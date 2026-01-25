/**
 * Single URL fetch tool implementation
 *
 * Fetches a single URL by calling the Python nodriver script,
 * respecting rate limits and returning processed content.
 *
 * Python script handles stealth features via nodriver:
 * - Undetected Chrome (nodriver)
 * - Overlay dismissal (cookie banners, popups)
 * - Lazy loading triggers via scroll simulation
 */

import { spawn } from "child_process";
import { dirname } from "path";
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
import { rateLimiter } from "../rate-limit/limiter.js";
import { logger } from "../utils/logger.js";
import { config as appConfig } from "../utils/config.js";

// Get Python paths from centralized config (handles bundling correctly)
const pythonConfig = getDefaultConfig();
const PYTHON_VENV = pythonConfig.python.pythonPath;
const PYTHON_SCRIPT = pythonConfig.python.fetcherScript;
const PYTHON_DIR = dirname(PYTHON_SCRIPT);

// Get timeout configuration
const config = getDefaultConfig();

/**
 * Call Python nodriver script to fetch a page
 *
 * @param url - URL to fetch
 * @param format - Output format (html, text, markdown)
 * @param timeout - Navigation timeout in milliseconds
 * @param waitFor - Optional CSS selector to wait for
 * @param humanMode - Enable human-mode scrolling and delays (defaults to config value)
 * @returns Raw page content or error
 */
async function callPythonFetcher(
  url: string,
  format: ContentFormat,
  timeout: number,
  waitFor?: string,
  humanMode?: boolean
): Promise<RawPageContent> {
  return new Promise((resolve) => {
    // Use passed value if defined, otherwise fall back to config
    const useHumanMode = humanMode ?? appConfig.browser.humanMode;

    const args = [
      PYTHON_SCRIPT,
      "--url", url,
      "--format", format,
      "--timeout", timeout.toString(),
      "--headless", "true",
      "--human-mode", useHumanMode.toString(),
    ];

    if (waitFor) {
      args.push("--wait-for", waitFor);
    }

    logger.info("python_spawn", { url, python: PYTHON_VENV, args: args.join(" ") });

    const python = spawn(PYTHON_VENV, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: PYTHON_DIR,
    });

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("error", (error) => {
      logger.error("python_spawn_error", {
        url,
        error: error.message,
      });
      resolve({
        html: "",
        title: "",
        url,
        status: 0,
        error: `Failed to spawn Python process: ${error.message}`,
      });
    });

    python.on("close", (code) => {
      logger.info("python_exit", { url, code: code ?? -1, stderr_length: stderr ? stderr.length : 0 });

      if (stderr) {
        logger.debug("python_stderr", { url, stderr: stderr.slice(0, 500) });
      }

      // Parse JSON output from Python
      // Only use the first line - nodriver outputs cleanup messages on subsequent lines
      try {
        const firstLine = stdout.split('\n')[0].trim();
        const result = JSON.parse(firstLine);

        if (result.success) {
          // Success case
          resolve({
            html: result.content,
            title: result.title || "",
            url: result.url,
            status: result.status || 200,
          });
        } else {
          // Error case from Python
          resolve({
            html: "",
            title: "",
            url: result.url || url,
            status: result.error?.status || 0,
            error: result.error?.message || "Unknown error from Python fetcher",
          });
        }
      } catch (parseError) {
        logger.error("python_parse_error", {
          url,
          stdout: stdout.slice(0, 200),
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });

        resolve({
          html: "",
          title: "",
          url,
          status: 0,
          error: `Failed to parse Python output: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
        });
      }
    });

    // Hard timeout for Python process
    const timeoutHandle = setTimeout(() => {
      python.kill("SIGTERM");
      logger.warn("python_timeout", { url, timeout });

      resolve({
        html: "",
        title: "",
        url,
        status: 0,
        error: `Python process timeout after ${timeout}ms`,
      });
    }, timeout + 5000); // Give Python 5s extra grace period

    // Clear timeout when process completes
    python.on("close", () => clearTimeout(timeoutHandle));
  });
}

/**
 * Sleep utility for retry backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Fetches a page with retry logic
 *
 * - Attempt 1: Normal fetch via Python
 * - Attempt 2: Retry after delay
 * - Attempt 3: Final retry
 */
async function fetchWithRetry(
  url: string,
  format: ContentFormat,
  timeout: number,
  waitFor?: string,
  humanMode?: boolean,
  maxRetries = 3
): Promise<RawPageContent> {
  let lastResult: RawPageContent | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger.info("retry_fetch_start", { url, attempt, max_retries: maxRetries });

    const result = await callPythonFetcher(url, format, timeout, waitFor, humanMode);

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

    // Log retry with backoff
    if (attempt < maxRetries) {
      const backoffMs = 1000 * attempt; // 1s, 2s, 3s

      logger.info("retry_scheduled", {
        url,
        attempt,
        next_attempt: attempt + 1,
        backoff_ms: backoffMs,
        error: result.error
      });

      await sleep(backoffMs);
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
 * 3. Call Python nodriver script to fetch page
 * 4. Process content through extractor
 * 5. Return FetchResponse
 */
export async function fetchPage(options: FetchOptions): Promise<FetchResponse> {
  const startTime = Date.now();
  const { url, format, wait_for, timeout, human_mode } = options;
  const domain = extractDomain(url);

  logger.info("fetch_start", { url, format, domain });

  try {
    // Step 2: Acquire rate limit token for domain
    logger.info("step_rate_limit", { domain, elapsed: Date.now() - startTime });
    await rateLimiter.acquire(domain);
    logger.info("step_rate_limit_done", { domain, elapsed: Date.now() - startTime });

    // Step 3: Call Python fetcher with retry logic
    logger.info("step_python_fetch", { elapsed: Date.now() - startTime });
    const rawContent = await fetchWithRetry(url, format as ContentFormat, timeout, wait_for, human_mode);
    logger.info("step_python_fetch_done", { elapsed: Date.now() - startTime });

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

    // Step 4: Python already handled content extraction, just return the result
    const duration = Date.now() - startTime;
    logger.info("fetch_complete", {
      url,
      duration_ms: duration,
      content_length: rawContent.html.length,
      status: rawContent.status,
    });

    // Step 5: Return FetchResult
    return createSuccessResponse(
      rawContent.html,  // Python already extracted content in the requested format
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
    human_mode?: boolean;
  } = {}
): Promise<FetchResponse> {
  return fetchPage({
    url,
    format: options.format ?? "text",
    wait_for: options.wait_for,
    timeout: options.timeout ?? config.timeouts.navigation,
    human_mode: options.human_mode,
  });
}
