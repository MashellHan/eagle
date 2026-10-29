#!/bin/sh
# Assemble the candidate App without replacing the last complete build on failure.
set -eu
cd "$(dirname "$0")/.."

app_configuration="${1:-debug}"
case "$app_configuration" in debug|release) ;; *) echo "Usage: build-app.sh [debug|release]" >&2; exit 1 ;; esac
mkdir -p .build
app_lock="$PWD/.build/app-assembly.lock"
mkdir "$app_lock" || { echo "Another App assembly owns $app_lock" >&2; exit 1; }
app_temporary=""
app_previous=""
app_output="$PWD/.build/Eagle.app"
cleanup_app() {
  if [ -d "$app_previous" ] && [ ! -e "$app_output" ]; then
    mv "$app_previous" "$app_output" || {
      echo "Previous App preserved at $app_previous" >&2
      rmdir "$app_lock"
      return
    }
  fi
  if [ -n "$app_temporary" ]; then rm -rf "$app_temporary"; fi
  rmdir "$app_lock"
}
trap cleanup_app EXIT
trap 'exit 1' HUP INT TERM
app_temporary="$(mktemp -d "$PWD/.build/eagle-app-assembly.XXXXXX")"
app_staged="$app_temporary/Eagle.app"
app_previous="$app_temporary/previous.app"

../../scripts/swift-gate.sh build -c "$app_configuration"
app_binary="$(../../scripts/swift-gate.sh build -c "$app_configuration" --show-bin-path)/EagleApp"
mkdir -p "$app_staged/Contents/MacOS" "$app_staged/Contents/Resources" "$app_staged/Contents/Helpers"
cp "$app_binary" "$app_staged/Contents/MacOS/EagleApp"
if [ ! -f Support/AppIcon.icns ]; then
  swift Scripts/make-icon.swift
fi
app_version="$(node -p "require('../../package.json').version")"
sed "s|<string>0.0.0</string>|<string>${app_version}</string>|" Support/Info.plist > "$app_staged/Contents/Info.plist"
cp Support/AppIcon.icns "$app_staged/Contents/Resources/AppIcon.icns"

# Each product retains its own source, lock and dependencies. No unpublished npm
# version is requested and no development .env is copied into the App.
node ../../scripts/bundle-agent.ts "$app_staged/Contents/Resources/Agent"
node ../bots/scripts/bundle.ts "$app_staged/Contents/Resources/Bots"
../../scripts/swift-gate.sh build --package-path ../bots-macos --scratch-path "$app_temporary/helper-build" --product BotsCredentialHelper -c "$app_configuration"
app_helper="$(../../scripts/swift-gate.sh build --package-path ../bots-macos --scratch-path "$app_temporary/helper-build" --show-bin-path -c "$app_configuration")/BotsCredentialHelper"
cp "$app_helper" "$app_staged/Contents/Helpers/BotsCredentialHelper"
codesign --force --sign - --identifier ai.hexly.eagle.bots-credential-helper "$app_staged/Contents/Helpers/BotsCredentialHelper"
codesign --verify --strict "$app_staged/Contents/Helpers/BotsCredentialHelper"

app_binary_directory="$(dirname "$app_binary")"
for bundle in "$app_binary_directory"/*.bundle; do
  [ -d "$bundle" ] || continue
  cp -R "$bundle" "$app_staged/Contents/Resources/"
done
codesign --force --sign - "$app_staged"
codesign --verify --deep --strict "$app_staged"
if [ -e "$app_output" ]; then mv "$app_output" "$app_previous"; fi
mv "$app_staged" "$app_output"
printf '%s\n' "$app_output"
