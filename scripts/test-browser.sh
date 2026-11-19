#!/usr/bin/env bash
# All browser journeys (cloudflare/test/*.spec.js) against fresh local servers.
#   bash scripts/test-browser.sh [port] [spec names...]    e.g.  bash scripts/test-browser.sh 8871 print share
# PW_SERVERS local servers (default 4; use 1 on a small machine) on ports port, port+100, port+200, ...
# (inspectors at +900), each with its own data folder; every Playwright worker sticks to one of them
# (cloudflare/test/worker-server.js). PW_WORKERS workers (default 6). Its own ports and data, so parallel agents
# never share or kill each other's servers; all of them stop when this script exits or is killed.
# Server logs (/tmp/pc-test-<port>.log) keep warnings and errors only; WRANGLER_LOG_LEVEL=info brings back a line
# per request. LOCAL_NO_LIMITS turns off the per-address rate limits for these local servers only. The PW_SERVERS servers
# run with CALENDAR_DEFAULT=classic (the Worker's kill switch), so the many journeys written against Syncfusion keep
# opening it without a ?cal= param; one more server, without the var, is the real default (native) and its URL is
# NATIVE_DEFAULT_URL for the specs that test the default and the switch. The Plus/Stripe journeys
# need the fake-Stripe vars (scripts/test-all.sh) and are skipped here unless named.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${1:-8871}; shift || true
N=${PW_SERVERS:-4}
# Playwright from this checkout when installed (any machine), else the main Mac checkout.
PW_NODE_PATH=${PW_NODE_PATH:-$( [ -d "$ROOT/node_modules/@playwright/test" ] && echo "$ROOT/node_modules" || echo /Users/kazad/Dropbox/computer/Projects/pastecal/node_modules )}
NODE=${NODE:-node}
DATA=$(mktemp -d /tmp/pc-test.XXXX)
PORTS=() PIDS=() URLS=()
PW=
stop() {
  [ -n "$PW" ] && kill "$PW" 2>/dev/null
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null; done
  for p in ${PORTS[@]+"${PORTS[@]}"}; do pkill -f "wrangler dev --port $p " 2>/dev/null; done
  rm -rf "$DATA"
}
trap stop EXIT
trap 'exit 130' INT TERM HUP
for i in $(seq 0 $N); do
  P=$((PORT + 100 * i))
  # server N (the extra one) is the production default: no CALENDAR_DEFAULT
  CD="--var CALENDAR_DEFAULT:classic"; [ "$i" -eq "$N" ] && CD=""
  (cd "$ROOT/cloudflare" && exec $NODE node_modules/.bin/wrangler dev --port "$P" --inspector-port $((P + 900)) --persist-to "$DATA/$i" \
    --show-interactive-dev-session=false --log-level "${WRANGLER_LOG_LEVEL:-warn}" --var IMPORT_SECRET:dev-secret --var COPY_BACK: --var FIREBASE_DB_URL: --var LOCAL_NO_LIMITS:1 $CD \
    </dev/null > "/tmp/pc-test-$P.log" 2>&1) &
  PIDS+=($!) PORTS+=("$P") URLS+=("http://localhost:$P")
done
NATIVE_DEFAULT_URL=${URLS[$N]}; unset 'URLS[$N]'
for P in "${PORTS[@]}"; do
  for i in $(seq 1 90); do curl -s -o /dev/null -w '%{http_code}' "localhost:$P/" 2>/dev/null | grep -q 200 && break; sleep 1; done
done
cd "$ROOT"
SPECS=("$@")
[ ${#SPECS[@]} -eq 0 ] && SPECS=($(ls cloudflare/test/*.spec.js | xargs -n1 basename | grep -v -E "^(account|plus-tab|pro-beta)\.spec\.js$"))
# Playwright runs in the background so a kill reaches the trap at once instead of after the run.
NODE_PATH="$PW_NODE_PATH" NATIVE_DEFAULT_URL="$NATIVE_DEFAULT_URL" BASE_URL="${URLS[0]}" BASE_URLS=$(IFS=,; echo "${URLS[*]}") \
  $NODE "$PW_NODE_PATH/@playwright/test/cli.js" test -c cloudflare/playwright.config.js "${SPECS[@]}" &
PW=$!
wait $PW
