#!/usr/bin/env bash
# Deploy pastecal to Firebase.
#
# Usage:
#   ./deploy.sh                 # deploy everything (database, functions, hosting, remoteconfig)
#   ./deploy.sh functions       # deploy only functions (fastest; use after a Cloud Function change)
#   ./deploy.sh hosting         # deploy only static assets
#   ./deploy.sh functions,hosting
#   ./deploy.sh --skip-tests functions   # emergency only: deploys WITHOUT running the tests
#
# Every deploy first runs `npm run test:unit` (fast + emulator-backed) and stops if it fails.
# The suite used to be advisory: nothing ran it before a deploy, and bugs it would have
# caught shipped anyway.
#
# Why the preflight check below: this repo lives in a Dropbox folder, and every JSON config
# here carries a com.dropbox.attrs xattr. If Dropbox is mid-sync when firebase-tools reads
# database.rules.json, it can see a truncated file and fail with
#
#     Error: Syntax error in database rules:
#     1:2: Expected 'rules' property.
#
# even though the file on disk is perfectly valid (column 2 is where an empty `{}` ends).
# The check below reads each config the same way firebase does and fails loudly with the
# actual bad content, so a real syntax error is never confused with a sync race.

set -euo pipefail

cd "$(dirname "$0")"

TARGETS=""
SKIP_TESTS=""
for arg in "$@"; do
    case "$arg" in
        --skip-tests) SKIP_TESTS=1 ;;
        -*) echo "ERROR: unknown flag $arg"; echo "usage: ./deploy.sh [--skip-tests] [targets]"; exit 2 ;;
        *)
            [ -z "$TARGETS" ] || { echo "ERROR: give targets as one comma-separated list"; exit 2; }
            TARGETS="$arg" ;;
    esac
done

# --- Preflight: verify configs are readable and well-formed before we start deploying ------
CONFIGS=("firebase.json" "database.rules.json" ".firebaserc" "remoteconfig.template.json")

for f in "${CONFIGS[@]}"; do
    [ -f "$f" ] || { echo "ERROR: $f is missing."; exit 1; }

    if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" 2>/dev/null; then
        echo "ERROR: $f is not valid JSON right now."
        echo "       Size: $(wc -c < "$f") bytes. Contents:"
        sed 's/^/         /' "$f"
        echo
        echo "       If this file looks correct in your editor, Dropbox is probably mid-sync."
        echo "       Wait for the Dropbox icon to go idle, then re-run."
        exit 1
    fi
done

# database.rules.json must actually have a top-level "rules" key — this is the exact
# assertion firebase-tools makes, and the one that fails during a sync race.
python3 - <<'PY' || exit 1
import json, sys
with open("database.rules.json") as fh:
    rules = json.load(fh)
if "rules" not in rules:
    print("ERROR: database.rules.json has no top-level 'rules' property.")
    print("       Got keys:", list(rules.keys()) or "(empty file)")
    sys.exit(1)
PY

echo "Preflight OK: configs are valid JSON."

# --- Pin the Node version firebase-tools runs under ---------------------------------------
# firebase-tools loads functions/ in-process to analyze it. functions/ depends on
# firebase-admin -> jsonwebtoken -> jwa -> buffer-equal-constant-time, which reads
# SlowBuffer.prototype. SlowBuffer was REMOVED in Node 22+, so on a newer runtime the
# analysis step dies with a confusing error that blames your source:
#
#     TypeError: Cannot read properties of undefined (reading 'prototype')
#         at .../buffer-equal-constant-time/index.js:37
#     Error: Functions codebase could not be analyzed successfully.
#
# The Homebrew `firebase-cli` formula depends on unversioned `node`, so it runs under
# Homebrew's newest Node no matter what nvm sets in your shell -- which is why the deploy
# can fail while `node --version` reports something perfectly fine.
#
# Deployed functions run on Node 20 (functions/package.json engines), so analyzing with
# Node 20 also matches production. Remove this once functions/ is upgraded past the
# firebase-admin versions that pull in SlowBuffer.
REQUIRED_NODE_MAJOR="$(python3 -c "import json;print(json.load(open('functions/package.json'))['engines']['node'])")"

node_major() { "$1" --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }

if [ "$(node_major node)" != "$REQUIRED_NODE_MAJOR" ]; then
    PINNED=""
    for candidate in \
        "/opt/homebrew/opt/node@${REQUIRED_NODE_MAJOR}/bin" \
        "/usr/local/opt/node@${REQUIRED_NODE_MAJOR}/bin" \
        "$HOME/.nvm/versions/node/v${REQUIRED_NODE_MAJOR}"*/bin
    do
        if [ -x "$candidate/node" ] && [ "$(node_major "$candidate/node")" = "$REQUIRED_NODE_MAJOR" ]; then
            PINNED="$candidate"
            break
        fi
    done

    if [ -n "$PINNED" ]; then
        echo "Using Node ${REQUIRED_NODE_MAJOR} from $PINNED (shell default is $(node --version))."
        export PATH="$PINNED:$PATH"
    else
        echo "WARNING: functions/ requires Node ${REQUIRED_NODE_MAJOR}, but only $(node --version) was found."
        echo "         If the deploy fails while analyzing the functions codebase, install it:"
        echo "             brew install node@${REQUIRED_NODE_MAJOR}"
        echo "         (Node 22+ removed SlowBuffer, which firebase-admin's dep chain still uses.)"
    fi
fi

# --- Shared modules: functions/caldate.js -> public/models/caldate.js ---------------------
# The ICS feed and the app must read dates identically; the browser copy is synced from
# functions/ (the source of truth) before anything is deployed. See scripts/sync-shared.sh.
./scripts/sync-shared.sh

# --- Tests gate the deploy -----------------------------------------------------------------
# After the Node pin above, so they run on the runtime production uses.
if [ -n "$SKIP_TESTS" ]; then
    echo
    echo "################################################################################"
    echo "#  WARNING: --skip-tests. Deploying WITHOUT running the test suite.            #"
    echo "#  Whatever the suite would have caught is going to production unchecked.      #"
    echo "################################################################################"
    echo
else
    echo "Running npm run test:unit before deploying (use --skip-tests only in an emergency)..."
    if ! npm run test:unit; then
        echo
        echo "ERROR: tests failed -- not deploying. Fix them, or (emergency only) re-run with --skip-tests."
        exit 1
    fi
fi

# --- Cache-bust static assets (hosting only; skip when deploying just functions) -----------
if [ -z "$TARGETS" ] || [[ "$TARGETS" == *hosting* ]]; then
    ./bust_cache.sh
else
    echo "Skipping cache-bust (not deploying hosting)."
fi

# --- Deploy -------------------------------------------------------------------------------
# Database rules go through scripts/deploy-rules.sh: firebase-tools uploads an empty body
# for them on this machine (see that script), so `firebase deploy` would fail on, or skip,
# the rules that /history and the view bindings depend on.
# Matched as a whole target, so e.g. functions:databaseSync does not also send rules.
if [ -z "$TARGETS" ] || [[ ",$TARGETS," == *,database,* ]]; then
    ./scripts/deploy-rules.sh
fi
# `|| true`: when database was the only target, grep matches nothing and exits 1, which
# set -o pipefail would turn into a failed deploy after the rules had already shipped.
REST="$(printf '%s' "${TARGETS:-hosting,functions,remoteconfig}" | tr ',' '\n' | { grep -v '^database$' || true; } | paste -sd, -)"
if [ -n "$REST" ]; then
    echo "Deploying: $REST"
    firebase deploy --only "$REST"
fi
