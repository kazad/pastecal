#!/usr/bin/env bash
# One-time: give the Worker its own Firebase identity so it can copy saves back to the
# Realtime Database. Run it yourself -- it creates a service account, grants it ONE role
# (database read/write, nothing else), makes a key, stores the key as the Worker secret
# FIREBASE_SA, and deletes the local key file. Re-run safe.
#
# To undo: gcloud iam service-accounts delete pastecal-copyback@pastecal-web.iam.gserviceaccount.com
#          wrangler secret delete FIREBASE_SA
set -euo pipefail
PROJECT=pastecal-web
SA=pastecal-copyback@$PROJECT.iam.gserviceaccount.com
KEY="$(mktemp)"; trap 'rm -f "$KEY"' EXIT
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create pastecal-copyback --project "$PROJECT" --display-name "pastecal Cloudflare copy-back"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role roles/firebasedatabase.admin --condition=None >/dev/null
gcloud iam service-accounts keys create "$KEY" --iam-account "$SA" --project "$PROJECT"
cd "$(dirname "$0")/.."
wrangler secret put FIREBASE_SA < "$KEY"
echo "Done. Copy-back is now ON for the calendars in COPY_BACK (wrangler.jsonc)."
