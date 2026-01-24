/**
 * Main content extractor for the TurboFetch MCP server.
 *
 * Routes raw HTML to the appropriate converter based on the requested format.
 * Handles pre-cleaning of HTML before conversion.
 */

import { toText, toMarkdown, toCleanHtml } from './converters.js';

/**
 * Supported output formats for content extraction.
 */
export type ContentFormat = 'html' | 'text' | 'markdown';

/**
 * Result of content extraction.
 */
export interface ExtractionResult {
  /** Extracted content in the requested format */
  content: string;
  /** Format that was used */
  format: ContentFormat;
  /** Whether extraction was successful */
  success: boolean;
  /** Error message if extraction failed */
  error?: string;
}

/**
 * Options for content extraction.
 */
export interface ExtractOptions {
  /** Maximum content length (truncates if exceeded). Default: no limit */
  maxLength?: number;
  /** Whether to include links in text/markdown output. Default: true */
  includeLinks?: boolean;
}

/**
 * Extract content from raw HTML in the specified format.
 *
 * Routes to the appropriate converter:
 * - 'html': Returns cleaned HTML (scripts, styles, nav removed)
 * - 'text': Uses Readability for article extraction, fallback to tag stripping
 * - 'markdown': Uses Turndown with ATX headings and fenced code blocks
 *
 * @param html - Raw HTML content from the browser
 * @param format - Desired output format
 * @param options - Optional extraction configuration
 * @returns Extraction result with content and status
 *
 * @example
 * ```typescript
 * const result = extractContent('<html>...</html>', 'markdown');
 * if (result.success) {
 *   console.log(result.content);
 * }
 * ```
 */
export function extractContent(
  html: string,
  format: ContentFormat = 'text',
  options: ExtractOptions = {}
): ExtractionResult {
  // Handle empty/invalid input
  if (!html || typeof html !== 'string') {
    return {
      content: '',
      format,
      success: false,
      error: 'No HTML content provided',
    };
  }

  // Handle empty HTML (just whitespace)
  if (!html.trim()) {
    return {
      content: '',
      format,
      success: true,
    };
  }

  try {
    let content: string;

    switch (format) {
      case 'html':
        content = toCleanHtml(html);
        break;

      case 'markdown':
        content = toMarkdown(html);
        break;

      case 'text':
      default:
        content = toText(html);
        break;
    }

    // Apply max length if specified
    if (options.maxLength && content.length > options.maxLength) {
      content = truncateContent(content, options.maxLength, format);
    }

    return {
      content,
      format,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown extraction error';
    console.error(`Content extraction failed for format '${format}':`, error);

    return {
      content: '',
      format,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Truncate content to a maximum length, trying to break at sensible points.
 * For text/markdown, tries to break at paragraph boundaries.
 * For HTML, truncates at the specified length (may break tags).
 *
 * @param content - Content to truncate
 * @param maxLength - Maximum allowed length
 * @param format - Content format (affects truncation strategy)
 * @returns Truncated content with ellipsis marker
 */
function truncateContent(content: string, maxLength: number, format: ContentFormat): string {
  if (content.length <= maxLength) {
    return content;
  }

  // For HTML, we can't easily truncate without breaking structure
  if (format === 'html') {
    return content.substring(0, maxLength) + '...';
  }

  // For text and markdown, try to break at paragraph boundaries
  const truncated = content.substring(0, maxLength);

  // Find the last paragraph break (double newline)
  const lastParagraph = truncated.lastIndexOf('\n\n');
  if (lastParagraph > maxLength * 0.7) {
    // Only use if we keep at least 70% of content
    return truncated.substring(0, lastParagraph) + '\n\n...';
  }

  // Fall back to sentence break
  const lastSentence = truncated.lastIndexOf('. ');
  if (lastSentence > maxLength * 0.8) {
    return truncated.substring(0, lastSentence + 1) + '...';
  }

  // Fall back to word break
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.9) {
    return truncated.substring(0, lastSpace) + '...';
  }

  // Hard truncation
  return truncated + '...';
}

/**
 * Quick check if HTML appears to have meaningful content.
 * Useful for early rejection of empty or stub pages.
 *
 * @param html - HTML to check
 * @returns true if HTML appears to have content
 */
export function hasContent(html: string): boolean {
  if (!html || typeof html !== 'string') {
    return false;
  }

  // Quick regex check for text content (not just tags)
  const textMatch = html.replace(/<[^>]*>/g, '').trim();
  return textMatch.length > 50; // Arbitrary threshold for "meaningful" content
}

/**
 * Extract the page title from HTML.
 *
 * @param html - HTML content
 * @returns Page title or empty string
 */
export function extractTitle(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  try {
    // Try to find <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim();
    }

    // Try og:title meta tag
    const ogTitleMatch = html.match(
      /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i
    );
    if (ogTitleMatch && ogTitleMatch[1]) {
      return ogTitleMatch[1].trim();
    }

    // Try reverse order (content before property)
    const ogTitleMatchAlt = html.match(
      /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i
    );
    if (ogTitleMatchAlt && ogTitleMatchAlt[1]) {
      return ogTitleMatchAlt[1].trim();
    }

    return '';
  } catch {
    return '';
  }
}

/**
 * Extract meta description from HTML.
 *
 * @param html - HTML content
 * @returns Meta description or empty string
 */
export function extractDescription(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  try {
    // Try standard meta description
    const descMatch = html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i
    );
    if (descMatch && descMatch[1]) {
      return descMatch[1].trim();
    }

    // Try reverse order
    const descMatchAlt = html.match(
      /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i
    );
    if (descMatchAlt && descMatchAlt[1]) {
      return descMatchAlt[1].trim();
    }

    // Try og:description
    const ogDescMatch = html.match(
      /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i
    );
    if (ogDescMatch && ogDescMatch[1]) {
      return ogDescMatch[1].trim();
    }

    return '';
  } catch {
    return '';
  }
}

// Re-export converters for direct access if needed
export { toText, toMarkdown, toCleanHtml } from './converters.js';
