#!/usr/bin/env bash
# pastecal stats — pull the GA4 numbers from the terminal.
#
#   ./scripts/stats.sh                 # the summary you usually want
#   ./scripts/stats.sh funnel          # claim funnel: shown -> claimed
#   ./scripts/stats.sh events          # every event, by count
#   ./scripts/stats.sh calendars       # busiest calendars by return depth
#   ./scripts/stats.sh returns         # how deep people come back
#   ./scripts/stats.sh adds            # where events get created
#   ./scripts/stats.sh shares          # how calendars get shared
#   ./scripts/stats.sh raw <json>      # any runReport body, printed as JSON
#   ./scripts/stats.sh setup           # check GA4 is configured to answer all of the above
#
# Options (before the subcommand):
#   -d N        days back, default 30
#   -j          print raw JSON instead of a table
#
# Auth uses the Application Default Credentials you already have from
# `gcloud auth login --update-adc`. If a call 401s, run that again.
#
# Why a shell script and not a Node tool: this needs curl and jq and nothing
# else, so there is no install step, no package.json entry, and nothing to keep
# up to date. See internal/scripts/local-analytics.js for the Firebase-side view
# (calendars, ICS hits); this covers the visitor-behavior side GA4 owns.

set -euo pipefail

PROPERTY_ID="298180842"   # GA4 property "pastecal-web"
API="https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport"

DAYS=30
JSON_ONLY=0

while getopts "d:jh" opt; do
    case "$opt" in
        d) DAYS="$OPTARG" ;;
        j) JSON_ONLY=1 ;;
        h) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "See: $0 -h" >&2; exit 1 ;;
    esac
done
shift $((OPTIND - 1))

CMD="${1:-summary}"

for tool in curl jq gcloud; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required." >&2; exit 1; }
done

TOKEN="$(gcloud auth application-default print-access-token 2>/dev/null)" || {
    echo "ERROR: could not get a token. Run:" >&2
    echo "    gcloud auth login --update-adc" >&2
    exit 1
}

# POST a runReport body and hand back the raw JSON. Fails loudly rather than
# letting jq parse an error page into confusing emptiness.
report() {
    local body="$1" out http
    out="$(mktemp)"
    http="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$API" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H 'Content-Type: application/json' \
        -d "$body")"

    if [ "$http" != "200" ]; then
        echo "ERROR: GA4 API returned HTTP $http" >&2
        jq -r '.error.message // .' < "$out" >&2 2>/dev/null || cat "$out" >&2
        rm -f "$out"
        exit 1
    fi
    cat "$out"
    rm -f "$out"
}

range() { printf '{"startDate":"%ddaysAgo","endDate":"yesterday"}' "$DAYS"; }

# Build a runReport body: dimensions, metrics, optional filter, optional limit.
mk() {
    local dims="$1" mets="$2" filter="${3:-}" limit="${4:-100}"
    local d m
    d="$(echo "$dims" | tr ',' '\n' | jq -R '{name: .}' | jq -s -c '.')"
    m="$(echo "$mets" | tr ',' '\n' | jq -R '{name: .}' | jq -s -c '.')"
    if [ -n "$filter" ]; then
        printf '{"dateRanges":[%s],"dimensions":%s,"metrics":%s,"dimensionFilter":%s,"limit":%d,"orderBys":[{"metric":{"metricName":"%s"},"desc":true}]}' \
            "$(range)" "$d" "$m" "$filter" "$limit" "$(echo "$mets" | cut -d, -f1)"
    else
        printf '{"dateRanges":[%s],"dimensions":%s,"metrics":%s,"limit":%d,"orderBys":[{"metric":{"metricName":"%s"},"desc":true}]}' \
            "$(range)" "$d" "$m" "$limit" "$(echo "$mets" | cut -d, -f1)"
    fi
}

# Only these event names, so a report isn't swamped by GA4's built-ins.
only_events() {
    local names="$1" list
    list="$(echo "$names" | tr ',' '\n' | jq -R '.' | jq -s -c '.')"
    printf '{"filter":{"fieldName":"eventName","inListFilter":{"values":%s}}}' "$list"
}

# Print rows as an aligned table. Header labels are passed in.
table() {
    local headers="$1"
    # Blank dimension values become "(none)" so a row never collapses into the
    # wrong column, and float metrics are rounded -- GA4 returns durations as
    # full-precision doubles, which are unreadable raw.
    jq -r --arg h "$headers" '
        def clean: if . == "" or . == null then "(none)" else . end;
        def num: (tonumber? // null) as $n
                 | if $n == null then .
                   elif ($n | floor) == $n then ($n | tostring)
                   else ($n * 10 | round / 10 | tostring) end;
        ($h | split(",")) as $head
        | ([$head] + [(.rows // [])[]
            | [(.dimensionValues // [])[].value | clean]
              + [(.metricValues // [])[].value | num]])
        | .[] | @tsv
    ' | column -t -s "$(printf '\t')"
}

# A single scalar metric, for the summary block.
scalar() {
    jq -r '(.rows // [])[0].metricValues[0].value // "0"'
}

emit() {
    local json="$1" headers="$2"
    if [ "$JSON_ONLY" = "1" ]; then
        echo "$json" | jq '.'
    else
        echo "$json" | table "$headers"
    fi
}


# Params are collected the moment the code ships, but stay unqueryable until the
# matching custom dimension exists in GA4 -- and GA4 does not backfill, so a
# dimension only sees data from its creation date forward. Worth registering
# before a deploy, not after.
dimension_warning() {
    echo
    echo "If the above is empty, '$1' is probably not registered as a custom"
    echo "dimension yet. Run:  $0 setup"
}

CUSTOM="slug_prompt_shown,slug_claimed,slug_autoassigned,slug_claim_failed,event_added,calendar_shared,calendar_returned"

case "$CMD" in

summary)
    users="$(report "$(mk 'date' 'totalUsers' '' 1)" | jq -r '[(.rows//[])[].metricValues[0].value|tonumber] | add // 0')"
    overview="$(report "$(mk 'newVsReturning' 'sessions,totalUsers,averageSessionDuration')")"
    events="$(report "$(mk 'eventName' 'eventCount' "$(only_events "$CUSTOM")")")"

    if [ "$JSON_ONLY" = "1" ]; then
        jq -n --argjson o "$overview" --argjson e "$events" \
            '{overview: $o, custom_events: $e}'
        exit 0
    fi

    echo "pastecal — last ${DAYS} days"
    echo
    echo "VISITORS"
    echo "$overview" | table "type,sessions,users,avg secs"
    echo
    echo "PRODUCT EVENTS"
    if [ "$(echo "$events" | jq '(.rows // []) | length')" = "0" ]; then
        cat <<'MSG'
  (none yet)

  No custom events recorded in this window. Either the analytics call sites
  have not been deployed yet, or they have been live for less than a day --
  GA4 backfills on a delay, so give it 24-48h after a deploy.
MSG
    else
        echo "$events" | table "event,count"
    fi
    ;;

funnel)
    # The question the whole schema exists to answer: of the people offered a
    # name they could change, how many chose one?
    json="$(report "$(mk 'eventName' 'eventCount' \
        "$(only_events 'slug_prompt_shown,slug_claimed,slug_autoassigned,slug_claim_failed')")")"

    if [ "$JSON_ONLY" = "1" ]; then echo "$json" | jq '.'; exit 0; fi

    get() { echo "$json" | jq -r --arg n "$1" \
        '[(.rows//[])[] | select(.dimensionValues[0].value == $n) | .metricValues[0].value | tonumber] | add // 0'; }

    shown="$(get slug_prompt_shown)"
    claimed="$(get slug_claimed)"
    auto="$(get slug_autoassigned)"
    failed="$(get slug_claim_failed)"

    echo "Claim funnel — last ${DAYS} days"
    echo
    printf '  offered a name      %8s\n' "$shown"
    printf '  chose their own     %8s' "$claimed"
    if [ "$shown" -gt 0 ]; then
        printf '   (%s%%)' "$(awk -v a="$claimed" -v b="$shown" 'BEGIN{printf "%.1f", a*100/b}')"
    fi
    echo
    printf '  kept the random one %8s\n' "$auto"
    printf '  name was taken      %8s\n' "$failed"
    echo
    echo "  A high 'taken' count argues for suggesting names."
    echo "  A high 'kept the random one' count argues the naming step is not discoverable."
    ;;

events)
    emit "$(report "$(mk 'eventName' 'eventCount,totalUsers')")" "event,count,users"
    ;;

calendars)
    # Busiest calendars, with sessions-per-user as the return-depth proxy.
    json="$(report "$(mk 'landingPage' 'sessions,totalUsers' '' 25)")"
    if [ "$JSON_ONLY" = "1" ]; then echo "$json" | jq '.'; exit 0; fi

    echo "Busiest calendars — last ${DAYS} days"
    echo
    echo "$json" | jq -r '
        ["calendar","sessions","users","visits each"],
        ((.rows // [])[]
         | [.dimensionValues[0].value,
            .metricValues[0].value,
            .metricValues[1].value,
            ((.metricValues[0].value|tonumber) /
             ([(.metricValues[1].value|tonumber), 1] | max) * 10 | round / 10 | tostring)])
        | @tsv' | column -t -s "$(printf '\t')"
    ;;

returns)
    emit "$(report "$(mk 'customEvent:visit_bucket' 'eventCount' \
        "$(only_events 'calendar_returned')")")" "visits,count"
    dimension_warning visit_bucket
    ;;

adds)
    emit "$(report "$(mk 'customEvent:source' 'eventCount' \
        "$(only_events 'event_added')")")" "source,count"
    dimension_warning source
    ;;

shares)
    emit "$(report "$(mk 'customEvent:method' 'eventCount' \
        "$(only_events 'calendar_shared')")")" "method,count"
    dimension_warning method
    ;;

raw)
    body="${2:-}"
    [ -n "$body" ] || { echo "usage: $0 raw '<runReport JSON body>'" >&2; exit 1; }
    report "$body" | jq '.'
    ;;

setup)
    # The params the call sites send, and the dimension each one needs.
    echo "GA4 configuration check"
    echo
    dims_raw="$(mktemp)"
    dims_http="$(curl -sS -o "$dims_raw" -w '%{http_code}' \
        -H "Authorization: Bearer ${TOKEN}" \
        "https://analyticsadmin.googleapis.com/v1beta/properties/${PROPERTY_ID}/customDimensions")"

    # Distinguish "no dimensions" from "could not ask" -- otherwise a permissions
    # error reads as a clean bill of missing dimensions and sends you to the UI
    # to create things that may already exist.
    if [ "$dims_http" != "200" ]; then
        echo "  Could not read custom dimensions (HTTP $dims_http)." >&2
        jq -r '.error.message // empty' < "$dims_raw" >&2 2>/dev/null || true
        echo "  The Analytics Admin API may need enabling for this project." >&2
        rm -f "$dims_raw"
        exit 1
    fi

    dims="$(jq -r '[(.customDimensions // [])[].parameterName] | join(" ")' < "$dims_raw")"
    rm -f "$dims_raw"

    missing=0
    for p in where source method visit_bucket slug_length event_count_bucket has_custom_slug reason surface; do
        if echo " $dims " | grep -q " $p "; then
            printf '  ok       %s\n' "$p"
        else
            printf '  MISSING  %s\n' "$p"
            missing=$((missing + 1))
        fi
    done

    echo
    if [ "$missing" = "0" ]; then
        echo "All parameters are queryable."
    else
        cat <<'MSG'
Missing parameters are still being COLLECTED -- they are just not queryable as a
breakdown until a custom dimension exists. GA4 does not backfill them, so a
dimension created today shows nothing for yesterday.

To fix, once per parameter:
  analytics.google.com -> Admin -> Custom definitions -> Create custom dimension
    Dimension name:  whatever reads well in reports
    Scope:           Event
    Event parameter: the name printed above

The 50-dimension limit is per property, so there is room for all of these.
MSG
    fi
    ;;

*)
    echo "Unknown command: $CMD" >&2
    echo "See: $0 -h" >&2
    exit 1
    ;;
esac
