# Spec: Optional Accounts + Pro Tier (path to $1k MRR)

## Status
Draft — not yet reviewed or scheduled.

## Context / why this exists

pastecal is growing ~10%/month (currently ~13k sessions/mo, ~7,750 new visitors/mo).
Free anonymous "zero-login" calendars stay the permanent core product — that's the
differentiator and must never require an account to use. This spec adds an **optional**
account layer on top, monetized via a cheap annual Pro tier, to test whether that gets
pastecal to $1,000 MRR.

Decision already made (see prior conversation): keep the product zero-friction for the
anonymous case; layer accounts on as pure enhancement, not a requirement.

### Market research grounding this plan

- **Closest business-model precedent: Carrd** (carrd.co). No-login-required core product,
  monetized via a deliberately cheap *annual* Pro tier ($9/$19/$49 per year, not per month).
  Solo-built, ~$30k MRR at scale, run near-solo. Strategy: keep the upgrade bar low rather
  than raise prices, because low friction converts a bigger free base into modest but
  compounding revenue. This is the shape of business pastecal is going for — not a
  team-procurement SaaS sale.
- **Closest direct competitor: TeamUp** (teamup.com). Shared calendars via link, no-login
  for viewers/editors, but the org owner needs an account. Gates **scale** (sub-calendar
  count, users, storage, sync speed, history depth) behind $12–70/mo tiers — nobody pays
  extra to edit; everybody can already edit. Confirms: **gate scale/persistence, not core
  editing features.**
- **Structural analogues for what converts: Excalidraw+ and CryptPad.** Both gate **cloud
  persistence/sync** (vs. local/device-bound storage) as the single strongest Pro lever.
  Neither sells password-protection/access-control as a standalone SKU — it's bundled into
  the same "account tier" as persistence. Password-protection alone is probably too thin a
  gate to convert on its own.
- **Conversion rate reality check:** no one publishes exact numbers for "anonymous-core +
  optional paid layer" (it's rarer and more niche than standard freemium). The closest
  analogue (Pastebin, optional accounts since 2011) suggests account creation itself sits in
  the low single-digit percent of visitors over a long horizon, with paid conversion on top
  of that smaller base again. **Plan against 0.1–0.5% of monthly visitors converting to
  paid**, not the 2–5% typical of forced-signup freemium products.
- **Failure mode to avoid:** forcing or quasi-forcing login kills conversion broadly (46% of
  users abandon at forced auth per industry data) — any upgrade nudge that makes the free
  flow feel gated is the single biggest risk to this plan. The account layer must stay
  visibly optional at every step.

### The MRR math (see modeling below)

At pastecal's actual ~10%/month compounding growth rate, modeling monthly new-payer
acquisition as (monthly new visitors × conversion rate), accumulating over time:

| Price/yr | Conversion | Crosses $1k MRR at |
|---|---|---|
| $20/yr | 0.1% | ~month 23 |
| $20/yr | 0.3% | ~month 14 |
| $50/yr | 0.1% | ~month 15 |
| $50/yr | 0.3% | ~month 8 |

**Conclusion: $1k MRR is realistically 8–23 months out**, not years (flat-traffic math
said years; compounding growth changes this materially) and not weeks. A **$50/yr price
point reaches the goal roughly 1.5–2x faster** than $20/yr at the same conversion rate,
and $50/yr is still in line with Carrd's top annual tier ($49/yr), so it doesn't break the
"cheap utility" psychology.

**Recommended price: $39/yr** (splitting the difference — cheap enough to impulse-buy,
priced above the $20 floor to reach the goal faster). Revisit after real conversion data
from the first 60–90 days.

## What's being built

### 1. Optional account (Firebase Auth)

- Add Firebase Authentication (email/password + Google sign-in) as a **fully optional**
  layer. No feature of the free anonymous flow (create calendar, edit, share link, ICS
  export, read-only public view) changes or requires this.
- Entry points: a small "Sign in" affordance in the nav (non-intrusive, same visual weight
  as the existing recents dropdown), and a contextual prompt inside the existing
  `ShareOrClaimUI` / claim flow ("Claim URL" already exists as a concept — see
  `specs/creation_flow.md` and `public/js-old-components/components/ShareOrClaimUI.js`).
  The natural moment to introduce "sign in to keep this forever" is right after a user
  claims a custom slug — that's already the moment they've expressed ownership intent.

### 2. Data model changes

Current RTDB shape (from `functions/index.js` and `database.rules.json`):

```
calendars/{id}            — full calendar doc, world-readable/writable
calendars_readonly/{id}    — read-only mirror (public view links)
slug_mappings/{slug}       — case-insensitive lookup cache
```

Add:

```
users/{uid}: {
  email,
  createdAt,
  plan: "free" | "pro",
  proExpiresAt,             // epoch ms; null/absent = free
  stripeCustomerId,
}

calendars/{id}/options: {
  ...existing options...
  ownerId: uid | null,       // NEW — set when a signed-in user claims/creates a calendar
}

user_calendars/{uid}/{calendarId}: true   // NEW — index for "my calendars" dashboard,
                                          // avoids scanning all of `calendars` per user
```

Security rule changes (`database.rules.json`):

```json
{
  "rules": {
    "calendars": {
      "$id": {
        ".read": true,
        ".write": true
      }
    },
    "user_calendars": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": false
      }
    }
  }
}
```

Note: `calendars/$id` stays world-writable — **ownership does not change edit
permissions**. Anyone with the link can still edit, exactly as today. `ownerId` is
metadata for the dashboard/persistence feature, not an access-control gate on the
calendar itself. This preserves the wiki-style editing model that's the whole point of
the product, and avoids the "Rename/Move" hijacking problem already identified in
`creation_flow.md` (§ Security Considerations) — we are not changing who can write to a
calendar, only who gets a persistent index of "calendars I claimed."

### 3. Free tier: what stays exactly as-is

- Create a calendar instantly, no login. Works today, unchanged.
- Edit any calendar with the link. Unchanged.
- Custom slug claiming (`createPublicLink` / `SlugManager`). Unchanged.
- ICS export/subscribe. Unchanged.
- `recentCalendars` via localStorage (device-bound). Unchanged — stays as the free,
  no-account "recents" mechanism.

### 4. Pro tier ($39/yr): what's gated

Per the research, gate **scale/persistence**, not editing features, and bundle
access-control into the same tier rather than sell it alone:

1. **Synced multi-calendar dashboard.** Signed-in users see all calendars they've
   claimed (via `user_calendars/{uid}`) from any device — replaces the fragile
   localStorage-only "recents." **This is the primary hook to get people to create a free
   account at all** (free accounts see their own dashboard; Pro is what happens after
   that account already has value). Free account = no cap disclosed yet, cap enforced at
   low ceiling (e.g. 3 calendars) once usage data shows where casual users land; Pro =
   unlimited.
2. **No-expiry guarantee.** *(Requires a companion decision: introduce an inactivity-based
   expiry/prune policy for free anonymous calendars — pastecal has none today. This is a
   prerequisite, not a Pro feature by itself — see Open Questions.)* Once expiry exists,
   "claim it with a free account to keep it a while longer, upgrade to Pro to keep it
   forever" becomes a natural, low-resistance upgrade trigger timed to real user concern.
3. **Password-protected / private calendars**, bundled into Pro rather than sold alone
   (per Excalidraw+/CryptPad precedent that standalone access-control doesn't convert
   well). This is the feature already scoped in `NOTES.md` ("Password protection",
   "Once it's password protected, can't be un-protected [for simplicity]").
4. **True rename/move** (delete-on-move, not copy-on-move). Currently blocked per
   `creation_flow.md` because there's no ownership model to prevent hijacking. `ownerId`
   solves this: only the owning `uid` can perform a destructive move. This closes a
   real, already-identified product gap for Pro users specifically.

### 5. Billing

- Stripe Checkout (annual subscription, $39/yr), Stripe Customer Portal for
  self-serve cancellation. No custom billing UI to build.
- A Cloud Function webhook (`onStripeWebhook`) updates `users/{uid}/plan` and
  `proExpiresAt` on `checkout.session.completed` / `customer.subscription.deleted`.
- Firestore/RTDB write is the source of truth the client reads; Stripe is not queried
  live from the client.

## Rollout sequencing

1. **Ship accounts + free dashboard first, with no paywall at all for 2–4 weeks.**
   Goal: validate that people actually want a persistent multi-calendar dashboard before
   building billing. If sign-up-for-a-dashboard has near-zero uptake, the whole Pro plan
   needs to be rethought before writing a line of Stripe code.
2. **Add the Pro paywall** (persistence guarantee + password-protection + true rename)
   once dashboard adoption is validated.
3. **Track conversion weekly** against the modeled 0.1–0.5% range. If month-3 actual
   conversion is near the low end, re-evaluate price ($50–60/yr) before assuming more
   traffic alone fixes it — per the earlier analysis, a dead gate isn't fixed by scale.

## Open questions (need a decision before/during build)

- **Does a free-tier expiry policy get introduced at all?** This is the single biggest
  open decision — it's the cleanest upgrade trigger (Excalidraw+/CryptPad/Pastebin all use
  some version of "free = ephemeral/limited, paid = permanent"), but pastecal has never
  expired calendars and doing so is a behavior change for existing free users, not just new
  ones. Needs explicit sign-off, and if yes, needs a generous grace window (e.g. 12+ months
  of inactivity) communicated clearly, not silent deletion.
- **Free account calendar cap** — pick a number (e.g. 3) once we can see real distribution
  of how many calendars a claiming user tends to make.
- **Google sign-in vs. email/password only for v1** — recommend both via Firebase Auth's
  built-in providers, minimal extra work.
- Does `calendars_readonly` need an `ownerId` too, or does it only ever need to track back
  to the source `calendars/{id}` (it already mirrors `options`, so `ownerId` would flow
  through automatically via `syncPublicView` — confirm this is sufficient).

## What this spec explicitly does not do

- Does not change edit permissions on any calendar — link-holders can still edit,
  free or Pro, exactly as today.
- Does not require an account to use any existing feature.
- Does not build a team/multi-user-role system (that's the "pivot to team SaaS" path,
  explicitly not chosen — see prior conversation).
- Does not commit to the expiry policy — that's an open question requiring a separate
  decision, called out above, not bundled silently into this build.
