#!/usr/bin/env python3
"""
TurboWebFetch Python Nodriver Fetcher

This script uses Nodriver to fetch web pages with Cloudflare and DataDome bypass capabilities.
It's called by the Node.js MCP server as an alternative to Camoufox.

Anti-bot handling:
- Cloudflare: Detected and bypassed using cf_verify() in headed mode
- DataDome: Detected and bypassed by retrying in headed mode with human-like behavior

Outputs JSON to stdout, logs to stderr.
"""

import argparse
import asyncio
import json
import os
import platform
import random
import socket
import subprocess
import sys
import time
from typing import Optional, Dict, Any, Tuple
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


# Default timeouts for individual operations (in seconds)
# These prevent indefinite hangs on nodriver operations
NAVIGATE_TIMEOUT = 30  # browser.get() navigation
EVALUATE_TIMEOUT = 10  # page.evaluate() JavaScript execution
CONTENT_TIMEOUT = 30   # page.get_content() DOM serialization


async def safe_evaluate(page, script: str, timeout: float = EVALUATE_TIMEOUT, default=None):
    """
    Execute page.evaluate() with a timeout to prevent indefinite hangs.

    Args:
        page: Nodriver page object
        script: JavaScript to execute
        timeout: Maximum seconds to wait (default: EVALUATE_TIMEOUT)
        default: Value to return on timeout/error

    Returns:
        Result of evaluation, or default on timeout/error
    """
    try:
        result = await asyncio.wait_for(page.evaluate(script), timeout=timeout)
        # nodriver can return ExceptionDetails objects on JS errors instead of raising
        # Check if result is an error object (has 'exceptionId' or similar attributes)
        if result is not None and hasattr(result, 'exceptionId'):
            log_error("js_exception_details", script=script[:50])
            return default
        return result
    except asyncio.TimeoutError:
        return default
    except Exception:
        return default


async def safe_navigate(browser, url: str, timeout: float = NAVIGATE_TIMEOUT):
    """
    Execute browser.get() with a timeout to prevent indefinite hangs.

    Args:
        browser: Nodriver browser object
        url: URL to navigate to
        timeout: Maximum seconds to wait (default: NAVIGATE_TIMEOUT)

    Returns:
        Page object

    Raises:
        FetchError: If navigation times out
    """
    try:
        return await asyncio.wait_for(browser.get(url), timeout=timeout)
    except asyncio.TimeoutError:
        raise FetchError("TIMEOUT", f"Navigation to {url} timed out after {timeout}s")


async def safe_get_content(page, timeout: float = CONTENT_TIMEOUT) -> str:
    """
    Execute page.get_content() with a timeout to prevent indefinite hangs.

    Args:
        page: Nodriver page object
        timeout: Maximum seconds to wait (default: CONTENT_TIMEOUT)

    Returns:
        Page HTML content, or empty string on timeout
    """
    try:
        return await asyncio.wait_for(page.get_content(), timeout=timeout)
    except asyncio.TimeoutError:
        # Fallback to evaluate if get_content times out
        try:
            return await asyncio.wait_for(
                page.evaluate("document.documentElement.outerHTML"),
                timeout=5
            ) or ""
        except Exception:
            return ""
    except Exception:
        return ""


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
            # Reduced from 1.5-3.5s to 0.8-1.5s for better performance
            return reading_delay(content_length=content_length, min_seconds=0.8, max_seconds=1.5)
        return 0.5  # Simple fallback

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


def find_available_port(start: int = 9222, end: int = 9322) -> int:
    """Find an available port for Chrome remote debugging."""
    # Try random ports in range to avoid conflicts with parallel agents
    ports = list(range(start, end))
    random.shuffle(ports)

    for port in ports:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('127.0.0.1', port))
                return port
        except OSError:
            continue

    raise FetchError("PORT_EXHAUSTED", f"No available ports in range {start}-{end}")


async def launch_chrome_background_macos(
    chrome_path: str,
    url: str,
    port: int,
    user_data_dir: Optional[str] = None,
) -> int:
    """
    Launch Chrome in background mode on macOS using 'open -gj'.

    This launches Chrome hidden (no window visible) and without stealing focus.

    Args:
        chrome_path: Path to Chrome executable (used to find the .app bundle)
        url: Initial URL to open
        port: Remote debugging port
        user_data_dir: Optional user data directory

    Returns:
        Chrome process PID (int) - NOT the 'open' command PID
    """
    # Build Chrome arguments
    chrome_args = [
        f'--remote-debugging-port={port}',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--safebrowsing-disable-auto-update',
        '--password-store=basic',
    ]

    if user_data_dir:
        chrome_args.append(f'--user-data-dir={user_data_dir}')
    else:
        # Create a temp directory for this session
        import tempfile
        temp_dir = tempfile.mkdtemp(prefix='turbowebfetch_chrome_')
        chrome_args.append(f'--user-data-dir={temp_dir}')

    # Add the URL last
    chrome_args.append(url)

    # On macOS, derive the .app bundle path from the executable path
    # /Applications/Google Chrome.app/Contents/MacOS/Google Chrome -> /Applications/Google Chrome.app
    app_path = chrome_path
    if '/Contents/MacOS/' in chrome_path:
        app_path = chrome_path.split('/Contents/MacOS/')[0]

    # Use 'open' command with -gj flags:
    # -g: Do not bring the application to the foreground
    # -j: Launches the app hidden
    # -n: Open a new instance even if one is running
    # -a: Specify application to open
    # --args: Pass remaining arguments to the application
    cmd = [
        'open',
        '-g',  # Background (don't bring to foreground)
        '-j',  # Hidden (launch hidden)
        '-n',  # New instance
        '-a', app_path,
        '--args',
    ] + chrome_args

    log_info("chrome_background_launch", cmd=' '.join(cmd[:7]) + ' --args [...]', port=port)

    # Launch Chrome via 'open' command
    # Note: 'open' exits immediately after launching Chrome, so we can't use it for cleanup
    subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Wait for Chrome to start and open the debugging port
    max_wait = 10  # seconds
    waited = 0
    chrome_pid = None

    while waited < max_wait:
        await asyncio.sleep(0.5)
        waited += 0.5

        # Check if port is accepting connections
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                s.connect(('127.0.0.1', port))

                # Port is open - now find the actual Chrome PID
                # Look for Chrome process with our specific debugging port
                try:
                    ps_output = subprocess.check_output(
                        ['ps', '-eo', 'pid,args'],
                        text=True
                    )
                    for line in ps_output.strip().split('\n'):
                        if f'--remote-debugging-port={port}' in line and 'Google Chrome' in line:
                            # Extract PID (first column)
                            pid_str = line.strip().split()[0]
                            chrome_pid = int(pid_str)
                            log_info("chrome_background_ready", port=port, pid=chrome_pid, waited_seconds=waited)
                            return chrome_pid
                except Exception as e:
                    log_error("chrome_pid_lookup_failed", error=str(e))

                # Fallback: port is open but couldn't find PID
                # This shouldn't happen, but if it does, we can't clean up properly
                log_error("chrome_pid_not_found", port=port)
                raise FetchError("BROWSER_LAUNCH_FAILED", f"Chrome started but couldn't find its PID")

        except (ConnectionRefusedError, socket.timeout, OSError):
            continue

    # If we get here, Chrome didn't start properly
    raise FetchError("BROWSER_LAUNCH_FAILED", f"Chrome didn't open debugging port {port} within {max_wait}s")


class FetchError(Exception):
    """Custom exception for fetch errors with error codes."""
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


async def start_headed_browser(
    chrome_path: Optional[str],
    url: str,
) -> Tuple[Any, Any, Optional[int], Optional[int]]:
    """
    Start a headed browser, using background mode on macOS.

    On macOS: Uses 'open -gj' to launch Chrome hidden without stealing focus,
    then connects nodriver to it via remote debugging port.

    On other platforms: Falls back to direct launch with off-screen positioning.

    Args:
        chrome_path: Path to Chrome executable
        url: URL to navigate to

    Returns:
        Tuple of (browser, page, chrome_pid, debug_port)
        chrome_pid and debug_port are only set on macOS background mode
    """
    system = platform.system()

    if system == "Darwin" and chrome_path:
        # macOS: Use background app mode
        port = find_available_port()
        log_info("headed_background_mode", platform="macOS", port=port)

        # Launch Chrome in background - returns the Chrome PID
        chrome_pid = await launch_chrome_background_macos(
            chrome_path=chrome_path,
            url=url,
            port=port,
        )

        # Connect nodriver to the existing Chrome
        # If connection fails, we MUST clean up the Chrome process we just spawned
        try:
            # When host and port are provided, nodriver doesn't launch its own browser
            # Add timeout to prevent hanging if Chrome doesn't respond
            browser = await asyncio.wait_for(
                uc.start(
                    host='127.0.0.1',
                    port=port,
                    sandbox=False,
                ),
                timeout=NAVIGATE_TIMEOUT
            )

            # Get the page (should already be at the URL)
            # nodriver's browser.get() with an existing browser just switches to/opens a tab
            page = await safe_navigate(browser, url)

            return browser, page, chrome_pid, port
        except asyncio.TimeoutError:
            log_error("nodriver_connect_timeout", port=port)
            # Clean up Chrome process on timeout
            try:
                import signal
                os.kill(chrome_pid, signal.SIGTERM)
            except Exception:
                try:
                    os.kill(chrome_pid, signal.SIGKILL)
                except Exception:
                    pass
            raise FetchError("TIMEOUT", f"Browser connection timed out after {NAVIGATE_TIMEOUT}s")
        except Exception as e:
            # Nodriver failed to connect - clean up the Chrome process we spawned
            log_error("nodriver_connect_failed", port=port, error=str(e))
            try:
                import signal
                os.kill(chrome_pid, signal.SIGTERM)
            except Exception:
                try:
                    os.kill(chrome_pid, signal.SIGKILL)
                except Exception:
                    pass
            raise  # Re-raise the original exception
    else:
        # Other platforms: Use off-screen positioning fallback
        log_info("headed_offscreen_mode", platform=system, window_position="-2400,-2400")

        browser = await asyncio.wait_for(
            uc.start(
                headless=False,
                browser_executable_path=chrome_path,
                sandbox=False,
                browser_args=['--window-position=-2400,-2400'],
            ),
            timeout=NAVIGATE_TIMEOUT
        )
        page = await safe_navigate(browser, url)

        return browser, page, None, None


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
        # Configure Readability to filter out cookie/consent noise
        doc = Document(
            html,
            negative_keywords="cookie,consent,privacy,gdpr,banner,modal,popup,overlay,newsletter,subscribe,tracking",
            min_text_length=15,  # Lower from default 25 to catch shorter headlines
        )
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

        # Check if extracted content looks like cookie/consent banner text
        text_lower = text.lower()
        suspicious_phrases = [
            "cookie", "consent", "privacy policy", "accept all", "gdpr",
            "manage preferences", "personal information", "we use cookies",
            "this site uses", "by continuing", "advertising partners"
        ]
        is_suspicious = any(phrase in text_lower for phrase in suspicious_phrases)

        # Fallback to innerText if content is short OR looks like cookie banner
        # Validate inner_text is a string (nodriver can return ExceptionDetails on JS errors)
        if inner_text and isinstance(inner_text, str) and (len(text) < 500 or is_suspicious) and len(inner_text) > len(text):
            log_info("using_innertext_fallback", readability_len=len(text), innertext_len=len(inner_text), suspicious=is_suspicious)
            text = inner_text.strip()

        # If text is empty but we have innerText, use it
        if not text and inner_text and isinstance(inner_text, str) and len(inner_text) > 50:
            log_info("readability_empty_using_innertext", innertext_len=len(inner_text))
            text = inner_text.strip()

        return f"{title}\n\n{text}" if title else text
    except Exception as e:
        log_error("text_extraction_failed", error=str(e))
        # Fallback to innerText if available and is a string, else simple tag stripping
        if inner_text and isinstance(inner_text, str):
            return f"{title}\n\n{inner_text.strip()}" if title else inner_text.strip()
        import re
        text = re.sub(r'<[^>]+>', '', html)
        return text.strip()


def extract_markdown_content(html: str, title: str, inner_text: Optional[str] = None) -> str:
    """Extract markdown content using Readability + Markdownify, with innerText fallback."""
    try:
        # Configure Readability to filter out cookie/consent noise
        doc = Document(
            html,
            negative_keywords="cookie,consent,privacy,gdpr,banner,modal,popup,overlay,newsletter,subscribe,tracking",
            min_text_length=15,  # Lower from default 25 to catch shorter headlines
        )
        summary = doc.summary()

        # Convert to markdown
        markdown = md(summary, heading_style="ATX", bullets="-")

        # Clean up excessive newlines
        import re
        markdown = re.sub(r'\n\s*\n\s*\n', '\n\n', markdown)
        markdown = markdown.strip()

        # Check if extracted content looks like cookie/consent banner text
        md_lower = markdown.lower()
        suspicious_phrases = [
            "cookie", "consent", "privacy policy", "accept all", "gdpr",
            "manage preferences", "personal information", "we use cookies",
            "this site uses", "by continuing", "advertising partners"
        ]
        is_suspicious = any(phrase in md_lower for phrase in suspicious_phrases)

        # Fallback to innerText if content is short OR looks like cookie banner
        # Validate inner_text is a string (nodriver can return ExceptionDetails on JS errors)
        if inner_text and isinstance(inner_text, str) and (len(markdown) < 500 or is_suspicious) and len(inner_text) > len(markdown):
            log_info("using_innertext_fallback_md", readability_len=len(markdown), innertext_len=len(inner_text), suspicious=is_suspicious)
            markdown = inner_text.strip()

        return f"# {title}\n\n{markdown}" if title else markdown
    except Exception as e:
        log_error("markdown_extraction_failed", error=str(e))
        # Fallback to text
        return extract_text_content(html, title, inner_text)


async def detect_datadome(page) -> bool:
    """Detect if DataDome anti-bot challenge is present."""
    try:
        # Get page title first (with timeout to prevent hangs)
        title = await safe_evaluate(page, "document.title", timeout=5, default="") or ""
        title_lower = title.lower()

        # Check title for DataDome block indicators
        block_titles = [
            "blocked",
            "request blocked",
            "pardon our interruption",
        ]

        for indicator in block_titles:
            if indicator in title_lower:
                log_info("datadome_detected_by_title", title=title, indicator=indicator)
                return True

        # Check for DataDome-specific elements (with timeout)
        element_checks = [
            "document.querySelector('iframe[src*=\"datadome\"]') !== null",
            "document.querySelector('iframe[src*=\"captcha-delivery\"]') !== null",
            "document.querySelector('[class*=\"datadome\"]') !== null",
            "document.querySelector('#dd_captcha') !== null",
            "document.querySelector('[id*=\"datadome\"]') !== null",
        ]

        for check in element_checks:
            result = await safe_evaluate(page, check, timeout=3, default=False)
            if result:
                log_info("datadome_detected_by_element", check=check)
                return True

        # Check body text for DataDome block indicators (with timeout)
        body_text = await safe_evaluate(page, "document.body.innerText.substring(0, 2000)", timeout=5, default="") or ""
        body_lower = body_text.lower()

        text_indicators = [
            "request blocked",
            "ray id",
            "support.indeed.com",
            "pardon our interruption",
            "we have detected unusual traffic",
            "blocked by datadome",
            "your request has been blocked",
            "automated access",
            "captcha-delivery.com",
        ]

        for indicator in text_indicators:
            if indicator in body_lower:
                log_info("datadome_detected_by_text", indicator=indicator)
                return True

        return False
    except Exception as e:
        log_error("datadome_detection_failed", error=str(e))
        return False


async def detect_cloudflare(page) -> bool:
    """Detect if Cloudflare or similar challenge is present."""
    try:
        # Get page title first (with timeout to prevent hangs)
        title = await safe_evaluate(page, "document.title", timeout=5, default="") or ""
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

        # Check for common challenge page elements (with timeout)
        element_checks = [
            "document.querySelector('#cf-wrapper') !== null",
            "document.querySelector('.cf-browser-verification') !== null",
            "document.querySelector('#challenge-running') !== null",
            "document.querySelector('#challenge-form') !== null",
            "document.querySelector('[class*=\"challenge\"]') !== null",
            "document.querySelector('iframe[src*=\"challenges.cloudflare.com\"]') !== null",
        ]

        for check in element_checks:
            result = await safe_evaluate(page, check, timeout=3, default=False)
            if result:
                log_info("cloudflare_detected_by_element", check=check)
                return True

        # Check body text for challenge indicators (with timeout)
        body_text = await safe_evaluate(page, "document.body.innerText.substring(0, 1000)", timeout=5, default="") or ""
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

        return False
    except Exception as e:
        log_error("cloudflare_detection_failed", error=str(e))
        return False


async def dismiss_overlays(page, human: Optional[HumanBehavior] = None, max_dismiss: int = 3):
    """
    Dismiss common overlay elements (cookie banners, popups) using fast JavaScript detection.

    Uses a single JavaScript call to find visible overlay buttons, then clicks them.
    Much faster than sequential page.find() calls (which wait full timeout per selector).

    Args:
        page: Nodriver page object
        human: Optional HumanBehavior instance for natural interactions
        max_dismiss: Maximum number of overlays to dismiss (default 3)
    """
    try:
        # Use JavaScript to find all matching buttons in a single call (FAST)
        # This avoids the 0.5s polling × timeout for each selector
        js_find_overlays = """
        (() => {
            const selectors = [
                // High-priority: specific consent platforms (most common)
                '#onetrust-accept-btn-handler',
                '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
                '#CybotCookiebotDialogBodyButtonAccept',
                '#didomi-notice-agree-button',
                '.qc-cmp2-summary-buttons button[mode="primary"]',
                '.truste-consent-button',
                '.trustarc-agree-btn',
                '.cky-btn-accept',
                '.cmplz-accept',
                '.cc-btn.cc-dismiss',
                '.cc-allow',
                '.iubenda-cs-accept-btn',
                // Generic patterns
                '.consent-accept',
                '[data-testid*="accept"]',
                '[data-testid*="cookie"] button',
                'button[data-cookieconsent="accept"]',
                // Aria-label patterns (case insensitive via JS)
                'button[aria-label*="cookie" i]',
                'button[aria-label*="accept" i]',
            ];

            // Find first visible, clickable button matching any selector
            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.offsetParent !== null && !el.disabled) {
                        // Return selector that matched
                        return sel;
                    }
                } catch (e) {
                    // Invalid selector, skip
                }
            }
            return null;
        })()
        """

        dismissed_count = 0
        max_attempts = max_dismiss + 2  # Extra attempts in case some clicks fail

        for attempt in range(max_attempts):
            if dismissed_count >= max_dismiss:
                break

            # Fast JS check for any visible overlay button
            matching_selector = await safe_evaluate(page, js_find_overlays, timeout=3, default=None)

            if not matching_selector:
                # No more overlays found
                break

            try:
                # Find the element using nodriver (needed for click)
                element = await page.find(matching_selector, timeout=1)
                if element:
                    # Add brief human hesitation before clicking
                    if human:
                        delay = human.get_thinking_delay(complexity="simple")
                        await asyncio.sleep(min(delay, 0.5))  # Cap at 0.5s

                    await element.click()
                    await asyncio.sleep(0.3)  # Brief wait for overlay to close
                    dismissed_count += 1
                    log_info("overlay_dismissed", selector=matching_selector, count=dismissed_count)
            except Exception as click_err:
                log_info("overlay_click_failed", selector=matching_selector, error=str(click_err))
                # Continue trying other overlays
                await asyncio.sleep(0.2)

        if dismissed_count > 0:
            log_info("overlay_dismissal_complete", total_dismissed=dismissed_count)
    except Exception as e:
        log_error("overlay_dismissal_failed", error=str(e))


async def lazy_load_content(page, human: Optional[HumanBehavior] = None, max_scroll_time: float = 8.0):
    """
    Scroll page to trigger lazy-loaded content using human-like behavior.

    Args:
        page: Nodriver page object
        human: Optional HumanBehavior instance for natural scrolling
        max_scroll_time: Maximum seconds to spend scrolling (default 8s)
    """
    import time
    start_time = time.time()

    try:
        # Get page dimensions with timeout to prevent hangs
        page_height = await safe_evaluate(page, """
            Math.max(
                document.body.scrollHeight,
                document.documentElement.scrollHeight
            )
        """, timeout=5, default=3000) or 3000
        viewport_height = await safe_evaluate(page, "window.innerHeight", timeout=5, default=800) or 800

        page_height = int(page_height)
        viewport_height = int(viewport_height)

        # Cap page height to prevent excessive scrolling on infinite-scroll pages
        MAX_PAGE_HEIGHT = 15000  # ~15 screens max
        MAX_SCROLL_ACTIONS = 12  # Maximum scroll iterations
        capped_height = min(page_height, MAX_PAGE_HEIGHT)

        log_info("lazy_load_start", page_height=page_height, capped_height=capped_height, viewport_height=viewport_height)

        # Generate scroll sequence using HumanBehavior or fallback
        if human:
            scroll_sequence = human.generate_scroll_sequence(capped_height, viewport_height, for_lazy_load=True)
        else:
            # Simple fallback sequence
            max_scroll = max(0, capped_height - viewport_height)
            scroll_sequence = [
                {'scroll_to': max_scroll // 2, 'delay_after': 0.3, 'smooth': True},
                {'scroll_to': max_scroll, 'delay_after': 0.3, 'smooth': True},
            ]

        # Cap scroll sequence length
        scroll_sequence = scroll_sequence[:MAX_SCROLL_ACTIONS]

        # Execute scroll sequence with time limit
        scroll_count = 0
        for action in scroll_sequence:
            # Check time limit
            elapsed = time.time() - start_time
            if elapsed >= max_scroll_time:
                log_info("lazy_load_time_limit", elapsed=round(elapsed, 2), scrolls_completed=scroll_count)
                break

            scroll_to = action['scroll_to']
            delay = min(action['delay_after'], 0.5)  # Cap individual delays at 0.5s
            smooth = action.get('smooth', True)

            if smooth:
                await safe_evaluate(page, f"""
                    window.scrollTo({{
                        top: {scroll_to},
                        behavior: 'smooth'
                    }});
                """, timeout=2, default=None)
            else:
                await safe_evaluate(page, f"window.scrollTo(0, {scroll_to});", timeout=2, default=None)

            await asyncio.sleep(delay)
            scroll_count += 1

        # Scroll back to top
        await safe_evaluate(page, """
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        """, timeout=2, default=None)
        await asyncio.sleep(0.2)

        total_time = time.time() - start_time
        log_info("lazy_load_complete", scroll_actions=scroll_count, total_time=round(total_time, 2))

    except Exception as e:
        log_error("lazy_load_failed", error=str(e))
        # Final fallback if everything fails - very fast version
        try:
            await safe_evaluate(page, "window.scrollTo(0, document.body.scrollHeight / 2);", timeout=2, default=None)
            await asyncio.sleep(0.3)
            await safe_evaluate(page, "window.scrollTo(0, document.body.scrollHeight);", timeout=2, default=None)
            await asyncio.sleep(0.3)
            await safe_evaluate(page, "window.scrollTo(0, 0);", timeout=2, default=None)
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
    chrome_pid = None  # For macOS background mode cleanup (actual Chrome PID)
    debug_port = None  # For macOS background mode
    user_data_dir = None  # Temp directory for browser profile (cleaned up in finally)
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
        # Use unique user_data_dir to avoid conflicts with parallel browser instances
        # (each Chrome instance needs its own profile directory)
        import tempfile
        user_data_dir = tempfile.mkdtemp(prefix='turbowebfetch_')  # Cleaned up in finally
        log_info("browser_user_data_dir", user_data_dir=user_data_dir, headless=headless)

        # Build browser args
        browser_args = []
        if not headless:
            browser_args.append('--window-position=-2400,-2400')
            log_info("headed_offscreen_mode", window_position="-2400,-2400")

        browser = await asyncio.wait_for(
            uc.start(
                headless=headless,
                browser_executable_path=chrome_path,
                sandbox=False,
                browser_args=browser_args,
                user_data_dir=user_data_dir,
            ),
            timeout=NAVIGATE_TIMEOUT
        )
        page = await safe_navigate(browser, url)

        # Initialize human behavior wrapper (after browser starts, we can get viewport)
        human: Optional[HumanBehavior] = None
        if human_mode:
            try:
                # Nodriver returns lists from evaluate, so get width/height separately
                viewport_width = await safe_evaluate(page, "window.innerWidth", timeout=5, default=1920) or 1920
                viewport_height = await safe_evaluate(page, "window.innerHeight", timeout=5, default=1080) or 1080
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
            except Exception:
                pass
            browser = None

            # Relaunch in headed mode (background on macOS, off-screen on others)
            browser, page, chrome_pid, debug_port = await start_headed_browser(
                chrome_path=chrome_path,
                url=url,
            )

            # Wait for page to load
            await asyncio.sleep(2)

            # Check if still Cloudflare (it should be)
            if await detect_cloudflare(page):
                log_info("cloudflare_cf_verify_attempt", url=url)
                try:
                    # Use nodriver's built-in Cloudflare bypass (clicks the checkbox)
                    # Add timeout to prevent hanging on cf_verify
                    await asyncio.wait_for(page.verify_cf(), timeout=30)
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
                except asyncio.TimeoutError:
                    log_error("cloudflare_cf_verify_timeout", url=url)
                    raise FetchError("TIMEOUT", "Cloudflare verification timed out after 30s")
                except FetchError:
                    raise  # Re-raise our own errors
                except Exception as cf_err:
                    log_error("cloudflare_cf_verify_error", error=str(cf_err))
                    raise FetchError("BLOCKED", f"Cloudflare bypass failed: {cf_err}")

            # Re-initialize human behavior for new browser
            if human_mode:
                try:
                    viewport_width = await safe_evaluate(page, "window.innerWidth", timeout=5, default=1920) or 1920
                    viewport_height = await safe_evaluate(page, "window.innerHeight", timeout=5, default=1080) or 1080
                    human = HumanBehavior(
                        enabled=True,
                        viewport_width=int(viewport_width),
                        viewport_height=int(viewport_height)
                    )
                except Exception:
                    human = HumanBehavior(enabled=False)

        # Detect DataDome anti-bot challenge (only if not already retried for Cloudflare)
        # DataDome is used by sites like Indeed and blocks headless browsers
        if not cf_retry_needed:
            is_datadome = await detect_datadome(page)
            datadome_retry_needed = False

            if is_datadome:
                log_info("datadome_detected", url=url)

                if headless:
                    datadome_retry_needed = True
                    log_info("datadome_retry_needed", reason="DataDome blocks headless, will retry in headed mode")
                else:
                    # Already in headed mode, DataDome might still block but we can't do more
                    log_info("datadome_already_headed", reason="Already in headed mode, cannot retry")

            # Retry with headed mode for DataDome (no cf_verify needed, just human behavior)
            if datadome_retry_needed:
                log_info("datadome_headed_retry_start", url=url)

                # Close headless browser
                try:
                    browser.stop()
                except Exception:
                    pass
                browser = None

                # Relaunch in headed mode (background on macOS, off-screen on others)
                browser, page, chrome_pid, debug_port = await start_headed_browser(
                    chrome_path=chrome_path,
                    url=url,
                )

                # Wait for page to load with human-like delay
                await asyncio.sleep(3)

                # Re-initialize human behavior for new browser
                if human_mode:
                    try:
                        viewport_width = await safe_evaluate(page, "window.innerWidth", timeout=5, default=1920) or 1920
                        viewport_height = await safe_evaluate(page, "window.innerHeight", timeout=5, default=1080) or 1080
                        human = HumanBehavior(
                            enabled=True,
                            viewport_width=int(viewport_width),
                            viewport_height=int(viewport_height)
                        )
                    except Exception:
                        human = HumanBehavior(enabled=False)

                # Check if DataDome is still blocking
                still_datadome = await detect_datadome(page)
                if still_datadome:
                    log_error("datadome_headed_retry_failed", message="Still blocked after headed retry")
                    raise FetchError("BLOCKED", "DataDome challenge not bypassed in headed mode")
                else:
                    log_info("datadome_bypassed", url=url)

        # Wait for specific selector if requested, otherwise auto-stabilize
        if wait_for:
            try:
                await page.find(wait_for, timeout=timeout / 1000)
                log_info("selector_found", selector=wait_for)
            except Exception as e:
                log_error("selector_wait_timeout", selector=wait_for, error=str(e))
        else:
            # Fixed wait for JS-heavy pages to load content
            # Auto-stabilization was unreliable due to intermittent evaluate() failures
            # A simple fixed wait is more reliable for modern JS frameworks
            fixed_wait = 5.0  # 5 seconds handles most JS rendering
            log_info("fixed_wait_start", seconds=fixed_wait)
            await asyncio.sleep(fixed_wait)

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

        # Get page title (with timeout)
        title = await safe_evaluate(page, "document.title", timeout=5, default="") or ""

        # Get page HTML (with timeout to prevent hangs on never-ending pages)
        html = await safe_get_content(page, timeout=CONTENT_TIMEOUT)
        if not html:
            log_error("content_extraction_failed", error="get_content returned empty")
            html = await safe_evaluate(page, "document.documentElement.outerHTML", timeout=10, default="") or ""

        # Get innerText as fallback for JS-heavy pages where Readability fails
        inner_text_raw = await safe_evaluate(page, "document.body.innerText", timeout=10, default=None)
        # Validate innerText is actually a string (nodriver can return error objects)
        inner_text = inner_text_raw if isinstance(inner_text_raw, str) else None

        # Log extraction inputs for debugging
        log_info("content_extraction_inputs",
                html_len=len(html) if html else 0,
                title=title[:50] if title else "None",
                innertext_len=len(inner_text) if inner_text else 0,
                innertext_type=type(inner_text_raw).__name__)

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

        # browser.stop() only kills the main Chrome process, not helper processes
        # Kill ALL remaining Chrome processes with our user-data-dir (renderer, GPU, etc.)
        if user_data_dir:
            try:
                subprocess.run(
                    ['pkill', '-KILL', '-f', user_data_dir],
                    timeout=3,
                    check=False,  # Don't raise if no processes found
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                log_info("chrome_helpers_cleanup", user_data_dir=user_data_dir)
            except subprocess.TimeoutExpired:
                log_error("chrome_helpers_cleanup_timeout", user_data_dir=user_data_dir)
            except Exception as e:
                log_error("chrome_helpers_cleanup_failed", user_data_dir=user_data_dir, error=str(e))

        # Clean up Chrome process if launched in background mode (macOS)
        # Must kill all Chrome processes with our user-data-dir (main + helpers)
        if chrome_pid and debug_port:
            import signal
            log_info("chrome_cleanup_starting", pid=chrome_pid, port=debug_port)

            # Use pkill with SIGKILL to immediately kill ALL Chrome processes with our port
            # This is more reliable than SIGTERM which Chrome may ignore
            # Note: macOS pkill uses "-KILL" not "-9"
            try:
                subprocess.run(
                    ['pkill', '-KILL', '-f', f'remote-debugging-port={debug_port}'],
                    timeout=3
                )
                log_info("chrome_background_cleanup", pid=chrome_pid, port=debug_port)
            except subprocess.TimeoutExpired:
                log_error("chrome_pkill_timeout", port=debug_port)
            except Exception as e:
                # Fallback: try direct kill on main process
                try:
                    os.kill(chrome_pid, signal.SIGKILL)
                except Exception:
                    pass
                log_error("chrome_background_cleanup_failed", pid=chrome_pid, error=str(e))

        # Clean up temp user data directory
        if user_data_dir:
            try:
                import shutil
                shutil.rmtree(user_data_dir, ignore_errors=True)
                log_info("user_data_dir_cleanup", path=user_data_dir)
            except Exception as e:
                log_error("user_data_dir_cleanup_failed", path=user_data_dir, error=str(e))


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
    import signal

    def _sigterm_handler(signum, frame):
        """Handle SIGTERM by outputting JSON before exiting, so Node.js never sees empty stdout."""
        output_result({
            "success": False,
            "error": {"code": "KILLED", "message": "Process terminated by SIGTERM"},
            "url": "",
        })
        sys.exit(1)

    signal.signal(signal.SIGTERM, _sigterm_handler)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log_info("interrupted")
        output_result({
            "success": False,
            "error": {"code": "INTERRUPTED", "message": "Process interrupted"},
            "url": "",
        })
        sys.exit(1)
    except Exception as e:
        log_error("fatal_error", error=str(e))
        output_result({
            "success": False,
            "error": {"code": "FATAL_ERROR", "message": str(e)},
            "url": "",
        })
        sys.exit(1)
