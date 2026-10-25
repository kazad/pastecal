#!/usr/bin/env bash
# Run every test in the repo with one command and print a pass/fail table.
#
#   scripts/test-all.sh                 # everything
#   scripts/test-all.sh --list          # suite names and the server setup each one needs
#   scripts/test-all.sh --only sync,lock,unit
#
# Each Worker suite gets its own local `wrangler dev --local` (fresh --persist-to, ports from
# 8700-8799 / inspector 9700-9799, settings only through --var), so suites never share state or
# the 10-a-minute create limit. FIREBASE_DB_URL always points at a local address and COPY_BACK is
# empty unless the suite is the copy-back test, so nothing reaches Firebase, Stripe or pastecal.com.
# Every wrangler this script starts is killed on exit, and the unit-test node_modules symlinks are
# removed again. Logs: /tmp/pastecal-test-all-<timestamp>/. Exits nonzero if any suite failed.
# Works with macOS bash 3.2 and Linux. Status: complete; last full run 2026-10-23 (Linux, Node 22), all 25 run suites passed in 246s.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF="$ROOT/cloudflare"
NODE="${NODE:-$HOME/.nvm/versions/node/v22.18.0/bin/node}"
[ -x "$NODE" ] || NODE="$HOME/.local/share/mise/installs/node/22/bin/node"   # Linux box: mise, Node 22 (.nvmrc)
MAIN_REPO="${MAIN_REPO:-/Users/kazad/Dropbox/computer/Projects/pastecal}"
WRANGLER="node_modules/.bin/wrangler"   # relative to cloudflare/, as the tests expect
RUN_DIR="/tmp/pastecal-test-all-$(date +%Y%m%d-%H%M%S)"
SECRET="dev-secret"
DEAD_FIREBASE="http://127.0.0.1:9"

# name | setup ("-" = no server). Order = run order.
SUITES="
stripe-unit|none
collector|none
site|none
headers|none
ics-safety|none
sync|plain
stress|plain
phase3|plain
firebase-sync|plain
cloud-service|plain
waitlist|plain
hardening|plain
view-socket|plain
archive|plain+persist
backup|plain+persist
copyback|copyback (fake Firebase on 9099, started by the test)
lock|lock (UNSAFE_DEV_SESSION_HEADER)
permissions|pro (UNSAFE_DEV_SESSION_HEADER + ACCOUNTS_DEV_MODE)
stats|pro+persist
restore|pro+persist
accounts|billing (fake Stripe vars + LOCK_API_BASE)
billing|billing x3 (BASE, NOKEYS_BASE, TESTKEY_BASE; fake Stripe started by the test)
welcome|billing
pro-health|billing
test-inbox|billing
stripe-sandbox-e2e|SKIP: needs the real Stripe sandbox, its secret key and \`stripe listen\`
pro-browser-e2e|SKIP: needs the real Stripe sandbox (same setup as stripe-sandbox-e2e) and Playwright
cloud-journeys|SKIP: Playwright browser suite for the main app; not run here (browser test, see docs/pro-plan.md rule 6)
unit|node --test \$(node test/unit-files.js)
"

ONLY=""
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1 ;;
    --only) shift; ONLY="${1:-}" ;;
    --only=*) ONLY="${1#--only=}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (use --list or --only a,b)"; exit 2 ;;
  esac
  shift
done

if [ "$LIST" = 1 ]; then
  echo "$SUITES" | while IFS='|' read -r n s; do [ -n "$n" ] && printf '%-20s %s\n' "$n" "$s"; done
  exit 0
fi

wanted() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}
if [ -n "$ONLY" ]; then
  for w in $(echo "$ONLY" | tr ',' ' '); do
    echo "$SUITES" | grep -q "^$w|" || { echo "no such suite: $w (see --list)"; exit 2; }
  done
fi

[ -x "$NODE" ] || { echo "node not found at $NODE (set NODE=)"; exit 2; }
mkdir -p "$RUN_DIR"
START_TS=$(date +%s)

# ---------------------------------------------------------------- cleanup
WRANGLER_PIDS=""
MADE_LINKS=""
kill_tree() {
  local p c
  p="$1"
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill "$p" 2>/dev/null
}
stop_wranglers() {
  local p
  for p in $WRANGLER_PIDS; do kill_tree "$p"; done
  sleep 1
  for p in $WRANGLER_PIDS; do
    for c in $(pgrep -P "$p" 2>/dev/null); do kill -9 "$c" 2>/dev/null; done
    kill -9 "$p" 2>/dev/null
  done
  WRANGLER_PIDS=""
}
cleanup() {
  stop_wranglers
  local l
  for l in $MADE_LINKS; do [ -L "$l" ] && rm -f "$l"; done
  MADE_LINKS=""
}
trap cleanup EXIT
trap 'echo; echo "interrupted"; exit 130' INT TERM

# ---------------------------------------------------------------- ports
NEXT_PORT=8700
NEXT_INSPECT=9700
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
take_port() {   # take_port VAR  (8700-8799)
  while port_busy "$NEXT_PORT"; do NEXT_PORT=$((NEXT_PORT + 1)); done
  [ "$NEXT_PORT" -le 8799 ] || { echo "no free port left in 8700-8799"; exit 2; }
  eval "$1=$NEXT_PORT"; NEXT_PORT=$((NEXT_PORT + 1))
}
take_inspect() {
  while port_busy "$NEXT_INSPECT"; do NEXT_INSPECT=$((NEXT_INSPECT + 1)); done
  [ "$NEXT_INSPECT" -le 9799 ] || { echo "no free inspector port left in 9700-9799"; exit 2; }
  eval "$1=$NEXT_INSPECT"; NEXT_INSPECT=$((NEXT_INSPECT + 1))
}
# Ports wrap within the range: a stopped instance frees its port for a later suite.
reset_ports() { NEXT_PORT=8700; NEXT_INSPECT=9700; }

FAKE_PORT=""

# ---------------------------------------------------------------- wrangler
# start_wrangler LABEL PERSIST_DIR --var ... ; sets LAST_BASE. Returns 1 if it never got ready.
LAST_BASE=""
start_wrangler() {
  local label="$1" persist="$2" port insp log pid i
  shift 2
  take_port port; take_inspect insp
  log="$RUN_DIR/wrangler-$label.log"
  ( cd "$CF" && exec env WRANGLER_SEND_METRICS=false "$NODE" "$WRANGLER" dev --local \
      --port "$port" --inspector-port "$insp" --persist-to "$persist" \
      --show-interactive-dev-session=false --var "IMPORT_SECRET:$SECRET" "$@" ) </dev/null >"$log" 2>&1 &
  pid=$!
  WRANGLER_PIDS="$WRANGLER_PIDS $pid"
  for i in $(seq 1 120); do
    if grep -q "Ready on" "$log" 2>/dev/null; then LAST_BASE="http://localhost:$port"; return 0; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  echo "  wrangler ($label) did not start; see $log"
  return 1
}

PLAIN_VARS="--var COPY_BACK: --var FIREBASE_DB_URL:$DEAD_FIREBASE"
LOCK_VARS="$PLAIN_VARS --var UNSAFE_DEV_SESSION_HEADER:on --var LOCK_API_BASE:"   # empty: override any LOCK_API_BASE left in cloudflare/.dev.vars
PRO_VARS="$LOCK_VARS --var ACCOUNTS_DEV_MODE:1"
fake_stripe_vars() {   # needs FAKE_PORT
  BILLING_VARS="$PLAIN_VARS --var ACCOUNTS_DEV_MODE:1 --var LOCK_API_BASE:http://127.0.0.1:$FAKE_PORT/lockfake"
  STRIPE_VARS="--var STRIPE_SECRET_KEY:fake-stripe-key --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret \
--var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly \
--var STRIPE_API_BASE:http://127.0.0.1:$FAKE_PORT/stripe"
  TESTKEY_VARS="$PLAIN_VARS --var ACCOUNTS_DEV_MODE:0 --var LOCK_API_BASE:http://127.0.0.1:$FAKE_PORT/lockfake \
--var STRIPE_SECRET_KEY:sk_test_fake --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret"
}

# ---------------------------------------------------------------- results
RESULTS=""   # lines: name|RESULT|checks|log
FAILED=0
record() { RESULTS="$RESULTS$1|$2|$3|$4
"; [ "$2" = FAIL ] && FAILED=1; return 0; }
checks_in() {   # "N checks passed" or node --test's "# pass N" / "ℹ pass N"
  local c
  c=$(grep -Eo '^[0-9]+ checks passed' "$1" 2>/dev/null | tail -1 | grep -Eo '^[0-9]+')
  [ -z "$c" ] && c=$(grep -Eo '^(# |ℹ )pass [0-9]+' "$1" 2>/dev/null | tail -1 | grep -Eo '[0-9]+$')
  echo "${c:--}"
}
# run_suite NAME LOG env... -- cmd...   (runs in cloudflare/ unless CWD is set)
run_node() {
  local name="$1" log="$2" cwd="$3"
  shift 3
  local t0=$(date +%s)
  ( cd "$cwd" && exec env "$@" ) >"$log" 2>&1 </dev/null
  local rc=$? t1=$(date +%s)
  local res=PASS; [ $rc -ne 0 ] && res=FAIL
  printf '  %-4s %-20s %3ss  %s checks\n' "$res" "$name" $((t1 - t0)) "$(checks_in "$log")"
  record "$name" "$res" "$(checks_in "$log")" "$log"
}

# ---------------------------------------------------------------- one suite
run_one() {
  local name="$1" setup="$2" log="$RUN_DIR/$name.log" persist base nokeys testkey
  case "$setup" in SKIP:*)
    printf '  %-4s %-20s %s\n' SKIP "$name" "${setup#SKIP: }"
    record "$name" SKIP - "${setup#SKIP: }"; return ;;
  esac
  reset_ports
  persist=$(mktemp -d "$RUN_DIR/persist-$name.XXXX")
  case "$name" in
    stripe-unit|collector|site|headers|ics-safety)
      run_node "$name" "$log" "$CF" "$NODE" "test/$name.test.mjs" ;;
    sync|stress|phase3|firebase-sync|cloud-service|waitlist|hardening|view-socket|archive|backup)
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $PLAIN_VARS || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
    copyback)
      if port_busy 9099; then
        echo "  FAIL copyback: port 9099 (the test's fake Firebase) is in use"; record "$name" FAIL - "port 9099 busy"; return
      fi
      start_wrangler "$name" "$persist" --var "COPY_BACK:test-cb-*" --var "FIREBASE_DB_URL:http://localhost:9099" \
        || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
    lock)
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $LOCK_VARS || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
    permissions|stats|restore)
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $PRO_VARS || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
    accounts|welcome|pro-health|test-inbox|billing)
      take_port FAKE_PORT; fake_stripe_vars
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $BILLING_VARS $STRIPE_VARS || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      base="$LAST_BASE"; nokeys=""; testkey=""
      if [ "$name" = billing ]; then
        # shellcheck disable=SC2086
        start_wrangler billing-nokeys "$(mktemp -d "$RUN_DIR/persist-billing-nokeys.XXXX")" $BILLING_VARS \
          || { record "$name" FAIL - "$RUN_DIR/wrangler-billing-nokeys.log"; return; }
        nokeys="$LAST_BASE"
        # shellcheck disable=SC2086
        start_wrangler billing-testkey "$(mktemp -d "$RUN_DIR/persist-billing-testkey.XXXX")" $TESTKEY_VARS \
          || { record "$name" FAIL - "$RUN_DIR/wrangler-billing-testkey.log"; return; }
        testkey="$LAST_BASE"
      fi
      run_node "$name" "$log" "$CF" BASE="$base" NOKEYS_BASE="$nokeys" TESTKEY_BASE="$testkey" FAKE_PORT="$FAKE_PORT" \
        IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
    unit)
      local l
      for l in node_modules functions/node_modules; do
        if [ ! -e "$ROOT/$l" ] && [ ! -L "$ROOT/$l" ]; then
          ln -s "$MAIN_REPO/$l" "$ROOT/$l" && MADE_LINKS="$MADE_LINKS $ROOT/$l"
        fi
      done
      local files
      files=$(cd "$ROOT" && "$NODE" test/unit-files.js | tr '\n' ' ')
      # shellcheck disable=SC2086
      run_node unit "$log" "$ROOT" "$NODE" --test $files
      for l in $MADE_LINKS; do [ -L "$l" ] && rm -f "$l"; done
      MADE_LINKS="" ;;
  esac
  stop_wranglers
}

echo "pastecal test-all  (logs: $RUN_DIR)"
echo "$SUITES" > "$RUN_DIR/.suites"
while IFS='|' read -r name setup; do
  [ -z "$name" ] && continue
  wanted "$name" || continue
  run_one "$name" "$setup"
done < "$RUN_DIR/.suites"
rm -f "$RUN_DIR/.suites"

# ---------------------------------------------------------------- table
END_TS=$(date +%s)
echo
printf '%-20s | %-6s | %-6s | %s\n' SUITE RESULT CHECKS "LOG PATH"
printf '%-20s-+-%-6s-+-%-6s-+-%s\n' "--------------------" "------" "------" "--------"
printf '%s' "$RESULTS" | while IFS='|' read -r n r c l; do
  [ -n "$n" ] && printf '%-20s | %-6s | %-6s | %s\n' "$n" "$r" "$c" "$l"
done
echo
echo "total: $((END_TS - START_TS))s   logs: $RUN_DIR"
if [ "$FAILED" = 1 ]; then echo "SOME SUITES FAILED"; exit 1; fi
echo "all run suites passed"
exit 0
