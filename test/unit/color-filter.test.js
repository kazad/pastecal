/**
 * Behavioural tests for the colour filter, run against the REAL functions in public/app.js.
 *
 * Issue #41: a user reported an event vanishing from the calendar after they edited its
 * time, while search still found it and it could not be clicked or deleted. The event was
 * untouched -- the search panel's colour filter was hiding it, and that calendar had
 * exactly ONE event of the hidden type, so filtering the colour erased the only member.
 *
 * The fix took several rounds, and every round failed the same way: there were TWO
 * definitions of "is this event visible" -- the one feeding the grid and the one counting
 * hidden events -- with nothing forcing them to agree.
 *
 *   the search panel being open was a hidden input to one of them
 *   types with no colour slot were classified differently by each
 *   the colorFilters array could drift out of length with COLORS
 *   `type: 0` normalised as 0 in one and 1 in the other
 *
 * An earlier version of this file re-declared the functions under test, which meant it
 * could pass while the shipped code was broken. These tests extract the real method bodies
 * from public/app.js and execute them, so sabotaging the source fails the suite.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');

// Pull one method/computed out of app.js by name and turn it into a callable function.
// Brace-matching from the opening `{` keeps nested blocks and object literals intact.
function extract(name) {
  const sig = new RegExp(`\\n\\s{8}${name}\\(([^)]*)\\)\\s*\\{`);
  const m = sig.exec(SRC);
  assert.ok(m, `could not find ${name}() in public/app.js — has it been renamed?`);

  const open = SRC.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = SRC.slice(open + 1, i);
  // eslint-disable-next-line no-new-func
  return new Function('ej', `return function(${m[1]}) {${body}}`)(stubEj());
}

// Minimal stand-in for the one Syncfusion helper the extracted code touches.
function stubEj() {
  return {
    schedule: {
      getDateFromRecurrenceDateString(s) {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(String(s));
        if (!m) return new Date(NaN);
        return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      },
    },
  };
}

const filterSlotFor = extract('filterSlotFor');
const isEventVisible = extract('isEventVisible');
const syncColorFiltersLength = extract('syncColorFiltersLength');
const isColorFilterActive = extract('isColorFilterActive');
const hiddenEventCount = extract('hiddenEventCount');
const recurrenceOccursInRange = extract('recurrenceOccursInRange');

// A stand-in for the Vue component instance the methods run against.
function ctx(overrides = {}) {
  const colors = overrides.colors || 8;
  const self = {
    COLORS: Array.from({ length: colors }, (_, i) => `#00000${i}`),
    colorFilters: overrides.colorFilters || Array.from({ length: colors }, () => true),
    calendar: { events: overrides.events || [], options: overrides.options || {} },
    viewTick: 0,
    filterSlotFor, isEventVisible, syncColorFiltersLength,
    isColorFilterActive, hiddenEventCount, recurrenceOccursInRange,
    visibleDateRange: overrides.visibleDateRange || (() => null),
  };
  // Rebind so `this` inside each extracted body is this context.
  for (const k of ['filterSlotFor', 'isEventVisible', 'syncColorFiltersLength',
                   'isColorFilterActive', 'hiddenEventCount', 'recurrenceOccursInRange']) {
    self[k] = self[k].bind(self);
  }
  return self;
}

// --- The invariant: grid and count are the same predicate -------------------------------

test('every event is either shown or counted as hidden, never neither', () => {
  const app = ctx({ events: [{ type: 1 }, { type: 4 }, { type: 4 }, { type: 7 }] });
  app.colorFilters[3] = false;

  const shown = app.calendar.events.filter(e => app.isEventVisible(e));
  const hidden = app.calendar.events.filter(e => !app.isEventVisible(e));

  assert.equal(shown.length, 2);
  assert.equal(hidden.length, 2);
  assert.equal(shown.length + hidden.length, app.calendar.events.length);
});

test('the single-member category from #41 is reported, not silently dropped', () => {
  const app = ctx({ events: [{ title: 'Movie Night', type: 4 }] });
  app.colorFilters[3] = false;

  assert.equal(app.isEventVisible(app.calendar.events[0]), false);
  assert.equal(app.hiddenEventCount(), 1, 'the count is the only thing standing between the user and #41');
});

// --- Normalisation must match the grid's ------------------------------------------------

test('falsy types normalise to slot 0, as Calendar.getSyncFusionEvents does', () => {
  const app = ctx();
  for (const falsy of [0, '', null, undefined]) {
    assert.equal(app.filterSlotFor({ type: falsy }), 0,
      `type ${JSON.stringify(falsy)} must land where the grid puts it`);
  }
});

test('hiding type 1 also hides everything that normalises to type 1', () => {
  const app = ctx();
  app.colorFilters[0] = false;
  for (const falsy of [0, '', null, undefined, 'garbage']) {
    assert.equal(app.isEventVisible({ type: falsy }), false);
  }
});

test('both event shapes are accepted', () => {
  const app = ctx();
  assert.equal(app.filterSlotFor({ type: 3 }), 2, 'app model uses lowercase type');
  assert.equal(app.filterSlotFor({ Type: 3 }), 2, 'Syncfusion objects use Type');
});

test('normalisation falls through a falsy lowercase type to Type, as || does', () => {
  // Calendar.getSyncFusionEvents uses `e.type || 1`, so a falsy `type` must fall through
  // rather than win. This is the one input where `??` and `||` actually disagree: with
  // `??`, {type: 0, Type: 5} stops at 0 and lands in slot 0 while the grid has it in
  // slot 4. Every other falsy value is masked by the out-of-range clamp.
  const app = ctx();
  assert.equal(app.filterSlotFor({ type: 0, Type: 5 }), 4,
    'a falsy lowercase type must not shadow the Syncfusion Type the grid rendered from');
});

// --- Types with no colour slot ----------------------------------------------------------

test('a type beyond the palette follows the type 1 dot, matching how it is painted', () => {
  // eventRendered and getTypeColor both fall back to COLORS[0].
  const app = ctx();
  assert.equal(app.filterSlotFor({ type: 99 }), 0);

  app.colorFilters[0] = false;
  assert.equal(app.isEventVisible({ type: 99 }), false);

  app.colorFilters[0] = true;
  app.colorFilters[3] = false;
  assert.equal(app.isEventVisible({ type: 99 }), true,
    'an unrelated colour must not drag it off the grid');
});

test('negative and fractional types do not throw', () => {
  const app = ctx();
  assert.equal(app.filterSlotFor({ type: -5 }), 0);
  assert.equal(app.filterSlotFor({ type: 2.7 }), 1);
});

// --- Slot bookkeeping -------------------------------------------------------------------

test('colorFilters follows COLORS when a custom palette changes length', () => {
  const app = ctx();
  app.colorFilters[3] = false;

  app.COLORS = Array.from({ length: 4 }, (_, i) => `#f0000${i}`);
  app.syncColorFiltersLength();
  assert.equal(app.colorFilters.length, 4);
  assert.equal(app.colorFilters[3], false, 'surviving choices are kept');

  app.COLORS = Array.from({ length: 10 }, (_, i) => `#0f000${i}`);
  app.syncColorFiltersLength();
  assert.equal(app.colorFilters.length, 10);
  assert.deepEqual(app.colorFilters.slice(4), Array(6).fill(true),
    'new slots default to shown, never hidden');
});

// --- The banner's own condition ---------------------------------------------------------

test('isColorFilterActive reports a switched-off colour even with nothing hidden in view', () => {
  // Filters persist past closing the panel, so the banner cannot key off the count alone:
  // paging to a week with none of the hidden type would drop it to 0 and hide the warning
  // while the filter was still on.
  const app = ctx({ events: [] });
  assert.equal(app.isColorFilterActive(), false);

  app.colorFilters[3] = false;
  assert.equal(app.isColorFilterActive(), true);
  assert.equal(app.hiddenEventCount(), 0, 'no events at all, so nothing to count');
});

test('all colours off hides everything and counts all of it', () => {
  const app = ctx({ events: [{ type: 1 }, { type: 4 }, { type: 8 }, { type: 99 }] });
  assert.equal(app.calendar.events.every(e => app.isEventVisible(e)), true);

  app.colorFilters = app.colorFilters.map(() => false);
  assert.equal(app.calendar.events.some(e => app.isEventVisible(e)), false);
  assert.equal(app.hiddenEventCount(), 4);
});

// --- Date scoping -----------------------------------------------------------------------

test('the count covers the visible range, not every event ever stored', () => {
  // One real calendar holds 2380 events of a single type; counting them all announced
  // "2380 events hidden" while 66 disappeared from the week on screen.
  const week = {
    start: Date.parse('2026-09-13T00:00:00Z'),
    end: Date.parse('2026-09-20T00:00:00Z'),
  };
  const app = ctx({
    events: [
      { title: 'in view', type: 4, start: '2026-09-17T22:00:00.000Z', end: '2026-09-18T01:00:00.000Z' },
      { title: 'long past', type: 4, start: '2025-01-15T18:00:00.000Z', end: '2025-01-15T19:00:00.000Z' },
    ],
    visibleDateRange: () => week,
  });
  app.colorFilters[3] = false;

  assert.equal(app.hiddenEventCount(), 1, 'only the event the user could have seen');
});

test('a recurring series that already finished is not counted as hidden here', () => {
  // The stored start only says when the series began. A weekly standup with COUNT=6 that
  // ended in early 2025 starts before every later window but belongs in none of them;
  // counting it produced a banner reporting an event the user could never find.
  const week = {
    start: Date.parse('2026-11-09T00:00:00Z'),
    end: Date.parse('2026-11-16T00:00:00Z'),
  };
  const app = ctx({
    events: [{
      title: 'Standup', type: 4,
      start: '2025-01-06T17:00:00.000Z', end: '2025-01-06T17:30:00.000Z',
      recurrencerule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=6',
    }],
    visibleDateRange: () => week,
  });
  app.colorFilters[3] = false;

  assert.equal(app.hiddenEventCount(), 0, 'the series put no occurrence in this week');
});

test('a recurring series with UNTIL in the past is not counted either', () => {
  const week = {
    start: Date.parse('2026-11-09T00:00:00Z'),
    end: Date.parse('2026-11-16T00:00:00Z'),
  };
  const app = ctx({
    events: [{
      title: 'Old series', type: 4,
      start: '2025-01-06T17:00:00.000Z', end: '2025-01-06T17:30:00.000Z',
      recurrencerule: 'FREQ=WEEKLY;INTERVAL=1;UNTIL=20250301T000000Z',
    }],
    visibleDateRange: () => week,
  });
  app.colorFilters[3] = false;

  assert.equal(app.hiddenEventCount(), 0);
});

test('an open-ended recurring series IS counted in a later window', () => {
  const week = {
    start: Date.parse('2026-11-09T00:00:00Z'),
    end: Date.parse('2026-11-16T00:00:00Z'),
  };
  const app = ctx({
    events: [{
      title: 'Forever standup', type: 4,
      start: '2025-01-06T17:00:00.000Z', end: '2025-01-06T17:30:00.000Z',
      recurrencerule: 'FREQ=WEEKLY;INTERVAL=1',
    }],
    visibleDateRange: () => week,
  });
  app.colorFilters[3] = false;

  assert.equal(app.hiddenEventCount(), 1, 'it still occurs, so it still counts');
});

test('an event with an unreadable date is counted rather than quietly ignored', () => {
  const week = {
    start: Date.parse('2026-09-13T00:00:00Z'),
    end: Date.parse('2026-09-20T00:00:00Z'),
  };
  const app = ctx({
    events: [{ title: 'broken', type: 4, start: 'not-a-date', end: 'nope' }],
    visibleDateRange: () => week,
  });
  app.colorFilters[3] = false;

  assert.equal(app.hiddenEventCount(), 1);
});
