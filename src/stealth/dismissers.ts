/**
 * Auto-dismissers for cookie banners, popups, and overlays that block content.
 *
 * These utilities help ensure clean page content extraction by removing
 * common UI obstacles that websites display to users.
 */

import { Page } from 'playwright';
import { logger } from '../utils/logger.js';

/** Timeout for actual click after element is found (ms) */
const CLICK_TIMEOUT = 500;

/** Short delay between dismissal attempts (ms) */
const ATTEMPT_DELAY = 100;

/**
 * Visually detect if there's an overlay blocking content.
 *
 * Uses a single page.evaluate() call to check for overlay signals,
 * avoiding the burst of parallel selector queries that can trigger anti-bot.
 *
 * @param page - Playwright page instance
 * @returns true if an overlay is likely present
 */
export async function detectOverlay(page: Page): Promise<boolean> {
  logger.debug('dismisser_detect_start');

  try {
    const result = await page.evaluate(() => {
      // Check 1: Body/html scroll locked (common modal behavior)
      const bodyStyle = window.getComputedStyle(document.body);
      const htmlStyle = window.getComputedStyle(document.documentElement);
      const scrollLocked =
        bodyStyle.overflow === 'hidden' ||
        bodyStyle.overflowY === 'hidden' ||
        htmlStyle.overflow === 'hidden' ||
        htmlStyle.overflowY === 'hidden';

      // Check 2: Any fixed/absolute element covering significant viewport area with high z-index
      let hasBlockingElement = false;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Only check elements that are likely overlays (fixed/absolute with z-index)
      const candidates = document.querySelectorAll('[style*="position: fixed"], [style*="position: absolute"]');
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        const position = style.position;
        const zIndex = parseInt(style.zIndex) || 0;

        if ((position === 'fixed' || position === 'absolute') && zIndex > 50) {
          const rect = el.getBoundingClientRect();
          // Check if it covers more than 40% width and 25% height
          if (rect.width > viewportWidth * 0.4 && rect.height > viewportHeight * 0.25) {
            // Exclude headers, navs, and legitimate fixed elements
            const tagName = el.tagName.toLowerCase();
            const className = (el.className || '').toString().toLowerCase();
            if (
              tagName !== 'header' &&
              tagName !== 'nav' &&
              !className.includes('header') &&
              !className.includes('nav') &&
              !className.includes('toolbar')
            ) {
              hasBlockingElement = true;
              break;
            }
          }
        }
      }

      // Check 3: Common overlay/modal/cookie classes exist and are visible
      const overlaySelectors = [
        '[class*="modal"]:not([style*="display: none"])',
        '[class*="overlay"]:not([style*="display: none"])',
        '[class*="cookie-banner"]:not([style*="display: none"])',
        '[class*="cookie-consent"]:not([style*="display: none"])',
        '[class*="gdpr"]:not([style*="display: none"])',
        '[id*="cookie"]:not([style*="display: none"])',
        '[class*="popup"]:not([style*="display: none"])',
        '[role="dialog"]:not([style*="display: none"])',
      ];

      let hasOverlayClass = false;
      for (const selector of overlaySelectors) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            const style = window.getComputedStyle(el);
            // Make sure it's actually visible
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              hasOverlayClass = true;
              break;
            }
          }
        } catch {
          // Invalid selector, skip
        }
      }

      // Check 4: Blur effect on main content
      const hasBlur = !!document.querySelector('[style*="blur"], [class*="blur"]');

      return {
        scrollLocked,
        hasBlockingElement,
        hasOverlayClass,
        hasBlur,
        detected: scrollLocked || hasBlockingElement || hasOverlayClass || hasBlur
      };
    });

    logger.debug('dismisser_detect_result', result);
    return result.detected;
  } catch (error) {
    logger.debug('dismisser_detect_error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    // If detection fails, assume no overlay (don't trigger dismissal burst)
    return false;
  }
}

/**
 * Try multiple selectors in parallel, return true if any succeeds.
 * Much faster than sequential attempts.
 */
async function tryClickAny(page: Page, selectors: string[], description: string): Promise<boolean> {
  // Check all selectors in parallel for existence
  const checks = await Promise.all(
    selectors.map(async (selector) => {
      const count = await page.locator(selector).first().count();
      return { selector, exists: count > 0 };
    })
  );

  // Find first existing element and click it
  for (const { selector, exists } of checks) {
    if (exists) {
      try {
        await page.locator(selector).first().click({ timeout: CLICK_TIMEOUT });
        logger.debug('dismisser_click_success', { selector, description });
        return true;
      } catch {
        // Try next one
      }
    }
  }
  return false;
}

/**
 * Try multiple text patterns in parallel, return true if any succeeds.
 */
async function tryClickAnyText(page: Page, patterns: string[], description: string): Promise<boolean> {
  // Check all patterns in parallel for existence
  const checks = await Promise.all(
    patterns.map(async (text) => {
      const locator = page.getByRole('button', { name: new RegExp(`^${text}$`, 'i') }).first();
      const count = await locator.count();
      return { text, locator, exists: count > 0 };
    })
  );

  // Find first existing element and click it
  for (const { text, locator, exists } of checks) {
    if (exists) {
      try {
        await locator.click({ timeout: CLICK_TIMEOUT });
        logger.debug('dismisser_click_success', { text, description });
        return true;
      } catch {
        // Try next one
      }
    }
  }
  return false;
}

/**
 * Dismiss cookie consent banners.
 *
 * Attempts to click common cookie consent accept/dismiss buttons.
 * Targets major cookie consent solutions (OneTrust, CookieConsent, etc.)
 * as well as custom implementations.
 *
 * @param page - Playwright page instance
 * @returns true if a cookie banner was dismissed
 *
 * @example
 * ```typescript
 * const dismissed = await dismissCookieBanners(page);
 * if (dismissed) {
 *   console.log('Cookie banner was dismissed');
 * }
 * ```
 */
export async function dismissCookieBanners(page: Page): Promise<boolean> {
  logger.debug('dismisser_cookie_start');

  // Common cookie consent selectors (more specific first)
  const selectors = [
    // OneTrust (very common)
    '#onetrust-accept-btn-handler',
    '#onetrust-pc-btn-handler',
    '.onetrust-close-btn-handler',

    // CookieConsent library
    '.cc-accept',
    '.cc-dismiss',
    '.cc-btn.cc-allow',

    // Cookiebot
    '#CybotCookiebotDialogBodyButtonAccept',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',

    // GDPR/Cookie notice patterns
    '[class*="cookie"] button[class*="accept"]',
    '[class*="cookie"] button[class*="agree"]',
    '[class*="cookie"] button[class*="allow"]',
    '[class*="cookie"] button[class*="confirm"]',
    '[class*="cookie"] button[class*="close"]',
    '[id*="cookie"] button[class*="accept"]',
    '[id*="cookie"] button[class*="agree"]',
    '[id*="cookie"] button[class*="allow"]',

    // Consent patterns
    '[class*="consent"] button[class*="accept"]',
    '[class*="consent"] button[class*="agree"]',
    '[class*="consent"] button[class*="allow"]',
    '[id*="consent"] button[class*="accept"]',
    '[id*="consent"] button[class*="agree"]',

    // GDPR patterns
    '[class*="gdpr"] button[class*="accept"]',
    '[class*="gdpr"] button[class*="agree"]',
    '[id*="gdpr"] button[class*="accept"]',

    // Aria label patterns
    '[aria-label*="accept" i]',
    '[aria-label*="Accept" i]',
    '[aria-label*="consent" i]',
    '[aria-label*="cookie" i][aria-label*="accept" i]',

    // Generic cookie/consent container buttons
    '[class*="cookie-banner"] button',
    '[class*="cookie-notice"] button',
    '[class*="cookie-popup"] button',
    '[class*="cookie-modal"] button',
  ];

  // Try all selectors in parallel (fast existence check)
  if (await tryClickAny(page, selectors, 'cookie_selector')) {
    logger.info('dismisser_cookie_dismissed', { method: 'selector' });
    return true;
  }

  // Try text-based buttons in parallel
  const textPatterns = [
    'Accept All',
    'Accept Cookies',
    'Accept all cookies',
    'Accept',
    'I agree',
    'I Accept',
    'Agree',
    'Allow All',
    'Allow all',
    'Allow Cookies',
    'Allow',
    'Got it',
    'OK',
    'Continue',
    'Understood',
    'Dismiss',
  ];

  if (await tryClickAnyText(page, textPatterns, 'cookie_text')) {
    logger.info('dismisser_cookie_dismissed', { method: 'text' });
    return true;
  }

  logger.debug('dismisser_cookie_none_found');
  return false;
}

/**
 * Dismiss newsletter/subscription popups and modal dialogs.
 *
 * Attempts to close common popup patterns including newsletter signups,
 * subscription prompts, and generic modal dialogs.
 *
 * @param page - Playwright page instance
 * @returns true if a popup was dismissed
 *
 * @example
 * ```typescript
 * const dismissed = await dismissPopups(page);
 * if (dismissed) {
 *   console.log('Popup was dismissed');
 * }
 * ```
 */
export async function dismissPopups(page: Page): Promise<boolean> {
  logger.debug('dismisser_popup_start');

  // Try pressing Escape first (closes many modals)
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(ATTEMPT_DELAY);
  } catch {
    // Escape key failed - continue with click attempts
  }

  // Common close button selectors
  const selectors = [
    // Modal close buttons
    '[class*="modal"] [class*="close"]',
    '[class*="modal"] button[aria-label="Close"]',
    '[class*="modal"] button[aria-label="close"]',
    '[class*="modal"] .close-button',
    '[class*="modal"] .btn-close',
    '.modal-close',
    '.modal .close',

    // Popup close buttons
    '[class*="popup"] [class*="close"]',
    '[class*="popup"] button[aria-label="Close"]',
    '.popup-close',

    // Overlay close buttons
    '[class*="overlay"] [class*="close"]',
    '[class*="overlay"] button[aria-label="Close"]',
    '.overlay-close',

    // Newsletter/subscription specific
    '[class*="newsletter"] [class*="close"]',
    '[class*="newsletter"] button[aria-label="Close"]',
    '[class*="subscribe"] [class*="close"]',
    '[class*="signup"] [class*="close"]',
    '[class*="sign-up"] [class*="close"]',

    // Generic close patterns
    '[aria-label="Close"]',
    '[aria-label="close"]',
    '[aria-label="Dismiss"]',
    '[aria-label="dismiss"]',
    'button.close',
    '.close-btn',
    '.close-button',
    '.btn-close',

    // X button patterns
    'button:has-text("\u00D7")',
    'button:has-text("\u2715")',
    'button:has-text("\u2716")',

    // Dialog close
    '[role="dialog"] [class*="close"]',
    '[role="dialog"] button[aria-label="Close"]',
  ];

  // Try all selectors in parallel (fast existence check)
  if (await tryClickAny(page, selectors, 'popup_selector')) {
    logger.info('dismisser_popup_dismissed', { method: 'selector' });
    return true;
  }

  // Try text-based dismiss buttons in parallel
  const textPatterns = [
    'No thanks',
    'No, thanks',
    'Maybe later',
    'Not now',
    'Close',
    'Skip',
    'Dismiss',
    'Cancel',
  ];

  if (await tryClickAnyText(page, textPatterns, 'popup_text')) {
    logger.info('dismisser_popup_dismissed', { method: 'text' });
    return true;
  }

  logger.debug('dismisser_popup_none_found');
  return false;
}

/**
 * Remove overlay elements that block scrolling or interaction.
 *
 * Uses page.evaluate to directly manipulate the DOM:
 * - Removes fixed/sticky elements that cover the viewport
 * - Removes modal backdrops
 * - Resets body overflow (often set to 'hidden' by modals)
 * - Removes blur effects from content
 *
 * @param page - Playwright page instance
 * @returns true if any blocking overlays were removed
 *
 * @example
 * ```typescript
 * const removed = await removeBlockingOverlays(page);
 * if (removed) {
 *   console.log('Blocking overlays were removed');
 * }
 * ```
 */
export async function removeBlockingOverlays(page: Page): Promise<boolean> {
  logger.debug('dismisser_overlay_start');

  try {
    const removed = await page.evaluate(() => {
      let removedCount = 0;

      // Helper to check if element covers significant viewport area
      const coversViewport = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Check if element covers more than 50% of viewport
        const coverageX = Math.min(rect.width, viewportWidth) / viewportWidth;
        const coverageY = Math.min(rect.height, viewportHeight) / viewportHeight;

        return coverageX > 0.5 && coverageY > 0.5;
      };

      // Remove fixed/sticky elements that cover viewport
      const allElements = document.querySelectorAll('*');
      allElements.forEach((el) => {
        const style = window.getComputedStyle(el);
        const position = style.position;
        const zIndex = parseInt(style.zIndex) || 0;

        // Target fixed/sticky elements with high z-index that cover viewport
        if (
          (position === 'fixed' || position === 'sticky') &&
          zIndex > 100 &&
          coversViewport(el)
        ) {
          // Don't remove headers, navs, or other legitimate fixed elements
          const tagName = el.tagName.toLowerCase();
          const className = el.className.toString().toLowerCase();

          if (
            tagName !== 'header' &&
            tagName !== 'nav' &&
            !className.includes('header') &&
            !className.includes('nav') &&
            !className.includes('toolbar') &&
            !className.includes('sticky-header')
          ) {
            (el as HTMLElement).style.display = 'none';
            removedCount++;
          }
        }
      });

      // Remove modal backdrops and overlays by class name
      const overlaySelectors = [
        '[class*="modal-backdrop"]',
        '[class*="modal-overlay"]',
        '[class*="overlay-backdrop"]',
        '[class*="backdrop"]',
        '.modal-backdrop',
        '.overlay',
        '[class*="dimmer"]',
        '[class*="shade"]',
      ];

      overlaySelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          const style = window.getComputedStyle(el);
          // Only remove if it's covering content (high z-index, positioned)
          if (
            (style.position === 'fixed' || style.position === 'absolute') &&
            parseInt(style.zIndex) > 0
          ) {
            (el as HTMLElement).style.display = 'none';
            removedCount++;
          }
        });
      });

      // Reset body overflow (modals often set this to 'hidden')
      const body = document.body;
      const html = document.documentElement;
      const bodyStyle = window.getComputedStyle(body);
      const htmlStyle = window.getComputedStyle(html);

      if (bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden') {
        body.style.overflow = 'auto';
        body.style.overflowY = 'auto';
        removedCount++;
      }

      if (htmlStyle.overflow === 'hidden' || htmlStyle.overflowY === 'hidden') {
        html.style.overflow = 'auto';
        html.style.overflowY = 'auto';
        removedCount++;
      }

      // Remove body classes that prevent scrolling
      body.classList.remove('modal-open', 'no-scroll', 'overflow-hidden', 'noscroll');

      // Remove blur effects from content
      document.querySelectorAll('[class*="blur"]').forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.filter && style.filter.includes('blur')) {
          (el as HTMLElement).style.filter = 'none';
          removedCount++;
        }
      });

      // Also check for inline blur styles
      document.querySelectorAll('[style*="blur"]').forEach((el) => {
        (el as HTMLElement).style.filter = 'none';
        removedCount++;
      });

      return removedCount;
    });

    if (removed > 0) {
      logger.info('dismisser_overlay_removed', { removed_count: removed });
      return true;
    }

    logger.debug('dismisser_overlay_none_found');
    return false;
  } catch (error) {
    logger.debug('dismisser_overlay_error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/**
 * Scroll page to trigger lazy loading of content.
 *
 * Scrolls down the page in increments, waiting between scrolls
 * to allow content to load, then scrolls back to the top.
 *
 * @param page - Playwright page instance
 *
 * @example
 * ```typescript
 * await triggerLazyLoading(page);
 * // Content should now be fully loaded
 * ```
 */
export async function triggerLazyLoading(page: Page): Promise<void> {
  logger.debug('dismisser_lazyload_start');

  try {
    await page.evaluate(async () => {
      const scrollHeight = document.body.scrollHeight;
      const viewportHeight = window.innerHeight;
      const scrollIncrement = viewportHeight * 0.8; // Scroll 80% of viewport at a time

      // Scroll down in increments
      let currentPosition = 0;
      while (currentPosition < scrollHeight) {
        window.scrollTo({
          top: currentPosition,
          behavior: 'auto', // Use instant scroll for speed
        });

        // Wait a bit for lazy content to load
        await new Promise((resolve) => setTimeout(resolve, 150));

        currentPosition += scrollIncrement;

        // Re-check scroll height as it may have grown
        const newScrollHeight = document.body.scrollHeight;
        if (newScrollHeight > scrollHeight) {
          // Page grew, continue scrolling
        }
      }

      // Scroll to very bottom to ensure everything loaded
      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: 'auto',
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Scroll back to top
      window.scrollTo({
        top: 0,
        behavior: 'auto',
      });
    });

    logger.debug('dismisser_lazyload_complete');
  } catch (error) {
    logger.debug('dismisser_lazyload_error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Result of running all dismissers.
 */
export interface DismissResult {
  /** Whether a cookie banner was dismissed */
  cookieDismissed: boolean;
  /** Whether popups were dismissed */
  popupsDismissed: boolean;
  /** Whether blocking overlays were removed */
  overlaysRemoved: boolean;
}

/**
 * Master function that runs all dismissers.
 *
 * Attempts to dismiss cookie banners, popups, and blocking overlays
 * in sequence with small delays between attempts.
 *
 * @param page - Playwright page instance
 * @returns Results indicating what was dismissed
 *
 * @example
 * ```typescript
 * const result = await dismissAllOverlays(page);
 * console.log(`Cookie: ${result.cookieDismissed}, Popups: ${result.popupsDismissed}`);
 * ```
 */
export async function dismissAllOverlays(page: Page): Promise<DismissResult> {
  logger.debug('dismisser_all_start');

  const result: DismissResult = {
    cookieDismissed: false,
    popupsDismissed: false,
    overlaysRemoved: false,
  };

  // Dismiss cookie banners first (most common blocker)
  result.cookieDismissed = await dismissCookieBanners(page);
  await page.waitForTimeout(ATTEMPT_DELAY);

  // Then try popups
  result.popupsDismissed = await dismissPopups(page);
  await page.waitForTimeout(ATTEMPT_DELAY);

  // Finally remove any remaining blocking overlays via DOM manipulation
  result.overlaysRemoved = await removeBlockingOverlays(page);

  // Log summary
  const dismissed = Object.values(result).filter(Boolean).length;
  if (dismissed > 0) {
    logger.info('dismisser_all_complete', {
      cookie_dismissed: result.cookieDismissed,
      popups_dismissed: result.popupsDismissed,
      overlays_removed: result.overlaysRemoved,
    });
  } else {
    logger.debug('dismisser_all_none_found');
  }

  return result;
}

/**
 * Wait for page to be ready and then run dismissers.
 *
 * Combines a short wait for dynamic content with all dismissers.
 * Useful when you want a single function to prepare a page for extraction.
 *
 * @param page - Playwright page instance
 * @param options - Configuration options
 * @returns Results indicating what was dismissed
 */
export async function preparePageForExtraction(
  page: Page,
  options: {
    /** Wait time before dismissing (ms). Default: 500 */
    waitBefore?: number;
    /** Whether to trigger lazy loading. Default: false */
    triggerLazy?: boolean;
  } = {}
): Promise<DismissResult> {
  const { waitBefore = 500, triggerLazy = false } = options;

  // Wait for dynamic content to appear
  await page.waitForTimeout(waitBefore);

  // Run all dismissers
  const result = await dismissAllOverlays(page);

  // Optionally trigger lazy loading
  if (triggerLazy) {
    await triggerLazyLoading(page);
  }

  return result;
}

/**
 * Alias for dismissCookieBanners (singular form for backwards compatibility).
 */
export const dismissCookieBanner = dismissCookieBanners;

/**
 * Full scroll simulation that mimics human scrolling behavior.
 *
 * Unlike triggerLazyLoading which scrolls quickly, this function:
 * - Uses smooth scrolling with variable speeds
 * - Pauses at random intervals
 * - Simulates reading behavior
 * - Helps trigger content that requires human-like interaction
 *
 * @param page - Playwright page instance
 * @param options - Configuration options
 *
 * @example
 * ```typescript
 * await fullScrollSimulation(page, { pauseChance: 0.3 });
 * ```
 */
export async function fullScrollSimulation(
  page: Page,
  options: {
    /** Chance to pause at each scroll step (0-1). Default: 0.2 */
    pauseChance?: number;
    /** Minimum pause duration (ms). Default: 500 */
    minPause?: number;
    /** Maximum pause duration (ms). Default: 2000 */
    maxPause?: number;
    /** Scroll step size in pixels. Default: 300 */
    stepSize?: number;
  } = {}
): Promise<void> {
  const {
    pauseChance = 0.2,
    minPause = 500,
    maxPause = 2000,
    stepSize = 300,
  } = options;

  logger.debug('dismisser_fullscroll_start');

  try {
    await page.evaluate(
      async ({ pauseChance, minPause, maxPause, stepSize }) => {
        const scrollHeight = document.body.scrollHeight;
        const viewportHeight = window.innerHeight;

        // Helper for random delay
        const randomDelay = (min: number, max: number) =>
          new Promise((resolve) =>
            setTimeout(resolve, Math.random() * (max - min) + min)
          );

        // Scroll down with human-like behavior
        let currentPosition = 0;
        while (currentPosition < scrollHeight - viewportHeight) {
          // Variable scroll amount
          const scrollAmount = stepSize + Math.random() * 100 - 50;
          currentPosition += scrollAmount;

          window.scrollTo({
            top: currentPosition,
            behavior: 'smooth',
          });

          // Base delay between scrolls
          await randomDelay(100, 300);

          // Random pauses to simulate reading
          if (Math.random() < pauseChance) {
            await randomDelay(minPause, maxPause);
          }

          // Check if page grew (infinite scroll)
          const newScrollHeight = document.body.scrollHeight;
          if (newScrollHeight > scrollHeight) {
            // Continue with new height
          }
        }

        // Scroll to absolute bottom
        window.scrollTo({
          top: document.body.scrollHeight,
          behavior: 'smooth',
        });

        await randomDelay(500, 1000);

        // Scroll back to top smoothly
        window.scrollTo({
          top: 0,
          behavior: 'smooth',
        });
      },
      { pauseChance, minPause, maxPause, stepSize }
    );

    logger.debug('dismisser_fullscroll_complete');
  } catch (error) {
    logger.debug('dismisser_fullscroll_error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
