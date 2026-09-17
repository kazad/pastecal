#!/usr/bin/env bash
# Check database.rules.json against the emulator, which enforces rules exactly as
# production does. The Admin SDK bypasses rules entirely, so the existing
# *.emulator.test.js files cannot cover this -- to them, a rule that denies
# everything and a rule that denies nothing look identical.
#
# Usage:
#   npx firebase emulators:start --only database --project pastecal-test &
#   ./scripts/test-rules.sh
#
# The emulator does not pick up database.rules.json for an unconfigured project,
# so this loads them explicitly first. Without that step every assertion below
# passes for the wrong reason: default-open rules allow the valid write AND
# everything it is supposed to refuse.
set -uo pipefail
cd "$(dirname "$0")/.."

NS="pastecal-test"
BASE="http://127.0.0.1:9000"

curl -s -X PUT "$BASE/.settings/rules.json?ns=$NS" \
    -H "Authorization: Bearer owner" --data-binary @database.rules.json \
    -o /tmp/pc_rules.out -w "" || {
    echo "ERROR: could not reach the database emulator on ${BASE#http://}" >&2
    echo "       start it with: npx firebase emulators:start --only database --project $NS" >&2
    exit 2
}
if ! grep -q '"ok"' /tmp/pc_rules.out; then
    echo "ERROR: the emulator refused these rules:" >&2
    cat /tmp/pc_rules.out >&2
    exit 2
fi

# Start from an empty node so a previous run's rows cannot mask a read failure.
curl -s -X DELETE "$BASE/pro_interest.json?ns=$NS" -H "Authorization: Bearer owner" >/dev/null

pass=0
fail=0

# try <label> <expected-http> <method> <path> <body>
try() {
    local label="$1" want="$2" method="$3" p="$4" body="$5"
    local code
    code=$(curl -s -o /tmp/pc_rr.out -w '%{http_code}' -X "$method" "$BASE$p?ns=$NS" -d "$body")
    if [ "$code" = "$want" ]; then
        echo "  PASS  $label (HTTP $code)"
        pass=$((pass + 1))
    else
        echo "  FAIL  $label (got $code, wanted $want): $(head -c 120 /tmp/pc_rr.out)"
        fail=$((fail + 1))
    fi
}

echo "pro_interest -- anyone may add an address, nobody may read the list:"
try "valid write accepted"       200 POST /pro_interest.json '{"email":"a@b.com","at":1700000000000}'
try "malformed email rejected"   401 POST /pro_interest.json '{"email":"nope","at":1700000000000}'
try "missing timestamp rejected" 401 POST /pro_interest.json '{"email":"a@b.com"}'
try "unknown field rejected"     401 POST /pro_interest.json '{"email":"a@b.com","at":1,"junk":"x"}'
try "oversized ua rejected"      401 POST /pro_interest.json "{\"email\":\"a@b.com\",\"at\":1,\"ua\":\"$(printf 'x%.0s' {1..300})\"}"
try "list is not readable"       401 GET  /pro_interest.json ''

echo "pro_accounts -- entitlements are written by the Stripe webhook only:"
try "client cannot grant itself" 401 PUT  /pro_accounts/someuid.json '{"status":"active"}'
try "client cannot read another" 401 GET  /pro_accounts/someuid.json ''

echo ""
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
