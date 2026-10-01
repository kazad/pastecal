/**
 * Structural guards for the color filter, for the few properties a behavioral test
 * cannot reach.
 *
 * color-filter.test.js executes the real functions from public/app.js and is where the
 * logic is actually tested. This file only asserts things that live in the wiring rather
 * than in a function: that the grid and the count are fed by the same predicate, that no
 * second predicate has reappeared, and that the template puts the warning somewhere the
 * user will see it.
 *
 * These are source-text assertions, which makes them weak: they pass if the spelling is
 * right and the behavior is wrong. Keep them few, keep them about wiring, and put
 * anything that can be executed in color-filter.test.js instead.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { appMethod, APP } = require('./helpers/app-method');
const INDEX = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');

test('the grid is filtered with the same predicate the count uses', () => {
  // The bug class behind #41 was two definitions of "visible" that had to agree and
  // repeatedly did not. There must be exactly one, and the scheduler must be fed by it.
  assert.match(APP, /dataSource:\s*this\.syncFusionEvents\.filter\(\s*e\s*=>\s*this\.isEventVisible\(e\)\s*\)/,
    'updateCalendarView should hand the scheduler a list filtered by isEventVisible');

  const start = APP.indexOf('hiddenEventCount() {');
  assert.ok(start !== -1, 'hiddenEventCount should exist');
  const fn = APP.slice(start, start + 1600);
  assert.match(fn, /this\.isEventVisible\(e\)/, 'the count must use that same predicate');
  assert.doesNotMatch(fn, /colorFilters\[/,
    'the count must not index colorFilters itself — that was its own second predicate');
});

test('the count helpers that take arguments are methods, not computeds', () => {
  // Vue 3 calls a computed getter with no arguments and caches the result, so a
  // "computed" recurrenceOccursInRange was a boolean, and calling it threw inside
  // hiddenEventCount the moment a hidden recurring event was in view. The behavioral
  // tests call the extracted bodies directly, so only the wiring can catch this.
  const methods = APP.indexOf('\n    methods: {');
  assert.ok(methods !== -1, 'expected a methods block');
  for (const sig of ['recurrenceOccursInRange(event, range) {', 'spansRange(start, end, range) {']) {
    const at = APP.indexOf(sig);
    assert.ok(at !== -1, `${sig} should exist`);
    assert.ok(at > methods, `${sig} must live in methods`);
  }
});

test('visibility does not depend on whether the search panel is open', () => {
  // The original #41 defect: panel visibility was a hidden input to the filter, and
  // nothing rebuilt the query when the panel closed. Run the real predicate both ways.
  const isEventVisible = appMethod('isEventVisible');
  const filterSlotFor = appMethod('filterSlotFor');
  for (const showSearch of [true, false]) {
    const vm = { showSearch, COLORS: ['a', 'b', 'c'], colorFilters: [true, false, true], filterSlotFor };
    assert.equal(isEventVisible.call(vm, { type: 1 }), true, `showSearch=${showSearch}`);
    assert.equal(isEventVisible.call(vm, { type: 2 }), false, `showSearch=${showSearch}`);
  }
});

test('every assignment to COLORS keeps colorFilters the same length', () => {
  // colorFilters is one flag per color; if they drift, a dot toggles the wrong type.
  const assignments = [...APP.matchAll(/this\.COLORS\s*=\s*\[/g)];
  assert.ok(assignments.length >= 2, 'expected the palette to be assigned in more than one place');
  for (const m of assignments) {
    assert.match(APP.slice(m.index, m.index + 600), /syncColorFiltersLength\(\)/,
      `a COLORS assignment near index ${m.index} does not resync colorFilters`);
  }
});

test('the filter warning lives with the calendar, not inside the search panel', () => {
  // In #41 the event went missing after the panel was closed, so an in-panel-only warning
  // would never have been seen.
  const banner = INDEX.indexOf('data-testid="hidden-events-banner"');
  assert.ok(banner !== -1, 'expected a hidden-events banner in the template');
  const panelEnd = INDEX.indexOf('</panel>');
  assert.ok(panelEnd !== -1 && banner > panelEnd,
    'the banner must sit outside the search panel, with the calendar');

  // And it must track the filter being on, not merely something being hidden right here:
  // filters persist past closing the panel, so paging to a week with none of the hidden
  // type would otherwise drop the warning while the filter was still applied.
  assert.match(INDEX.slice(banner - 200, banner + 60), /v-if="isColorFilterActive"/,
    'the banner must show whenever a color is switched off');
});

test('the color dots are real, labeled toggle controls', () => {
  // They were <span>s: no name, no pressed state, no keyboard focus, and opacity as the
  // only "off" signal — which fails for colorblind users and near-identical palettes.
  const at = INDEX.indexOf('toggleColorFilter(idx)');
  assert.ok(at !== -1, 'expected the color dots in the template');
  const dots = INDEX.slice(at - 900, at + 1200);

  assert.match(dots, /role="switch"/, 'dots should expose a switch role');
  assert.match(dots, /:aria-checked=/, 'dots should expose their on/off state');
  assert.match(dots, /:aria-label="typeLabelFor\(idx\)"/, 'dots should be named, not color-only');
  assert.match(dots, /backgroundColor: 'transparent'/,
    'the off state needs a non-color signal (hollow dot), not just opacity');
  // A focusable control needs a visible focus indicator. Tailwind's ring utilities
  // resolve to a transparent shadow in this build, so the dots carry a real outline
  // from style.css instead.
  assert.match(dots, /pc-filter-dot/, 'dots should carry the class that styles their focus ring');
  const css = fs.readFileSync(path.join(__dirname, '../../public/style.css'), 'utf8');
  assert.match(css, /\.pc-filter-dot:focus-visible\s*\{[^}]*outline:/,
    'pc-filter-dot needs a visible focus-visible outline');
});

test('quick-add cannot produce an event with no end time', () => {
  // An event with a null end is dropped at the write boundary, so it sat on the grid
  // until reload and was then gone for good. Runs the shipped handleQuickAddEvent.
  const Event = new Function('Utils',
    `${fs.readFileSync(path.join(__dirname, '../../public/models/Event.js'), 'utf8')}\nreturn Event;`)(
    { uuidv4: () => 'generated-uuid' });
  const handleQuickAddEvent = appMethod('handleQuickAddEvent',
    { Event, track: () => {}, AuthorSignal: undefined });
  const events = [];
  const vm = {
    isExisting: false,
    calendar: { events, setEvents() {} },
    recordLocalAction() {},
  };
  handleQuickAddEvent.call(vm, { subject: 'standup', startDateTime: '2026-09-17T09:00:00.000Z' });
  assert.equal(events.length, 1);
  assert.ok(Event.isComplete(events[0]), 'the event must reach the write path complete');
  assert.equal(new Date(events[0].end).getTime() - new Date(events[0].start).getTime(), 3600000,
    'a missing end defaults to one hour after the start');
});

test('dropped events are surfaced to the user, not only the console', () => {
  // The service reports what it dropped (behavior, through the real write-boundary
  // filter) ...
  const { loadDataService, ev } = require('./helpers/data-service-harness');
  const { S } = loadDataService();
  const reported = [];
  S.onIncompleteEvents = (dropped) => reported.push(...dropped);
  const out = S._dropIncompleteEvents({ id: 'c', events: [ev('ok', 'ok'), ev('bad', 'bad', { end: null })] });
  assert.deepEqual([...out.events].map(e => e.id), ['ok']);
  assert.deepEqual(reported.map(e => e.id), ['bad']);
  // ... and the app registers a handler for it (wiring, which only the source shows).
  assert.match(APP, /CalendarDataService\.onIncompleteEvents\s*=/,
    'the app must register a handler so the drop reaches the user');
});
