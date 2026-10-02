#!/usr/bin/env bash
# Runs the Playwright e2e suite against the Firebase emulators (hosting, database,
# functions, auth) under the demo-pastecal project, so no test can read or write
# production. Extra arguments go to `playwright test` (e.g. -g timeformat).
#
# NOT in CI yet: see test/README.md ("E2E against the emulators") for what remains.
set -euo pipefail
cd "$(dirname "$0")/.."
source test/firebase-cli.sh

args=""
for a in "$@"; do args+=" $(printf '%q' "$a")"; done
exec "${FIREBASE[@]}" emulators:exec --project demo-pastecal \
    --only hosting,database,functions,auth "npx playwright test${args}"
