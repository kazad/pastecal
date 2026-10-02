#!/usr/bin/env bash
# Deploy database.rules.json via the REST API.
#
# Why not `firebase deploy --only database`: on this machine firebase-tools sends an EMPTY
# body for the rules upload -- verified with --debug, the PUT to /.settings/rules.json
# carries literally {"dryRun":true} and never the file -- so the server rejects it with
#   1:2: Expected 'rules' property.
# which reads exactly like a syntax error in a file that is in fact valid. The same file
# passes the server's own dry run through this script.
#
# Usage:  scripts/deploy-rules.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

# Anything but exactly --dry-run or nothing is refused: a typo like --dryrun used to be
# ignored and deploy to production. Checked first, before anything that needs a token or
# the network, so a mistyped flag can never get as far as an upload.
QS=""
[ "$#" -le 1 ] || { echo "usage: scripts/deploy-rules.sh [--dry-run]"; exit 2; }
case "${1:-}" in
    "") ;;
    --dry-run) QS="?dryRun=true" ;;
    *) echo "usage: scripts/deploy-rules.sh [--dry-run]"; exit 2 ;;
esac

RULES="database.rules.json"
DB="https://pastecal-web-default-rtdb.firebaseio.com"

python3 -c "import json,sys; json.load(open('$RULES'))" || { echo "ERROR: $RULES is not valid JSON."; exit 1; }

TOKEN="$(gcloud auth print-access-token 2>/dev/null)" || true
if [ -z "${TOKEN:-}" ]; then
    echo "ERROR: no gcloud access token. Run: gcloud auth login"
    exit 1
fi

echo "Uploading $RULES to $DB/.settings/rules.json$QS"
# The token goes in through a file descriptor, not argv, where any local user could read
# it from ps. -S so a network failure says why instead of exiting silently under set -e.
RESP="$(curl -sS -X PUT -w $'\n%{http_code}' \
    -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H "Content-Type: application/json" \
    --data-binary @"$RULES" "$DB/.settings/rules.json$QS")"

CODE="$(printf '%s' "$RESP" | tail -1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
echo "$BODY"

if [ "$CODE" != "200" ]; then
    echo "FAILED (HTTP $CODE)"
    exit 1
fi
echo "OK (HTTP $CODE)"
