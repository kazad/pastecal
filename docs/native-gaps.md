# Native calendar: gap list

What the tests say about replacing Syncfusion's Schedule ("classic") with NativeCalendar ("native").
The plan is in [native-switch.md](native-switch.md). Measured Oct 25 2026 on branch `native-harness`
(pro + `native-audit`), against a local wrangler dev. Native means `/beta/<id>`, which opens in the v2 look
(`public/nativecal/index.html:101`; `?ux=1` gives v1).

## The numbers

| Suite | Before | After the test fixes |
|---|---|---|
| Audit, `test/native-audit` (213 tests: 71 journeys x desktop-en, desktop-de, phone-en) | 137 passed, 22 failed, 54 skipped | **153 passed, 6 failed, 54 skipped** |
| Data parity, `cloudflare/test/native-data-parity.spec.js` (new, 17) | | **14 pass, 3 expected failures (findings D1, D2)** |
| Unit, `node --test $(node test/unit-files.js)` | | 524 tests, 0 failed (a worktree needs the main checkout's `node_modules` and `functions/node_modules`) |

The 22 failures sort into:

| Class | Count | |
|---|---|---|
| Test drift (the test expected an older UI) | 16 | all fixed |
| Native missing feature | 5 | drag one repeating occurrence (2), embed `/beta/view` in an iframe (3) |
| Native bug | 0 | the audit found none; the data journeys found two (D1, D2 below) |
| Syncfusion bug / limit (classic fails) | 1 | classic loses a one-occurrence edit when another tab deletes the series |

The 54 skips: 38 are by design (a journey that runs in one project only), 16 are phone skips, and
10 of those are gaps nobody has checked on a phone (see Skips).

## Top native gaps, by user impact

Data loss first, then common actions. Only items a test (or a failing journey) confirmed.

1. **D1. Native's editor writes its whole form over the event (data loss).** Open an event in native,
   someone else renames it meanwhile, change the time and Save: the rename is silently undone.
   `public/nativecal/app.js:1250` (`handleSaveEvent`: `{ ...events[i], ...data }`, `data` being every
   editor field). Classic saves only the fields the person changed since the editor opened
   (`ScheduleAdapter.noteStart` / `changesFrom`). Journey c, native-saves-second direction.
2. **D2. Skipped dates of an all-day repeating event come back in other time zones.** A date skipped in
   Tokyo shows again for native viewers in Los Angeles and London; a date an LA classic user skipped shows
   for a native viewer in Tokyo. Native compares the stored EXDATE stamps raw
   (`public/nativecal/components/NativeCalendar.js:93` and `:110`), and `app.js:210` (`displayEvents`) maps
   an all-day series' rule to the viewer's dates but not its `recurrenceException`. Classic does both
   (`ScheduleAdapter.toView`, `public/services/ScheduleAdapter.js:164`, `Event.allDayExceptionsToLocal`).
   What native writes is right (classic reads its stamps correctly). People see a cancelled day as on.
   (Untested, from reading the code: editing or deleting that ghost occurrence would add a second stamp for
   the same date in the viewer's form.) Journey b3.
3. **Dragging one occurrence of a repeating event does nothing.** `NativeCalendar.js:466`
   (`startDrag` returns on `occ.recurring`, which is also true for an edited occurrence's own row, `:117`).
   Classic asks "this event or the series?" and stamps the exception. Audit: "drag a repeating occurrence"
   (desktop-en, desktop-de). Planned in native-switch.md step 3.
4. **No drag or resize on phones.** `NativeCalendar.js:466` and `:453` return on `isPhone`. Classic has
   none either (the audit skips both renderers), but the plan asks for long-press to drag.
5. **Drag to create a duration: v2 only, desktop only, and untested.** `NativeCalendar.js:453`
   (`!this.v2 || ... || this.isPhone`). No journey drags to create, in either renderer.
6. **Embeds: `/beta/view/<id>` refuses to be framed.** The worker sends `frame-ancestors 'none'` for
   everything but `/view/...` (`cloudflare/src/SecurityHeaders.js:30`, `isViewPath`). Not NativeCalendar's
   code: once native mounts in the main app at `/view/<id>` the header allows it, so re-run the embed
   journey then. Audit: "a view-only link in an iframe" (3 projects).
7. **The color filter works differently.** In the main app a chip shows only that type
   (`public/app.js:3522`, `soloColorFilter`); native's dots switch one type off (`public/nativecal/app.js:1535`,
   `toggleColorFilter`). Same data, different gesture; the audit now checks each renderer's own behavior.
8. **The `/beta` shell lacks the main app's features** (Share, Plus, print, the add page, templates, the
   "New event" draft block, as native-switch.md says). Not NativeCalendar gaps: they arrive with the
   main-app integration, and every journey here has to run there again (`NATIVE_URL=main` in the data spec).

Fewer than ten: nothing else the suites exercise fails on native. The open risks are the unchecked areas
below, not known bugs.

## Data-safety journeys (cloudflare/test/native-data-parity.spec.js)

Every journey asserts on `GET /cal/<id>`. The renderer is a parameter: `RENDERERS.native.open(page, id, query)`
opens `/beta/<id>?backend=cf` today; `NATIVE_URL=main` switches it to `/<id>?backend=cf&cal=native`.

| Journey | Result |
|---|---|
| a. Weekly series made in classic; native deletes Oct 13 and edits Oct 20 ("this event"); classic reloads | pass: series gets `20261013T170000Z,20261020T170000Z` (classic's exact `stamp()` form), the edit is its own row (`recurrenceID` = series, `recurrenceException` = its stamp, copy of the rule), nothing else changed |
| a. The reverse (made in native, edited in classic, native reloads) | pass |
| b. All-day: one-day and three-day events across the EU DST week (Oct 24-26) and the US one (Oct 31-Nov 2), made in each renderer in LA, Tokyo and London (6 runs); the other renderer draws the same dates in all three zones; opening and closing its editor stores nothing | pass (all 6) |
| b2. A no-op Save of all-day events made in Tokyo, from LA, in each renderer | pass: stored start/end unchanged, dates drawn as Tokyo meant |
| b3. All-day weekly series from Tokyo with a skipped date, drawn in LA, Tokyo and London | classic pass; native **expected failure, D2** (LA and London show the skipped Oct 13) |
| b3. Native in LA skips another date; stored stamps; classic in Tokyo reads it | pass: existing stamp kept verbatim, new one in stamp form, dates and rule unchanged, classic hides it |
| b3. Classic in LA skips another date; native in Tokyo reads it | **expected failure, D2** (native in Tokyo shows Oct 20) |
| c. Classic renames while native moves the time, both editors open; classic saves first | **expected failure, D1**: the title goes back to the old one |
| c. Native renames while classic moves the time; native saves first | pass (classic's save keeps native's title) |
| d. Drag an event an hour later in native week view | pass: stored start/end are ISO strings, 90-minute duration kept, other fields unchanged, classic draws it at 12:00 PM |

Not covered yet: two saves on the same event landing within one sync (untested; from reading
`CalendarDataService._mergeEvents`, which merges whole rows, the later save would win in either renderer);
"this and following" across renderers; moving an all-day event by drag.

## Every audit failure (baseline: 22)

| Test | Projects | Class | Notes |
|---|---|---|---|
| syncfusion: delete a single event, then undo with Cmd/Ctrl+Z | en, de, phone | test drift, fixed | No "Are you sure?" since the Undo toast: `app.js` `popupOpen` presses Syncfusion's DeleteAlert for the person. The harness clicked the confirm, which only flashes. |
| syncfusion: undo a delete with the on-screen Undo | en, de | test drift, fixed | same |
| syncfusion: a view-only link shows events and offers no editing | en, de, phone | test drift, fixed | Syncfusion draws its edit and delete icons disabled on a read-only calendar; the test now counts enabled ones. (Cosmetic Syncfusion limit: native shows none.) |
| syncfusion: DST day, events sit at their wall-clock hour | en | test drift, fixed | The gutter reads "10:00 AM" since the 5:30 PM time format. |
| syncfusion: click a day, type a title, save | phone | test drift, fixed | Classic phones have no quick box: a tap marks "+ New event", a second tap opens the editor. |
| syncfusion: offline edit is saved after reconnect | phone | test drift, fixed | same quick-box step |
| syncfusion: settings, Monday first, 24-hour time | phone | test drift, fixed | On a phone the 24-hour gutter reads "13", "14". |
| syncfusion: search panel, color filter | en, de | test drift, fixed | Chips solo a type now; see gap 7. |
| native: offline edit is saved after reconnect | phone | test drift, fixed | The harness tapped a fixed spot in the Oct 12 cell, where the Team standup bar sits; it now taps the cell's empty lower edge. Passes after. |
| fix2: event_added ... fire from native | en | test drift, fixed | The parameter is `add_via` since f601004 (GA4 reads `source` as a traffic source). Native sends it. |
| native: drag a repeating occurrence | en, de | native missing feature | gap 3 |
| native: a view-only link in an iframe (embed) | en, de, phone | native missing feature (route) | gap 6 |
| syncfusion: editing one occurrence while another tab deletes the series | en | Syncfusion bug | Classic drops the edit with no message (page error "Cannot read properties of undefined (reading 'RecurrenceRule')"). Native keeps it as a separate event and says so (fix1 passes). |

## Skips (54)

| Reason | Count | Gap? |
|---|---|---|
| Runs in one project only (`fix1`-`fix9` desktop-en or desktop-de, the two race tests and the locked-calendar redirect "once is enough") | 38 | no, by design |
| Phone: drag, resize, drag a repeating occurrence, both renderers ("no touch drag in either renderer") | 6 | yes: neither renderer supports it (gap 4); nobody tests long-press |
| Phone: two tabs, live sync | 2 | unchecked on phones (same sync code; low risk) |
| Phone: DST day geometry | 2 | unchecked: the native time grid on a phone at a DST change |
| Phone: search panel and color filter | 2 | unchecked on phones |
| Phone: keyboard (arrows, Escape, Tab) | 2 | no, not a phone action |
| Phone: native data contract (all-day + weekly BYDAY + COUNT); fix3 (self-hosted Vue) | 2 | no, device-independent |

Also unchecked: drag to create; native's v1 look (`?ux=1`, which the main-app integration may or may not
use); that native mode downloads no Syncfusion JS or CSS (native-switch.md asks for that test).

## Running it

Local only. Start a wrangler dev with its own data folder:

    cd cloudflare && node node_modules/.bin/wrangler dev --port 8882 --inspector-port 9782 \
      --persist-to $(mktemp -d) --show-interactive-dev-session=false \
      --var IMPORT_SECRET:dev-secret --var COPY_BACK: --var FIREBASE_DB_URL: --var ACCOUNTS_DEV_MODE:1

    # audit (about 13 minutes; per project with --project desktop-en|desktop-de|phone-en)
    AUDIT_BASE=http://127.0.0.1:8882 AUDIT_IMPORT_SECRET=dev-secret OUT=<scratch dir> \
      npx playwright test -c test/native-audit/playwright.config.js
    node test/native-audit/summarize.js <scratch dir>/results.json

    # data parity (about 4 minutes)
    BASE_URL=http://localhost:8882 npx playwright test -c cloudflare/playwright.config.js native-data-parity

The audit writes screenshots to `OUT` (default `test/native-audit/out/`, never commit it).

On a machine shared with other agents, a wrangler started from inside `.claude/worktrees/` was stopped
(SIGTERM) every 30-60 seconds by something outside this repo, which shows up as `fetch failed` /
ECONNREFUSED failures. Running the same server from an APFS copy of `cloudflare/` and `public/`
outside `.claude/` (`cp -c -R`) kept it up for the whole run. The numbers above come from runs with no
restarts.
