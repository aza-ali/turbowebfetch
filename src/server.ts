/**
 * MCP Server for TurboWebFetch
 *
 * This module sets up the MCP server, registers tools, and routes
 * tool calls to the appropriate handlers.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  FetchOptionsSchema,
  FetchBatchOptionsSchema,
  type FetchOptions,
  type FetchBatchOptions,
  type FetchResponse,
  type FetchBatchResult,
  type ToolHandlers,
  createErrorResponse,
} from "./types.js";

// =============================================================================
// Tool Definitions
// =============================================================================

/**
 * Tool definition for single URL fetch
 */
const FETCH_TOOL: Tool = {
  name: "fetch",
  description:
    "Fetch and render a web page, returning its content. Supports JavaScript rendering for dynamic pages.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must be a valid HTTP/HTTPS URL)",
      },
      format: {
        type: "string",
        enum: ["html", "text", "markdown"],
        default: "text",
        description:
          "Output format: 'html' for raw HTML, 'text' for cleaned text content, 'markdown' for structured markdown",
      },
      wait_for: {
        type: "string",
        description:
          "Optional CSS selector to wait for before extracting content (useful for dynamic pages)",
      },
      timeout: {
        type: "number",
        default: 30000,
        description: "Timeout in milliseconds (default: 30000, max: 120000)",
      },
      human_mode: {
        type: "boolean",
        description:
          "Enable human-mode scrolling and delays for more natural browsing behavior (default: true)",
      },
    },
    required: ["url"],
  },
};

/**
 * Tool definition for batch URL fetch
 */
const FETCH_BATCH_TOOL: Tool = {
  name: "fetch_batch",
  description:
    "Fetch multiple URLs in parallel. Returns an array of results in the same order as input URLs.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 14,
        description: "Array of URLs to fetch (1-14 URLs)",
      },
      format: {
        type: "string",
        enum: ["html", "text", "markdown"],
        default: "text",
        description: "Output format for all fetched pages",
      },
      timeout: {
        type: "number",
        default: 30000,
        description: "Timeout in milliseconds per URL (default: 30000)",
      },
      human_mode: {
        type: "boolean",
        description:
          "Enable human-mode scrolling and delays for more natural browsing behavior (default: true)",
      },
    },
    required: ["urls"],
  },
};

/**
 * All registered tools
 */
const TOOLS: Tool[] = [FETCH_TOOL, FETCH_BATCH_TOOL];

// =============================================================================
// Server Creation
// =============================================================================

/**
 * Creates and configures the MCP server instance
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: "turbo-web-fetch",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  return server;
}

// =============================================================================
// Handler Registration
// =============================================================================

/**
 * Placeholder handlers used before real handlers are registered
 */
let handlers: ToolHandlers = {
  fetch: async (options: FetchOptions): Promise<FetchResponse> => {
    return createErrorResponse(
      options.url,
      "UNKNOWN",
      "Fetch handler not registered. Server not fully initialized."
    );
  },
  fetchBatch: async (options: FetchBatchOptions): Promise<FetchBatchResult> => {
    return {
      results: options.urls.map((url) =>
        createErrorResponse(
          url,
          "UNKNOWN",
          "Fetch batch handler not registered. Server not fully initialized."
        )
      ),
      total: options.urls.length,
      succeeded: 0,
      failed: options.urls.length,
    };
  },
};

/**
 * Registers the tool handlers that will process fetch requests
 * Must be called before the server starts accepting requests
 */
export function registerToolHandlers(newHandlers: ToolHandlers): void {
  handlers = newHandlers;
}

/**
 * Sets up request handlers on the server for listing and calling tools
 */
export function setupRequestHandlers(server: Server): void {
  // Handler for listing available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handler for tool invocations
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "fetch":
          return await handleFetch(args);

        case "fetch_batch":
          return await handleFetchBatch(args);

        default:
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: {
                    code: "UNKNOWN",
                    message: `Unknown tool: ${name}`,
                  },
                }),
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: {
                code: "UNKNOWN",
                message: `Tool execution failed: ${errorMessage}`,
              },
            }),
          },
        ],
        isError: true,
      };
    }
  });
}

// =============================================================================
// Tool Handlers
// =============================================================================

/**
 * Handles the 'fetch' tool invocation
 */
async function handleFetch(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  // Validate input
  const parseResult = FetchOptionsSchema.safeParse(args);

  if (!parseResult.success) {
    const errorMessages = parseResult.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            createErrorResponse(
              (args as Record<string, unknown>)?.url?.toString() || "unknown",
              "INVALID_URL",
              `Validation failed: ${errorMessages}`
            )
          ),
        },
      ],
      isError: true,
    };
  }

  const options = parseResult.data;

  // Execute fetch
  const result = await handlers.fetch(options);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
    isError: !result.success,
  };
}

/**
 * Handles the 'fetch_batch' tool invocation
 */
async function handleFetchBatch(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  // Validate input
  const parseResult = FetchBatchOptionsSchema.safeParse(args);

  if (!parseResult.success) {
    const errorMessages = parseResult.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [],
            total: 0,
            succeeded: 0,
            failed: 0,
            error: `Validation failed: ${errorMessages}`,
          }),
        },
      ],
      isError: true,
    };
  }

  const options = parseResult.data;

  // Execute batch fetch
  const result = await handlers.fetchBatch(options);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
    isError: result.failed > 0 && result.succeeded === 0,
  };
}

// =============================================================================
// Exports
// =============================================================================

export { TOOLS, FETCH_TOOL, FETCH_BATCH_TOOL };
