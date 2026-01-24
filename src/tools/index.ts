/**
 * Tool exports for the TurboFetch MCP Server
 *
 * This module exports the main fetch functions that implement
 * the MCP tool handlers.
 */

// Single URL fetch
export { fetchPage, fetch } from "./fetch.js";

// Batch URL fetch
export { fetchBatch, fetchMultiple, fetchBatchWithProgress } from "./fetch-batch.js";
