#!/bin/sh
# Performance suite: real clock, generous bounds, informational results.
set -eu
cd "$(dirname "$0")/.."
[ -d test/perf ] || { echo "no perf suite yet (stage 4)" >&2; exit 1; }
find test/perf -name '*.test.ts' | sort
