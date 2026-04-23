#!/usr/bin/env bash
# Build a Chrome Web Store ready zip for RUBICON Meet Caption Capture.
# Usage: ./build.sh
# Output: ../rubicon-meet-caption-capture-vX.Y.Z.zip  (alongside the project folder)

set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(grep -E '"version"' manifest.json | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')
NAME="rubicon-meet-caption-capture-v${VERSION}.zip"
OUT="../${NAME}"

echo "Building ${NAME}..."

rm -f "$OUT"

zip -r "$OUT" . \
  -x ".git/*" \
     ".git" \
     "icons/generate.html" \
     "icons/icon.svg" \
     ".gitignore" \
     ".DS_Store" \
     "icons/.DS_Store" \
     "build.sh"

echo ""
echo "Zip contents:"
unzip -l "$OUT"

echo ""
echo "File size:"
ls -lh "$OUT" | awk '{print $5, $9}'

echo ""
echo "Done. Share in Slack: $(cd .. && pwd)/${NAME}"
