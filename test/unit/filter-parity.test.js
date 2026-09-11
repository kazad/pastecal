/**
 * Guards the structural properties of the colour filter in public/app.js.
 *
 * color-filter.test.js mirrors the filter methods so it can exercise them headlessly. A
 * mirror can drift from the source it mirrors, and a drifted mirror tests nothing. These
 * tests read public/app.js itself and assert the properties that made issue #41 possible
 * cannot come back, regardless of how the code is refactored.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');

test('the grid is filtered with isEventVisible, not a second predicate', () => {
  // The #41 bug class was two definitions of "visible" that had to agree and repeatedly
  // did not. updateCalendarView must filter with the same function hiddenEventCount uses.
  assert.match(APP, /dataSource:\s*this\.syncFusionEvents\.filter\(\s*e\s*=>\s*this\.isEventVisible\(e\)\s*\)/,
    'updateCalendarView should hand the scheduler a list filtered by isEventVisible');
});

test('the ej.data.Query type predicate is gone', () => {
  // The old allow-list built `Type == n` clauses as a parallel definition of visibility.
  assert.doesNotMatch(APP, /getFilteredEventsQuery/,
    'getFilteredEventsQuery was replaced by filtering the array directly');
  assert.doesNotMatch(APP, /Predicate\(\s*['"]Type['"]/,
    'no Type equality predicate should remain -- that was the second source of truth');
});

test('hiddenEventCount is derived from isEventVisible', () => {
  const start = APP.indexOf('hiddenEventCount() {');
  assert.ok(start !== -1, 'hiddenEventCount should exist');
  const fn = APP.slice(start, start + 1400);
  assert.match(fn, /this\.isEventVisible\(e\)/,
    'the count must use the same predicate as the grid, never its own copy');
  assert.doesNotMatch(fn, /colorFilters\[/,
    'the count must not index colorFilters itself -- that was its own second predicate');
});

test('type normalisation matches Calendar.getSyncFusionEvents', () => {
  // getSyncFusionEvents does `parseInt(e.type || 1)`. filterSlotFor must use `||` too:
  // with `??`, a type of 0 or "" classified differently here than on the grid.
  const start = APP.indexOf('filterSlotFor(event) {');
  assert.ok(start !== -1, 'filterSlotFor should exist');
  const slot = APP.slice(start, start + 400);
  assert.match(slot, /parseInt\(event\.type \|\| event\.Type \|\| 1\)/,
    'filterSlotFor must normalise with || so falsy types land where the grid puts them');
  assert.doesNotMatch(slot, /\?\?/,
    '?? does not treat 0 and "" the way the rest of the app does');

  const cal = fs.readFileSync(path.join(__dirname, '../../public/models/Calendar.js'), 'utf8');
  assert.match(cal, /parseInt\(e\.type \|\| 1\)/,
    'the shape filterSlotFor is matching -- if this changes, filterSlotFor must too');
});

test('the filter does not depend on whether the search panel is open', () => {
  // The original #41 defect: panel visibility was a hidden input to the query, and
  // nothing rebuilt the query when the panel closed.
  const start = APP.indexOf('isEventVisible(event)');
  const body = APP.slice(start, start + 300);
  assert.doesNotMatch(body, /showSearch/,
    'visibility must depend only on colorFilters');
});

test('every assignment to COLORS keeps colorFilters the same length', () => {
  // colorFilters is one flag per colour. If they drift, a dot toggles the wrong type.
  const assignments = [...APP.matchAll(/this\.COLORS\s*=\s*\[/g)];
  assert.ok(assignments.length >= 2, 'expected the palette to be assigned in more than one place');

  for (const m of assignments) {
    const after = APP.slice(m.index, m.index + 600);
    assert.match(after, /syncColorFiltersLength\(\)/,
      `a COLORS assignment near index ${m.index} does not resync colorFilters`);
  }
});

test('a filtered-out event is reported outside the search panel', () => {
  // The indicator must not live only inside the panel: in #41 the user lost the event
  // after the panel was closed, so an in-panel-only warning would not have been seen.
  const banner = INDEX.indexOf('data-testid="hidden-events-banner"');
  assert.ok(banner !== -1, 'expected a hidden-events banner in the template');

  const panelEnd = INDEX.indexOf('</panel>');
  assert.ok(panelEnd !== -1 && banner > panelEnd,
    'the banner must sit outside the search panel, with the calendar');
});

test('the colour dots are real toggle controls', () => {
  // They were <span>s: no name, no pressed state, no keyboard focus, and opacity as the
  // only "off" signal -- which fails for colourblind users and near-identical palettes.
  const at = INDEX.indexOf('toggleColorFilter(idx)');
  assert.ok(at !== -1, 'expected the colour dots in the template');
  const dots = INDEX.slice(at - 900, at + 1200);
  assert.match(dots, /role="switch"/, 'dots should expose a switch role');
  assert.match(dots, /:aria-checked=/, 'dots should expose their on/off state');
  assert.match(dots, /:aria-label="typeLabelFor\(idx\)"/, 'dots should be named, not colour-only');
  assert.match(dots, /backgroundColor: 'transparent'/,
    'the off state needs a non-colour signal (hollow dot), not just opacity');
});

test('quick-add cannot produce an event with no end time', () => {
  // An event with a null end is dropped at the write boundary by _dropIncompleteEvents,
  // so it sits on the grid until reload and is then gone for good.
  const fn = APP.slice(APP.indexOf('handleQuickAddEvent(event)'),
                       APP.indexOf('handleQuickAddEvent(event)') + 1200);
  assert.match(fn, /if \(start && !end\)/, 'a missing end must be defaulted, not passed through');
  assert.match(fn, /3600000/, 'default the end to one hour after the start');
});

test('dropped events are surfaced to the user, not only the console', () => {
  const svc = fs.readFileSync(
    path.join(__dirname, '../../public/services/CalendarDataService.js'), 'utf8');
  assert.match(svc, /onIncompleteEvents/,
    '_dropIncompleteEvents must be able to tell the app what it dropped');
  assert.match(APP, /CalendarDataService\.onIncompleteEvents\s*=/,
    'the app must register a handler so the drop reaches the user');
});
