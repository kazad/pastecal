# Why pastecal keeps shipping bugs users find first

Written Sep 25, 2026, after issue #32 came back a second time. Add to it when the next one
does, rather than starting over.

## The incident

A French user (issue #32) wrote on Sep 24: *"Can't change colors when creating time slots.
And no way to save once you've written in the description."* We fixed the **+Event** dialog,
replied "fixed", and closed the loop. On Sep 25 they answered: *"We used to be able to change
colors and write a description without going through +Event. Now when you select a slot,
Save doesn't work."*

What was actually happening, found from their calendar's analytics and a copy of its data:

1. **Save crashed when editing some events.** Their calendar (`/ywxa56kc`) mixes 26 events
   with number ids (made on the grid long ago) and 19 with text uuids (made with +Event, or on
   the grid since Sep 17). Syncfusion decides "ids are numbers" or "ids are strings" from the
   **first** event, converts the edited event's id to that kind, and looks it up with `===`.
   Every event of the other kind failed the lookup: `can't access property "RecurrenceRule",
   o is undefined`, the editor stayed open, nothing saved. `/nonetoile-son` had 273 of 290
   events in this state.
2. **The color menu stopped working after the first use per visit on phones.** A hint we
   inject into Syncfusion's dropdown became the popup's first child once Syncfusion removed
   its list on close; on the next open Syncfusion rendered the colors *into our hidden hint*.
   A 0 x 0 menu.

Both are fixed (Calendar.sfId/restoreIds; the hint is removed on close), each with a journey
that fails without the fix.

## 100 whys

### A. Why did Save fail?
1. Why did the editor stay open after Save? Syncfusion threw inside `processCrudActions`.
2. Why did it throw? It could not find the event being saved (`o` was undefined).
3. Why not? It looked it up with `===` after converting the id to the kind of the first event.
4. Why was the kind wrong? The calendar's first event had a number id; the edited one a uuid.
5. Why do calendars hold two id kinds? Grid events got Syncfusion's numbers; +Event, paste
   and NativeCal create uuids.
6. Why did new grid events start getting uuids? `withStableId` (Sep 17) replaced Syncfusion's
   numbers with uuids to fix the same crash in a different shape.
7. Why did that fix create this crash? It changed new events only; every existing calendar
   kept its old number ids, so "mixed" became the normal state of any calendar older than a week.
8. Why wasn't the mixed state considered? The fix was reasoned about for new calendars.
9. Why only new ones? Every test calendar is created fresh, so its first event is always new.
10. Why do we never test old data? There is no corpus of real calendar shapes to test against.
11. Why did the user say "select a slot"? To them, a *créneau* is one of their booked slots —
    they were editing existing events, not creating new ones.
12. Why did we read it as "create"? We read the words, not what the user was doing.
13. Why couldn't we see what they were doing? We didn't look at their calendar's events in
    analytics until the second report.
14. Why did the first report get a +Event fix? The first report said "création" and +Event
    was where a French-date bug was easy to find and fix.
15. Why did we reply "fixed" to a user whose path we hadn't reproduced? Our test passed, and
    we treated a green test as the user's problem solved.
16. Why did the color complaint get the same wrong fix? We assumed "change colors" meant +Event
    lacked a color picker (it did), not that the grid's color menu broke.
17. Why did the color menu break? Our hint was appended as a sibling of Syncfusion's list.
18. Why does that matter? Syncfusion assumes the popup's first child is its own list.
19. Why only on phones? On desktop the hint is visible, so the colors rendered inside it still
    showed up; on phones it is `hidden`.
20. Why only from the second use? Syncfusion drops its list on close; the first open is fine.

### B. Why didn't the tests catch it?
21. Why didn't the journeys catch the crash? They never edit an event whose id kind differs from the first.
22. Why not? Seed data is always created through the UI of the day, so every id is the same kind.
23. Why didn't they catch the phone color bug? No journey changes the color of two events in one visit.
24. Why not? Each journey does one thing once, then checks the server.
25. Why do real users hit "second time" bugs? Real sessions edit many events; tests edit one.
26. Why wasn't Firefox tested? The gate ran Chromium and WebKit only; Firefox wasn't installed.
27. Why does that matter here? The reporter and several of our heaviest French calendars use
    Firefox on Windows — and it made the investigation start in the wrong place.
28. Why wasn't display scaling tested? Viewports were CSS pixels at 100%; users run 125–150%.
29. Why did the lab tests keep passing? They reproduced the user's *environment* (language,
    browser, size) but not the user's *data*.
30. Why is data the missing axis? Most of our bugs this month were data-shaped (#41 ids,
    #44 settings, sync_refused on series, mixed ids).
31. Why did one of my reproduction scripts "pass" wrongly? A title with `->` was stored as
    `-&gt;` and my exact-match check missed it — escaping in titles is its own bug.
32. Why did several reproduction attempts fail for test reasons? Wrong selectors (uppercase
    labels), cells out of range, cells covered by earlier test events. Tests that can be wrong
    silently slow every investigation down.
33. Why is there no "edit every event" check? Nobody wrote one; it would have found this in a day.
34. Why do we only find these through users? Because users are the only ones running real data.
35. Why do users report in French? Our French users are among the most engaged; they carry
    the largest, oldest calendars.
36. Why weren't French users' calendars sampled for tests? We had no process for it.
37. Why do journeys run only on new calendars? It is simpler and they are "clean" — which is
    exactly why they miss what real calendars do.
38. Why did the gate still pass after the Sep 17 fix? It had no journey editing pre-existing events.
39. Why did `withStableId`'s own comment name this crash? It was written for this crash in one
    shape and never re-checked for the shape it produced.
40. Why is "fixed in one shape, broken in another" common here? Fixes are verified by the
    test that reproduces the report, not by the population of calendars they touch.

### C. Why did observability miss it for 10 days?
41. Why didn't analytics flag it? `js_error` fired daily on this calendar since Sep 15, but
    only as a count.
42. Why only a count? The error *message* was sent but never registered as a GA dimension.
43. Why wasn't it registered? `stats.sh setup` had a hand-written list, and `message` wasn't on it.
44. Why did nobody notice? The weekly report shows totals (150 js_errors), not what they say.
45. Why not per calendar? The report ranks growth, not failures per calendar.
46. Why didn't `sync_refused` help? The crash happens before any write, so no sync signal fires.
47. Why didn't "save failed" show at all? There is no event for "Save pressed, nothing saved".
48. Why is that the key signal? It is the user-visible failure; every other signal is a proxy.
49. Why was the pattern visible in hindsight? Color changes without saves (Sep 22: 10 color
    changes, 0 saves) — but nobody looks at per-calendar ratios.
50. Why did Clarity not help? Its project mixes in instacalc traffic, and its session list
    filters return nothing for France.

### D. Why do we answer users before we're sure?
51. Why did we tell the user "fixed"? A plausible fix passed its test.
52. Why not ask the user to confirm first? No step in the process says to.
53. Why no step? Fixes are closed by us, not by the reporter.
54. Why does that cost so much? A wrong "fixed" spends the user's patience twice.
55. Why is patience scarce? This user wrote "every week there is a problem".
56. Why every week? Each week shipped real fixes *and* new regressions.
57. Why do regressions ship with fixes? Changes land in areas with thin coverage of real data.
58. Why thin? The gate is new (Sep 24) and was built from the bugs we already knew.
59. Why only known bugs? Journeys are written after incidents, not from how the app is used.
60. Why not from usage? We never listed the top 10 things real users do and checked each.

### E. Why does Syncfusion keep biting?
61. Why is Syncfusion involved in most of these? It owns the grid, the editor and their data.
62. Why is that a problem? It has assumptions we can't see (id kinds, popup children, a
    quick popup that lingers behind the editor, a hidden all-day field that reports the opposite).
63. Why can't we see them? It's minified; we find its rules only when they break.
64. Why do we keep poking inside it? Features we add (colors, hints, categories) are bolted
    into its DOM rather than built next to it.
65. Why bolted in? It was the fastest way to add them.
66. Why is that fragile? Every Syncfusion re-render can undo or collide with our additions.
67. Why did the smaller bundle (Sep 24) raise the risk? It changed exactly what we load, and
    nothing checked that every editor feature still worked with real calendars.
68. Why do we keep it? Replacing a calendar is big; NativeCal is the replacement in progress.
69. Why does NativeCal help? It is our code, with data rules we choose and can test directly.
70. Why not faster? It must write data identical to Syncfusion's while both exist — which is
    how NativeCal found the UNTIL bug in Syncfusion's reading of rules.

### F. Why do data-shape bugs keep appearing?
71. Why do we have many data shapes? Four writers over the years: Syncfusion grid, +Event,
    paste/import, NativeCal.
72. Why weren't they unified? Each was added for a feature; the stored format was never
    specified as one contract.
73. Why is that dangerous? Every reader must handle every shape ever written.
74. Why don't readers do that? There is no list of shapes to handle.
75. Why no list? The format is defined by examples in code comments, not a schema.
76. Why no schema? It felt heavy for a no-login app.
77. Why does it matter now? Calendars live for months (415 with 4+ active weeks), so old
    shapes never age out.
78. Why can't we migrate old data? Rewrites of shared calendars are risky, and the write gate
    exists because a bad rewrite already lost data once.
79. So what's the safe pattern? Normalize at the boundary (like `Calendar.sfId`), never in storage.
80. Why wasn't that the pattern before? It wasn't written down; this doc now does.

### G. Why does this keep happening, at the root?
81. Why are users the test suite? Because our tests model an idealized user on an empty calendar.
82. Why idealized? Tests are written by the person who wrote the code, from the code's view.
83. Why is that a blind spot? The code's view has no history; users' calendars are all history.
84. Why does speed make it worse? Many changes a day, each verified narrowly.
85. Why narrowly? Verification is "the reported thing works", not "nothing people do broke".
86. Why no broad check? Broad checks need real data and real usage patterns — the missing piece.
87. Why is the missing piece missing? We never treated user data as the primary test input.
88. Why not? It is private and messy; clones felt heavy.
89. Why is cloning cheap now? Calendars are public by URL; a copy into a test slug took one
    script and seconds (this investigation).
90. Why wasn't the per-calendar analytics timeline used first? It didn't exist as a habit; it
    solved this in minutes once used.
91. Why do investigations start in the lab? Reproducing in a clean environment feels rigorous.
92. Why is it slow? The lab lacks the user's data, so it tries every environment first.
93. Why does evidence-first help? The user's own event timeline pointed straight at "color
    changed, not saved" and at the file and line of the crash.
94. Why didn't the first report get this treatment? We moved to fixing before observing.
95. Why do we move to fixing? Fixing feels like progress; observing feels like delay.
96. Why is that wrong here? The fastest path to the right fix was observation.
97. Why does the product feel fragile to users? Because the bugs they hit are in the most
    basic acts — save, change color — on their real, old calendars.
98. Why the most basic acts? Those are what every user does on every visit.
99. Why aren't the basic acts on real data guarded? That's the gap this doc closes (below).
100. So the root cause: **we verify changes against empty calendars and our own reading of a
    report, while users live in months-old calendars and do the basic things many times.**

## What changed today
- `Calendar.sfId` / `restoreIds`: Syncfusion sees string ids only; stored ids never change shape.
- The color hint is removed on close, so Syncfusion's list always renders into its own popup.
- Journey: a calendar with number ids first and uuids after, editing both kinds, changing
  color twice in one visit, in 4 browsers — verified failing before the fix.
- Firefox (French, desktop) added to the release gate for the core create/edit journeys.
- The `js_error` message is now a GA dimension, so the next crash arrives with its text.

## What we do from now on
1. **Real-data canary.** A script that copies the 50 most active calendars into test slugs
   and, in the gate, opens and saves one event of every id kind and type in each. (Next.)
2. **Evidence first.** For any user report: read that calendar's analytics timeline and copy
   its data before touching code. The runbook is in this doc's incident section.
3. **Reporter confirms.** Don't tell a user "fixed" until the path *they* use is reproduced
   and passes; ask them to confirm, and only then close.
4. **"Second time" journeys.** Every journey that changes something does it twice in one visit.
5. **Boundary normalization.** Any data rule a library imposes (id kinds, date forms) is
   enforced where data enters and leaves the library, not by rewriting stored data.
6. **A save-failed signal.** Count "Save pressed, editor still open" as its own event; it is
   the user-visible failure every other metric only approximates.
7. **Finish NativeCal.** Most of this class of bug lives in Syncfusion's hidden rules.

## Open items found along the way
- Titles containing `>` or `&` are stored HTML-escaped (`-&gt;`) by the grid editor.
- Drag-selecting several slots highlights them but offers no way to create from the selection.
- View-only calendars still receive the edit slug in their data (server fix pending).


---

# Sep 26: a series edit saved as a delete (20 whys)

**What happened.** The EventStore shipped (deploy #1, 08:41 UTC). Editing a whole repeating series
from one of its occurrences saved the series as an "edited occurrence" of itself; every other
occurrence vanished (27 -> 1) and history logged a delete. The owner restored it from Recent
changes. Deleting a whole series from an occurrence silently did nothing. Live for about
90 minutes; rolled back to the previous release.

1. Why did the series vanish? Its row was saved with `recurrenceID` = its own id.
2. Why? The store's update copied `recurrenceID` from Syncfusion's record onto the series.
3. Why did the record carry it? At `actionBegin`, an "Entire series" edit started from an
   occurrence still holds the occurrence's link to the series.
4. Why did the store allow an edit to change identity? Nothing said it couldn't. **Fixed:** an
   update can never change `id` or `recurrenceID`.
5. Why did a structurally broken calendar save at all? No check that every edited occurrence
   points at a series that exists. **Fixed:** checked on every change; a violation is refused,
   shown, and logged as `command_failed`.
6. Why did delete-series do nothing? At `actionBegin` Syncfusion lists the series as CHANGED,
   not deleted; only `currentAction` says "DeleteSeries".
7. Why did the adapter read records literally? I assumed `actionBegin` records state intent.
   They don't: Syncfusion computes the real changes AFTER `actionBegin`, in the step we cancel.
8. Why wasn't that known? I captured Syncfusion's data for occurrence edits and deletes, but not
   for series edits or deletes. **Fixed:** every action is mapped explicitly
   (Add, Save, Delete, EditOccurrence, DeleteOccurrence, EditSeries, DeleteSeries), following
   Syncfusion's own source for series rules, and an unmapped action on a repeating event is
   refused and logged, never guessed.
9. Why didn't the old-vs-new comparison catch it? It covered 6 actions, none on a whole series.
   **Fixed:** 16 actions, including every series action; kept in `test/differential/`.
10. Why didn't the journeys catch it? The series journey checked that the new title appeared
    somewhere. It did -- on the broken row. **Fixed:** `expectSeriesIntact` checks what the
    calendar means (still a series, occurrences drawn, nothing orphaned).
11. Why do tests keep checking text instead of meaning? Checking a saved title is the easiest
    assertion to write; checking structure takes knowing the data model.
12. Why was a refactor of every save path shipped on 6 compared actions? The evidence looked
    strong (identical data, all journeys passing) and I did not ask which actions were missing.
13. Why wasn't that question asked? There was no list of the actions the app supports. The
    matrix is now that list.
14. Why did it reach every user at once? The deploy is all-or-nothing; there is no staged rollout.
15. Why did the rollback take minutes? The command's syntax was worked out by trial and error
    during the incident. **Fixed:** `deploy.sh` prints the exact rollback command for the
    release it replaced.
16. Why did the owner find it and not monitoring? The bad save succeeded, so nothing errored.
    **Fixed** for this class: a structure violation is now a refused save plus a logged
    `command_failed` with its reason.
17. Why could history restore it? `/history` snapshots every write that removes or changes
    events -- the safety net worked exactly as designed.
18. Why is Syncfusion so hard to wrap? Its public events expose half-built data, and its rules
    live in minified code we only read when something breaks.
19. Why wrap it at all? To stop its quirks leaking into our data -- the goal was right; the
    adapter needed to follow Syncfusion's rules, not its surface.
20. Root cause: **I replaced Syncfusion's save logic without first listing every action it
    handles and proving each one equal, and the tests checked that text was saved rather
    than that the calendar still meant the same thing.**

**Rules from this.**
- Before replacing behavior, list every case it handles and diff old vs new on each (the matrix).
- Assert meaning, not text: structure, counts drawn, links resolved.
- A data layer refuses and logs what it cannot handle; it never guesses.
- Every deploy prints its rollback.
