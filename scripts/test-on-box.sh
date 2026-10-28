#!/usr/bin/env bash
# Tests on the omarchy box (16 cores, idle) instead of this Mac: copies this checkout there, installs what
# changed, runs the tests, prints the summary, and exits with the tests' status.
#   bash scripts/test-on-box.sh [spec names...]        browser journeys (scripts/test-browser.sh), e.g.
#                                                      bash scripts/test-on-box.sh series-data native-editing
#   bash scripts/test-on-box.sh --worker [args...]     Worker suites (scripts/test-all.sh -j 16 [args]), e.g. --only sync,lock
#   bash scripts/test-on-box.sh --sync-only            copy and install only;  --no-sync  skips that step
#                                                      (scripts/gate.sh copies once, then runs both kinds at once)
# Each checkout gets its own folder and ports on the box, so parallel agents don't collide. BOX_WORKERS Playwright
# workers (default 16, one per core) share BOX_SERVERS local servers (default 4); BOX_JOBS Worker suites run at once
# (default 16).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=$(basename "$ROOT")
DEST="Projects/pastecal-ci-$NAME"
SUM=$(printf '%s' "$NAME" | cksum | cut -d' ' -f1)
PORT=$((8900 + SUM % 80))
MODE=browser SYNC=1
while [ $# -gt 0 ]; do
  case "$1" in
    --worker) MODE=worker ;;
    --sync-only) MODE=none ;;
    --no-sync) SYNC=0 ;;
    *) break ;;
  esac
  shift
done
if [ "$SYNC" = 1 ]; then
  rsync -az --delete --exclude node_modules --exclude .wrangler --exclude cloudflare/test-results --exclude test/native-audit/out \
    --exclude .cloudflare --exclude snapshots "$ROOT/" "omarchy:$DEST/" || { echo "rsync to omarchy failed"; exit 2; }
fi
ssh -o BatchMode=yes omarchy bash -s -- "$DEST" "$PORT" "${BOX_WORKERS:-16}" "${BOX_SERVERS:-4}" "$MODE" "$SYNC" "${BOX_JOBS:-16}" "$@" <<'EOF'
set -u
DEST=$1 PORT=$2 WORKERS=$3 SERVERS=$4 MODE=$5 SYNC=$6 JOBS=$7; shift 7
cd ~/"$DEST" || exit 2
export PATH="$(mise where node@22)/bin:$PATH"
# Reinstall only when a lockfile changed since the last install here.
if [ "$SYNC" = 1 ]; then
  for d in . cloudflare functions; do
    if [ ! -d "$d/node_modules" ] || ! cmp -s "$d/package-lock.json" "$d/node_modules/.lock-copy"; then
      (cd "$d" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && cp package-lock.json node_modules/.lock-copy)
    fi
  done
fi
S=$(date +%s)
case "$MODE" in
  none) exit 0 ;;
  worker)
    NODE=$(which node) bash scripts/test-all.sh -j "$JOBS" "$@" > /tmp/pc-ci-w$PORT.log 2>&1
    RC=$?
    echo "took $(( $(date +%s) - S ))s on omarchy (log: omarchy:/tmp/pc-ci-w$PORT.log)"
    sed -n '/^SUITE /,$p' /tmp/pc-ci-w$PORT.log
    exit $RC ;;
esac
NODE=$(which node) PW_WORKERS=$WORKERS PW_SERVERS=$SERVERS bash scripts/test-browser.sh "$PORT" "$@" > /tmp/pc-ci-$PORT.log 2>&1
RC=$?
echo "took $(( $(date +%s) - S ))s on omarchy (log: omarchy:/tmp/pc-ci-$PORT.log)"
grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|✘|Error:" /tmp/pc-ci-$PORT.log | tail -30
exit $RC
EOF
