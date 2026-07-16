/**
 * Unit tests for the Event model's date handling (public/models/Event.js).
 *
 * Root-cause layer for the "Server error generating ICS" incident. The ICS fix
 * (test/unit/ics.test.js) stops a malformed event from crashing the feed; these tests
 * cover the layer that lets malformed events exist in the first place:
 *
 *   1. `new Event({StartTime})` with a missing/invalid EndTime throws RangeError, because
 *      `new Date(undefined).toISOString()` throws before the `|| null` fallback can run.
 *      That `|| null` is dead code.
 *   2. Event.isComplete() lets the write path reject dateless events instead of silently
 *      persisting `start: null` — the shape that produced the live 500s.
 *
 * A dateless Event is a LEGITIMATE intermediate state (Calendar.defaultEvent() builds one,
 * then assigns dates), so the constructor must NOT throw. The gate belongs at the write
 * boundary. These tests lock in that split.
 *
 * Run: npm run test:unit   (node 20/22 — see test/README.md)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Event.js is a browser script (no module exports) and depends on a global Utils.
// Load it into a function scope and hand back the class, mirroring how the browser sees it.
function loadEventClass() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../public/models/Event.js'), 'utf8');
  const factory = new Function('Utils', `${src}; return Event;`);
  return factory({ uuidv4: () => 'generated-uuid' });
}

const Event = loadEventClass();

const ISO_START = '2026-05-27T10:00:00.000Z';
const ISO_END = '2026-05-27T13:00:00.000Z';

// --- Constructor must not throw on partial Syncfusion input (bug 1) -----------------------

test('Event: StartTime without EndTime does not throw', () => {
  // Was: RangeError: Invalid time value. new Date(undefined).toISOString() throws,
  // so the `|| null` fallback never got a chance to run.
  let e;
  assert.doesNotThrow(() => { e = new Event({ Subject: 'X', StartTime: ISO_START }); });
  assert.equal(e.start, ISO_START);
  assert.equal(e.end, null, 'a missing EndTime must degrade to null, not explode');
});

test('Event: invalid date strings degrade to null rather than throwing', () => {
  for (const bad of ['garbage', '', 'not-a-date', '2026-13-45T99:99:99Z']) {
    let e;
    assert.doesNotThrow(
      () => { e = new Event({ Subject: 'X', StartTime: bad, EndTime: bad }); },
      `StartTime=${JSON.stringify(bad)} must not throw`);
    assert.equal(e.start, null, `start for ${JSON.stringify(bad)}`);
    assert.equal(e.end, null, `end for ${JSON.stringify(bad)}`);
  }
});

test('Event: a valid Syncfusion pair still round-trips unchanged', () => {
  const e = new Event({
    Subject: 'Verkehr', StartTime: ISO_START, EndTime: ISO_END, Type: 1,
  });

  assert.equal(e.start, ISO_START);
  assert.equal(e.end, ISO_END);
  assert.equal(e.title, 'Verkehr');
});

test('Event: Date objects (what Syncfusion actually emits) still work', () => {
  const e = new Event({
    Subject: 'X', StartTime: new Date(ISO_START), EndTime: new Date(ISO_END),
  });

  assert.equal(e.start, ISO_START);
  assert.equal(e.end, ISO_END);
});

// --- Dateless events stay constructible (must not regress) --------------------------------

test('Event: a dateless event is still constructible', () => {
  // Calendar.defaultEvent() relies on this: build, then assign start/end.
  // Tightening the constructor here would break event creation in the UI.
  const e = new Event({ title: 'Öffentlichkeitsreferat' });

  assert.equal(e.start, null);
  assert.equal(e.end, null);
  assert.equal(e.title, 'Öffentlichkeitsreferat');
});

test('Event: no field is ever undefined after construction', () => {
  // Firebase rejects undefined outright; the constructor nulls them. Guards the
  // existing e2e expectation (all-day-events.spec.js) at the unit level.
  for (const opts of [{}, { isAllDay: true }, { Subject: 'X', StartTime: ISO_START }]) {
    const e = new Event(opts);
    const undef = Object.entries(e).filter(([, v]) => v === undefined).map(([k]) => k);
    assert.deepEqual(undef, [], `undefined fields for ${JSON.stringify(opts)}`);
  }
});

// --- isComplete(): the write-boundary gate (bug 2) ----------------------------------------

test('Event.isComplete: rejects exactly the shapes that broke the ICS feed', () => {
  const incomplete = [
    ['no dates at all', new Event({ title: 'X' })],
    ['start only', new Event({ title: 'X', start: ISO_START })],
    ['end only', new Event({ title: 'X', end: ISO_END })],
  ];
  for (const [label, e] of incomplete) {
    assert.equal(e.isComplete(), false, label);
  }
});

test('Event.isComplete: accepts a well-formed event', () => {
  const e = new Event({ title: 'Verkehr', start: ISO_START, end: ISO_END });

  assert.equal(e.isComplete(), true);
});

test('Event.isComplete: rejects the exact live bad record', () => {
  // Verbatim from /calendars_readonly/bht-asta-sprechzeiten/events[26] — the record
  // that returned 500 for the whole feed.
  const e = new Event({
    description: '',
    id: 'af5ca747-cd58-425d-b10d-1aba274440a6',
    isAllDay: false,
    recurrencerule: '',
    repeat: '',
    title: 'Öffentlichkeitsreferat',
    type: 1,
  });

  assert.equal(e.isComplete(), false, 'this record must never be writable again');
});

test('Event.isComplete: rejects null, empty-string, and whitespace dates', () => {
  // The sanitizer turns undefined into null, so null is the shape that actually lands
  // in Firebase. Empty string is what an emptied form field yields.
  for (const bad of [null, '', '   ']) {
    const e = new Event({ title: 'X' });
    e.start = bad;
    e.end = ISO_END;
    assert.equal(e.isComplete(), false, `start=${JSON.stringify(bad)}`);
  }
});

test('Event.isComplete: rejects unparseable date values', () => {
  const e = new Event({ title: 'X' });
  e.start = 'garbage';
  e.end = ISO_END;

  assert.equal(e.isComplete(), false, 'a non-date string is not a usable start');
});

test('Event.isComplete: works on plain objects read back from Firebase', () => {
  // Events arrive from the DB as plain objects, not Event instances. The static form
  // is what the write path can actually call on arbitrary data.
  assert.equal(Event.isComplete({ start: ISO_START, end: ISO_END }), true);
  assert.equal(Event.isComplete({ start: null, end: ISO_END }), false);
  assert.equal(Event.isComplete({}), false);
  assert.equal(Event.isComplete(null), false);
  assert.equal(Event.isComplete(undefined), false);
});
