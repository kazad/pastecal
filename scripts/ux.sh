#!/usr/bin/env bash
# pastecal UX scorecard from Workers Analytics Engine (dataset pastecal_events).
#
#   ./scripts/ux.sh [days]              # default 7
#   ./scripts/ux.sh 28 --sql            # print the queries instead of running them
#   ./scripts/ux.sh trials [days]       # the Pro trial funnel (also: ./scripts/stats.sh trials -d N)
#   ./scripts/ux.sh usage [days]        # site-wide calendar visits, visitors, calendar-app followers, calendars in use
#   UX_DATASET=pastecal_events_staging ./scripts/ux.sh trials   # another dataset (staging)
#
# Auth: CLOUDFLARE_API_TOKEN (Account Analytics: Read) + CLOUDFLARE_ACCOUNT_ID, or, when those are
# unset, the `cf` CLI if it is logged in (as scripts/homepage-funnel.sh). Read-only: SELECTs only.
# Column layout is defined in cloudflare/src/Collector.js -- keep the two in sync:
#   blob1 event name, blob2 ui, blob6 detail (the event's one value), double7 = 1.
# First-party, so it covers EU visitors (GA4 is off for them); test traffic (surface=test) is
# dropped by the collector before it is written, so nothing here needs to filter it.
set -euo pipefail
REPORT=ux
if [ "${1:-}" = "trials" ]; then REPORT=trials; shift; fi
if [ "${1:-}" = "usage" ]; then REPORT=usage; shift; fi
DAYS="${1:-7}"; [[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "days must be a number" >&2; exit 2; }
PRINT=0; [ "${2:-}" = "--sql" ] && PRINT=1
DS="${UX_DATASET:-pastecal_events}"
[[ "$DS" =~ ^[a-z0-9_]+$ ]] || { echo "UX_DATASET must be a dataset name" >&2; exit 2; }
D="timestamp > NOW() - INTERVAL '$DAYS' DAY"

query() { # sql -> JSON on stdout
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data "$1 FORMAT JSON"
  elif command -v cf >/dev/null 2>&1; then
    local tmp rc=0; tmp="$(mktemp)"; printf '%s FORMAT JSON' "$1" > "$tmp"
    cf analytics_engine sql query --file "$tmp" || rc=$?; rm -f "$tmp"; return $rc
  else
    echo "set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or log in to the cf CLI" >&2; return 1
  fi
}

run() { # title, sql
  echo; echo "== $1 (last ${DAYS}d, $DS)"
  if [ "$PRINT" = 1 ]; then echo "$2"; return; fi
  local out; out="$(query "$2" 2>&1)" || true
  if ! jq -e . >/dev/null 2>&1 <<<"$out"; then echo "  (query failed: ${out:0:300})"; return; fi
  if [ "$(jq '(.data // []) | length' <<<"$out")" = 0 ]; then echo "  (none yet)"; return; fi
  jq -r '(.data // [])[] | [.[]] | @tsv' <<<"$out"
}

if [ "$REPORT" = usage ]; then
  # Every calendar's own deduplicated counts (RoomInsight.countHit), summed across pastecal: visits (a
  # visitor again after a gap), new visitors per calendar per day, and calendar-app followers (one per
  # subscriber per calendar per day). blob9 is a hash of the calendar, so calendars can be counted, never named.
  run "Per day: visits, visitors, calendar-app followers, calendars in use" \
"SELECT toDate(timestamp) AS day,
  SUM(_sample_interval * double1) AS visits,
  SUM(_sample_interval * double2) AS visitors,
  SUM(_sample_interval * double3) AS followers,
  COUNT(DISTINCT blob9) AS calendars
FROM $DS WHERE blob1 = 'cal_hit' AND $D GROUP BY day ORDER BY day"
  run "Whole window: calendars viewed in a browser vs followed in a calendar app" \
"SELECT blob6 AS how, COUNT(DISTINCT blob9) AS calendars, SUM(_sample_interval * (double1 + double3)) AS hits
FROM $DS WHERE blob1 = 'cal_hit' AND $D GROUP BY how"
  run "Whole window: calendars in use (viewed or followed at least once)" \
"SELECT COUNT(DISTINCT blob9) AS calendars_in_use
FROM $DS WHERE blob1 = 'cal_hit' AND $D"
  exit 0
fi

if [ "$REPORT" = trials ]; then
  # Pro trial funnel. Events from public/utils/analytics.js (trialStarted etc.), app.js, contact.html.
  # blob6 holds each event's one value: trial_surface | feature | interval | mode | action | type.
  T="'trial_started','trial_feature_used','trial_converted','trial_lapsed','trial_reminder_clicked'"
  run "Trial funnel: started -> used a Pro feature -> converted / lapsed" \
"SELECT SUMIf(_sample_interval, blob1 = 'trial_started') AS started,
  SUMIf(_sample_interval, blob1 = 'trial_feature_used') AS feature_uses,
  SUMIf(_sample_interval, blob1 = 'trial_reminder_clicked') AS reminder_clicks,
  SUMIf(_sample_interval, blob1 = 'trial_converted') AS converted,
  SUMIf(_sample_interval, blob1 = 'trial_lapsed') AS lapsed
FROM $DS WHERE blob1 IN ($T) AND $D"

  run "Trials started, by where the offer was opened (trial_surface)" \
"SELECT blob6 AS trial_surface, SUM(_sample_interval) AS started
FROM $DS WHERE blob1 = 'trial_started' AND $D GROUP BY trial_surface ORDER BY started DESC"

  run "Pro features used during a trial (once per feature per calendar per day)" \
"SELECT blob6 AS feature, SUM(_sample_interval) AS uses
FROM $DS WHERE blob1 = 'trial_feature_used' AND $D GROUP BY feature ORDER BY uses DESC"

  run "Trials converted, by plan interval" \
"SELECT blob6 AS plan_interval, SUM(_sample_interval) AS converted
FROM $DS WHERE blob1 = 'trial_converted' AND $D GROUP BY plan_interval ORDER BY converted DESC"

  run "Trials lapsed, by what the calendar became (mode)" \
"SELECT blob6 AS lapse_mode, SUM(_sample_interval) AS lapsed
FROM $DS WHERE blob1 = 'trial_lapsed' AND $D GROUP BY lapse_mode ORDER BY lapsed DESC"

  run "Around the funnel: subscribe nudge (by action), contact form (by type)" \
"SELECT blob1 AS event, blob6 AS detail, SUM(_sample_interval) AS n
FROM $DS WHERE blob1 IN ('subscribe_nudge','contact_submitted') AND $D GROUP BY event, detail ORDER BY event, n DESC"
  exit 0
fi

# quantileWeighted(q, value, weight): double7 is always 1, so weights are plain counts (sampling-aware).
run "Load time by browser x UI: views, p75 TTFB / FCP / LCP ms, p75 CLS" \
"SELECT blob3 AS browser, blob2 AS ui, SUM(_sample_interval) AS views,
  round(quantileWeighted(0.75, double1, _sample_interval)) AS ttfb_p75,
  round(quantileWeighted(0.75, double2, _sample_interval)) AS fcp_p75,
  round(quantileWeighted(0.75, double3, _sample_interval)) AS lcp_p75,
  round(quantileWeighted(0.75, double5, _sample_interval), 3) AS cls_p75
FROM $DS WHERE blob1 = 'page_perf' AND double3 > 0 AND $D GROUP BY browser, ui ORDER BY views DESC"

run "Time to first event by UI: people, median / p75 seconds" \
"SELECT blob2 AS ui, SUM(_sample_interval) AS first_events,
  round(quantileWeighted(0.5, double6, _sample_interval)) AS median_s,
  round(quantileWeighted(0.75, double6, _sample_interval)) AS p75_s
FROM $DS WHERE blob1 = 'event_added' AND double6 > 0 AND $D GROUP BY ui"

run "Editor abandonment: events added vs editors abandoned, by UI" \
"SELECT blob2 AS ui,
  SUMIf(_sample_interval, blob1 = 'event_added') AS added,
  SUMIf(_sample_interval, blob1 = 'editor_abandoned') AS abandoned
FROM $DS WHERE blob1 IN ('event_added','editor_abandoned') AND $D GROUP BY ui"

run "Trust: refused saves and errors by UI and detail" \
"SELECT blob1 AS event, blob2 AS ui, blob6 AS detail, SUM(_sample_interval) AS n
FROM $DS WHERE blob1 IN ('sync_refused','js_error','command_failed') AND $D GROUP BY event, ui, detail ORDER BY n DESC LIMIT 20"

run "Volume: all events by UI" \
"SELECT blob1 AS event, blob2 AS ui, SUM(_sample_interval) AS n
FROM $DS WHERE $D GROUP BY event, ui ORDER BY n DESC LIMIT 30"
