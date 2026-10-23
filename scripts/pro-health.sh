#!/usr/bin/env bash
# pastecal Pro daily health check: GET /api/admin/pro/health and print a readable summary.
#
# Usage:
#   scripts/pro-health.sh                                  # https://pastecal.com, secret from gcloud
#   scripts/pro-health.sh --base http://localhost:8787     # a local `wrangler dev`
#   scripts/pro-health.sh --json                           # print the raw report too
#
# The admin secret comes from PRO_HEALTH_SECRET if set (local: dev-secret), otherwise from
#   gcloud secrets versions access latest --secret=CLOUDFLARE_IMPORT_SECRET --project pastecal-web
# It is never echoed: curl reads the Authorization header from stdin, so it isn't in `ps` either.
#
# Read-only: one GET. Exit code 0 when healthy, 1 when there are mismatches (paid but not locked,
# locked but not paid, paid for a calendar that doesn't exist), calendars it could not reach, or
# the request failed; 2 on usage.
# Needs bash 3.2+, curl, python3.

set -u

BASE="https://pastecal.com"
RAW=0
while [ $# -gt 0 ]; do
    case "$1" in
        --base) BASE="${2%/}"; shift 2 ;;
        --json) RAW=1; shift ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1 (see --help)"; exit 2 ;;
    esac
done
command -v curl >/dev/null || { echo "need curl"; exit 2; }
command -v python3 >/dev/null || { echo "need python3"; exit 2; }

SECRET="${PRO_HEALTH_SECRET:-}"
if [ -z "$SECRET" ]; then
    command -v gcloud >/dev/null || { echo "need gcloud (or set PRO_HEALTH_SECRET)"; exit 2; }
    SECRET="$(gcloud secrets versions access latest --secret=CLOUDFLARE_IMPORT_SECRET --project pastecal-web 2>/dev/null)" || SECRET=""
    [ -n "$SECRET" ] || { echo "could not read CLOUDFLARE_IMPORT_SECRET from gcloud"; exit 1; }
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pro-health.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
CODE="$(printf 'Authorization: Bearer %s\n' "$SECRET" | curl -sS -m 60 -o "$TMP/body" -w '%{http_code}' -H @- "$BASE/api/admin/pro/health")" || CODE="000"
unset SECRET

if [ "$CODE" != "200" ]; then
    echo "pro health: request failed (HTTP $CODE) at $BASE/api/admin/pro/health"
    [ "$CODE" = "403" ] && echo "  the admin secret was refused"
    exit 1
fi
[ "$RAW" = 1 ] && { cat "$TMP/body"; echo; }

python3 - "$TMP/body" "$BASE" <<'PY'
import json, sys, datetime
r = json.load(open(sys.argv[1]))
print(f"pastecal Pro health  {sys.argv[2]}  {datetime.datetime.fromtimestamp(r['at'] / 1000):%Y-%m-%d %H:%M}")
subs = r.get('subscriptions', {})
print("subscriptions: " + (", ".join(f"{k} {v}" for k, v in sorted(subs.items())) or "none"))
c = r.get('calendars', {})
print(f"calendars checked: {c.get('checked', 0)} of {c.get('total', 0)}" + ("  (capped: the rest were not checked)" if c.get('capped') else ""))
s = r.get('signIn24h', {})
issued, used = s.get('issued', 0), s.get('consumed', 0)
print(f"sign-in links, last 24h: {issued} sent, {used} used" + (f" ({round(100 * used / issued)}%)" if issued else ""))
words = {'paid-not-locked': 'paid, not locked by its owner', 'locked-not-paid': 'locked, but no active subscription',
         'no-calendar': 'paid, but the calendar does not exist'}
mm = r.get('mismatches', [])
if mm:
    print(f"\nMISMATCHES ({len(mm)}):")
    for m in mm:
        extra = " (locked by someone else)" if m.get('lockedByOther') else ""
        print(f"  {m['calendarId']}: {words.get(m['kind'], m['kind'])}{extra}  [{m['status']}, {m['subscriptionId']}]")
un = r.get('unchecked', [])
if not mm:
    print("\nno mismatches" + (" among the calendars it could reach" if un else ""))
if un:
    print(f"\ncould not reach {len(un)} calendar(s): " + ", ".join(f"{u['calendarId']} (HTTP {u.get('httpStatus')})" for u in un))
if r.get('notChecked'):
    print(f"note: {r['notChecked']}")
sys.exit(1 if mm or un else 0)
PY
