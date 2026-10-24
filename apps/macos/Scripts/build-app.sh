#!/bin/sh
# Assemble an ad-hoc signed .app so the client launches like a normal macOS
# application (Dock icon, menu bar, reliable activation).
#
#     ./Scripts/build-app.sh [debug|release]
set -eu
cd "$(dirname "$0")/.."

CONFIG="${1:-debug}"
swift build -c "$CONFIG"
BINARY="$(swift build -c "$CONFIG" --show-bin-path)/EagleApp"
APP=".build/Eagle.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/EagleApp"
cp Support/Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "$APP"
