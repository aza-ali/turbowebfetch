/**
 * Stealth module exports
 *
 * Provides utilities for handling anti-bot measures:
 * - Blocker detection (CAPTCHA, login walls, etc.)
 * - Overlay dismissal (cookie banners, popups)
 * - Lazy loading triggers
 */

export {
  detectBlockers,
  detectCloudflareChallenge,
  isObviouslyBlocked,
  type BlockerResult,
} from "./detectors.js";

export {
  dismissAllOverlays,
  dismissCookieBanners,
  dismissPopups,
  removeBlockingOverlays,
  triggerLazyLoading,
  fullScrollSimulation,
  preparePageForExtraction,
  type DismissResult,
} from "./dismissers.js";
