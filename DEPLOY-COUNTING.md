# Deploy: per-calendar stats counting (branch `prod-counting`)

This turns on stats **counting** in production so history starts accumulating before Pro launches.
Nothing is shown to anyone. No stats endpoint, no Pro UI, no lock, billing or trial code, no client changes.

## What's in it (vs `homepage-tour` 6e6a63d, the code live on pastecal-sync)

- `cloudflare/src/RoomInsight.js` (new): the counting half of the Pro branch's file, copied verbatim.
  It includes `countHit`, the daily salt and hash set, the caps, and the `stats_daily`, `stats_seen`
  and `stats_salt` tables with their migrations (`views`, `apps_json`, `hours_json`, `sources_json`).
  The tables are identical to Pro's, so Pro's report reads this history unchanged. Restore and
  `statsReport` are not included.
- `cloudflare/src/Insight.js` (new): `isBot`, `hitHeaders` and `withoutSourceParams`, plus the
  `stats-dump` test hook. The hook needs both `ACCOUNTS_DEV_MODE=1` **and** the `IMPORT_SECRET`
  bearer, exactly as on Pro. Production never sets `ACCOUNTS_DEV_MODE`, so there it always answers 403.
- `cloudflare/src/CalendarRoom.js` (+15 lines):
  - The constructor creates the stats tables. They are additive only (`CREATE TABLE IF NOT EXISTS`,
    `ADD COLUMN` in try/catch). The whole step is wrapped in try/catch: if it ever failed, the
    calendar would still open and simply not be counted.
  - `fetch` calls `countHit` without awaiting it, with a `.catch` that logs `[stats] count failed`.
    Counting cannot fail or delay a read or a write.
  - `stats-dump` answers only `http://internal/...` requests.
- `cloudflare/src/index.js` (+30 lines):
  - What gets marked:
    - `GET /cal/<id>`, `/cal/<id>/ws`, `/cal/view/<id>` and `/cal/view/<id>/ws` are marked as views.
    - `/<id>.ics` and `/view/<id>.ics` are marked as follows.
    - Bots, crawlers and curl are never marked.
  - Every public request forwarded to a room goes through `forRoom`. It strips any `X-PC-*` header
    the client sent, so nobody can forge a hit, and it drops `Referer`.
  - Old clients send no `?src`, so the source falls back to Referer and Sec-Fetch-Dest. A URL
    without `embed`, `ref` or `src` is forwarded exactly as it came.
- `wrangler.jsonc` and `public/` are byte-identical to 6e6a63d. The bindings are exactly live's:
  CALENDARS, DIRECTORY, WAITLIST, BACKUPS (pastecal-backups), EVENTS (pastecal_events),
  CREATE_LIMITER, ASSETS, FIREBASE_DB_URL and COPY_BACK. The migrations are v1 to v3, which is
  live's tag v3, so there is no new migration. There is no cron and no `scheduled` handler, as live.
- Everything else in 6e6a63d is unchanged: the waitlist, the `/api/collect` collector and archive.
- Tests:
  - `test/unit/room-insight-breakdowns.test.js` (ported from Pro).
  - `test/unit/room-insight-counting.test.js`: caps, roll-over, privacy, migration over the
    base's schema, the Worker half, and a check that Pro's report reads these rows.
  - `cloudflare/test/stats.test.mjs` (ported from Pro; reads rows through the dev dump).
  - `cloudflare/test/master-compat.test.mjs`: seeds rooms with the base's (6e6a63d) code, then checks that the
    new code reads them byte-identically.

## Why this base

Production `pastecal-sync` is deployed by hand. The live version (1c8475eb: a secret change on top
of the code uploaded 2026-10-23 21:45 UTC) matches branch `homepage-tour` at 6e6a63d, not
`master`. Checked read-only with `wrangler versions view`:
- Bindings: same as this branch (WAITLIST included).
- Migration tag: v3.
- Handlers: `fetch` plus the CalendarRoom, CalendarDirectory and Waitlist classes; no `scheduled`.
- Compatibility date: 2026-09-01.
- `_headers` and `run_worker_first`: byte-identical to 6e6a63d's.

This branch is 6e6a63d plus one commit, with only the counting.

## Before deploying (read-only)

```sh
cd ~/worktrees/pc-prod-counting-live/cloudflare
npx wrangler deployments list --name pastecal-sync   # the live version must still be 1c8475eb (or a later secret change on it)
npx wrangler versions view <live-version-id> --name pastecal-sync   # bindings as above, incl. WAITLIST
npx wrangler secret list --name pastecal-sync         # names only; ACCOUNTS_DEV_MODE must NOT be there
```

If a newer code upload is live, stop and rebase this branch onto the code it came from.

## Deploy (owner)

Deploy from this worktree only: not from the main checkout, not from `master`.

```sh
cd ~/worktrees/pc-prod-counting-live/cloudflare
npx wrangler deploy --dry-run --outdir .dry-run   # bindings: CALENDARS, DIRECTORY, WAITLIST, BACKUPS, EVENTS, CREATE_LIMITER, ASSETS, FIREBASE_DB_URL, COPY_BACK
npx wrangler deploy                                # Worker: pastecal-sync
```

## After deploying: this branch is the production baseline

`prod-counting-live` becomes what production runs. The next production deploy must start from it,
or contain it, or counting quietly stops: a gap in the history, not an outage. `master` does
**not** contain it, nor 6e6a63d's Waitlist and other changes. Before anyone deploys from `master`,
reconcile: merge `prod-counting-live` (and so `homepage-tour`) into master.

When `pro` merges, these files conflict:
- `RoomInsight.js`, `Insight.js`, `cloudflare/test/stats.test.mjs` and
  `test/unit/room-insight-breakdowns.test.js`
- the `CalendarRoom.js` and `index.js` hunks

Take pro's side for all of them. The table schema is identical, so no data migration is needed.

## Verify after deploy (read-only)

curl's user agent counts as a bot, so none of these checks are counted.

```sh
# 1. The new code is live. Run this once BEFORE deploying (it must not be 403) and again after:
#    this branch answers 403 "forbidden" (always, in production: no ACCOUNTS_DEV_MODE).
curl -s -o /dev/null -w '%{http_code}\n' https://pastecal.com/api/admin/cal/x/stats-dump      # after: expect 403

# 2. Calendars still read as before. Use a calendar you own: expect 200 and the same JSON, and the
#    feed's ETag the same as before the deploy.
curl -s -o /dev/null -w '%{http_code}\n' "https://pastecal.com/cal/<your-calendar>"
curl -sI "https://pastecal.com/<your-calendar>.ics" | grep -i -E '^(HTTP|etag)'

# 3. No counting errors. Open pastecal.com in a browser meanwhile; nothing should match.
npx wrangler tail pastecal-sync --search "[stats]"
```

Nothing in production reads the counts yet, by design. The first read is Pro's room `stats` route
(`/api/stats`, `/api/pro/stats`) when Pro ships.

Note: preview.pastecal.com's Worker uses pastecal-sync's own calendar rooms.
- Preview traffic will be counted too. It is real calendars, with the same bot and privacy rules.
- Preview's `/api/stats` keeps answering `503 stats-unavailable`, because this branch does not add
  the room's `stats` read route.

## Roll back

```sh
cd ~/worktrees/pc-prod-counting-live/cloudflare
npx wrangler rollback --name pastecal-sync     # back to the previous version
```

Or redeploy the base: `git -C ~/worktrees/pc-prod-counting-live switch --detach 6e6a63d`, then
`cd cloudflare && npx wrangler deploy`, then `git switch prod-counting-live` to come back.

The stats tables stay in each room. 6e6a63d never reads them, so they are inert. Redeploying this
branch later picks up where it stopped.
