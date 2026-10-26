#!/usr/bin/env bash
# Browser journeys on the omarchy box (16 cores, idle) instead of this Mac: copies this checkout there, installs
# what changed, runs scripts/test-browser.sh, prints the summary.
#   bash scripts/test-on-box.sh [spec names...]        e.g.  bash scripts/test-on-box.sh series-data native-editing
# Each checkout gets its own folder and ports on the box, so parallel agents don't collide. BOX_WORKERS Playwright
# workers (default 16, one per core) share BOX_SERVERS local servers (default 4).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=$(basename "$ROOT")
DEST="Projects/pastecal-ci-$NAME"
PORT=$((8900 + $(printf '%s' "$NAME" | cksum | cut -d' ' -f1) % 80))
rsync -az --delete --exclude node_modules --exclude .wrangler --exclude cloudflare/test-results --exclude test/native-audit/out \
  --exclude .cloudflare --exclude snapshots "$ROOT/" "omarchy:$DEST/" || { echo "rsync to omarchy failed"; exit 2; }
ssh -o BatchMode=yes omarchy bash -s -- "$DEST" "$PORT" "${BOX_WORKERS:-16}" "${BOX_SERVERS:-4}" "$@" <<'EOF'
set -u
DEST=$1 PORT=$2 WORKERS=$3 SERVERS=$4; shift 4
cd ~/"$DEST" || exit 2
export PATH="$(mise where node@22)/bin:$PATH"
# Reinstall only when a lockfile changed since the last install here.
for d in . cloudflare functions; do
  if [ ! -d "$d/node_modules" ] || ! cmp -s "$d/package-lock.json" "$d/node_modules/.lock-copy"; then
    (cd "$d" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && cp package-lock.json node_modules/.lock-copy)
  fi
done
S=$(date +%s)
NODE=$(which node) PW_WORKERS=$WORKERS PW_SERVERS=$SERVERS bash scripts/test-browser.sh "$PORT" "$@" > /tmp/pc-ci-$PORT.log 2>&1
echo "took $(( $(date +%s) - S ))s on omarchy (log: omarchy:/tmp/pc-ci-$PORT.log)"
grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|✘|Error:" /tmp/pc-ci-$PORT.log | tail -30
EOF
