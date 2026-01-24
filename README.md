# TurboWebFetch

AI agents aren't bots, and they shouldn't pretend to be human. They should work at AI speed - not waiting on screenshots, not slowly navigating your Chrome tab by tab. Running 5 agents? Each one gets its own browser. Running 14? Same thing. TurboWebFetch gives every agent its own headless browser, all running in parallel, returning content as fast as your agents can think.

Regular WebFetch fails on modern sites because it's just HTTP - no JavaScript, no rendering. Sites block scripts and scrapers, not browsers. TurboWebFetch runs real browsers, so your agents see what users actually see.

## Quick Comparison

| Tool | JS Rendering | Parallel | Your Screen | Best For |
|------|--------------|----------|-------------|----------|
| WebFetch | No | No | Free | Simple static HTML |
| Chrome MCP | Yes | No | Taken over | Interactive tasks |
| TurboWebFetch | Yes | 14 browsers | Free | Content retrieval at scale |

## Works Where Vanilla Automation Fails

Most automation tools ship with detectable fingerprints. TurboWebFetch uses Nodriver (undetected Chrome) with realistic human-like behavior - so you get content from sites that block obvious automation.

**Auto-bypasses anti-bot protection:**
- **Cloudflare** - Auto-detects challenges, retries in headed mode, clicks verification
- **DataDome** - Auto-detects blocks (Indeed, etc.), retries with human behavior

**On macOS:** Headed retries run in background - Chrome launches hidden without stealing focus or appearing on screen. Your workflow stays uninterrupted.

| Capability | TurboWebFetch | fetcher-mcp | concurrent-browser-mcp |
|------------|---------------|-------------|------------------------|
| Parallel browsers | ✅ | ✅ | ✅ |
| JS rendering | ✅ | ✅ | ✅ |
| Cloudflare bypass | ✅ | ❌ | ❌ |
| DataDome bypass | ✅ | ❌ | ❌ |
| Realistic browser config | ✅ | ❌ | ❌ |
| Cookie banner handling | ✅ | ❌ | ❌ |
| Human-like scrolling | ✅ | ❌ | ❌ |
| Background headed mode | ✅ | ❌ | ❌ |

## Installation

**Requirements:** Node.js 18+, Python 3.8+, Google Chrome installed

```bash
# Clone and build
git clone https://github.com/aza-ali/turbowebfetch.git
cd turbowebfetch
npm install
npm run setup:python    # Install Python/Nodriver dependencies
npm run build

# Register with Claude Code
claude mcp add turbo-web-fetch node /path/to/turbowebfetch/dist/index.js
```

Restart Claude Code after registering.

## Usage

### Single URL

```
mcp__turbo_web_fetch__fetch(url: "https://example.com", format: "markdown")
```

**Parameters:**
- `url` (required) - URL to fetch
- `format` - "html", "text", or "markdown" (default: "markdown")
- `timeout` - milliseconds (default: 30000, max: 120000)
- `waitFor` - CSS selector to wait for before extracting

### Batch (Parallel)

```
mcp__turbo_web_fetch__fetch_batch(urls: ["url1", "url2", ...], format: "text")
```

Fetches up to 14 URLs simultaneously.

## Use Cases

- **Multi-agent research** - 10 agents gathering info from 10 sources, all at once
- **Job search** - Parse postings from Indeed, Glassdoor, Greenhouse, Lever, LinkedIn in parallel
- **Documentation** - Read JS-heavy docs (React, Next.js, Stripe) that WebFetch can't render
- **Protected sites** - Access content behind Cloudflare/DataDome that blocks other tools

## Configuration

Environment variables (optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `TURBOFETCH_MAX_PROCESSES` | 14 | Maximum concurrent browser processes |
| `TURBOFETCH_HEADLESS` | true | Run browsers headless (auto-switches to headed for anti-bot) |
| `TURBOFETCH_HUMAN_MODE` | true | Enable human-like scrolling/delays |
| `TURBOFETCH_NAV_TIMEOUT` | 30000 | Navigation timeout (ms) |
| `TURBOFETCH_DEFAULT_RPM` | 60 | Rate limit per domain (requests/minute) |

## License

MIT - see [LICENSE](LICENSE)

## Author

**Mourtaza Ali**
[mourtaza.com](https://mourtaza.com) | [GitHub](https://github.com/aza-ali)
