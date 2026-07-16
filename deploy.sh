#!/usr/bin/env bash
# Deploy pastecal to Firebase.
#
# Usage:
#   ./deploy.sh                 # deploy everything (database, functions, hosting, remoteconfig)
#   ./deploy.sh functions       # deploy only functions (fastest; use after a Cloud Function change)
#   ./deploy.sh hosting         # deploy only static assets
#   ./deploy.sh functions,hosting
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

# --- Cache-bust static assets (hosting only; skip when deploying just functions) -----------
if [ -z "$TARGETS" ] || [[ "$TARGETS" == *hosting* ]]; then
    ./bust_cache.sh
else
    echo "Skipping cache-bust (not deploying hosting)."
fi

# --- Deploy -------------------------------------------------------------------------------
if [ -n "$TARGETS" ]; then
    echo "Deploying only: $TARGETS"
    firebase deploy --only "$TARGETS"
else
    firebase deploy
fi
