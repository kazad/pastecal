# pastecal Pro: launch runbook

**Run order (not the section order):** a → b → c1–c4 → e1–e3 (deploy, then smoke test with billing off) → d1–d4 (turn billing on) → the second smoke test in e3 → f. Section g is for emergencies.

Every command fits on one line and is safe to paste into zsh. Prices: **$24/year and $2.99/month, no trial.**

What ships: Worker `pastecal-sync` from the `pro` branch. It adds:

- an `Accounts` Durable Object (migration **v4**)
- the `send_email` binding `EMAIL` (sender `login@pastecal.com`)
- `/api/auth/{start,verify,signout}`, `/api/me`, `/api/pro/{checkout,portal,editor-key,status}`, `/api/stripe/webhook`
- admin routes (`Authorization: Bearer $IMPORT_SECRET`): `/api/admin/cal/<id>/{lock,unlock,rotate-editor-key,lock-status}` and `/api/admin/accounts/{reassign,lookup}`

The pages that ship with it are `/signin` and `/pro/done`; `/pricing` is already live.

Billing stays **off** until both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set. Until then, checkout, portal and webhook all answer `503 billing-not-configured`. Checkout also needs the price secret for the interval being bought (code: `cloudflare/src/Stripe.js`, `stripeConfig`).

**Never set these in production.** They are for local tests only (`.dev.vars` / `--var`):

- `ACCOUNTS_DEV_MODE`
- `STRIPE_API_BASE`
- `LOCK_API_BASE`
- `UNSAFE_DEV_SESSION_HEADER`

Section (f) checks that none of them is set.

## 0. Shell setup (every new terminal)

```zsh
alias wr="$HOME/.nvm/versions/node/v22.18.0/bin/node $HOME/worktrees/pastecal-pro/cloudflare/node_modules/.bin/wrangler"
cd ~/worktrees/pastecal-pro/cloudflare
wr whoami
stripe whoami
```

`stripe` commands go to whichever account and mode `stripe whoami` shows as **active**. In a sandbox, `--live` is refused ("You're in a sandbox"). In live mode, `--live` is accepted. **Read `stripe whoami` before every Stripe block.** As of 2026-10-23 the CLI has:

- sandbox **pastecal dev** `acct_1UTqVZEPgWTHeJ7W`
- live account **New business** `acct_1CN6CpEBwAK7H2Dz`

Rename the live business to pastecal before activation (see c1), because customers see that name.

Stripe CLI output: the JSON goes to stdout and the `▸ Running in …` banner goes to stderr. Every `| jq` below therefore adds `2>/dev/null`.

---

## (a) Stripe test sandbox: prove the whole loop before going live

### a1. Product and prices (already exist in "pastecal dev"; check before creating)

```zsh
stripe switch acct_1UTqVZEPgWTHeJ7W
stripe whoami
stripe prices list --lookup-keys=pro_yearly --lookup-keys=pro_monthly 2>/dev/null | jq -r '.data[] | [.id, .lookup_key, .unit_amount, .recurring.interval, .product] | @tsv'
```

Expected on 2026-10-23: `pro_yearly 2400 year` and `pro_monthly 299 month`, both on `prod_VUqpcyjWw0UyoH`. **Only if they are missing**, create them:

```zsh
PROD=$(stripe products create --name="pastecal Pro" --description="Lock your calendar: only you and people with your editor key can edit." 2>/dev/null | jq -er .id) && echo $PROD
stripe prices create --product="$PROD" --currency=usd --unit-amount=2400 "--recurring[interval]=year" --lookup-key=pro_yearly --nickname="Pro yearly" 2>/dev/null | jq -r .id
stripe prices create --product="$PROD" --currency=usd --unit-amount=299 "--recurring[interval]=month" --lookup-key=pro_monthly --nickname="Pro monthly" 2>/dev/null | jq -r .id
```

Every Stripe command in this file was checked with `--help` / `--dry-run`. Add `--dry-run` to any of them to preview the request without sending it. Quote bracket flags (`"--recurring[interval]=year"`), because zsh treats `[...]` as a glob.

### a2. Customer portal (sandbox)

The Worker creates portal sessions without a `configuration`, so it uses the mode's **default** portal configuration. That default exists only after you save it once in the Dashboard: Settings → Billing → Customer portal. Set:

- Payment methods: customers can update them.
- Cancellations: allowed, at the **end of the billing period**, with no prorations.
- Invoice history: on.
- Subscriptions (switch plans): **off at launch.** Recommended: it keeps the yearly/monthly logic to "buy" and "cancel". To offer it later, turn it on here and add both Pro prices. The webhook already handles `customer.subscription.updated`.
- Default redirect: `https://pastecal.com/`.

Then check:

```zsh
stripe billing_portal configurations list 2>/dev/null | jq '.data[] | {id, is_default, cancel: .features.subscription_cancel, switch: .features.subscription_update.enabled, pm: .features.payment_method_update.enabled}'
```

### a3. Local end-to-end against the sandbox

Webhook events the code acts on (`SUBSCRIPTION_EVENTS` and `CHARGE_EVENTS` in `Accounts.js`). The Worker records and ignores every other event:

`checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed, charge.refunded, charge.dispute.created`

A full refund or a dispute cancels the subscription it paid for, which unlocks the calendar. A test-mode key (`sk_test_`/`rk_test_`) only works with `ACCOUNTS_DEV_MODE=1`; anywhere else billing answers `503 billing-not-configured` and logs `BILLING OFF`. Events whose `livemode` doesn't match the key's mode are ignored.

1. Create `cloudflare/.dev.vars`. It is gitignored. **Never copy it to production.** It holds:
   - `ACCOUNTS_DEV_MODE=1`, which accepts `http://localhost` origins and writes sign-in emails to an outbox instead of sending them.
   - `IMPORT_SECRET=<any local string>`, which reads that outbox.
   - `STRIPE_SECRET_KEY=<sandbox sk_test_… or rk_test_… from Dashboard → Developers → API keys>`. Testing a **restricted** test key here, with the same permissions planned for live (c4), proves those permissions.
   - `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_YEARLY` and `STRIPE_PRICE_PRO_MONTHLY`, from the commands below.
2. Print the values to paste into `.dev.vars`:

```zsh
stripe listen --print-secret 2>/dev/null
stripe prices list --lookup-keys=pro_yearly 2>/dev/null | jq -er '.data[0].id'
stripe prices list --lookup-keys=pro_monthly 2>/dev/null | jq -er '.data[0].id'
```

3. In terminal 1, start the Worker locally: `wr dev --port 8787`.
4. In terminal 2, forward sandbox events to it:

```zsh
stripe listen --forward-to localhost:8787/api/stripe/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.payment_failed,charge.refunded,charge.dispute.created
```

5. Run the loop in a browser:
   1. Open `http://localhost:8787`, make a calendar, and start Pro.
   2. Ask for a sign-in link, then read it from the outbox:

      ```zsh
      curl -s -H "Authorization: Bearer <your local IMPORT_SECRET>" "http://localhost:8787/api/admin/accounts/outbox?email=you@example.com" | jq -r '.emails[-1].text'
      ```

   3. Open the link with the host changed to `http://localhost:8787` (keep the `/signin#t=…` part).
   4. Check out with the cards below.

   After payment, Stripe redirects to the hard-coded `https://pastecal.com/pro/done…`. Locally that page is irrelevant: the webhook in terminal 2 is what locks the calendar. Confirm in the `stripe listen` output that each event got `[200]`, and that the calendar now shows as locked at `http://localhost:8787`.

**The first checkout must succeed.** Checkout sets `expires_at` to exactly 30 minutes from the Worker's clock (`CHECKOUT_HOLD_MS`). Stripe's documented minimum is 30 minutes after session creation, so clock or network delay could make Stripe refuse it. The failure looks like this: the browser gets `502 stripe-error`, and the `wr dev` terminal shows `[accounts] checkout session failed: 400 <code>`. Confirm it is this problem in the Dashboard (Developers → Logs → that request): the error names `expires_at`. If you see it, the hold must grow (e.g. to 31 minutes) in code before launch. The automated tests use a fake Stripe and do not prove this.

Test cards: any future expiry, any CVC, any ZIP.

| Card | Use it for |
|---|---|
| `4242 4242 4242 4242` | Pays. The calendar locks. |
| `4000 0025 0000 3155` | 3-D Secure challenge. Approve it. |
| `4000 0000 0000 9995` | Declined (insufficient funds). Nothing locks. |
| `4000 0000 0000 0341` | Card attaches, but later charges fail. Use it with a test clock to see `invoice.payment_failed` → `past_due` (stays locked) → `unpaid`/`canceled` (unlocks). |

Then cancel in the portal (Pro button → Manage billing). The subscription goes to `cancel_at_period_end`, and the calendar stays locked until the period ends. To see the unlock immediately:

```zsh
stripe subscriptions cancel <sub_id>
```

---

## (b) Cloudflare Email Sending for pastecal.com (sign-in links)

The state on 2026-10-23, checked read-only:

- Email Routing on pastecal.com: **enabled, ready**. The apex keeps MX `route1/2/3.mx.cloudflare.net` and SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`, which is how support@ receives mail.
- Email Sending: **not enabled** for pastecal.com. Only `notify.betterexplained.com` is onboarded in this account.
- No DMARC record on `_dmarc.pastecal.com`.

The read-only preview (`cf email-sending subdomains preview -z pastecal.com --name pastecal.com`) shows that onboarding adds exactly these records, and reports **no conflicts**:

| Name | Type | Content |
|---|---|---|
| `cf-bounce.pastecal.com` | MX ×3 | `route1/2/3.mx.cloudflare.net` (bounce handling) |
| `cf-bounce.pastecal.com` | TXT | `v=spf1 include:_spf.mx.cloudflare.net ~all` (SPF for the return path) |
| `cf-bounce._domainkey.pastecal.com` | TXT | `v=DKIM1; …` (DKIM) |
| `_dmarc.pastecal.com` | TXT | `v=DMARC1; p=reject;` |

None of these names is the apex, so Email Routing's MX and SPF are untouched.

**Decision before b1, about the DMARC record.** `p=reject` on `pastecal.com` makes receivers reject any mail *From: @pastecal.com* that is not sent through Cloudflare. A real case: replying as `support@pastecal.com` from Gmail ("Send mail as"). If you do that, or might, set the record to `v=DMARC1; p=none; rua=mailto:support@pastecal.com` after b1 (Dashboard → DNS → edit `_dmarc`). Unverified: Cloudflare may lock the records it creates for email (the `dns fix` help mentions an "email_routing lock"), so check that the record can be edited before you rely on this. If nothing else ever sends as @pastecal.com, keep `p=reject`.

### b1. Onboard

```zsh
wr email sending enable pastecal.com
```

### b2. Verify

```zsh
wr email sending list pastecal.com
wr email sending settings pastecal.com
wr email sending dns get pastecal.com
cf email-sending subdomains preview -z pastecal.com --name pastecal.com | jq '.errors'
```

The preview must print `[]`. If records are missing, re-apply them with `cf email-sending subdomains dns fix <id> -z pastecal.com`, where `<id>` is the tag that `wr email sending list pastecal.com` printed. It refuses with a 409 if a conflicting MX, SPF, DKIM or DMARC record exists.

Then confirm the record values in public DNS, and that receiving still works:

```zsh
dig +short MX cf-bounce.pastecal.com
dig +short TXT cf-bounce.pastecal.com
dig +short TXT _dmarc.pastecal.com
dig +short MX pastecal.com
wr email routing settings pastecal.com
```

`dig MX pastecal.com` must still show the three `route*.mx.cloudflare.net` records, and routing must still say `Enabled: true, Status: ready`. Send yourself a mail at support@pastecal.com and check that it arrives.

### b3. Test send (sends one real email to you)

```zsh
wr email sending send --from login@pastecal.com --from-name pastecal --to you@example.com --subject "pastecal sending test" --text "If this arrived, login@pastecal.com can send."
```

In Gmail, open the message → Show original. SPF, DKIM and DMARC must each show **PASS**.

Do b1–b3 **before the deploy in (e)**. Otherwise the first sign-in emails fail: the Worker logs `[accounts] sign-in email failed`, and the user still sees "check your email".

---

## (c) Stripe live

### c1. Account activation checklist (Dashboard, live mode)

- [ ] Business details complete. Public business name **pastecal**, statement descriptor `PASTECAL`, support email `support@pastecal.com`, website `https://pastecal.com`.
- [ ] Bank account added and verified. Identity verification complete, with no "action required" banner.
- [ ] Customer emails: successful-payment receipts and refund emails on. Failed-payment emails and "upcoming renewal" reminders on; the yearly reminder matters most.
- [ ] Smart Retries / dunning: the default is fine. It ends with "cancel the subscription", which unlocks the calendar.
- [ ] Branding: icon and color for Checkout and the portal.
- [ ] Policies: links to terms and privacy, shown on Checkout and in the portal.
- [ ] **Stripe Tax: launch without collecting tax.** Checkout never sets `automatic_tax`, so turning Stripe Tax on in the Dashboard alone collects nothing. Leave it off, and use Stripe Tax's threshold monitoring (Tax → Registrations) to see when registration becomes necessary. Collecting tax later is a code change: `automatic_tax[enabled]=true` plus billing-address collection in `checkout()`.

### c2. Live product and prices

```zsh
stripe switch acct_1CN6CpEBwAK7H2Dz --live
stripe whoami
stripe prices list --live --lookup-keys=pro_yearly --lookup-keys=pro_monthly 2>/dev/null | jq -r '.data[] | [.id, .lookup_key, .unit_amount, .recurring.interval] | @tsv'
```

`stripe whoami` must say `live`. Create the prices only if the list is empty:

```zsh
PROD=$(stripe products create --live --name="pastecal Pro" --description="Lock your calendar: only you and people with your editor key can edit." 2>/dev/null | jq -er .id) && echo $PROD
stripe prices create --live --product="$PROD" --currency=usd --unit-amount=2400 "--recurring[interval]=year" --lookup-key=pro_yearly --nickname="Pro yearly" 2>/dev/null | jq -r .id
stripe prices create --live --product="$PROD" --currency=usd --unit-amount=299 "--recurring[interval]=month" --lookup-key=pro_monthly --nickname="Pro monthly" 2>/dev/null | jq -r .id
```

### c3. Live customer portal

Use the same settings as a2, in live mode: Dashboard → Settings → Billing → Customer portal → Save. Check:

```zsh
stripe billing_portal configurations list --live 2>/dev/null | jq '.data[] | {id, is_default, cancel: .features.subscription_cancel.mode, switch: .features.subscription_update.enabled}'
```

Want `is_default: true` and `cancel: "at_period_end"`.

### c4. Live API key (Dashboard only; the CLI cannot mint one)

Dashboard → Developers → API keys → **Create restricted key** named "pastecal-sync Worker". The Worker calls only:

- `POST /v1/checkout/sessions`, `POST /v1/checkout/sessions/<id>/expire`, `GET /v1/checkout/sessions/<id>` (a buyer restarting checkout: the old page is expired first)
- `POST /v1/billing_portal/sessions`
- `GET /v1/subscriptions/<id>`, `DELETE /v1/subscriptions/<id>` (cancel now: a second payer for a locked calendar, a duplicate, a full refund or a dispute)
- `GET /v1/invoices/<id>`, `GET /v1/invoice_payments`, `GET /v1/charges/<id>`, `POST /v1/refunds` (refund a payment that could not get the lock)

Grant **Checkout Sessions: Write**, **Customer portal: Write**, **Subscriptions: Write**, **Invoices: Read**, **Charges: Read**, **Refunds: Write**, and nothing else. The exact permission labels are unverified, so prove the set in the sandbox first (a3). If live checkout answers `502 stripe-error` and `wr tail` shows a 403 permission error, add the one Stripe names. Copy the key and go straight to d1. Do not paste it anywhere else.

### c5. Live webhook endpoint: done in d4, **after** the deploy

The endpoint's signing secret (`whsec_…`) is returned **only once, when the endpoint is created**. So d4 creates the endpoint and stores the secret in one step. It runs after (e) so that Stripe never sends events to a Worker that lacks the route.

---

## (d) Worker secrets: run after (e), from `~/worktrees/pastecal-pro/cloudflare`, in the live Stripe context

`wr secret put NAME` reads the value from a hidden prompt, or from a pipe (the docs say "The `put` command can also receive piped input"). Either way the value never shows on screen. Each `put` takes effect immediately on the deployed Worker.

The order matters. Billing stays off until **both** the key and the webhook secret exist, so set them in this order and set the webhook secret last.

d1. The restricted key from c4. It is on your clipboard; this pipes it in, then clears the clipboard:

```zsh
pbpaste | wr secret put STRIPE_SECRET_KEY && pbcopy < /dev/null
```

d2 and d3. The price ids, looked up by lookup key. Price ids are not secret:

```zsh
Y=$(stripe prices list --live --lookup-keys=pro_yearly 2>/dev/null | jq -er '.data[0].id') && echo $Y && print -r -- "$Y" | wr secret put STRIPE_PRICE_PRO_YEARLY
M=$(stripe prices list --live --lookup-keys=pro_monthly 2>/dev/null | jq -er '.data[0].id') && echo $M && print -r -- "$M" | wr secret put STRIPE_PRICE_PRO_MONTHLY
```

d4. Create the live webhook endpoint and store its signing secret. **Run this after (e).** Billing turns on when this finishes:

```zsh
WH=$(stripe webhook_endpoints create --live --url=https://pastecal.com/api/stripe/webhook --description="pastecal Pro (Worker pastecal-sync)" --enabled-events=checkout.session.completed --enabled-events=customer.subscription.created --enabled-events=customer.subscription.updated --enabled-events=customer.subscription.deleted --enabled-events=invoice.payment_failed --enabled-events=charge.refunded --enabled-events=charge.dispute.created 2>/dev/null | jq -er .secret) && print -r -- "$WH" | wr secret put STRIPE_WEBHOOK_SECRET; unset WH
```

If `jq` printed an error, the endpoint may exist without its secret stored. Look for it with `stripe webhook_endpoints list --live 2>/dev/null | jq '.data[] | {id, url, enabled_events}'`. Then either roll its signing secret in the Dashboard (Developers → Webhooks → endpoint → Roll secret) and set it with `pbpaste | wr secret put STRIPE_WEBHOOK_SECRET`, or delete it (`stripe webhook_endpoints delete <we_id> --live`) and re-run d4.

The endpoint uses the account's default API version. The code reads subscriptions in both the pre- and post-`2025-03-31.basil` shapes (`summarizeSubscription`).

Check what is set. This shows names only, never values:

```zsh
wr secret list
```

Want exactly `FIREBASE_SA`, `IMPORT_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and **none** of the four dev-only names.

---

## (e) Deploy

The deploy is all-or-nothing, with no staged rollout. Deploy with billing **off** (secrets d1–d4 not yet set) and smoke-test. Then turn billing on with (d) and smoke-test again.

### e1. Pre-flight

- Deploy from the `pro` worktree, never from the Dropbox checkout. On 2026-10-23 the Dropbox checkout had uncommitted `cloudflare/` work, `BackupService.js` and an hourly cron, which is not in `pro` and not live. Production runs version `ca0b6a70…`: fetch handler only, bindings CALENDARS, DIRECTORY, WAITLIST, BACKUPS, EVENTS, CREATE_LIMITER and ASSETS, secrets FIREBASE_SA and IMPORT_SECRET.
- `git status` must print nothing. The `log` must show the commit you mean to ship.

```zsh
cd ~/worktrees/pastecal-pro && git status --short && git log --oneline -3 && cd cloudflare
wr deploy --dry-run
wr deployments list
```

- Run the Worker tests as each file's header says. They need local `wrangler dev` instances; `test/accounts.test.mjs` and `test/billing.test.mjs` cover Pro.
- `wr deploy --dry-run` bundles and lists the bindings without uploading. Check that it shows ACCOUNTS (Accounts) and EMAIL.
- **Write down the current version id** that `wr deployments list` shows (100%). It is the "before" in (g).

### e2. Make master match what ships, then deploy

`master` is an ancestor of `pro`, so this is a fast-forward and rewrites no history:

```zsh
cd ~/worktrees/pastecal-pro && git push origin pro:master
cd ~/worktrees/pastecal-pro/cloudflare && wr deploy --message "Pro: accounts, magic link, Stripe billing (billing off until secrets)"
```

A push to master does not deploy. Only `.github/workflows/uptime.yml` runs on GitHub, so `wr deploy` is the deploy.

**Migration v4 is one-way.** The first deploy creates the `Accounts` Durable Object class, which holds owners, sessions and subscriptions. After that:

- `wr rollback` to any version from before this deploy is **refused**. Cloudflare blocks rollbacks across a Durable Object class change.
- Deleting the class would need a `deleted_classes` migration, which **destroys every account and subscription record**. Never do that to roll back.

To roll back *code*, see (g3).

### e3. Right after the deploy

From the repo root:

```zsh
scripts/pro-smoke.sh --expect-deployed
```

With billing still off, the expected results are:

- the Pro pages PASS
- `/api/me` → 401
- checkout and portal → `503 billing-not-configured`
- webhook → 503
- the admin routes → 403

Then set the secrets (d1–d4) and run:

```zsh
scripts/pro-smoke.sh --expect-billing
```

Now checkout and portal → 401 and webhook → 400 invalid-signature.

---

## (f) Post-deploy checks

1. Run both smoke tests from e3. To check delivery from production, add `--with-email you@example.com`: it sends one real sign-in email.
2. Watch the logs for 10 minutes. They should show no `[accounts]` errors:

```zsh
wr tail --format pretty --search accounts
```

3. Check that no dev-only setting is live:

```zsh
wr secret list | grep -E 'ACCOUNTS_DEV_MODE|STRIPE_API_BASE|LOCK_API_BASE|UNSAFE_DEV_SESSION_HEADER'
```

   It must print nothing. They are also absent from `vars` in `wrangler.jsonc`.
4. Make one real purchase, with your own card, on a throwaway calendar:
   1. Sign in with the email link.
   2. Buy **monthly** ($2.99).
   3. Check that `/pro/done` says Pro is on, that the calendar is locked in a private window, and that the editor key works.
   4. Developers → Webhooks → endpoint: all deliveries 200.
   5. Open Manage billing, cancel, and check that the portal says it ends at period end.
5. Refund the test purchase:

```zsh
stripe subscriptions list --live --status=all --limit 3 2>/dev/null | jq -r '.data[] | [.id, .status, .latest_invoice] | @tsv'
stripe refunds create --live --payment-intent=<pi_…> --reason=requested_by_customer
```

   The `pi_` id is on the payment in the Dashboard.
6. Check that the existing app still works:
   - Open an existing calendar and a `/view/<id>` link.
   - Edit an event and see it sync to a second tab.
   - Run `./scripts/stats.sh health` now and again in ~30 minutes.

---

## (g) Rollback and kill switches

Steps g1–g3 run from `~/worktrees/pastecal-pro/cloudflare`. Each change takes effect in seconds.

### g1. Stop new sales only (recommended first move)

```zsh
wr secret delete STRIPE_PRICE_PRO_YEARLY
wr secret delete STRIPE_PRICE_PRO_MONTHLY
```

Each delete asks for confirmation; there is no `--yes`.

After this:

- Checkout answers `503 billing-not-configured`.
- Webhooks and the portal keep working, so existing owners can still cancel, and cancellations still unlock.

To restore sales, re-run d2 and d3.

### g2. Turn all billing off

```zsh
wr secret delete STRIPE_SECRET_KEY
```

After this:

- Checkout, portal and webhook all answer 503.
- Stripe keeps retrying the failed webhooks for up to 3 days. Restoring the key within that window (d1) lets them land; nothing is lost.
- Sign-in and locks are unaffected.

To also stop Stripe sending events, disable the endpoint in the Dashboard (Developers → Webhooks → Disable).

### g3. Roll back code

`wr rollback` cannot cross migration v4 (see e2). Instead:

- **If the bug is in Pro code:** fix forward. Or turn billing off (g2) and leave the routes inert: with no session and no billing, they only answer 401/503.
- **If the bug is in shared code (sync, rooms) and you need the old behavior now:** deploy the previous code **forward** with the Accounts class kept.
  1. Check out the last good commit.
  2. Copy back `src/Accounts.js`, `src/Stripe.js` and `src/LockClient.js` from `pro`.
  3. Add `export { Accounts } from './Accounts.js';` next to the other class exports at the top of `src/index.js`, as on `pro`.
  4. Keep the `ACCOUNTS` binding and the `v4` migration in `wrangler.jsonc`.
  5. Run `wr deploy --dry-run`, then `wr deploy`.

  The class stays and its data is untouched. If no Pro calendar exists yet, that is enough. If one does, the old `CalendarRoom` code would not enforce its lock: tell the owners or fix forward instead.
- Rolling back between two versions *after* v4 is allowed:

```zsh
wr deployments list
wr rollback <version-id> --message "reason"
```

### g4. Unlock a calendar by hand (support, disputes, a stuck lock)

Read the admin secret without echoing it, then check the lock:

```zsh
read -rs "IMPORT_SECRET?IMPORT_SECRET: " && echo
curl -s -H "Authorization: Bearer $IMPORT_SECRET" "https://pastecal.com/api/admin/cal/<calendarId>/lock-status"
```

Unlock it. `ownerId` is optional for an admin unlock:

```zsh
curl -s -X POST -H "Authorization: Bearer $IMPORT_SECRET" -H "Content-Type: application/json" --data '{}' "https://pastecal.com/api/admin/cal/<calendarId>/unlock"
```

After an unlock, the next sync takes the calendar's current copy as the baseline. **An unlock is undone by the next webhook while the subscription is still active**, because any `customer.subscription.updated` re-locks a paid calendar. So also stop the subscription:

```zsh
stripe subscriptions list --live --status=active --limit 100 2>/dev/null | jq -r '.data[] | select(.metadata.calendar_id=="<calendarId>") | .id'
stripe subscriptions cancel <sub_id> --live
```

Other support routes:

- An owner lost the editor key: `POST /api/admin/cal/<id>/rotate-editor-key` with body `{"ownerId":"<ownerId from lock-status>"}`.
- Find an owner: `GET /api/admin/accounts/lookup?email=`.
- Move a paid calendar to another email: `POST /api/admin/accounts/reassign` with body `{"calendarId":"…","email":"…"}`. It re-locks for the new owner.

Clear the secret from the shell when done:

```zsh
unset IMPORT_SECRET
```

---

## Reference: what the smoke test checks (`scripts/pro-smoke.sh`)

Read-only checks against production:

- `/`, `/pricing`, `/signin` and `/pro/done` load with their own titles. A missing page would return the homepage with a 200, because of the SPA fallback.
- `/api/pro/status?calendar=test` returns exactly `{isOwner, locked, pro}`.
- `/api/me` with no cookie → 401.
- Checkout with no Origin → `403 forbidden-origin` (the CSRF check).
- Checkout and portal with no session → 401 when billing is on, 503 when it is off.
- Webhook with a bad signature → 400 (503 while billing is off).
- `/api/lookup?slug=demo`, a view-only name, has no `targetId`.
- The admin routes with no secret, or a wrong one → `403 forbidden`.

`/api/auth/start` is called only with `--with-email` (it sends an email). Before the Pro deploy, the Pro checks report `NOT-DEPLOYED` and the script exits 0. `--expect-deployed` makes them fail, and `--expect-billing` also fails on 503.
