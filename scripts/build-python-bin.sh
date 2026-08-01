#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv-build"

if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "$ROOT_DIR/src/python/requirements-build.txt"

rm -rf "$ROOT_DIR/dist/python-bin" "$ROOT_DIR/build/pyinstaller"

pyinstaller \
    --onedir \
    --name ytarchiver-py \
    --distpath "$ROOT_DIR/dist/python-bin" \
    --workpath "$ROOT_DIR/build/pyinstaller" \
    --specpath "$ROOT_DIR/build/pyinstaller" \
    --collect-all yt_dlp \
    --noconfirm \
    "$ROOT_DIR/src/python/cli.py"
