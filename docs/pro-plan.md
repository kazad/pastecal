# pastecal Pro: plan and work items

Status as of 2026-10-23. Owner: Kalid. Coordinator: Claude (main session).
This file is the shared plan for anyone (human or AI) helping build Pro. Read all of it before
starting a work item.

## What Pro is

pastecal is a no-login shared calendar: anyone with a calendar's edit name
(`pastecal.com/<name>`) can edit it; read-only links are `/view/<code>`.

Pro is $24/year or $2.99/month **per calendar**, no trial, paid through Stripe Checkout.
Pro **locks** a calendar: only the owner (signed in by email link) and people holding a
private **editor link** can change it; everyone else can still view. Pro also hides pastecal
branding. When a subscription ends, the calendar keeps its events and goes back to free,
unlocked. Teams stays waitlist-only for now.

The pricing page (`public/pricing.html`, live at https://pastecal.com/pricing) lists more Pro
features marked "Soon". The work items below build them.

## Architecture (where things live)

- **Worker** `pastecal-sync` (Cloudflare): `cloudflare/src/index.js` routes everything; static
  site from `public/`. Config `cloudflare/wrangler.jsonc`.
- **CalendarRoom** Durable Object (`cloudflare/src/CalendarRoom.js`): one per calendar, SQLite.
  Holds events, history, the `lock` table, `canWrite()`, WebSocket protocol (`save`, `meta`,
  `auth`). Internal routes (`http://internal/cal/<id>/lock|unlock|rotate-editor-key|lock-status`)
  are reachable only from Worker code.
- **Accounts** Durable Object (`cloudflare/src/Accounts.js`): users, magic-link tokens, sessions,
  Stripe subscriptions, checkout holds. Routes `/api/auth/*`, `/api/me`, `/api/pro/*`,
  `/api/stripe/webhook`, admin `/api/admin/accounts/*`. `Stripe.js` = REST + signature check;
  `LockClient.js` = calls into rooms.
- **CalendarDirectory** DO: name → calendar lookups. **Waitlist** DO: Pro waitlist.
- **Client**: Vue 3 app `public/index.html` + `public/app.js`, Syncfusion Schedule (Material
  theme, restyled in `public/style.css`), WebSocket client `public/services/CloudCalendarService.js`,
  analytics `public/utils/analytics.js`. `public/tailwind.css` is prebuilt: new Tailwind classes do
  NOT work; write plain CSS with tokens from `public/tokens.css` (`--pc-link`, `--pc-surface`,
  `--pc-line`, `--pc-text`, `--pc-text-muted`). Font Figtree. Dark mode must work.

## Ground rules (non-negotiable)

1. **Never touch production.** No requests that change anything on pastecal.com, no deploys, no
   `wrangler secret put`, no Stripe live mode. Test only against a local `wrangler dev` and the
   Stripe sandbox "pastecal dev". Deploys are done by Kalid.
2. **Never commit secrets.** `.dev.vars*` files are gitignored; check diffs for `sk_`, `rk_`,
   `whsec_` before every commit.
3. **Work in your own git worktree and branch**, cut from `pro`. Don't edit another worker's
   worktree. Never touch `~/Dropbox/computer/Projects/pastecal` (it holds someone else's
   uncommitted work).
4. **Security first for anything Pro.** Enforce permissions on the server, never only in the UI.
   Locked state and Pro settings never live in client-writable calendar `options`. Keys and
   tokens are stored only as SHA-256 hashes, never put in URLs' query strings (use `#fragment`),
   never logged or sent to analytics.
5. **Privacy:** stats are counts only. No IPs, user agents, names, or who-viewed-what stored.
6. **Tests with every change.** Server: plain-node test scripts in `cloudflare/test/*.test.mjs`
   (style: `assert` + `step()`), run against `wrangler dev`. Client: unit tests
   `node --test $(node test/unit-files.js)` (needs `node_modules` symlinked from the main repo,
   remove the symlink before committing). Do NOT run `test/journeys` or `test/e2e` Playwright
   suites: they write to production Firebase.
7. **Copy style:** calm, plain, sentence case, American spelling. No promises we can't keep
   (no refunds, uptime, "for life", response times).
8. Commit messages: one plain sentence of what changed and why. Use `git add <paths>`, never `-A`.

Tooling notes: Node is `~/.nvm/versions/node/v22.18.0/bin/node` (npx/npm are broken shell
functions here; call node directly). Wrangler: `node cloudflare/node_modules/.bin/wrangler`.
Local dev settings: `cloudflare/.dev.vars` (IMPORT_SECRET=dev-secret, ACCOUNTS_DEV_MODE=1).
With ACCOUNTS_DEV_MODE=1, sign-in emails go to a dev outbox: `GET /api/admin/accounts/outbox?email=`
(Bearer dev-secret). Make a calendar Pro locally with `POST /api/admin/cal/<id>/lock`
`{ownerId}` (Bearer dev-secret).

## Branches

| Branch | What | State |
|---|---|---|
| `master` | What's deployed on pastecal.com | Live |
| `pro` | Integration branch for Pro (lock, accounts, billing, polish, wording, sandbox test) | Merged, all suites pass |
| `pro-ui` | Pro screens in the app | Claude agent, in progress |
| `pro-runbook` | Launch runbook + read-only smoke test | Claude agent, in progress |
| `pro-perms` | Named editor links, owner-only Pro settings (theme/branding) | Claude agent, in progress |
| `pro-insight` | Stats + restore earlier version (server) | Claude agent, in progress |

## Done

- **Lock** (server): every write path enforces it; editor key auth; admin routes. `cloudflare/test/lock.test.mjs` (11 checks).
- **Accounts**: magic link sign-in, 30-day sessions, CSRF checks. `accounts.test.mjs` (11).
- **Billing**: Checkout yearly/monthly, signed webhook, portal, one buyer at a time. `billing.test.mjs` (16, fake Stripe).
- **Sandbox end to end** with real Stripe test mode: `stripe-sandbox-e2e.mjs` (6).
- **Polish**: restyled editor/popups, sample event, color names, header, toolbar.
- **Paid-plan wording** in terms, privacy, pricing FAQ.

## Work items

Status values: `todo`, `claimed (<who>)`, `in progress (<who>)`, `done`. Claim an item by
editing this table in your branch's first commit.

| ID | Item | Area | Size | Status |
|---|---|---|---|---|
| P1 | Pro screens: lock flow in share menu, lock icon for visitors, editor link UI, billing, /pro/done | client | L | in progress (Claude) |
| P2 | Named editor links + owner-only settings (server) | server | M | in progress (Claude) |
| P3 | Calendar stats + where people are (server) | server | M | in progress (Claude) |
| P4 | Restore any earlier version (server) | server | M | in progress (Claude) |
| P5 | Launch runbook + smoke test | docs | S | in progress (Claude) |
| G1 | **Secret events** (server + client) | both | M | todo: good for Gemini |
| G2 | **Subcalendars** (layers people can toggle) | client | M | todo: good for Gemini |
| G3 | **Suggested events** (visitors suggest, owner/editors approve) | both | L | todo: good for Gemini, after G1 |
| C1 | UI for P2/P3/P4 (editor links list, theme/branding form, stats page, version picker) | client | L | todo, after P1 merges |
| C2 | Custom theme applied to calendar + embeds (`?theme=` respected) | client | M | todo, after P2 |
| C3 | Stats across all your calendars (Teams) | both | M | later |
| C4 | Shared admins across calendars (Teams) | both | L | later |

### G1. Secret events

Pro only. An event can be marked secret; only the owner and editor-link holders see it.
Viewers (view link, edit name without a key, ICS feed of the view link, embeds) never receive it.

- Server (`CalendarRoom.js`): add `secret: true|false` on events (stored as a field; validate
  boolean). When building what a socket or HTTP reader receives, filter secret events out unless
  `canWrite(att)` is true (owner or editor). Apply to: snapshots, every broadcast of changes
  (a viewer must not learn a secret event was added, changed or deleted: filter per socket),
  `GET /cal/<id>`, `/cal/view/<id>`, ICS for view links, history entries shown to viewers.
  The edit-link ICS (`/<name>.ics`) on a locked calendar is a viewer path too unless keyed.
  Free (unlocked) calendars: ignore the flag (treat as not secret) and say so in the UI.
- Client: a "Secret (only editors see this)" checkbox in the event editor when the calendar is
  Pro and the user can edit; a small lock or eye-off icon on secret events in the grid.
- Tests: `cloudflare/test/secret.test.mjs`: viewer socket never receives secret events in
  snapshot or broadcasts; editor does; ICS of the view excludes them; unlocking a calendar
  makes them normal events (decide and document: recommend they stay hidden only while Pro).
- Acceptance: no secret event title, id or time is observable by a viewer through any route.

### G2. Subcalendars

Pro only. Layers like "Games" and "Practice" that viewers can turn on and off. Build on the
existing event categories (types 1-8 with labels; see `colorNameFor` and the filter dots in
`public/app.js`).

- Client: in view mode, show the categories in use as toggle chips above the calendar; toggling
  hides/shows those events (client-side filter, remembered in localStorage per calendar, wrapped
  in try/catch). Owners can rename categories (already possible) and mark which appear as layers.
- Embeds and links: support `?layers=1,3` to preselect layers (and keep the hash-free URL rule
  for keys).
- ICS: `/<view>.ics?layers=1,3` returns only those categories so people can subscribe to just
  "Games" in Google Calendar (server change in ICSService/index.js).
- Tests: unit tests for the filter function; a server test for ICS filtering.

### G3. Suggested events

Pro only. Viewers can propose an event; owner/editors approve or decline.

- Server: new socket message `{t:'suggest', event, name?}` allowed for viewers on locked
  calendars only; rate-limited per socket and per IP (reuse CREATE_LIMITER pattern); stored in a
  `suggestions` table (id, event json, suggested_at, note <=200 chars, status). Editors receive
  `{t:'suggestions', list}`; viewers never see others' suggestions. Approve = add the event as
  a normal save by that editor + mark approved. Decline = mark declined. Max 200 pending.
- Client: viewers get "Suggest an event" in place of editing; editors get a badge with the count
  and a review list (approve / decline).
- Tests: viewer can suggest, can't read the list; editor approves and the event appears for
  everyone; spam limits.

## Kalid's launch steps (not for helpers)

See the launch plan artifact and `docs/pro-launch.md` (from `pro-runbook`) for exact commands:
Stripe live activation, live product/prices/webhook, Cloudflare Email Sending for pastecal.com,
four secrets, deploy, one real purchase.
