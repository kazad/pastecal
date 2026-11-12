#!/usr/bin/env bash
# The whole pre-deploy test gate in one command, all three parts at once:
#   unit tests       here       (scripts/test-all.sh --only unit)
#   Worker suites    omarchy    (scripts/test-on-box.sh --worker: scripts/test-all.sh -j 16, every suite but unit)
#   browser journeys omarchy    (scripts/test-on-box.sh: scripts/test-browser.sh)
# then one summary with counts and times. Passes only when unit has 0 failures, every Worker suite passes, and the
# browser run has 0 failed (a test that passes on its retry is reported as flaky, as in test-browser.sh). A Worker
# suite or browser spec that fails under the full parallel load is run again alone; passing alone, it is reported
# as FLAKY and does not fail the gate (at most 5 are rerun: more than that is not load).
#
#   bash scripts/gate.sh             gate HEAD (the checkout as it is)
#   bash scripts/gate.sh --force     run even when this tree already passed
#   bash scripts/gate.sh --changed   only what the changes since origin/master (or GATE_BASE) touch: see below
#
# Reuse: after a full pass of a clean checkout, the tree hash (git rev-parse HEAD^{tree}) is recorded in
# <git common dir>/pastecal-gate-passed, shared by every worktree. Gating a commit with the same tree (say a
# launch-prep merge identical to pro) prints "already passed at <commit>" and exits 0. A different tree, or
# uncommitted changes, always runs; a --changed run is never recorded.
#
# --changed (for iterating, never before a deploy): from `git diff --name-only $GATE_BASE...HEAD` plus uncommitted
# files. A changed cloudflare/test/<name>.spec.js runs that spec; cloudflare/test/<name>.test.mjs runs that
# suite; test/** (unit) runs unit only. Anything else (app, Worker, scripts, config) runs everything.
# Logs: /tmp/pastecal-gate-<time>/.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 2
FORCE=0 CHANGED=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --changed) CHANGED=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a"; exit 2 ;;
  esac
done

TREE=$(git rev-parse 'HEAD^{tree}') COMMIT=$(git rev-parse --short HEAD)
PASSED="$(git rev-parse --git-common-dir)/pastecal-gate-passed"
DIRTY=$(git status --porcelain --untracked-files=normal | grep -v ' cloudflare/node_modules$' | head -1)
if [ "$FORCE" = 0 ] && [ "$CHANGED" = 0 ] && [ -z "$DIRTY" ] && [ -f "$PASSED" ]; then
  hit=$(grep "^$TREE " "$PASSED" | tail -1)
  if [ -n "$hit" ]; then
    set -- $hit
    echo "already passed at $2 ($3; tree $TREE): ${*:4}"
    echo "(bash scripts/gate.sh --force runs it again)"
    exit 0
  fi
fi

# ---- what to run
DO_UNIT=1 DO_WORKER=1 DO_BROWSER=1 SPECS="" SUITES=""
if [ "$CHANGED" = 1 ]; then
  base=${GATE_BASE:-origin/master}
  files=$( { git diff --name-only "$base...HEAD"; git status --porcelain | cut -c4-; } | sort -u)
  DO_UNIT=0 DO_WORKER=0 DO_BROWSER=0 all=0
  for f in $files; do
    case "$f" in
      cloudflare/test/*.spec.js) n=${f##*/}; SPECS="$SPECS ${n%.spec.js}"; DO_BROWSER=1 ;;
      cloudflare/test/*.test.mjs) n=${f##*/}; n=${n%.test.mjs}
        if bash scripts/test-all.sh --list | grep -q "^$n "; then SUITES="$SUITES,$n"; DO_WORKER=1; else all=1; fi ;;
      test/*) DO_UNIT=1 ;;
      cloudflare/node_modules) ;;
      *) all=1 ;;
    esac
  done
  if [ "$all" = 1 ]; then DO_UNIT=1 DO_WORKER=1 DO_BROWSER=1 SPECS="" SUITES=""; fi
  echo "--changed against $base: unit=$DO_UNIT worker=${DO_WORKER}${SUITES:+ (${SUITES#,})} browser=${DO_BROWSER}${SPECS:+ (${SPECS# })}"
fi

LOG="/tmp/pastecal-gate-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$LOG"
S0=$(date +%s)
echo "gate $COMMIT (tree ${TREE:0:12}${DIRTY:+, uncommitted changes}): logs $LOG"
if [ "$DO_WORKER$DO_BROWSER" != 00 ]; then
  bash scripts/test-on-box.sh --sync-only > "$LOG/sync.log" 2>&1 || { echo "copying to omarchy failed:"; cat "$LOG/sync.log"; exit 2; }
  echo "copied to omarchy in $(( $(date +%s) - S0 ))s"
fi

PIDS=""
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done; exit 130' INT TERM
part() {   # part NAME cmd...   runs in the background, writes LOG/NAME.log, .rc and .secs
  local name=$1; shift
  ( t=$(date +%s); "$@" > "$LOG/$name.log" 2>&1; rc=$?; echo $rc > "$LOG/$name.rc"; echo $(( $(date +%s) - t )) > "$LOG/$name.secs" ) &
  PIDS="$PIDS $!"
}
[ "$DO_UNIT" = 1 ] && part unit bash scripts/test-all.sh --only unit -j 1
# shellcheck disable=SC2086
[ "$DO_WORKER" = 1 ] && part worker bash scripts/test-on-box.sh --no-sync --worker --skip unit ${SUITES:+--only ${SUITES#,}}
# shellcheck disable=SC2086
[ "$DO_BROWSER" = 1 ] && part browser bash scripts/test-on-box.sh --no-sync $SPECS
wait

# ---- summary
OK=1 SUMMARY=""
rc_of() { cat "$LOG/$1.rc" 2>/dev/null || echo 99; }
line() { printf '  %-8s %-4s %4ss  %s\n' "$1" "$2" "$(cat "$LOG/$1.secs" 2>/dev/null || echo '?')" "$3"; SUMMARY="$SUMMARY $1: $3;"; }

# ---- a failure under full load gets one run alone: red must mean a regression, not a busy box
# (2026-11-11: archive, db-archive and restore failed with 16 suites and 24 Chromes running; all three passed alone.)
# A suite or spec that passes alone is reported as FLAKY and does not fail the gate; one that fails again does.
# More than 5 failures is not load, so those are not rerun.
W_FLAKY="" W_ALONE="" B_FLAKY="" B_ALONE=""
if [ "$DO_WORKER" = 1 ] && [ "$(rc_of worker)" != 0 ]; then
  wf=$(awk -F'|' '$2 ~ /FAIL/ {gsub(/ /, "", $1); print $1}' "$LOG/worker.log")
  n=$(echo "$wf" | grep -c .)
  if [ "$n" -ge 1 ] && [ "$n" -le 5 ]; then
    echo "worker suites that failed under load, run again one at a time: $(echo $wf)"
    BOX_JOBS=1 bash scripts/test-on-box.sh --no-sync --worker --only "$(echo $wf | tr ' ' ,)" > "$LOG/worker-alone.log" 2>&1
    for s in $wf; do
      if awk -F'|' -v s="$s" '{gsub(/ /, "", $1)} $1 == s && $2 ~ /PASS/ {ok = 1} END {exit !ok}' "$LOG/worker-alone.log"
      then W_FLAKY="$W_FLAKY $s"; else W_ALONE="$W_ALONE $s"; fi
    done
  fi
fi
if [ "$DO_BROWSER" = 1 ] && [ "$(rc_of browser)" != 0 ]; then
  # Playwright's closing summary lists what still failed after its own retry, under "N failed".
  bspecs=$(awk '/^ +[0-9]+ failed/ {f = 1; next} /^ +[0-9]+ (flaky|skipped|passed|did not run)/ {f = 0} f' "$LOG/browser.log" \
    | grep -Eo '[a-z0-9-]+\.spec\.js' | sed 's/\.spec\.js$//' | sort -u)
  n=$(echo "$bspecs" | grep -c .)
  if [ "$n" -ge 1 ] && [ "$n" -le 5 ]; then
    echo "browser specs that failed under load, run again on their own: $(echo $bspecs)"
    # shellcheck disable=SC2086
    if bash scripts/test-on-box.sh --no-sync $bspecs > "$LOG/browser-alone.log" 2>&1; then B_FLAKY=" $(echo $bspecs)"; else B_ALONE=" $(echo $bspecs)"; fi
  fi
fi
RED=""
echo
if [ "$DO_UNIT" = 1 ]; then
  ul=$(grep -Eo '/tmp/pastecal-test-all-[^ ,]*/unit.log' "$LOG/unit.log" | head -1)   # node --test's own output
  p=$(grep -Eo '^(ℹ|#) pass [0-9]+' "$ul" 2>/dev/null | grep -Eo '[0-9]+$' | tail -1)
  f=$(grep -Eo '^(ℹ|#) fail [0-9]+' "$ul" 2>/dev/null | grep -Eo '[0-9]+$' | tail -1)
  r=PASS; { [ "$(rc_of unit)" = 0 ] && [ "${f:-1}" = 0 ]; } || { r=FAIL; OK=0; RED="$RED unit"; }
  line unit $r "${p:-?} passed, ${f:-?} failed"
fi
if [ "$DO_WORKER" = 1 ]; then
  s=$(grep -E '^suites: ' "$LOG/worker.log" | tail -1 | sed 's/^suites: //')
  r=PASS; { [ "$(rc_of worker)" = 0 ] && echo "$s" | grep -q ' 0 failed'; } || r=FAIL
  [ "$r" = FAIL ] && [ -n "$W_FLAKY" ] && [ -z "$W_ALONE" ] && r=PASS   # every failure passed alone
  [ "$r" = FAIL ] && { OK=0; RED="$RED worker"; }
  line worker $r "suites ${s:-?}, $(awk -F'|' '$2 ~ /PASS/ && $3+0 > 0 {c += $3} END {print c+0}' "$LOG/worker.log") checks${W_FLAKY:+; FLAKY (failed under load, passed alone):$W_FLAKY}${W_ALONE:+; failed alone too:$W_ALONE}"
fi
if [ "$DO_BROWSER" = 1 ]; then
  cnt() { grep -Eo "^\s+[0-9]+ $1" "$LOG/browser.log" | grep -Eo '[0-9]+' | tail -1; }
  bp=$(cnt passed) bf=$(cnt failed) bk=$(cnt flaky) bs=$(cnt skipped)
  r=PASS; { [ "$(rc_of browser)" = 0 ] && [ -z "$bf" ] && [ -n "$bp" ]; } || r=FAIL
  [ "$r" = FAIL ] && [ -n "$B_FLAKY" ] && r=PASS   # every failed spec passed on its own
  [ "$r" = FAIL ] && { OK=0; RED="$RED browser"; }
  line browser $r "${bp:-0} passed, ${bf:-0} failed, ${bk:-0} flaky, ${bs:-0} skipped${B_FLAKY:+; FLAKY (failed under load, passed alone):$B_FLAKY}${B_ALONE:+; failed alone too:$B_ALONE}"
fi
T=$(( $(date +%s) - S0 ))
echo "  total         ${T}s"
for n in $RED; do
  echo; echo "---- $n (tail of $LOG/$n.log)"; tail -25 "$LOG/$n.log"
  [ -f "$LOG/$n-alone.log" ] && { echo "---- $n run alone (tail of $LOG/$n-alone.log)"; tail -15 "$LOG/$n-alone.log"; }
done
echo
if [ "$OK" = 1 ]; then
  if [ "$CHANGED" = 0 ] && [ -z "$DIRTY" ]; then
    echo "$TREE $COMMIT $(date +%Y-%m-%dT%H:%M)$SUMMARY" >> "$PASSED"
    echo "GATE PASSED ($COMMIT; recorded for tree ${TREE:0:12})"
  else
    echo "GATE PASSED ($COMMIT; not recorded: ${DIRTY:+uncommitted changes}${DIRTY:-a --changed run})"
  fi
  exit 0
fi
echo "GATE FAILED"
exit 1
