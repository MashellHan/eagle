#!/bin/sh
# Assemble an ad-hoc signed .app so the client launches like a normal macOS
# application (Dock icon, menu bar, reliable activation).
#
#     ./Scripts/build-app.sh [debug|release]
set -eu
cd "$(dirname "$0")/.."

# SwiftUI macros need the Xcode toolchain; fall back to the selected one.
if [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
fi

CONFIG="${1:-debug}"
swift build -c "$CONFIG"
BINARY="$(swift build -c "$CONFIG" --show-bin-path)/EagleApp"
APP=".build/Eagle.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/EagleApp"
if [ ! -f Support/AppIcon.icns ]; then
  swift Scripts/make-icon.swift
fi
VERSION="$(node -p "require('../../package.json').version" 2>/dev/null || echo 0.0.0)"
sed "s|<string>0.0.0</string>|<string>${VERSION}</string>|" Support/Info.plist \
  > "$APP/Contents/Info.plist"
cp Support/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# SwiftUI resource bundles must ship next to the binary.
BUNDLE_DIR="$(dirname "$BINARY")"
for bundle in "$BUNDLE_DIR"/*.bundle; do
  [ -d "$bundle" ] || continue
  cp -R "$bundle" "$APP/Contents/Resources/"
done
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "$APP"
