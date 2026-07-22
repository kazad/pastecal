/**
 * Unit tests for Calendar.getSyncFusionEvents() (public/models/Calendar.js).
 *
 * nativecal (public/nativecal/components/EventEditor.js) stores event.start/end as raw
 * epoch-millisecond numbers. The legacy Syncfusion app's Event model
 * (public/models/Event.js) stores them as ISO strings. getSyncFusionEvents() must
 * normalize either representation into a real Date object -- Syncfusion's
 * StartTime/EndTime fields silently fail to render when handed a raw number or a string
 * instead of a Date, so a calendar created in nativecal appeared empty when opened via
 * the legacy app's bare /{slug} URL even though the event data was intact in Firebase.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadCalendarClass() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../public/models/Calendar.js'), 'utf8');
  const factory = new Function('Event', `${src}; return Calendar;`);
  // Calendar.defaultEvent() constructs an Event; not exercised by these tests, so a
  // minimal stub is enough.
  return factory(class Event {});
}

const Calendar = loadCalendarClass();

const START_MS = 1783148400000;
const END_MS = 1783234799999;
const START_ISO = '2026-07-02T15:00:00.000Z';
const END_ISO = '2026-07-03T14:59:59.999Z';

test('getSyncFusionEvents: numeric epoch start/end (nativecal shape) become Date objects', () => {
  const cal = new Calendar('slug', 'Title', [
    { id: '1', title: 'Team Standup', start: START_MS, end: END_MS, type: 1 },
  ]);

  const [sfEvent] = cal.getSyncFusionEvents();

  assert.ok(sfEvent.StartTime instanceof Date, 'StartTime must be a Date instance');
  assert.ok(sfEvent.EndTime instanceof Date, 'EndTime must be a Date instance');
  assert.equal(sfEvent.StartTime.getTime(), START_MS);
  assert.equal(sfEvent.EndTime.getTime(), END_MS);
});

test('getSyncFusionEvents: ISO string start/end (legacy shape) become Date objects', () => {
  const cal = new Calendar('slug', 'Title', [
    { id: '1', title: 'Legacy Event', start: START_ISO, end: END_ISO, type: 1 },
  ]);

  const [sfEvent] = cal.getSyncFusionEvents();

  assert.ok(sfEvent.StartTime instanceof Date, 'StartTime must be a Date instance');
  assert.ok(sfEvent.EndTime instanceof Date, 'EndTime must be a Date instance');
  assert.equal(sfEvent.StartTime.toISOString(), START_ISO);
  assert.equal(sfEvent.EndTime.toISOString(), END_ISO);
});

test('getSyncFusionEvents: missing/invalid start or end becomes null rather than an Invalid Date', () => {
  const cal = new Calendar('slug', 'Title', [
    { id: '1', title: 'No dates', start: null, end: undefined, type: 1 },
    { id: '2', title: 'Garbage', start: 'not-a-date', end: 'also-not-a-date', type: 1 },
  ]);

  const [noDates, garbage] = cal.getSyncFusionEvents();

  assert.equal(noDates.StartTime, null);
  assert.equal(noDates.EndTime, null);
  assert.equal(garbage.StartTime, null);
  assert.equal(garbage.EndTime, null);
});
