/**
 * Browser Pool Manager - Manages a pool of BrowserInstance objects
 *
 * Uses generic-pool library to handle:
 * - Instance creation and destruction
 * - Connection pooling with min/max limits
 * - Idle timeout and instance recycling
 * - Health validation before acquisition
 */

import { createPool, Pool, Options as PoolOptions } from 'generic-pool';
import { BrowserInstance, BrowserInstanceConfig } from './instance.js';

export interface PoolManagerConfig {
  // Pool sizing
  minInstances?: number;
  maxInstances?: number;

  // Timeouts (in milliseconds)
  idleTimeoutMs?: number;
  acquireTimeoutMs?: number;
  evictionRunIntervalMs?: number;

  // Instance lifecycle
  maxInstanceAgeMs?: number;
  maxRequestsPerInstance?: number;

  // Browser config passed to instances
  browserConfig?: BrowserInstanceConfig;
}

const DEFAULT_POOL_CONFIG: Required<Omit<PoolManagerConfig, 'browserConfig'>> & { browserConfig: BrowserInstanceConfig } = {
  minInstances: 2,
  maxInstances: 14,
  idleTimeoutMs: 0,              // Never idle out - keep browsers hot
  acquireTimeoutMs: 30000,       // 30 seconds
  evictionRunIntervalMs: 30000,  // 30 seconds
  maxInstanceAgeMs: 3600000,     // 1 hour (recycle old instances)
  maxRequestsPerInstance: 200,   // Higher limit before recycle
  browserConfig: {}
};

export class PoolManager {
  private pool: Pool<BrowserInstance>;
  private config: Required<Omit<PoolManagerConfig, 'browserConfig'>> & { browserConfig: BrowserInstanceConfig };
  private isShuttingDown: boolean = false;

  constructor(config: PoolManagerConfig = {}) {
    this.config = {
      ...DEFAULT_POOL_CONFIG,
      ...config,
      browserConfig: { ...DEFAULT_POOL_CONFIG.browserConfig, ...config.browserConfig }
    };

    this.pool = this.createPool();
  }

  private createPool(): Pool<BrowserInstance> {
    const factory = {
      /**
       * Create a fresh browser instance
       */
      create: async (): Promise<BrowserInstance> => {
        const instance = await BrowserInstance.create(this.config.browserConfig);
        return instance;
      },

      /**
       * Destroy a browser instance - close context and browser
       */
      destroy: async (instance: BrowserInstance): Promise<void> => {
        await instance.close();
      },

      /**
       * Validate an instance before acquisition
       * Returns false if instance should be destroyed and recreated
       */
      validate: async (instance: BrowserInstance): Promise<boolean> => {
        // Check if browser is still connected
        if (!instance.isHealthy()) {
          return false;
        }

        // Check if instance is too old (> 5 minutes by default)
        if (instance.age > this.config.maxInstanceAgeMs) {
          return false;
        }

        // Check if instance has served too many requests
        if (instance.requestCount >= this.config.maxRequestsPerInstance) {
          return false;
        }

        return true;
      }
    };

    const poolOptions: PoolOptions = {
      min: this.config.minInstances,
      max: this.config.maxInstances,
      acquireTimeoutMillis: this.config.acquireTimeoutMs,
      idleTimeoutMillis: this.config.idleTimeoutMs,
      evictionRunIntervalMillis: this.config.evictionRunIntervalMs,
      testOnBorrow: true,  // Validate before returning to caller
      autostart: true      // Start creating min instances immediately
    };

    return createPool(factory, poolOptions);
  }

  /**
   * Acquire a browser instance from the pool
   * Blocks until an instance is available or timeout is reached
   *
   * @throws Error if pool is draining or acquire times out
   */
  async acquire(): Promise<BrowserInstance> {
    if (this.isShuttingDown) {
      throw new Error('Pool is shutting down - cannot acquire new instances');
    }

    try {
      const instance = await this.pool.acquire();
      return instance;
    } catch (error) {
      if (error instanceof Error) {
        // Wrap with more context
        throw new Error(`Failed to acquire browser instance: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Release a browser instance back to the pool
   * The instance will be validated before being reused
   *
   * @param instance - The instance to release
   */
  async release(instance: BrowserInstance): Promise<void> {
    try {
      await this.pool.release(instance);
    } catch {
      // Instance may have been invalidated - destroy it
      try {
        await this.pool.destroy(instance);
      } catch {
        // Already destroyed
      }
    }
  }

  /**
   * Drain the pool - stop accepting new acquires and close all instances
   * Call this during shutdown
   */
  async drain(): Promise<void> {
    this.isShuttingDown = true;

    // Stop accepting new acquisitions
    await this.pool.drain();

    // Clear all remaining instances
    await this.pool.clear();
  }

  /**
   * Get current pool statistics
   */
  getStats(): PoolStats {
    return {
      size: this.pool.size,
      available: this.pool.available,
      borrowed: this.pool.borrowed,
      pending: this.pool.pending,
      min: this.pool.min,
      max: this.pool.max
    };
  }

  /**
   * Check if the pool is healthy
   * Returns true if there are available instances or capacity to create more
   */
  isHealthy(): boolean {
    if (this.isShuttingDown) {
      return false;
    }

    const stats = this.getStats();
    return stats.available > 0 || stats.size < stats.max;
  }

  /**
   * Pre-warm the pool by creating minimum instances
   * This is non-blocking - call it on startup and let it run in background
   */
  async warmup(): Promise<void> {
    const instancesToWarm = this.config.minInstances;
    const instances: BrowserInstance[] = [];

    try {
      // Acquire minimum instances in parallel
      const acquisitions = Array(instancesToWarm)
        .fill(null)
        .map(() => this.pool.acquire());

      const acquired = await Promise.all(acquisitions);
      instances.push(...acquired);

      // Release them back to the pool (now they're warm and available)
      await Promise.all(instances.map(instance => this.pool.release(instance)));
    } catch (error) {
      // Release any acquired instances on error
      await Promise.all(instances.map(instance => {
        try {
          return this.pool.release(instance);
        } catch {
          return Promise.resolve();
        }
      }));
      throw error;
    }
  }
}

export interface PoolStats {
  /** Current total number of instances (borrowed + available) */
  size: number;
  /** Number of instances available for acquisition */
  available: number;
  /** Number of instances currently in use */
  borrowed: number;
  /** Number of acquisition requests waiting */
  pending: number;
  /** Minimum pool size */
  min: number;
  /** Maximum pool size */
  max: number;
}

// Singleton instance for the application
let poolManagerInstance: PoolManager | null = null;

/**
 * Get or create the global pool manager instance
 */
export function getPoolManager(config?: PoolManagerConfig): PoolManager {
  if (!poolManagerInstance) {
    poolManagerInstance = new PoolManager(config);
  }
  return poolManagerInstance;
}

/**
 * Shutdown the global pool manager
 * Should be called during application shutdown
 */
export async function shutdownPoolManager(): Promise<void> {
  if (poolManagerInstance) {
    await poolManagerInstance.drain();
    poolManagerInstance = null;
  }
}

/**
 * Helper function to execute a task with a pooled browser instance
 * Automatically acquires and releases the instance
 *
 * @param task - Function to execute with the browser instance
 * @param config - Optional pool configuration (only used if pool not initialized)
 */
export async function withBrowserInstance<T>(
  task: (instance: BrowserInstance) => Promise<T>,
  config?: PoolManagerConfig
): Promise<T> {
  const manager = getPoolManager(config);
  const instance = await manager.acquire();

  try {
    return await task(instance);
  } finally {
    await manager.release(instance);
  }
}

/**
 * Singleton browser pool instance for use throughout the application
 * This is the primary export that other modules should use
 *
 * Usage:
 *   import { browserPool } from '../pool/manager.js';
 *   const instance = await browserPool.acquire();
 *   // ... use instance
 *   await browserPool.release(instance);
 */
export const browserPool = getPoolManager();
