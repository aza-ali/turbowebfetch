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

# Human behavior modules (optional - graceful degradation if not available)
HUMAN_MODULES_AVAILABLE = False
try:
    from human_mouse import generate_path, get_random_start, create_mouse_movement
    from human_timing import reading_delay, thinking_delay, scroll_pause
    from human_scroll import generate_scroll_sequence, generate_lazy_load_sequence
    HUMAN_MODULES_AVAILABLE = True
except ImportError as e:
    # Log at module load time - will be reported when used
    pass


class HumanBehavior:
    """
    Wrapper class for human-like browser behavior.

    Provides methods for:
    - Natural mouse movements (bezier curves with jitter)
    - Gaussian-distributed timing delays
    - Human-like scrolling patterns

    Falls back to simple behavior if human modules are not available.
    """

    def __init__(self, enabled: bool = True, viewport_width: int = 1920, viewport_height: int = 1080):
        """
        Initialize human behavior wrapper.

        Args:
            enabled: Whether to use human-like behavior (if modules available)
            viewport_width: Browser viewport width for mouse calculations
            viewport_height: Browser viewport height for mouse calculations
        """
        self.enabled = enabled and HUMAN_MODULES_AVAILABLE
        self.viewport_width = viewport_width
        self.viewport_height = viewport_height
        self._last_mouse_pos = None

        if enabled and not HUMAN_MODULES_AVAILABLE:
            log_info("human_mode_fallback", reason="human behavior modules not available")

    def get_reading_delay(self, content_length: Optional[int] = None) -> float:
        """Get delay for reading/scanning page content."""
        if self.enabled:
            return reading_delay(content_length=content_length, min_seconds=1.5, max_seconds=3.5)
        return 1.0  # Simple fallback

    def get_thinking_delay(self, complexity: str = "simple") -> float:
        """Get delay before taking an action (cognitive processing time)."""
        if self.enabled:
            return thinking_delay(complexity=complexity)
        return 0.3  # Simple fallback

    def get_scroll_pause(self, position: str = "middle") -> float:
        """Get pause duration during scrolling."""
        if self.enabled:
            return scroll_pause(position=position)
        return 0.5  # Simple fallback

    def generate_mouse_path(self, end_x: float, end_y: float) -> list:
        """
        Generate a human-like mouse movement path to target coordinates.

        Args:
            end_x: Target X coordinate
            end_y: Target Y coordinate

        Returns:
            List of (x, y) points along the path
        """
        if not self.enabled:
            return [(end_x, end_y)]

        # Get or generate starting position
        if self._last_mouse_pos is None:
            start = get_random_start(self.viewport_width, self.viewport_height)
        else:
            start = self._last_mouse_pos

        # Generate movement
        movement = create_mouse_movement(start[0], start[1], end_x, end_y)
        path = movement['path']

        # Update last known position
        self._last_mouse_pos = (end_x, end_y)

        return path

    def get_mouse_step_delay(self, path_length: int, duration_ms: float = 800) -> float:
        """
        Get delay between mouse movement steps.

        Args:
            path_length: Number of points in the path
            duration_ms: Total movement duration in milliseconds

        Returns:
            Delay in seconds between each step
        """
        if not self.enabled or path_length < 2:
            return 0.01

        from human_mouse import calculate_step_delay
        return calculate_step_delay(duration_ms, path_length)

    def generate_scroll_sequence(self, page_height: int, viewport_height: int, for_lazy_load: bool = False) -> list:
        """
        Generate a human-like scroll sequence.

        Args:
            page_height: Total page height in pixels
            viewport_height: Visible viewport height in pixels
            for_lazy_load: If True, optimized for triggering lazy content

        Returns:
            List of scroll actions with positions and delays
        """
        if not self.enabled:
            # Simple fallback: three scroll positions
            max_scroll = max(0, page_height - viewport_height)
            return [
                {'scroll_to': max_scroll // 2, 'delay_after': 0.5, 'smooth': True},
                {'scroll_to': max_scroll, 'delay_after': 0.5, 'smooth': True},
            ]

        if for_lazy_load:
            return generate_lazy_load_sequence(page_height, viewport_height)
        return generate_scroll_sequence(page_height, viewport_height)


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
    """Detect if Cloudflare or similar challenge is present."""
    try:
        # Get page title first
        title = await page.evaluate("document.title") or ""
        title_lower = title.lower()

        # Check title for challenge indicators
        challenge_titles = [
            "just a moment",
            "cloudflare",
            "checking your browser",
            "please wait",
            "verify you are human",
            "attention required",
            "access denied",
            "one moment",
            "hold on",
            "security check",
        ]

        for indicator in challenge_titles:
            if indicator in title_lower:
                log_info("cloudflare_detected_by_title", title=title, indicator=indicator)
                return True

        # Check for common challenge page elements
        element_checks = [
            "document.querySelector('#cf-wrapper') !== null",
            "document.querySelector('.cf-browser-verification') !== null",
            "document.querySelector('#challenge-running') !== null",
            "document.querySelector('#challenge-form') !== null",
            "document.querySelector('[class*=\"challenge\"]') !== null",
            "document.querySelector('iframe[src*=\"challenges.cloudflare.com\"]') !== null",
        ]

        for check in element_checks:
            try:
                result = await page.evaluate(check)
                if result:
                    log_info("cloudflare_detected_by_element", check=check)
                    return True
            except:
                continue

        # Check body text for challenge indicators
        try:
            body_text = await page.evaluate("document.body.innerText.substring(0, 1000)") or ""
            body_lower = body_text.lower()

            text_indicators = [
                "checking your browser",
                "ddos protection",
                "verify you are human",
                "please verify",
                "help us protect",
                "security check",
            ]

            for indicator in text_indicators:
                if indicator in body_lower:
                    log_info("cloudflare_detected_by_text", indicator=indicator)
                    return True
        except:
            pass

        return False
    except Exception as e:
        log_error("cloudflare_detection_failed", error=str(e))
        return False


async def dismiss_overlays(page, human: Optional[HumanBehavior] = None):
    """
    Dismiss common overlay elements (cookie banners, popups).

    Args:
        page: Nodriver page object
        human: Optional HumanBehavior instance for natural interactions
    """
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
                    # Add thinking delay before clicking (human hesitation)
                    if human:
                        delay = human.get_thinking_delay(complexity="simple")
                        await asyncio.sleep(delay)

                        # Get element bounding box for mouse movement
                        try:
                            box = await element.get_position()
                            if box:
                                # Generate mouse path to element center
                                center_x = box.x + box.width / 2
                                center_y = box.y + box.height / 2
                                path = human.generate_mouse_path(center_x, center_y)

                                # Execute mouse movement (simulate via JS for stealth)
                                if len(path) > 1:
                                    step_delay = human.get_mouse_step_delay(len(path))
                                    for x, y in path[:-1]:  # Skip last point, we'll click there
                                        await page.evaluate(f"""
                                            document.elementFromPoint({x}, {y});
                                        """)
                                        await asyncio.sleep(step_delay)
                        except Exception as mouse_err:
                            log_info("mouse_movement_skipped", error=str(mouse_err))

                    await element.click()
                    await asyncio.sleep(0.5)
                    log_info("overlay_dismissed", selector=selector)
                    break
            except:
                continue
    except Exception as e:
        log_error("overlay_dismissal_failed", error=str(e))


async def lazy_load_content(page, human: Optional[HumanBehavior] = None):
    """
    Scroll page to trigger lazy-loaded content using human-like behavior.

    Args:
        page: Nodriver page object
        human: Optional HumanBehavior instance for natural scrolling
    """
    try:
        # Get page dimensions (Nodriver evaluate returns primitives directly)
        page_height = await page.evaluate("""
            Math.max(
                document.body.scrollHeight,
                document.documentElement.scrollHeight
            )
        """) or 3000
        viewport_height = await page.evaluate("window.innerHeight") or 800

        page_height = int(page_height)
        viewport_height = int(viewport_height)

        log_info("lazy_load_start", page_height=page_height, viewport_height=viewport_height)

        # Generate scroll sequence using HumanBehavior or fallback
        if human:
            scroll_sequence = human.generate_scroll_sequence(page_height, viewport_height, for_lazy_load=True)
        else:
            # Simple fallback sequence
            max_scroll = max(0, page_height - viewport_height)
            scroll_sequence = [
                {'scroll_to': max_scroll // 2, 'delay_after': 0.5, 'smooth': True},
                {'scroll_to': max_scroll, 'delay_after': 0.5, 'smooth': True},
            ]

        # Execute scroll sequence
        for action in scroll_sequence:
            scroll_to = action['scroll_to']
            delay = action['delay_after']
            smooth = action.get('smooth', True)

            if smooth:
                await page.evaluate(f"""
                    window.scrollTo({{
                        top: {scroll_to},
                        behavior: 'smooth'
                    }});
                """)
            else:
                await page.evaluate(f"window.scrollTo(0, {scroll_to});")

            await asyncio.sleep(delay)

        # Scroll back to top
        await page.evaluate("""
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        """)
        await asyncio.sleep(0.3)

        log_info("lazy_load_complete", scroll_actions=len(scroll_sequence))

    except Exception as e:
        log_error("lazy_load_failed", error=str(e))
        # Final fallback if everything fails
        try:
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2);")
            await asyncio.sleep(0.5)
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight);")
            await asyncio.sleep(0.5)
            await page.evaluate("window.scrollTo(0, 0);")
        except Exception as fallback_err:
            log_error("lazy_load_fallback_failed", error=str(fallback_err))


async def fetch_page(
    url: str,
    format: str = "text",
    timeout: int = 30000,
    wait_for: Optional[str] = None,
    headless: bool = True,
    human_mode: bool = True,
) -> Dict[str, Any]:
    """
    Fetch a web page using Nodriver.

    Args:
        url: URL to fetch
        format: Output format - "text", "markdown", or "html"
        timeout: Timeout in milliseconds
        wait_for: Optional CSS selector to wait for
        headless: Run browser in headless mode
        human_mode: Enable human-like behavior (delays, mouse movements, scrolling)

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

        log_info("fetch_start", url=url, format=format, headless=headless, human_mode=human_mode)

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

        # Initialize human behavior wrapper (after browser starts, we can get viewport)
        human: Optional[HumanBehavior] = None
        if human_mode:
            try:
                # Nodriver returns lists from evaluate, so get width/height separately
                viewport_width = await page.evaluate("window.innerWidth") or 1920
                viewport_height = await page.evaluate("window.innerHeight") or 1080
                human = HumanBehavior(
                    enabled=True,
                    viewport_width=int(viewport_width),
                    viewport_height=int(viewport_height)
                )
                log_info("human_mode_enabled", viewport_width=viewport_width, viewport_height=viewport_height, modules_available=HUMAN_MODULES_AVAILABLE)
            except Exception as e:
                log_info("human_mode_init_failed", error=str(e))
                human = HumanBehavior(enabled=False)

        # Detect and wait for Cloudflare JS challenge to auto-pass
        is_cloudflare = await detect_cloudflare(page)
        cf_retry_needed = False

        if is_cloudflare:
            log_info("cloudflare_detected", url=url)

            # Wait for Cloudflare JS challenge to complete (up to 10 seconds)
            max_cf_wait = 10
            cf_check_interval = 2
            cf_waited = 0

            while cf_waited < max_cf_wait:
                await asyncio.sleep(cf_check_interval)
                cf_waited += cf_check_interval

                # Check if still on Cloudflare challenge
                still_cloudflare = await detect_cloudflare(page)
                if not still_cloudflare:
                    log_info("cloudflare_passed", waited_seconds=cf_waited)
                    break

                log_info("cloudflare_waiting", waited_seconds=cf_waited, max_wait=max_cf_wait)

            # If still on Cloudflare after waiting, need headed retry with cf_verify
            still_cf = await detect_cloudflare(page)
            log_info("cloudflare_check_after_wait", cf_waited=cf_waited, max_cf_wait=max_cf_wait, still_cloudflare=still_cf, headless=headless)
            if cf_waited >= max_cf_wait and still_cf:
                if headless:
                    cf_retry_needed = True
                    log_info("cloudflare_retry_needed", reason="JS challenge didn't pass, will retry headed with cf_verify")
                else:
                    log_info("cloudflare_already_headed", reason="Already in headed mode, cannot retry")

        # Retry with headed mode + cf_verify() if needed
        if cf_retry_needed:
            log_info("cloudflare_headed_retry_start", url=url)

            # Close headless browser
            try:
                browser.stop()
            except:
                pass
            browser = None

            # Relaunch in headed mode
            browser = await uc.start(
                headless=False,  # Headed mode for cf_verify
                browser_executable_path=chrome_path,
                sandbox=False,
            )
            page = await browser.get(url)

            # Wait for page to load
            await asyncio.sleep(2)

            # Check if still Cloudflare (it should be)
            if await detect_cloudflare(page):
                log_info("cloudflare_cf_verify_attempt", url=url)
                try:
                    # Use nodriver's built-in Cloudflare bypass (clicks the checkbox)
                    await page.verify_cf()
                    log_info("cloudflare_cf_verify_success", url=url)

                    # Wait for redirect after verification
                    await asyncio.sleep(3)

                    # Verify we passed
                    if await detect_cloudflare(page):
                        log_error("cloudflare_cf_verify_failed", message="Still on challenge after cf_verify")
                        # Return error - don't continue extracting challenge page content
                        raise FetchError("BLOCKED", "Cloudflare challenge not bypassed after cf_verify")
                    else:
                        log_info("cloudflare_bypassed", url=url)
                except FetchError:
                    raise  # Re-raise our own errors
                except Exception as cf_err:
                    log_error("cloudflare_cf_verify_error", error=str(cf_err))
                    raise FetchError("BLOCKED", f"Cloudflare bypass failed: {cf_err}")

            # Re-initialize human behavior for new browser
            if human_mode:
                try:
                    viewport_width = await page.evaluate("window.innerWidth") or 1920
                    viewport_height = await page.evaluate("window.innerHeight") or 1080
                    human = HumanBehavior(
                        enabled=True,
                        viewport_width=int(viewport_width),
                        viewport_height=int(viewport_height)
                    )
                except:
                    human = HumanBehavior(enabled=False)

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

        # Add reading delay after navigation (human takes time to see page)
        if human:
            reading_time = human.get_reading_delay()
            log_info("reading_delay", seconds=round(reading_time, 2))
            await asyncio.sleep(reading_time)

        # Add thinking delay before taking actions
        if human:
            think_time = human.get_thinking_delay(complexity="simple")
            await asyncio.sleep(think_time)

        # Dismiss overlays (with human behavior)
        await dismiss_overlays(page, human=human)

        # Lazy load content (with human behavior)
        await lazy_load_content(page, human=human)

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
    parser.add_argument("--human-mode", type=str, default="true", help="Enable human-like behavior (true/false)")

    args = parser.parse_args()

    # Convert string args to bool
    headless = args.headless.lower() in ("true", "1", "yes")
    human_mode = args.human_mode.lower() in ("true", "1", "yes")

    try:
        # Run fetch with timeout
        result = await asyncio.wait_for(
            fetch_page(
                url=args.url,
                format=args.format,
                timeout=args.timeout,
                wait_for=args.wait_for,
                headless=headless,
                human_mode=human_mode,
            ),
            timeout=args.timeout / 1000 + 10  # Add 10s buffer for human delays
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
