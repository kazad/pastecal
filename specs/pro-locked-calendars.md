# Spec: Pro — Locked Calendars ($25/yr)

## Status
Draft. Supersedes the pricing/gating decisions in `pro-accounts-monetization.md`
(see "Relationship to the earlier spec" below). Not yet scheduled.

## The product in one sentence

Every pastecal calendar is world-writable by anyone with the link. **Pro is paying
$25/year to make one yours: you get admin control, and nobody else can edit it.**

That's the whole pitch. Not a vanity URL, not a dashboard, not sync. The free tier
already lets anyone claim any name — what it can't do is stop a stranger who finds
the URL from editing or wrecking it. That gap is the product.

## Why this and not the earlier plan

`pro-accounts-monetization.md` proposed gating persistence/sync/dashboard and
explicitly stated ownership would *not* change edit permissions
(§2: "`calendars/$id` stays world-writable — ownership does not change edit
permissions"). That reasoning came from Excalidraw+/CryptPad precedent, where the
free artifact is already private so access control is redundant.

**Pastecal is the opposite case.** The free artifact is world-writable to anyone
who has or guesses the URL. Access control isn't a redundant add-on here — it's the
answer to the one question every serious user eventually asks, and today the honest
answer is "nothing stops them." A synced dashboard is a convenience nobody loses
sleep over; an unprotected calendar is a real anxiety. We sell the anxiety fix.

## Pricing: $25/yr

Recurring, not one-time. One-time would sell permanent hosting, permanent access
control, and permanent defense of a name for a single payment — an unbounded
liability against a recurring cost.

$25/yr is below the threshold where anyone deliberates, and it sits in the same
mental bucket as a domain renewal, which needs no explanation.

**Do not over-tune this number.** At current traffic the price is nearly untestable
— the earlier spec's own 0.1–0.5% conversion range against ~7,750 new visitors/mo
is single-digit-to-~39 new payers a month at any price in the $20–50 band. The
number that matters is traffic × conversion, not the price. Revisit after there are
enough payers for a price change to produce a readable signal.

### Honest math on "thousands of calendars"

The goal is thousands of calendars at $25/yr. That is a real business (~$50k/yr at
2,000) and it is reachable, but it is a **compounding-growth outcome, not a
feature outcome**. At 0.1–0.5% conversion on ~7,750 new visitors/mo, even with the
observed ~10%/month traffic growth, 2,000 payers is on the order of 2.5–4 years.

Nothing in this spec accelerates that. The levers are traffic and conversion rate.
This is recorded here so the spec is not mistaken for a plan that produces
thousands of payers by shipping the features in it.

## The hard technical constraint (read before designing anything)

**Locking cannot be a field on the calendar.**

Current state:

- `database.rules.json` grants `calendars/$id` `".read": true, ".write": true`.
- `public/js-old-components/firebase.js:246,269,279` writes directly to
  `/calendars/{id}` via the Firebase client SDK — not through a Cloud Function.

So a calendar with `options.locked = true` living at a world-writable path is still
writable by anyone. The flag would be a suggestion the client is free to ignore, and
"the lock is enforced in the UI" is not a thing anyone should pay $25/yr for. Worse,
an attacker can simply clear the flag.

**Locking must be enforced in `database.rules.json`.** Everything below follows from
that. This is the single largest piece of work in the spec and the reason it is not
a weekend change.

Note that `slug_mappings` is already fully client-locked
(`".read": false, ".write": false`) and mediated by Cloud Functions — so the
slug/claim path already has a server-side chokepoint to build on.

## Design

### 1. Optional accounts (Firebase Auth)

Email/password + Google. Required **only** to buy and hold a locked calendar.
Nothing in the free anonymous flow changes: create, edit, share, ICS export, and
read-only views all continue to work with no account. Sign-in surfaces at exactly
one moment — when someone chooses to lock a calendar.

### 2. Data model

```
users/{uid}: {
  email,
  createdAt,
  plan: "free" | "pro",
  proExpiresAt,          // epoch ms
  stripeCustomerId,
}

calendars/{id}/options: {
  ...existing...
  ownerId: uid | null,   // set at lock time; null = unlocked, world-writable as today
}

user_calendars/{uid}/{calendarId}: true    // index for "my calendars"
```

`ownerId` is the enforcement key, not metadata.

### 3. Security rules — the actual mechanism

```json
{
  "rules": {
    "calendars": {
      "$id": {
        ".read": true,
        ".write": "!data.child('options/ownerId').exists() || data.child('options/ownerId').val() === auth.uid"
      }
    }
  }
}
```

Reads: unchanged and public. A locked calendar stays world-*readable* — this is
deliberate and load-bearing (see Displacement below).

Writes: allowed if the calendar has no owner (today's behavior, preserved exactly)
or if the writer is the owner.

Two consequences to design around, both of which need verification during build:

- **The lock write itself.** Setting `ownerId` is a write by a user who is not yet
  the owner, and `newData`-based rules are easy to get subtly wrong here. Do the
  lock server-side in a Cloud Function (`lockCalendar`) using the Admin SDK, which
  bypasses rules entirely. The rule above then only ever has to evaluate the
  steady state. This also gives one place to check the payer's plan.
- **`syncPublicView` and the readonly mirror.** `functions/index.js:437` mirrors
  `calendars/{id}` into `calendars_readonly/{publicViewId}` with the Admin SDK, so
  it is unaffected by the rule. `calendars_readonly` is already `".write": false`
  for clients. Confirm `ownerId` flowing into the mirror is harmless (it should be
  — the mirror is read-only regardless).

### 4. What Pro gets

1. **Exclusive edit access.** Only the owner can write. The core of the purchase.
2. **True rename/move.** Currently blocked per `creation_flow.md` for lack of an
   ownership model; `ownerId` unblocks destructive moves for the owner.
3. **"My calendars" list** for signed-in owners, from `user_calendars/{uid}` —
   included because once accounts exist it's nearly free, not as a separate sell.

Explicitly **not** in v1: password-protected calendars (the `NOTES.md` idea).
Owner-only-write already delivers the protection people want, and password
protection carries the irreversibility problem NOTES.md itself flags ("once it's
password protected, can't be un-protected"). Revisit only if users ask for
shared-secret access rather than account-based access.

### 5. Billing

Stripe Checkout (annual, $25/yr) + Stripe Customer Portal for self-serve
cancellation. A Cloud Function webhook updates `users/{uid}/plan` and
`proExpiresAt` on `checkout.session.completed` and
`customer.subscription.deleted`. RTDB is the source of truth the client reads;
Stripe is never queried from the client.

### 6. Expiry / non-payment

When Pro lapses, **the calendar unlocks — it is never deleted.** Clear `ownerId`
and the rule reverts the calendar to today's world-writable behavior. The user
loses exclusivity, not data.

This is the entire lapse policy. No free-tier expiry or pruning policy is
introduced — that was the earlier spec's biggest open question and it is simply
dropped, because it's a behavior change for existing free users that this product
doesn't need.

## Claiming and displacement

**Locking is first-come, first-served. No eligibility rules, no inactivity
detection, no dispute flow.** Whoever pays first gets admin over that name.

Rationale: at current user counts, two parties contending for the same calendar is
a hypothetical, and the mitigation is already in the product — a displaced user can
still **view and export** the calendar (locked calendars stay world-readable, and
ICS export remains open), so they can move their data elsewhere. That's a support
email, not an architecture problem.

If this happens more than once in practice, revisit then with real cases in hand.

**Prerequisite:** because export *is* the displacement escape hatch, verify before
launch that ICS export works for a non-owner on a locked calendar and is reachable
in the UI without admin rights. This is the one thing that must be true for the
policy above to be honest.

## Build order

1. **Rules + `lockCalendar` function, behind a flag, no billing.** This is the risky
   part; prove owner-only-write actually holds before building anything around it.
   Test explicitly: non-owner write to a locked calendar must fail; anonymous write
   to an unlocked calendar must still succeed (regression); `syncPublicView` must
   still mirror.
2. **Verify non-owner export** on a locked calendar (per prerequisite above).
3. **Firebase Auth + "my calendars".**
4. **Stripe Checkout, webhook, Portal.**
5. **Lock affordance in the claim/share UI**, using the existing `ShareOrClaimUI`
   surface and the "URL Builder" direction from `claim_ux_concepts.md`.

Steps 1–2 are the ones that can invalidate the plan. Do them first and stop if
owner-only-write can't be made to hold cleanly.

## Risks

- **Rules complexity is the whole bet.** If owner-only-write can't be enforced
  cleanly at `calendars/$id`, there is no product — the fallback would be routing
  all writes for locked calendars through a Cloud Function, which is a much larger
  change to `firebase.js` and adds latency to every edit. Know this before step 3.
- **Locking undercuts the wiki-style model** that is pastecal's differentiator. It
  is opt-in and per-calendar, so the default product is unchanged — but resist any
  future pressure to make locking the default.
- **Timeline vs. ambition.** See the math above. The feature set here does not by
  itself produce thousands of payers.

## Open questions

- Does a locked calendar need a **co-editor list** (owner + invited accounts), or is
  single-owner enough for v1? Single-owner is simpler and likely right initially,
  but "my team needs to edit it" is the obvious first request from anyone paying to
  lock a shared calendar — and it's the case most likely to make owner-only feel
  broken. Worth a decision before step 3, since it changes the rule shape.
- Should locking be available to free accounts for one calendar, to drive signups?
  Decided against for now (locking is the paid thing), but it's the most plausible
  future concession if conversion is dead.
- Does the lock affordance appear on *any* calendar, or only ones the user created
  this session? Showing it everywhere advertises the feature but also advertises
  that other people's calendars can be taken.

## Relationship to the earlier spec

`pro-accounts-monetization.md` keeps its value as market research (Carrd/TeamUp
precedent, conversion-rate reality check, the MRR model) and that research is not
re-litigated here. What this spec overrides:

- **Price:** $39/yr → **$25/yr**.
- **What's gated:** persistence/sync/dashboard → **exclusive edit access**.
- **Ownership semantics:** metadata only → **enforced in security rules**.
- **Free-tier expiry:** open question → **dropped entirely**.

## Relationship to a third, rejected plan (vanity-path packaging)

A third draft (`PasteCal_Pro_Implementation_Plan.md`, produced externally without
access to this repo) proposed a different Pro packaging: unlimited calendar
creation + reserving up to 3 top-level vanity paths per account
(`pastecal.com/department`), billed the same $25/yr. Reviewed and **not adopted**
as written — it assumed infrastructure pastecal doesn't have (a SQL `Users`/`Paths`
schema with migrations, a routing middleware layer intercepting `GET /:slug`) where
the real stack is Firebase RTDB + Hosting rewrites + the `createPublicLink` Cloud
Function (`functions/index.js`). More importantly, its core pitch — pay to get more
slugs and no caps — is the packaging this spec already superseded once (that was
`pro-accounts-monetization.md`'s persistence/scale framing); it says nothing about
access control, which is the actual gate this spec is built around.

Two pieces were worth keeping and have been folded in elsewhere rather than kept as
a separate plan:

- **Expanded reserved-slug list.** `SlugService.validateSlug` in `functions/index.js`
  had a 7-word reserved list; extended to the ~90-word list the draft proposed
  (`about`, `admin`, `billing`, `dashboard`, `pricing`, etc.). Unrelated to Pro
  gating — this is a free-tier correctness fix (stops anyone claiming
  `pastecal.com/pricing`) and applies regardless of what happens to locking.
- **Billing shape.** The draft's webhook/Checkout/Portal sketch
  (`checkout.session.completed` → active, `customer.subscription.deleted` →
  degrade-not-delete) is directionally identical to §5 above and needed no new
  ideas, just the RTDB/`users/{uid}` target instead of a SQL row.

**"Claim more vanity paths" as a Pro lever is not currently planned, but isn't
ruled out as a future angle either** — if it's revisited, it should be scoped as
its own spec against the real slug/claim mechanism (`SlugManager.js`,
`createPublicLink`), and reconciled with this spec's packaging rather than
proposed as a competing "what Pro means" without addressing why locking was chosen
over scale/caps in the first place.
