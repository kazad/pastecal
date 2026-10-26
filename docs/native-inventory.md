# Syncfusion inventory: what the main app asks of its calendar

Step 1 of the native switch (docs/native-switch.md). Every place `public/app.js` touches `scheduleObj`
(127 lines matching `scheduleObj|ScheduleAdapter`, Oct 25 2026, branch `pro`) plus the other `ej.*` calls,
sorted into what each is FOR. The table decides the calendar interface (`public/services/CalendarView.js`):
only what more than one renderer needs goes in it; workarounds are deleted with Syncfusion, not ported.

Categories:

- **Data** -- the data path: saves, deletes, recurrence exceptions (stamp format `YYYYMMDDTHHMMSSZ`, UTC, of the
  occurrence's original start), the noteStart merge (a change is measured from the event as it was when the
  person started), all-day dates (stored as the writer's local midnight, read at the viewer's local midnight).
- **View** -- view state: current view, selected date, visible range, read-only, the settings that shape the grid.
- **Workaround** -- exists only because of how Syncfusion behaves. Deleted with it.
- **Internals** -- a pastecal feature built on Syncfusion's internals. Needs a renderer-neutral home.
- **Note** -- comments, or a renderer-neutral helper that only lives in ScheduleAdapter.

## Counts (the 127 grep lines)

| Category | Lines | What happens to them |
|---|---|---|
| View | 78 | 9 interface calls (below); the rest is Syncfusion's own setup (its `views` array, `startHour`, `firstDayOfWeek`, the toolbar-click default view), which the native calendar takes as reactive props |
| Data | 14 | unchanged in milestone 1 (view links never write); the native editor will produce the same commands (`EventStore`) |
| Workaround | 23 | deleted with Syncfusion |
| Internals | 3 | print's repeat expansion, the draft "New event" block, editor-abandoned analytics |
| Note | 9 | comments; `ScheduleAdapter.onColor` (text color on an event color) is renderer-neutral and stays |

Plus, outside the grep: `ej.data.Query` (Data), `ej.schedule.generate` and `getDateFromRecurrenceDateString`
(Internals: the hidden-events count expands repeats with them), `ej.splitbuttons.DropDownButton` (the editor's type
picker: Workaround), `ej.base.L10n.load` (sentence-case Syncfusion's words: Workaround), `.e-popup-open` in the
Cmd+Z guard (Workaround), the `.e-color-N` CSS (Workaround), `swapSyncfusionTheme` (Workaround), `selftest.js`.

## Every use

| Lines (app.js) | What | Category | Native |
|---|---|---|---|
| 345, 772, 810, 1186, 1779-1784 | comments | Note | |
| 1001 | `ej.base.L10n.load`: "New event", "More details"... | Workaround | own strings |
| 1020 | `new ej.schedule.Schedule()` | View | `<native-calendar>` in the template |
| 1023, 1028, 1031 | init timing logs (actionComplete / dataBound / eventsLoaded) | Workaround | |
| 1038-1040 | startHour, timeFormat, firstDayOfWeek before first render | View | props `start-hour`, `time-format`, `first-day-of-week` |
| 1051 | phone hour labels ("5a"): Syncfusion clips "5:00 AM" | Workaround | own hour labels |
| 1059 | views array with the custom "N Months / N Weeks" view | View | props `custom-duration`, `custom-unit` |
| 1067 | enableAdaptiveUI = false | Workaround | |
| 1069 | readonly | View | prop `read-only` |
| 1081-1153 (15) | `?date=` / `?view=` (d, w, 12w, m, c + dur/unit, q, y, a) | View | props `initial-date`, `initial-view` (+ custom from the link) |
| 1161-1162 | no drag/resize on touch | View | the component's own `isPhone` |
| 1165 | dataSource = syncFusionEvents | Data | prop `events` (stored events, read directly) |
| 1172 | actionBegin: cancel Syncfusion's change, `ScheduleAdapter.toCommand` -> EventStore | Data | editor emits commands (milestone 2) |
| 1179 | popupClose: editor_abandoned analytics, hide the draft block | Internals | editor's own close |
| 1187-1188 | dragStart / resizeStart -> `noteStart` (the merge snapshot) | Data | `update:events` carries only the moved row |
| 1193 | renderCell: the "Earlier" corner label, short weekday names | Workaround | built in |
| 1210-1220 (4) | eventRendered: paint chips, `onColor`, `showTitle` (Syncfusion escapes titles) | Workaround | built in; `onColor` stays as a helper |
| 1224, 1237, 1243, 1246 | popupOpen: auto-confirm delete, title unescape, header color, "change date" hover | Workaround | `<event-popover>` |
| 1240 | `showDraftBlock` on `.e-selected-cell` | Internals | native create preview |
| 1266-1267 | one popup at a time (#32) | Workaround | |
| 1277 | editor open -> `noteStart` | Data | editor (milestone 2) |
| 1290-1515 (no grep hits) | date-picker formats, type dropdown (`ej.splitbuttons`), popup clamp | Workaround | |
| 1534 | focusin guard against the stray quick popup (#32) | Workaround | |
| 1548 | appendTo('#Schedule') | View | template |
| 1568-1584 (6) | view links: a click on a month day opens that day (`getCellDetails`) | View | prop `open-day-on-click` |
| 1595, 1601, 1634 | chip relayout and fitMonthRows (Syncfusion sizes chips in px at render) | Workaround | CSS |
| 1653 | dataBound -> `viewTick++` (hidden-events count follows the range) | View | `range-change` emit |
| 1672-1674 | Year view dots colored by a home-made rule parser | Workaround | year dots built in, real expansion |
| 2078 | sideDocked -> refreshLayout | View | `refreshLayout()` |
| 2149-2150 | `options.extended` -> startHour | View | prop |
| 2265-2321 (5) | applyDefaultView, done by clicking Syncfusion's toolbar button | View | prop `initial-view` |
| 2373 | theme swap -> refreshLayout (and `swapSyncfusionTheme`) | Workaround | tokens follow `data-theme` |
| 2415-2443 (7) | updateCustomViewInSchedule | View | props |
| 2461-2464 | getActualViewName ("Custom" -> "3 Months") | View | |
| 2611, 2621 | updateCalendarView: setProperties(dataSource filtered by the color filter) + dataBind | Data | `render()`; native filters with prop `hidden-slots` |
| 2658-2673 (5) | applyScheduleAction (activeEventData, currentAction, uiStateValues) | Data | |
| 2704 | home aside toggled -> refreshLayout | View | `refreshLayout()` |
| 2791 | applyTemplate anchors on selectedDate | View | `selectedDate()` |
| 3021 | buildPrintMonth: `getEvents(start, end, true)` to expand repeats | Internals | `occurrences(start, end)` |
| 3051 | `ScheduleAdapter.onColor` in print | Note | |
| 3063 (no grep hit) | showDraftBlock reads `.e-selected-cell` | Internals | |
| 3277-3278 | updateCurrentViewURL (Share's "This view") | View | `currentView()`, `selectedDate()` |
| 3551-3553 | visibleDateRange (`getCurrentViewDates`) | View | `visibleRange()` |
| 3589-3607 (no grep hits) | recurrenceOccursInRange: `ej.schedule.generate` | Internals | `occursInRange(event, range)` |
| 3666-3667 | editSearchResult -> `openEditor` | Data | `openEditor(event)` (milestone 2) |
| 3672-3673 | jumpToEvent (search result) | View | `goTo({ date, view })` |
| 5031-5089 (12) | applyGlobalSettings(AfterRemote) | View | props (reactive) |
| 5255-5256, 5325-5326 | refresh after colors / type names change | View | `render()` (props are reactive) |
| 5489-5492 | lock state: close the editor, readonly | View | `setReadOnly()`, `closePopups()` |

## ScheduleAdapter (public/services/ScheduleAdapter.js)

| Function | Category | Note |
|---|---|---|
| `noteStart`, `changesFrom` | Data | the merge: a change is the difference from the event as it was when editing began |
| `toView`, `fromRecord` | Data | Syncfusion record shape (Subject/StartTime/...); all-day dates mapped to the viewer's local midnight and back (Event.allDay*) |
| `stamp` | Data | the exception stamp, `YYYYMMDDTHHMMSSZ` UTC |
| `toCommand` | Data | EditOccurrence / DeleteOccurrence (exception stamp + new row with recurrenceID), EditSeries / DeleteSeries, plain add/change/remove |
| `showTitle` | Workaround | Syncfusion's display sanitizer escapes "A > B" |
| `contrastRatio`, `onColor` | Note | renderer-neutral; both renderers use it |

## The interface

`public/services/CalendarView.js`, two implementations: `CalendarView.syncfusion(scheduleObj, vm)` wraps
today's code; `CalendarView.native(vm, getComponent)` wraps `<native-calendar>`. Neutral shapes only (stored
events in, `{ event, start, end, allDay, title, type }` out), never Syncfusion's records.

| Method | Used by |
|---|---|
| `currentView()`, `selectedDate()` | Share's "This view" link, templates, print |
| `visibleRange()` | hidden-events count |
| `goTo({ date, view })` | search results |
| `occurrences(start, end)` | print (the paper month), shown events only, repeats expanded |
| `occursInRange(event, range)` | hidden-events count (a repeat with nothing on screen is not counted) |
| `render()` | the events or the color filter changed |
| `refreshLayout()` | side panel docked, homepage aside |
| `setReadOnly(on)`, `closePopups()` | lock state |
| `openEditor(event)` | search result's Edit |

## Milestone 1: view links on the native calendar

The flag: `?cal=native|classic`, else `localStorage pc_cal`, else the server's `<meta name="pc-cal">`
(Worker var `NATIVE_VIEW_LINKS="1"`, unset = classic). Decided in index.html's head, by path (`/view/<id>`,
`/@handle/<name>`): edit links, and locked calendars opened from one, stay classic. In native mode
index.html writes in rrule (jsDelivr, SRI), `nativecal/components/{ncUx,NcIcon,NativeCalendar,EventPopover}.js`
and `native-calendar.css` instead of `ej2-calendar.min.js` and `material(.dark).css`.

Changes to the shared components are additive (defaults leave /beta as it was): NativeCalendar gained
`openDayOnClick`, `appLook`, `textOn`, `monthRowHeight`, a `range-change` emit, `visibleRange()` and the static
`NativeCalendar.occurrencesBetween`; its all-day reader takes the display shape as local dates (fixes UTC+13).
EventPopover gained `textOn`.

### Bytes: one first visit to a view link (cold cache, wrangler dev, which gzips as production does)

From `cloudflare/test/native-view-links.spec.js` (CDP `encodedDataLength`, Oct 25 2026):

| | Transferred | Files | Syncfusion | Calendar code |
|---|---|---|---|---|
| Classic | 1537 KB | 45 | 906 KB | (in Syncfusion) |
| Native | 496 KB | 47 | 0 | 42 KB (NativeCalendar, popover, icons, CSS, rrule) |

About 1 MB less, two thirds of the page. The rest of the native page is fonts, Vue, app.js and the other services.

### Not yet the same as classic

- Week / Day: classic tints the hours outside 9-5; native tints only weekends.
- A multi-day bar cut by the week edge: classic draws « and »; native squares the corner.
- Links with `?view=q`, `12w` or `custom&dur=&unit=`: classic opens them as Day (on branch `pro` too: the custom
  view is replaced when the calendar loads); native opens the view the link names. Day/Week/Month/Year/Agenda
  links open the same view and dates in both (tested).
- No `location` field exists in the event model, so neither popup shows one.
- The native editor, drag-to-create, Undo and Recent changes are milestone 2 (edit links), below.

## Milestone 2: edit links on the native calendar

The same flag, extended to edit links (`/<id>`): `?cal=native`, else `localStorage pc_cal`. The server's
`pc-cal` meta stays view-links-only, the homepage stays classic, and classic is the default everywhere
(index.html `window.pcNativeEdit`). An edit link in native mode also loads `EventEditor.js` and
`QuickCreatePopover.js`; a view link does not.

**One write path.** Classic's actionBegin now hands its args to `commitScheduleAction(args, context)`; the native
calendar builds the same args (app.js `nativeAction`): records from `ScheduleAdapter.toView` (an edited
occurrence beside its series), `noteStart` when the editor opens or a drag starts, then `toCommand` with
`Add`, `Save`, `Delete`, `EditOccurrence` (a temporary id + `RecurrenceID`, `occurrenceStart` = the occurrence's
original start), `DeleteOccurrence`, `EditSeries` (with classic's "match the series again?" question, Yes / No,
whenever the series has skipped or edited dates) or `DeleteSeries`. So stamps, all-day dates, the merge (D1),
undo, the Undo toast, Recent changes and analytics (`event_added` add_via grid, `editor_abandoned`,
`feature_used` event_type) are classic's. Nothing on the native path writes the event list itself.

| Classic (Syncfusion) | Native |
|---|---|
| quick popup + "New event" draft on `.e-selected-cell` (`showDraftBlock`) | `QuickCreatePopover` + NativeCalendar `draft` prop: a real block on the grid, labelled as you type |
| editor (`ej.splitbuttons` type picker, recurrence editor) | `EventEditor` `app-look`: title, color by name, start/end, all day, repeat (daily, weekly days, monthly by day or Nth weekday, yearly by month, until / count), description |
| drag / resize (desktop only) | drag, resize from either edge, Esc cancels; drag to create a duration (week) or a run of days (month, all-day row); long-press on touch |
| dragging an occurrence: moves only it, no question | asks "This event / All events"; this event = classic's stored shape; all events moves the series and its repeat days (`CalendarView.edits.shiftRule`) |
| delete: Syncfusion's confirm pressed unseen, then the Undo toast | no confirm, the Undo toast |
| `openEditor` | `nativeEditEvent` (a search result's Edit opens the series) |
| locked: `readonly`, double-click toast | `read-only` prop, no affordances, the same toast |
