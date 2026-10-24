#!/bin/sh
# Unit-test coverage for the logic layer.
#
# SwiftUI views are not covered here: they are exercised by
# `Scripts/render-snapshots.sh` and reviewed as images. The threshold applies to
# the view models and the token/state helpers, which is where behaviour lives.
#
#     ./Scripts/coverage.sh [minimum-percent]
set -eu
cd "$(dirname "$0")/.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
MINIMUM="${1:-90}"

swift test --enable-code-coverage
CODECOV="$(swift test --show-codecov-path)"
PROFILE="$(dirname "$CODECOV")/default.profdata"
BIN_DIR="$(dirname "$(dirname "$CODECOV")")"

REPORT=".build/coverage.txt"
: > "$REPORT"
for bundle in EagleDesignTests EagleFeaturesTests; do
  binary="$BIN_DIR/$bundle.xctest/Contents/MacOS/$bundle"
  [ -x "$binary" ] || continue
  xcrun llvm-cov report "$binary" -instr-profile "$PROFILE" >> "$REPORT"
done

awk -v minimum="$MINIMUM" '
  /WorkspaceViewModels\.swift|Theme\.swift|SidebarList\.swift/ {
    lines += $8
    missed += $9
    printf "  %-52s %6s lines, %s covered\n", $1, $8, $10
  }
  END {
    if (lines == 0) {
      print "coverage: no logic files matched"
      exit 1
    }
    covered = lines - missed
    percent = (covered * 100) / lines
    printf "coverage: %d/%d lines = %.1f%% (minimum %.1f%%)\n", covered, lines, percent, minimum
    if (percent + 0 < minimum + 0) {
      print "coverage below threshold"
      exit 1
    }
  }
' "$REPORT"
