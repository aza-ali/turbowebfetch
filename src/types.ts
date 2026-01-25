/**
 * Type definitions for the TurboFetch MCP Server
 *
 * This file contains all shared types, Zod schemas for validation,
 * and configuration interfaces used throughout the server.
 */

import { z } from "zod";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Get project root from this file's location (src/types.ts -> project root)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

// =============================================================================
// Content Formats
// =============================================================================

export const ContentFormatSchema = z.enum(["html", "text", "markdown"]);
export type ContentFormat = z.infer<typeof ContentFormatSchema>;

// =============================================================================
// Fetch Options & Schemas
// =============================================================================

/**
 * Schema for single URL fetch options
 */
export const FetchOptionsSchema = z.object({
  url: z.string().url("Invalid URL format"),
  format: ContentFormatSchema.optional().default("text"),
  wait_for: z.string().optional(),
  timeout: z.number().int().positive().max(120000).optional().default(60000),
  human_mode: z.boolean().optional(),
});

export type FetchOptions = z.infer<typeof FetchOptionsSchema>;

/**
 * Schema for batch URL fetch options
 */
export const FetchBatchOptionsSchema = z.object({
  urls: z
    .array(z.string().url("Invalid URL format"))
    .min(1, "At least one URL is required")
    .max(14, "Maximum 14 URLs per batch"),
  format: ContentFormatSchema.optional().default("text"),
  timeout: z.number().int().positive().max(120000).optional().default(60000),
  human_mode: z.boolean().optional(),
});

export type FetchBatchOptions = z.infer<typeof FetchBatchOptionsSchema>;

// =============================================================================
// Fetch Results
// =============================================================================

/**
 * Successful fetch result
 */
export interface FetchResult {
  success: true;
  content: string;
  url: string;
  title: string;
  status: number;
}

/**
 * Error codes for categorizing fetch failures
 */
export type FetchErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "POOL_EXHAUSTED"
  | "INVALID_URL"
  | "HTTP_ERROR"
  | "EXTRACTION_ERROR"
  | "BLOCKED"
  | "UNKNOWN";

/**
 * Failed fetch result with error details
 */
export interface FetchError {
  success: false;
  error: {
    code: FetchErrorCode;
    message: string;
    status?: number;
  };
  url: string;
  partial_content?: string;
}

/**
 * Union type for any fetch response
 */
export type FetchResponse = FetchResult | FetchError;

/**
 * Result from batch fetch operation
 */
export interface FetchBatchResult {
  results: FetchResponse[];
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * Raw page content before content processing
 */
export interface RawPageContent {
  html: string;
  title: string;
  url: string;
  status: number;
  error?: string;
}

// =============================================================================
// Browser Instance (Deprecated)
// =============================================================================

/**
 * BrowserInstance is deprecated - browser management is now handled by Python nodriver
 */
// export { BrowserInstance } from './pool/instance.js';  // Removed - no longer used

// =============================================================================
// Rate Limiter Configuration
// =============================================================================

/**
 * Configuration for rate limiting
 */
export interface RateLimiterConfig {
  defaultRequestsPerMinute: number;
  domainOverrides: Map<string, number>;
}

/**
 * Internal state for a domain's rate limiter
 */
export interface RateLimiterState {
  domain: string;
  requestsPerMinute: number;
  lastResetTime: number;
  requestCount: number;
}

// =============================================================================
// Server Configuration
// =============================================================================

/**
 * Python fetcher configuration
 * Python process pool settings (Nodriver-based Chrome automation)
 */
export interface PythonFetcherConfig {
  /** Path to Python virtual environment executable */
  pythonPath: string;
  /** Path to fetcher.py script */
  fetcherScript: string;
  /** Maximum concurrent Python processes */
  maxProcesses: number;
}

/**
 * Timeout configuration
 */
export interface TimeoutConfig {
  navigation: number;
  waitFor: number;
}

/**
 * Complete server configuration
 */
export interface ServerConfig {
  python: PythonFetcherConfig;
  timeouts: TimeoutConfig;
  rateLimiter: RateLimiterConfig;
}

// =============================================================================
// Default Configuration
// =============================================================================

/**
 * Default server configuration, can be overridden via environment variables
 */
export function getDefaultConfig(): ServerConfig {
  return {
    python: {
      pythonPath: process.env.TURBOFETCH_PYTHON_PATH || `${PROJECT_ROOT}/python/venv/bin/python`,
      fetcherScript: process.env.TURBOFETCH_FETCHER_SCRIPT || `${PROJECT_ROOT}/python/fetcher.py`,
      maxProcesses: parseInt(process.env.TURBOFETCH_MAX_PROCESSES || "14", 10),
    },
    timeouts: {
      navigation: parseInt(process.env.TURBOFETCH_NAV_TIMEOUT || "60000", 10),
      waitFor: parseInt(process.env.TURBOFETCH_WAIT_TIMEOUT || "10000", 10),
    },
    rateLimiter: {
      defaultRequestsPerMinute: parseInt(process.env.TURBOFETCH_DEFAULT_RPM || "60", 10),
      domainOverrides: new Map([
        ["linkedin.com", 30],
        ["indeed.com", 30],
      ]),
    },
  };
}

// =============================================================================
// Logging Types
// =============================================================================

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  request_id?: string;
  url?: string;
  domain?: string;
  duration_ms?: number;
  status?: number;
  content_length?: number;
  format?: ContentFormat;
  message?: string;
}

// =============================================================================
// Tool Handler Types
// =============================================================================

/**
 * Handler function for single fetch operations
 */
export type FetchHandler = (options: FetchOptions) => Promise<FetchResponse>;

/**
 * Handler function for batch fetch operations
 */
export type FetchBatchHandler = (options: FetchBatchOptions) => Promise<FetchBatchResult>;

/**
 * Collection of tool handlers that must be registered
 */
export interface ToolHandlers {
  fetch: FetchHandler;
  fetchBatch: FetchBatchHandler;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Type guard to check if a response is successful
 */
export function isSuccessResponse(response: FetchResponse): response is FetchResult {
  return response.success === true;
}

/**
 * Type guard to check if a response is an error
 */
export function isErrorResponse(response: FetchResponse): response is FetchError {
  return response.success === false;
}

/**
 * Create a success response
 */
export function createSuccessResponse(
  content: string,
  url: string,
  title: string,
  status: number
): FetchResult {
  return {
    success: true,
    content,
    url,
    title,
    status,
  };
}

/**
 * Create an error response
 */
export function createErrorResponse(
  url: string,
  code: FetchErrorCode,
  message: string,
  status?: number,
  partial_content?: string
): FetchError {
  return {
    success: false,
    error: {
      code,
      message,
      ...(status !== undefined && { status }),
    },
    url,
    ...(partial_content && { partial_content }),
  };
}
