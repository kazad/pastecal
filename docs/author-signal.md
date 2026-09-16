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
| `firstSeen` | first time this browser touched the calendar (set once, never moved) |
| `lastSeen` | most recent touch |
| `editCount` | total writes |
| `days/<YYYY-MM-DD>` | set of distinct days active |
| `createdHere` | true if this browser was present when the calendar was created |

Read it with `node internal/scripts/authors.js <slug>`.

## Why anonymous auth and not a localStorage id

A localStorage id is a number the client *claims about itself*, so anyone could send
someone else's and the records would be worthless as evidence exactly when they mattered.

`auth.uid` is asserted by Firebase, and the rule `auth.uid === $uid` means a browser can
only ever write under its own id. Forgery is prevented at the database layer rather than by
client good behavior.

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

`authors.js` orders candidates by: presence at creation, then distinct active days, then
how early they appeared, then raw edits.

Edit volume is deliberately last. Ranking by it would hand ownership to whoever typed the
most — precisely the wrong answer during a takeover. 400 edits in one afternoon is a busy
visitor; 400 edits across 90 days is whoever runs the calendar.

## Limits, stated plainly

- **A uid is a browser, not a person.** It dies on cache clear and does not follow someone
  to their phone, so one person may appear as several uids.
- **History starts at deploy.** A calendar created in 2025 shows nothing until its owner
  next edits it. `createdHere` only ever exists for calendars made after this shipped.
- **It is circumstantial evidence, not proof.** It shows continuity of use, which is the
  strongest thing available in a product with no accounts.
