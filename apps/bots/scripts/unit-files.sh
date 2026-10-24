#!/bin/sh
# The deterministic test file list, shared by `npm test` and `npm run coverage`.
# test/crash and test/perf are excluded on purpose: a real SIGKILL and a real clock
# are not deterministic, and they run as their own gates.
set -eu
cd "$(dirname "$0")/.."

files=""
for dir in src test/protocol test/core test/runtime test/server test/e2e test/log; do
  if [ -d "$dir" ]; then
    found=$(find "$dir" -name '*.test.ts' | sort)
    [ -n "$found" ] && files="$files$found
"
  fi
done

if [ -z "$files" ]; then
  echo "no deterministic test files yet; write the first failing test" >&2
  exit 1
fi
printf '%s' "$files"
