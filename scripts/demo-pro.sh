#!/usr/bin/env bash
# A local "test Pro account" for pastecal: wrangler dev on :8970 + the fake Stripe, seeded with every
# Pro state (paid owner + editor links, trial, Pro ended/paused, free). Local only: Firebase off, Stripe
# faked, its own state in ~/.pastecal-demo-state. Never preview, production or real Stripe.
#
#   bash scripts/demo-pro.sh            start (seeds on the first run), print the links; Ctrl-C stops
#   bash scripts/demo-pro.sh --reset    wipe the demo state and seed again
#   bash scripts/demo-pro.sh link       a fresh one-time owner sign-in link (demo must be running)
#
# Docs: docs/DEMO-PRO.md
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${DEMO_STATE:-$HOME/.pastecal-demo-state}"
if [ ! -x "$ROOT/cloudflare/node_modules/.bin/wrangler" ]; then
  echo "cloudflare/node_modules is missing: run (cd cloudflare && npm install) first." >&2; exit 1
fi
case "${1:-}" in
  link) exec node "$ROOT/scripts/demo-pro.mjs" link ;;
  --reset)
    if curl -s -o /dev/null --max-time 2 "http://localhost:${DEMO_PORT:-8970}/robots.txt"; then
      echo "The demo is running: stop it (Ctrl-C) before --reset." >&2; exit 1
    fi
    case "$STATE" in */.pastecal-demo-state*) rm -rf "$STATE" ;; *) echo "Refusing to delete $STATE" >&2; exit 1 ;; esac
    echo "Demo state wiped." ;;
  "") ;;
  *) echo "usage: bash scripts/demo-pro.sh [--reset|link]" >&2; exit 2 ;;
esac
exec node "$ROOT/scripts/demo-pro.mjs"
