# TurboWebFetch Python Nodriver Fetcher

This directory contains the Python fetcher script that uses [Nodriver](https://github.com/ultrafunkamsterdam/nodriver) for undetected browser automation with built-in Cloudflare bypass.

## Why Nodriver?

Nodriver provides:
- **Automatic Cloudflare bypass** - No manual challenge solving required
- **Undetected automation** - Bypasses most bot detection systems
- **Chrome-based** - Uses real Chrome/Chromium for maximum compatibility
- **Async/await** - Modern Python async architecture
- **Active maintenance** - Regular updates for anti-bot countermeasures

## Setup

1. Ensure Python 3.8+ is installed
2. Run the setup script:

```bash
cd /Users/azaali/CascadeProjects/turbowebfetch/python
./setup.sh
```

This will:
- Create a Python virtual environment in `./venv`
- Install all dependencies from `requirements.txt`
- Make `fetcher.py` executable

## Usage

The fetcher script is called by the Node.js MCP server, but you can also test it directly:

```bash
# Text format (default)
./venv/bin/python fetcher.py --url "https://example.com" --format text

# Markdown format
./venv/bin/python fetcher.py --url "https://example.com" --format markdown

# HTML format
./venv/bin/python fetcher.py --url "https://example.com" --format html

# With custom timeout and selector wait
./venv/bin/python fetcher.py \
  --url "https://example.com" \
  --format markdown \
  --timeout 60000 \
  --wait-for ".main-content"

# Non-headless (visible browser)
./venv/bin/python fetcher.py --url "https://example.com" --headless false
```

## Command-Line Arguments

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `--url` | string | **required** | URL to fetch |
| `--format` | string | `text` | Output format: `html`, `text`, or `markdown` |
| `--timeout` | int | `30000` | Navigation timeout in milliseconds |
| `--wait-for` | string | none | CSS selector to wait for before extracting content |
| `--headless` | string | `true` | Run browser in headless mode (`true`/`false`) |

## Output Format

The script outputs JSON to stdout and logs to stderr.

### Success Response

```json
{
  "success": true,
  "content": "extracted content here...",
  "url": "https://final-url-after-redirects.com",
  "title": "Page Title",
  "status": 200
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error message"
  },
  "url": "https://attempted-url.com"
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `INVALID_URL` | URL format is invalid |
| `TIMEOUT` | Navigation or overall timeout exceeded |
| `UNKNOWN_ERROR` | Unexpected error occurred |
| `FATAL_ERROR` | Critical error during execution |

## Features

### Cloudflare Detection & Bypass

The fetcher automatically detects Cloudflare challenges by checking for:
- Page title containing "Just a moment" or "Cloudflare"
- Cloudflare wrapper elements (`#cf-wrapper`)
- Browser verification messages

When detected, Nodriver's built-in bypass mechanism handles the challenge automatically.

### Overlay Dismissal

Automatically attempts to dismiss common overlays:
- Cookie consent banners
- "Accept" buttons
- Privacy policy popups

### Lazy Loading

Scrolls the page to trigger lazy-loaded content:
1. Scroll to middle of page
2. Scroll to bottom
3. Scroll back to top

### Content Extraction

- **HTML**: Raw HTML content
- **Text**: Readable text extracted using Readability algorithm
- **Markdown**: Converted to markdown using markdownify

## Testing

Run the test script to verify the setup:

```bash
./test_fetcher.sh
```

This will test fetching example.com in all three formats.

## Dependencies

See `requirements.txt` for the full list. Key dependencies:

- `nodriver` - Undetected browser automation
- `readability-lxml` - Content extraction
- `markdownify` - HTML to Markdown conversion
- `lxml` - HTML parsing

## Integration with Node.js

The Node.js MCP server spawns this script as a subprocess:

```typescript
const result = await execFile('python', [
  'python/fetcher.py',
  '--url', url,
  '--format', format,
  '--timeout', timeout.toString(),
  ...(waitFor ? ['--wait-for', waitFor] : []),
  '--headless', 'true'
]);
```

The server parses the JSON output from stdout and handles any errors.

## Troubleshooting

### "python3 not found"
Install Python 3.8 or higher from python.org or via Homebrew:
```bash
brew install python@3.11
```

### "nodriver not found" after setup
Activate the virtual environment manually:
```bash
source venv/bin/activate
pip install -r requirements.txt
```

### Cloudflare bypass not working
- Try increasing timeout: `--timeout 60000`
- Disable headless mode to see what's happening: `--headless false`
- Check stderr logs for Cloudflare detection messages

### Page content incomplete
- Use `--wait-for` to wait for specific elements to load
- Increase timeout for slow-loading pages
- Check if the site requires JavaScript (Nodriver should handle this)

## License

Same as parent project (TurboWebFetch).
