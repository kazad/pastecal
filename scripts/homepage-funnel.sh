#!/usr/bin/env bash
# Homepage funnel from our own event log (Cloudflare Analytics Engine, dataset pastecal_events).
# Usage: scripts/homepage-funnel.sh [days]   (default 7). Needs the `cf` CLI, logged in.
# Columns: blob1 event, blob6 detail (section, new/returning...), blob8 homepage variant.
set -euo pipefail
DAYS="${1:-7}"
q() { printf '%s FORMAT TabSeparated' "$1" > "$TMP"; cf analytics_engine sql query --file "$TMP" | python3 -c 'import json,sys; print(json.load(sys.stdin), end="")'; }
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
W="timestamp > NOW() - INTERVAL '$DAYS' DAY"

echo "== Homepage visits, by variant and new/returning (last $DAYS days)"
q "SELECT blob8 AS variant, blob6 AS visitor, SUM(_sample_interval) AS visits FROM pastecal_events WHERE $W AND blob1 = 'homepage_viewed' GROUP BY variant, visitor ORDER BY variant, visitor"
echo; echo "== How far down people read: sections seen (scroll funnel)"
q "SELECT blob6 AS section, SUM(_sample_interval) AS seen FROM pastecal_events WHERE $W AND blob1 = 'tour_seen' GROUP BY section ORDER BY seen DESC"
echo; echo "== Outcomes, by variant"
q "SELECT blob8 AS variant, blob1 AS event, SUM(_sample_interval) AS n FROM pastecal_events WHERE $W AND blob1 IN ('homepage_viewed','event_added','calendar_created','slug_claimed','calendar_shared','pricing_viewed','waitlist_joined') GROUP BY variant, event ORDER BY variant, n DESC"
