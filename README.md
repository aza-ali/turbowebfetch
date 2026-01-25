# TurboWebFetch

**Real browsers. Real content. Full fidelity.**

Your AI agents need to read web pages. Documentation, product info, articles, research. But standard fetch tools use plain HTTP - they cannot handle modern client-side rendering or bot mitigation layers, and return empty shells.

TurboWebFetch runs actual Chrome browsers. Your agents see what users see.

**14 parallel browsers. Zero API keys. Runs locally.**

---

## Prerequisites

Before installing, verify you have:

```bash
node --version    # Need 18+
python3 --version # Need 3.8+
```

Google Chrome must be installed (not Chromium).

---

## Quick Start

```bash
claude mcp add turbo-web-fetch npx -y turbowebfetch
```

That's it. Your agents now have access to `turbo_web_fetch`.

---

## What This Is (And Isn't)

TurboWebFetch helps your AI agents access content **you have the right to access**. It renders JavaScript-heavy pages that standard tools cannot handle.

**It is for:**
- Fetching documentation that requires JS rendering (React, Stripe, etc.)
- Product research on e-commerce sites
- Reading articles and news behind JS walls
- Multi-source research for your AI agents

**It is not for:**
- Circumventing paywalls
- Scraping data you don't have permission to collect
- High-volume data harvesting (rate-limited by design)
- Violating websites' Terms of Service

The challenge-handling exists because many legitimate sites use broad bot mitigation that affects even authorized access. If a site restricts access and you don't have permission, respect that.

---

## WebFetch vs TurboWebFetch

| Scenario | WebFetch | TurboWebFetch |
|----------|----------|---------------|
| Static HTML pages | Works | Works (overkill) |
| JavaScript SPAs | Empty content | Full render |
| Sites with JS challenges | Fails | Negotiates automatically |
| Bot mitigation layers | Fails | Negotiates automatically |
| Parallel agents | One at a time | 14 simultaneous browsers |
| JS-heavy sites (docs, e-commerce) | Blocked or empty | Works |

**Rule of thumb:** Use WebFetch for simple pages. Use TurboWebFetch when that fails.

---

## Usage

**Single page:**
```
mcp__turbo_web_fetch__fetch(url: "https://react.dev/learn", format: "markdown")
```

**Response:**
```json
{
  "success": true,
  "url": "https://react.dev/learn",
  "title": "Quick Start - React",
  "content": "# Quick Start\n\nWelcome to the React documentation...",
  "status": 200
}
```

**Batch (parallel):**
```
mcp__turbo_web_fetch__fetch_batch(
  urls: [
    "https://react.dev/learn",
    "https://nextjs.org/docs",
    "https://www.target.com/p/some-product"
  ],
  format: "text"
)
```

All three fetch simultaneously in separate browsers.

---

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | The URL to fetch |
| `format` | `"text"` | `"text"`, `"markdown"`, or `"html"` |
| `timeout` | `60000` | Milliseconds. Increase to 90000+ for slow sites |
| `wait_for` | - | CSS selector to wait for (rarely needed) |

The tool auto-detects when content has loaded. Use `wait_for` only if auto-detection fails on a specific site.

---

## Known Limitations

**Sites that don't work:**
- **Login-required content** - This tool doesn't handle authentication
- **Interactive CAPTCHAs** - It handles JS challenges, not image selection tasks
- **Zillow** - Requires interactive verification
- **Bloomberg** - Requires interactive verification

**Performance:**
- Adds 5-8 seconds per page (browser startup + rendering + human-like behavior)
- Memory usage: ~200-400MB per browser instance
- For 14 parallel fetches, expect ~4GB RAM usage

**Not for scale:** This is a user assistant, not a scraping service. Rate-limited to 60 requests/minute per domain.

---

## Configuration

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TURBOFETCH_MAX_PROCESSES` | `14` | Max concurrent browsers |
| `TURBOFETCH_HUMAN_MODE` | `true` | Human-like scrolling/delays |
| `TURBOFETCH_HEADLESS` | `true` | Headless mode (auto-switches if blocked) |

Most users won't need to change these.

---

## Troubleshooting

**"Python not found"**
```bash
# macOS
brew install python3

# Ubuntu/Debian
sudo apt install python3 python3-venv
```

**"Chrome not launching"**

Install Google Chrome from https://google.com/chrome (not Chromium).

**"Content is empty"**

Some heavily lazy-loaded sites need an explicit selector:
```
mcp__turbo_web_fetch__fetch(
  url: "https://www.bestbuy.com/site/searchpage.jsp?st=laptop",
  wait_for: "[class*=\"product\"]",
  timeout: 90000
)
```

**"Page not loading on [site]"**

Some sites require interactive verification that automated browsers cannot complete. Open an issue with the URL.

---

## How It Works

1. Your agent calls the MCP tool
2. TurboWebFetch spawns a Python process with Chrome (via nodriver)
3. Chrome loads the page, executes JavaScript, negotiates any browser challenges
4. Content is extracted and returned as clean text/markdown/HTML
5. Browser closes, process exits

Each fetch is isolated. No cookies or state persist between requests.

---

## License

MIT - do whatever you want with it.

Copyright (c) 2026 [Mourtaza Ali](https://mourtaza.com)
