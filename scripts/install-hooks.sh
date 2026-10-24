#!/bin/sh
# Point Git at the tracked hooks. `npm ci` runs this through the prepare script,
# so a fresh clone is protected without extra steps.
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "hooks: core.hooksPath=$(git config core.hooksPath)"
