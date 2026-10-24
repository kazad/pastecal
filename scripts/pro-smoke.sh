#!/usr/bin/env bash
# pastecal Pro smoke test: read-only checks against the live site, run after every deploy.
#
# Usage:
#   scripts/pro-smoke.sh                          # against https://pastecal.com
#   scripts/pro-smoke.sh --expect-deployed        # Pro routes MUST answer (use after the Pro deploy)
#   scripts/pro-smoke.sh --expect-billing         # also fail if billing answers 503 (after the secrets are set)
#   scripts/pro-smoke.sh --with-email you@example.com   # also POST /api/auth/start (SENDS a real sign-in email)
#   scripts/pro-smoke.sh --base http://localhost:8787 --calendar mycal --view-slug myview
#
# What it sends: GETs, plus POSTs that cannot change anything (no session, wrong Origin, bad
# Stripe signature). It never calls /api/auth/start unless --with-email is given, never sends a
# session cookie or the admin secret, and never creates a calendar.
#
# Results: PASS, FAIL, or NOT-DEPLOYED (a Pro route answered like the pre-Pro site: HTML / 405).
# NOT-DEPLOYED does not fail the run unless --expect-deployed is passed.
# Exit code: 0 when nothing failed, 1 otherwise. Needs bash 3.2+, curl, python3.

set -u

BASE="https://pastecal.com"
CAL="test"          # an existing edit calendar (lookup: isReadOnly false)
VIEW="demo"         # an existing view-only name (lookup: isReadOnly true)
EMAIL=""
EXPECT_DEPLOYED=0
EXPECT_BILLING=0
ORIGIN="https://pastecal.com"

while [ $# -gt 0 ]; do
    case "$1" in
        --base) BASE="${2%/}"; shift 2 ;;
        --calendar) CAL="$2"; shift 2 ;;
        --view-slug) VIEW="$2"; shift 2 ;;
        --with-email) EMAIL="$2"; shift 2 ;;
        --expect-deployed) EXPECT_DEPLOYED=1; shift ;;
        --expect-billing) EXPECT_BILLING=1; EXPECT_DEPLOYED=1; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)"; exit 2 ;;
    esac
done

# A deployed site (https) trusts only its own origin, so preview.pastecal.com must send its own.
case "$BASE" in https://*) ORIGIN="$BASE" ;; esac

command -v curl >/dev/null || { echo "need curl"; exit 2; }
command -v python3 >/dev/null || { echo "need python3"; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pro-smoke.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
ROWS="$TMP/rows"; : > "$ROWS"
NPASS=0; NFAIL=0; NND=0

# record RESULT NAME DETAIL
record() {
    local res="$1"
    if [ "$res" = "NOT-DEPLOYED" ] && [ "$EXPECT_DEPLOYED" = 1 ]; then res="FAIL"; fi
    case "$res" in
        PASS) NPASS=$((NPASS + 1)) ;;
        FAIL) NFAIL=$((NFAIL + 1)) ;;
        NOT-DEPLOYED) NND=$((NND + 1)) ;;
    esac
    printf '%s\t%s\t%s\n' "$res" "$2" "$3" >> "$ROWS"
}

# req METHOD PATH [extra curl args...]  -> sets CODE, CTYPE; body in $TMP/body
req() {
    local method="$1" path="$2"; shift 2
    local out
    out="$(curl -sS -m 20 -X "$method" -o "$TMP/body" -w '%{http_code} %{content_type}' "$@" "$BASE$path" 2>"$TMP/err")" || out="000 curl-error"
    CODE="${out%% *}"
    CTYPE="${out#* }"
}

is_json() { case "$CTYPE" in *application/json*) return 0 ;; *) return 1 ;; esac; }
is_html() { case "$CTYPE" in *text/html*) return 0 ;; *) return 1 ;; esac; }

# jget EXPR: evaluate a python expression against the JSON body as `j` (prints "" on any error)
jget() { python3 - "$1" "$TMP/body" <<'PY' 2>/dev/null
import json, sys
try:
    j = json.load(open(sys.argv[2]))
    v = eval(sys.argv[1], {"j": j})
    print(v if not isinstance(v, (dict, list)) else json.dumps(v, sort_keys=True))
except Exception:
    print("")
PY
}

title() { python3 -c 'import re,sys; m=re.search(r"<title>([^<]*)</title>", open(sys.argv[1], encoding="utf-8", errors="replace").read()); print(m.group(1).strip() if m else "")' "$TMP/body"; }

# A Pro API route that answers like the pre-Pro site (HTML SPA fallback, or 405 from static assets).
not_deployed() { is_html || { [ "$CODE" = 405 ] && ! is_json; }; }

HOME_TITLE="pastecal: A shared calendar in one link"

# --- 1. Pages --------------------------------------------------------------------------------
# The assets use the single-page-app fallback: a missing page is 200 with the homepage, so the
# title is what proves the right page was served.
check_page() { # path expected-title is-pro-page
    req GET "$1"
    local t; t="$(title)"
    if [ "$CODE" = 200 ] && [ "$t" = "$2" ]; then record PASS "page $1" "200, \"$t\""
    elif [ "$3" = 1 ] && [ "$CODE" = 200 ] && [ "$t" = "$HOME_TITLE" ]; then record NOT-DEPLOYED "page $1" "200 but serves the homepage (SPA fallback)"
    else record FAIL "page $1" "HTTP $CODE, title \"$t\" (want \"$2\")"; fi
}
check_page /         "$HOME_TITLE"            0
check_page /pricing  "Pricing · pastecal"     0
check_page /signin   "Sign in · pastecal"     1
check_page /pro/done "Pro is on · pastecal"   1

# --- 2. /api/pro/status reveals only {isOwner, locked, pro} ------------------------------------
req GET "/api/pro/status?calendar=$CAL"
if not_deployed; then record NOT-DEPLOYED "GET /api/pro/status" "HTTP $CODE $CTYPE"
elif [ "$CODE" = 200 ] && is_json && [ "$(jget 'sorted(j.keys())')" = '["isOwner", "locked", "pro"]' ]; then
    record PASS "GET /api/pro/status" "200, keys exactly isOwner/locked/pro ($(jget 'j'))"
else record FAIL "GET /api/pro/status" "HTTP $CODE, body $(head -c 160 "$TMP/body")"; fi

# --- 3. /api/me without a cookie is 401 ------------------------------------------------------
req GET /api/me
if not_deployed; then record NOT-DEPLOYED "GET /api/me (no cookie)" "HTTP $CODE $CTYPE"
elif [ "$CODE" = 401 ] && is_json; then record PASS "GET /api/me (no cookie)" "401 $(jget 'j.get("error")')"
else record FAIL "GET /api/me (no cookie)" "HTTP $CODE (want 401), body $(head -c 120 "$TMP/body")"; fi

# --- 4. CSRF: a cookie route POSTed without our Origin is refused ------------------------------
req POST /api/pro/checkout -H 'Content-Type: application/json' --data '{"calendarId":"'"$CAL"'"}'
if not_deployed; then record NOT-DEPLOYED "POST /api/pro/checkout (no Origin)" "HTTP $CODE $CTYPE"
elif [ "$CODE" = 403 ] && [ "$(jget 'j.get("error")')" = forbidden-origin ]; then record PASS "POST /api/pro/checkout (no Origin)" "403 forbidden-origin"
else record FAIL "POST /api/pro/checkout (no Origin)" "HTTP $CODE (want 403 forbidden-origin)"; fi

# --- 5. Checkout / portal without a session: 401 when billing is on, 503 when it is off ---------
BILLING="unknown"
billing_check() { # path name
    req POST "$1" -H 'Content-Type: application/json' -H "Origin: $ORIGIN" --data '{"calendarId":"'"$CAL"'"}'
    local err; err="$(jget 'j.get("error")')"
    if not_deployed; then record NOT-DEPLOYED "$2" "HTTP $CODE $CTYPE"
    elif [ "$CODE" = 401 ] && [ "$err" = signed-out ]; then BILLING="on"; record PASS "$2" "401 signed-out (billing configured)"
    elif [ "$CODE" = 503 ] && [ "$err" = billing-not-configured ]; then
        BILLING="off"
        if [ "$EXPECT_BILLING" = 1 ]; then record FAIL "$2" "503 billing-not-configured (secrets missing)"
        else record PASS "$2" "503 billing-not-configured (billing OFF)"; fi
    else record FAIL "$2" "HTTP $CODE $err (want 401 signed-out or 503 billing-not-configured)"; fi
}
billing_check /api/pro/checkout "POST /api/pro/checkout (no session)"
billing_check /api/pro/portal   "POST /api/pro/portal (no session)"

# --- 6. Stripe webhook with a bad signature: 400 (503 while billing is off) ---------------------
req POST /api/stripe/webhook -H 'Content-Type: application/json' -H "Stripe-Signature: t=$(date +%s),v1=0000" --data '{"id":"evt_smoke","type":"ping"}'
werr="$(jget 'j.get("error")')"
if not_deployed; then record NOT-DEPLOYED "POST /api/stripe/webhook (bad sig)" "HTTP $CODE $CTYPE"
elif [ "$CODE" = 400 ] && [ "$werr" = invalid-signature ]; then record PASS "POST /api/stripe/webhook (bad sig)" "400 invalid-signature ($(jget 'j.get("reason")'))"
elif [ "$CODE" = 503 ] && [ "$werr" = billing-not-configured ]; then
    if [ "$EXPECT_BILLING" = 1 ]; then record FAIL "POST /api/stripe/webhook (bad sig)" "503 billing-not-configured"
    else record PASS "POST /api/stripe/webhook (bad sig)" "503 billing-not-configured (signature not checked while billing is off)"; fi
else record FAIL "POST /api/stripe/webhook (bad sig)" "HTTP $CODE $werr (want 400 invalid-signature)"; fi

# --- 7. A view-only lookup never reveals the edit name ------------------------------------------
req GET "/api/lookup?slug=$VIEW"
if [ "$CODE" = 200 ] && is_json; then
    if [ "$(jget 'j.get("isReadOnly")')" != True ]; then record FAIL "GET /api/lookup?slug=$VIEW" "not a view-only name; pass --view-slug <view-only name>"
    elif [ "$(jget '"targetId" in j')" = False ]; then record PASS "GET /api/lookup?slug=$VIEW" "view-only, no targetId ($(jget 'j'))"
    else record FAIL "GET /api/lookup?slug=$VIEW" "LEAKS targetId: $(jget 'j')"; fi
else record FAIL "GET /api/lookup?slug=$VIEW" "HTTP $CODE $CTYPE"; fi

# --- 8. Admin routes without the secret are 403 ---------------------------------------------------
# Body must be exactly "forbidden" (the Worker's answer), so a WAF/bot-challenge 403 can't pass.
admin_check() { # method path name [curl args]
    local m="$1" p="$2" n="$3"; shift 3
    req "$m" "$p" "$@"
    local body; body="$(head -c 40 "$TMP/body")"
    if [ "$CODE" = 403 ] && [ "$body" = forbidden ]; then record PASS "$n" "403 forbidden"
    elif not_deployed; then record NOT-DEPLOYED "$n" "HTTP $CODE $CTYPE"
    else record FAIL "$n" "HTTP $CODE body \"$body\" (want 403 forbidden)"; fi
}
admin_check GET  "/api/admin/cal/$CAL/lock-status" "GET admin lock-status (no secret)"
admin_check POST "/api/admin/cal/$CAL/unlock" "POST admin unlock (wrong secret)" -H 'Authorization: Bearer not-the-secret' -H 'Content-Type: application/json' --data '{}'
admin_check GET  "/api/admin/accounts/lookup?email=nobody%40example.com" "GET admin accounts/lookup (no secret)"

# --- 9. Optional: a real sign-in email ---------------------------------------------------------
if [ -n "$EMAIL" ]; then
    payload="$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1]}))' "$EMAIL")"
    req POST /api/auth/start -H 'Content-Type: application/json' -H "Origin: $ORIGIN" --data "$payload"
    if not_deployed; then record NOT-DEPLOYED "POST /api/auth/start ($EMAIL)" "HTTP $CODE $CTYPE"
    elif [ "$CODE" = 200 ] && [ "$(jget 'j.get("ok")')" = True ]; then record PASS "POST /api/auth/start ($EMAIL)" "200 ok -- now check that inbox (and spam) for the link from login@pastecal.com"
    else record FAIL "POST /api/auth/start ($EMAIL)" "HTTP $CODE $(head -c 120 "$TMP/body")"; fi
else
    printf '%s\t%s\t%s\n' "SKIP" "POST /api/auth/start" "would send an email; pass --with-email you@example.com" >> "$ROWS"
fi

# --- Report -------------------------------------------------------------------------------------
echo "pastecal Pro smoke test: $BASE  ($(date -u '+%Y-%m-%d %H:%M UTC'))"
echo
python3 - "$ROWS" <<'PY'
import sys
rows = [l.rstrip("\n").split("\t", 2) for l in open(sys.argv[1]) if l.strip()]
w1 = max([6] + [len(r[0]) for r in rows]); w2 = max([5] + [len(r[1]) for r in rows])
print(f"{'RESULT':<{w1}}  {'CHECK':<{w2}}  DETAIL")
print(f"{'-'*w1}  {'-'*w2}  {'-'*6}")
for r in rows:
    print(f"{r[0]:<{w1}}  {r[1]:<{w2}}  {r[2]}")
PY
echo
echo "PASS $NPASS   FAIL $NFAIL   NOT-DEPLOYED $NND   billing: $BILLING"
if [ "$NND" -gt 0 ]; then echo "Pro is not deployed on $BASE yet (re-run with --expect-deployed after the Pro deploy)."; fi
[ "$NFAIL" -eq 0 ]
