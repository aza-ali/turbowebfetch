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
// Server State
// =============================================================================

let isShuttingDown = false;
let serverTransport: StdioServerTransport | null = null;

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
 * IMPORTANT: Only kills Chrome processes that were spawned by TurboWebFetch,
 * identified by having '--user-data-dir=.../turbowebfetch_chrome_...' in their args.
 *
 * This is safe because:
 * - User's personal Chrome browser does NOT have this user-data-dir
 * - Other applications' Chrome instances do NOT have this marker
 * - Only TurboWebFetch uses the 'turbowebfetch_chrome_' temp directory prefix
 */
function cleanupOrphanedBrowsers(): void {
  try {
    // Get Chrome processes with full command line args
    // We need the full args to check for our specific user-data-dir marker
    const psOutput = execSync(
      'ps -eo pid,args | grep -i "chrome" | grep "turbowebfetch_chrome_" | grep -v grep',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!psOutput) {
      return; // No TurboWebFetch Chrome processes found
    }

    const lines = psOutput.split('\n');
    let orphansKilled = 0;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 1) continue;

      const pid = parseInt(parts[0], 10);
      if (isNaN(pid)) continue;

      // Kill this TurboWebFetch-spawned Chrome process
      try {
        process.kill(pid, 'SIGTERM');
        orphansKilled++;
      } catch {
        // Process may have already exited
      }
    }

    if (orphansKilled > 0) {
      log("info", "Cleaned up orphaned TurboWebFetch browser processes", { count: orphansKilled });
    }
  } catch {
    // ps/grep command failed (no matching processes) - that's fine
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

    try {
      // Give in-flight requests time to complete
      const shutdownTimeout = setTimeout(() => {
        log("warn", "Shutdown timeout reached, forcing exit");
        process.exit(1);
      }, 30000);

      // Close server connection
      await server.close();
      log("info", "Server connection closed");

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
