/**
 * Batch URL fetch tool implementation
 *
 * Fetches multiple URLs in parallel using Promise.all,
 * respecting the pool's concurrent limit (14 max).
 */

import type {
  FetchBatchOptions,
  FetchBatchResult,
  FetchResponse,
  ContentFormat,
} from "../types.js";
import { isSuccessResponse, getDefaultConfig } from "../types.js";
import { fetchPage } from "./fetch.js";
import { logger } from "../utils/logger.js";

// Get configuration
const config = getDefaultConfig();

// Maximum concurrent fetches (matches Python process limit)
const MAX_CONCURRENT = config.python.maxProcesses;

/**
 * Chunks an array into smaller arrays of specified size
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Fetches a batch of URLs in parallel
 *
 * Uses Promise.all to fetch URLs concurrently, limited to
 * MAX_CONCURRENT (14) at a time to match the Python process limit.
 *
 * @param options - Batch fetch options including URLs and format
 * @returns FetchBatchResult with aggregated results
 */
export async function fetchBatch(
  options: FetchBatchOptions
): Promise<FetchBatchResult> {
  const startTime = Date.now();
  const { urls, format, timeout, human_mode } = options;
  const total = urls.length;

  logger.info("batch_fetch_start", {
    event: `Starting batch fetch of ${total} URLs`,
    format,
  });

  if (total === 0) {
    return {
      results: [],
      total: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  // Deduplicate URLs while preserving order
  const seenUrls = new Set<string>();
  const uniqueUrls: string[] = [];
  const urlIndexMap = new Map<string, number[]>();

  urls.forEach((url, index) => {
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      uniqueUrls.push(url);
      urlIndexMap.set(url, [index]);
    } else {
      urlIndexMap.get(url)!.push(index);
    }
  });

  if (uniqueUrls.length < total) {
    logger.info("batch_deduplicated", {
      event: `Deduplicated ${total} URLs to ${uniqueUrls.length} unique URLs`,
    });
  }

  // Results array matching original input order
  const results: FetchResponse[] = new Array(total);
  let succeeded = 0;
  let failed = 0;

  // Process in chunks to respect concurrency limit
  const chunks = chunkArray(uniqueUrls, MAX_CONCURRENT);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const chunkStart = Date.now();

    logger.info("batch_chunk_start", {
      event: `Processing chunk ${chunkIndex + 1}/${chunks.length}`,
      queue_length: chunk.length,
    });

    // Fetch all URLs in chunk concurrently
    const chunkResults = await Promise.all(
      chunk.map(async (url): Promise<FetchResponse> => {
        try {
          return await fetchPage({
            url,
            format: format as ContentFormat,
            timeout,
            human_mode,
          });
        } catch (error) {
          // This shouldn't happen as fetchPage handles errors internally,
          // but just in case, wrap any uncaught errors
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("batch_uncaught_error", {
            url,
            event: `Uncaught error: ${errorMessage}`,
          });
          return {
            success: false,
            error: {
              code: "UNKNOWN",
              message: `Unexpected error: ${errorMessage}`,
            },
            url,
          };
        }
      })
    );

    // Map results back to original indices (handles duplicates)
    chunkResults.forEach((result, idx) => {
      const url = chunk[idx];
      const originalIndices = urlIndexMap.get(url)!;

      // Place result at all original indices (for duplicates)
      for (const originalIndex of originalIndices) {
        results[originalIndex] = result;
      }

      // Count successes/failures (only once per unique URL)
      if (isSuccessResponse(result)) {
        succeeded++;
      } else {
        failed++;
      }
    });

    const chunkDuration = Date.now() - chunkStart;
    logger.info("batch_chunk_complete", {
      event: `Chunk ${chunkIndex + 1} completed`,
      duration_ms: chunkDuration,
    });
  }

  const totalDuration = Date.now() - startTime;
  logger.info("batch_fetch_complete", {
    event: `Batch fetch completed: ${succeeded}/${uniqueUrls.length} succeeded`,
    duration_ms: totalDuration,
  });

  return {
    results,
    total,
    succeeded,
    failed,
  };
}

/**
 * Convenience function for batch fetching with inline options
 * (matches the simpler interface from PRD)
 */
export async function fetchMultiple(
  urls: string[],
  options: {
    format?: ContentFormat;
    timeout?: number;
    human_mode?: boolean;
  } = {}
): Promise<FetchBatchResult> {
  return fetchBatch({
    urls,
    format: options.format ?? "text",
    timeout: options.timeout ?? config.timeouts.navigation,
    human_mode: options.human_mode,
  });
}

/**
 * Fetches a batch of URLs with a callback for progress tracking
 */
export async function fetchBatchWithProgress(
  options: FetchBatchOptions,
  onProgress?: (completed: number, total: number) => void
): Promise<FetchBatchResult> {
  const { urls, format, timeout, human_mode } = options;
  const total = urls.length;

  if (total === 0) {
    return {
      results: [],
      total: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  const results: FetchResponse[] = [];
  let succeeded = 0;
  let failed = 0;
  let completed = 0;

  // Process in chunks for concurrency limit
  const chunks = chunkArray(urls, MAX_CONCURRENT);

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map((url) =>
        fetchPage({
          url,
          format: format as ContentFormat,
          timeout,
          human_mode,
        })
      )
    );

    for (const result of chunkResults) {
      results.push(result);
      completed++;

      if (isSuccessResponse(result)) {
        succeeded++;
      } else {
        failed++;
      }

      if (onProgress) {
        onProgress(completed, total);
      }
    }
  }

  return {
    results,
    total,
    succeeded,
    failed,
  };
}
