#!/usr/bin/env bash
# pastecal report — build a local HTML report of how the site is being used.
#
#   ./scripts/report.sh            # last 30 days, opens in your browser
#   ./scripts/report.sh -d 90      # different window
#   ./scripts/report.sh -o out.html   # write somewhere specific
#                                     (default: ~/.pastecal/reports/, private)
#   ./scripts/report.sh -n         # write the file, don't open it
#
# The report is written to a local file and never deployed. Nothing about this
# is exposed on pastecal.com -- it reads the GA4 Data API with the Application
# Default Credentials already on this machine.
#
# For quick terminal answers use ./scripts/stats.sh instead; this is the
# shareable, look-at-everything-at-once version.

set -euo pipefail

# Everything this writes -- the report, the temp files holding raw GA4 rows --
# is private to this user. The report used to land at a predictable
# /tmp/pastecal-report-DATE.html, world-readable and pre-creatable by anyone
# else on the machine.
umask 077

# Resolve our own directory BEFORE the cd: $0 may be relative, and every later
# "$(dirname "$0")" would otherwise point somewhere else (ga-token.js went
# missing and auth silently fell back to gcloud).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

PROPERTY_ID="298180842"
API="https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport"
RT_API="https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runRealtimeReport"

DAYS=30
OUT=""
OPEN=1

while getopts "d:o:nh" opt; do
    case "$opt" in
        d) DAYS="$OPTARG" ;;
        o) OUT="$OPTARG" ;;
        n) OPEN=0 ;;
        h) sed -n '2,16p' "$SCRIPT_DIR/$(basename "$0")" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "See: $0 -h" >&2; exit 1 ;;
    esac
done

case "$DAYS" in
    ''|*[!0-9]*) echo "ERROR: -d takes a whole number of days, got '$DAYS'." >&2; exit 1 ;;
esac
# Force base 10: printf %d reads a leading zero as octal, so -d 010 meant 8 days.
DAYS=$((10#$DAYS))
[ "$DAYS" -ge 1 ] || { echo "ERROR: -d must be at least 1." >&2; exit 1; }

if [ -z "$OUT" ]; then
    mkdir -p "$HOME/.pastecal/reports"
    OUT="$HOME/.pastecal/reports/pastecal-report-$(date +%Y%m%d).html"
fi

for tool in curl jq gcloud python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required." >&2; exit 1; }
done

# Prefer the service account: gcloud's ADC can no longer be granted
# analytics.edit (Google blocks that scope on gcloud's client ID), so anything
# that writes -- creating custom dimensions -- only works this way. Falls back to
# gcloud for read-only use so the script still runs without the key.
mint_token() {
    local want="${1:-read}" node=""
    for candidate in node "$HOME/.nvm/versions/node/v22"*/bin/node /opt/homebrew/opt/node@20/bin/node; do
        if command -v "$candidate" >/dev/null 2>&1; then node="$candidate"; break; fi
        [ -x "$candidate" ] && { node="$candidate"; break; }
    done

    if [ -n "$node" ] && [ -f "$SCRIPT_DIR/ga-token.js" ]; then
        local args=""
        [ "$want" = "edit" ] && args="--edit"
        local t
        # stderr stays on the terminal: a missing, ambiguous or over-exposed key
        # is something to fix, not something to fall back past silently.
        if t="$("$node" "$SCRIPT_DIR/ga-token.js" $args)" && [ -n "$t" ]; then
            printf '%s' "$t"
            return 0
        fi
        echo "Service account token failed (above); falling back to gcloud ADC." >&2
    fi

    # Fallback: gcloud ADC. Fine for reading, cannot create dimensions.
    gcloud auth application-default print-access-token
}

TOKEN="$(mint_token read)"
[ -n "$TOKEN" ] || {
    echo "ERROR: could not get a token. Either add the service account key to" >&2
    echo "       internal/keys/, or run: gcloud auth login --update-adc" >&2
    exit 1
}

# The bearer token goes to curl through a file descriptor, never argv, where
# any local user could read it from ps. printf is a builtin, so it never execs.
auth_header() { printf 'Authorization: Bearer %s\n' "$1"; }

post() {
    local url="$1" body="$2" out http
    out="$(mktemp)"
    http="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$url" \
        -H @<(auth_header "$TOKEN") \
        -H 'Content-Type: application/json' -d "$body")"
    if [ "$http" != "200" ]; then
        echo "ERROR: GA4 API returned HTTP $http" >&2
        jq -r '.error.message // .' < "$out" >&2 2>/dev/null || cat "$out" >&2
        rm -f "$out"; exit 1
    fi
    cat "$out"; rm -f "$out"
}

range() { printf '{"startDate":"%ddaysAgo","endDate":"yesterday"}' "$DAYS"; }

# Calendar-aligned starts for the long queries, computed in python because BSD
# and GNU date disagree on arithmetic flags.
#   MONTHS_FROM: the 1st of the month 12 months back, so the first month is a
#                whole month and can serve as a growth baseline (365daysAgo
#                started mid-month and made the baseline a fraction).
#   WEEKS_FROM:  the Monday 60 ISO weeks back: 52 weeks shown, the same 4 weeks
#                a year earlier for the year-over-year tile, plus the cohort
#                lookback and the lag-skipped current week.
read -r TODAY MONTHS_FROM WEEKS_FROM < <(python3 -c '
import datetime as d
t = d.date.today()
print(t.isoformat(),
      d.date(t.year - 1, t.month, 1).isoformat(),
      (t - d.timedelta(days=t.weekday(), weeks=60)).isoformat())')
[ -n "${WEEKS_FROM:-}" ] || { echo "ERROR: could not compute query start dates." >&2; exit 1; }

# GA4 silently stops at a request's limit; rowCount is the true total. Every
# capped query is checked, since any sum over a truncated report reads low.
check_rows() {
    local name="$1" json="$2" got total
    got="$(printf '%s' "$json" | jq '(.rows // []) | length')"
    total="$(printf '%s' "$json" | jq '.rowCount // 0')"
    if [ "$total" -gt "$got" ]; then
        echo "WARNING: $name: GA4 returned $got of $total rows -- truncated." >&2
    fi
}

# dims, metrics, [filter], [limit]
q() {
    local dims="$1" mets="$2" filter="${3:-}" limit="${4:-100}" d m first
    d="$(echo "$dims" | tr ',' '\n' | jq -R '{name:.}' | jq -s -c '.')"
    m="$(echo "$mets" | tr ',' '\n' | jq -R '{name:.}' | jq -s -c '.')"
    first="$(echo "$mets" | cut -d, -f1)"
    if [ -n "$filter" ]; then
        printf '{"dateRanges":[%s],"dimensions":%s,"metrics":%s,"dimensionFilter":%s,"limit":%d,"orderBys":[{"metric":{"metricName":"%s"},"desc":true}]}' \
            "$(range)" "$d" "$m" "$filter" "$limit" "$first"
    else
        printf '{"dateRanges":[%s],"dimensions":%s,"metrics":%s,"limit":%d,"orderBys":[{"metric":{"metricName":"%s"},"desc":true}]}' \
            "$(range)" "$d" "$m" "$limit" "$first"
    fi
}

only() {
    local list
    list="$(echo "$1" | tr ',' '\n' | jq -R '.' | jq -s -c '.')"
    printf '{"filter":{"fieldName":"eventName","inListFilter":{"values":%s}}}' "$list"
}

CUSTOM="calendar_created,slug_prompt_shown,slug_claimed,slug_autoassigned,slug_claim_failed,event_added,calendar_shared,calendar_returned,feature_used"

echo "Pulling ${DAYS} days from GA4..." >&2

overview="$(post "$API" "$(q 'newVsReturning' 'sessions,totalUsers,averageSessionDuration')")"
daily="$(post "$API" "$(q 'date' 'totalUsers,sessions' '' 400)")"
devices="$(post "$API" "$(q 'deviceCategory' 'sessions,totalUsers')")"
channels="$(post "$API" "$(q 'sessionDefaultChannelGroup' 'sessions,totalUsers' '' 12)")"
pages="$(post "$API" "$(q 'landingPage' 'sessions,totalUsers' '' 25)")"
# pagePath rather than landingPage: landingPage only counts sessions that
# STARTED on a page, so a calendar reached from the homepage is undercounted.
# The limit is high on purpose: every calendar here feeds the "calendars that
# stick" count, and a 200-row cap silently dropped the long tail.
reach="$(post "$API" "$(q 'pagePath' 'screenPageViews,totalUsers,newUsers' '' 25000)")"
events="$(post "$API" "$(q 'eventName' 'eventCount,totalUsers' "$(only "$CUSTOM")")")"
countries="$(post "$API" "$(q 'country' 'totalUsers' '' 10)")"

# The previous window, same length, so every KPI can show a trend rather than a
# bare number. A KPI without a direction is just trivia.
prev_start=$((DAYS * 2))
prev_end=$((DAYS + 1))
prev_range="{\"startDate\":\"${prev_start}daysAgo\",\"endDate\":\"${prev_end}daysAgo\"}"
# Metric ORDER must match the current-window overview query above: the renderer
# reads these positionally, so swapping them silently compares sessions against
# users.
prev_overview="$(post "$API" "$(printf '{"dateRanges":[%s],"dimensions":[{"name":"newVsReturning"}],"metrics":[{"name":"sessions"},{"name":"totalUsers"},{"name":"averageSessionDuration"}]}' "$prev_range")")"
prev_reach="$(post "$API" "$(printf '{"dateRanges":[%s],"dimensions":[{"name":"pagePath"}],"metrics":[{"name":"screenPageViews"},{"name":"totalUsers"},{"name":"newUsers"}],"limit":25000,"orderBys":[{"metric":{"metricName":"screenPageViews"},"desc":true}]}' "$prev_range")")"

# Month-over-month history. The KPI deltas compare two adjacent windows, which
# is far too short a baseline for a site with this much week-to-week noise -- a
# 30-day comparison showed "returning users flat, sharing ratio down 36%" during
# a year in which both actually grew 6x. Trend beats delta; show both.
monthly="$(post "$API" "$(printf '{"dateRanges":[{"startDate":"%s","endDate":"yesterday"}],"dimensions":[{"name":"yearMonth"}],"metrics":[{"name":"totalUsers"},{"name":"newUsers"},{"name":"sessions"}],"limit":24,"orderBys":[{"dimension":{"dimensionName":"yearMonth"}}]}' "$MONTHS_FROM")")"

# A full year of week x calendar x people, one query serving two views: the
# north-star series (calendars with 2+ people in a week) and cohort survival
# (born which week; ever shared; alive 4 weeks on). Weekly rather than daily
# because "2+ people" needs GA4 to de-duplicate users within the bucket, and a
# year rather than the report window because the north star is only readable
# against its own history. Starts on a Monday (WEEKS_FROM) so no week is partial.
weekly="$(post "$API" "$(printf '{"dateRanges":[{"startDate":"%s","endDate":"yesterday"}],"dimensions":[{"name":"isoYearIsoWeek"},{"name":"pagePath"}],"metrics":[{"name":"totalUsers"}],"limit":250000}' "$WEEKS_FROM")")"

for name in overview prev_overview daily events reach prev_reach monthly weekly; do
    check_rows "$name" "${!name}"
done

# Realtime has no processing delay, so it shows whether instrumentation is live
# right now even when the daily tables have not caught up yet.
realtime="$(post "$RT_API" '{"dimensions":[{"name":"eventName"}],"metrics":[{"name":"eventCount"}],"limit":30}')"

# Which custom dimensions exist. Params are collected from the moment the code
# ships but are not queryable as a breakdown until one is registered, and GA4
# never backfills -- so a report that silently omitted this would be misleading.
dims_raw="$(mktemp)"
dims_http="$(curl -sS -o "$dims_raw" -w '%{http_code}' \
    -H @<(auth_header "$TOKEN") \
    "https://analyticsadmin.googleapis.com/v1beta/properties/${PROPERTY_ID}/customDimensions")"
if [ "$dims_http" = "200" ]; then
    dims="$(jq -c '[(.customDimensions // [])[].parameterName]' < "$dims_raw")"
else
    dims='null'
fi
rm -f "$dims_raw"

# Breakdowns that only work once the matching dimension is registered.
breakdowns='{}'
if [ "$dims" != "null" ]; then
    add_bd() {
        local key="$1" param="$2" evs="$3"
        echo "$dims" | jq -e --arg p "$param" 'index($p)' >/dev/null 2>&1 || return 0
        local r
        r="$(post "$API" "$(q "customEvent:${param}" 'eventCount' "$(only "$evs")")")"
        check_rows "breakdown $key" "$r"
        breakdowns="$(jq -n --argjson b "$breakdowns" --arg k "$key" --argjson v "$r" \
            '$b + {($k): $v}')"
    }
    add_bd sources source event_added
    add_bd methods method calendar_shared
    add_bd visits visit_bucket calendar_returned
    add_bd surfaces where "slug_claimed,slug_autoassigned,slug_prompt_shown"
    add_bd features feature feature_used
fi

# The weekly payload is a year of week x calendar rows -- far past ARG_MAX as a
# --argjson literal -- so it goes through a file. --slurpfile wraps the file's
# JSON in an array, hence $w[0].
weekly_tmp="$(mktemp)"
printf '%s' "$weekly" > "$weekly_tmp"

DATA="$(jq -n \
    --argjson overview "$overview" --argjson daily "$daily" \
    --argjson devices "$devices" --argjson channels "$channels" \
    --argjson pages "$pages" --argjson events "$events" \
    --argjson reach "$reach" \
    --argjson prevOverview "$prev_overview" --argjson prevReach "$prev_reach" \
    --argjson monthly "$monthly" \
    --argjson countries "$countries" --argjson realtime "$realtime" \
    --argjson dims "$dims" --argjson breakdowns "$breakdowns" \
    --slurpfile w "$weekly_tmp" --arg curweek "$(date +%G%V)" \
    --arg today "$TODAY" --arg monthsFrom "$MONTHS_FROM" --arg weeklyFrom "$WEEKS_FROM" \
    --arg days "$DAYS" --arg generated "$(date '+%Y-%m-%d %H:%M')" \
    '{overview:$overview, daily:$daily, devices:$devices, channels:$channels,
      pages:$pages, reach:$reach, events:$events, countries:$countries, realtime:$realtime,
      prevOverview:$prevOverview, prevReach:$prevReach, monthly:$monthly,
      weekly:$w[0], curweek:$curweek,
      today:$today, monthsFrom:$monthsFrom, weeklyFrom:$weeklyFrom,
      dims:$dims, breakdowns:$breakdowns, days:($days|tonumber), generated:$generated}')"
rm -f "$weekly_tmp"

echo "Rendering..." >&2
printf '%s' "$DATA" | python3 "$SCRIPT_DIR/render_report.py" > "$OUT"

echo "Report written to $OUT" >&2
[ "$OPEN" = "1" ] && command -v open >/dev/null 2>&1 && open "$OUT"
exit 0
