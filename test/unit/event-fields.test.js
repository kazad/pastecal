/**
 * ROOT 3 guard: one list of event fields (EventStore.RECORD / FIELDS), and every path that creates, copies, compares
 * or merges events carries every field of it.
 *
 * Why: the fields were once named by hand in each path. Adding the time zone (tz, Oct 2026) meant finding eight such
 * lists, and the Option-drag copy was missed: the copy of a Tokyo event lost its zone (stress S03). Here a FULL event
 * (every field set) goes through each path, and each field must survive (or, for a copy, be one it deliberately
 * resets). SAMPLE must name every field: a field added to EventStore.RECORD without a sample fails the first test,
 * and a field added WITH one fails every path that does not carry it. The last test adds a field to a fresh copy of the
 * list and shows it flows through the paths with no other change.
 *
 * The browser paths (Duplicate, Option-drag copy, the card) are checked in cloudflare/test/root-data.spec.js.
 * Run: node --test test/unit/event-fields.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '../../public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

/** The page's scripts in one context: Event, EventStore, ScheduleAdapter, CalendarDataService (as index.html loads them). */
function page() {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Date, JSON, Math, Intl, setTimeout, clearTimeout });
  vm.runInContext(`var firebase = { database: () => ({ ref: () => ({}) }) };
    var Utils = { debounce: (f) => f, uuidv4: () => 'generated-uuid' };`, ctx);
  vm.runInContext(read('models/Event.js') + ';this.Event = Event;', ctx);
  vm.runInContext(read('services/EventStore.js'), ctx);
  vm.runInContext(read('services/ScheduleAdapter.js'), ctx);
  vm.runInContext(read('services/CalendarDataService.js') + ';this.CalendarDataService = CalendarDataService;', ctx);
  return ctx;
}
const P = page();
const { EventStore, ScheduleAdapter, CalendarDataService, Event } = P;

// A value for every field, unlike its default. A timed event (all-day dates have their own display mapping, checked in
// all-day-timezone.test.js).
const SAMPLE = {
  title: 'Tokyo standup',
  description: 'Bring the <b>notes</b> & "agenda"',
  start: '2026-10-27T01:00:00.000Z',
  end: '2026-10-27T01:30:00.000Z',
  type: 4,
  isAllDay: false,
  repeat: 'Weekly',
  recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;',
  recurrenceID: 'series-1',
  recurrenceException: '20261103T010000Z',
  tz: 'Asia/Tokyo',
};
// A different value for each field (what "someone changed it" looks like).
const OTHER = {
  title: 'Renamed', description: 'other notes', start: '2026-10-27T00:30:00.000Z', end: '2026-10-27T03:00:00.000Z', type: 6,
  isAllDay: true, repeat: 'Daily', recurrencerule: 'FREQ=DAILY;INTERVAL=1;', recurrenceID: 'series-2',
  recurrenceException: '20261110T010000Z', tz: 'Europe/London',
};
const full = (extra = {}) => ({ id: 'e1', ...SAMPLE, ...extra });
const FIELDS = [...EventStore.FIELDS];
const same = (f, a, b) => (f === 'start' || f === 'end') ? new Date(a).getTime() === new Date(b).getTime() : a === b;
const lost = (row, base = SAMPLE, fields = FIELDS) => fields.filter((f) => !same(f, row[f], base[f]));

test('the one list: every field has a sample here, and a record name; nothing else names fields', () => {
  assert.deepEqual(FIELDS, Object.keys(EventStore.RECORD), 'FIELDS is the record map\'s keys');
  for (const f of FIELDS) {
    assert.ok(f in SAMPLE, `EventStore.FIELDS has "${f}" but this test has no sample for it: add one, then make every path below carry it`);
    assert.ok(f in OTHER, `no OTHER value for "${f}"`);
  }
  for (const f of Object.keys(SAMPLE)) assert.ok(FIELDS.includes(f), `sample "${f}" is not in EventStore.FIELDS`);
  // The places that used to keep their own copy of the list now read this one.
  const src = (f) => read(f);
  for (const f of ['services/CalendarDataService.js', 'services/ScheduleAdapter.js', 'app.js', '../cloudflare/src/CalendarRoom.js']) {
    assert.ok(!/\['title', 'description', 'start', 'end'/.test(src(f)), `${f} lists the event fields by hand again`);
  }
});

test('normalize (the schema every save goes through) keeps every field', () => {
  assert.deepEqual(lost(EventStore.normalize(full())), []);
  // ...under the record names too (an old grid row).
  const rec = { Id: 'e1' };
  for (const f of FIELDS) rec[EventStore.RECORD[f]] = SAMPLE[f];
  assert.deepEqual(lost(EventStore.normalize(rec)), []);
});

test('ScheduleAdapter: an event shown on the grid and read back keeps every field', () => {
  const rec = ScheduleAdapter.toView([full()])[0];
  for (const f of FIELDS) assert.ok(EventStore.RECORD[f] in rec, `toView drops ${f}`);
  assert.deepEqual(lost(ScheduleAdapter.fromRecord(rec)), []);
});

test('Event model: built from a stored row and from a grid record, it keeps every field', () => {
  assert.deepEqual(lost(new Event(full())), []);
  const rec = ScheduleAdapter.toView([full()])[0];
  assert.deepEqual(lost(new Event(rec)), []);
});

test('the store: add keeps every field; an update of any one field changes only that field', () => {
  let list = EventStore.apply([], { type: 'add', event: full() }).events;
  assert.deepEqual(lost(list[0]), []);
  for (const f of FIELDS) {
    if (f === 'recurrenceID') continue;   // identity: an update never changes which row it is
    const r = EventStore.apply(list, { type: 'update', key: list[0], changes: { [f]: OTHER[f] } });
    const row = r.events[0];
    assert.ok(same(f, row[f], OTHER[f]) || (f === 'isAllDay' && row[f] === true), `update of ${f} did not land`);
    assert.deepEqual(lost(row, SAMPLE, FIELDS.filter((x) => x !== f)), [], `update of ${f} touched other fields`);
  }
});

test('comparisons: changing any one field is noticed by every "same event?" check', () => {
  const a = full();
  for (const f of FIELDS) {
    const b = { ...a, [f]: OTHER[f] };
    assert.equal(EventStore.same(a, b), false, `EventStore.same misses ${f}`);
    assert.equal(CalendarDataService._sameEvent(a, b), false, `CalendarDataService._sameEvent misses ${f}`);
    const stamp = CalendarDataService._lastEditedAt({ events: [a], lastEditedAt: 1 }, { events: [b] }, 2);
    assert.equal(stamp, 2, `_lastEditedAt misses a change to ${f}`);
    assert.ok(f in EventStore.diff(EventStore.normalize(a), EventStore.normalize(b)), `EventStore.diff misses ${f}`);
  }
  assert.equal(EventStore.same(a, { ...a }), true);
  // The same meaning in another spelling is not a change.
  assert.equal(EventStore.same(a, { ...a, start: new Date(a.start).getTime(), type: String(a.type) }), true);
});

test('copy (Duplicate, Option-drag): every field is copied, or is one a copy resets on purpose', () => {
  const c = EventStore.copy(full());
  assert.equal(c.id, null, 'a copy has no id (the store gives it one)');
  for (const f of FIELDS) {
    if (f in EventStore.COPY_RESETS) assert.equal(c[f], EventStore.COPY_RESETS[f], `copy keeps ${f}, which it should reset`);
    else assert.ok(same(f, c[f], SAMPLE[f]), `copy drops ${f}`);
  }
  // The copy as a new event's grid record (app.js nativeCopyRecord) and back keeps them too.
  const back = ScheduleAdapter.fromRecord(ScheduleAdapter.toView([c])[0]);
  for (const f of FIELDS) if (!(f in EventStore.COPY_RESETS)) assert.ok(same(f, back[f], SAMPLE[f]), `copy record drops ${f}`);
});

test('merges: my change to any one field and someone else\'s change to another both survive', () => {
  for (const mine of FIELDS) {
    if (mine === 'recurrenceID') continue;
    const theirs = mine === 'title' ? 'description' : 'title';
    const base = full(), local = { ...base, [mine]: OTHER[mine] }, remote = { ...base, [theirs]: OTHER[theirs] };
    const merged = CalendarDataService._mergeEvents([base], [local], [remote])[0];
    assert.ok(same(mine, merged[mine], OTHER[mine]), `_mergeEvents loses my ${mine}`);
    assert.equal(merged[theirs], OTHER[theirs], `_mergeEvents puts back their ${theirs} while merging my ${mine}`);
  }
});

test('a field added to the list flows through every path with no other change', () => {
  const X = page();   // a fresh copy of the page's scripts
  X.EventStore.RECORD.location = 'Location';
  X.EventStore.FIELDS.push('location');
  const e = { ...full(), location: 'Lincoln Field' };
  assert.equal(X.EventStore.normalize(e).location, 'Lincoln Field', 'normalize');
  const rec = X.ScheduleAdapter.toView([e])[0];
  assert.equal(rec.Location, 'Lincoln Field', 'toView');
  assert.equal(X.ScheduleAdapter.fromRecord(rec).location, 'Lincoln Field', 'fromRecord');
  assert.equal(new X.Event(e).location, 'Lincoln Field', 'Event');
  assert.equal(new X.Event(rec).location, 'Lincoln Field', 'Event from a record');
  assert.equal(X.EventStore.copy(e).location, 'Lincoln Field', 'copy');
  assert.equal(X.EventStore.same(e, { ...e, location: 'Gym' }), false, 'same');
  assert.equal(X.CalendarDataService._sameEvent(e, { ...e, location: 'Gym' }), false, '_sameEvent');
  const merged = X.CalendarDataService._mergeEvents([e], [{ ...e, location: 'Gym' }], [{ ...e, title: 'Theirs' }])[0];
  assert.deepEqual([merged.location, merged.title], ['Gym', 'Theirs'], '_mergeEvents');
});
