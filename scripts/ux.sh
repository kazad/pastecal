#!/usr/bin/env bash
# pastecal UX scorecard from Workers Analytics Engine (dataset pastecal_events).
#
#   ./scripts/ux.sh [days]        # default 7
#   ./scripts/ux.sh 28 --sql      # print the queries instead of running them
#
# Needs CLOUDFLARE_API_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID.
# Column layout is defined in cloudflare/src/Collector.js -- keep the two in sync.
set -euo pipefail
DAYS="${1:-7}"; [[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "days must be a number" >&2; exit 2; }
PRINT=0; [ "${2:-}" = "--sql" ] && PRINT=1
D="timestamp > NOW() - INTERVAL '$DAYS' DAY"

run() { # title, sql
  echo; echo "== $1 (last ${DAYS}d)"
  if [ "$PRINT" = 1 ]; then echo "$2"; return; fi
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
  curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data "$2 FORMAT JSON" \
    | jq -r '(.data // [])[] | [.[]] | @tsv' || true
}

# quantileWeighted(q, value, weight): double7 is always 1, so weights are plain counts (sampling-aware).
run "Load time by browser x UI: views, p75 TTFB / FCP / LCP ms, p75 CLS" \
"SELECT blob3 AS browser, blob2 AS ui, SUM(_sample_interval) AS views,
  round(quantileWeighted(0.75, double1, _sample_interval)) AS ttfb_p75,
  round(quantileWeighted(0.75, double2, _sample_interval)) AS fcp_p75,
  round(quantileWeighted(0.75, double3, _sample_interval)) AS lcp_p75,
  round(quantileWeighted(0.75, double5, _sample_interval), 3) AS cls_p75
FROM pastecal_events WHERE blob1 = 'page_perf' AND double3 > 0 AND $D GROUP BY browser, ui ORDER BY views DESC"

run "Time to first event by UI: people, median / p75 seconds" \
"SELECT blob2 AS ui, SUM(_sample_interval) AS first_events,
  round(quantileWeighted(0.5, double6, _sample_interval)) AS median_s,
  round(quantileWeighted(0.75, double6, _sample_interval)) AS p75_s
FROM pastecal_events WHERE blob1 = 'event_added' AND double6 > 0 AND $D GROUP BY ui"

run "Editor abandonment: events added vs editors abandoned, by UI" \
"SELECT blob2 AS ui,
  SUMIf(_sample_interval, blob1 = 'event_added') AS added,
  SUMIf(_sample_interval, blob1 = 'editor_abandoned') AS abandoned
FROM pastecal_events WHERE blob1 IN ('event_added','editor_abandoned') AND $D GROUP BY ui"

run "Trust: refused saves and errors by UI and detail" \
"SELECT blob1 AS event, blob2 AS ui, blob6 AS detail, SUM(_sample_interval) AS n
FROM pastecal_events WHERE blob1 IN ('sync_refused','js_error','command_failed') AND $D GROUP BY event, ui, detail ORDER BY n DESC LIMIT 20"

run "Volume: all events by UI" \
"SELECT blob1 AS event, blob2 AS ui, SUM(_sample_interval) AS n
FROM pastecal_events WHERE $D GROUP BY event, ui ORDER BY n DESC LIMIT 30"
