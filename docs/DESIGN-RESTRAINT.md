# Design restraint

pastecal's virtue is that it is simple. Restraint is saying no repeatedly, so these rules are checked on every change
and the key pages carry a budget that can only go down (`cloudflare/test/restraint.spec.js`).

## The rules

1. **One loud thing per screen.** On a calendar page that is the calendar. At most one filled (primary) button in the
   first screen: Save & share, or Share. Everything else is quiet: muted text links, no chips, no badges unless they
   show a state you can't otherwise see.
2. **Every element earns its place.** With data (`./scripts/stats.sh panels`, `stats.sh events`) or a job nothing else
   does. Ask what breaks if it is removed; if nothing, remove it. (The homepage's "Start from" chip row: 1 person in
   60 days. It became one sentence in the guide panel.)
3. **Words: one short line, never two.** Don't explain what people can see. Say a thing once per page (the homepage
   listed its five promises twice; the guide panel now has three short ones, the full list is below the calendar).
4. **Help in place, not up front.** Hints appear when they are needed (an empty calendar, the first save), not as
   permanent fixtures. Toasts only for what you can't see happen: a delete, someone else's edit, an error.
5. **Defaults over options.** One quiet way to do a thing. No control for the default ("Blank" is the default, so it
   isn't a chip).
6. **A small visual vocabulary.** Two type weights per view, one accent color, one corner radius per kind of element,
   the spacing tokens. No raw browser controls (`test/unit/native-fields.test.js`).
7. **Nothing floats over content** except what you are working on (the event card, a picker, a dialog).
8. **A deliberate action always acts.** Enter, Done, Save do what they say, even with fields left empty (an untitled
   event is "(No title)"). Only accidental exits (a click outside, a swipe) may quietly do nothing.
9. **Remember the last choice.** A run of similar entries should not repeat the same picks (a new event takes the type
   of the last one added).
10. **More room means a modal, not a bigger popover.** The quick card sits beside its event; "More details" is a
   centered dialog over a scrim, as classic's editor was.
11. **Status text must tell you something you don't know.** "Edited just now" under the change you just made is noise.

## The budget

`restraint.spec.js` measures the first screen of six pages, in dark and light: filled buttons, accent-colored links
(outside the calendar grid), chips and badges, and words outside the calendar grid. The numbers in the spec are the
ceiling. Lower them when a page gets quieter. Raise one only with a reason written here.

| Page | Filled | Accent links | Chips/badges | Words | Notes |
|---|---|---|---|---|---|
| Homepage, desktop 1440 | 1 | 3 | 0 | 118 | was 150 before the guide panel trim; template choices became quiet outline pills (links 6 to 3); +4 words for "3,000+ calendars since 2021", owner's call (Oct 26 2026) |
| Homepage, phone 390 | 2 | 2 | 0 | 33 | **over the rule**: + and Save & share are both filled; next to fix |
| Edit link, desktop | 1 | 1 | 1 | 36 | |
| View link, desktop | 0 | 3 | 1 | 46 | |
| View link, phone | 0 | 2 | 1 | 32 | +1 word: "Notes" in the header when the calendar has notes (app-stress-3 A20: they were hidden in the ⋮ menu with no sign they exist; desktop pins them open) |
| Embed, 720 | 0 | 0 | 0 | 18 | one quiet header line |
| Event card (quick view) | - | - | - | 13 | title, type, date and times, More details, Done; the "Edited just now" line (3 words) removed Oct 27 2026 |
| Settings panel | 0 | - | - | 43 | this calendar only since Oct 28 2026 (was ~70 words with "Only me" in it); Backup last |
| You panel | 0 | - | - | 36 | your name (optional) and its one line, then the six preferences that left Settings |
| Make a copy dialog | 1 | - | - | 8 | name, Include events, Make copy |
| Import dialog (2 new events) | 1 | - | - | 21 | title, "New · 2", two rows (date, time, title, as the Agenda), Cancel, Import 2 events; no summary line (the headings and the button carry the counts), "Already in this calendar" and "Not imported" folded (Oct 28 2026) |

## Next, in order

1. Phone homepage: one filled button (make + quiet, or fold it into the calendar).
2. Edit-link header: audit with `stats.sh panels` after a week of data; what nobody uses moves into one ⋯ menu.
3. Classic toolbar: six view buttons; check view use, the rarely used ones behind "More views".
4. Nudges (subscribe hint, name prompt, upsells): at most one per visit.

Every change: before/after screenshots in dark and light, read before it ships.
