#!/usr/bin/env python3
"""
TurboWebFetch Python Nodriver Fetcher

This script uses Nodriver to fetch web pages with Cloudflare bypass capabilities.
It's called by the Node.js MCP server as an alternative to Camoufox.

Outputs JSON to stdout, logs to stderr.
"""

import argparse
import asyncio
import json
import os
import platform
import sys
import time
from typing import Optional, Dict, Any
from urllib.parse import urlparse

import nodriver as uc
from readability import Document
from markdownify import markdownify as md


def get_chrome_path() -> Optional[str]:
    """Get Chrome executable path for the current platform."""
    system = platform.system()

    if system == "Darwin":  # macOS
        paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
    elif system == "Linux":
        paths = [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
        ]
    elif system == "Windows":
        paths = [
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        ]
    else:
        paths = []

    for path in paths:
        if os.path.exists(path):
            return path

    return None


class FetchError(Exception):
    """Custom exception for fetch errors with error codes."""
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def log_error(message: str, **kwargs):
    """Log to stderr as JSON."""
    log_data = {"level": "error", "message": message, **kwargs}
    print(json.dumps(log_data), file=sys.stderr, flush=True)


def log_info(message: str, **kwargs):
    """Log to stderr as JSON."""
    log_data = {"level": "info", "message": message, **kwargs}
    print(json.dumps(log_data), file=sys.stderr, flush=True)


def output_result(result: Dict[str, Any]):
    """Output JSON result to stdout."""
    print(json.dumps(result, ensure_ascii=False), flush=True)


def extract_text_content(html: str, title: str, inner_text: Optional[str] = None) -> str:
    """Extract readable text content using Readability, with innerText fallback."""
    try:
        doc = Document(html)
        summary = doc.summary()

        # Simple text extraction
        import re
        # Remove HTML tags
        text = re.sub(r'<script[^>]*>.*?</script>', '', summary, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<[^>]+>', '', text)

        # Decode HTML entities
        import html as html_module
        text = html_module.unescape(text)

        # Clean up whitespace
        text = re.sub(r'\n\s*\n\s*\n', '\n\n', text)
        text = text.strip()

        # If Readability returned little content but we have innerText, use that instead
        if len(text) < 200 and inner_text and len(inner_text) > len(text):
            log_info("using_innertext_fallback", readability_len=len(text), innertext_len=len(inner_text))
            text = inner_text.strip()

        return f"{title}\n\n{text}" if title else text
    except Exception as e:
        log_error("text_extraction_failed", error=str(e))
        # Fallback to innerText if available, else simple tag stripping
        if inner_text:
            return f"{title}\n\n{inner_text.strip()}" if title else inner_text.strip()
        import re
        text = re.sub(r'<[^>]+>', '', html)
        return text.strip()


def extract_markdown_content(html: str, title: str, inner_text: Optional[str] = None) -> str:
    """Extract markdown content using Readability + Markdownify, with innerText fallback."""
    try:
        doc = Document(html)
        summary = doc.summary()

        # Convert to markdown
        markdown = md(summary, heading_style="ATX", bullets="-")

        # Clean up excessive newlines
        import re
        markdown = re.sub(r'\n\s*\n\s*\n', '\n\n', markdown)
        markdown = markdown.strip()

        # If Readability returned little content but we have innerText, use that instead
        if len(markdown) < 200 and inner_text and len(inner_text) > len(markdown):
            log_info("using_innertext_fallback_md", readability_len=len(markdown), innertext_len=len(inner_text))
            markdown = inner_text.strip()

        return f"# {title}\n\n{markdown}" if title else markdown
    except Exception as e:
        log_error("markdown_extraction_failed", error=str(e))
        # Fallback to text
        return extract_text_content(html, title, inner_text)


async def detect_cloudflare(page) -> bool:
    """Detect if Cloudflare challenge is present."""
    try:
        # Check for common Cloudflare challenge indicators
        checks = [
            "document.title.includes('Just a moment')",
            "document.title.includes('Cloudflare')",
            "document.querySelector('#cf-wrapper') !== null",
            "document.querySelector('.cf-browser-verification') !== null",
            "document.body.innerText.includes('Checking your browser')",
            "document.body.innerText.includes('DDoS protection by Cloudflare')",
        ]

        for check in checks:
            result = await page.evaluate(check)
            if result:
                return True

        return False
    except Exception as e:
        log_error("cloudflare_detection_failed", error=str(e))
        return False


async def dismiss_overlays(page):
    """Dismiss common overlay elements (cookie banners, popups)."""
    try:
        # Common overlay selectors
        selectors = [
            "button[aria-label*='cookie' i]",
            "button[aria-label*='accept' i]",
            "button:has-text('Accept')",
            "button:has-text('Agree')",
            ".cookie-banner button",
            "#onetrust-accept-btn-handler",
            ".consent-accept",
            "[class*='cookie'] button[class*='accept']",
        ]

        for selector in selectors:
            try:
                # Try to find and click the element
                element = await page.find(selector, timeout=1)
                if element:
                    await element.click()
                    await asyncio.sleep(0.5)
                    log_info("overlay_dismissed", selector=selector)
                    break
            except:
                continue
    except Exception as e:
        log_error("overlay_dismissal_failed", error=str(e))


async def lazy_load_content(page):
    """Scroll page to trigger lazy-loaded content."""
    try:
        await page.evaluate("""
            window.scrollTo(0, document.body.scrollHeight / 2);
        """)
        await asyncio.sleep(0.5)
        await page.evaluate("""
            window.scrollTo(0, document.body.scrollHeight);
        """)
        await asyncio.sleep(0.5)
        await page.evaluate("""
            window.scrollTo(0, 0);
        """)
    except Exception as e:
        log_error("lazy_load_failed", error=str(e))


async def fetch_page(
    url: str,
    format: str = "text",
    timeout: int = 30000,
    wait_for: Optional[str] = None,
    headless: bool = True,
) -> Dict[str, Any]:
    """
    Fetch a web page using Nodriver.

    Returns:
        Dict with success, content, url, title, status
    """
    browser = None
    start_time = time.time()

    try:
        # Validate URL
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            raise FetchError("INVALID_URL", f"Invalid URL format: {url}")

        log_info("fetch_start", url=url, format=format, headless=headless)

        # Get Chrome path
        chrome_path = get_chrome_path()
        if chrome_path:
            log_info("chrome_found", path=chrome_path)
        else:
            log_info("chrome_not_found", message="Using nodriver auto-detection")

        # Launch browser
        # sandbox=False required on macOS, otherwise Chrome fails to start
        browser = await uc.start(
            headless=headless,
            browser_executable_path=chrome_path,
            sandbox=False,
        )
        page = await browser.get(url)

        # Detect Cloudflare
        is_cloudflare = await detect_cloudflare(page)
        if is_cloudflare:
            log_info("cloudflare_detected", url=url)
            # Use Nodriver's built-in Cloudflare bypass
            try:
                await page  # Nodriver handles CF challenges automatically
                # Wait a bit longer after CF bypass
                await asyncio.sleep(2)
            except Exception as e:
                log_error("cloudflare_bypass_failed", error=str(e))

        # Wait for specific selector if requested
        if wait_for:
            try:
                await page.find(wait_for, timeout=timeout / 1000)
                log_info("selector_found", selector=wait_for)
            except Exception as e:
                log_error("selector_wait_timeout", selector=wait_for, error=str(e))
        else:
            # Default wait for page to be somewhat loaded
            await asyncio.sleep(1)

        # Dismiss overlays
        await dismiss_overlays(page)

        # Lazy load content
        await lazy_load_content(page)

        # Get final URL
        final_url = page.url

        # Get page title
        try:
            title = await page.evaluate("document.title")
        except:
            title = ""

        # Get page HTML
        try:
            html = await page.get_content()
        except Exception as e:
            log_error("content_extraction_failed", error=str(e))
            html = await page.evaluate("document.documentElement.outerHTML")

        # Get innerText as fallback for JS-heavy pages where Readability fails
        inner_text = None
        try:
            inner_text = await page.evaluate("document.body.innerText")
        except Exception as e:
            log_error("innertext_extraction_failed", error=str(e))

        # Extract content based on format
        if format == "html":
            content = html
        elif format == "markdown":
            content = extract_markdown_content(html, title, inner_text)
        else:  # text
            content = extract_text_content(html, title, inner_text)

        duration_ms = int((time.time() - start_time) * 1000)
        log_info("fetch_success", url=url, final_url=final_url, duration_ms=duration_ms)

        return {
            "success": True,
            "content": content,
            "url": final_url,
            "title": title,
            "status": 200,  # Nodriver doesn't expose HTTP status easily
        }

    except FetchError as e:
        duration_ms = int((time.time() - start_time) * 1000)
        log_error("fetch_failed", url=url, code=e.code, message=e.message, duration_ms=duration_ms)
        return {
            "success": False,
            "error": {"code": e.code, "message": e.message},
            "url": url,
        }

    except asyncio.TimeoutError:
        duration_ms = int((time.time() - start_time) * 1000)
        log_error("fetch_timeout", url=url, duration_ms=duration_ms)
        return {
            "success": False,
            "error": {"code": "TIMEOUT", "message": f"Fetch timeout after {timeout}ms"},
            "url": url,
        }

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        log_error("fetch_error", url=url, error=str(e), duration_ms=duration_ms)
        return {
            "success": False,
            "error": {"code": "UNKNOWN_ERROR", "message": str(e)},
            "url": url,
        }

    finally:
        # Clean up browser
        if browser:
            try:
                browser.stop()  # Note: stop() is not async
            except Exception as e:
                log_error("browser_cleanup_failed", error=str(e))


async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Fetch web pages using Nodriver")
    parser.add_argument("--url", required=True, help="URL to fetch")
    parser.add_argument("--format", choices=["html", "text", "markdown"], default="text", help="Output format")
    parser.add_argument("--timeout", type=int, default=30000, help="Timeout in milliseconds")
    parser.add_argument("--wait-for", help="CSS selector to wait for")
    parser.add_argument("--headless", type=str, default="true", help="Run headless (true/false)")

    args = parser.parse_args()

    # Convert headless string to bool
    headless = args.headless.lower() in ("true", "1", "yes")

    try:
        # Run fetch with timeout
        result = await asyncio.wait_for(
            fetch_page(
                url=args.url,
                format=args.format,
                timeout=args.timeout,
                wait_for=args.wait_for,
                headless=headless,
            ),
            timeout=args.timeout / 1000 + 5  # Add 5s buffer
        )
        output_result(result)
    except asyncio.TimeoutError:
        output_result({
            "success": False,
            "error": {"code": "TIMEOUT", "message": f"Overall timeout after {args.timeout}ms"},
            "url": args.url,
        })
    except Exception as e:
        output_result({
            "success": False,
            "error": {"code": "FATAL_ERROR", "message": str(e)},
            "url": args.url,
        })


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log_info("interrupted")
        sys.exit(1)
    except Exception as e:
        log_error("fatal_error", error=str(e))
        output_result({
            "success": False,
            "error": {"code": "FATAL_ERROR", "message": str(e)},
            "url": "",
        })
        sys.exit(1)
