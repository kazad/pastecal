# Pro demo: a local test Pro account

One command starts a local pastecal with every Pro state already set up, so you can click through
them as the owner, an editor and a visitor. It runs only on your machine. It never touches preview,
production, production Firebase or real Stripe.

```bash
npm run demo:pro                 # or: bash scripts/demo-pro.sh
npm run demo:pro -- --reset      # wipe the demo and seed it again
bash scripts/demo-pro.sh link    # a fresh owner sign-in link (while the demo is running)
```

Ctrl-C in the demo's terminal stops it. It needs `cloudflare/node_modules`, so run
`(cd cloudflare && npm install)` once if it's missing.

## What you get

The demo serves on **http://localhost:8970**. It signs you in as the owner `owner@demo.test`, who
owns four calendars:

| Calendar | Id | State |
|---|---|---|
| Riverside rooftop | `demo-rooftop` | Pro (yearly, paid through the Stripe webhook). Has editor links "Maria" and "Dev", a view link (`/view/demo-rooftop-view`), events this week and next, and stats |
| Robotics club | `demo-trial` | 30-day Pro trial, no card on file. The share panel shows "Pro trial · N days left · Keep Pro" |
| Choir rehearsals | `demo-lapsed` | Paid monthly, then canceled, so Pro ended. It is paused: read-only for everyone. The owner sees "Pro ended — read-only" with Open to everyone / Keep Pro |
| Book club | `demo-free` | A plain free calendar |

When it starts, the demo prints a menu of links:

- **Open first:** `http://localhost:8970/demo-free?backend=cf`. This switches the browser to the
  local backend (see below).
- **Owner sign-in:** a one-time `http://localhost:8970/signin#t=…` link. It works once and expires
  after 15 minutes. `bash scripts/demo-pro.sh link` mints a new one. Sign-in links are limited to 5
  an hour per email; if you hit the limit, wait or run `--reset`.
- **Owner views** of each calendar.
- **Editor links**: `/demo-rooftop?backend=cf#k=<key>` for Maria and Dev. Open them in a private
  window or another browser, so you aren't the owner there.
- **Visitor links**: the edit name (read-only, because it's locked), the view-only link, and the
  paused calendar.
- **Pro stats**: as the owner on Riverside rooftop, go to Share → Stats.

## How it works

- **The Worker.** `scripts/demo-pro.mjs` runs `wrangler dev` from `cloudflare/` on a private
  loopback port. Its state lives in `~/.pastecal-demo-state`, and the log is `wrangler.log` in that
  folder. It always passes these variables:
  - `FIREBASE_DB_URL:` and `COPY_BACK:` (empty), so the Worker never copies to Firebase.
  - `ACCOUNTS_DEV_MODE:1`, so sign-in emails go to the dev outbox and the admin test hooks are on.
  - `IMPORT_SECRET:dev-secret`.
  - Fake Stripe keys and prices, with `STRIPE_API_BASE` pointing at the fake.
- **The fake Stripe.** `cloudflare/test/fake-stripe.mjs` runs on a free port inside the same Node
  process. The Stripe objects it holds are saved to `~/.pastecal-demo-state/demo.json`, so a restart
  still answers for them. `LOCK_API_BASE` is not set, so locks and pauses happen in the real
  calendar rooms.
- **The proxy on :8970.** It passes every request, WebSockets included, through to wrangler. On
  pages it tightens the Content-Security-Policy:
  - `connect-src 'self'`.
  - Firebase, Google and analytics hosts are removed from `script-src` and `frame-src`.

  Even with `?backend=cf`, the app still signs in anonymously to production Firebase and writes
  author signals there. Production analytics would also count your clicks. The proxy blocks all of
  that in the browser.
- **`?backend=cf`.** On localhost the app uses the Cloudflare backend only with this flag, which
  the browser then remembers. Every printed link carries it. The sign-in link's redirect drops it,
  which is why you open a `?backend=cf` link first. If you skip that step, the proxy's CSP still
  keeps the page away from Firebase, but the page won't load the calendar.
- **Seeding** happens on the first run only, through the same routes the app and Stripe use:
  1. Calendars are created with `POST /cal/<id>`, and the view link with `/api/create-view`.
  2. The owner signs in through `/api/auth/start`, the outbox, then `/api/auth/verify`.
  3. Paid Pro comes from a `customer.subscription.created` webhook signed with the fake secret.
  4. Editor links are made with `/api/pro/editor-links`. Their keys are kept in `demo.json`,
     because the server shows each key only once.
  5. The trial is started with `/api/pro/trial`.
  6. Pro ended is a paid subscription followed by `customer.subscription.deleted`.
  7. Stats are 18 views from different networks and browsers (direct, embed, search and site) and
     7 calendar-app follows of the `.ics` feed (Google, Apple, Outlook, other).

  A later run without `--reset` keeps everything and only prints a new sign-in link.
- **Stats are today only.** The Worker counts only real requests, so every view lands on today
  (UTC) in the current hour. The 30-day chart has a single bar.

Clicking "Keep Pro" or "Lock" goes to the fake checkout URL (`checkout.stripe.test`), which is not a
real page. To see Pro come back after a checkout, use the billing tests' webhook flow
(`cloudflare/test/billing.test.mjs`) instead.
