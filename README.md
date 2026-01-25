# TurboWebFetch

> **Turn websites into LLM-ready data, locally.**
>
> Reliably fetches content where standard tools fail. Handles dynamic JS, Cloudflare challenges, and rendering automatically.
> **14 parallel browsers. Zero API keys.**

---

### Why TurboWebFetch?

Most fetch tools fail on modern sites because they are just HTTP—no JavaScript, no rendering. TurboWebFetch gives every agent its own **headless browser cluster**, running in parallel to return clean content as fast as your agents can think.

* **Auto-Managed:** Automatically handles Cloudflare & DataDome challenges.
* **Invisible:** Uses `nodriver` (undetected Chrome) technology to bypass bot detection.
* **Parallel:** Fetch up to 14 pages simultaneously (configurable).
* **Local:** Runs 100% on your machine. No API keys, no per-page costs.

---

### Quick Start

**Add to Claude Code (Recommended)**

One command to install and register:

```bash
claude mcp add turbo-web-fetch npx -y turbowebfetch
```

**Prerequisites:** Node.js 18+, Python 3.8+, Google Chrome.

---

### Comparison

| Capability | TurboWebFetch | WebFetch (Standard) | Chrome MCP |
|------------|---------------|---------------------|------------|
| JS Rendering | Yes | No | Yes |
| Parallelism | Up to 14 | 1 Request | 1 Tab |
| Anti-Bot Bypass | Auto-Managed | No | Manual |
| User Interference | None (Headless) | None | Occupied |

---

### Anti-Bot Features

TurboWebFetch doesn't just "try" to fetch; it adapts.

* **Cloudflare:** Auto-detects challenges ("Just a moment..."), retries in headed mode, and clicks verification automatically.
* **DataDome:** Detects block pages (Indeed, etc.) and retries with human-like scrolling and behavior.
* **macOS Background Mode:** When a "headed" browser is required for verification, it launches hidden in the background. It never steals your focus or clutters your dock.

---

### Use Cases

* **Multi-agent research:** 10 agents gathering info from 10 sources, all at once.
* **Job search:** Parse postings from Indeed, Glassdoor, Greenhouse, Lever, and LinkedIn in parallel.
* **Documentation:** Read JS-heavy docs (React, Next.js, Stripe) that standard fetchers can't render.
* **Protected sites:** Access content behind Cloudflare/DataDome that blocks other tools.

---

### Usage

**Single Page (MCP Tool Call)**

```
mcp__turbo_web_fetch__fetch(url: "https://example.com", format: "markdown")
```

**Batch / Parallel (MCP Tool Call)**

```
mcp__turbo_web_fetch__fetch_batch(urls: [
  "https://www.linkedin.com/jobs/view/...",
  "https://www.glassdoor.com/job/...",
  "https://www.indeed.com/viewjob?..."
])
```

---

### Configuration

Optional environment variables to tune performance:

| Variable | Default | Description |
|----------|---------|-------------|
| `TURBOFETCH_MAX_PROCESSES` | 14 | Max concurrent browsers. Set higher for powerful machines. |
| `TURBOFETCH_HEADLESS` | true | Start invisible. Auto-switches to visible if blocked. |
| `TURBOFETCH_HUMAN_MODE` | true | Enable human-like scrolling/delays for protected sites. |

---

### License

MIT © [Mourtaza Ali](https://mourtaza.com)
