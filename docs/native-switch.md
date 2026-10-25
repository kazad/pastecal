# From Syncfusion to the native calendar

Decision (Oct 25, 2026): switch. The native calendar (public/nativecal/, /beta) replaces Syncfusion's Schedule
for every calendar, behind a flag, then Syncfusion is deleted.

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
   new calendars first, then 10%, 50%, 100% of existing ones by browser; a "Use the classic calendar" link for
   two weeks; the flag can send everyone back in one deploy.
6. **Delete Syncfusion:** vendor files, ScheduleAdapter, the workarounds, the license key. Measure the first
   load before and after.

Rough size: steps 2-3 about two weeks of agent time; 4 a few days; 5 two weeks of watching; 6 a day.
