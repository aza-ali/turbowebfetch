/**
 * Content format converters for the TurboFetch MCP server.
 *
 * Handles conversion of raw HTML to text, markdown, and clean HTML formats.
 * Uses JSDOM for DOM manipulation, Readability for article extraction,
 * and Turndown for markdown conversion.
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

/**
 * Elements to remove during HTML cleaning.
 * These elements typically contain non-content (navigation, ads, scripts, etc.)
 */
const ELEMENTS_TO_REMOVE = [
  'script',
  'style',
  'nav',
  'footer',
  'aside',
  'header',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'form',
  'button',
  'input',
  'select',
  'textarea',
] as const;

/**
 * Additional selectors for common non-content elements.
 * These are class/id patterns commonly used for ads, popups, etc.
 */
const SELECTORS_TO_REMOVE = [
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '.advertisement',
  '.ad',
  '.ads',
  '.social-share',
  '.share-buttons',
  '.cookie-banner',
  '.popup',
  '.modal',
  '#cookie-consent',
  '#newsletter-signup',
] as const;

/**
 * Clean HTML by removing non-content elements.
 * Preserves document structure while removing scripts, styles, navigation, etc.
 *
 * @param html - Raw HTML string to clean
 * @returns Cleaned HTML string with structure preserved
 */
export function toCleanHtml(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Remove unwanted elements by tag name
    for (const tag of ELEMENTS_TO_REMOVE) {
      const elements = document.querySelectorAll(tag);
      elements.forEach((el) => el.remove());
    }

    // Remove elements by common non-content selectors
    for (const selector of SELECTORS_TO_REMOVE) {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach((el) => el.remove());
      } catch {
        // Invalid selector, skip
      }
    }

    // Remove HTML comments
    const walker = document.createTreeWalker(
      document.documentElement,
      dom.window.NodeFilter.SHOW_COMMENT,
      null
    );

    const comments: Comment[] = [];
    while (walker.nextNode()) {
      comments.push(walker.currentNode as Comment);
    }
    comments.forEach((comment) => comment.remove());

    // Remove empty elements that might clutter the output
    const emptyElements = document.querySelectorAll('div:empty, span:empty, p:empty');
    emptyElements.forEach((el) => {
      // Only remove if truly empty (no text, no children)
      if (!el.textContent?.trim() && el.children.length === 0) {
        el.remove();
      }
    });

    // Return the body content, or full HTML if no body
    const body = document.body;
    return body ? body.innerHTML.trim() : document.documentElement.innerHTML.trim();
  } catch (error) {
    // If DOM parsing fails, return original (might be malformed HTML)
    console.error('Error cleaning HTML:', error);
    return html;
  }
}

/**
 * Extract plain text from HTML using Mozilla Readability.
 * Falls back to simple tag stripping if Readability fails.
 *
 * @param html - Raw HTML string
 * @returns Plain text content
 */
export function toText(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  try {
    // First, clean the HTML
    const cleanedHtml = toCleanHtml(html);

    // Create a fresh DOM for Readability (it modifies the document)
    const dom = new JSDOM(cleanedHtml, {
      url: 'https://example.com/', // Readability needs a base URL
    });

    const reader = new Readability(dom.window.document, {
      charThreshold: 0, // Don't skip short content
    });

    const article = reader.parse();

    if (article && article.textContent) {
      // Clean up the text: normalize whitespace, remove excess newlines
      return normalizeWhitespace(article.textContent);
    }

    // Fallback: strip tags and extract text directly
    return fallbackTextExtraction(cleanedHtml);
  } catch (error) {
    console.error('Error extracting text:', error);
    // Last resort fallback
    return fallbackTextExtraction(html);
  }
}

/**
 * Convert HTML to Markdown using Turndown.
 * Cleans HTML first, then converts with ATX headings and fenced code blocks.
 *
 * @param html - Raw HTML string
 * @returns Markdown formatted string
 */
export function toMarkdown(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  try {
    // Clean the HTML first
    const cleanedHtml = toCleanHtml(html);

    // Configure Turndown for clean markdown output
    const turndown = new TurndownService({
      headingStyle: 'atx', // Use # style headings
      codeBlockStyle: 'fenced', // Use ``` for code blocks
      bulletListMarker: '-', // Use - for unordered lists
      emDelimiter: '*', // Use * for emphasis
      strongDelimiter: '**', // Use ** for bold
      hr: '---', // Horizontal rule style
    });

    // Add custom rules for better output

    // Remove empty links
    turndown.addRule('removeEmptyLinks', {
      filter: (node) => {
        return (
          node.nodeName === 'A' &&
          !node.textContent?.trim() &&
          !node.querySelector('img')
        );
      },
      replacement: () => '',
    });

    // Handle images with alt text
    turndown.addRule('imageWithAlt', {
      filter: 'img',
      replacement: (_content, node) => {
        const element = node as HTMLImageElement;
        const alt = element.getAttribute('alt') || '';
        const src = element.getAttribute('src') || '';

        if (!src) return '';
        if (!alt) return `![image](${src})`;

        return `![${alt}](${src})`;
      },
    });

    // Clean up tables (basic handling)
    turndown.addRule('tableCell', {
      filter: ['th', 'td'],
      replacement: (content) => {
        return ` ${content.trim()} |`;
      },
    });

    turndown.addRule('tableRow', {
      filter: 'tr',
      replacement: (content) => {
        return `|${content}\n`;
      },
    });

    // Convert and clean up
    let markdown = turndown.turndown(cleanedHtml);

    // Post-process: clean up excessive whitespace
    markdown = markdown
      .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
      .replace(/^\s+|\s+$/g, '') // Trim start/end
      .replace(/[ \t]+$/gm, ''); // Remove trailing spaces on lines

    return markdown;
  } catch (error) {
    console.error('Error converting to markdown:', error);
    // Fallback to text if markdown conversion fails
    return toText(html);
  }
}

/**
 * Fallback text extraction by stripping HTML tags.
 * Used when Readability fails or for simple content.
 *
 * @param html - HTML string (ideally already cleaned)
 * @returns Plain text
 */
function fallbackTextExtraction(html: string): string {
  try {
    const dom = new JSDOM(html);
    const text = dom.window.document.body?.textContent || '';
    return normalizeWhitespace(text);
  } catch {
    // Absolute fallback: regex-based tag stripping
    const stripped = html
      .replace(/<[^>]*>/g, ' ') // Remove tags
      .replace(/&nbsp;/g, ' ') // Replace nbsp
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return normalizeWhitespace(stripped);
  }
}

/**
 * Normalize whitespace in text.
 * Collapses multiple spaces/newlines while preserving paragraph structure.
 *
 * @param text - Raw text with potential whitespace issues
 * @returns Normalized text
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[\t ]+/g, ' ') // Collapse spaces and tabs
    .replace(/\n\s*\n\s*\n/g, '\n\n') // Max 2 consecutive newlines
    .replace(/^\s+|\s+$/g, '') // Trim
    .replace(/\n +/g, '\n') // Remove leading spaces after newlines
    .replace(/ +\n/g, '\n'); // Remove trailing spaces before newlines
}
