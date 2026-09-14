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

RULES="database.rules.json"
DB="https://pastecal-web-default-rtdb.firebaseio.com"

python3 -c "import json,sys; json.load(open('$RULES'))" || { echo "ERROR: $RULES is not valid JSON."; exit 1; }

TOKEN="$(gcloud auth print-access-token 2>/dev/null)" || true
if [ -z "${TOKEN:-}" ]; then
    echo "ERROR: no gcloud access token. Run: gcloud auth login"
    exit 1
fi

QS=""
[ "${1:-}" = "--dry-run" ] && QS="?dryRun=true"

echo "Uploading $RULES to $DB/.settings/rules.json$QS"
RESP="$(curl -s -X PUT -w $'\n%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data-binary @"$RULES" "$DB/.settings/rules.json$QS")"

CODE="$(printf '%s' "$RESP" | tail -1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
echo "$BODY"

if [ "$CODE" != "200" ]; then
    echo "FAILED (HTTP $CODE)"
    exit 1
fi
echo "OK (HTTP $CODE)"
