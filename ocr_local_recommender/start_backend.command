#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
VENV_DIR="$ROOT_DIR/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"
REQUIREMENTS_FILE="$BACKEND_DIR/requirements.txt"
HOST="${OCR_RECOMMENDER_HOST:-127.0.0.1}"
PORT="${OCR_RECOMMENDER_PORT:-8765}"

echo "OCR Local Recommender"
echo "Project: $ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 was not found. Install Python 3 first."
  read -r -p "Press Enter to close..."
  exit 1
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "Creating local virtual environment..."
  python3 -m venv "$VENV_DIR"
fi

if ! "$PYTHON_BIN" -c "import sys" >/dev/null 2>&1; then
  echo "Repairing local virtual environment..."
  python3 -m venv --clear "$VENV_DIR"
fi

if ! "$PYTHON_BIN" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "Installing backend dependencies..."
  "$PYTHON_BIN" -m pip install --upgrade pip setuptools wheel || true
  if ! "$PYTHON_BIN" -m pip install -r "$REQUIREMENTS_FILE"; then
    echo "Retrying dependency install with trusted PyPI hosts..."
    "$PYTHON_BIN" -m pip install \
      --trusted-host pypi.org \
      --trusted-host files.pythonhosted.org \
      -r "$REQUIREMENTS_FILE"
  fi
fi

echo
echo "Backend starting at http://$HOST:$PORT"
echo "Entries: http://$HOST:$PORT/entries"
echo "Press Ctrl+C in this window to stop."
echo

cd "$BACKEND_DIR"
exec "$PYTHON_BIN" -m uvicorn app.main:app --host "$HOST" --port "$PORT"
