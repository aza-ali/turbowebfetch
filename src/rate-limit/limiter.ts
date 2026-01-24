/**
 * Per-domain rate limiter using token bucket algorithm.
 *
 * Tracks requests per domain and enforces rate limits to ensure
 * human-like pacing when fetching web content.
 *
 * Domain extraction:
 * - Uses the full hostname (e.g., jobs.lever.co stays as jobs.lever.co)
 * - This gives finer-grained control - different subdomains can have different limits
 * - Example: api.example.com and www.example.com are tracked separately
 */

export interface RateLimiterConfig {
  /** Default requests per minute for all domains. Defaults to 60. */
  defaultRpm?: number;
  /** Per-domain RPM overrides. Keys are full hostnames. */
  domainLimits?: Record<string, number>;
}

interface TokenBucket {
  /** Current number of tokens available */
  tokens: number;
  /** Max tokens (equals RPM) */
  maxTokens: number;
  /** Last time tokens were replenished */
  lastRefill: number;
  /** Tokens added per millisecond */
  refillRate: number;
}

/**
 * Extracts the hostname from a URL string.
 * Returns the full hostname including subdomains.
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    // If URL parsing fails, try to extract domain from string
    const match = url.match(/^(?:https?:\/\/)?([^\/\s:]+)/i);
    if (match) {
      return match[1].toLowerCase();
    }
    throw new Error(`Invalid URL: ${url}`);
  }
}

export class RateLimiter {
  private readonly defaultRpm: number;
  private readonly domainLimits: Map<string, number>;
  private readonly buckets: Map<string, TokenBucket>;

  constructor(config: RateLimiterConfig = {}) {
    this.defaultRpm = config.defaultRpm ?? 60;
    this.domainLimits = new Map(Object.entries(config.domainLimits ?? {}));
    this.buckets = new Map();
  }

  /**
   * Gets or creates a token bucket for a domain.
   */
  private getOrCreateBucket(domain: string): TokenBucket {
    let bucket = this.buckets.get(domain);

    if (!bucket) {
      const rpm = this.domainLimits.get(domain) ?? this.defaultRpm;
      bucket = {
        tokens: rpm, // Start with full bucket
        maxTokens: rpm,
        lastRefill: Date.now(),
        // Tokens per ms = RPM / 60000ms (1 minute)
        refillRate: rpm / 60000,
      };
      this.buckets.set(domain, bucket);
    }

    return bucket;
  }

  /**
   * Refills tokens based on elapsed time since last refill.
   * Tokens accumulate over time up to the maximum.
   */
  private refillBucket(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;

    if (elapsed > 0) {
      const tokensToAdd = elapsed * bucket.refillRate;
      bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
  }

  /**
   * Calculates time to wait until a token is available.
   * Returns 0 if a token is available now.
   */
  private getWaitTime(bucket: TokenBucket): number {
    this.refillBucket(bucket);

    if (bucket.tokens >= 1) {
      return 0;
    }

    // Calculate time needed to get 1 token
    const tokensNeeded = 1 - bucket.tokens;
    return Math.ceil(tokensNeeded / bucket.refillRate);
  }

  /**
   * Acquires a rate limit token for the given domain.
   * Blocks (waits) if the rate limit is exceeded.
   *
   * @param domain - The domain hostname (e.g., "example.com")
   * @returns Promise that resolves when a token is acquired
   */
  async acquire(domain: string): Promise<void> {
    const normalizedDomain = domain.toLowerCase();
    const bucket = this.getOrCreateBucket(normalizedDomain);
    const waitTime = this.getWaitTime(bucket);

    if (waitTime > 0) {
      // Apply variable jitter to avoid predictable timing patterns
      const jitteredWait = this.applyJitter(waitTime);
      await this.sleep(jitteredWait);
      // Refill again after waiting
      this.refillBucket(bucket);
    }

    // Consume a token
    bucket.tokens -= 1;
  }

  /**
   * Convenience method: acquires a token for a URL.
   * Extracts the domain automatically.
   */
  async acquireForUrl(url: string): Promise<void> {
    const domain = extractDomain(url);
    return this.acquire(domain);
  }

  /**
   * Non-blocking check if a request can be made immediately.
   *
   * @param domain - The domain hostname
   * @returns true if a token is available, false if rate limited
   */
  tryAcquire(domain: string): boolean {
    const normalizedDomain = domain.toLowerCase();
    const bucket = this.getOrCreateBucket(normalizedDomain);
    this.refillBucket(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Non-blocking check for a URL.
   */
  tryAcquireForUrl(url: string): boolean {
    const domain = extractDomain(url);
    return this.tryAcquire(domain);
  }

  /**
   * Gets the number of tokens currently available for a domain.
   * Returns the full limit if the domain hasn't been used yet.
   *
   * @param domain - The domain hostname
   * @returns Number of available tokens (fractional, floored for display)
   */
  getRemainingTokens(domain: string): number {
    const normalizedDomain = domain.toLowerCase();
    const bucket = this.buckets.get(normalizedDomain);

    if (!bucket) {
      // Domain hasn't been used yet, return full limit
      return this.domainLimits.get(normalizedDomain) ?? this.defaultRpm;
    }

    this.refillBucket(bucket);
    return Math.floor(bucket.tokens);
  }

  /**
   * Gets remaining tokens for a URL.
   */
  getRemainingTokensForUrl(url: string): number {
    const domain = extractDomain(url);
    return this.getRemainingTokens(domain);
  }

  /**
   * Gets the configured RPM limit for a domain.
   */
  getLimit(domain: string): number {
    const normalizedDomain = domain.toLowerCase();
    return this.domainLimits.get(normalizedDomain) ?? this.defaultRpm;
  }

  /**
   * Sets a custom RPM limit for a domain.
   * This also resets the bucket for that domain.
   */
  setLimit(domain: string, rpm: number): void {
    if (rpm <= 0) {
      throw new Error(`RPM must be positive, got: ${rpm}`);
    }

    const normalizedDomain = domain.toLowerCase();
    this.domainLimits.set(normalizedDomain, rpm);

    // Reset the bucket to apply new limit
    this.buckets.delete(normalizedDomain);
  }

  /**
   * Resets the rate limiter state for a specific domain.
   */
  reset(domain: string): void {
    const normalizedDomain = domain.toLowerCase();
    this.buckets.delete(normalizedDomain);
  }

  /**
   * Resets all rate limiter state.
   */
  resetAll(): void {
    this.buckets.clear();
  }

  /**
   * Gets stats about current rate limiter state.
   * Useful for debugging and monitoring.
   */
  getStats(): {
    trackedDomains: number;
    domains: Array<{
      domain: string;
      tokens: number;
      limit: number;
    }>;
  } {
    const domains: Array<{ domain: string; tokens: number; limit: number }> = [];

    for (const [domain, bucket] of this.buckets) {
      this.refillBucket(bucket);
      domains.push({
        domain,
        tokens: Math.floor(bucket.tokens),
        limit: bucket.maxTokens,
      });
    }

    return {
      trackedDomains: this.buckets.size,
      domains,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Applies variable jitter to a wait time to avoid predictable patterns.
   * The jitter percentage itself varies (10-30%) for extra unpredictability.
   */
  private applyJitter(baseMs: number): number {
    // Pick a random jitter percentage between 10% and 30%
    const jitterPercent = 0.10 + Math.random() * 0.20;
    // Apply jitter in either direction
    const jitterRange = baseMs * jitterPercent;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    return Math.max(100, Math.round(baseMs + jitter));
  }
}

/**
 * Creates a rate limiter with common configuration for job boards.
 * More conservative limits for sites that are strict about automation.
 */
export function createJobSearchLimiter(): RateLimiter {
  return new RateLimiter({
    defaultRpm: 30, // Conservative default
    domainLimits: {
      // Job boards - moderate limits
      'linkedin.com': 20,
      'www.linkedin.com': 20,
      'indeed.com': 20,
      'www.indeed.com': 20,
      'glassdoor.com': 20,
      'www.glassdoor.com': 20,
      'lever.co': 20,
      'jobs.lever.co': 20,
      'greenhouse.io': 20,
      'boards.greenhouse.io': 20,
      'job-boards.greenhouse.io': 20,
      'workday.com': 15,
      'myworkdayjobs.com': 15,

      // Fortress-level anti-bot - very conservative
      'x.com': 10,
      'twitter.com': 10,
      'airbnb.com': 10,
      'www.airbnb.com': 10,

      // General sites with known anti-bot
      'amazon.com': 15,
      'www.amazon.com': 15,
      'zillow.com': 15,
      'www.zillow.com': 15,
    },
  });
}

/**
 * Default singleton rate limiter instance.
 * Uses job search configuration with conservative limits for common job boards.
 *
 * Usage:
 * ```typescript
 * import { rateLimiter } from './rate-limit/limiter.js';
 * await rateLimiter.acquire('example.com');
 * ```
 */
export const rateLimiter = createJobSearchLimiter();
