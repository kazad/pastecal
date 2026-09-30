# Moving pastecal from Firebase to Cloudflare

Started Sep 27, 2026, after one looping tab cost 14 GB of Firebase downloads in a day
(`docs/quality-whys.md`). Work through the phases in order; tick boxes as they land. Each
phase ends with something that is verified and can be rolled back.

## Why

- **Cost is bounded by design.** Cloudflare doesn't bill downloads. Workers Paid is $5/month
  and includes far more requests than we use. Saturday's loop would have cost about $0.05.
- **The server decides what is stored.** Today every browser writes the whole calendar and
  merges in the browser, which is where our data bugs came from. Here one Durable Object per
  calendar applies saves in order, with the SAME `EventStore` code the browser uses, and
  enforces rate and size limits no browser bug can skip.
- **Everything is code and runs locally.** `wrangler dev` runs the real Worker, Durable
  Objects and SQLite on a laptop, so every journey can run before anything ships.

## Architecture

```
browser ──WebSocket /cal/<id>/ws──▶ Worker ──▶ Durable Object "CalendarRoom" (one per calendar)
                                                 SQLite: meta, events, history
browser ──GET /cal/<id>──────────▶               (read-only views, ICS, checks)
Firebase fn (shadow) ──PUT /cal/<id>/import──▶   (phase 1-3 only)
```

Protocol and limits: `cloudflare/src/CalendarRoom.js` (header comment).

## Inventory: what Firebase does for us today

| Firebase piece | Used for | Cloudflare replacement | Phase |
|---|---|---|---|
| RTDB `calendars/<id>` + `CalendarDataService` (transaction, 3-way merge, write gate, journal) | the data and live sync | CalendarRoom + a `CloudCalendarService` in the browser | 1-2 |
| `calendars_readonly`, `syncPublicView`, `createPublicLink`, `indexReadOnlySlug` | view-only links | GET from the same room by a view id; no copy. Fixes the known leak (view data holds the edit id) | 3 |
| `slug_mappings`, `indexSlug`, `lookupCalendar` | case-insensitive names ("14WZW6WX" and "14wzw6wx" are BOTH real calendars) | a directory Durable Object (or D1 table): lowercase name -> actual name | 3 |
| `history`, `history_meta`, `recordHistory` | Recent changes, restore, "Edited N ago" | `history` table in each room, written in the same step as the save; `lastEditedAt` on the room | 2-3 |
| `calendar_authors` + anonymous auth (`AuthorSignal`) | who edits what (owner signal) | a per-browser id sent on connect, recorded in the room | 3 |
| `generateICSV2` at `/<name>.ics` | calendar-app subscriptions (~2,900 a day) | Worker route, same URLs, reading the room | 3 |
| Firebase Hosting + rewrites (`/beta`, `/nativecal/**`, `/dev/design`, `**`) | the site | Workers static assets (`public/`) with the same rewrites | 4 |
| `pro_accounts`, `pro_interest` | Pro prototype | later; not needed for cutover | - |
| Remote Config | nothing (template is empty) | drop | - |
| `updateEventIds`, `_internal` | one-off maintenance | drop | - |

## Phase 0 -- dry run (DONE, Sep 27)

- [x] Worker + CalendarRoom (SQLite Durable Object, hibernating WebSockets) in `cloudflare/`.
      `wrangler deploy --dry-run`: 22 KB, binding OK.
- [x] `test/sync.test.mjs` against `wrangler dev` on a real calendar (localPD copy): snapshot to
      two tabs, save -> ack + push, echo stores nothing, idle tabs silent, **a save loop is
      refused by the server** (37 stored, 63 refused in <1 s), bad batches refused whole,
      oversized fields refused, settings merge by key. 11/11.
- [x] Full-data dry run (`scripts/migrate.mjs`): all 8,548 calendars / 86,753 events imported
      locally and read back **identical, field for field and in order**; 16 duplicate ids
      given fresh ids.
- Found and fixed in the dry run: import must not normalize (it trimmed "James " -> "James");
  names must allow any Firebase key (153 real calendars have spaces, accents, "&", Hangul).

## Phase 1 -- shadow copy in production (no user-visible change)

- [x] Deploy `pastecal-sync` to workers.dev; `wrangler secret put IMPORT_SECRET`. (Sep 30)
- [x] Load every calendar (`scripts/migrate.mjs` against production), verify identical. (Sep 30: 8,613 calendars / 87,632 events, all identical; 17 duplicate ids renamed)
- [x] `new.pastecal.com` (Worker custom domain, serves `public/`, noindex; same rewrites as Firebase). Still reads Firebase data until Phase 2.
- [ ] Firebase function `shadowToCloudflare` on `calendars/{id}` writes -> PUT import.
      (Retries on failure; logs failures. Deployed with the existing functions.)
- [ ] `scripts/parity.mjs`: compare Firebase vs Cloudflare for every calendar edited in the
      last day; add to `stats.sh health`. Run for 3+ days: zero differences.
- Rollback: delete the function. Nothing reads from Cloudflare yet.

## Known gaps found in testing (fold into Phase 2)

- Two tabs editing the SAME event at once: the server keeps the later save, but the tab that
  lost keeps showing its own value. The client must re-sync (take the server's snapshot) when
  its ack shows another save landed first.
- A new event must carry an id chosen by the tab; the server refuses one without.

## Phase 2 -- the browser talks to Cloudflare, behind a flag

- [ ] `CloudCalendarService`: same interface the apps use (`findAndSubscribe`,
      `subscribe_readonly`, `debounce_sync`, `createWithId`, `checkExists`), over the WebSocket
      (`partysocket` for reconnect/backoff).
- [ ] Saves become commands: `EventStore.changesBetween(before, after)` -> `save`. Works for
      the main app and the beta without restructuring either. Title/options -> `meta`.
- [ ] Offline: unsent commands kept in the local journal, re-sent on reconnect.
- [ ] Reverse shadow: while the flag is on, the Worker copies each save back to Firebase, so
      other users (still on Firebase) see it.
- [ ] Flag: `?backend=cf` and a per-calendar allowlist. Full journey suite + idle-tab journey +
      multi-tab journeys against `wrangler dev`, then the beta on production.
- Rollback: turn the flag off.

## Phase 3 -- everything else the site needs

- [ ] Name directory (case-insensitive lookup, claim a name, reserved words).
- [ ] View-only links from the room, WITHOUT the edit id.
- [ ] ICS at the same URLs; compare output with Firebase's for 50 real calendars.
- [ ] Recent changes / restore from the room's history table.
- [ ] Author signal.
- [ ] Health checks (`stats.sh health`) read Cloudflare: edits, sizes, refused saves.

## Phase 4 -- cutover

- [ ] Worker serves the site too (static assets from `public/`, same rewrites).
- [ ] Route `pastecal.com/*` to the Worker (DNS record proxied). Firebase Hosting stays up.
- [ ] Keep copying writes back to Firebase for two weeks.
- Rollback: remove the route -> Firebase Hosting again, with current data (reverse shadow).

## Phase 5 -- turn Firebase off

- [ ] Stop the reverse shadow; export a final Firebase backup; disable the database and
      functions; remove the Firebase SDK from the pages.

## Costs (expected)

Workers Paid $5/month; our volume (under 1M requests/month, ~8.5k calendars, ~135 MB) fits
in what it includes. No per-GB download charges. A runaway loop is refused by the room; a
deliberate flood costs ~$0.30 per million requests beyond the included amount.

## Open questions

- Durable Object placement: each room lives near whoever first opened it. Fine for groups
  in one region; check latency for the few calendars used across continents.
- Very large calendars (2,442 events, 477 KB): snapshot on connect is fine; if needed later,
  send "changes since version" to reconnecting tabs.
