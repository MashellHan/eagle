#!/bin/sh
# Keep the selected full Xcode toolchain, or use the verified installed CLT SDK/plugin.
# This changes only this process and never suppresses tests, diagnostics or coverage.
set -eu
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
developer="${DEVELOPER_DIR:-$(xcode-select -p)}"
case "$developer" in
  *.app/Contents/Developer) exec swift "$@" ;;
esac
case "${1:-}" in
  build|test)
    eagle_sdk="$developer/SDKs/MacOSX26.5.sdk"
    eagle_testing_plugin="$developer/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib"
    if [ ! -d "$eagle_sdk" ] || [ ! -f "$eagle_testing_plugin" ]; then
      echo "Swift gate: select full Xcode or provide the verified CLT SDK26.5 and TestingMacros plugin" >&2
      exit 1
    fi
    echo "Swift gate: CLT SDK26.5 with the installed TestingMacros plugin" >&2
    exec swift "$@" --sdk "$eagle_sdk" -Xswiftc -load-plugin-library -Xswiftc "$eagle_testing_plugin"
    ;;
  *) exec swift "$@" ;;
esac
