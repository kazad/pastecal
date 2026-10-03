/**
 * The behavior both UIs now share (services/EventSearch.js, services/LocalDraft.js, the
 * occurrence helpers and Quick Add builder in models/Event.js) and the main app's wiring
 * of it, run on the real code.
 *
 *   - search threw on an untitled event, ignored notes, and listed a weekly series at the
 *     date it started (and jumped there);
 *   - events added on an unclaimed /slug vanished on reload;
 *   - nativecal deleted a whole series from one occurrence's trash; one occurrence is now
 *     an exception date, written the way Syncfusion and the ICS feed read it;
 *   - Quick Add's Create button went grey with no reason, and "for 2 hours" ignored a
 *     start the user had set by hand;
 *   - the filter switches named types differently from Settings;
 *   - Recent changes offered "Undo this edit" on an edit already undone.
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadDataService } = require('./helpers/data-service-harness');
const { appMethod } = require('./helpers/app-method');

process.env.TZ = 'America/Los_Angeles';
const PUBLIC = path.join(__dirname, '../../public');

const { ctx } = loadDataService();
for (const f of ['UndoService', 'EventSearch', 'LocalDraft']) {
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, `services/${f}.js`), 'utf8') + `;this.${f} = ${f};`, ctx);
}
const { Event, EventSearch, LocalDraft, CalDate, UndoService } = ctx;
// Arrays made inside the sandbox are another realm's; compare them as plain data.
const ids = (results) => JSON.parse(JSON.stringify(results.map(r => r.event.id)));

// --- EventSearch ---------------------------------------------------------------------------

test('search: an untitled event does not break it, and notes are searched', () => {
  const events = [
    { id: 'u', start: '2026-10-06T14:00:00.000Z', end: '2026-10-06T15:00:00.000Z' },   // no title at all
    { id: 'a', title: 'Alpha', description: 'bring insurance card', start: '2026-10-05T14:00:00.000Z', end: '2026-10-05T15:00:00.000Z' },
  ];
  const now = Date.parse('2026-10-03T00:00:00Z');
  assert.deepEqual(ids(EventSearch.search(events, 'insurance', { now })), ['a']);
  assert.deepEqual(ids(EventSearch.search(events, 'untitled', { now })), ['u']);
  assert.equal(EventSearch.search(events, 'zzz', { now }).length, 0);
});

test('search: a series is listed at its next occurrence, upcoming before past', () => {
  const series = { id: 's', title: 'Standup', start: '2025-01-06T17:00:00.000Z', end: '2025-01-06T17:30:00.000Z',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=MO' };
  const old = { id: 'o', title: 'Standup notes', start: '2026-01-01T17:00:00.000Z', end: '2026-01-01T18:00:00.000Z' };
  const now = Date.parse('2026-10-03T12:00:00Z');
  const next = Date.parse('2026-10-05T16:00:00Z');
  const results = EventSearch.search([old, series], 'standup', {
    now, occurrenceAfter: (e, ms) => (ms === now ? { start: next, end: next + 1800000 } : null),
  });
  assert.deepEqual(ids(results), ['s', 'o']);
  assert.equal(results[0].start, next);
  assert.equal(results[0].recurring, true);
  assert.match(EventSearch.describe(results[0]), /2026/, 'the year is always shown');
});

test('search: a filter-hidden event is marked, and jumping to it shows its type again', () => {
  const e = { id: 'b', title: 'Book club', type: 3, start: '2026-10-09T23:00:00.000Z', end: '2026-10-10T00:00:00.000Z' };
  const [r] = EventSearch.search([e], 'book', { now: 0, isVisible: () => false });
  assert.equal(r.hidden, true);
  const jump = appMethod('jumpToEvent', { Event, scheduleObj: {} });
  const toasts = [];
  const app = { colorFilters: [true, true, false], isEventVisible: () => false, filterSlotFor: () => 2,
    typeName: (i) => `Type ${i + 1}`, showToast: (m) => toasts.push(m) };
  const sched = {};
  appMethod('jumpToEvent', { Event, scheduleObj: sched }).call(app, r);
  assert.equal(app.colorFilters[2], true);
  assert.equal(sched.selectedDate.getTime(), r.start);
  assert.deepEqual(toasts, ['Showing Type 3 again']);
  assert.ok(jump);
});

// --- LocalDraft ----------------------------------------------------------------------------

test('draft: an unclaimed slug keeps its events and gets them back', () => {
  const store = new Map();
  ctx.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k) };
  const cal = { title: 'New Calendar', options: {}, events: [] };
  LocalDraft.save('My-Cal', cal);
  assert.equal(store.size, 0, 'nothing to keep');
  cal.events = [{ id: 'd', title: 'Dentist', start: '2026-10-04T22:00:00.000Z', end: '2026-10-04T23:00:00.000Z' }];
  LocalDraft.save('My-Cal', cal);
  assert.ok(store.has('pastecal_draft_my-cal'));

  const fresh = { title: 'New Calendar', options: {}, events: [], setEvents(list) { this.events = list; } };
  assert.equal(LocalDraft.restoreInto('my-cal', fresh), 1);
  assert.equal(fresh.events[0].title, 'Dentist');

  // Claimed by someone else first: the draft is not silently thrown away.
  LocalDraft.settle('my-cal', [{ id: 'other' }]);
  assert.ok(store.has('pastecal_draft_my-cal'));
  LocalDraft.settle('my-cal', [{ id: 'd' }]);
  assert.equal(store.has('pastecal_draft_my-cal'), false);

  store.set('pastecal_draft_bad', '{nope');
  assert.equal(LocalDraft.load('bad'), null, 'a corrupt draft is ignored, never thrown');
});

// --- One occurrence of a series --------------------------------------------------------------

test('occurrence: hiding one is an exception stamp the grid and feed read', () => {
  const timed = { id: 's', title: 'S', start: '2026-09-07T16:00:00.000Z', end: '2026-09-07T16:30:00.000Z',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=MO' };
  const hidden = Event.withoutOccurrence(timed, Date.parse('2026-10-12T16:00:00Z'));
  assert.equal(hidden.recurrenceException, '20261012T160000Z');
  assert.equal(Event.withoutOccurrence(hidden, Date.parse('2026-10-12T16:00:00Z')).recurrenceException,
    '20261012T160000Z', 'not added twice');

  const allDay = new Event({ title: 'A', isAllDay: true, start: new Date(2026, 8, 7).toISOString(),
    end: new Date(2026, 8, 8).toISOString(), recurrencerule: 'FREQ=WEEKLY;BYDAY=MO' });
  assert.equal(Event.withoutOccurrence(allDay, new Date(2026, 9, 12).getTime()).recurrenceException, '20261012T000000');
});

test('occurrence: "this and following" ends the series the day before', () => {
  const s = { id: 's', title: 'S', start: '2026-09-07T16:00:00.000Z', end: '2026-09-07T16:30:00.000Z',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=20' };
  const ended = Event.endSeriesBefore(s, Date.parse('2026-10-12T16:00:00Z'));
  assert.equal(ended.recurrencerule, `FREQ=WEEKLY;BYDAY=MO;UNTIL=${Event.ruleUntilStamp('2026-10-11', false)}`);
  assert.equal(Event.endSeriesBefore(s, Date.parse('2026-09-07T16:00:00Z')), null, 'the first one is the whole series');
});

// --- Quick Add -------------------------------------------------------------------------------

test('quick add: the shared builder keeps a repeat and defaults the end and title', () => {
  const e = Event.fromQuickAdd({ subject: '', startDateTime: '2026-10-05T16:00:00.000Z', endDateTime: null,
    recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=1;' });
  assert.equal(e.title, 'Untitled event');
  assert.equal(e.end, '2026-10-05T17:00:00.000Z');
  assert.equal(e.recurrencerule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=1');
});

function mountDialog(parse) {
  const src = fs.readFileSync(path.join(PUBLIC, 'components/QuickAddDialog.js'), 'utf8');
  const def = new Function('Utils', `${src}; return QuickAddDialog;`)({
    parseHumanWrittenCalendar: parse, describeRecurrence: (r) => (r ? 'every weekday' : ''),
  });
  const vm2 = { canEdit: true, emitted: [] };
  Object.assign(vm2, def.data.call(vm2));
  for (const [name, get] of Object.entries(def.computed)) Object.defineProperty(vm2, name, { get: get.bind(vm2) });
  for (const [name, fn] of Object.entries(def.methods)) vm2[name] = fn.bind(vm2);
  vm2.$el = { querySelector: () => null };
  vm2.$nextTick = () => {};
  vm2.$emit = (n, p) => vm2.emitted.push([n, p]);
  return vm2;
}

test('quick add dialog: says why Create is disabled', () => {
  const d = mountDialog(() => ({ subject: 'hello world', startDateTime: null, endDateTime: null, reason: 'no-date' }));
  d.description = 'hello world';
  d.parseDescription();
  assert.equal(d.isValidEvent, false);
  assert.match(d.disabledReason, /Couldn't find a date/);
});

test('quick add dialog: "for 2 hours" goes on a start the user set by hand', () => {
  const d = mountDialog(() => ({ subject: 'call', startDateTime: null, endDateTime: null, durationMs: 7200000 }));
  d.description = 'call';
  d.editStart('Date', '2026-10-05');
  d.editStart('Time', '14:00');
  d.description = 'call for 2 hours';
  d.parseDescription();
  assert.equal(d.fields.endTime, '16:00');
  assert.equal(d.fields.endDate, '2026-10-05');
});

test('quick add dialog: a repeat is shown, emitted, and can be cleared', () => {
  const rule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=1';
  const d = mountDialog(() => ({ subject: 'standup', startDateTime: '2026-10-05T16:00:00.000Z',
    endDateTime: '2026-10-05T17:00:00.000Z', recurrenceRule: rule }));
  d.description = 'standup every weekday 9am';
  d.parseDescription();
  assert.equal(d.repeatLabel, 'every weekday');
  d.createEvent();
  assert.equal(d.emitted[0][1].recurrenceRule, rule);
  d.description = 'standup every weekday 9am';
  d.parseDescription();
  d.clearRepeat();
  d.parseDescription();
  assert.equal(d.recurrenceRule, '', 'a cleared repeat stays cleared while typing');
});

// --- Main app wiring --------------------------------------------------------------------------

test('filter switches use the type names Settings shows', () => {
  const app = { calendar: { options: { typeLabels: ['Work', 'Type 2'] } }, COLORS: ['#3f51b5', '#e3165b'] };
  app.typeName = appMethod('typeName').bind(app);
  app.colorNameFor = appMethod('colorNameFor').bind(app);
  const label = appMethod('typeLabelFor').bind(app);
  const types = appMethod('getTypes').bind(app)();
  assert.equal(label(0), 'Work');
  assert.equal(types[0].text, 'Work');
  assert.match(label(1), /^Type 2 \(\w+\)$/, 'a default name still says which dot');
  assert.equal(types[1].text, 'Type 2');
});

test('Recent changes does not offer to undo an edit already undone', () => {
  const isUndone = appMethod('isUndoneEntry');
  const app = { _undoneHistoryKeys: new Set(['k1']), planUndo: () => ({ noop: false, skipped: [] }) };
  assert.equal(isUndone.call(app, { canRestore: true, parts: [{ key: 'k1' }] }), true);
  assert.equal(isUndone.call(app, { canRestore: true, parts: [{ key: 'k2', reversed: true }] }), true);
  assert.equal(isUndone.call(app, { canRestore: true, parts: [{ key: 'k3' }] }), false);
  const noop = { _undoneHistoryKeys: new Set(), planUndo: () => ({ noop: true, skipped: [] }) };
  assert.equal(isUndone.call(noop, { canRestore: true, parts: [{ key: 'k4' }] }), true, 'already as it was');
  assert.ok(UndoService && CalDate);
});
