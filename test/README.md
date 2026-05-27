# Tests

End-to-end regression tests driven by Playwright against a locally-served pastecal instance.

## Setup (one-time)

```bash
npm install
npm run test:e2e:install   # downloads Chromium for Playwright
```

## Running

```bash
npm test                   # run all e2e tests (auto-starts firebase serve on :8000)
npm run test:e2e:ui        # interactive UI mode
npm run test:e2e -- -g timeformat   # run a subset by name/grep
```

If port 8000 is already in use (e.g. you're running `./serve.sh` in another terminal),
Playwright will reuse it.

## Layout

- `e2e/settings-apply.spec.js` — settings persistence regressions (timeFormat, dark mode, etc.).
  When fixing a bug where a saved setting doesn't survive reload, add a case here first
  (red), then fix.
- `e2e/basic.spec.js` — smoke tests for calendar creation, mobile/desktop chrome, dialogs.
- `e2e/nativecal-sanity.spec.js` — nativecal prototype navigation smoke tests.
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
