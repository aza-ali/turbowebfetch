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
  /** Page navigation timeout in ms (TURBOFETCH_NAV_TIMEOUT, default: 60000) */
  navigation: number;
  /** Wait-for-selector timeout in ms (TURBOFETCH_WAIT_TIMEOUT, default: 10000) */
  waitFor: number;
}

/** Browser configuration */
export interface BrowserConfig {
  /** Run browser in headless mode (TURBOFETCH_HEADLESS, default: true) */
  headless: boolean;
  /** Enable human-mode scrolling and delays (TURBOFETCH_HUMAN_MODE, default: true) */
  humanMode: boolean;
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
      navigation: 60000,
      waitFor: 10000,
    },
    browser: {
      headless: true,
      humanMode: true,
    },
    stealth: {
      enabled: true,
      dismissCookies: true,
      dismissPopups: true,
      triggerLazyLoad: true,
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
      navigation: parseEnvInt('TURBOFETCH_NAV_TIMEOUT', 60000),
      waitFor: parseEnvInt('TURBOFETCH_WAIT_TIMEOUT', 10000),
    },
    browser: {
      headless: parseEnvBool('TURBOFETCH_HEADLESS', true),
      humanMode: parseEnvBool('TURBOFETCH_HUMAN_MODE', true),
    },
    stealth: {
      enabled: parseEnvBool('TURBOFETCH_STEALTH_ENABLED', true),
      dismissCookies: parseEnvBool('TURBOFETCH_DISMISS_COOKIES', true),
      dismissPopups: parseEnvBool('TURBOFETCH_DISMISS_POPUPS', true),
      triggerLazyLoad: parseEnvBool('TURBOFETCH_LAZY_LOAD', true),
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

  // Browser validation (nodriver handles user-agent and viewport automatically)
  // No additional browser config validation needed

  // Stealth validation (nodriver handles fingerprinting automatically via undetected Chrome)
  // No additional stealth config validation needed

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
