#!/usr/bin/env bash
# pastecal report — build a local HTML report of how the site is being used.
#
#   ./scripts/report.sh            # last 30 days, opens in your browser
#   ./scripts/report.sh -d 90      # different window
#   ./scripts/report.sh -o out.html   # write somewhere specific
#   ./scripts/report.sh -n         # write the file, don't open it
#
# The report is written to a local file and never deployed. Nothing about this
# is exposed on pastecal.com -- it reads the GA4 Data API with the Application
# Default Credentials already on this machine.
#
# For quick terminal answers use ./scripts/stats.sh instead; this is the
# shareable, look-at-everything-at-once version.

set -euo pipefail

cd "$(dirname "$0")/.."

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
        h) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "See: $0 -h" >&2; exit 1 ;;
    esac
done

[ -n "$OUT" ] || OUT="/tmp/pastecal-report-$(date +%Y%m%d).html"

for tool in curl jq gcloud python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required." >&2; exit 1; }
done

TOKEN="$(gcloud auth application-default print-access-token 2>/dev/null)" || {
    echo "ERROR: could not get a token. Run:" >&2
    echo "    gcloud auth login --update-adc" >&2
    exit 1
}

post() {
    local url="$1" body="$2" out http
    out="$(mktemp)"
    http="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$url" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H 'Content-Type: application/json' -d "$body")"
    if [ "$http" != "200" ]; then
        echo "ERROR: GA4 API returned HTTP $http" >&2
        jq -r '.error.message // .' < "$out" >&2 2>/dev/null || cat "$out" >&2
        rm -f "$out"; exit 1
    fi
    cat "$out"; rm -f "$out"
}

range() { printf '{"startDate":"%ddaysAgo","endDate":"yesterday"}' "$DAYS"; }

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

CUSTOM="slug_prompt_shown,slug_claimed,slug_autoassigned,slug_claim_failed,event_added,calendar_shared,calendar_returned"

echo "Pulling ${DAYS} days from GA4..." >&2

overview="$(post "$API" "$(q 'newVsReturning' 'sessions,totalUsers,averageSessionDuration')")"
daily="$(post "$API" "$(q 'date' 'totalUsers,sessions' '' 400)")"
devices="$(post "$API" "$(q 'deviceCategory' 'sessions,totalUsers')")"
channels="$(post "$API" "$(q 'sessionDefaultChannelGroup' 'sessions,totalUsers' '' 12)")"
pages="$(post "$API" "$(q 'landingPage' 'sessions,totalUsers' '' 25)")"
# pagePath rather than landingPage: landingPage only counts sessions that
# STARTED on a page, so a calendar reached from the homepage is undercounted.
reach="$(post "$API" "$(q 'pagePath' 'screenPageViews,totalUsers,newUsers' '' 200)")"
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
prev_reach="$(post "$API" "$(printf '{"dateRanges":[%s],"dimensions":[{"name":"pagePath"}],"metrics":[{"name":"screenPageViews"},{"name":"totalUsers"},{"name":"newUsers"}],"limit":200,"orderBys":[{"metric":{"metricName":"screenPageViews"},"desc":true}]}' "$prev_range")")"

# Realtime has no processing delay, so it shows whether instrumentation is live
# right now even when the daily tables have not caught up yet.
realtime="$(post "$RT_API" '{"dimensions":[{"name":"eventName"}],"metrics":[{"name":"eventCount"}],"limit":30}')"

# Which custom dimensions exist. Params are collected from the moment the code
# ships but are not queryable as a breakdown until one is registered, and GA4
# never backfills -- so a report that silently omitted this would be misleading.
dims_raw="$(mktemp)"
dims_http="$(curl -sS -o "$dims_raw" -w '%{http_code}' \
    -H "Authorization: Bearer ${TOKEN}" \
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
        breakdowns="$(jq -n --argjson b "$breakdowns" --arg k "$key" --argjson v "$r" \
            '$b + {($k): $v}')"
    }
    add_bd sources source event_added
    add_bd methods method calendar_shared
    add_bd visits visit_bucket calendar_returned
    add_bd surfaces where "slug_claimed,slug_autoassigned,slug_prompt_shown"
fi

DATA="$(jq -n \
    --argjson overview "$overview" --argjson daily "$daily" \
    --argjson devices "$devices" --argjson channels "$channels" \
    --argjson pages "$pages" --argjson events "$events" \
    --argjson reach "$reach" \
    --argjson prevOverview "$prev_overview" --argjson prevReach "$prev_reach" \
    --argjson countries "$countries" --argjson realtime "$realtime" \
    --argjson dims "$dims" --argjson breakdowns "$breakdowns" \
    --arg days "$DAYS" --arg generated "$(date '+%Y-%m-%d %H:%M')" \
    '{overview:$overview, daily:$daily, devices:$devices, channels:$channels,
      pages:$pages, reach:$reach, events:$events, countries:$countries, realtime:$realtime,
      prevOverview:$prevOverview, prevReach:$prevReach,
      dims:$dims, breakdowns:$breakdowns, days:($days|tonumber), generated:$generated}')"

echo "Rendering..." >&2
printf '%s' "$DATA" | python3 scripts/render_report.py > "$OUT"

echo "Report written to $OUT" >&2
[ "$OPEN" = "1" ] && command -v open >/dev/null 2>&1 && open "$OUT"
exit 0
