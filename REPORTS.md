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
