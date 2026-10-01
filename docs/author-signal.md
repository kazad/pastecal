# Author signal: who most likely owns a calendar

`database.rules.json` cannot hold comments (Firebase rejects the file), so the reasoning
behind the `calendar_authors` rules lives here.

## The problem

pastecal is an open wiki by design: anyone with `pastecal.com/<id>` can read and write it.
That is the product, not an oversight, and this does not change it.

The cost of that design is that nothing on a calendar says whose it is. If a slug leaks, or
two groups collide on one (there are ~107 pairs of calendars whose slugs differ only by
case), there is no way to tell the owner from the interloper — both are just anonymous
writers.

## The signal

Each browser signs in anonymously (`firebase.auth().signInAnonymously()` in `index.html`)
and records, per calendar it edits, under `/calendar_authors/<slug>/<uid>`:

| field | meaning |
|---|---|
| `firstSeen` | server time of this browser's first recorded write (set once, never moved) |
| `lastSeen` | server time of the most recent write |
| `editCount` | number of writes (each write adds exactly 1) |
| `days/<YYYY-MM-DD>` | a day active; the value is the server time of that write |
| `createdHere` | true if this record was written in the same write that created the calendar |

Records written before the rules were hardened (October 2026) may hold `days/<day>: true`
and client-clock timestamps; treat them as unverified.

Read it with `node internal/scripts/authors.js <slug>`.

## Why anonymous auth and not a localStorage id

A localStorage id is a number the client *claims about itself*, so anyone could send
someone else's and the records would be worthless as evidence exactly when they mattered.

`auth.uid` is asserted by Firebase, and the rule `auth.uid === $uid` means a browser can
only ever write under its own id. That stops a browser from writing as *someone else*. It
does not stop a browser from lying about *itself* — so the rules also constrain the values.

Firebase anonymous auth was already enabled on this project and `firebase-compat.js`
already ships the auth SDK, so this cost one function call.

## Why `.read: false`

Nothing in the UI shows authorship. A publicly readable `calendar_authors` would be a list
of which browsers edit which calendars — strictly worse for privacy than the open wiki it
exists to protect. Reads happen server-side via the Admin SDK.

## Why the data cannot live on the calendar node

`CalendarDataService.sync()` calls `.set()` on the entire calendar node from client state.
Anything stored inside the calendar would be wiped by the next write from any browser, and
a stale client would clobber a newer one's records. Hence a sibling node the client can
only append to.

## Why v2 triggers could not do this instead

A Cloud Function trigger would have been tamper-proof without any client change, but
firebase-functions v2 RTDB triggers carry **no auth context** (v1's `context.auth` was
dropped). A trigger can see that a calendar changed, not who changed it. So the client
writes the uid and the security rules constrain it.

## Ranking, and why not by edit count

`authors.js` orders candidates by: presence at creation, then distinct active days (counted
from the server timestamps stored as values, see below), then how early they appeared, then
raw edits.

Edit volume is deliberately last. Ranking by it would hand ownership to whoever typed the
most — precisely the wrong answer during a takeover. 400 edits in one afternoon is a busy
visitor; 400 edits across 90 days is whoever runs the calendar.

## What the rules enforce, and what they cannot

A record's owner writes it directly from the browser, so every field is attacker-controlled
unless a rule pins it. The original rules only type-checked, so a browser could write
`{createdHere: true, firstSeen: 0, days: {...365 keys}, editCount: 1e9}` under its own uid
and outrank the real owner on every ranking criterion. The rules now enforce:

| field | rule | what it prevents |
|---|---|---|
| `firstSeen` | equals the server's `now` when first written, then can never change | backdating; resetting |
| `lastSeen` | equals `now` on every write, and every write must set it | claiming recent activity without writing |
| `editCount` | created as exactly 1; every write must raise it by exactly 1 | inflating edits in one write |
| `days/$day` | key shaped `YYYY-MM-DD`, value equals `now` | stamping days with any time but the present |
| `createdHere` | only `true`, only on a brand-new record, only in the write that creates the calendar, and only if `/history/<slug>` is empty | claiming creation of an existing calendar, or of one deleted and recreated |
| record | needs `firstSeen`, `lastSeen`, `editCount`; no other fields; the calendar must exist after the write; cannot be deleted | junk fields; records for unsaved ids; resetting a record to start over |

What remains possible, because the rules language cannot express it:

- **Day keys are not checked against the date.** Rules have `now` as a number but no way to
  format it as a date, so a write can add any number of well-formed keys. Each one's value
  must equal `now`, so **`authors.js` must count distinct days from the values (server
  timestamps), not the keys** — then 365 keys written at once count as one day. Legacy `true`
  values predate the hardening and can only be counted by key.
- **Volume is only rate-limited by patience.** `editCount` moves by 1 per write, but nothing
  limits how many writes a browser makes. That is why ranking puts edit count last.
- **Distinct days take real days, not real use.** A browser that writes once a day for 90
  days earns 90 days. The rules make history impossible to backdate, not impossible to
  accrue on purpose; a patient attacker who starts *before* an incident still builds a record.
- **`createdHere` cannot tell a copy from a creation.** Renaming creates a new slug, and the
  rules would accept `createdHere` there; the client simply does not send it for a copy.
  Likewise anyone may create a fresh slug and be its creator — which is true.
- **Uids are free.** Anonymous sign-in mints a new uid on demand, so an attacker can create
  many records. Each starts at `now` with no history, so none outranks an established owner.

So the honest claim is: records cannot be backdated, cannot claim creation of a calendar
that already existed, and cannot pack more than one day of activity into a day. They can
still be grown deliberately, at the rate of real time.

## Limits, stated plainly

- **A uid is a browser, not a person.** It dies on cache clear and does not follow someone
  to their phone, so one person may appear as several uids.
- **History starts at deploy.** A calendar created in 2025 shows nothing until its owner
  next edits it. `createdHere` only ever exists for calendars made after this shipped.
- **It is circumstantial evidence, not proof.** It shows continuity of use, which is the
  strongest thing available in a product with no accounts.
