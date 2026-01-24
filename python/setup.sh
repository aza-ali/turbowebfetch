#!/usr/bin/env bash
set -e

# TurboWebFetch Python Setup Script
# Creates virtual environment and installs nodriver dependencies

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"

echo "🐍 Setting up Python environment for TurboWebFetch..."

# Check Python version (require 3.8+)
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: python3 not found. Please install Python 3.8 or higher."
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "✓ Found Python $PYTHON_VERSION"

# Create virtual environment
if [ -d "$VENV_DIR" ]; then
    echo "✓ Virtual environment already exists"
else
    echo "📦 Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
    echo "✓ Virtual environment created"
fi

# Activate and install dependencies
echo "📥 Installing dependencies..."
source "$VENV_DIR/bin/activate"
pip install --upgrade pip -q
pip install -r "$SCRIPT_DIR/requirements.txt" -q

# Make fetcher.py executable
if [ -f "$SCRIPT_DIR/fetcher.py" ]; then
    chmod +x "$SCRIPT_DIR/fetcher.py"
    echo "✓ Made fetcher.py executable"
fi

echo "✅ Python setup complete!"
echo ""
echo "Virtual environment: $VENV_DIR"
echo "Python executable: $VENV_DIR/bin/python"
echo ""
