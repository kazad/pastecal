#!/usr/bin/env bash
# Sends a real pastecal sign-in email to the test inbox and checks how it arrived.
#
# Usage:
#   scripts/test-signin-email.sh [BASE_URL] [ADDRESS]
#     BASE_URL  default https://pastecal.com
#     ADDRESS   default test-signin@pastecal.com (must be a test inbox address routed to the Worker:
#               test@, test-signin@, test-welcome@ or test-weekly@pastecal.com; see docs/pro-launch.md)
#
# What it does: POST BASE_URL/api/auth/start {email: ADDRESS} (Origin: BASE_URL), then polls
# GET BASE_URL/api/admin/test-inbox?to=ADDRESS for up to 2 minutes for a message newer than the
# ones already there. Prints its subject, sender, SPF/DKIM/DMARC verdicts, and whether the sign-in
# link has the expected shape. It never prints the link or its token (the inbox stores the token
# redacted as [token:<length>] anyway).
#
# Admin secret: $PRO_HEALTH_SECRET if set, else
#   gcloud secrets versions access latest --secret=CLOUDFLARE_IMPORT_SECRET --project pastecal-web
# It is passed to curl on stdin (not in argv) and never echoed.
#
# Against production this sends one real email and uses up one of that address's sign-in emails
# (5 an hour, 10 a day per address). Exit code: 0 when the email arrived with a well-formed link
# and SPF, DKIM and DMARC all pass; 1 otherwise; 2 on a usage or setup problem.

set -u

BASE="${1:-https://pastecal.com}"; BASE="${BASE%/}"
ADDR="$(printf '%s' "${2:-test-signin@pastecal.com}" | tr '[:upper:]' '[:lower:]')"
WAIT_SECONDS=120

case "$ADDR" in
    test@pastecal.com|test-signin@pastecal.com|test-welcome@pastecal.com|test-weekly@pastecal.com) ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "not a test inbox address: $ADDR (use test@, test-signin@, test-welcome@ or test-weekly@pastecal.com)"; exit 2 ;;
esac
[ "$BASE" = "-h" ] || [ "$BASE" = "--help" ] && { sed -n '2,22p' "$0"; exit 0; }
command -v curl >/dev/null || { echo "need curl"; exit 2; }
command -v python3 >/dev/null || { echo "need python3"; exit 2; }

SECRET="${PRO_HEALTH_SECRET:-}"
if [ -z "$SECRET" ]; then
    SECRET="$(gcloud secrets versions access latest --secret=CLOUDFLARE_IMPORT_SECRET --project pastecal-web 2>/dev/null)" || SECRET=""
fi
[ -n "$SECRET" ] || { echo "no admin secret: set PRO_HEALTH_SECRET or sign in to gcloud"; exit 2; }

# GET the inbox for ADDR (newest first). The Authorization header goes in through curl's config on stdin.
inbox() {
    printf 'header = "Authorization: Bearer %s"\n' "$SECRET" | curl -sS -K - --max-time 15 \
        "$BASE/api/admin/test-inbox?to=$ADDR&limit=$1"
}

newest_id() {
    python3 -c 'import json,sys
d=json.load(sys.stdin)
print(d[0]["id"] if isinstance(d,list) and d else 0)' 2>/dev/null
}

BEFORE="$(inbox 1 | newest_id)" || BEFORE=""
case "$BEFORE" in ''|*[!0-9]*) echo "could not read the test inbox at $BASE (wrong secret, or not deployed?)"; exit 1 ;; esac

echo "Requesting a sign-in email for $ADDR from $BASE"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/api/auth/start" \
    -H 'Content-Type: application/json' -H "Origin: $BASE" --data "{\"email\":\"$ADDR\"}")"
[ "$CODE" = "200" ] || { echo "FAIL: /api/auth/start answered $CODE"; exit 1; }

START=$(date +%s)
while :; do
    BODY="$(inbox 5)"
    FOUND="$(printf '%s' "$BODY" | python3 -c 'import json,sys
before=int(sys.argv[1])
try: d=json.load(sys.stdin)
except Exception: d=[]
new=[m for m in d if isinstance(m,dict) and m.get("id",0)>before]
print("yes" if new else "no")' "$BEFORE")"
    [ "$FOUND" = "yes" ] && break
    if [ $(( $(date +%s) - START )) -ge $WAIT_SECONDS ]; then
        echo "FAIL: no new message for $ADDR within ${WAIT_SECONDS}s."
        echo "  Possible causes: the address's sign-in limit (5 an hour, 10 a day) was reached, so /api/auth/start"
        echo "  answered ok without sending; Email Sending is not set up; or no routing rule sends $ADDR to the Worker."
        exit 1
    fi
    sleep 5
done

# Report on the newest new message. Only booleans about the link are printed, never the link.
printf '%s' "$BODY" | python3 -c 'import json,re,sys
before=int(sys.argv[1])
m=[m for m in json.load(sys.stdin) if m.get("id",0)>before][0]
a=m.get("auth") or {}
text=m.get("text") or ""
links=re.findall(r"https?://\S+", text)
signin=[l for l in links if "/signin" in l]
shape=re.compile(r"^https://pastecal\.com/signin#t=\[token:22\]$")   # the inbox stores the token redacted
link_ok=len(signin)==1 and bool(shape.match(signin[0].rstrip(").,")))
no_query=all("?" not in l for l in signin)
print("Subject:      %s" % m.get("subject"))
print("From:         %s" % m.get("from"))
print("Received:     %s" % m.get("receivedAt"))
print("SPF:          %s" % a.get("spf"))
print("DKIM:         %s" % a.get("dkim"))
print("DMARC:        %s" % a.get("dmarc"))
print("DKIM-Signature header present: %s" % ("yes" if (m.get("headers") or {}).get("dkimSignature") else "no"))
print("Sign-in link: %s" % ("ok (https://pastecal.com/signin#t=<22-character token>)" if link_ok
    else "UNEXPECTED (%d sign-in link(s); expected one https://pastecal.com/signin#t=<token>, token in the fragment)" % len(signin)))
if not no_query: print("Sign-in link: has a query string (a token must never be in the query)")
auth_ok=all(a.get(k)=="pass" for k in ("spf","dkim","dmarc"))
ok=link_ok and no_query and auth_ok
print("PASS" if ok else "FAIL" + ("" if auth_ok else ": SPF, DKIM and DMARC must all be pass"))
sys.exit(0 if ok else 1)' "$BEFORE"
