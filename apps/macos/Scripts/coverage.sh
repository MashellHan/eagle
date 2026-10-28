#!/bin/sh
# Unit-test coverage for the logic layer.
#
# SwiftUI views are not covered here: they are exercised by the snapshot
# renderer and reviewed as images. The threshold applies to the view models and
# token helpers, which is where behaviour lives.
#
#     ./Scripts/coverage.sh [minimum-percent]
set -eu
cd "$(dirname "$0")/.."

if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
MINIMUM="${1:-90}"

coverage_root="$(mktemp -d "${TMPDIR:-/tmp}/eagle-macos-coverage.XXXXXX")"
trap 'rm -rf "$coverage_root"' EXIT
../../scripts/swift-gate.sh test --scratch-path "$coverage_root" --enable-code-coverage

PROFILE="$(find "$coverage_root" -name default.profdata -print -quit)"
[ -n "$PROFILE" ] || { echo "coverage: no profile data found"; exit 1; }

REPORT=".build/coverage.txt"
mkdir -p .build
: > "$REPORT"
coverage_bundles="$coverage_root/test-bundles.txt"
find "$coverage_root" -name '*.xctest' -type d -print > "$coverage_bundles"
while IFS= read -r bundle; do
  name="$(basename "$bundle" .xctest)"
  binary="$bundle/Contents/MacOS/$name"
  [ -x "$binary" ] || continue
  xcrun llvm-cov report "$binary" -instr-profile "$PROFILE" >> "$REPORT"
done < "$coverage_bundles"

if ! grep -q 'WorkspaceViewModels.swift' "$REPORT"; then
  echo "coverage: no logic files matched; profile=$PROFILE"
  ls -d .build/out/Products/Debug/*.xctest 2>/dev/null || true
  exit 1
fi

# New machine logic must be instrumented too; views keep their image-review gate.
for logic in Sources/EagleFeatures/Machines/*.swift; do
  case "$logic" in *View.swift) continue ;; esac
  if ! grep -q "$(basename "$logic")" "$REPORT"; then
    echo "coverage: missing machine logic $logic"
    exit 1
  fi
done

# These Bots files are exercised by this App consumer's HTTP tests. Their rows
# must exist as well as count toward the floor; standalone Bots totals omit them.
for logic in BotsCore/Domain/RemoteTools BotsTransport/RemoteToolsHTTPClient; do
  if ! grep -Eq "(^|/)$logic\\.swift[[:space:]]" "$REPORT"; then
    echo "coverage: missing consumer logic $logic.swift"
    exit 1
  fi
done

awk -v minimum="$MINIMUM" '
  /WorkspaceViewModels\.swift|SettingsViewModel\.swift|SettingsModels\.swift|SidebarComposition\.swift|Theme\.swift|SidebarList\.swift/ || (/Machines\/.*\.swift/ && !/View\.swift/) ||
  $1 ~ /(^|\/)BotsCore\/Domain\/RemoteTools\.swift$/ ||
  $1 ~ /(^|\/)BotsTransport\/RemoteToolsHTTPClient\.swift$/ {
    lines += $8
    missed += $9
    printf "  %-52s %6s lines, %s covered\n", $1, $8, $10
  }
  END {
    covered = lines - missed
    percent = (covered * 100) / lines
    printf "coverage: %d/%d lines = %.1f%% (minimum %.1f%%)\n", covered, lines, percent, minimum
    if (percent + 0 < minimum + 0) {
      print "coverage below threshold"
      exit 1
    }
  }
' "$REPORT"
