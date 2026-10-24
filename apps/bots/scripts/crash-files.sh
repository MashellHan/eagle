#!/bin/sh
# Crash suite: real SIGKILL against a child daemon. Never part of `npm test`.
set -eu
cd "$(dirname "$0")/.."
[ -d test/crash ] || { echo "no crash suite yet (stage 4)" >&2; exit 1; }
find test/crash -name '*.test.ts' | sort
