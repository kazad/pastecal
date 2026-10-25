#!/usr/bin/env bash
# Quick production deploy for an ordinary code update. No questions.
#
#   bash scripts/deploy.sh
#
# Refuses unless: this is launch-prep, nothing tracked is uncommitted, and the code is exactly the commit
# that passed the tests (TESTED_CODE in scripts/launch.sh). Then it deploys to pastecal-sync, waits for the
# edge, runs the curl smoke test and the browser smoke test, and prints how to roll back.
# Billing, secrets and Stripe are untouched (that is launch.sh). Notes go to ~/pastecal-deploy-<time>.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
WORKER=pastecal-sync
LOG="$HOME/pastecal-deploy-$(date +%Y%m%d-%H%M%S).log"
G=$'\033[32m'; R=$'\033[31m'; N=$'\033[0m'
ok()  { echo "  ${G}ok${N}  $*"; echo "$(date +%T) ok $*" >>"$LOG"; }
die() { echo "  ${R}XX${N}  $*"; echo "$(date +%T) stop $*" >>"$LOG"; exit 1; }
wr()  { (cd "$ROOT/cloudflare" && node node_modules/.bin/wrangler "$@"); }

cd "$ROOT"
[ "$(git rev-parse --abbrev-ref HEAD)" = "launch-prep" ] || die "not on launch-prep"
git diff --quiet && git diff --cached --quiet || die "uncommitted changes to tracked files"
TESTED="$(grep -Eo '^TESTED_CODE="[0-9a-f]+"' scripts/launch.sh | cut -d'"' -f2)"
[ -n "$TESTED" ] || die "no TESTED_CODE in scripts/launch.sh"
git merge-base --is-ancestor "$TESTED" HEAD || die "HEAD does not contain the tested commit $TESTED"
git diff --quiet "$TESTED" HEAD -- cloudflare/src cloudflare/wrangler.jsonc public \
    || die "the code differs from the tested commit $TESTED: run the tests and update TESTED_CODE"
ok "code is the tested commit $TESTED (HEAD $(git rev-parse --short HEAD))"

PREV="$(wr deployments list --name "$WORKER" 2>/dev/null | grep -Eo 'Version\(s\):.*|[0-9a-f]{8}-[0-9a-f-]{27}' | grep -Eo '[0-9a-f]{8}-[0-9a-f-]{27}' | tail -1)"
echo "  live version before: ${PREV:-unknown}"; echo "$(date +%T) before ${PREV:-unknown}" >>"$LOG"

out="$(wr deploy --env="" --message "deploy.sh: launch-prep $(git rev-parse --short HEAD)" 2>&1)"; rc=$?
tail -6 <<<"$out"
[ $rc -eq 0 ] || die "deploy failed (production is unchanged unless the output says otherwise)"
NEW="$(grep -Eo 'Current Version ID: [0-9a-f-]+' <<<"$out" | awk '{print $4}')"
ok "deployed ${NEW:-<see output>}"
echo "  waiting 15 s for the edge..."; sleep 15

fail=0
bash scripts/pro-smoke.sh --expect-deployed >/tmp/pastecal-deploy-smoke.txt 2>&1 && ok "curl smoke passed" || { fail=1; tail -15 /tmp/pastecal-deploy-smoke.txt; }
node scripts/launch-smoke.mjs --base https://pastecal.com --billing any >/tmp/pastecal-deploy-browser.txt 2>&1 && ok "browser smoke passed" || { fail=1; grep -E "FAIL" /tmp/pastecal-deploy-browser.txt; }

echo
if [ $fail -eq 0 ]; then
    echo "  ${G}Done.${N} pastecal.com runs $(git rev-parse --short HEAD) (version ${NEW:-?})."
else
    echo "  ${R}Smoke checks failed.${N} Read them above. To go back to the previous version:"
fi
echo "  Roll back: cd $ROOT/cloudflare && npx wrangler rollback ${PREV:-<version>} --name $WORKER"
echo "  Notes: $LOG"
exit $fail
