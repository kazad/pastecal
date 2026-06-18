# PasteCal UX Review — "Instant Start" / Quick-Start Pills

**Date:** June 2026
**Scope:** First-run & onboarding experience, reviewed through the lens of a microwave's
"quick 30" / Instacalc's no-ceremony instant input — plus a recommendation on whether to
add quick-start "pills" for common scenarios on the homepage.

## Deliverable
- **[PasteCal-UX-Review.pdf](./PasteCal-UX-Review.pdf)** — the full review with annotated screenshots.
- `report.html` — source for the PDF (open in a browser; images load from `screenshots/`).
- `screenshots/` — captures from the live app (desktop 1280×860, mobile 390×844).

## TL;DR
- PasteCal **already embodies the "quick 30"**: you land in a working, editable calendar with a
  real URL and a sample event — no login, no setup. Keep that.
- The truest one-tap primitive is **natural-language Quick Add** ("lunch tomorrow 2pm"), but it's
  under-surfaced (Cmd+E on desktop, buried in the kebab menu on mobile). **Make it the always-visible
  primary action first** — that's the change that most delivers "just gets things going."
- **Quick pills: yes** — as the microwave's *preset buttons* layer. A single dismissible
  "Start with:" row (Team meetings · Trip planning · Event/RSVP · Office hours · Club schedule ·
  Reservations) that **seeds a template and suggests a slug**, shown only on fresh/unclaimed
  calendars. Measure pill-click → claim conversion.

## Notable bug surfaced
There are two `create()` methods in `public/app.js`; the second overrides the first, so the
specced "Name your calendar" claim-intervention modal (`specs/creation_flow.md`) never fires —
clicking **Claim URL** navigates immediately.

See the PDF for the prioritized order of work.
