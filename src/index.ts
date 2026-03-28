#!/usr/bin/env node

/**
 * TurboFetch MCP Server - Entry Point
 *
 * This is the main entry point for the MCP server. It initializes
 * the configuration, sets up the server, and starts listening on stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

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
// Runtime Environment Validation
// =============================================================================

const __indexFilename = fileURLToPath(import.meta.url);
const __indexDirname = dirname(__indexFilename);
const INDEX_PROJECT_ROOT = resolve(__indexDirname, "..");

/**
 * Validates that the Python environment is functional and auto-repairs if possible.
 *
 * Checks performed:
 * 1. Python venv exists and the binary is executable
 * 2. Required Python modules can be imported (nodriver, readability, markdownify)
 * 3. Chrome browser is installed
 *
 * Auto-repair:
 * - If the venv Python binary is a broken symlink (e.g., after brew upgrade), recreates the venv
 * - If imports fail due to nodriver encoding issues (Python 3.14+), patches the source files
 * - If dependencies are missing, reinstalls them
 */
function validateEnvironment(): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const config = getDefaultConfig();
  const pythonPath = config.python.pythonPath;
  const fetcherScript = config.python.fetcherScript;
  const pythonDir = dirname(fetcherScript);
  const venvDir = resolve(pythonDir, "venv");

  // Check 1: Does the venv exist?
  if (!existsSync(venvDir)) {
    log("warn", "Python venv not found, attempting to create", { venvDir });
    if (!attemptVenvCreation(pythonDir, venvDir)) {
      errors.push(
        `Python virtual environment not found at ${venvDir}. ` +
        `Run: cd ${INDEX_PROJECT_ROOT} && node scripts/postinstall.js`
      );
      return { ok: false, errors, warnings };
    }
  }

  // Check 2: Is the venv Python binary functional?
  if (!existsSync(pythonPath)) {
    log("warn", "Python binary not found, attempting to recreate venv", { pythonPath });
    if (!attemptVenvCreation(pythonDir, venvDir, true)) {
      errors.push(
        `Python binary not found at ${pythonPath}. The virtual environment may be corrupted. ` +
        `This can happen after a Python upgrade (e.g., brew upgrade python). ` +
        `Fix: rm -rf ${venvDir} && cd ${INDEX_PROJECT_ROOT} && node scripts/postinstall.js`
      );
      return { ok: false, errors, warnings };
    }
  }

  // Check 3: Can the venv Python actually run?
  const versionCheck = spawnSync(pythonPath, ["--version"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  });

  if (versionCheck.status !== 0) {
    log("warn", "Python binary exists but won't run, attempting to recreate venv", {
      pythonPath, stderr: versionCheck.stderr?.slice(0, 200)
    });
    if (!attemptVenvCreation(pythonDir, venvDir, true)) {
      errors.push(
        `Python at ${pythonPath} is not functional (exit code ${versionCheck.status}). ` +
        `Fix: rm -rf ${venvDir} && cd ${INDEX_PROJECT_ROOT} && node scripts/postinstall.js`
      );
      return { ok: false, errors, warnings };
    }
  }

  // Check 4: Can we import required modules?
  const importCheck = spawnSync(
    pythonPath,
    ["-c", "import nodriver; import readability; import markdownify; print('ok')"],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }
  );

  if (importCheck.status !== 0 || importCheck.stdout?.trim() !== "ok") {
    const stderr = importCheck.stderr || "";

    // Check if it's the nodriver encoding issue
    if (stderr.includes("Non-UTF-8") || stderr.includes("SyntaxError")) {
      log("info", "Detected nodriver encoding issue, patching...");
      patchNodriverEncoding(venvDir);

      // Retry import
      const retryCheck = spawnSync(
        pythonPath,
        ["-c", "import nodriver; import readability; import markdownify; print('ok')"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }
      );

      if (retryCheck.status === 0 && retryCheck.stdout?.trim() === "ok") {
        log("info", "Nodriver encoding patched successfully");
      } else {
        errors.push(
          `Python import check failed even after patching. stderr: ${(retryCheck.stderr || stderr).slice(0, 300)}. ` +
          `Fix: rm -rf ${venvDir} && cd ${INDEX_PROJECT_ROOT} && node scripts/postinstall.js`
        );
        return { ok: false, errors, warnings };
      }
    } else if (stderr.includes("ModuleNotFoundError") || stderr.includes("No module named")) {
      // Missing dependencies - try to install them
      log("info", "Missing Python dependencies, attempting to install...");
      const pipPath = process.platform === "win32"
        ? join(venvDir, "Scripts", "pip.exe")
        : join(venvDir, "bin", "pip");
      const requirementsPath = join(pythonDir, "requirements.txt");

      try {
        execSync(`"${pipPath}" install -r "${requirementsPath}" -q`, {
          cwd: pythonDir,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 120000,
        });

        // Patch after install in case of encoding issues
        patchNodriverEncoding(venvDir);

        // Retry
        const retryCheck = spawnSync(
          pythonPath,
          ["-c", "import nodriver; import readability; import markdownify; print('ok')"],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }
        );

        if (retryCheck.status === 0 && retryCheck.stdout?.trim() === "ok") {
          log("info", "Dependencies installed and verified successfully");
        } else {
          errors.push(
            `Failed to install Python dependencies. stderr: ${(retryCheck.stderr || "").slice(0, 300)}. ` +
            `Fix: ${pipPath} install -r ${requirementsPath}`
          );
          return { ok: false, errors, warnings };
        }
      } catch (err) {
        errors.push(
          `Failed to install Python dependencies: ${err instanceof Error ? err.message : String(err)}. ` +
          `Fix: ${pipPath} install -r ${requirementsPath}`
        );
        return { ok: false, errors, warnings };
      }
    } else {
      errors.push(
        `Python import check failed: ${stderr.slice(0, 300)}. ` +
        `Fix: rm -rf ${venvDir} && cd ${INDEX_PROJECT_ROOT} && node scripts/postinstall.js`
      );
      return { ok: false, errors, warnings };
    }
  }

  // Check 5: Is Chrome installed?
  if (!findChromeRuntime()) {
    warnings.push(
      "Google Chrome not found. TurboWebFetch requires Chrome to fetch web pages. " +
      "Install from: https://www.google.com/chrome/"
    );
  }

  // Check 6: Does fetcher.py exist?
  if (!existsSync(fetcherScript)) {
    errors.push(`Fetcher script not found at ${fetcherScript}. Package may be corrupted.`);
    return { ok: false, errors, warnings };
  }

  return { ok: true, errors, warnings };
}

/**
 * Attempt to create or recreate the Python venv.
 */
function attemptVenvCreation(pythonDir: string, venvDir: string, forceRecreate = false): boolean {
  // Find a system Python
  const candidates = process.platform === "win32"
    ? ["python", "python3"]
    : ["python3.13", "python3.12", "python3.11", "python3.10", "python3.9", "python3.8", "python3", "python"];

  let systemPython: string | null = null;
  for (const cmd of candidates) {
    const check = spawnSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (check.status === 0) {
      const version = check.stdout.trim() || check.stderr.trim();
      const match = version.match(/Python (\d+)\.(\d+)/);
      if (match && parseInt(match[1]) >= 3 && parseInt(match[2]) >= 8) {
        systemPython = cmd;
        break;
      }
    }
  }

  if (!systemPython) {
    log("error", "No suitable Python 3.8+ found on system");
    return false;
  }

  try {
    if (forceRecreate && existsSync(venvDir)) {
      execSync(`rm -rf "${venvDir}"`, { stdio: ["pipe", "pipe", "pipe"] });
    }

    execSync(`${systemPython} -m venv "${venvDir}"`, {
      cwd: pythonDir,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });

    // Install dependencies
    const pipPath = process.platform === "win32"
      ? join(venvDir, "Scripts", "pip.exe")
      : join(venvDir, "bin", "pip");
    const requirementsPath = join(pythonDir, "requirements.txt");

    if (existsSync(requirementsPath)) {
      execSync(`"${pipPath}" install --upgrade pip -q`, {
        cwd: pythonDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      });
      execSync(`"${pipPath}" install -r "${requirementsPath}" -q`, {
        cwd: pythonDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      });
    }

    // Patch nodriver for encoding issues
    patchNodriverEncoding(venvDir);

    log("info", "Python venv created and dependencies installed", { venvDir, python: systemPython });
    return true;
  } catch (err) {
    log("error", "Failed to create Python venv", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Patch nodriver .py files that contain invalid UTF-8 bytes (Latin-1 remnants).
 * Converts isolated non-UTF-8 bytes to their proper UTF-8 encoding.
 */
function patchNodriverEncoding(venvDir: string): void {
  let nodriverDir: string | null = null;

  if (process.platform === "win32") {
    nodriverDir = join(venvDir, "Lib", "site-packages", "nodriver");
  } else {
    const libDir = join(venvDir, "lib");
    if (!existsSync(libDir)) return;

    try {
      const pyDirs = readdirSync(libDir).filter((d: string) => d.startsWith("python"));
      for (const pyDir of pyDirs) {
        const candidate = join(libDir, pyDir, "site-packages", "nodriver");
        if (existsSync(candidate)) {
          nodriverDir = candidate;
          break;
        }
      }
    } catch { return; }
  }

  if (!nodriverDir || !existsSync(nodriverDir)) return;

  let patchCount = 0;
  const walkAndPatch = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndPatch(fullPath);
      } else if (entry.name.endsWith(".py")) {
        try {
          const buf = readFileSync(fullPath);
          // Quick check: does this file have any bytes > 127 that aren't valid UTF-8?
          let hasInvalid = false;
          for (let i = 0; i < buf.length; i++) {
            const b = buf[i];
            if (b > 127) {
              if ((b & 0xe0) === 0xc0 && i + 1 < buf.length && (buf[i + 1] & 0xc0) === 0x80) {
                i += 1; // valid 2-byte
              } else if ((b & 0xf0) === 0xe0 && i + 2 < buf.length && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80) {
                i += 2; // valid 3-byte
              } else if ((b & 0xf8) === 0xf0 && i + 3 < buf.length && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80 && (buf[i + 3] & 0xc0) === 0x80) {
                i += 3; // valid 4-byte
              } else {
                hasInvalid = true;
                break;
              }
            }
          }
          if (!hasInvalid) continue;

          // Patch: convert Latin-1 bytes to proper UTF-8
          const patched: number[] = [];
          for (let i = 0; i < buf.length; i++) {
            const b = buf[i];
            if (b <= 0x7f) {
              patched.push(b);
            } else if ((b & 0xe0) === 0xc0 && i + 1 < buf.length && (buf[i + 1] & 0xc0) === 0x80) {
              patched.push(b, buf[++i]);
            } else if ((b & 0xf0) === 0xe0 && i + 2 < buf.length && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80) {
              patched.push(b, buf[++i], buf[++i]);
            } else if ((b & 0xf8) === 0xf0 && i + 3 < buf.length && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80 && (buf[i + 3] & 0xc0) === 0x80) {
              patched.push(b, buf[++i], buf[++i], buf[++i]);
            } else {
              // Isolated non-UTF-8 byte: encode as UTF-8 (Latin-1 code point)
              patched.push(0xc0 | (b >> 6), 0x80 | (b & 0x3f));
            }
          }

          writeFileSync(fullPath, Buffer.from(patched));
          patchCount++;
        } catch { /* skip unreadable files */ }
      }
    }
  };

  walkAndPatch(nodriverDir);
  if (patchCount > 0) {
    log("info", `Patched ${patchCount} nodriver file(s) for encoding compatibility`);
  }
}

/**
 * Check if Chrome is installed (runtime check)
 */
function findChromeRuntime(): boolean {
  if (process.platform === "darwin") {
    return existsSync("/Applications/Google Chrome.app");
  }
  if (process.platform === "win32") {
    const paths = [
      join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    return paths.some((p) => existsSync(p));
  }
  // Linux
  const cmds = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
  for (const cmd of cmds) {
    const check = spawnSync("which", [cmd], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (check.status === 0) return true;
  }
  return false;
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize and start the MCP server
 */
async function main(): Promise<void> {
  try {
    // Validate Python environment before starting (auto-repairs if possible)
    log("info", "Validating environment...");
    const validation = validateEnvironment();

    for (const warning of validation.warnings) {
      log("warn", warning);
    }

    if (!validation.ok) {
      for (const error of validation.errors) {
        log("error", error);
      }
      log("error", "Environment validation failed. The server will start but fetches may fail.");
      // Don't exit - let the server start so it can return proper error messages via MCP
    } else {
      log("info", "Environment validation passed");
    }

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
