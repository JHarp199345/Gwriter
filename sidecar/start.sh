#!/usr/bin/env bash
# GWriter NSM Sidecar — launch script (macOS / Linux)
# Run this in a terminal before opening Obsidian with GWriter.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Activate virtual environment if present
if [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
    echo "✓ Virtual environment activated"
elif [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
    echo "✓ Virtual environment activated"
else
    echo "⚠  No virtual environment found — using system Python"
    echo "   Recommended: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
fi

# Check for .env
if [ ! -f ".env" ]; then
    echo ""
    echo "⚠  No .env file found."
    echo "   Run: python setup.py"
    echo "   Or:  cp .env.example .env  (and edit manually)"
    echo ""
fi

echo ""
echo "Starting GWriter NSM Sidecar..."
echo "Press Ctrl+C to stop."
echo ""

python main.py
