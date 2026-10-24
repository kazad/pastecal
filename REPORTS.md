# Reports

## 2026-10-23 — Step 1: merge test-all, pro-inbox, pro-staging into pro

**Did**
- Merged `bundle/test-all` (e76fb3b), `bundle/pro-inbox` (e0b659c), `bundle/pro-staging` (ce79c2a) into `pro`.
  Note: the `origin/*` refs in this clone are stale (e.g. origin/test-all = 9f0b23d); the `bundle/*` refs match HANDOFF.md, so those were used.
- One conflict, in `cloudflare/src/index.js` and `cloudflare/src/Accounts.js` (pro-inbox vs pro-staging):
  kept both: the `email()` test-inbox handler alongside staging's `fetch()` wrapper (robots/noindex) that calls `route()`; merged the session/Origin header comment.
- Regressions found by tests and fixed (9210a37):
  - Staging env in `wrangler.jsonc` lacked `COLLECT_LIMITER` (free-harden added it to production after pro-staging branched). Bindings are not inherited, so staging would have had no telemetry limiter. Added its own namespace 2002.
  - `makeOwnCopy()` (pro) still used `Utils.randomID(8)`; free-harden moved new names to 10 characters. Now 10.
- `scripts/test-all.sh`: added the five suites added after it was written (site, headers, ics-safety, hardening, test-inbox); on a box with no nvm, it uses mise's Node 22 (`.nvmrc` says 22).
- Installed `functions/node_modules` locally (`npm ci --ignore-scripts`; gitignored), which the unit tests need.

**Tests** (`scripts/test-all.sh`, Linux, Node 22.20, 246s): all 25 run suites pass, including unit (385 checks).
Skipped by design: stripe-sandbox-e2e, pro-browser-e2e, cloud-journeys.

**Open issues**
- Under Node 26 (this box's default) 7 unit tests fail: `buffer-equal-constant-time` (a firebase-functions dependency) uses `SlowBuffer`, which Node 25+ removed. Use Node 22.
- `test:unit:emulator` (Firebase emulator tests) not run.

## 2026-10-23 — Step 2: browser pass on ?backend=cf + CSP console check

**Did**
Local `wrangler dev --local` (port 8790, ACCOUNTS_DEV_MODE=1, FIREBASE_DB_URL dead, COPY_BACK empty) driven by headless
Chromium (Playwright, scripts in the session scratchpad, not committed). Seeded calendars through the admin import,
locked one, made a read-only link through /api/create-view. A `securitypolicyviolation` listener on every page.

**Results**
- Pages /, a calendar, a locked calendar, /view/:id, /pricing, /signin, /pro/done, /report, /beta, /beta/:id: all 200,
  every one sends a CSP header, **0 CSP violations, 0 page errors**. Remaining console errors are the requests I blocked
  (GTM, Google Fonts, identitytoolkit) and Cloudflare's RUM beacon failing CORS on localhost (expected off production).
- Framing: `frame-ancestors 'none'` on /, calendars, /beta, /pricing, /signin; `frame-ancestors *` on /view/:id. Correct.
- .ics feed: 200 text/calendar, both events.
- Draft → click a day → type → Save & share → choose a name → Get my link: URL becomes the calendar, the event is on the Worker.
- Edit then "Edited just now" → Recent changes lists the edits and the restore note.
- /view/:id shows View Only + "Make your own calendar"; locked calendar shows the lock badge, "Locked", "Hosted on pastecal · Report".
- Locked visitor → lock badge → "Make your own copy" → home draft "Copy of …" with a 10-character id (the step-1 fix).
- Pro owner: real magic-link sign-in from the dev outbox (/signin#t=… → Continue → pc_session cookie), calendar locked to that
  user: snapshot role owner/canEdit, Sharing & Security shows "Locked with Pro", Stats, History, editor link, Manage billing,
  Sign out; the owner's edit is saved on the Worker.

**Rule incident (read-only, disclosed)**: Playwright's `route()` does not intercept WebSockets, so during the first page loads
the Firebase SDK opened a WebSocket to the live RTDB (pastecal-web-default-rtdb). I then mocked all off-localhost sockets
and recorded what the client sends: only an SDK stats ping (`a:"s"`) and one read listener (`a:"q"`) on
`/history_meta/<test calendar>/lastEditedAt` for the test-only names. No write was sent; anonymous auth was blocked
(identitytoolkit aborted), so there was no Firebase identity. Any later browser pass must also mock WebSockets
(`context.routeWebSocket`), not only HTTP.

**Open issues (pre-existing, not fixed: outside "regressions only")**
- Recent changes shows a **"0 events added"** row: a save that changes no events (here a title/options meta save right after
  an add) is stored as kind "edited" with all counts 0, and `public/app.js` (~3763, from 083bef5, Sept 15) falls through to
  "0 events added". Suggest: label it "Calendar settings changed" or skip rows with no event changes.
- On localhost/?backend=cf (not on preview, which is guarded by PreviewSite) the app still listens to production Firebase
  `/history_meta/<id>` and can read `/history/<id>` when the Worker has no undo rows. Read-only, but it means a local pass
  talks to production unless sockets are blocked.
- Lock badge popover: it opens on mouse hover and a click on the icon toggles it shut again, so a mouse user who clicks sees it vanish.
- Test setup note: with UNSAFE_DEV_SESSION_HEADER=on, loopback requests ignore the session cookie (header only), so the
  browser owner looks like a viewer. Run browser passes without it.
