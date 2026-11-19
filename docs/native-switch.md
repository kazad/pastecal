# From Syncfusion to the native calendar

Decision (Oct 25, 2026): switch. The native calendar (public/nativecal/, /beta) replaces Syncfusion's Schedule
for every calendar, behind a flag, then Syncfusion is deleted.

**Update (Nov 18, 2026): native is the default for everyone, without the slow rollout below.** Reason: Classic's
editing bugs in the field (GitHub #53, #54) and Syncfusion errors in production. Classic stays one click away: the
footer pill ("New calendar · Feedback · Classic editor"), Settings > You > Calendar (the only way on the home page and
Pro calendars), `?cal=classic`, and the Worker's `CALENDAR_DEFAULT=classic` kill switch for browsers that have not
chosen. The browser test pool runs Classic-pinned (`CALENDAR_DEFAULT:classic`) plus one production-default server
(`NATIVE_DEFAULT_URL`) for the native default, the switch and the kill switch (`try-new-calendar.spec.js`).

## Why

| | Syncfusion 23.2.6 | Native |
|---|---|---|
| Download (gzip) | 644 KB JS + 260 KB CSS = ~900 KB | ~48 KB |
| Share of a first visit | most of it (app.js is 87 KB) | small |
| Our UX on top of it | 54 workarounds in app.js: the double quick popup (#32), the hidden delete confirm, the draft "New event" block on its cells, print redrawn from scratch | ours to design |
| Version | 2023, pinned; upgrades change markup our CSS targets | ours |
| License | Community license key in index.html: free only while the company stays small (revenue, staff limits) | none needed |

It is extensible enough for a generic calendar, but every pastecal-specific idea is a fight with it (quick add,
live preview while typing, "who's coming" in the popup, print, phone layout). 79% of new people arrive on a
calendar someone sent them; ~900 KB is most of what stands between them and the schedule.

The risk is the opposite of the reward: the calendar is where people's data is edited. So the plan is mostly tests
and a slow rollout, with the data format unchanged (both renderers read and write the same events).

## Where native is today

- Renderer parity G1-G16 merged (all-day row, multi-day spans, +N more, recurrence exceptions, multi-select,
  resize, color filter in every view, keyboard focus, view-only links).
- Audit suite (branch `native-audit`, 2 commits not merged): 137 passed, 22 failed, 54 skipped. About half the
  failures are tests that drifted from the current Syncfusion UI.
- Known gaps: drag-to-create (click and drag a duration), dragging one occurrence of a repeating event, embeds,
  offline edits on phones, analytics events the classic app sends.
- `worktree-nativecal-parity` (July, 298 unmerged commits) is superseded by native-fixes; archive it, don't merge.

## The shape of the work (corrected Oct 25)

`/beta` is a separate copy of the app (its own index.html, app.js, settings), forked months ago. It lacks everything
built since: Share, Plus, print, the add page, templates, the draft block. So the switch is NOT "turn /beta on".
It is: mount `NativeCalendar` (props/emits, self-contained; needs window.rrule) and its editor/popover/quick-create
inside the MAIN app in place of `#Schedule`, behind a flag, through a small calendar interface with two
implementations (Syncfusion, native). Not a fake `scheduleObj` that imitates Syncfusion's shapes.

- First inventory the main app's 119 `scheduleObj` uses and ScheduleAdapter into: data path (saves, deletes,
  recurrence exceptions and their stamp format, the noteStart merge, all-day local midnight), view state
  (currentView, selectedDate, range, readonly), Syncfusion workarounds (deleted, not ported), and features built
  on its internals (draft block on `.e-selected-cell`, print's `getEvents` repeat expansion). That table defines
  the interface.
- Data safety during rollout: one calendar edited by classic and native browsers at once. Journeys edit in one
  renderer, reload in the other, and assert on `GET /cal/<id>`: repeat exceptions (exact stamp format), all-day
  events across time zones and a DST week, two browsers editing different fields of one event.
- Speed only counts if Syncfusion's JS and CSS are not downloaded in native mode (a test asserts zero requests).

## Decisions

- Oct 25, 2026: dragging one occurrence of a repeating event asks "this event / all events" (the owner's call). Classic Syncfusion moved only the occurrence without asking; "this event" stores exactly what classic stored.
- Oct 25, 2026: the native editor follows the editing prototype (artifact Pme2wmbmcdS8vjPQ9xQ4ba): a quick card that grows into full details, Starts/Ends with "Same day", a length menu, the time zone as a line under the times, a category menu with Edit labels, changes saved as you go with Undo.

## Plan

1. **No new features on Syncfusion.** Bug fixes only. New calendar UX ("who's coming") is built on native.
2. **One parity suite, run against both** (merge `native-audit`). Sort the 22 failures into test drift (fix the
   test) and native bugs (fix native). Every journey asserts on what the server saved, not on the screen alone.
3. **Close the gaps, Google/Apple behavior as the reference:**
   - click-drag to create a duration; drag to move; drag edges to resize; Esc cancels
   - a repeating event: move or edit "this event / all events" (same choice as today)
   - every editor field: title, time, all-day, repeat rules and end dates, type, location, details
   - phones: tap to add, long-press to drag, the editor as a sheet, offline edit then sync
   - embeds, view-only links, the live "New event" block, Undo, Recent changes, search and filters
   - the analytics events the classic app sends, so dashboards don't break at the switch
4. **Dogfood:** native is the default on preview.pastecal.com; errors split by ui (the collector already tags
   classic vs native).
5. **Roll out on pastecal.com,** each step held until errors, events added per visit, editor-abandoned and saves
   look the same or better than classic:
   view links first (they never write, and they are where 79% of new people land), then new calendars, then 10%,
   50%, 100% of existing ones by browser; a "Use the classic calendar" link for two weeks; the flag can send
   everyone back in one deploy.
6. **Delete Syncfusion:** vendor files, ScheduleAdapter, the workarounds, the license key. Measure the first
   load before and after.

First milestone: view links render natively in the main app on preview, with no Syncfusion download, bytes measured
before and after, and the cross-renderer data journeys in place.

Rough size: steps 2-3 about three weeks of agent time (the main-app integration is the larger part); 4 a few days;
5 two to three weeks of watching; 6 a day.
