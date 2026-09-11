/**
 * Unit tests for the colour filter (public/app.js).
 *
 * Issue #41 was reported as "editing the time of an event makes it disappear, but search
 * still finds it and it can't be deleted". The event had not been touched: the search
 * panel's colour filter was hiding it, and the calendar it happened on had exactly ONE
 * event of the hidden type, so filtering that colour did not thin out a group -- it
 * erased the only member.
 *
 * The fix took four rounds, and every round failed the same way: there were TWO
 * definitions of "is this event visible" -- the predicate feeding the grid, and the
 * predicate counting hidden events -- with nothing forcing them to agree.
 *
 *   round 1: they disagreed about whether the search panel was open
 *   round 2: they disagreed about event types with no colour slot
 *   round 3: they disagreed about the length of the colorFilters array
 *   round 4: they disagreed about how `type: 0` normalises (`??` vs `||`)
 *
 * The grid is now filtered with isEventVisible() directly, so there is only one
 * definition and the class of bug is unrepresentable. These tests pin that down: the
 * shared predicate, the normalisation it must match, and the slot bookkeeping.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// The filter logic lives on a Vue options object that cannot be instantiated headlessly,
// so these mirror the methods exactly as written in public/app.js. filter-parity.test.js
// guards against that mirror drifting from the real source.
function makeApp(colors = 8, filters = null) {
  return {
    COLORS: Array.from({ length: colors }, (_, i) => `#00000${i}`),
    colorFilters: filters || Array.from({ length: colors }, () => true),
    calendar: { events: [], options: {} },

    filterSlotFor(event) {
      const type = parseInt(event.type || event.Type || 1);
      if (!Number.isFinite(type) || type < 1 || type > this.COLORS.length) return 0;
      return type - 1;
    },

    isEventVisible(event) {
      return this.colorFilters[this.filterSlotFor(event)] === true;
    },

    syncColorFiltersLength() {
      const want = this.COLORS.length;
      if (this.colorFilters.length === want) return;
      const next = [];
      for (let i = 0; i < want; i++) next.push(this.colorFilters[i] !== false);
      this.colorFilters = next;
    },
  };
}

// --- The invariant: what the grid shows and what the count reports never disagree -------

test('grid and hidden-count are derived from the same predicate', () => {
  const app = makeApp();
  app.calendar.events = [
    { title: 'a', type: 1 }, { title: 'b', type: 4 },
    { title: 'c', type: 4 }, { title: 'd', type: 7 },
  ];
  app.colorFilters[3] = false; // hide type 4

  const shown = app.calendar.events.filter(e => app.isEventVisible(e));
  const hidden = app.calendar.events.filter(e => !app.isEventVisible(e));

  assert.equal(shown.length, 2);
  assert.equal(hidden.length, 2, 'both type-4 events are hidden');
  assert.equal(shown.length + hidden.length, app.calendar.events.length,
    'every event is either shown or counted as hidden -- never neither, never both');
});

test('the single-member category from #41: hiding one colour erases the only event', () => {
  const app = makeApp();
  app.calendar.events = [{ title: 'Movie Night', type: 4 }];
  app.colorFilters[3] = false;

  assert.equal(app.isEventVisible(app.calendar.events[0]), false);
  assert.equal(app.calendar.events.filter(e => !app.isEventVisible(e)).length, 1,
    'the count must report it -- this is the whole point of the indicator');
});

// --- Normalisation must match the grid's (round 4) --------------------------------------

test('type is normalised with || 1, matching Calendar.getSyncFusionEvents', () => {
  // Calendar.getSyncFusionEvents does `parseInt(e.type || 1)`, so 0/""/null are all
  // type 1 by the time Syncfusion sees them. Using `??` here instead made this file
  // classify them as 0/NaN while the grid had already made them 1.
  const app = makeApp();
  for (const falsy of [0, '', null, undefined]) {
    assert.equal(app.filterSlotFor({ type: falsy }), 0,
      `type ${JSON.stringify(falsy)} must land in slot 0, as it does on the grid`);
  }
});

test('a hidden type 1 also hides the events that normalise to type 1', () => {
  const app = makeApp();
  app.colorFilters[0] = false;
  for (const falsy of [0, '', null, undefined, 'garbage']) {
    assert.equal(app.isEventVisible({ type: falsy }), false,
      `type ${JSON.stringify(falsy)} follows the type 1 dot`);
  }
});

test('both event shapes are accepted', () => {
  // App model uses lowercase `type`; Syncfusion's internal objects use `Type`.
  const app = makeApp();
  assert.equal(app.filterSlotFor({ type: 3 }), 2);
  assert.equal(app.filterSlotFor({ Type: 3 }), 2);
});

// --- Types with no colour slot (round 2) ------------------------------------------------

test('a type beyond the palette follows the type 1 dot, because that is how it is painted', () => {
  // eventRendered and getTypeColor both fall back to COLORS[0], so an out-of-range event
  // renders in type 1's colour. The dot the user would click to hide it is therefore the
  // type 1 dot, and the filter has to agree with what they see.
  const app = makeApp();
  assert.equal(app.filterSlotFor({ type: 99 }), 0);

  app.colorFilters[0] = false;
  assert.equal(app.isEventVisible({ type: 99 }), false, 'hidden with type 1');

  app.colorFilters[0] = true;
  app.colorFilters[3] = false;
  assert.equal(app.isEventVisible({ type: 99 }), true,
    'an unrelated colour must not drag it off the grid');
});

test('negative and fractional types are handled without throwing', () => {
  const app = makeApp();
  assert.equal(app.filterSlotFor({ type: -5 }), 0);
  assert.equal(app.filterSlotFor({ type: 2.7 }), 1, 'parseInt truncates to 2');
});

// --- Slot bookkeeping when the palette changes (round 3) --------------------------------

test('colorFilters follows COLORS when a custom palette changes its length', () => {
  // calendar.options.colors comes from Firebase and is never length-checked. If the flags
  // and the dots fall out of step, a dot toggles the wrong type.
  const app = makeApp(8);
  app.colorFilters[3] = false;

  app.COLORS = Array.from({ length: 4 }, (_, i) => `#f0000${i}`);
  app.syncColorFiltersLength();
  assert.equal(app.colorFilters.length, 4, 'shrinks to match');
  assert.equal(app.colorFilters[3], false, 'surviving choices are preserved');

  app.COLORS = Array.from({ length: 10 }, (_, i) => `#0f000${i}`);
  app.syncColorFiltersLength();
  assert.equal(app.colorFilters.length, 10, 'grows to match');
  assert.deepEqual(app.colorFilters.slice(4), [true, true, true, true, true, true],
    'new slots default to shown, never to hidden');
});

test('a type whose slot fell off a shrinking palette is still reachable', () => {
  const app = makeApp(10);
  app.colorFilters[8] = false;          // hide type 9
  app.COLORS = app.COLORS.slice(0, 6);  // palette shrinks; slot 8 is gone
  app.syncColorFiltersLength();

  // Type 9 is now out of range, so it follows type 1 -- which is on, so it is visible.
  // The event must not be stranded hidden with no dot able to bring it back.
  assert.equal(app.isEventVisible({ type: 9 }), true);
});

// --- All on / all off -------------------------------------------------------------------

test('all colours on shows everything; all off hides everything', () => {
  const app = makeApp();
  const events = [{ type: 1 }, { type: 4 }, { type: 8 }, { type: 99 }];

  assert.equal(events.every(e => app.isEventVisible(e)), true);

  app.colorFilters = app.colorFilters.map(() => false);
  assert.equal(events.some(e => app.isEventVisible(e)), false);
  assert.equal(events.filter(e => !app.isEventVisible(e)).length, events.length,
    'and every one of them is counted');
});
