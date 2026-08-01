#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv-build"
RAW_DIST="$ROOT_DIR/dist/ytdlp-bin-raw"
FINAL_DIST="$ROOT_DIR/dist/ytdlp-bin"

if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "$ROOT_DIR/src/python/requirements-build.txt"

rm -rf "$RAW_DIST" "$FINAL_DIST" "$ROOT_DIR/build/pyinstaller"

pyinstaller \
    --onedir \
    --name yt-dlp \
    --distpath "$RAW_DIST" \
    --workpath "$ROOT_DIR/build/pyinstaller" \
    --specpath "$ROOT_DIR/build/pyinstaller" \
    --collect-all yt_dlp \
    --noconfirm \
    "$ROOT_DIR/src/python/ytdlp_entrypoint.py"

mkdir -p "$FINAL_DIST"
cp -R "$RAW_DIST/yt-dlp/." "$FINAL_DIST/"
chmod +x "$FINAL_DIST/yt-dlp"
rm -rf "$RAW_DIST"

echo "Built yt-dlp onedir binary -> $FINAL_DIST/yt-dlp"
