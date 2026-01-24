#!/usr/bin/env bash
# Simple test script for the Python fetcher

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PYTHON="$SCRIPT_DIR/venv/bin/python"
FETCHER="$SCRIPT_DIR/fetcher.py"

# Check if venv exists
if [ ! -f "$VENV_PYTHON" ]; then
    echo "❌ Virtual environment not found. Run setup.sh first."
    exit 1
fi

echo "Testing Python Nodriver Fetcher"
echo "================================"
echo ""

# Test 1: Simple fetch (text format)
echo "Test 1: Fetching example.com (text format)..."
$VENV_PYTHON "$FETCHER" --url "https://example.com" --format text --headless true
echo ""

# Test 2: Markdown format
echo "Test 2: Fetching example.com (markdown format)..."
$VENV_PYTHON "$FETCHER" --url "https://example.com" --format markdown --headless true
echo ""

# Test 3: HTML format
echo "Test 3: Fetching example.com (html format)..."
$VENV_PYTHON "$FETCHER" --url "https://example.com" --format html --headless true | python3 -c "import sys, json; data = json.load(sys.stdin); print('Success:', data.get('success')); print('Title:', data.get('title')); print('Content length:', len(data.get('content', '')))"
echo ""

echo "✅ Tests complete!"
