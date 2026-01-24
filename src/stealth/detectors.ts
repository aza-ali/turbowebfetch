/**
 * Stealth detection module for the TurboFetch MCP server.
 *
 * Detects when a page is blocked or requires human intervention:
 * - CAPTCHAs (reCAPTCHA, hCaptcha, Cloudflare Turnstile)
 * - Cloudflare browser challenges
 * - Login walls
 * - Paywalls
 * - Error pages (403, 404, 500, etc.)
 *
 * All detectors are designed to be fast and non-throwing.
 */

import { Page } from 'playwright';

/**
 * Result of CAPTCHA detection.
 */
export interface CaptchaResult {
  detected: boolean;
  type?: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'generic';
}

/**
 * Result of error page detection.
 */
export interface ErrorResult {
  isError: boolean;
  type?: '403' | '404' | '500' | 'blocked' | 'unavailable';
}

/**
 * Result of the master blocker detection.
 */
export interface BlockerResult {
  blocked: boolean;
  reason?: 'captcha' | 'cloudflare' | 'login' | 'paywall' | 'error' | 'unknown';
  details?: string;
}

/**
 * Check if page has a CAPTCHA challenge.
 *
 * Detects:
 * - Google reCAPTCHA (v2 and v3)
 * - hCaptcha
 * - Cloudflare Turnstile
 * - Generic CAPTCHA elements
 *
 * @param page - Playwright page instance
 * @returns Detection result with CAPTCHA type if found
 */
export async function detectCaptcha(page: Page): Promise<CaptchaResult> {
  try {
    const result = await page.evaluate(() => {
      // Google reCAPTCHA detection
      const recaptchaSelectors = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="google.com/recaptcha"]',
        '.g-recaptcha',
        '#recaptcha',
        '[data-sitekey]', // reCAPTCHA site key attribute
        '.grecaptcha-badge',
      ];

      for (const selector of recaptchaSelectors) {
        if (document.querySelector(selector)) {
          return { detected: true, type: 'recaptcha' as const };
        }
      }

      // hCaptcha detection
      const hcaptchaSelectors = [
        'iframe[src*="hcaptcha"]',
        '.h-captcha',
        '[data-hcaptcha-sitekey]',
        'iframe[src*="assets.hcaptcha.com"]',
      ];

      for (const selector of hcaptchaSelectors) {
        if (document.querySelector(selector)) {
          return { detected: true, type: 'hcaptcha' as const };
        }
      }

      // Cloudflare Turnstile detection
      const turnstileSelectors = [
        'iframe[src*="turnstile"]',
        'iframe[src*="challenges.cloudflare.com"]',
        '.cf-turnstile',
        '[data-turnstile-sitekey]',
      ];

      for (const selector of turnstileSelectors) {
        if (document.querySelector(selector)) {
          return { detected: true, type: 'turnstile' as const };
        }
      }

      // Generic CAPTCHA detection (last resort)
      const genericSelectors = [
        '[class*="captcha"]',
        '[id*="captcha"]',
        'img[src*="captcha"]',
        '[class*="challenge"]',
        '[id*="challenge"]',
      ];

      for (const selector of genericSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          // Verify it's likely a CAPTCHA (not just a class named "challenge" for something else)
          const text = element.textContent?.toLowerCase() || '';
          const html = element.innerHTML?.toLowerCase() || '';
          if (
            text.includes('robot') ||
            text.includes('human') ||
            text.includes('verify') ||
            html.includes('captcha')
          ) {
            return { detected: true, type: 'generic' as const };
          }
        }
      }

      return { detected: false };
    });

    return result;
  } catch {
    // If evaluation fails, assume no CAPTCHA (don't block the request)
    return { detected: false };
  }
}

/**
 * Check if page is a Cloudflare browser challenge.
 *
 * Detects the "Just a moment..." interstitial that Cloudflare shows
 * before allowing access to a protected site.
 *
 * @param page - Playwright page instance
 * @returns true if Cloudflare challenge is detected
 */
export async function detectCloudflareChallenge(page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(() => {
      // Check page title
      const title = document.title?.toLowerCase() || '';
      if (
        title.includes('just a moment') ||
        title.includes('checking your browser') ||
        title.includes('attention required') ||
        title.includes('one moment')
      ) {
        return true;
      }

      // Check for Cloudflare challenge elements
      const cfSelectors = [
        '#cf-browser-verification',
        '.cf-browser-verification',
        '#challenge-running',
        '#challenge-form',
        '#challenge-stage',
        '.challenge-running',
        '[id*="cf-challenge"]',
        '[class*="cf-challenge"]',
        '#cf-wrapper',
        '.cf-wrapper',
      ];

      for (const selector of cfSelectors) {
        if (document.querySelector(selector)) {
          return true;
        }
      }

      // Check for Cloudflare-specific meta tags
      const metas = Array.from(document.querySelectorAll('meta'));
      for (const meta of metas) {
        const content = meta.getAttribute('content')?.toLowerCase() || '';
        const httpEquiv = meta.getAttribute('http-equiv')?.toLowerCase() || '';

        // Cloudflare often uses meta refresh for challenges
        if (httpEquiv === 'refresh' && content.includes('__cf_chl')) {
          return true;
        }
      }

      // Check for ray ID (Cloudflare identifier)
      const bodyText = document.body?.textContent?.toLowerCase() || '';
      if (
        bodyText.includes('ray id:') &&
        (bodyText.includes('cloudflare') || bodyText.includes('please wait'))
      ) {
        return true;
      }

      // Check for challenge script
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const src = script.getAttribute('src') || '';
        if (src.includes('challenges.cloudflare.com') || src.includes('/cdn-cgi/challenge')) {
          return true;
        }
      }

      return false;
    });

    return result;
  } catch {
    return false;
  }
}

/**
 * Check if page requires login to access content.
 *
 * Detects login walls by looking for:
 * - Prominent login forms
 * - "Login required" messaging
 * - URLs containing auth paths
 * - Minimal content besides the login form
 *
 * @param page - Playwright page instance
 * @returns true if login wall is detected
 */
export async function detectLoginWall(page: Page): Promise<boolean> {
  try {
    // First check URL patterns
    const url = page.url().toLowerCase();
    const authPaths = ['/login', '/signin', '/sign-in', '/auth', '/account/login', '/sso'];
    const isAuthUrl = authPaths.some((path) => url.includes(path));

    const result = await page.evaluate(
      ({ isAuthUrl }) => {
        // Look for password fields (strong indicator of login form)
        const passwordFields = document.querySelectorAll('input[type="password"]');
        if (passwordFields.length === 0) {
          return false;
        }

        // Check if password field is visible and prominent
        const visiblePasswordFields = Array.from(passwordFields).filter((field) => {
          const rect = field.getBoundingClientRect();
          const style = window.getComputedStyle(field);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        });

        if (visiblePasswordFields.length === 0) {
          return false;
        }

        // Check for login-related text
        const bodyText = document.body?.textContent?.toLowerCase() || '';
        const loginIndicators = [
          'sign in',
          'log in',
          'login required',
          'please sign in',
          'please log in',
          'must be logged in',
          'authentication required',
          'access denied',
          'members only',
          'subscribers only',
        ];

        const hasLoginText = loginIndicators.some((indicator) => bodyText.includes(indicator));

        // Check for login form selectors
        const loginSelectors = [
          'form[action*="login"]',
          'form[action*="signin"]',
          'form[action*="auth"]',
          '[class*="login-form"]',
          '[class*="signin-form"]',
          '[id*="login-form"]',
          '[id*="signin-form"]',
        ];

        const hasLoginForm = loginSelectors.some((selector) => document.querySelector(selector));

        // Count main content elements
        const contentElements = document.querySelectorAll('article, main, [role="main"]');
        const hasMinimalContent =
          contentElements.length === 0 ||
          Array.from(contentElements).every((el) => {
            const text = el.textContent?.trim() || '';
            return text.length < 200;
          });

        // Login wall detected if:
        // - Has visible password field AND
        // - (Has login text OR has login form OR is auth URL) AND
        // - Has minimal content
        return (hasLoginText || hasLoginForm || isAuthUrl) && hasMinimalContent;
      },
      { isAuthUrl }
    );

    return result;
  } catch {
    return false;
  }
}

/**
 * Check if page has a paywall blocking content.
 *
 * Detects paywalls by looking for:
 * - Common paywall class names and IDs
 * - Subscription/payment messaging
 * - Blurred or truncated content with overlays
 * - Metered paywall indicators
 *
 * @param page - Playwright page instance
 * @returns true if paywall is detected
 */
export async function detectPaywall(page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(() => {
      // Check for explicit paywall elements
      const paywallSelectors = [
        '[class*="paywall"]',
        '[id*="paywall"]',
        '[class*="subscription-wall"]',
        '[class*="premium-wall"]',
        '[class*="subscriber-only"]',
        '[data-paywall]',
        '.piano-offer',
        '.tp-modal', // Piano paywall modal
        '[class*="metered"]',
        '[class*="gate"]',
        '.regwall',
        '.reg-wall',
      ];

      for (const selector of paywallSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const style = window.getComputedStyle(element);
          // Make sure the element is visible
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true;
          }
        }
      }

      // Check for paywall text indicators
      const bodyText = document.body?.textContent?.toLowerCase() || '';
      const paywallIndicators = [
        'subscribe to continue',
        'subscribe to read',
        'subscription required',
        'premium content',
        'members only',
        'subscriber exclusive',
        'unlock this article',
        'become a member',
        'start your free trial',
        'already a subscriber?',
        'not a subscriber?',
        'to continue reading',
        'this article is for subscribers',
        'this content is for subscribers',
        'free articles remaining',
        'articles left this month',
      ];

      const hasPaywallText = paywallIndicators.some((indicator) => bodyText.includes(indicator));

      if (hasPaywallText) {
        // Verify there's also a blocking overlay or truncated content
        const overlays = Array.from(
          document.querySelectorAll(
            '[class*="overlay"], [class*="modal"], [class*="blur"], [class*="fade"]'
          )
        );

        for (const overlay of overlays) {
          const style = window.getComputedStyle(overlay);
          const rect = overlay.getBoundingClientRect();

          // Check if overlay is visible and covers significant area
          if (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > window.innerWidth * 0.3 &&
            rect.height > 100
          ) {
            return true;
          }
        }

        // Check for content blur
        const contentAreas = Array.from(
          document.querySelectorAll('article, .article, [class*="content"]')
        );
        for (const content of contentAreas) {
          const style = window.getComputedStyle(content);
          if (style.filter?.includes('blur') || style.opacity === '0.5') {
            return true;
          }
        }
      }

      // Check for gradient fade indicating truncated content
      const fadeElements = Array.from(
        document.querySelectorAll('[class*="gradient"], [class*="fade-out"]')
      );
      for (const fade of fadeElements) {
        const rect = fade.getBoundingClientRect();
        // If there's a large gradient overlay, likely a paywall
        if (rect.width > window.innerWidth * 0.5 && rect.height > 50) {
          const parent = fade.parentElement;
          if (parent?.textContent?.toLowerCase().includes('subscribe')) {
            return true;
          }
        }
      }

      return false;
    });

    return result;
  } catch {
    return false;
  }
}

/**
 * Check if page is an error page.
 *
 * Detects:
 * - 403 Forbidden
 * - 404 Not Found
 * - 500 Server Error
 * - Access Denied / Blocked pages
 * - Service Unavailable
 *
 * @param page - Playwright page instance
 * @returns Detection result with error type if found
 */
export async function detectErrorPage(page: Page): Promise<ErrorResult> {
  try {
    const result = await page.evaluate(() => {
      const title = document.title?.toLowerCase() || '';
      const bodyText = document.body?.textContent?.toLowerCase() || '';
      const h1Text =
        document.querySelector('h1')?.textContent?.toLowerCase() ||
        document.querySelector('h2')?.textContent?.toLowerCase() ||
        '';

      // Check for 403 Forbidden
      const is403 =
        title.includes('403') ||
        title.includes('forbidden') ||
        h1Text.includes('403') ||
        h1Text.includes('forbidden') ||
        (bodyText.includes('403') && bodyText.includes('forbidden'));

      if (is403) {
        return { isError: true, type: '403' as const };
      }

      // Check for 404 Not Found
      const is404 =
        title.includes('404') ||
        title.includes('not found') ||
        title.includes('page not found') ||
        h1Text.includes('404') ||
        h1Text.includes('not found') ||
        (bodyText.includes('404') && bodyText.includes('not found'));

      if (is404) {
        return { isError: true, type: '404' as const };
      }

      // Check for 500 Server Error
      const is500 =
        title.includes('500') ||
        title.includes('server error') ||
        title.includes('internal error') ||
        h1Text.includes('500') ||
        h1Text.includes('server error') ||
        h1Text.includes('internal error') ||
        (bodyText.includes('500') && bodyText.includes('error'));

      if (is500) {
        return { isError: true, type: '500' as const };
      }

      // Check for access denied / blocked
      const isBlocked =
        title.includes('access denied') ||
        title.includes('blocked') ||
        title.includes('request blocked') ||
        h1Text.includes('access denied') ||
        h1Text.includes('blocked') ||
        bodyText.includes('your access has been blocked') ||
        bodyText.includes('access to this page has been denied') ||
        bodyText.includes('ip address has been blocked') ||
        bodyText.includes('you have been blocked');

      if (isBlocked) {
        return { isError: true, type: 'blocked' as const };
      }

      // Check for service unavailable
      const isUnavailable =
        title.includes('unavailable') ||
        title.includes('service unavailable') ||
        title.includes('temporarily unavailable') ||
        title.includes('503') ||
        h1Text.includes('unavailable') ||
        h1Text.includes('503') ||
        (bodyText.includes('service') && bodyText.includes('unavailable')) ||
        bodyText.includes('currently unavailable') ||
        bodyText.includes('try again later');

      if (isUnavailable) {
        return { isError: true, type: 'unavailable' as const };
      }

      return { isError: false };
    });

    return result;
  } catch {
    return { isError: false };
  }
}

/**
 * Master function that runs all detectors and returns the first match.
 *
 * Runs detectors in priority order:
 * 1. Cloudflare challenge (most common and blocks everything)
 * 2. CAPTCHA (requires human intervention)
 * 3. Error pages (page didn't load properly)
 * 4. Login walls (content exists but is protected)
 * 5. Paywalls (content exists but requires payment)
 *
 * @param page - Playwright page instance
 * @returns Blocker detection result with reason and details
 */
export async function detectBlockers(page: Page): Promise<BlockerResult> {
  try {
    // Run all detectors in parallel for speed
    const [cloudflare, captcha, error, login, paywall] = await Promise.all([
      detectCloudflareChallenge(page),
      detectCaptcha(page),
      detectErrorPage(page),
      detectLoginWall(page),
      detectPaywall(page),
    ]);

    // Check in priority order
    if (cloudflare) {
      return {
        blocked: true,
        reason: 'cloudflare',
        details: 'Cloudflare browser verification challenge detected',
      };
    }

    if (captcha.detected) {
      return {
        blocked: true,
        reason: 'captcha',
        details: `CAPTCHA detected: ${captcha.type || 'unknown type'}`,
      };
    }

    if (error.isError) {
      return {
        blocked: true,
        reason: 'error',
        details: `Error page detected: ${error.type || 'unknown error'}`,
      };
    }

    if (login) {
      return {
        blocked: true,
        reason: 'login',
        details: 'Login wall detected - authentication required',
      };
    }

    if (paywall) {
      return {
        blocked: true,
        reason: 'paywall',
        details: 'Paywall detected - subscription required',
      };
    }

    return { blocked: false };
  } catch (err) {
    // If detection itself fails, don't block - let the request proceed
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      blocked: false,
      details: `Detection failed: ${message}`,
    };
  }
}

/**
 * Quick check for obvious blocks without running full detection.
 * Useful for fast-fail scenarios.
 *
 * @param page - Playwright page instance
 * @returns true if obviously blocked
 */
export async function isObviouslyBlocked(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    const lowerTitle = title.toLowerCase();

    // Quick title-based checks
    const obviousBlockers = [
      'just a moment',
      'checking your browser',
      'access denied',
      '403 forbidden',
      '404 not found',
      'blocked',
    ];

    return obviousBlockers.some((blocker) => lowerTitle.includes(blocker));
  } catch {
    return false;
  }
}
