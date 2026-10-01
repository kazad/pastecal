/**
 * Behavioral tests for the color filter, run against the REAL functions in public/app.js.
 *
 * Issue #41: a user reported an event vanishing from the calendar after they edited its
 * time, while search still found it and it could not be clicked or deleted. The event was
 * untouched -- the search panel's color filter was hiding it, and that calendar had
 * exactly ONE event of the hidden type, so filtering the color erased the only member.
 *
 * The fix took several rounds, and every round failed the same way: there were TWO
 * definitions of "is this event visible" -- the one feeding the grid and the one counting
 * hidden events -- with nothing forcing them to agree.
 *
 *   the search panel being open was a hidden input to one of them
 *   types with no color slot were classified differently by each
 *   the colorFilters array could drift out of length with COLORS
 *   `type: 0` normalized as 0 in one and 1 in the other
 *
 * An earlier version of this file re-declared the functions under test, which meant it
 * could pass while the shipped code was broken. These tests extract the real method bodies
 * from public/app.js and execute them, so sabotaging the source fails the suite.
 *
 * Recurrence is expanded by Syncfusion's own ej.schedule.generate, so the recurring-event
 * tests load the real ej2.min.js (the version index.html pins) into a VM. It is cached in
 * the OS temp dir after the first download; set PASTECAL_EJ2_PATH to use a local copy. If
 * it cannot be had, those tests skip rather than test a stand-in.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');

const METHODS = ['filterSlotFor', 'isEventVisible', 'syncColorFiltersLength',
  'isColorFilterActive', 'hiddenEventCount', 'recurrenceOccursInRange', 'spansRange'];

// Pull one method/computed out of app.js by name and turn it into a callable function.
// Brace-matching from the opening `{` keeps nested blocks and object literals intact.
function extract(name, ej) {
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
  return new Function('ej', `return function(${m[1]}) {${body}}`)(ej);
}

// Minimal stand-in for Syncfusion WITHOUT generate, which exercises the fallback estimate.
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

// The real bundle, so recurrence is expanded exactly as the grid expands it.
function loadRealEj() {
  const version = (/cdn\.syncfusion\.com\/ej2\/([\d.]+)\/dist\/ej2\.min\.js/.exec(INDEX) || [])[1];
  if (!version) return { reason: 'index.html no longer pins an ej2.min.js version' };
  const url = `https://cdn.syncfusion.com/ej2/${version}/dist/ej2.min.js`;
  const file = process.env.PASTECAL_EJ2_PATH
    || path.join(os.tmpdir(), `pastecal-ej2-${version}.min.js`);
  if (!fs.existsSync(file)) {
    // curl honors the HTTPS proxy settings that node's own fetch ignores.
    const tmp = `${file}.${process.pid}.part`;
    const r = spawnSync('curl', ['-sfL', '--max-time', '60', '-o', tmp, url]);
    if (r.status !== 0) return { reason: `could not download ${url}` };
    fs.renameSync(tmp, file);
  }

  const noop = () => {};
  const any = () => new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : any()), apply: () => any(),
  });
  // Share the host's Date so the dates generate() returns compare with ours.
  const sb = { console, setTimeout, clearTimeout, Date, Math, JSON, Intl, Object, Array };
  Object.assign(sb, {
    window: sb, self: sb, addEventListener: noop, removeEventListener: noop,
    navigator: { userAgent: 'node', platform: '', language: 'en-US' },
    document: {
      addEventListener: noop, createElement: () => any(), querySelector: () => null,
      querySelectorAll: () => [], body: any(), documentElement: any(), head: any(),
      getElementsByTagName: () => [],
    },
    location: { href: '', protocol: 'https:' },
    matchMedia: () => ({ matches: false, addListener: noop }),
    getComputedStyle: () => ({}), localStorage: { getItem: () => null },
    Element: function () {}, HTMLElement: function () {}, Node: function () {},
  });
  try {
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sb, { timeout: 120000 });
  } catch (err) {
    return { reason: `ej2.min.js failed to load: ${err.message}` };
  }
  if (typeof sb.ej?.schedule?.generate !== 'function') {
    return { reason: 'ej.schedule.generate is missing from the bundle' };
  }
  return { ej: sb.ej };
}

let realEj; // loaded on first use, so only the tests that need it pay for it
function needRealEj(t) {
  if (realEj === undefined) realEj = loadRealEj();
  if (!realEj.ej) t.skip(realEj.reason);
  return realEj.ej;
}

// A stand-in for the Vue component instance the methods run against.
function ctx(overrides = {}) {
  const colors = overrides.colors || 8;
  const ej = overrides.ej || stubEj();
  const self = {
    COLORS: Array.from({ length: colors }, (_, i) => `#00000${i}`),
    colorFilters: overrides.colorFilters || Array.from({ length: colors }, () => true),
    calendar: { events: overrides.events || [], options: overrides.options || {} },
    globalSettings: { firstDayOfWeek: '0' },
    viewTick: 0,
    visibleDateRange: overrides.visibleDateRange || (() => null),
  };
  // Bind so `this` inside each extracted body is this context.
  for (const k of METHODS) self[k] = extract(k, ej).bind(self);
  return self;
}

// Local-time ms, so the fixtures read the same in every time zone the suite runs in.
const L = s => new Date(s).getTime();
// The week of Sun Nov 8 - Sat Nov 14 2026, as visibleDateRange reports it.
const WEEK = { start: L('2026-11-08T00:00:00'), end: L('2026-11-15T00:00:00') };

// A mixed fixture, each event labeled by hand with whether the grid draws it in WEEK.
// The labels are the oracle; nothing here is derived from the code under test.
const MIXED = [
  { inView: true, e: { title: 'BYDAY=MO;COUNT=5 from a Wednesday, 5th lands Mon Nov 9', type: 4,
    start: '2026-10-07T09:00:00', end: '2026-10-07T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;COUNT=5' } },
  { inView: false, e: { title: 'MO,WE,FR;COUNT=3, done by Oct 9', type: 4,
    start: '2026-10-05T09:00:00', end: '2026-10-05T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=3' } },
  { inView: false, e: { title: 'open-ended Tuesdays, Nov 10 excepted', type: 4,
    start: '2025-01-07T09:00:00', end: '2025-01-07T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1', recurrenceException: '20261110T120000Z' } },
  { inView: true, e: { title: 'every other Saturday, on Nov 14', type: 4,
    start: '2026-10-31T09:00:00', end: '2026-10-31T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=SA;INTERVAL=2' } },
  { inView: false, e: { title: 'every other Saturday, off Nov 14', type: 2,
    start: '2026-11-07T09:00:00', end: '2026-11-07T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=SA;INTERVAL=2' } },
  { inView: true, e: { title: 'late-night daily spilling past midnight into Sun', type: 2,
    start: '2026-11-07T22:00:00', end: '2026-11-08T02:00:00', recurrencerule: 'FREQ=DAILY;COUNT=1' } },
  { inView: false, e: { title: 'all-day Sat Nov 7, ends at the window start', type: 4,
    isAllDay: true, start: '2026-11-07T00:00:00', end: '2026-11-08T00:00:00' } },
  { inView: true, e: { title: 'all-day Sat Nov 14', type: 4,
    isAllDay: true, start: '2026-11-14T00:00:00', end: '2026-11-15T00:00:00' } },
  { inView: true, e: { title: 'zero-length at the window start', type: 1,
    start: '2026-11-08T00:00:00', end: '2026-11-08T00:00:00' } },
  { inView: false, e: { title: 'zero-length at the window end', type: 1,
    start: '2026-11-15T00:00:00', end: '2026-11-15T00:00:00' } },
  { inView: true, e: { title: 'multi-day, spanning in from last week', type: 2,
    start: '2026-11-06T09:00:00', end: '2026-11-09T09:00:00' } },
  { inView: true, e: { title: 'plain timed', type: 1,
    start: '2026-11-11T13:00:00', end: '2026-11-11T14:00:00' } },
];

// --- The invariant: grid and count are the same predicate -------------------------------

test('the count equals the in-view events the grid predicate excludes, for every filter', (t) => {
  const ej = needRealEj(t);
  const app = ctx({ ej, events: MIXED.map(f => f.e), visibleDateRange: () => WEEK });
  // Every on/off combination of the types the fixture uses.
  const types = [1, 2, 4];
  for (let mask = 0; mask < 1 << types.length; mask++) {
    app.colorFilters = app.colorFilters.map(() => true);
    types.forEach((ty, i) => { if (mask & (1 << i)) app.colorFilters[ty - 1] = false; });

    const excluded = MIXED.filter(f => f.inView && !app.isEventVisible(f.e));
    assert.equal(app.hiddenEventCount(), excluded.length,
      `off: [${types.filter((_, i) => mask & (1 << i))}] — expected ${excluded.map(f => f.e.title)}`);
  }
});

test('the single-member category from #41 is reported, not silently dropped', () => {
  const app = ctx({ events: [{ title: 'Movie Night', type: 4 }] });
  app.colorFilters[3] = false;

  assert.equal(app.isEventVisible(app.calendar.events[0]), false);
  assert.equal(app.hiddenEventCount(), 1, 'the count is the only thing standing between the user and #41');
});

// --- Normalization must match the grid's ------------------------------------------------

test('falsy types normalize to slot 0, as Calendar.getSyncFusionEvents does', () => {
  const app = ctx();
  for (const falsy of [0, '', null, undefined]) {
    assert.equal(app.filterSlotFor({ type: falsy }), 0,
      `type ${JSON.stringify(falsy)} must land where the grid puts it`);
  }
});

test('hiding type 1 also hides everything that normalizes to type 1', () => {
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

// --- Types with no color slot ----------------------------------------------------------

test('a type beyond the palette follows the type 1 dot, matching how it is painted', () => {
  // eventRendered and getTypeColor both fall back to COLORS[0].
  const app = ctx();
  assert.equal(app.filterSlotFor({ type: 99 }), 0);

  app.colorFilters[0] = false;
  assert.equal(app.isEventVisible({ type: 99 }), false);

  app.colorFilters[0] = true;
  app.colorFilters[3] = false;
  assert.equal(app.isEventVisible({ type: 99 }), true,
    'an unrelated color must not drag it off the grid');
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

test('isColorFilterActive reports a switched-off color even with nothing hidden in view', () => {
  // Filters persist past closing the panel, so the banner cannot key off the count alone:
  // paging to a week with none of the hidden type would drop it to 0 and hide the warning
  // while the filter was still on.
  const app = ctx({ events: [] });
  assert.equal(app.isColorFilterActive(), false);

  app.colorFilters[3] = false;
  assert.equal(app.isColorFilterActive(), true);
  assert.equal(app.hiddenEventCount(), 0, 'no events at all, so nothing to count');
});

test('all colors off hides everything and counts all of it', () => {
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

test('without generate, the fallback still drops a series that already finished', () => {
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

// --- Recurrence, expanded by the real Syncfusion ------------------------------------------

function hiddenIn(range, event, ej) {
  const app = ctx({ ej, events: [event], visibleDateRange: () => range });
  app.colorFilters[event.type - 1] = false;
  return app.hiddenEventCount();
}

test('BYDAY moves the last occurrence of a COUNT series later than start + COUNT steps', (t) => {
  // Starting on a Wednesday, the first Monday is the first occurrence, so the 5th lands on
  // Mon Nov 9 -- not Wed Nov 4, where stepping a week at a time from the start puts it.
  // The banner said "none in this view" while that Monday was hidden.
  const ej = needRealEj(t);
  const standup = { type: 4, start: '2026-10-07T09:00:00', end: '2026-10-07T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;COUNT=5' };
  assert.equal(hiddenIn(WEEK, standup, ej), 1);
  assert.equal(hiddenIn({ start: L('2026-11-15T00:00:00'), end: L('2026-11-22T00:00:00') },
    standup, ej), 0, 'and nothing the week after it ends');
});

test('an open-ended series is counted only where its BYDAY/INTERVAL put it', (t) => {
  const ej = needRealEj(t);
  const saturdays = { type: 4, start: '2026-01-03T09:00:00', end: '2026-01-03T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=SA' };
  const monToWed = { start: L('2026-11-09T00:00:00'), end: L('2026-11-12T00:00:00') };
  assert.equal(hiddenIn(monToWed, saturdays, ej), 0, 'a 3-day view with no Saturday in it');
  assert.equal(hiddenIn(WEEK, saturdays, ej), 1);

  const fortnightly = { ...saturdays, start: '2026-11-07T09:00:00', end: '2026-11-07T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=SA;INTERVAL=2' };
  assert.equal(hiddenIn(WEEK, fortnightly, ej), 0, 'the off week of an every-other-week series');
});

test('an occurrence removed by EXDATE is not counted', (t) => {
  const ej = needRealEj(t);
  const tuesdays = { type: 4, start: '2025-01-07T09:00:00', end: '2025-01-07T10:00:00',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=TU' };
  assert.equal(hiddenIn(WEEK, tuesdays, ej), 1);
  assert.equal(hiddenIn(WEEK, { ...tuesdays, recurrenceException: '20261110T120000Z' }, ej), 0,
    'the only Tuesday in view was deleted from the series');
});

test('the real expansion still honors COUNT and UNTIL that ended long ago', (t) => {
  const ej = needRealEj(t);
  const old = { type: 4, start: '2025-01-06T09:00:00', end: '2025-01-06T09:30:00' };
  assert.equal(hiddenIn(WEEK, { ...old, recurrencerule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=6' }, ej), 0);
  assert.equal(hiddenIn(WEEK, { ...old, recurrencerule: 'FREQ=WEEKLY;UNTIL=20250301T000000Z' }, ej), 0);
  assert.equal(hiddenIn(WEEK, { ...old, recurrencerule: 'FREQ=WEEKLY;INTERVAL=1' }, ej), 1);
});

// --- Exclusive ends ---------------------------------------------------------------------

test('an all-day event ending at midnight is not counted in the week that midnight opens', () => {
  // Ends are exclusive: Sat Nov 7 all-day ends Sun Nov 8 00:00, which is the first instant
  // of WEEK, and the grid does not draw it there.
  const sat = { type: 4, isAllDay: true, start: '2026-11-07T00:00:00', end: '2026-11-08T00:00:00' };
  assert.equal(hiddenIn(WEEK, sat), 0);
  assert.equal(hiddenIn({ start: L('2026-11-01T00:00:00'), end: WEEK.start }, sat), 1);
});

test('a zero-length event counts in the window it starts in, and only that one', () => {
  const atMidnight = { type: 4, start: '2026-11-15T00:00:00', end: '2026-11-15T00:00:00' };
  assert.equal(hiddenIn(WEEK, atMidnight), 0, 'it starts at the exclusive end of WEEK');
  assert.equal(hiddenIn({ start: WEEK.end, end: WEEK.end + 7 * 864e5 }, atMidnight), 1);
});
