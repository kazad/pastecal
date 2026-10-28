#!/usr/bin/env bash
# Run every test in the repo with one command and print a pass/fail table.
#
#   scripts/test-all.sh                 # everything
#   scripts/test-all.sh --list          # suite names and the server setup each one needs
#   scripts/test-all.sh --only sync,lock,unit
#   scripts/test-all.sh --skip unit       # everything but these
#   scripts/test-all.sh -j 1              # one suite at a time (default: -j <CPU count>: suites run side by side)
#
# Each Worker suite gets its own local `wrangler dev --local` (fresh --persist-to, its own 4 ports, settings
# only through --var), so suites never share state, ports or the 10-a-minute create limit, and run concurrently.
# Ports: each run locks one of 50 blocks of 160 ports in 12000-19999 (inspectors +12000), starting from a block
# picked by this checkout's path, so two runs on one machine (two checkouts, or the same one twice) never
# collide; suite i takes base+4i .. base+4i+3. TEST_PORT_BASE=<n> pins the base (still locked).
# The slowest suites start first; the table is in the order below, whatever order they finish in.
# FIREBASE_DB_URL always points at a local address and COPY_BACK is
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
RUN_DIR="/tmp/pastecal-test-all-$(date +%Y%m%d-%H%M%S)-$$"
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
previews-tz|plain
archive|plain+persist
backup|plain+persist
db-archive|plain+persist + --test-scheduled, ARCHIVE_CHUNK=3
copyback|copyback (fake Firebase on 9099, started by the test)
lock|lock (UNSAFE_DEV_SESSION_HEADER)
permissions|pro (UNSAFE_DEV_SESSION_HEADER + ACCOUNTS_DEV_MODE)
name-collision|pro (ACCOUNTS_DEV_MODE: the directory's dev-plant hook)
exact-names|pro+persist (ACCOUNTS_DEV_MODE: the registry's dev-forget hook; reads the archive from local R2)
name-key|pro+persist (ACCOUNTS_DEV_MODE: dev-plant legacy rows for the re-key; reads the archive from local R2)
stats|pro+persist
restore|pro+persist
accounts|billing (fake Stripe vars + LOCK_API_BASE)
billing|billing x3 (BASE, NOKEYS_BASE, TESTKEY_BASE; fake Stripe started by the test)
welcome|billing
pro-health|billing
test-inbox|billing
trial|realbilling (real rooms, fake Stripe started by the test on FAKE_PORT)
unlimited|realbilling
handles|realbilling
stripe-sandbox-e2e|SKIP: needs the real Stripe sandbox, its secret key and \`stripe listen\`
pro-browser-e2e|SKIP: needs the real Stripe sandbox (same setup as stripe-sandbox-e2e) and Playwright
cloud-journeys|SKIP: Playwright browser suite for the main app; not run here (browser test, see docs/pro-plan.md rule 6)
unit|node --test \$(node test/unit-files.js)
"

ONLY=""
SKIP=""
LIST=0
JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
TEST_PORT_BASE="${TEST_PORT_BASE:-}"
# Test-only timings, set on every wrangler with --var (production keeps the defaults in CalendarRoom.js and
# RoomInsight.js). The tests read the same values, so their waits scale with them.
export COPY_BACK_DELAY_MS="${COPY_BACK_DELAY_MS:-1000}" RESTORE_MIN_GAP_MS="${RESTORE_MIN_GAP_MS:-1000}"
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1 ;;
    --only) shift; ONLY="${1:-}" ;;
    --only=*) ONLY="${1#--only=}" ;;
    --skip) shift; SKIP="${1:-}" ;;
    --skip=*) SKIP="${1#--skip=}" ;;
    -j|--jobs) shift; JOBS="${1:-}" ;;
    -j*) JOBS="${1#-j}" ;;
    --jobs=*) JOBS="${1#--jobs=}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (use --list, --only a,b, --skip a,b or -j N)"; exit 2 ;;
  esac
  shift
done

if [ "$LIST" = 1 ]; then
  echo "$SUITES" | while IFS='|' read -r n s; do [ -n "$n" ] && printf '%-20s %s\n' "$n" "$s"; done
  exit 0
fi

case "$JOBS" in ''|*[!0-9]*|0) echo "-j needs a positive number"; exit 2 ;; esac

wanted() {
  case ",$SKIP," in *",$1,"*) return 1 ;; esac
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}
if [ -n "$ONLY$SKIP" ]; then
  for w in $(echo "$ONLY,$SKIP" | tr ',' ' '); do
    echo "$SUITES" | grep -q "^$w|" || { echo "no such suite: $w (see --list)"; exit 2; }
  done
fi

[ -x "$NODE" ] || { echo "node not found at $NODE (set NODE=)"; exit 2; }

# ---------------------------------------------------------------- port block lock
# /tmp/pastecal-test-ports-<base>.lock (a directory: mkdir is atomic) holds the owner's pid; a lock whose owner
# is gone is taken over. Released on exit.
PORT_LOCK=""
lock_block() {   # lock_block BASE -> 0 if this run now holds it
  local lock="/tmp/pastecal-test-ports-$1.lock" p
  if ! mkdir "$lock" 2>/dev/null; then
    p=$(cat "$lock/pid" 2>/dev/null)
    { [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; } || return 1
    rm -rf "$lock"; mkdir "$lock" 2>/dev/null || return 1
  fi
  echo $$ > "$lock/pid"; PORT_LOCK="$lock"; TEST_PORT_BASE=$1
}
if [ -n "$TEST_PORT_BASE" ]; then
  lock_block "$TEST_PORT_BASE" || { echo "ports $TEST_PORT_BASE.. are locked by another test-all run (/tmp/pastecal-test-ports-$TEST_PORT_BASE.lock)"; exit 2; }
else
  b0=$(( $(printf '%s' "$ROOT" | cksum | cut -d' ' -f1) % 50 ))
  for i in $(seq 0 49); do lock_block $((12000 + ((b0 + i) % 50) * 160)) && break; done
  [ -n "$PORT_LOCK" ] || { echo "all 50 port blocks are locked by other test-all runs"; exit 2; }
fi
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
trap 'cleanup; [ -n "$PORT_LOCK" ] && rm -rf "$PORT_LOCK"' EXIT
trap 'echo; echo "interrupted"; exit 130' INT TERM

# ---------------------------------------------------------------- ports
# Suite number i (its line in SUITES) owns ports TEST_PORT_BASE+4i .. +4i+3 (billing needs all four: three
# wranglers and fake Stripe), plus the same +12000 for wrangler's inspector, so concurrent suites never
# collide. A port something else already listens on is skipped, within the block.
NEXT_PORT=0
PORT_END=0
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
take_port() {   # take_port VAR  (from this suite's block)
  while port_busy "$NEXT_PORT" || port_busy $((NEXT_PORT + 12000)); do NEXT_PORT=$((NEXT_PORT + 1)); done
  [ "$NEXT_PORT" -le "$PORT_END" ] || { echo "  no free port left in this suite's block (ends $PORT_END)"; return 1; }
  eval "$1=$NEXT_PORT"; NEXT_PORT=$((NEXT_PORT + 1))
}
reset_ports() { NEXT_PORT=$((TEST_PORT_BASE + 4 * $1)); PORT_END=$((NEXT_PORT + 3)); }

FAKE_PORT=""

# ---------------------------------------------------------------- wrangler
# start_wrangler LABEL PERSIST_DIR --var ... ; sets LAST_BASE. Returns 1 if it never got ready.
LAST_BASE=""
start_wrangler() {
  local label="$1" persist="$2" port insp log pid i
  shift 2
  take_port port || return 1; insp=$((port + 12000))
  log="$RUN_DIR/wrangler-$label.log"
  ( cd "$CF" && exec env WRANGLER_SEND_METRICS=false "$NODE" "$WRANGLER" dev --local \
      --port "$port" --inspector-port "$insp" --persist-to "$persist" \
      --show-interactive-dev-session=false --var "IMPORT_SECRET:$SECRET" \
      --var "COPY_BACK_DELAY_MS:$COPY_BACK_DELAY_MS" --var "RESTORE_MIN_GAP_MS:$RESTORE_MIN_GAP_MS" "$@" ) </dev/null >"$log" 2>&1 &
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
  # Real rooms (no LOCK_API_BASE): trial, Pro (unlimited) and its names; the test starts fake Stripe on FAKE_PORT.
  REAL_BILLING_VARS="$PLAIN_VARS --var ACCOUNTS_DEV_MODE:1 --var LOCK_API_BASE: --var STRIPE_PRICE_UNLIMITED_YEARLY:price_fake_unl_yearly \
--var STRIPE_PRICE_UNLIMITED_MONTHLY:price_fake_unl_monthly"
  STRIPE_VARS="--var STRIPE_SECRET_KEY:fake-stripe-key --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret \
--var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly \
--var STRIPE_API_BASE:http://127.0.0.1:$FAKE_PORT/stripe"
  TESTKEY_VARS="$PLAIN_VARS --var ACCOUNTS_DEV_MODE:0 --var LOCK_API_BASE:http://127.0.0.1:$FAKE_PORT/lockfake \
--var STRIPE_SECRET_KEY:sk_test_fake --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret"
}

# ---------------------------------------------------------------- results
# Suites run in separate processes: each writes its one line, name|RESULT|checks|log, to its own file in
# $RUN_DIR/.res, and the table reads them back in SUITES order.
RES_FILE=/dev/null
record() { echo "$1|$2|$3|$4" > "$RES_FILE"; return 0; }
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
  [ "$res" = FAIL ] && tail -5 "$log" | sed 's/^/        | /'
  record "$name" "$res" "$(checks_in "$log")" "$log"
}

# ---------------------------------------------------------------- one suite
run_one() {   # run_one NAME SETUP INDEX
  local name="$1" setup="$2" log="$RUN_DIR/$name.log" persist base nokeys testkey fbport
  case "$setup" in SKIP:*)
    printf '  %-4s %-20s %s\n' SKIP "$name" "${setup#SKIP: }"
    record "$name" SKIP - "${setup#SKIP: }"; return ;;
  esac
  reset_ports "$3"
  persist=$(mktemp -d "$RUN_DIR/persist-$name.XXXX")
  case "$name" in
    stripe-unit|collector|site|headers|ics-safety)
      run_node "$name" "$log" "$CF" "$NODE" "test/$name.test.mjs" ;;
    sync|stress|phase3|firebase-sync|cloud-service|waitlist|hardening|view-socket|previews-tz|archive|backup)
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $PLAIN_VARS || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
    db-archive)
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $PLAIN_VARS --var ARCHIVE_CHUNK:3 --test-scheduled || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
    copyback)
      take_port fbport || { record "$name" FAIL - "no port for the fake Firebase"; return; }
      start_wrangler "$name" "$persist" --var "COPY_BACK:test-cb-*" --var "FIREBASE_DB_URL:http://localhost:$fbport" \
        || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" FIREBASE_PORT="$fbport" \
        COPY_BACK_DELAY_MS="$COPY_BACK_DELAY_MS" "$NODE" "test/$name.test.mjs" ;;
    lock)
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $LOCK_VARS || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
    permissions|stats|restore|name-collision|exact-names|name-key)
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $PRO_VARS || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" PERSIST="$persist" IMPORT_SECRET="$SECRET" \
        RESTORE_MIN_GAP_MS="$RESTORE_MIN_GAP_MS" "$NODE" "test/$name.test.mjs" ;;
    accounts|welcome|pro-health|test-inbox|billing)
      take_port FAKE_PORT || { record "$name" FAIL - "no port for fake Stripe"; return; }; fake_stripe_vars
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
    trial|unlimited|handles)
      take_port FAKE_PORT || { record "$name" FAIL - "no port for fake Stripe"; return; }; fake_stripe_vars
      # shellcheck disable=SC2086
      start_wrangler "$name" "$persist" $REAL_BILLING_VARS $STRIPE_VARS || { record "$name" FAIL - "$RUN_DIR/wrangler-$name.log"; return; }
      run_node "$name" "$log" "$CF" BASE="$LAST_BASE" FAKE_PORT="$FAKE_PORT" IMPORT_SECRET="$SECRET" "$NODE" "test/$name.test.mjs" ;;
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

# ---------------------------------------------------------------- run
# Up to JOBS suites at once, each in its own background process that stops its own wranglers (and is
# stopped by this one on Ctrl-C). With -j > 1 the slowest start first, so the longest never starts last.
SLOW_FIRST="restore copyback cloud-service billing trial unlimited handles accounts"
mkdir -p "$RUN_DIR/.res"
echo "pastecal test-all  (logs: $RUN_DIR, $JOBS at a time, ports $TEST_PORT_BASE+)"
idx=0
ORDERED=""   # lines idx|name|setup, in launch order
while IFS='|' read -r name setup; do
  [ -z "$name" ] && continue
  idx=$((idx + 1))
  wanted "$name" || continue
  ORDERED="$ORDERED$idx|$name|$setup
"
done <<EOF_SUITES
$SUITES
EOF_SUITES
if [ "$JOBS" -gt 1 ]; then
  first=""
  for n in $SLOW_FIRST; do
    line=$(printf '%s' "$ORDERED" | grep "^[0-9]*|$n|")
    [ -n "$line" ] && first="$first$line
"
  done
  rest=$(printf '%s' "$ORDERED" | while IFS='|' read -r i n st; do
    case " $SLOW_FIRST " in *" $n "*) ;; *) echo "$i|$n|$st" ;; esac
  done)
  ORDERED="$first$rest"
fi

trap 'echo; echo "interrupted"; for p in $(jobs -p); do kill "$p" 2>/dev/null; done; wait; exit 130' INT TERM
while IFS='|' read -r idx name setup; do
  [ -z "$name" ] && continue
  while [ "$(jobs -pr | wc -l)" -ge "$JOBS" ]; do sleep 0.2; done
  (
    trap cleanup EXIT
    trap 'exit 143' INT TERM
    RES_FILE="$RUN_DIR/.res/$(printf '%03d' "$idx")"
    record "$name" FAIL - "did not finish"   # replaced by the real result
    run_one "$name" "$setup" "$idx"
  ) &
done <<EOF_ORDER
$ORDERED
EOF_ORDER
wait

# ---------------------------------------------------------------- table
END_TS=$(date +%s)
echo
printf '%-20s | %-6s | %-6s | %s\n' SUITE RESULT CHECKS "LOG PATH"
printf '%-20s-+-%-6s-+-%-6s-+-%s\n' "--------------------" "------" "------" "--------"
FAILED=0 NPASS=0 NFAIL=0 NSKIP=0
for f in "$RUN_DIR"/.res/*; do
  [ -f "$f" ] || continue
  IFS='|' read -r n r c l < "$f"
  printf '%-20s | %-6s | %-6s | %s\n' "$n" "$r" "$c" "$l"
  case "$r" in PASS) NPASS=$((NPASS + 1)) ;; SKIP) NSKIP=$((NSKIP + 1)) ;; *) NFAIL=$((NFAIL + 1)); FAILED=1 ;; esac
done
echo
echo "suites: $NPASS passed, $NFAIL failed, $NSKIP skipped"
echo "total: $((END_TS - START_TS))s   logs: $RUN_DIR"
if [ "$FAILED" = 1 ] || [ $((NPASS + NFAIL + NSKIP)) -eq 0 ]; then echo "SOME SUITES FAILED"; exit 1; fi
echo "all run suites passed"
exit 0
