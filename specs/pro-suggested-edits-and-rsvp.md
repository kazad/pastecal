# Spec: Viewer Feedback on Calendars — Suggested Events & RSVP

## Status
Draft — exploratory, not reviewed or scheduled. Depends on
`pro-locked-calendars.md` for one of its two features (see below); does not
depend on it for the other.

## Context / why this exists

Raised as a "what if" against the Pro-locked-calendars direction: once a
calendar has an owner and stops being world-writable, does the owner lose
something valuable — the ability for other people to contribute? This spec
is the answer: a **moderated** channel for viewer input, instead of the
**direct** one that locking removes.

This is not one feature, it's two, with different prerequisites, different
build cost, and arguably different audiences. Bundling them under one
"viewer engagement" banner would hide that. They're specced separately
below and should probably ship (or not ship) independently.

## The two features

### A. Suggested events (approval queue)

A viewer proposes a new event; the owner approves it into the real calendar
or rejects it. Nothing the viewer submits is visible on the calendar until
approved.

**Hard prerequisite: this only makes sense on a locked calendar.**
On today's free, world-writable calendar, "suggest an event" is a
redundant extra step — the viewer could just add the event directly, and
usually will, because that's the entire current product. Suggestions are
only a meaningful feature once direct writes are blocked, i.e. once
`options.ownerId` exists per `pro-locked-calendars.md`. This feature is
best understood as **a companion to locking, not a standalone Pro SKU** —
without locking shipped first, there's nothing for it to sit on top of.

**Data model** (additive to `pro-locked-calendars.md`'s shape):

```
calendars/{id}/suggestions/{suggestionId}: {
  title, start, end, notes, ...           // same shape as a normal event
  suggestedAt,
  suggestedByName,        // free-text, optional — viewers aren't authenticated
  status: "pending" | "approved" | "rejected",
}
```

Kept as a sub-path of the calendar, not a new top-level tree — it's
calendar-scoped data and should ride along with `syncPublicView` deletion
cleanup, cache invalidation, etc. the same way `options` does.

**Security rules** — this is the part that needs real thought, not a quick
addition:

```json
"suggestions": {
  "$sid": {
    ".read": true,
    ".write": "!data.exists() || data.child('status').val() === 'pending'",
    // anyone can create a new pending suggestion;
    // only the current status transition matters, ownership is checked
    // separately for the *approve/reject* action below
  }
}
```

That rule alone allows anyone to flip `status` on anyone else's
suggestion, which is wrong — approving/rejecting must be owner-only. Two
ways to get there, in order of preference:

1. **Do approve/reject through a Cloud Function** (`resolveSuggestion`),
   using the Admin SDK and checking `auth.uid === calendar.options.ownerId`
   server-side. This mirrors exactly how `pro-locked-calendars.md` handles
   the lock-write itself ("Do the lock server-side... this also gives one
   place to check the payer's plan"). Recommended for the same reason: it
   keeps the RTDB rule simple (create-only for viewers) and puts the one
   piece of real authorization logic in one server-side place instead of
   trying to express "only the owner can change status, but anyone can
   create" as a single rules expression.
2. Express it in rules directly with `root.child(...).val() === auth.uid`
   comparisons against the parent calendar's `ownerId`. Possible, but this
   is exactly the kind of rules complexity `pro-locked-calendars.md` flags
   as "the single largest piece of work in the spec" for the simpler
   owner-only-write case — doing it twice, for a nested path with a status
   state machine, is more risk for a smaller feature. Don't do this unless
   the Cloud Function path turns out to add unacceptable latency.

**On approval**: the Cloud Function copies the suggestion into
`calendars/{id}/events/{newId}` (Admin SDK, bypasses the write rule same as
`syncPublicView` does today) and deletes or marks the suggestion resolved.
**On rejection**: mark resolved, don't delete immediately — an owner who
mis-clicks "reject" should be able to see what they rejected for a window,
same instinct as the display of Notes/edit history elsewhere in the
product. Exact retention isn't decided here.

**UI surface**:
- Viewer side: on a locked calendar, "Suggest an event" replaces the
  normal add-event affordance for non-owners (who currently see nothing,
  since the calendar is locked — this is new territory, not a regression).
  Submits into the pending queue, viewer gets a toast confirmation, no
  further visibility into approval status (v1 — see open questions).
- Owner side: a pending-suggestions indicator (badge count, similar
  pattern to the existing `ToastNotification`/badge conventions) with a
  simple approve/reject list. Does **not** need a diff/merge UI in v1 —
  a suggestion is a full new event, not an edit to an existing one (see
  scope note below).

**Explicitly out of scope for v1**: suggested *edits* to existing events
(as opposed to suggested *new* events). "Suggest an edit" implies a
diff/merge UI against the current event and a conflict story if the owner
edits the same event in the meantime — meaningfully more complex than an
approval queue for net-new items. If there's demand for this after v1
ships, it's a separate follow-up, not an assumed part of this spec.

### B. RSVP / react on existing events

A viewer marks themselves going/maybe/not going (or leaves a lightweight
reaction) on an event the owner already created.

**No lock prerequisite.** Unlike suggestions, this doesn't touch write
access to the calendar's core content — it's a new, narrower write
surface (responses to one event) that's orthogonal to who can edit the
event itself. It works exactly the same on a free, world-writable
calendar as on a locked one. This is the meaningful design fork against
feature A: RSVP is a general engagement feature, not inherently a
locked-calendar companion.

**Data model:**

```
calendars/{id}/events/{eventId}/responses/{responseId}: {
  name,                    // free-text, viewers aren't authenticated
  status: "going" | "maybe" | "no",
  respondedAt,
}
```

**Security rules:**

```json
"responses": {
  "$rid": {
    ".read": true,
    ".write": "!data.exists()"   // create-only; no edit/delete of others' RSVPs
  }
}
```

Simpler than feature A's rules problem — there's no approval gate, no
owner-only transition, just append-only responses anyone can read. This is
close to today's `calendars/$id` shape (`.read: true, .write: true`) and
doesn't need a Cloud Function chokepoint the way approval does.

**UI surface**: response buttons on the event popover/detail view, a
count/avatar-stack summary on the event chip in month/week view (subject
to the space constraints already documented for month-view event chips
elsewhere in the codebase). No moderation UI needed since there's nothing
to approve.

**Abuse surface, worth naming even though it's low-severity**: since
responses are unauthenticated free-text like the rest of pastecal's model,
anyone can submit junk RSVPs (fake names, spam text in the name field) on
any event on any calendar, locked or not. This is the same trust model the
whole product already runs on (anyone with the link can currently retitle
or delete the event outright, which is strictly worse) — so it's not a new
category of risk, just noting it doesn't need special defense beyond what
exists today. An owner can presumably delete individual responses if it
gets abused; that's a cheap escape hatch, not a policy this spec needs to
design further.

## Where this fits relative to the other two specs

- `pro-accounts-monetization.md` — superseded pricing/gating model, kept
  for its market research only (per `pro-locked-calendars.md`'s own
  framing). Not otherwise relevant here.
- `pro-locked-calendars.md` — the current Pro direction: $25/yr,
  owner-only-write, no dashboard, no password protection. **Feature A
  above is a direct extension of that spec** and should not be built,
  priced, or scheduled independently of it — it has no prerequisite to
  stand on otherwise. **Feature B has no dependency on it** and could be
  evaluated as its own free-tier or Pro-tier decision.

## Open questions

- **Pro gating for each feature** — deliberately left undecided here
  rather than assumed:
  - Feature A (suggestions) most naturally rides along with the same
    $25/yr tier as locking, since it has no independent reason to exist
    without a locked calendar underneath it. Whether it's *included* in
    that $25/yr or a further upsell on top is a pricing call, not a
    technical one.
  - Feature B (RSVP) is the one with a real free-vs-Pro choice: it could
    ship free as a general engagement/growth lever (gives non-payers a
    reason to interact with a calendar beyond viewing, which the free
    tier currently has zero of), or it could be bundled into Pro as
    another reason to lock a calendar. No recommendation made here —
    this needs the same kind of "what's the actual gate" reasoning
    `pro-locked-calendars.md` did for locking vs. dashboard/persistence.
- **Does a viewer get any feedback after suggesting an event?** V1 above
  assumes no (fire and forget). If owners routinely reject or ignore
  suggestions, silence may read as broken rather than "pending." A
  read-only "your suggestions" view (keyed on... what, with no account
  system? localStorage-device-bound, matching how `recentCalendars`
  already works for the analogous "no login" problem) is the likely
  answer if this turns out to matter, not designed further here.
- **Suggestion spam/rate-limiting** — an approval queue is a more
  attractive spam target than direct editing was (direct edits are
  visible and reversible by anyone; a queue an owner must wade through is
  a nuisance vector even if nothing gets approved). Not designed here;
  flagging because it's a new failure mode feature A introduces that the
  free product doesn't currently have.
- **Does RSVP responder identity need to survive across visits** (e.g. "I
  already said I'm going, let me change my answer") without an account?
  Today's answer would presumably be the same localStorage-device-bound
  pattern used elsewhere, but that means RSVPs don't follow a person
  across devices — probably fine for v1, noted as a known limitation
  rather than a gap to close now.

## What this spec explicitly does not do

- Does not decide free-vs-Pro gating for either feature (see Open
  Questions) — that's a call for whoever schedules this, informed by
  where `pro-locked-calendars.md` actually lands first.
- Does not design suggested *edits* to existing events, only suggested
  *new* events (see scope note under Feature A).
- Does not build notifications (email/push) for owners when a suggestion
  arrives or for viewers when their suggestion resolves — v1 is
  pull-based (owner checks a badge), not push-based.
- Does not change anything about unlocked, free-tier calendars for
  Feature A — suggestions are meaningless without locking and are not
  proposed there.
