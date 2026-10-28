#!/bin/sh
# Logic coverage for the client: the pure fold, the codec, the catalog client, the token
# reader and the view models. The socket's connect/reconnect/close lifecycle is covered by
# the integration tests against a real daemon (row 61), not by line coverage here.
#
#     ./Scripts/coverage.sh [minimum-percent]
set -eu
cd "$(dirname "$0")/.."

if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
MINIMUM="${1:-90}"

coverage_root="$(mktemp -d "${TMPDIR:-/tmp}/eagle-bots-coverage.XXXXXX")"
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

awk -v minimum="$MINIMUM" '
  /Reducer\.swift|RevisionGap\.swift|Domain\.swift|JSONValue\.swift|Ports\.swift|Wire\.swift|CatalogHTTPClient\.swift|TokenStore\.swift|AppViewModel\.swift|ConversationViewModel\.swift|OutboxStore\.swift/ {
    # The same file appears once per test bundle; keep its best covered percentage.
    percent = $10 + 0
    if (!(($1) in best) || percent > best[$1]) {
      best[$1] = percent
      lines[$1] = $8
      missed[$1] = $9
    }
  }
  END {
    for (file in best) {
      covered = lines[file] - missed[file]
      total += lines[file]
      hit += covered
      printf "  %-56s %6d lines, %.1f%%\n", file, lines[file], best[file]
    }
    percent = (hit * 100) / total
    printf "coverage: %d/%d lines = %.1f%% (minimum %.1f%%)\n", hit, total, percent, minimum
    if (percent + 0 < minimum + 0) {
      print "coverage below threshold"
      exit 1
    }
  }
' "$REPORT"
