# NativeCal: feature parity audit and rollout plan

> **Status, 2026-08-29 — parity reached; phases 0-4 shipped.**
>
> Sections 2 and 3 are the audit *as found*, kept as the record of what was
> wrong. Everything they list is now closed except the two items called out
> under "Still open" below. Section 5 marks which phases are done.
>
> Both engines run from one shell. `?cal=native` selects the native engine,
> `?cal=syncfusion` selects Syncfusion, which is still the default. The parity
> suite (`test/e2e/engine-parity.spec.js`) runs 21 cases against both and is
> green on both.
>
> **Closed by the de-fork** (they were staleness, not design): welcome dock,
> the four subscribe buttons and their analytics, share-pill copy, date-format
> setting, Tailwind dark-mode selector, anonymous auth, AuthorSignal.
>
> **Closed by the component work**: multi-day spanning, the all-day lane,
> read-only enforcement, the touch guard, first-day-of-week, start hour,
> extended hours, default view, custom colours, type labels, the custom view,
> `?d=`/`?v=` deep links, search jump-to-event, the title date picker,
> month-start labels, year-view type colouring, chronological agenda, and the
> recurrence editor's weekday picker, monthly-by-position and "ends after N".
>
> **Bugs found and fixed on the way**, none of which were on the audit list:
> recurring events rendered at page-load time rather than their own time;
> recurring instances had `end: NaN`; the agenda sorted ISO strings with minus;
> hour labels drifted an hour out of step by mid-afternoon; the year view showed
> a 14-day strip instead of a month; `?v=12w` and `?v=q` had never worked in
> production at all.
>
> **Still open, deliberately:**
> - **Timezone fields.** Syncfusion's editor shows Start/End Timezone. The Event
>   model has no timezone field, so those values are dropped on save today --
>   the controls are already inert. Not rebuilt; worth confirming nobody wants
>   them before Syncfusion goes.
> - **The Today button.** Production hides Syncfusion's with CSS; the native
>   toolbar has one. Left in place as an improvement, so the native toolbar is a
>   superset rather than a divergence.

Status as of 2026-08-29. Audited against `public/app.js` + `public/index.html`
(Syncfusion, in production) and `public/nativecal/*` (NativeCal, behind
`/nativecal/<slug>`).

Everything below was verified by reading the code and by loading both UIs
headlessly against the same injected event data — not inferred from the spec.

---

## 1. Why this is worth finishing

The calendar engine is the single largest thing we ship. Measured over the
wire, gzipped, as the CDN actually serves it:

| | raw | gzipped |
| --- | ---: | ---: |
| `ej2.min.js` | 20.7 MB | 4.48 MB |
| `material.css` (3 files) | 4.0 MB | 0.57 MB |
| **Syncfusion total** | **24.7 MB** | **5.05 MB** |
| date-fns + rrule | 145 KB | 36 KB |
| our own component code | 70 KB | ~15 KB |
| **NativeCal total** | **215 KB** | **~51 KB** |

That is a ~100x reduction in bytes for the calendar layer, plus the removal of
a commercial licence key (`registerLicense(...)` in `index.html`) and of a
third-party CDN from the critical path.

There is also a maintenance dividend. `app.js` currently carries roughly 250
lines that exist only to fight Syncfusion: the popup re-positioning block
(`popupOpen`, with its `MutationObserver`, `pc-clamp-top`, and the comment
recording a reverted fix that broke icon-font painting), `applyDefaultView`'s
poll-the-toolbar-button-until-it-exists dance, the `swapSyncfusionTheme` CSS
link swap, and the `strictMode`/`resolveDateFormat` workaround for ambiguous
date pickers. Owning the component deletes all of it.

---

## 2. Feature inventory and parity

Legend: **OK** at parity · **PARTIAL** present but degraded · **GAP** absent.

### 2.1 Views

| Feature | Syncfusion | NativeCal | |
| --- | --- | --- | --- |
| Day | vertical time grid | yes | OK |
| Week | 7-day time grid | yes | OK |
| Month | 6x7 grid | yes | OK |
| **Custom (N weeks / N months)** | `buildCustomViewConfig()`, default "3 Months"; per-calendar and per-user configurable; `?v=12w`, `?v=q`, `?v=c&dur=&unit=` | **absent** | **GAP** |
| Year | 12 mini-months, dots coloured by event type (`dataBound`) | 12 mini-months, 14-day preview strip, no type colouring | PARTIAL |
| Agenda | chronological list over a rolling range | fixed 14 days from start of week | PARTIAL |

The Custom view is the notable one: it is the *fifth* toolbar button in
production ("3 MONTHS" in the screenshot), it is reachable by three URL forms,
and it has settings UI in both the global and per-calendar panels. All of that
plumbing already exists in `nativecal/app.js` (`customViewDuration`,
`customViewUnit`, `validateCustomView`, watchers) — it is wired to nothing,
because `NativeCalendar.js:342` hardcodes
`const views = ['Day','Week','Month','Year','Agenda']`.

### 2.2 Event rendering

| Feature | Status | Detail |
| --- | --- | --- |
| Colour by type 1-8 | PARTIAL | `NativeCalendar.js:347` hardcodes the palette. Per-calendar **custom colours** (`loadCustomColors`, `updateEventColor`, a shipped settings feature) never reach the grid. |
| **Multi-day events** | **GAP** | `getEventsForDate` filters on `isSameDay(e.start, date)`, so an event renders **only on its start day**. Verified: a 10-13 Aug event draws as a single spanning bar in production and as a one-cell chip on the 10th in NativeCal. This silently hides data. |
| **All-day lane** | **GAP** | Day/Week have no all-day row. All-day events fall through `getEventsWithLayout` and get positioned as ordinary timed blocks. |
| Overlap stacking | OK | Column-packing in `getEventsWithLayout` is a correct greedy interval layout. |
| Recurrence expansion | OK | rrule.js, expanded per visible range. |
| Month-start labels ("Aug 1") | GAP | `dataBound` tags `.month-start` in production; nothing equivalent. |

### 2.3 Interaction

| Feature | Status | Detail |
| --- | --- | --- |
| Prev / next / today | OK | |
| Date-picker dropdown on the title | GAP | Syncfusion's title carries a caret; NativeCal's title is inert. |
| Click empty cell to create | OK (better) | Quick-create popover with "more details" escape hatch, vs Syncfusion's modal-first flow. |
| Click event to inspect | OK | `EventPopover` reimplements the production popup including the 480px wide-description behaviour. |
| Drag to move | OK | |
| Resize | OK | Bottom handle, `NativeCalendar.js:152`. |
| **Disable drag/resize on touch** | **GAP** | Production sets `allowDragAndDrop = allowResizing = !touchDevice` to stop accidental edits on phones. `NativeCalendar.js` has no touch guard. (`nativecal/app.js` checks `ontouchstart` for unrelated UI only.) |
| **Read-only enforcement** | **GAP** | `NativeCalendar.js` contains **zero** occurrences of `readOnly`. The shell tracks `isReadOnly` and hides chrome, but the grid still accepts cell-click-to-create, drag, resize, and edit. Read-only links are a shipped feature with their own e2e spec. |

### 2.4 Event editor

Largely at parity and in places better.

| Field | Status |
| --- | --- |
| Subject, description, delete | OK |
| Start / end | OK, and **better**: native `datetime-local` / `date` inputs render in the browser's own locale, which removes the entire class of bug that `strictMode` + `resolveDateFormat()` exists to patch. |
| All-day toggle | OK — switches the inputs between `date` and `datetime-local`. |
| Type / colour | PARTIAL — colour swatches, but **no type labels**. Production shows the user's custom labels ("Type 1"… or renamed) in a dropdown, plus a "Customize labels in Settings" hint. |
| Recurrence | PARTIAL — Daily/Weekly/Monthly + interval + UNTIL. Missing the weekday picker, monthly by-position, and "ends after N". See 3.5. |

### 2.5 Configuration and shell integration

| Feature | Status | Detail |
| --- | --- | --- |
| `startHour` (incl. 5am mode) | **GAP** | Stored in `globalSettings`, has settings UI, never passed to the component. |
| `extended` (24-hour mode) | **GAP** | Same. |
| `firstDayOfWeek` | **GAP** | Same — the grid is hardcoded Sunday-first. |
| `timeFormat` 12/24 | OK | The one setting that is actually wired. |
| `defaultView` | GAP | No `applyDefaultView` equivalent. |
| **URL `?d=` / `?v=`** | **GAP** | `searchParams.get` appears **zero** times in `nativecal/app.js`. Deep links into a date or view — a documented feature — do nothing. |
| Search → jump to event | **GAP** | `jumpToEvent` is a stub with the body commented out and a `console.log('Stubbed')`. |
| Colour filters | OK | Search-panel-only in production too. Not a gap. |
| Dark mode | PARTIAL | Theme variables from `style.css` work. But `nativecal/index.html` drops the `tailwind.config` block, so the `dark:` utilities inside the components follow the OS preference instead of the app's explicit toggle. |
| ICS export / subscribe / slugs / recents | OK | Shell-level, engine-independent, shared services. |

### 2.6 Data model

Good news, and the reason a gradual rollout is safe at all: NativeCal loads the
**same** `models/Event.js`, `models/Calendar.js`, `services/CalendarDataService.js`
and `services/SlugManager.js`. Both engines read and write the same records the
same way. A calendar can be opened in either UI without migration.

---

## 3. UI control inventory

Every interactive control in the app, region by region. Compiled by diffing the
markup of both shells (`@click`, `v-model`, `data-testid`) and confirmed by
enumerating the rendered, visible controls in a real browser against both
engines.

**Score: 78 controls at parity, 12 missing, 3 partial, 2 deliberate divergences.**

### 3.1 Top bar

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Logo / home | yes | yes | OK |
| Calendar title (inline rename) | yes | yes | OK |
| Recent calendars dropdown | yes | yes | OK |
| Pin / remove a recent | yes | yes | OK |
| Help | yes | yes | OK |
| Search | yes | yes | OK |
| Settings | yes | yes | OK |
| `+Event` (with `⌘E` hint) | yes | yes | OK |
| Notes toggle | yes | yes | OK |
| Claim URL pill + Claim button | yes | yes | OK |
| Mobile menu | yes | yes | OK |
| **Share pill: one-click copy** | `share-pill-copied`, `share-pill-more` | absent | **GAP** |

### 3.2 Calendar toolbar

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Previous / Next | yes | yes | OK |
| Current range title | `August 2026` | `August 2026` | OK |
| **Title opens a date picker** | yes — the title is a button with a caret | inert text | **GAP** |
| **Today button** | **hidden on purpose** (`.e-toolbar-item.e-today { display:none !important }`) | **present** | **DIVERGENCE** |
| Day / Week / Month / Year / Agenda | yes | yes | OK |
| **Custom view (`3 Months`)** | 6th toolbar button | absent | **GAP** |

Two divergences in one toolbar, in opposite directions. The Today button was
deliberately suppressed in production; NativeCal reintroduces it. Keeping "the
same general UX" means picking one on purpose — bringing Today back is a
defensible evolution, but it should be a decision, not an accident.

### 3.3 Grid interactions

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Click empty cell to create | opens editor | quick-create popover | OK (better) |
| Click event | quick popup | popover | OK |
| Drag to move | yes | yes | OK |
| Resize from bottom edge | yes | yes | OK |
| Drag/resize disabled on touch | yes | **no guard** | **GAP** |
| Any edit blocked when read-only | yes | **not enforced** | **GAP** |

### 3.4 Event popup (click an event)

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Title, time, description | yes | yes | OK |
| Edit | yes | `popover-edit` | OK |
| Delete | yes | `popover-delete` | OK |
| Close | yes | `popover-close` | OK |
| Widens for long descriptions | 480px threshold | same threshold, reimplemented | OK |

### 3.5 Event editor

Field lists captured from both editors open in a browser.

| Field | Production (Syncfusion) | NativeCal | |
| --- | --- | --- | --- |
| Title | yes | `editor-title` | OK |
| Location | rendered but **CSS-hidden** | omitted | OK — matches effective UX |
| Start / End | Syncfusion datetime pickers, patched with `strictMode` + a resolved date format | native `datetime-local` / `date` | OK (better) |
| All day | yes | yes | OK |
| **Timezone (start + end)** | three controls | absent | **GAP — confirm intent** |
| Repeat: frequency | Daily/Weekly/Monthly/Yearly | Daily/Weekly/Monthly | PARTIAL |
| Repeat: interval ("every N") | yes | yes | OK |
| **Repeat: weekday picker (S M T W T F S)** | yes | absent | **GAP** |
| **Repeat: monthly by date vs by weekday** | radio pair | absent | **GAP** |
| Repeat: ends on a date | yes | yes | OK |
| **Repeat: ends after N occurrences** | yes | absent | **GAP** |
| Type / colour | dropdown showing the user's **type labels** | colour swatches, **unlabelled** | PARTIAL |
| Description | yes | `editor-description` | OK |
| Save / Cancel / Delete / Close | yes | yes | OK |

This corrects the earlier read of recurrence as being at parity. NativeCal
covers simple repeats; Syncfusion's editor also writes `BYDAY`, monthly
by-position, and `COUNT`. Any of those rules already stored on a calendar will
still *expand* correctly in NativeCal — rrule.js handles them — but the editor
cannot represent them, so opening such an event and saving it silently
downgrades the rule. Worth a guard: refuse to overwrite a rule the editor
cannot round-trip.

### 3.6 Quick add dialog

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Natural-language input (chrono) | yes | yes | OK |
| Parsed preview, submit, close | yes | yes | OK |
| `⌘E` / `Ctrl+E` shortcut | yes | yes | OK |

### 3.7 Search panel

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Query box, `/` to focus | yes | yes | OK |
| Colour filter chips, reset | yes | yes | OK |
| Result list | yes | yes | OK |
| **Click a result to jump** | moves the calendar to that week | `jumpToEvent` is a stub that logs "Stubbed" | **GAP** |

### 3.8 Share panel

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Editable URL + copy + native share | yes | yes | OK |
| Read-only URL + copy + native share | yes | yes | OK |
| Current-view URL + copy + share | yes | yes | OK |
| Create / customise the read-only link | yes | yes | OK |
| ICS URLs (editable + read-only) + copy | yes | yes | OK |
| **Subscribe (webcal)** | `subscribe-webcal` | absent | **GAP** |
| **Subscribe: Google** | `subscribe-google` | absent | **GAP** |
| **Subscribe: Outlook** | `subscribe-outlook` | absent | **GAP** |
| **Subscribe: Apple** | `subscribe-apple` | absent | **GAP** |
| `trackSubscribe()` analytics | 4 call sites | absent | **GAP** |

The whole one-tap subscribe row is missing. It shipped on 2026-08-21 — after
the fork — and is a good illustration of section 4: this is not a NativeCal
design decision, it is drift.

### 3.9 Notes and Help panels

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Notes textarea, autosave, toggle | yes | yes | OK |
| Type definitions imported from notes | yes | yes | OK |
| Help panel + "see how it works" | yes | yes | OK |

### 3.10 Settings

| Control | Production | NativeCal | Applied to the grid? |
| --- | --- | --- | --- |
| Dark mode (auto / light / dark) | yes | yes | partial — see 2.5 |
| Time format 12/24 | yes | yes | **yes** |
| **Date format** | yes | **absent** | — **GAP** |
| First day of week | yes | yes | **no** |
| Start hour | yes | yes | **no** |
| Default view | yes | yes | **no** |
| Custom view duration + unit (global) | yes | yes | **no** |
| Custom view duration + unit (per calendar) | yes | yes | **no** |
| Extended / 24-hour mode (per calendar) | yes | yes | **no** |
| Type labels (8) | yes | yes | editor ignores them |
| Event colours (8) + reset all | yes | yes | **no** — grid hardcodes the palette |

The settings *panel* is almost at parity. The problem is the right-hand column:
nine of eleven controls render, accept input, and persist, but change nothing
on screen. A user who sets "start the week on Monday" gets a Sunday grid and no
error. That is worse than the control being absent.

### 3.11 Onboarding and misc

| Control | Production | NativeCal | |
| --- | --- | --- | --- |
| Claim dialog (confirm / randomise slug) | yes | yes | OK |
| Read-only slug input | yes | yes | OK |
| Toasts | yes | yes | OK |
| Tooltips | yes | yes | OK |
| **Welcome dock** ("Got it" / "See how it works" / dismiss) | yes | **component not even registered** | **GAP** |


## 4. The structural problem: it is a fork, not a component

`public/nativecal/index.html` and `public/nativecal/app.js` are **copies** of
the production shell, taken at cache-bust `v=1763769217` while production is
now at `v=1787723862`. The copies are 306 and 1,335 diff lines away from their
originals.

This is not a one-off. In the ten days since NativeCal was last touched,
**15 commits** landed on `public/app.js` / `public/index.html`: the welcome
dock, the design-system tokens, one-tap subscribe, the header share pill,
anonymous auth, `AuthorSignal`, and the whole analytics delivery fix. NativeCal
has none of them. `nativecal/index.html` still omits `AuthorSignal.js` and the
gtag bootstrap entirely.

Every day the fork exists, parity gets further away, and half the "gaps" in
section 2 are really just *the fork not having been re-synced*. **Merging the
fork back is the highest-leverage move available, and it should come before
any further feature work.**

### Proposed shape

One shell, one `app.js`, with the engine chosen at runtime behind a small
adapter:

```
CalendarEngine
  mount(el, options)
  setEvents(events)
  setView(name) / getView()
  setDate(date) / getDate()
  setOptions({ startHour, firstDayOfWeek, timeFormat, readOnly,
               colors, customView, extended })
  on('create'|'update'|'delete'|'viewchange', handler)
  refresh()
  destroy()
```

`SyncfusionEngine` wraps `ej.schedule.Schedule`; `NativeEngine` wraps
`NativeCalendar`. `app.js` stops referencing `scheduleObj` and talks only to
the adapter. The Syncfusion-specific code is already concentrated —
`mounted()` lines ~364-800 plus `applyDefaultView`, `applyGlobalSettings`,
`swapSyncfusionTheme`, `updateCalendarView`, `jumpToEvent` — so this is a
bounded extraction, not a rewrite.

Writing the adapter also *defines* parity: every method on it is a thing both
engines must do, and section 2's gaps become the `NativeEngine` to-do list.

---

## 5. Rollout plan

Each phase is independently shippable and independently revertable. Nothing
before Phase 5 changes what an existing user sees.

### Phase 0 — De-fork (blocking) — **done**

Extract the `CalendarEngine` adapter. Delete `public/nativecal/index.html` and
`public/nativecal/app.js`. Serve NativeCal from the production shell, selected
by `?cal=native`. Keep `/nativecal/<slug>` working as a redirect so existing
bookmarks and the two existing e2e specs survive.

This alone closes seven of the control gaps in section 3, because they are drift
rather than design: the one-tap subscribe row (webcal, Google, Outlook, Apple)
with its `trackSubscribe` analytics, the share pill's one-click copy, the welcome
dock, and the date-format setting. None of them need to be rebuilt — they need
to stop living in a copy.

Done when: `/x?cal=native` and `/x?cal=syncfusion` render the same shell, the
same welcome dock, the same analytics, and differ only in the grid.

### Phase 1 — Correctness gaps — **done**

The ones that lose or expose data. In priority order:

1. **Multi-day event spanning** — month bars across cells and week rows; a
   `getEventsForDate` that tests interval overlap rather than start-day
   equality.
2. **All-day lane** in Day/Week.
3. **Read-only enforcement** inside the component — gate create, drag, resize
   and edit on a `readOnly` prop.
4. **Touch guard** — no drag or resize when `ontouchstart` is present.

### Phase 2 — Configuration gaps — **done**

Nine of the eleven settings controls currently render, accept input and persist
while changing nothing on screen (section 3.10) — worse than being absent, since
there is no error to notice. Turn them into live props: `startHour`, `extended`,
`firstDayOfWeek`, `defaultView`, custom colours, and type labels in the editor.
Then the Custom view (N weeks / N months), which is the last missing toolbar
button.

Also in this phase, the recurrence editor: the weekday picker, monthly
by-position, and "ends after N occurrences". Until those land, guard the editor
so saving an event whose rule it cannot represent does not silently downgrade
that rule.

### Phase 3 — Shell integration — **done**

`?d=` / `?v=` URL params (all the aliases production accepts: `d`, `date`, `v`,
`view`, `12w`, `q`, `c`+`dur`+`unit`), `jumpToEvent`, the title date-picker
dropdown, month-start labels, year-view type colouring, and the `tailwind.config`
darkMode selector.

Settle the Today button here too: production hides it deliberately, NativeCal
adds it back. Either is fine; shipping both engines with different toolbars is
not.

### Phase 4 — Prove it — **done**

`test/e2e/engine-parity.spec.js` runs 21 cases against both engines and is green
on both. `test/e2e/cdn-cache.js` takes the seven third-party libraries out of
the test path; opt in with `PASTECAL_CDN_CACHE`, populate with
`npm run test:e2e:cache`. Unset, the suite fetches from the network as before.

Worth noting from a run: the native cases take about 1.5s each against
Syncfusion's 15s. That is the 5 MB bundle showing up as wall-clock on every
test.

### Phase 5 — Opt-in — **next**

Ship `?cal=native` publicly. Announce it in the help panel. Dogfood on
pastecal's own calendars. Track `engine` as an analytics dimension so
`stats.sh` can compare event-add rates and error rates between engines.

### Phase 6 — Percentage rollout

`remoteconfig.template.json` is already declared in `firebase.json` and is
currently empty — it is the natural switch. Add a `calendar_engine` parameter,
roll 5% → 25% → 50% → 100%, with `?cal=syncfusion` as a permanent escape hatch
during this phase. Watch the event-add funnel and JS error rate at each step;
any regression rolls back by editing one Remote Config value, no deploy.

### Phase 7 — Remove Syncfusion

Once 100% has held for a couple of weeks: drop the three CDN stylesheets, the
`ej2.min.js` script tag, `registerLicense`, `swapSyncfusionTheme`,
`SyncfusionEngine`, `getSyncFusionEvents`, and the `Subject`/`StartTime`/`Type`
aliases in `models/Event.js` that exist only for Syncfusion's field names.
Cancel the licence.

---

## 6. How we prove it works

**A parity suite, not a NativeCal suite.** The existing e2e specs
(`basic`, `all-day-events`, `date-format`, `settings-apply`, `mobile-popup`,
`legacy-readonly-popup-links`, `write-gate`, `quick-add-dialog`) already encode
the behaviour we must not lose. Parameterise them over the engine — a Playwright
project per engine that sets `?cal=` — and require both to pass. A spec that
cannot pass on NativeCal is, by definition, a parity gap; that list is the
release gate.

This subsumes `nativecal-sanity.spec.js` and `nativecal-event-popover.spec.js`,
which today test NativeCal against nothing but themselves.

**Add specs for the section 2 gaps first**, red, before fixing them:
a 4-day event visible on all four days; an all-day event in the all-day lane in
Week view; a read-only calendar rejecting a cell click and a drag; `?d=` and
`?v=` honoured; `firstDayOfWeek=1` starting the grid on Monday.

**A note on the local harness.** `firebase serve` is the documented dev server,
but the e2e suite also needs the seven CDN assets (Vue, Tailwind, date-fns,
rrule, chrono, firebase-compat, and — until Phase 7 — Syncfusion). Caching
those and fulfilling them from disk in a Playwright fixture makes the suite
deterministic, offline-capable, and roughly a second faster per test; it also
removes a real source of CI flake. Worth doing as part of Phase 4.

---

## 7. Where NativeCal should go beyond parity

Parity is the bar, not the goal. Things Syncfusion made hard that we get cheaply
once we own the component:

- **Popup positioning that just works.** The 100-line `popupOpen` block, the
  `MutationObserver`, and the reverted-fix comment about icon glyphs failing to
  paint all disappear when we control layout.
- **Locale-correct date entry for free** (already true in `EventEditor`).
- **Keyboard navigation** — arrows to move the cursor, `n` to create, `Esc` to
  close. Syncfusion's is unusable and unstyleable.
- **Real print output** — a print stylesheet for the month grid is trivial on
  our own DOM and impossible on theirs.
- **Week numbers**, and a proper "N weeks from today" custom view rather than
  Syncfusion's calendar-aligned approximation.
- **Faster first paint** — no 4.5 MB parse before the grid appears, which is
  the whole point of a paste-and-share calendar.
