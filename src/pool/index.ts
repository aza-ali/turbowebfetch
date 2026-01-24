/**
 * Browser Pool Module
 *
 * Exports the browser pool management functionality for the TurboFetch MCP server.
 */

export { BrowserInstance, BrowserInstanceConfig } from './instance.js';
export {
  PoolManager,
  PoolManagerConfig,
  PoolStats,
  getPoolManager,
  shutdownPoolManager,
  withBrowserInstance,
  browserPool
} from './manager.js';
