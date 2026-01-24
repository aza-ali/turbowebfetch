/**
 * Single URL fetch tool implementation
 *
 * Fetches a single URL using a browser instance from the pool,
 * respecting rate limits and returning processed content.
 *
 * Includes stealth features:
 * - Cloudflare challenge detection and waiting
 * - Blocker detection (CAPTCHA, login walls, paywalls)
 * - Overlay dismissal (cookie banners, popups)
 * - Lazy loading triggers via scroll simulation
 * - Retry logic with escalating stealth measures
 */

import type { Page } from "playwright";
import type {
  FetchOptions,
  FetchResponse,
  RawPageContent,
  ContentFormat,
  FetchErrorCode,
} from "../types.js";
import {
  createSuccessResponse,
  createErrorResponse,
  getDefaultConfig,
} from "../types.js";
import { browserPool } from "../pool/manager.js";
import type { BrowserInstance } from "../pool/instance.js";
import { rateLimiter } from "../rate-limit/limiter.js";
import { extractContent } from "../content/extractor.js";
import { logger } from "../utils/logger.js";
import { dismissAllOverlays, triggerLazyLoading, fullScrollSimulation } from "../stealth/dismissers.js";
import { detectBlockers, detectCloudflareChallenge } from "../stealth/detectors.js";

// Get timeout configuration
const config = getDefaultConfig();

/**
 * Sleep utility for retry backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hard timeout wrapper - aborts if operation takes too long
 */
function withHardTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

/**
 * Get a random delay between min and max milliseconds
 */
function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Extracts domain from URL for rate limiting
 */
function extractDomain(urlString: string): string {
  try {
    const url = new URL(urlString);
    return url.hostname;
  } catch {
    return "unknown";
  }
}

/**
 * Determines error code from error message
 */
function getErrorCode(errorMessage: string): FetchErrorCode {
  if (errorMessage.includes("Timeout") || errorMessage.includes("timeout")) {
    return "TIMEOUT";
  }
  if (
    errorMessage.includes("net::") ||
    errorMessage.includes("Network") ||
    errorMessage.includes("ECONNREFUSED") ||
    errorMessage.includes("ENOTFOUND")
  ) {
    return "NETWORK";
  }
  if (errorMessage.includes("Pool") || errorMessage.includes("exhausted")) {
    return "POOL_EXHAUSTED";
  }
  if (errorMessage.includes("Invalid URL")) {
    return "INVALID_URL";
  }
  if (errorMessage.includes("HTTP")) {
    return "HTTP_ERROR";
  }
  if (errorMessage.includes("blocked") || errorMessage.includes("BLOCKED")) {
    return "BLOCKED";
  }
  return "UNKNOWN";
}

/**
 * Wait for Cloudflare challenge to resolve
 *
 * @param page - Playwright page object
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @returns true if challenge resolved, false if timed out
 */
async function waitForCloudflareResolve(
  page: Page,
  timeoutMs = 10000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const stillChallenging = await detectCloudflareChallenge(page);
    if (!stillChallenging) {
      logger.info("cloudflare_resolved", {
        url: page.url(),
        waited_ms: Date.now() - startTime
      });
      return true;
    }
    await page.waitForTimeout(500);
  }

  logger.warn("cloudflare_timeout", {
    url: page.url(),
    timeout_ms: timeoutMs
  });
  return false;
}

/**
 * Internal fetch function with attempt-based behavior escalation
 *
 * @param page - Playwright page object
 * @param url - URL to navigate to
 * @param timeout - Navigation timeout
 * @param waitFor - Optional selector to wait for
 * @param attempt - Current attempt number (1, 2, or 3)
 */
async function navigateAndExtractInternal(
  page: Page,
  url: string,
  timeout: number,
  waitFor: string | undefined,
  attempt: number
): Promise<RawPageContent> {
  try {
    // Attempt-based behavior escalation
    if (attempt === 2) {
      // Add random delay before navigation (1-3s)
      const delay = randomDelay(1000, 3000);
      logger.debug("retry_delay", { url, attempt, delay_ms: delay });
      await sleep(delay);
    } else if (attempt === 3) {
      // Longer random delay for attempt 3 (2-5s)
      const delay = randomDelay(2000, 5000);
      logger.debug("retry_delay", { url, attempt, delay_ms: delay });
      await sleep(delay);
    }

    // Navigate to URL - use domcontentloaded for speed, not networkidle
    // AI agents shouldn't wait for all network activity to stop
    logger.info("navigate_goto_start", { url, timeout });
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    logger.info("navigate_goto_done", { url, status: response?.status() });

    const status = response?.status() ?? 0;

    // Check for HTTP errors
    if (status >= 400) {
      return {
        html: "",
        title: "",
        url: page.url(),
        status,
        error: `HTTP ${status} error`,
      };
    }

    // Step 1: Check for Cloudflare challenge, wait if detected
    logger.info("step_cloudflare_check", { url });
    const isCloudflare = await detectCloudflareChallenge(page);
    logger.info("step_cloudflare_done", { url, isCloudflare });
    if (isCloudflare) {
      logger.info("cloudflare_detected", { url });
      const resolved = await waitForCloudflareResolve(page, 10000);
      if (!resolved) {
        return {
          html: "",
          title: "",
          url: page.url(),
          status: 403,
          error: "BLOCKED: Cloudflare challenge did not resolve",
        };
      }
    }

    // Step 2: Detect blockers (CAPTCHA, login walls, etc.)
    logger.info("step_blockers_check", { url });
    const blockerCheck = await detectBlockers(page);
    logger.info("step_blockers_done", { url, blocked: blockerCheck.blocked });
    if (blockerCheck.blocked) {
      logger.warn("blocker_detected", {
        url,
        reason: blockerCheck.reason,
        details: blockerCheck.details
      });
      return {
        html: "",
        title: "",
        url: page.url(),
        status: 403,
        error: `BLOCKED: ${blockerCheck.reason} - ${blockerCheck.details}`,
      };
    }

    // Step 3: Dismiss overlays (cookie banners, popups)
    logger.info("step_dismiss_overlays", { url });
    await dismissAllOverlays(page);
    logger.info("step_dismiss_done", { url });

    // Step 4: Trigger lazy loading
    logger.info("step_lazy_loading", { url, attempt });
    if (attempt === 3) {
      // Full scroll simulation on attempt 3
      await fullScrollSimulation(page);
    } else {
      // Normal lazy loading trigger
      await triggerLazyLoading(page);
    }
    logger.info("step_lazy_done", { url });

    // Step 5: Wait a moment for content to settle
    const settleTime = attempt === 3 ? 1000 : 500;
    logger.info("step_settle_wait", { url, settleTime });
    await page.waitForTimeout(settleTime);
    logger.info("step_settle_done", { url });

    // Wait for specific selector if provided
    if (waitFor) {
      try {
        await page.waitForSelector(waitFor, {
          timeout: config.timeouts.waitFor,
        });
      } catch {
        // Log but don't fail - selector might not exist
        logger.warn("selector_timeout", {
          url,
          event: `Selector "${waitFor}" not found within timeout`,
        });
      }
    }

    // Extract content
    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();

    return {
      html,
      title,
      url: finalUrl,
      status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Try to get partial content on timeout
    if (errorMessage.includes("Timeout") || errorMessage.includes("timeout")) {
      try {
        const html = await page.content();
        const title = await page.title();

        if (html && html.length > 100) {
          logger.warn("partial_content", {
            url,
            event: "Timeout but returning partial content",
          });
          return {
            html,
            title,
            url: page.url(),
            status: 200,
            error: "Partial content - page timed out before fully loading",
          };
        }
      } catch {
        // Ignore errors getting partial content
      }
    }

    return {
      html: "",
      title: "",
      url,
      status: 0,
      error: errorMessage,
    };
  }
}

/**
 * Fetches a page with retry logic and escalating stealth measures
 *
 * - Attempt 1: Normal fetch
 * - Attempt 2: Add random delay (1-3s) before navigation
 * - Attempt 3: Full scroll simulation, longer waits
 */
async function fetchWithRetry(
  instance: BrowserInstance,
  url: string,
  timeout: number,
  waitFor?: string,
  maxRetries = 3
): Promise<RawPageContent> {
  let lastResult: RawPageContent | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger.info("retry_creating_page", { url, attempt });
    const page = await instance.context.newPage();
    logger.info("retry_page_created", { url, attempt });

    try {
      logger.info("retry_navigate_start", { url, attempt, max_retries: maxRetries });

      const result = await navigateAndExtractInternal(
        page,
        url,
        timeout,
        waitFor,
        attempt
      );

      // Success - return result
      if (!result.error || result.html.length > 100) {
        return result;
      }

      lastResult = result;

      // Don't retry certain errors
      if (
        result.error?.includes("BLOCKED") ||
        result.error?.includes("Invalid URL") ||
        result.error?.includes("HTTP 4") // Client errors (400-499)
      ) {
        logger.debug("no_retry", {
          url,
          attempt,
          reason: "Non-retryable error",
          error: result.error
        });
        return result;
      }

      // Log retry
      if (attempt < maxRetries) {
        // Randomized backoff to avoid fingerprinting (not fixed exponential)
        const minBackoff = 500 + (attempt * 500);   // 1000, 1500, 2000...
        const maxBackoff = 2000 + (attempt * 1500); // 3500, 5000, 6500...
        const backoffMs = randomDelay(minBackoff, maxBackoff);

        logger.info("retry_scheduled", {
          url,
          attempt,
          next_attempt: attempt + 1,
          backoff_ms: backoffMs,
          error: result.error
        });

        await sleep(backoffMs);
      }
    } finally {
      await page.close();
    }
  }

  return lastResult!;
}

/**
 * Main fetch function - fetches a single URL and returns processed content
 *
 * Steps:
 * 1. Validate URL (already done by Zod schema in types.ts)
 * 2. Acquire rate limit token for domain
 * 3. Acquire browser instance from pool
 * 4. Create new page in browser context
 * 5. Navigate to URL (waitUntil: 'networkidle')
 * 6. Check for Cloudflare challenge and wait if needed
 * 7. Detect blockers (CAPTCHA, login walls, paywalls)
 * 8. Dismiss overlays (cookie banners, popups)
 * 9. Trigger lazy loading
 * 10. Wait for selector if options.wait_for provided
 * 11. Extract page content (html)
 * 12. Get title, final URL
 * 13. Close page
 * 14. Release browser instance to pool
 * 15. Process content through extractor
 * 16. Return FetchResponse
 */
export async function fetchPage(options: FetchOptions): Promise<FetchResponse> {
  const startTime = Date.now();
  const { url, format, wait_for, timeout } = options;
  const domain = extractDomain(url);

  logger.info("fetch_start", { url, format, domain });

  let instance: BrowserInstance | null = null;

  // Hard timeout for entire operation (60 seconds max)
  const HARD_TIMEOUT_MS = 60000;

  try {
    // Step 2: Acquire rate limit token for domain
    logger.info("step_rate_limit", { domain, elapsed: Date.now() - startTime });
    await withHardTimeout(
      rateLimiter.acquire(domain),
      5000,
      "Timeout acquiring rate limit token"
    );
    logger.info("step_rate_limit_done", { domain, elapsed: Date.now() - startTime });

    // Step 3: Acquire browser instance from pool
    logger.info("step_pool_acquire", { elapsed: Date.now() - startTime });
    instance = await withHardTimeout(
      browserPool.acquire(),
      30000,
      "Timeout acquiring browser from pool"
    );
    logger.info("step_pool_done", { elapsed: Date.now() - startTime });

    // Steps 4-13: Navigate and extract content with retry logic
    logger.info("step_fetch_with_retry", { elapsed: Date.now() - startTime });
    const remainingTime = HARD_TIMEOUT_MS - (Date.now() - startTime);
    const rawContent = await withHardTimeout(
      fetchWithRetry(instance, url, timeout, wait_for),
      Math.max(remainingTime, 10000),
      `Timeout: fetch operation exceeded ${HARD_TIMEOUT_MS}ms`
    );
    logger.info("step_fetch_with_retry_done", { elapsed: Date.now() - startTime });

    // Check for errors with no content
    if (rawContent.error && rawContent.html === "") {
      logger.error("fetch_failed", {
        url,
        event: rawContent.error,
        status: rawContent.status,
      });

      const errorCode = getErrorCode(rawContent.error);

      return createErrorResponse(
        rawContent.url,
        errorCode,
        rawContent.error,
        rawContent.status || undefined
      );
    }

    // Step 15: Process content through extractor
    const extractionResult = extractContent(
      rawContent.html,
      format as ContentFormat
    );

    // Check if extraction failed
    if (!extractionResult.success) {
      logger.error("extraction_failed", {
        url,
        event: extractionResult.error || "Unknown extraction error",
      });

      return createErrorResponse(
        rawContent.url,
        "EXTRACTION_ERROR",
        extractionResult.error || "Content extraction failed"
      );
    }

    const duration = Date.now() - startTime;
    logger.info("fetch_complete", {
      url,
      duration_ms: duration,
      content_length: extractionResult.content.length,
      status: rawContent.status,
    });

    // Step 16: Return FetchResult
    return createSuccessResponse(
      extractionResult.content,
      rawContent.url,
      rawContent.title,
      rawContent.status
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("fetch_error", {
      url,
      event: errorMessage,
    });

    const errorCode = getErrorCode(errorMessage);

    return createErrorResponse(url, errorCode, errorMessage);
  } finally {
    // Step 14: Release browser instance to pool
    if (instance) {
      await browserPool.release(instance);
    }
  }
}

/**
 * Convenience function for fetching with inline options
 * (matches the simpler interface from PRD)
 */
export async function fetch(
  url: string,
  options: {
    format?: ContentFormat;
    wait_for?: string;
    timeout?: number;
  } = {}
): Promise<FetchResponse> {
  return fetchPage({
    url,
    format: options.format ?? "text",
    wait_for: options.wait_for,
    timeout: options.timeout ?? config.timeouts.navigation,
  });
}
