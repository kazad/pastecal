#!/usr/bin/env bash
# All browser journeys (cloudflare/test/*.spec.js) against a fresh local server, six at a time.
#   bash scripts/test-browser.sh [port] [spec names...]    e.g.  bash scripts/test-browser.sh 8871 print share
# Its own port and data folder, so parallel agents never share or kill each other's servers. LOCAL_NO_LIMITS turns
# off the per-address rate limits for this local server only. The Plus/Stripe journeys need the fake-Stripe vars
# (scripts/test-all.sh) and are skipped here unless named.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${1:-8871}; shift || true
PW_NODE_PATH=${PW_NODE_PATH:-/Users/kazad/Dropbox/computer/Projects/pastecal/node_modules}
NODE=${NODE:-node}
DATA=$(mktemp -d /tmp/pc-test.XXXX)
(cd "$ROOT/cloudflare" && $NODE node_modules/.bin/wrangler dev --port "$PORT" --inspector-port $((PORT + 900)) --persist-to "$DATA" \
  --show-interactive-dev-session=false --var IMPORT_SECRET:dev-secret --var COPY_BACK: --var FIREBASE_DB_URL: --var LOCAL_NO_LIMITS:1 \
  </dev/null > "/tmp/pc-test-$PORT.log" 2>&1) &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; pkill -f "wrangler dev --port $PORT " 2>/dev/null' EXIT
for i in $(seq 1 60); do curl -s -o /dev/null -w '%{http_code}' "localhost:$PORT/" 2>/dev/null | grep -q 200 && break; sleep 1; done
cd "$ROOT"
SPECS=("$@")
[ ${#SPECS[@]} -eq 0 ] && SPECS=($(ls cloudflare/test/*.spec.js | xargs -n1 basename | grep -v -E "^(account|plus-tab|pro-beta)\.spec\.js$"))
NODE_PATH="$PW_NODE_PATH" BASE_URL="http://localhost:$PORT" $NODE "$PW_NODE_PATH/@playwright/test/cli.js" test -c cloudflare/playwright.config.js "${SPECS[@]}"
