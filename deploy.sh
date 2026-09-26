#!/usr/bin/env bash
# Deploy pastecal to Firebase.
#
# Usage:
#   ./deploy.sh                 # deploy everything (database, functions, hosting, remoteconfig)
#   ./deploy.sh functions       # deploy only functions (fastest; use after a Cloud Function change)
#   ./deploy.sh hosting         # deploy only static assets
#   ./deploy.sh functions,hosting
#   SKIP_GATE=1 ./deploy.sh hosting   # emergency only -- ships without the release gate
#
# RELEASE GATE: before hosting ships, this runs the unit tests and the user journeys
# (test/journeys, in English desktop, French desktop and a French iPhone). If any fail,
# nothing is deployed. Nine of pastecal's ~30 issues were "my event didn't save", and #32
# shipped through a dialog every existing test called green; the journeys click and type
# like a person and check what reaches the server, so that class of bug stops here
# instead of in a user's inbox. Functions deploy BEFORE the gate, because the journeys
# read the live ICS feed and must see the new code.
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

TARGETS="${1:-}"

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

# --- Build CSS, then cache-bust static assets (hosting only) ------------------------------
if [ -z "$TARGETS" ] || [[ "$TARGETS" == *hosting* ]]; then
    # Tailwind is prebuilt (it used to compile in every visitor's browser). Rebuilding on
    # every deploy means a class added to the markup can never ship unstyled.
    ./scripts/build-css.sh
    ./bust_cache.sh
else
    echo "Skipping cache-bust (not deploying hosting)."
fi

# --- Release gate ---------------------------------------------------------------------------
# Unit tests need Node 20/22 (the same SlowBuffer problem as above); find one.
unit_node() {
    for n in "$(command -v node)" /opt/homebrew/opt/node@22/bin/node /opt/homebrew/opt/node@20/bin/node \
             "$HOME"/.nvm/versions/node/v22*/bin/node "$HOME"/.nvm/versions/node/v20*/bin/node; do
        [ -x "$n" ] || continue
        case "$(node_major "$n")" in 20|22) echo "$n"; return 0 ;; esac
    done
    return 1
}

run_gate() {
    if [ "${SKIP_GATE:-}" = "1" ]; then
        echo
        echo "!!! SKIP_GATE=1: shipping WITHOUT the release gate. Use only to ship an emergency fix."
        echo
        return 0
    fi
    echo
    echo "=== Release gate 1/2: unit tests ==="
    local un; un="$(unit_node)" || { echo "ERROR: need Node 20 or 22 to run unit tests (brew install node@22)."; exit 1; }
    # shellcheck disable=SC2046
    "$un" --test $(ls test/unit/*.test.js | grep -v emulator) || {
        echo; echo "RELEASE GATE FAILED: unit tests. Nothing was deployed to hosting."; exit 1; }

    echo
    echo "=== Release gate 2/2: user journeys (desktop-en, desktop-fr, iphone-fr, firefox-fr) ==="
    # The project's own Playwright, not `npx`: in some shells npx is a lazy-loading
    # function that recurses ("maximum nested function level reached") and never runs.
    [ -x ./node_modules/.bin/playwright ] || { echo "ERROR: run npm install first (no ./node_modules/.bin/playwright)."; exit 1; }
    ./node_modules/.bin/playwright test -c playwright.journeys.config.js --reporter=line || {
        echo
        echo "RELEASE GATE FAILED: a user journey broke. Nothing was deployed to hosting."
        echo "  Screenshots and traces: test-results/   Report: npx playwright show-report"
        exit 1
    }
    echo
    echo "Release gate passed."
}

# --- Deploy -------------------------------------------------------------------------------
# Everything except hosting goes first, then the gate, then hosting -- so a failing gate
# never leaves the site running new front-end code against old back-end code.
ALL_TARGETS="${TARGETS:-database,functions,hosting,remoteconfig}"
PRE_TARGETS="$(echo "$ALL_TARGETS" | tr ',' '\n' | grep -v '^hosting$' | paste -sd, - || true)"

if [ -n "$PRE_TARGETS" ]; then
    echo "Deploying: $PRE_TARGETS"
    firebase deploy --only "$PRE_TARGETS"
fi

if [[ ",$ALL_TARGETS," == *,hosting,* ]]; then
    run_gate
    # The release this deploy replaces, so going back is one known-good command. (Sep 26: a
    # bad release was live while the rollback syntax was worked out by trial and error.)
    PREV_VERSION="$(curl -s -H "Authorization: Bearer $(gcloud auth print-access-token 2>/dev/null)" \
        -H "x-goog-user-project: pastecal-web" \
        "https://firebasehosting.googleapis.com/v1beta1/sites/pastecal-web/releases?pageSize=1" \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['releases'][0]['version']['name'].split('/')[-1])" 2>/dev/null || true)"
    echo "Deploying: hosting"
    firebase deploy --only hosting
    if [ -n "$PREV_VERSION" ]; then
        echo
        echo "If this release misbehaves, go back to the previous one (takes seconds):"
        echo "  firebase hosting:clone pastecal-web@$PREV_VERSION pastecal-web:live"
    fi
fi
