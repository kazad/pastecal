#!/usr/bin/env bash
# Copy the modules shared by the browser and Cloud Functions into public/.
#
# functions/caldate.js decides which calendar date a stored value names, for both the ICS
# feed (functions/index.js) and the app (public/models/Event.js). Only functions/ is
# uploaded as the Functions source and only public/ is served by hosting, so the browser
# gets a byte-identical copy at public/models/caldate.js. functions/ is the source of
# truth: edit it there, then run this. deploy.sh and firebase.json (hosting predeploy) run
# it before every deploy, and test/unit/caldate.test.js fails if the copies differ.
# functions/slug-rules.js (what a calendar or view name may be) is shared the same way;
# test/unit/slug-rules.test.js guards that copy.
#
# Usage:
#   scripts/sync-shared.sh          # copy
#   scripts/sync-shared.sh --check  # exit 1 if a copy is stale, change nothing

set -euo pipefail
cd "$(dirname "$0")/.."

SHARED=(
    "functions/caldate.js:public/models/caldate.js"
    "functions/slug-rules.js:public/utils/slug-rules.js"
)

status=0
for pair in "${SHARED[@]}"; do
    src="${pair%%:*}"; dst="${pair#*:}"
    [ -f "$src" ] || { echo "ERROR: $src is missing."; exit 1; }
    if cmp -s "$src" "$dst"; then continue; fi
    if [ "${1:-}" = "--check" ]; then
        echo "STALE: $dst differs from $src (run scripts/sync-shared.sh)"
        status=1
    else
        cp "$src" "$dst"
        echo "Synced $src -> $dst"
    fi
done
exit $status
