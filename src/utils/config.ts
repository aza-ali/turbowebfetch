/**
 * Configuration management for the TurboFetch MCP server.
 *
 * Loads configuration from environment variables with sensible defaults.
 */

/** Browser pool configuration */
export interface PoolConfig {
  /** Minimum number of warm browser instances (TURBOFETCH_POOL_MIN, default: 2) */
  min: number;
  /** Maximum concurrent browser instances (TURBOFETCH_POOL_MAX, default: 14) */
  max: number;
  /** Milliseconds before recycling idle instances (TURBOFETCH_IDLE_TIMEOUT, default: 60000) */
  idleTimeout: number;
}

/** Rate limiting configuration */
export interface RateLimitConfig {
  /** Default requests per minute per domain (TURBOFETCH_DEFAULT_RPM, default: 60) */
  defaultRpm: number;
}

/** Timeout configuration */
export interface TimeoutConfig {
  /** Page navigation timeout in ms (TURBOFETCH_NAV_TIMEOUT, default: 30000) */
  navigation: number;
  /** Wait-for-selector timeout in ms (TURBOFETCH_WAIT_TIMEOUT, default: 10000) */
  waitFor: number;
}

/** Browser configuration */
export interface BrowserConfig {
  /** Run browser in headless mode (TURBOFETCH_HEADLESS, default: true) */
  headless: boolean;
  /** User agent string for all requests */
  userAgent: string;
  /** Viewport dimensions */
  viewport: {
    width: number;
    height: number;
  };
}

/** Stealth configuration for anti-bot evasion */
export interface StealthConfig {
  /** Enable stealth mode (TURBOFETCH_STEALTH_ENABLED, default: true) */
  enabled: boolean;
  /** Automatically dismiss cookie consent banners (TURBOFETCH_DISMISS_COOKIES, default: true) */
  dismissCookies: boolean;
  /** Automatically dismiss popups and modals (TURBOFETCH_DISMISS_POPUPS, default: true) */
  dismissPopups: boolean;
  /** Trigger lazy-loaded content by scrolling (TURBOFETCH_LAZY_LOAD, default: true) */
  triggerLazyLoad: boolean;
  /** User agent for stealth mode (TURBOFETCH_USER_AGENT, default: Chrome UA) */
  userAgent: string;
  /** Viewport dimensions for stealth mode */
  viewport: {
    width: number;
    height: number;
  };
  /** Browser locale (TURBOFETCH_LOCALE, default: 'en-US') */
  locale: string;
  /** Browser timezone (TURBOFETCH_TIMEZONE, default: 'America/Los_Angeles') */
  timezone: string;
}

/** Retry configuration for failed requests */
export interface RetryConfig {
  /** Maximum number of retry attempts (TURBOFETCH_MAX_RETRIES, default: 3) */
  maxRetries: number;
  /** Base delay between retries in ms (TURBOFETCH_RETRY_DELAY, default: 1000) */
  baseDelayMs: number;
  /** Use exponential backoff for retry delays (default: true) */
  exponentialBackoff: boolean;
}

/** Complete configuration structure */
export interface Config {
  pool: PoolConfig;
  rateLimit: RateLimitConfig;
  timeouts: TimeoutConfig;
  browser: BrowserConfig;
  stealth: StealthConfig;
  retry: RetryConfig;
}

/**
 * Parse an integer from an environment variable with a default fallback.
 */
function parseEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a boolean from an environment variable with a default fallback.
 * Accepts: "true", "1", "yes" as truthy; "false", "0", "no" as falsy.
 */
function parseEnvBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.toLowerCase();
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (value === 'true' || value === '1' || value === 'yes') {
    return true;
  }
  if (value === 'false' || value === '0' || value === 'no') {
    return false;
  }
  return defaultValue;
}

/**
 * Parse a string from an environment variable with a default fallback.
 */
function parseEnvString(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value;
}

/**
 * Standard Chrome user agent string for macOS.
 * This presents as a regular Chrome browser, not a bot.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Get default configuration values.
 * Useful for testing or resetting to defaults.
 */
export function getDefaultConfig(): Config {
  return {
    pool: {
      min: 2,
      max: 14,
      idleTimeout: 60000,
    },
    rateLimit: {
      defaultRpm: 60,
    },
    timeouts: {
      navigation: 30000,
      waitFor: 10000,
    },
    browser: {
      headless: true,
      userAgent: DEFAULT_USER_AGENT,
      viewport: {
        width: 1280,
        height: 800,
      },
    },
    stealth: {
      enabled: true,
      dismissCookies: true,
      dismissPopups: true,
      triggerLazyLoad: true,
      userAgent: DEFAULT_USER_AGENT,
      viewport: {
        width: 1920,
        height: 1080,
      },
      locale: 'en-US',
      timezone: 'America/Los_Angeles',
    },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      exponentialBackoff: true,
    },
  };
}

/**
 * Load configuration from environment variables.
 * Call this function to get the current config (useful for testing with different env values).
 */
export function loadConfig(): Config {
  return {
    pool: {
      min: parseEnvInt('TURBOFETCH_POOL_MIN', 2),
      max: parseEnvInt('TURBOFETCH_POOL_MAX', 14),
      idleTimeout: parseEnvInt('TURBOFETCH_IDLE_TIMEOUT', 60000),
    },
    rateLimit: {
      defaultRpm: parseEnvInt('TURBOFETCH_DEFAULT_RPM', 60),
    },
    timeouts: {
      navigation: parseEnvInt('TURBOFETCH_NAV_TIMEOUT', 30000),
      waitFor: parseEnvInt('TURBOFETCH_WAIT_TIMEOUT', 10000),
    },
    browser: {
      headless: parseEnvBool('TURBOFETCH_HEADLESS', true),
      userAgent: parseEnvString('TURBOFETCH_USER_AGENT', DEFAULT_USER_AGENT),
      viewport: {
        width: parseEnvInt('TURBOFETCH_VIEWPORT_WIDTH', 1280),
        height: parseEnvInt('TURBOFETCH_VIEWPORT_HEIGHT', 800),
      },
    },
    stealth: {
      enabled: parseEnvBool('TURBOFETCH_STEALTH_ENABLED', true),
      dismissCookies: parseEnvBool('TURBOFETCH_DISMISS_COOKIES', true),
      dismissPopups: parseEnvBool('TURBOFETCH_DISMISS_POPUPS', true),
      triggerLazyLoad: parseEnvBool('TURBOFETCH_LAZY_LOAD', true),
      userAgent: parseEnvString('TURBOFETCH_USER_AGENT', DEFAULT_USER_AGENT),
      viewport: {
        width: parseEnvInt('TURBOFETCH_STEALTH_VIEWPORT_WIDTH', 1920),
        height: parseEnvInt('TURBOFETCH_STEALTH_VIEWPORT_HEIGHT', 1080),
      },
      locale: parseEnvString('TURBOFETCH_LOCALE', 'en-US'),
      timezone: parseEnvString('TURBOFETCH_TIMEZONE', 'America/Los_Angeles'),
    },
    retry: {
      maxRetries: parseEnvInt('TURBOFETCH_MAX_RETRIES', 3),
      baseDelayMs: parseEnvInt('TURBOFETCH_RETRY_DELAY', 1000),
      exponentialBackoff: parseEnvBool('TURBOFETCH_EXPONENTIAL_BACKOFF', true),
    },
  };
}

/**
 * Singleton config instance.
 * Loaded once at module initialization.
 */
export const config: Config = loadConfig();

/**
 * Validate configuration values.
 * Returns an array of error messages (empty if valid).
 */
export function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];

  // Pool validation
  if (cfg.pool.min < 0) {
    errors.push('pool.min must be non-negative');
  }
  if (cfg.pool.max < 1) {
    errors.push('pool.max must be at least 1');
  }
  if (cfg.pool.min > cfg.pool.max) {
    errors.push('pool.min cannot exceed pool.max');
  }
  if (cfg.pool.idleTimeout < 1000) {
    errors.push('pool.idleTimeout should be at least 1000ms');
  }

  // Rate limit validation
  if (cfg.rateLimit.defaultRpm < 1) {
    errors.push('rateLimit.defaultRpm must be at least 1');
  }
  if (cfg.rateLimit.defaultRpm > 600) {
    errors.push('rateLimit.defaultRpm should not exceed 600 (10 req/sec)');
  }

  // Timeout validation
  if (cfg.timeouts.navigation < 1000) {
    errors.push('timeouts.navigation should be at least 1000ms');
  }
  if (cfg.timeouts.waitFor < 100) {
    errors.push('timeouts.waitFor should be at least 100ms');
  }

  // Browser validation
  if (cfg.browser.viewport.width < 320) {
    errors.push('browser.viewport.width should be at least 320px');
  }
  if (cfg.browser.viewport.height < 240) {
    errors.push('browser.viewport.height should be at least 240px');
  }

  // Stealth validation
  if (cfg.stealth.viewport.width < 320) {
    errors.push('stealth.viewport.width should be at least 320px');
  }
  if (cfg.stealth.viewport.height < 240) {
    errors.push('stealth.viewport.height should be at least 240px');
  }
  if (!cfg.stealth.locale || cfg.stealth.locale.length < 2) {
    errors.push('stealth.locale must be a valid locale string (e.g., en-US)');
  }
  if (!cfg.stealth.timezone || cfg.stealth.timezone.length < 3) {
    errors.push('stealth.timezone must be a valid timezone string (e.g., America/Los_Angeles)');
  }

  // Retry validation
  if (cfg.retry.maxRetries < 0) {
    errors.push('retry.maxRetries must be non-negative');
  }
  if (cfg.retry.maxRetries > 10) {
    errors.push('retry.maxRetries should not exceed 10');
  }
  if (cfg.retry.baseDelayMs < 100) {
    errors.push('retry.baseDelayMs should be at least 100ms');
  }
  if (cfg.retry.baseDelayMs > 30000) {
    errors.push('retry.baseDelayMs should not exceed 30000ms');
  }

  return errors;
}
