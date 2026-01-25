#!/usr/bin/env node

/**
 * TurboFetch MCP Server - Entry Point
 *
 * This is the main entry point for the MCP server. It initializes
 * the configuration, sets up the server, and starts listening on stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";

import { createServer, setupRequestHandlers, registerToolHandlers } from "./server.js";
import { getDefaultConfig, type ToolHandlers } from "./types.js";
import { fetchPage, fetchBatch } from "./tools/index.js";

// =============================================================================
// Public Exports (for library usage)
// =============================================================================

export {
  // Types
  type ContentFormat,
  type FetchOptions,
  type FetchBatchOptions,
  type FetchResult,
  type FetchError,
  type FetchErrorCode,
  type FetchResponse,
  type FetchBatchResult,
  type RawPageContent,
  type RateLimiterConfig,
  type RateLimiterState,
  type PythonFetcherConfig,
  type TimeoutConfig,
  type ServerConfig,
  type LogLevel,
  type LogEntry,
  type FetchHandler,
  type FetchBatchHandler,
  type ToolHandlers,
  // Schemas
  ContentFormatSchema,
  FetchOptionsSchema,
  FetchBatchOptionsSchema,
  // Functions
  getDefaultConfig,
  isSuccessResponse,
  isErrorResponse,
  createSuccessResponse,
  createErrorResponse,
} from "./types.js";

export { fetchPage, fetchBatch } from "./tools/index.js";
export { createServer, setupRequestHandlers, registerToolHandlers } from "./server.js";
export { rateLimiter } from "./rate-limit/limiter.js";

// =============================================================================
// Server State
// =============================================================================

let isShuttingDown = false;
let serverTransport: StdioServerTransport | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;

// =============================================================================
// Logging
// =============================================================================

/**
 * Log to stderr (stdout is reserved for MCP protocol)
 */
function log(level: "info" | "warn" | "error" | "debug", message: string, data?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data !== undefined && { data }),
  };
  console.error(JSON.stringify(entry));
}

// =============================================================================
// Tool Handlers
// =============================================================================

/**
 * Creates the actual tool handlers using the fetch implementations
 */
function createToolHandlers(): ToolHandlers {
  return {
    fetch: async (options) => {
      log("debug", "Fetch handler called", { url: options.url });
      return fetchPage(options);
    },

    fetchBatch: async (options) => {
      log("debug", "Fetch batch handler called", { urlCount: options.urls.length });
      return fetchBatch(options);
    },
  };
}

// =============================================================================
// Orphan Cleanup
// =============================================================================

/**
 * Cleans up orphaned Chrome processes from previous TurboWebFetch sessions.
 *
 * Uses three strategies:
 * 1. Kill processes with 'turbowebfetch' in user-data-dir
 * 2. Kill processes using nodriver temp directories
 * 3. Kill headless Chrome processes running >5 minutes (likely stuck)
 *
 * IMPORTANT: Only kills Chrome processes that were spawned by TurboWebFetch,
 * NOT the user's personal Chrome browser.
 */
function cleanupOrphanedBrowsers(): void {
  let totalKilled = 0;

  // Strategy 1: Kill TurboWebFetch processes (covers both turbowebfetch_ and turbowebfetch_chrome_)
  try {
    const psOutput = execSync(
      'ps -eo pid,args | grep -i "chrome" | grep "turbowebfetch" | grep -v grep',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (psOutput) {
      for (const line of psOutput.split('\n')) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 'SIGKILL');  // Use SIGKILL for immediate termination
            totalKilled++;
          } catch {
            // Process may have already exited
          }
        }
      }
    }
  } catch {
    // No matching processes - that's fine
  }

  // Strategy 2: Kill nodriver temp directory processes
  try {
    const psOutput = execSync(
      'ps -eo pid,args | grep -i "chrome" | grep -E "/tmp/\\.org\\.chromium|/tmp/nodriver" | grep -v grep',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (psOutput) {
      for (const line of psOutput.split('\n')) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
            totalKilled++;
          } catch {
            // Process may have already exited
          }
        }
      }
    }
  } catch {
    // No matching processes - that's fine
  }

  // Strategy 3: Kill long-running headless Chrome (>5 minutes = likely stuck)
  try {
    // ps etime format: [[dd-]hh:]mm:ss
    const psOutput = execSync(
      'ps -eo pid,etime,args | grep -i "chrome" | grep "\\-\\-headless" | grep -v grep',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (psOutput) {
      for (const line of psOutput.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;

        const pid = parseInt(parts[0], 10);
        const etime = parts[1];  // Format: [[dd-]hh:]mm:ss

        if (isNaN(pid)) continue;

        // Parse elapsed time to seconds
        let totalSeconds = 0;
        const etimeParts = etime.split(/[-:]/);
        if (etimeParts.length === 2) {
          // mm:ss
          totalSeconds = parseInt(etimeParts[0], 10) * 60 + parseInt(etimeParts[1], 10);
        } else if (etimeParts.length === 3) {
          // hh:mm:ss
          totalSeconds = parseInt(etimeParts[0], 10) * 3600 + parseInt(etimeParts[1], 10) * 60 + parseInt(etimeParts[2], 10);
        } else if (etimeParts.length === 4) {
          // dd-hh:mm:ss
          totalSeconds = parseInt(etimeParts[0], 10) * 86400 + parseInt(etimeParts[1], 10) * 3600 +
                         parseInt(etimeParts[2], 10) * 60 + parseInt(etimeParts[3], 10);
        }

        // Kill if running >5 minutes (300 seconds)
        if (totalSeconds > 300) {
          try {
            process.kill(pid, 'SIGKILL');
            totalKilled++;
            log("info", "Killed long-running headless Chrome", { pid, elapsed_seconds: totalSeconds });
          } catch {
            // Process may have already exited
          }
        }
      }
    }
  } catch {
    // No matching processes - that's fine
  }

  if (totalKilled > 0) {
    log("info", "Cleaned up orphaned browser processes", { count: totalKilled });
  }
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize and start the MCP server
 */
async function main(): Promise<void> {
  try {
    // Clean up any orphaned browser processes from previous crashed sessions
    cleanupOrphanedBrowsers();

    // Load configuration
    const config = getDefaultConfig();
    log("info", "Configuration loaded", {
      defaultRpm: config.rateLimiter.defaultRequestsPerMinute,
      navTimeout: config.timeouts.navigation,
    });

    // Create server
    const server = createServer();
    log("info", "MCP server created");

    // Register tool handlers
    const handlers = createToolHandlers();
    registerToolHandlers(handlers);
    log("info", "Tool handlers registered");

    // Set up request handlers
    setupRequestHandlers(server);
    log("info", "Request handlers configured");

    // Create stdio transport
    serverTransport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(serverTransport);
    log("info", "Server connected to stdio transport");

    // Handle graceful shutdown
    setupShutdownHandlers(server);

    // Set up periodic cleanup every 5 minutes to catch orphaned processes during runtime
    cleanupInterval = setInterval(() => {
      log("debug", "Running periodic orphan cleanup");
      cleanupOrphanedBrowsers();
    }, 5 * 60 * 1000);  // 5 minutes

    log("info", "TurboFetch MCP Server ready", {
      version: "1.0.0",
      tools: ["fetch", "fetch_batch"],
      engine: "Python/Nodriver (Chrome)",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", "Failed to start server", { error: errorMessage });
    process.exit(1);
  }
}

// =============================================================================
// Shutdown Handling
// =============================================================================

/**
 * Sets up handlers for graceful shutdown
 */
function setupShutdownHandlers(server: ReturnType<typeof createServer>): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      log("warn", "Shutdown already in progress, forcing exit");
      process.exit(1);
    }

    isShuttingDown = true;
    log("info", `Received ${signal}, initiating graceful shutdown`);

    // Clear periodic cleanup interval
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
      log("info", "Cleanup interval cleared");
    }

    try {
      // Give in-flight requests time to complete
      const shutdownTimeout = setTimeout(() => {
        log("warn", "Shutdown timeout reached, forcing exit");
        process.exit(1);
      }, 30000);

      // Close server connection
      await server.close();
      log("info", "Server connection closed");

      // Final cleanup of any remaining Chrome processes
      cleanupOrphanedBrowsers();
      log("info", "Final browser cleanup complete");

      clearTimeout(shutdownTimeout);
      log("info", "Graceful shutdown complete");
      process.exit(0);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("error", "Error during shutdown", { error: errorMessage });
      process.exit(1);
    }
  };

  // Handle termination signals
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    log("error", "Uncaught exception", {
      error: error.message,
      stack: error.stack,
    });
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    log("error", "Unhandled rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    shutdown("unhandledRejection");
  });
}

// =============================================================================
// Start Server
// =============================================================================

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
