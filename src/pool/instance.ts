/**
 * BrowserInstance - Wrapper around Playwright browser and context
 *
 * Manages a single browser instance with its associated context.
 * Tracks lifecycle metadata for health checks and pool management.
 * Uses playwright-extra with stealth plugin for anti-detection.
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { randomUUID } from 'crypto';

// Add stealth plugin (do this once at module load)
chromium.use(StealthPlugin());

export interface BrowserInstanceConfig {
  headless?: boolean;
  userAgent?: string;
  viewport?: { width: number; height: number };
  launchArgs?: string[];
}

const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',  // Hide automation
  '--disable-infobars',
  '--window-size=1920,1080',  // Realistic size
  '--start-maximized',
];

// Common viewport sizes to randomize across (reduces fingerprinting)
const COMMON_VIEWPORTS = [
  { width: 1920, height: 1080 },  // 1080p - most common
  { width: 1366, height: 768 },   // Popular laptop
  { width: 1536, height: 864 },   // Popular scaled laptop
  { width: 1440, height: 900 },   // MacBook Pro 15"
  { width: 1280, height: 800 },   // MacBook Air 13"
  { width: 1680, height: 1050 },  // Larger desktop
];

/**
 * Pick a random viewport from common sizes
 */
function getRandomViewport(): { width: number; height: number } {
  return COMMON_VIEWPORTS[Math.floor(Math.random() * COMMON_VIEWPORTS.length)];
}

/**
 * Get the system's actual timezone
 */
function getSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'America/Los_Angeles'; // Fallback
  }
}

const DEFAULT_CONFIG: Required<BrowserInstanceConfig> = {
  headless: true,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 }, // Will be randomized at runtime
  launchArgs: DEFAULT_LAUNCH_ARGS
};

/**
 * BrowserInstance class that matches the expected interface in types.ts
 * Exposes browser, context, id, createdAt, and requestCount as public properties
 */
export class BrowserInstance {
  /** Unique identifier for this instance */
  readonly id: string;

  /** The underlying Playwright Browser */
  readonly browser: Browser;

  /** The browser context (session) - fresh for each instance */
  readonly context: BrowserContext;

  /** Timestamp when this instance was created */
  readonly createdAt: number;

  /** Number of requests served by this instance */
  requestCount: number = 0;

  /** Last time this instance was used */
  private _lastUsedAt: number;

  private constructor(id: string, browser: Browser, context: BrowserContext) {
    this.id = id;
    this.browser = browser;
    this.context = context;
    this.createdAt = Date.now();
    this._lastUsedAt = Date.now();
  }

  /**
   * Factory method to create a new BrowserInstance
   * Launches a fresh Chromium browser with a new context
   * Uses stealth plugin for anti-detection
   */
  static async create(config: BrowserInstanceConfig = {}): Promise<BrowserInstance> {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };

    const browser = await chromium.launch({
      headless: mergedConfig.headless,
      channel: 'chrome',  // Use real Chrome instead of Chromium - harder to detect
      args: mergedConfig.launchArgs
    });

    // Randomize viewport per instance to reduce fingerprinting
    const randomViewport = getRandomViewport();

    // Create fresh context with stealth-friendly defaults
    const context = await browser.newContext({
      userAgent: mergedConfig.userAgent,
      viewport: randomViewport,
      locale: 'en-US',
      timezoneId: getSystemTimezone(), // Use actual system timezone
      // No geolocation spoofing - let it be blocked like privacy-conscious users
      permissions: [],
      // Explicitly disable persistence
      storageState: undefined,
      // Accept downloads but don't save them
      acceptDownloads: false,
      // Standard browser settings
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      // Extra HTTP headers for better stealth
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    const id = randomUUID();
    return new BrowserInstance(id, browser, context);
  }

  /**
   * Create a new page within this browser instance's context
   * Increments the request count for lifecycle tracking
   */
  async createPage(): Promise<Page> {
    if (!this.isHealthy()) {
      throw new Error('Cannot create page: browser instance is not healthy');
    }

    this.requestCount++;
    this._lastUsedAt = Date.now();

    const page = await this.context.newPage();
    return page;
  }

  /**
   * Close the browser instance and all associated resources
   * Should be called when the instance is being destroyed
   */
  async close(): Promise<void> {
    try {
      // Close context first (closes all pages)
      await this.context.close();
    } catch {
      // Context may already be closed
    }

    try {
      // Then close browser
      await this.browser.close();
    } catch {
      // Browser may already be closed
    }
  }

  /**
   * Check if this browser instance is healthy and can be used
   * Returns false if browser is disconnected
   */
  isHealthy(): boolean {
    return this.browser.isConnected();
  }

  /**
   * Get the age of this instance in milliseconds
   */
  get age(): number {
    return Date.now() - this.createdAt;
  }

  /**
   * Get the last time this instance was used
   */
  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  /**
   * Get idle time in milliseconds
   */
  get idleTime(): number {
    return Date.now() - this._lastUsedAt;
  }
}
