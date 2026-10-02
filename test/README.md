# Tests

Unit tests (`node --test`, plus a Python suite for the usage report), emulator-backed
Cloud Functions tests, and Playwright e2e tests -- none of which touch production.

## Setup (one-time)

```bash
npm ci                     # also installs functions/ (postinstall) and the pinned test fixtures
npm run test:e2e:install   # downloads Chromium for Playwright (e2e only)
```

Needs Node 20-22, Python 3, and a JDK 21+ (the Database emulator is Java). firebase-tools is
NOT required globally: the emulator scripts run the version pinned in `test/firebase-cli.sh`
via npx when `firebase` is not on PATH (and always under CI).

## Running

```bash
npm test                   # = npm run test:unit
npm run test:unit          # fast + report + emulator-backed; deploy.sh refuses to deploy unless this passes
npm run test:unit:fast     # pure-logic tests only, no emulator startup
npm run test:report        # python3 -m unittest discover -s test/report
npm run test:unit:emulator # emulator-backed tests only (starts/stops the Database emulator on free ports)
npm run test:e2e           # Playwright, against the hosting/database/functions/auth emulators
npm run test:e2e:ui        # interactive UI mode (playwright.config starts the emulators itself)
npm run test:e2e -- -g timeformat   # run a subset by name/grep
npm run test:all           # unit + e2e
```

CI (`.github/workflows/test.yml`) runs `test:unit:fast` + `test:report` under four timezones
and `test:unit:emulator` once, with `CI=1`. Under `CI` a missing fixture (the real Syncfusion
and chrono bundles, root devDependencies pinned to the versions index.html loads) fails
instead of skipping, and nothing is downloaded.

## E2E against the emulators

The e2e suite used to run against `firebase serve` with the page's hard-coded production
config, so every test wrote real calendars into the production database. Now:

- `public/utils/emulators.js` (loaded before `firebase.initializeApp` on both pages) moves
  the database, functions and auth clients to the emulators under the `demo-pastecal`
  project when the page is on localhost/127.0.0.1 AND served by the hosting emulator, or
  `window.__PASTECAL_EMULATOR__` is set (the fixture sets it), or the URL has `?emulator`.
  Plain `firebase serve` on another port still talks to production, as before.
- `test/e2e/fixtures.js` additionally aborts every request and WebSocket to production
  Firebase/analytics, so a broken switch fails tests instead of writing real data.
- `npm run test:e2e` wraps Playwright in `firebase emulators:exec --project demo-pastecal
  --only hosting,database,functions,auth`; `baseURL` is the hosting emulator.

Remaining gap (why e2e is not in CI yet): verified here that pages load from the hosting
emulator and their database writes, callables and anonymous auth all reach the emulators,
but several specs fail for reasons unrelated to the switch -- stale selectors (e.g.
`basic.spec.js` matches two "Claim" buttons) and timing assumptions on a slow CDN. The suite
needs a pass to green before it can gate anything. `analytics-delivery.spec.js` deliberately
skips the fixture (it checks real GA delivery); its data still goes to the emulators because
it is served from the hosting emulator.

**Node version for `test:unit`:** use Node 20–22 (matching `functions/engines`). Run
`nvm use` to pick it up from `.nvmrc`.

On Node 24+ `firebase-admin` fails to load: it requires `jsonwebtoken` → `jwa` →
`buffer-equal-constant-time`, which reads `SlowBuffer.prototype` at module scope, and
Node removed `SlowBuffer` in v24. `require('functions/index.js')` therefore throws
before any test runs, and node reports it as a test failure with a stack trace pointing
into `node_modules`.

`test:unit:fast` runs `test/check-node-version.js` first so an unsupported runtime fails
with one actionable line instead of that stack trace. Upgrading won't fix it —
`buffer-equal-constant-time` has only ever published 1.0.x, and `jsonwebtoken` still
depends on it in its latest release.

If port 8000 is already in use (e.g. you're running `./serve.sh` in another terminal),
Playwright will reuse it.

## Layout

- `e2e/settings-apply.spec.js` — settings persistence regressions (timeFormat, dark mode, etc.).
  When fixing a bug where a saved setting doesn't survive reload, add a case here first
  (red), then fix.
- `e2e/basic.spec.js` — smoke tests for calendar creation, mobile/desktop chrome, dialogs.
- `e2e/nativecal-sanity.spec.js` — nativecal prototype navigation smoke tests.
- `unit/ics.test.js` — Cloud Functions ICS generation (`node:test`, no framework). Covers the
  "Server error generating ICS" regression: a single event missing start/end used to crash the
  whole feed, and missing calendars returned 500 instead of 404.
- `unit/event-model.test.js` — the Event model's date handling: invalid dates degrade to null
  instead of throwing, and `isComplete()` gates the write path. A dateless Event stays
  constructible on purpose (`Calendar.defaultEvent` builds one, then assigns dates).
- `unit/stress.test.js` — fuzz/invariant tests over a cross-product of hostile date and text
  inputs. The original incident came from a shape nobody thought to write a test for, so these
  assert invariants ("never throws", "never emits a VEVENT without DTSTART") rather than
  specific outputs. They caught two real bugs the example-based tests missed.
- `unit/lookup-calendar.emulator.test.js` — runs `SlugService.lookupCalendar` and
  `CalendarService.getCalendarData` against a real (emulated) Realtime Database. Every other
  unit test mocks nothing but also touches nothing that calls `admin.database()` — this is the
  only file that does. It exists because the firebase-admin 11->14 upgrade (2026-07-16) broke
  `admin.database()` in production ("admin.database is not a function") and shipped anyway:
  35 unit tests passed because none of them exercised the Admin SDK at all. Any future change
  to `functions/package.json`'s `firebase-admin` or `firebase-functions` version must pass
  `npm run test:unit:emulator` before deploying. New Cloud Functions code that calls
  `admin.database()` should get a case here, not just in `test:unit:fast`.
- `e2e/write-gate.spec.js` — incomplete events never reach Firebase (`CalendarDataService`
  can't be unit-tested in node; it calls `firebase.database()` at class load).
- `smoke-llm.sh`, `debug-recurrence.sh`, `validate-ux.sh` — older bash-based scripts.

## Writing a regression test

When a user reports a bug:

1. Reproduce it in `playwright test --ui` against `localhost:8000`.
2. Add a failing test alongside the closest existing spec (or create a new one).
3. The test should assert on **observable state** — `scheduleObj.timeFormat`, rendered DOM
   text, localStorage contents — not on internal call counts.
4. Fix the bug. Test should go green without modifying the assertion.

See `e2e/settings-apply.spec.js` for the pattern: seed localStorage, navigate, wait for
the app to mount, then read state through a small helper.

## Notes

- Tests run **sequentially** (one worker) because Firebase real-time DB writes from one
  test can leak into another test's view. If you parallelize, isolate by slug.
- The Vue 3 production build hides `_instance.proxy`. Use
  `document.getElementById('app')._vnode.component.proxy` to reach reactive state.
