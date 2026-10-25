# Retire Firebase: Cloudflare as the only backend

Status: plan only (Oct 24, 2026). Nothing in it has been run against production. The evidence comes from branch `pro`
(`~/worktrees/pastecal-pro`), checked against `master` where they differ, plus two read-only `curl -sI` requests to
pastecal.com. This continues `docs/cloudflare-migration.md`. That doc's Phase 4 boxes were never ticked, but the code
and the live headers show Phase 4 has shipped. Its Phase 5 ("turn Firebase off") is what this plan covers.

---

## 0. Before anything else: rotate the import secret (owner, today)

`cloudflare/scripts/backfill-directory.mjs:23` has a hardcoded fallback value for `IMPORT_SECRET`. That file was committed
in `6374921` ("Phase 4 Cutover…"), which is on `origin/master` of **kazad/pastecal, a PUBLIC repo**. The value is not
repeated here.

If it is (or ever was) production's `IMPORT_SECRET`, anyone can do all of the following:

- `PUT /cal/<id>/import`: replace any unlocked calendar outright (`cloudflare/src/index.js:410-414`, `CalendarRoom.js:756-760`)
- `PUT /cal/<id>/from-firebase`: merge arbitrary data into any calendar
- `POST /api/directory/backfill`: rewrite name→calendar mappings, including view ids (`index.js:362-369`, `CalendarDirectory.js:146-162`)
- `POST /cal/<id>/archive`, plus `/api/admin/cal/<id>/{lock,unlock,rotate-editor-key}` and `/api/admin/test-inbox`

What the owner should do:
1. Generate a new secret. Set it as the Worker secret (`wrangler secret put IMPORT_SECRET`) and on Firebase
   (`firebase functions:secrets:set CLOUDFLARE_IMPORT_SECRET`) in the same sitting. Then redeploy `shadowToCloudflare`, or
   delete it (step 4) if you are past that point. If the two secrets disagree, the shadow gets 403s and logs `shadowToCloudflare FAILED`
   (functions/index.js:1830). That fails safe.
2. Replace the literal with `process.env.IMPORT_SECRET` and refuse to run without it. A plain commit is enough once the secret is
   rotated: history still holds the old value, but it is dead.
3. Check Worker logs for `/import`, `/from-firebase` and `/api/directory/backfill` calls since that commit date (`cf observability telemetry query`).

`internal/keys/` (the Firebase admin SDK key the same script reads) is git-ignored (`.gitignore:10`) and has never been tracked.

---

## 1. Where things stand (evidence)

### Who serves pastecal.com (read-only `curl -sI`, Oct 24 23:59 UTC)

| Request | Discriminating headers | Served by |
|---|---|---|
| `https://pastecal.com/` | `server: cloudflare`, `cf-cache-status: HIT`, `cache-control: public, max-age=0, must-revalidate` (the Workers static-assets default; firebase.json would send `no-cache, no-store, must-revalidate`); no `x-served-by`/`x-cache` (Fastly, which Firebase Hosting uses) | **Worker `pastecal-sync` assets** |
| `https://pastecal.com/demo.ics` | `content-type: text/calendar; charset=utf-8`, `content-disposition: inline; filename="demo.ics"` (set only by the Worker, `cloudflare/src/index.js:205`; `generateICSV2` never sets it), `etag` | **Worker ICS route** |

This matches `cloudflare/wrangler.jsonc:9-13` (routes `pastecal.com/*`, `www.pastecal.com/*`, `new.pastecal.com`) and
`run_worker_first` for `/*.ics` and `/view/*.ics` (lines 31-32). **Legacy feed URLs on pastecal.com already reach the
Worker. No ICS subscriber on pastecal.com depends on `generateICSV2`.**

`generateICSV2` and the whole Firebase-backed site can still be reached on Firebase's own hosts:
`https://pastecal-web.web.app`, `https://pastecal-web.firebaseapp.com` (default Hosting sites for project
`pastecal-web`, `.firebaserc`) and the function's `cloudfunctions.net` URL. These were not probed (production rule). The owner should check them.

### Which backend the browser uses

- `public/services/CloudCalendarService.js:54-65` (pro): `enabled()` returns true on `HOSTS = ['pastecal.com',
  'www.pastecal.com','new.pastecal.com','preview.pastecal.com']`, ignoring `?backend=firebase`. When it returns true, the last line
  (`:614`) sets `CalendarDataService = CloudCalendarService`.
- **On `master` this differs.** `master:public/services/CloudCalendarService.js:46-52` checks `?backend=firebase` *before*
  the host check, so `pastecal.com/x?backend=firebase` sends that browser back to Firebase, which is world-writable
  and a way around a Pro lock. **Owner question: which branch is deployed to `pastecal-sync`?** If it is master,
  merging pro's `enabled()` comes first.
- Every other host takes the Firebase path: localhost (the whole e2e/journey suite), `pastecal-web.web.app` and `firebaseapp.com`.

### The bridge between the two databases (both directions are live)

```
Firebase RTDB calendars/<id>  ──onValueWritten: shadowToCloudflare──▶  PUT /cal/<id>/from-firebase  (merge)
        ▲                                                                     │
        └──── CalendarRoom.alarm(): GET (ETag) → fromFirebase(remote) → PUT If-Match ◀── every CF save (COPY_BACK="*")
```

- **Shadow (Firebase → CF):** `functions/index.js:1806-1835`. It fires on every write to `calendars/{id}` and skips deletes
  ("Cloudflare copy left as is").
- **Copy-back (CF → Firebase):** `CalendarRoom.js:937-1074`. It is on when `COPY_BACK` matches (`wrangler.jsonc:57-60`: `"*"`), when
  `FIREBASE_DB_URL` is set, and when the `FIREBASE_SA` secret exists (`copyBackAllowed`, :951-959; key made by
  `cloudflare/scripts/setup-copyback.sh`). It is skipped for locked calendars (:955). The alarm **first reads Firebase and merges
  it into the room** (:1053-1058) and only then writes back. So copy-back is also an *inbound* path: any write to
  Firebase (world-writable per `database.rules.json:6-11`) lands in the CF room on the next save.
- Each copy-back PUT is a Firebase write, so it fires **all** the `calendars/{id}` triggers: `recordHistory` (:1556),
  `syncPublicView` (:1514), `indexSlug` (:1440) and `shadowToCloudflare` (a no-op echo, thanks to `mirrored`). This is the only
  reason `history`, `history_meta`, `calendars_readonly` and `slug_mappings` in Firebase are still current.
- The doc comment at functions/index.js:1807 ("Firebase is still the source of truth") is stale. Cloudflare is the source of truth.

### How calendars got to Cloudflare (no lazy import)

- Bulk: `cloudflare/scripts/migrate.mjs` (Sep 30: 8,613 calendars / 87,632 events, all identical) and a `MODE=merge`
  catch-up pass. Names: `cloudflare/scripts/backfill-directory.mjs` (from `slug_mappings`, shallow `calendars`, and
  `calendars_readonly`).
- Ongoing: `shadowToCloudflare` for every Firebase write. `importCalendar`/`fromFirebase` registers the name in
  `CalendarDirectory` (`CalendarRoom.js` ~:817, :847 `registerInDirectory`).
- **There is no lazy import on first open.** Nothing in the Worker reads Firebase on a miss (`firebaseFetch` is
  only called from `alarm()`), and `CalendarDirectory.js` has no Firebase fallback. A calendar that exists only in
  Firebase is simply a 404 / "create new" on pastecal.com. Firebase-only calendars can come from:
  shadow failures (size limit, a 403 after a secret mismatch, timeouts; logged as `shadowToCloudflare FAILED`), writes refused because
  the room is locked, deletes (never propagated), and anything written to Firebase before Sep 30 that the catch-up missed.

---

## 2. Dependency table

Risk: **H** = data loss, a security hole, or a user-visible break if handled wrong; **M** = a visible regression or a blind spot; **L** = cleanup.

| # | Component | How it depends on Firebase (evidence) | Replacement | Risk |
|---|---|---|---|---|
| 1 | Production `IMPORT_SECRET` | Literal in a public repo (`backfill-directory.mjs:23`) | Rotate; env only | **H** |
| 2 | `updateEventIds` Cloud Function | Unauthenticated `functions.https.onRequest` that reads and **rewrites every calendar** (`functions/index.js:1596`) | Delete; nothing uses it | **H** (if deployed) |
| 3 | RTDB `calendars/$id` rules | `.read/.write: true` (`database.rules.json:6-11`): anyone can write, and it flows into CF through the shadow and the copy-back merge | Freeze `.write: false` (the service account bypasses rules, so copy-back still works) | **H** |
| 4 | `shadowToCloudflare` (fn) | Firebase writes → `/from-firebase` (`functions/index.js:1813`) | Nothing; delete once Firebase is frozen | M |
| 5 | Copy-back (Worker) | `COPY_BACK="*"`, `FIREBASE_DB_URL`, secret `FIREBASE_SA` (`wrangler.jsonc:57-60`, `CalendarRoom.js:951-1074`) | Off: `COPY_BACK=""`, then delete `FIREBASE_SA` and the SA | **H**: the point of no return for rollback |
| 6 | `/cal/<id>/from-firebase`, `/import` routes | Firebase write path into rooms (`index.js:402-414`, `CalendarRoom.js:756-768`) | Drop `/from-firebase`; keep `/import` (secret) for restores, or move restores to R2 | M |
| 7 | Main page Firebase SDK | `public/index.html:163-166` loads app/database/auth/functions compat; `:181 initializeApp` | Remove once 8-12 are gone | M |
| 8 | Anonymous auth → author identity | `index.html:196 signInAnonymously` ("[auth] anonymous sign-in"); `AuthorSignal.uid()` = Firebase uid (`AuthorSignal.js:35-42`), sent as `?author=` on the socket and in saves (`CloudCalendarService.js:86-92, 415-421`); the room records it (`CalendarRoom.js:696-700, 1124-1125`, `authors` table) | A **server-asserted** per-browser id: a Worker-issued signed HttpOnly cookie (e.g. `pc_bid`), read by the Worker and passed to the room like `X-PC-User`. Not localStorage (AuthorSignal.js:9-13 explains why). Today the room trusts whatever `author` the client sends, so the Firebase uid is already unverified on the CF path | M |
| 9 | `AuthorSignal.touch/creationRecord` | Writes `calendar_authors/<id>/<uid>` in Firebase from the browser on edits (`AuthorSignal.js:97-136`; called at `app.js:2430, 3612`, `nativecal/app.js:1218, 1233, 1261`). The rule requires `calendars/<id>` to exist in Firebase (copy-back keeps that true) | Room `authors` table (exists); delete the Firebase writes | L (observational) |
| 10 | "Edited N ago" live label | `app.js:3821-3846 watchLastEdited`: a persistent RTDB listener on `/history_meta/<id>/lastEditedAt` and `.info/serverTimeOffset` for **every open calendar on pastecal.com** (an RTDB connection per tab) | The snapshot already carries `lastEditedAt` (`CalendarRoom.js:214, 242`; `CloudCalendarService.js:259, 355, 456`); the app already falls back to `calendar.lastEditedAt` (`app.js:3873`). Server clock: Worker `Date` header or a `now` field in the snapshot | M |
| 11 | Recent changes / undo fallback | `app.js:3671-3676`: if the room's `/history` is empty, read Firebase `/history/<id>` (pre-migration history; the room only has history since its import) | Accept the loss of pre-cutover history, or import the last 20 Firebase history entries per calendar into the room once (new import route, or an extension of `/import`). Decide before the freeze | M |
| 12 | nativecal / beta | `nativecal/index.html:111` full `firebase-compat.js`, `:132 initializeApp`; `nativecal/app.js:2132` one-off `/history_meta` read; it does load `CloudCalendarService.js` (:148) | Same as 10; drop the SDK | L |
| 13 | `CalendarDataService` base class | `static db = firebase.database().ref('/calendars')` at class-definition time (`CalendarDataService.js:4-5`); `CloudCalendarService extends` it, so **the page breaks if the SDK is removed** while the base class touches `firebase` at load. `_serverNow` (:462-467) also touches `firebase`. Not overridden by Cloud: `create`, `update`, `delete` (:870-909), which are unused by the apps (grep) | Make `db` lazy or delete it; fold Cloud into the base class or strip the Firebase methods; remove `_sanitizeForFirebase` naming last | M |
| 14 | `lookupCalendar` / `createPublicLink` | Callables (`functions/index.js:1373, 1568`); the client uses them only when Cloud is off (`CalendarDataService.js:913-925`). The Worker has same-name compat routes (`index.js:6-8`) | Already replaced; delete the functions | L |
| 15 | View-only links | `calendars_readonly` + `syncPublicView`/`removePublicView`/`indexReadOnlySlug`/`createPublicLink` (fns); kept current only by copy-back | Worker `/cal/view/<id>` + directory (`index.js:375+`). Firebase copies are a legacy leak (the view holds the edit id) | L |
| 16 | Name directory | `slug_mappings` + `indexSlug` | `CalendarDirectory` DO (backfilled, registered on create/import) | L |
| 17 | ICS feeds | `generateICSV2` + `firebase.json` rewrite `/**/*.ics` (firebase.json:18-21) | Worker `/*.ics`, `/view/*.ics` already serves pastecal.com (headers above). Only web.app/firebaseapp.com/cloudfunctions.net URLs still reach the function | L, M if subscribers use the Firebase hosts |
| 18 | ICS stats | `recordIcsStat` → `calendar_stats` + `sweepDeviceBuckets` (scheduled, `functions/index.js:277`) | Worker counts follows (`index.js:182-183`, Insight.js) | L |
| 19 | Firebase Hosting | `firebase.json` hosting + rewrites; `deploy.sh` (`firebase deploy --only hosting`, :181-195), `deployhosting.sh` | Worker static assets (live) | M: pastecal-web.web.app / firebaseapp.com serve a **full, working Firebase-backed copy of the site**, and Cloud is off there |
| 20 | Pro prototype | `public/dev/pro.js:35-167` writes `pro_interest`, uses email-link auth and the `createProCheckout` callable (exported only if `PRO_BILLING=on`, functions/index.js:1800); rules `pro_accounts`, `pro_interest` | Worker `Accounts.js` / `Waitlist.js` (live). Delete `public/dev/pro.*` | L |
| 21 | Dead client code | `public/js-old-components/` (firebase.js, app.js, ShareOrClaimUI.js) is still served as static assets | Delete | L |
| 22 | CSP | `public/_headers:11,17` and `cloudflare/src/SecurityHeaders.js:18-23` allow `*.firebaseio.com`, `wss://*.firebaseio.com`, `pastecal-web.firebaseapp.com`, `apis.google.com` | Remove after 7-12 | L |
| 23 | Ops scripts | `scripts/health.py:23,53` and `cloudflare/scripts/parity.mjs` choose calendars from Firebase `/history_meta` (only current because copy-back fires `recordHistory`); `scripts/restore-calendar.js`, `migrate-public-views.js`, `deploy-rules.sh`, `test-rules.sh` | Health from Worker data (`/api/directory/stats`, Analytics Engine `pastecal_events`, R2 `snapshots/`). **Must move before copy-back stops, or health goes blind** | M |
| 24 | Release gate and journeys | `deploy.sh` gate + `playwright.config.js:31`, `playwright.journeys.config.js:42` run `firebase serve -p 8000` on localhost, where **Cloud is off, so the gate tests the Firebase path production no longer runs**. Journeys read and write the **production RTDB** directly (`test/journeys/journeys.spec.js:67, 315`; `test/e2e/write-safety.spec.js:47`) and so feed test calendars into CF through the shadow | Run the journeys against `wrangler dev` (`cloudflare/playwright.config.js` already uses :8787) with assertions via `GET /cal/<id>` | **H** for confidence: today's gate does not cover production |
| 25 | Emulator unit tests | `test/unit/*.emulator.test.js` (lookup, slug-twins, last-edit-stamp, author-rules, history-service, ics-device-buckets), `test/run-emulator-tests.sh` | Delete with the functions; CF equivalents in `cloudflare/test/` | L |
| 26 | Remote Config | `firebase.json` `remoteconfig`, empty template | Drop | L |

---

## 3. Retirement plan (ordered, each step reversible until step 6)

Each step: **do** → **verify** → **rollback**. Keep a fixed number of days between steps so logs can show anything that broke.

### Step 0: Secret rotation and dangerous endpoints (owner, now)
- Do: rotate `IMPORT_SECRET` / `CLOUDFLARE_IMPORT_SECRET` (§0). `firebase functions:list` → if `updateEventIds` is
  deployed, `firebase functions:delete updateEventIds`.
- Verify: `shadowToCloudflare` logs show no `FAILED` after rotation; an old-secret `PUT /import` against **wrangler dev
  only** returns 403 (`hardening.test.mjs` style).
- Rollback: none needed. Restoring the old secret would reopen the hole.

### Step 1: Confirm which branch is live; ship pro's `enabled()` (code, owner deploys)
- Do: make sure the deployed `CloudCalendarService.enabled()` ignores `?backend=firebase` on our hosts (pro `:54-58`).
- Verify: `test/unit/cloud-calendar-service.test.js` and `test/unit/preview-site.test.js` (host cases). On production, open
  `pastecal.com/<name>?backend=firebase` and confirm the WebSocket goes to `/cal/<name>/ws` (owner).
- Rollback: redeploy the previous Worker version (`wrangler rollback`).

### Step 2: Measure what still lives only in Firebase (read-only, owner runs)
See §5 for the commands. Outputs: (a) ids in Firebase `calendars` not in the CF directory; (b) ids where Firebase's
`lastEditedAt` is newer than CF's; (c) `shadowToCloudflare FAILED` count over 30 days; (d) `ICS served` count of
`generateICSV2` and hits on web.app/firebaseapp.com over 14 days.
- Rollback: n/a (read-only).

### Step 3: Move the release gate and ops scripts onto Cloudflare (code, can be done now)
- Do: point `playwright.config.js` / `playwright.journeys.config.js` at `wrangler dev` (`cd cloudflare && npx wrangler dev`,
  with a local `FIREBASE_DB_URL=""`, `COPY_BACK=""`); replace `firebase.database().ref(...)` assertions with
  `fetch('/cal/<id>').then(r => r.json())`; seed through `POST /cal/<id>` or `PUT /import` (dev secret). Change
  `deploy.sh` to gate `wrangler deploy` instead of `firebase deploy --only hosting`. Rewrite `health.py` and `parity.mjs` to
  choose calendars from Worker data (R2 `snapshots/<id>/<today>` listing or Analytics Engine) instead of `/history_meta`.
- Verify: the suite is green on `wrangler dev`; deliberately break `CloudCalendarService._sendSave` and confirm it fails red.
- Rollback: the old configs stay in git; revert the commit.

### Step 4: Freeze Firebase to the world; stop the inbound bridge (owner deploys rules + functions)
- Do (in order):
  1. Rules: `calendars/$id/.write: false`, `calendar_authors` `.write: false`, `pro_interest` `.write: false` (deploy via
     `scripts/deploy-rules.sh`). The copy-back service account (`roles/firebasedatabase.admin`) bypasses rules, so Firebase
     stays a current mirror for rollback.
  2. Client: remove the browser-side Firebase writes `AuthorSignal.touch/creationRecord` (they would start failing
     anyway). Keep `signInAnonymously` for now, because the uid is still the author id (item 8).
  3. `firebase functions:delete shadowToCloudflare` (nothing writes to Firebase except copy-back, whose echo it ignores).
- Verify: an anonymous REST write `curl -X PUT .../calendars/test-freeze.json` → `Permission denied` (owner, one
  throwaway id, ideally against the emulator with the same rules first: `scripts/test-rules.sh`); copy-back keeps working
  (`copyBack FAILED` absent from Worker logs; a CF edit shows up in Firebase within ~5 s); web.app/firebaseapp.com now show
  "can't save" (expected: they are frozen copies).
- Rollback: redeploy the previous `database.rules.json` and the `shadowToCloudflare` function.

### Step 5: Remove the browser's remaining Firebase reads; replace author identity (code, owner deploys)
- Do: (a) `watchLastEdited` → snapshot `lastEditedAt` plus pushed `meta`/`change` (already updates `room.server.lastEditedAt`), server clock
  from the Worker; (b) the `loadUndoEntries` Firebase fallback → room only (after the decision in item 11; if keeping old
  history, run a one-time history import now while Firebase is still current); (c) the nativecal `history_meta` read → `calendar.lastEditedAt`;
  (d) author id → Worker-issued signed cookie (the Worker sets it on the first `/cal/*/ws` upgrade and passes it to the room as a trusted
  header; the room ignores a client-sent `author`); map old Firebase uids by recording both for a transition window if continuity matters;
  (e) make `CalendarDataService` load without `firebase` (lazy `db`, no `_serverNow` Firebase path); (f) drop the SDK script tags,
  `firebaseConfig`, and the CSP entries; delete `public/dev/pro.*` and `public/js-old-components/`.
- Verify: on pastecal.com (owner), DevTools shows no requests to `*.firebaseio.com`, `gstatic.com/firebasejs`,
  `identitytoolkit`, or `securetoken`; "Edited N ago" updates when another tab edits; Recent changes lists entries.
- Rollback: `wrangler rollback` to the previous version (Firebase is still current through copy-back, so nothing is lost).

### Step 6: Stop copy-back (owner; the POINT OF NO RETURN)
After this, Firebase goes stale, and rolling back to Firebase Hosting would lose every edit made after this moment. From here on,
the fallback is the R2 snapshots (`backupToR2`, `docs/backups.md`), not Firebase.
- Preconditions: steps 2-5 done; step 2 numbers reconciled (Firebase-only calendars imported, see step 7); 14 days of clean Worker
  logs; ops scripts no longer read Firebase.
- Do: final Firebase export (`firebase database:get / > firebase-final-YYYYMMDD.json`, or the console's export/backup) stored in
  R2 `archive/firebase/` and offline; then `COPY_BACK: ""` in `wrangler.jsonc` → deploy; then `wrangler secret delete FIREBASE_SA`
  and delete the `pastecal-copyback` service account (`setup-copyback.sh` header lists the commands).
- Verify: no `copyBack` lines in Worker logs; `cloudflare/test/copyback.test.mjs` updated so "COPY_BACK empty → no Firebase
  fetch"; R2 snapshots are still written (`backup.test.mjs`).
- Rollback (partial): `COPY_BACK="*"` plus restore the secret turns it back on, and the alarm's merge-then-write brings Firebase
  current again for calendars as they are next saved (not for idle ones). A true rollback after this needs `migrate.mjs` in
  reverse, which does not exist.

### Step 7: Bring over the stragglers (can run any time after step 2, ideally right before step 6)
- Do: for the ids from §5(a)/(b), push with the existing tool in batches of 25:
  `ONLY='["id1",...]' MODE=merge IMPORT_SECRET=… node cloudflare/scripts/migrate.mjs export.json https://pastecal-sync.instacalc.workers.dev`.
  `MODE=merge` goes through `/from-firebase`, so it never erases CF-side edits; locked rooms refuse it (report those by hand).
- Verify: the script itself reads each calendar back and prints `identical/mismatched/failed`; re-run §5(a) → 0;
  `parity.mjs` on those ids → 0 differences.
- Rollback: the R2 snapshot of each touched calendar from before the batch (`snapshots/<id>/<date>.json`) via `/import`.

### Step 8: Delete Firebase functions and hosting (owner)
- Do: `firebase functions:delete` for all remaining functions (generateICSV2, createPublicLink, lookupCalendar, indexSlug,
  indexReadOnlySlug, syncPublicView, removePublicView, recordHistory, sweepDeviceBuckets, and any Stripe ones). If §5(d) showed
  ICS subscribers on Firebase hosts, first replace Hosting with a **redirect-only** deploy (`firebase.json`
  `"redirects": [{"source":"**","destination":"https://pastecal.com/:path","type":301}]`, with the `.ics` rewrite removed)
  and leave it up for 60-90 days, because calendar apps follow 301s. Otherwise `firebase hosting:disable`.
- Verify: `firebase functions:list` is empty; `https://pastecal-web.web.app/demo.ics` returns 301 → pastecal.com (owner).
- Rollback: redeploy from git (`firebase deploy --only functions,hosting`). This is still possible because the code stays in git until step 9.

### Step 9: Remove Firebase from the repo, then the project
- Do: delete `functions/`, `firebase.json`, `.firebaserc`, `database.rules.json`, `remoteconfig.template.json`,
  `deployhosting.sh`, the Firebase half of `deploy.sh`, the emulator tests (item 25), `cloudflare/test/firebase-sync.test.mjs`,
  `fake-firebase.mjs`, the `/from-firebase` route, `fromFirebase`/`mirrored`/`firebaseToken`/`firebaseFetch` in `CalendarRoom.js`,
  and `FIREBASE_DB_URL`/`COPY_BACK` vars. Update `docs/cloudflare-migration.md` (tick Phases 4-5). After 90 days with no
  traffic: set the RTDB to locked (`.read: false`), and later delete the database / downgrade the Firebase plan.
- Verify: `grep -ri firebase public cloudflare/src` is empty (excluding docs); the full suite is green on wrangler dev.
- Rollback: `git revert`; the final export from step 6 is the data.

---

## 4. Now vs. owner

| Can be done now in a branch (no prod access) | Needs the owner |
|---|---|
| Remove the literal secret from `backfill-directory.mjs` (step 0.2) | **Rotate `IMPORT_SECRET` + `CLOUDFLARE_IMPORT_SECRET`** (step 0) |
| Port the release gate and journeys to `wrangler dev` (step 3) | Say which branch is deployed; deploy pro's `enabled()` (step 1) |
| Rewrite `health.py` / `parity.mjs` off `/history_meta` (step 3) | `firebase functions:list` / delete `updateEventIds` (step 0) |
| Remove `AuthorSignal` Firebase writes; author cookie in the Worker + room (steps 4.2, 5d) | Run the read-only counts in §5 (gcloud login + Cloud Logging) |
| Remove `watchLastEdited` / undo / nativecal Firebase reads; make `CalendarDataService` load without the SDK; drop SDK tags and CSP entries (step 5) | Deploy rules freeze, delete `shadowToCloudflare` (step 4) |
| Delete `public/dev/pro.*`, `public/js-old-components/` | Every `wrangler deploy` to production |
| Optional history-import route + test (item 11) | Decision: keep or drop pre-cutover history (item 11) |
| Prepare the redirect-only `firebase.json` and the `COPY_BACK=""` change as ready-to-merge PRs | Final export, `COPY_BACK=""`, delete `FIREBASE_SA` + SA (step 6) |
| Remove copy-back / from-firebase code behind a test (step 9 prep) | Check web.app / firebaseapp.com / cloudfunctions.net traffic; redirect-only Hosting; delete functions; disable the DB (steps 8-9) |

---

## 5. Measuring Firebase-only calendars (read-only; owner runs; not run here)

Credentials: these use `gcloud auth print-access-token` (the same as `scripts/health.py:33` and `parity.mjs`). A gcloud login
for kalid.azad@gmail.com is configured on this machine. Whether it has RTDB read on `pastecal-web` was **not tested**, because that is a production request.
`IMPORT_SECRET` is not needed. Every request below is a GET.

```bash
DB=https://pastecal-web-default-rtdb.firebaseio.com
T=$(gcloud auth print-access-token | tail -1)
W=https://pastecal-sync.instacalc.workers.dev

# (a) every Firebase calendar id (shallow = keys only, no data downloaded)
curl -s "$DB/calendars.json?shallow=true&access_token=$T" | jq -r 'keys[]' > fb-ids.txt
wc -l fb-ids.txt
curl -s "$W/api/directory/stats"                 # {total, readOnly, editable} on Cloudflare (one SELECT in the directory DO)

# ids not known to Cloudflare. Use the DIRECTORY lookup, not /cal/<id>:
#  - GET /cal/<id> counts a "view" in the room's stats (index.js:430, hitHeaders)
#  - HEAD /cal/<id> wakes (and for an unknown id, creates the SQLite schema of) a Durable Object per id
#  /api/lookup reads only the single directory DO.
while IFS= read -r id; do
  enc=$(jq -rn --arg s "$id" '$s|@uri')
  # exact match on actualSlug: lookup is case-insensitive, and case twins ("14WZW6WX" / "14wzw6wx") are distinct calendars
  hit=$(curl -s "$W/api/lookup?slug=$enc" | jq -r --arg s "$id" 'select(.found and .actualSlug == $s) | "y"')
  [ "$hit" = "y" ] || echo "$id"
done < fb-ids.txt > fb-only.txt
wc -l fb-only.txt
```
(The query parameter is `slug`, from `CalendarDirectory.js:25-36`. `SlugService.isLookupable` answers `found:false` for some odd names,
and the directory keeps one row per lowercase name, so the second twin of a case pair always shows up here. For the few ids in
`fb-only.txt` only, confirm with one `GET $W/cal/<id>`: 404 means truly Firebase-only.)

```bash
# (b) shadow drift: calendars whose Firebase copy was edited later than Cloudflare's (last 30 days)
node cloudflare/scripts/parity.mjs 720          # existing, read-only; exit 1 + DIFF lines if any differ
#   note: GET /cal/<id> inside parity.mjs counts a view per calendar; acceptable once, or add ?nostat

# (c) shadow failures and refused writes
gcloud logging read 'resource.type="cloud_run_revision" AND textPayload:"shadowToCloudflare FAILED"' \
  --project pastecal-web --freshness=30d --format='value(textPayload)' | sort | uniq -c | sort -rn | head

# (d) who still uses the Firebase hosts / ICS function
gcloud logging read 'textPayload:"ICS served" OR textPayload:"ICS 304"' --project pastecal-web --freshness=14d \
  --format='value(textPayload)' | wc -l
```
Expected from the design: (a) is close to 0 apart from deleted-on-CF test calendars (archived `test*` rooms are dropped from the directory,
`CalendarRoom.js:978-997`, but still exist in Firebase; filter `^test` out). (b) is 0 for unlocked calendars, while **locked calendars
will differ by design** (copy-back skips them, and Firebase holds their pre-lock state). That is one more reason never to roll back to a
world-writable Firebase. (d) is non-zero only if someone subscribed through web.app/firebaseapp.com/cloudfunctions.net.

Also worth one look in the console: Firebase → Realtime Database → Usage (connections, downloads). After step 5 the
simultaneous-connections graph should drop to ~0. Today every open pastecal.com tab holds an RTDB socket (items 7, 10).

---

## 6. Tests that prove each step

| Step | Existing proof | Gap to write |
|---|---|---|
| 0 secret | `cloudflare/test/hardening.test.mjs`, `permissions.test.mjs` (403 without the secret) | A test that no tracked file contains a 64-hex literal assigned to `IMPORT_SECRET` (cheap grep in `test/unit/deploy-surface.test.js`) |
| 1 flag | `test/unit/cloud-calendar-service.test.js`, `test/unit/preview-site.test.js` | Case: `hostname=pastecal.com, search=?backend=firebase` → enabled |
| 3 gate on CF | `cloudflare/test/cloud-journeys.spec.js`, `day-click.spec.js`, `side-panel.spec.js`, `templates.spec.js`, `recent-changes.spec.js` (all on :8787) | Port `test/journeys/journeys.spec.js` (en/fr/iPhone) to `cloudflare/playwright.config.js`; assertions via `GET /cal/<id>` |
| 4 freeze | `scripts/test-rules.sh` (rules emulator), `cloudflare/test/copyback.test.mjs` (copy-back with `fake-firebase.mjs`) | Rules test: anonymous write to `calendars/x` is denied, admin write allowed; copy-back still writes when the "world" can't |
| 5 no Firebase in the page | `cloudflare/test/history.test.mjs`, `phase3.test.mjs` (views, directory, ICS), `test/unit/cloud-calendar-service.test.js` | Playwright on wrangler dev with `page.route('**/*firebase*', r => r.abort())` + `**/gstatic.com/firebasejs/**`: the calendar opens, edits save, "Edited N ago" moves, Recent changes lists entries, ICS works. Author test: the room records the cookie id and ignores a client-sent `author` |
| 6 copy-back off | `copyback.test.mjs`, `backup.test.mjs` | `COPY_BACK=""` → zero fetches to `FIREBASE_DB_URL` across save + alarm |
| 7 stragglers | `migrate.mjs` read-back comparison, `parity.mjs`, `cloudflare/test/firebase-sync.test.mjs` (merge keeps CF edits) | none |
| 8 ICS | `cloudflare/test/ics-safety.test.mjs`, `test/unit/ics.test.js` | Owner check: `curl -sI https://pastecal-web.web.app/<cal>.ics` → 301 to pastecal.com |
| 9 removal | full suite on wrangler dev | `grep -ri firebase public cloudflare/src` empty, as a unit test in `deploy-surface.test.js` |

---

## 7. Open questions for the owner

1. Which branch is deployed to `pastecal-sync`: master (where `?backend=firebase` still works on pastecal.com) or pro?
2. Is `FIREBASE_SA` actually set? (`wrangler secret list`.) Without it, copy-back is inert (`copyBackAllowed`), Firebase has been
   stale since cutover, and steps 4-6 compress.
3. Is `updateEventIds` deployed?
4. Keep pre-cutover Recent-changes history (import ~20 entries per calendar) or let it go?
5. Does author continuity across the identity switch matter (Firebase uid → Worker cookie)? If so, record both during a transition.
6. Any known subscribers or embeds on `pastecal-web.web.app` / `firebaseapp.com`?
