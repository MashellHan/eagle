#!/bin/sh
# Runs one non-deterministic suite (crash or perf). An empty or missing suite fails
# loudly instead of falling back to Node's automatic test discovery.
set -eu
cd "$(dirname "$0")/.."

dir=${1:-}
[ -n "$dir" ] || { echo "usage: run-suite.sh <directory>" >&2; exit 2; }
[ -d "$dir" ] || { echo "no $dir suite yet" >&2; exit 1; }

files=$(find "$dir" -name '*.test.ts' | sort)
[ -n "$files" ] || { echo "no test files in $dir" >&2; exit 1; }

exec node --test $files
