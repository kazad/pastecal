/**
 * Tests for the per-browser writer id and the nativecal delete path.
 *
 *   - every calendar write carries top-level `_writer`, which the history trigger copies
 *     onto the entry; Recent changes only collapses one writer's entries, and the Cmd+Z
 *     /history fallback only undoes this browser's own
 *   - `_writer` never reaches calendar state, and a write that changes nothing keeps the
 *     previous writer (nativecal echoes every snapshot back through sync)
 *   - nativecal deletes never declared themselves, so the write gate refused every one and
 *     the next edit re-saved the deleted row
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadDataService, ev, clone, PUBLIC } = require('./helpers/data-service-harness');

const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const NATIVE = fs.readFileSync(path.join(PUBLIC, 'nativecal/app.js'), 'utf8');
const ids = (list) => list.map(e => e.id).sort();
const serverIds = (server, id) => ids(Object.values(server[id].events));

function blockAt(src, from) {
  const open = src.indexOf('{', from);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, i + 1);
}

// Source of a Vue method (`        [async ]name(args) { ... }`).
function method(src, name) {
  const m = new RegExp(`\\n {8}(async )?${name}\\(`).exec(src);
  assert.ok(m, `${name} not found — renamed?`);
  const start = m.index + 1;
  return src.slice(start, src.indexOf('{', src.indexOf(')', start))) +
    blockAt(src, src.indexOf('{', src.indexOf(')', start)));
}

// --- Writer id on the write path --------------------------------------------------------

test('every sync stamps this browser\'s writer id, persisted across loads', () => {
  const store = {};
  const fakeStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };

  const a = loadDataService();
  a.ctx.localStorage = fakeStorage;
  a.server.c = { id: 'c', events: [ev('A', 'A')] };
  a.deliver('c');
  a.S.sync({ id: 'c', events: [ev('A', 'A2')] });
  const id = a.S.writerId;
  assert.match(id, /^w[0-9a-z]+$/);
  assert.equal(a.server.c._writer, id, 'the write carries the id the history trigger reads');

  const b = loadDataService();
  b.ctx.localStorage = fakeStorage;
  assert.equal(b.S.writerId, id, 'a reload in the same browser is the same writer');
});

test('blocked storage falls back to an in-memory id', () => {
  const { S, ctx } = loadDataService();
  ctx.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const id = S.writerId;
  assert.ok(id);
  assert.equal(S.writerId, id, 'stable for the life of the page');
});

test('a write that changes nothing keeps the previous writer', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', title: 'T', _writer: 'other', events: [ev('A', 'A')] };
  deliver('c');

  // nativecal's watcher echoes an imported snapshot straight back.
  S.sync({ id: 'c', title: 'T', events: clone(server.c.events) });
  assert.equal(server.c._writer, 'other', 'an echo is not attributed to this browser');

  S.sync({ id: 'c', title: 'T', events: [ev('A', 'A2')] });
  assert.equal(server.c._writer, S.writerId, 'a real edit is');
});

test('a calendar carrying someone else\'s _writer still writes ours', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', _writer: 'other', events: [ev('A', 'A')] };
  deliver('c');
  S.sync({ id: 'c', _writer: 'other', events: [ev('A', 'A2')] });
  assert.equal(server.c._writer, S.writerId);
});

test('snapshots reach the app without _writer', () => {
  const { S, ctx } = loadDataService();
  ctx.SlugManager = { autoCreateReadOnlyLink() {} };
  const node = { id: 'c', title: 'T', _writer: 'other', events: [ev('A', 'A')] };
  const fakeRef = { child: () => ({ on: (_, cb) => cb({ val: () => clone(node) }) }) };
  S.db = fakeRef;
  S.db_readonly = fakeRef;

  const got = [];
  S._subscribeExact('c', (c) => got.push(c));
  S.subscribe_readonly('c', (c) => got.push(c));
  S.subscribe('c', (c) => got.push(c));
  assert.equal(got.length, 3);
  for (const c of got) {
    assert.equal('_writer' in c, false, 'import() would copy it onto the calendar');
    assert.equal(c.title, 'T');
  }
});

test('applyRemoteCalendar drops _writer before import', () => {
  const m = /\n\s*applyRemoteCalendar\(([^)]*\}[^)]*|[^)]*)\)\s*\{/.exec(APP);
  assert.ok(m);
  assert.match(blockAt(APP, m.index + m[0].length - 1), /CalendarDataService\._withoutMeta\(c\)/);
});

// --- Recent changes: collapse one writer's burst only -------------------------------------

function loadAppMethods(names, extra = {}) {
  const ctx = { console, JSON, Date, Map, Set, Math, Object, Array, String, Promise, ...extra };
  vm.createContext(ctx);
  vm.runInContext(`this.app = {\n${names.map(n => method(APP, n)).join(',\n')}\n}`, ctx);
  return ctx.app;
}

const edit = (key, savedAt, writer) => ({
  key, savedAt, writer, keys: ['A|'], lost: [], added: [],
  edited: [{ title: 'A', change: 'moved' }], what: 'Edited "A"',
  parts: [{ key, savedAt, writer, keys: ['A|'], delta: {} }],
});

test('collapsing never merges different writers, and null is a writer of its own', () => {
  const app = loadAppMethods(['collapseSessions', 'describeSession']);
  const rows = app.collapseSessions([
    edit('h5', 5000, 'me'),
    edit('h4', 4000, 'them'),
    edit('h3', 3000, 'them'),
    edit('h2', 2000, null),
    edit('h1', 1000, null),
    edit('h0', 500, 'me'),
  ]);
  assert.deepEqual(clone(rows.map(r => r.parts.map(p => p.key))),
    [['h5'], ['h4', 'h3'], ['h2', 'h1'], ['h0']]);
  for (const r of rows) {
    assert.equal(new Set(r.parts.map(p => p.writer)).size, 1,
      'undoing a row only reverses one writer\'s entries');
  }
});

// --- Cmd+Z /history fallback: only this browser's entries ---------------------------------

function loadUndo(rows) {
  const app = loadAppMethods(['undoLastChange'], { CalendarDataService: { writerId: 'me' } });
  Object.assign(app, {
    _undoBusy: false, _sessionUndo: [], isExisting: true, _undoneHistoryKeys: new Set(),
    committed: [], toasts: [],
    loadUndoEntries: async () => rows,
    isHandledHistory: () => false,
    planUndo: (deltas) => ({ noop: false, deltas }),
    commitUndo(plan) { this.committed.push(plan); },
    describeUndo: () => 'undone',
    showToast(msg) { this.toasts.push(msg); },
  });
  return app;
}

test('Cmd+Z skips a collaborator\'s and legacy entries for this browser\'s own', async () => {
  const row = (key, writer) => ({ parts: [{ key, writer, delta: key }] });
  const app = loadUndo([row('theirs', 'them'), row('legacy', null), row('mine', 'me')]);
  await app.undoLastChange();
  assert.equal(app.committed.length, 1);
  assert.deepEqual([...app.committed[0].deltas], ['mine']);
  assert.ok(app._undoneHistoryKeys.has('mine'));
});

test('Cmd+Z with only others\' entries undoes nothing', async () => {
  const app = loadUndo([{ parts: [{ key: 't', writer: 'them', delta: 't' }] },
    { parts: [{ key: 'l', writer: null, delta: 'l' }] }]);
  await app.undoLastChange();
  assert.equal(app.committed.length, 0);
  assert.deepEqual(app.toasts, ['Nothing to undo']);
});

// --- nativecal: deletes declare themselves; refusals recover --------------------------------

function wireNative(S, calendarId, events) {
  const vmApp = {
    calendar: {
      id: calendarId,
      events: clone(events),
      setEvents(list) { this.events = list; S.sync(this); },
      import(c) { Object.assign(this, c); },
    },
    toasts: [],
    showToast(msg) { this.toasts.push(msg); },
    closePopover() {}, closeEditor() {},
  };
  // eslint-disable-next-line no-new-func
  vmApp.handleDeleteEvent = new Function('CalendarDataService',
    `return { ${method(NATIVE, 'handleDeleteEvent')} }.handleDeleteEvent;`)(S).bind(vmApp);

  const at = NATIVE.indexOf('CalendarDataService.onSyncRefused =');
  assert.ok(at !== -1, 'nativecal sets no onSyncRefused');
  const arrowStart = NATIVE.indexOf('(', at);
  const arrow = NATIVE.slice(arrowStart, NATIVE.indexOf('=>', arrowStart) + 2) + ' ' +
    blockAt(NATIVE, NATIVE.indexOf('=>', arrowStart));
  // eslint-disable-next-line no-new-func
  S.onSyncRefused = new Function(`return function() { return (${arrow}); }`)().call(vmApp);
  return vmApp;
}

test('a nativecal delete reaches the server and a later edit does not resurrect it', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), ev('B', 'B'), ev('C', 'C')] };
  deliver('c');
  const app = wireNative(S, 'c', server.c.events);

  app.handleDeleteEvent('B');
  assert.deepEqual(serverIds(server, 'c'), ['A', 'C'], 'the delete is not refused');
  assert.deepEqual(app.toasts, []);
  assert.equal(S._intent, null, 'the declaration was consumed by that write');

  const events = clone(app.calendar.events);
  events.find(e => e.id === 'A').title = 'A2';
  app.calendar.setEvents(events);
  assert.deepEqual(serverIds(server, 'c'), ['A', 'C'], 'B stays deleted');
  assert.equal(server.c.events.find(e => e.id === 'A').title, 'A2');
});

test('deleting a series in nativecal removes its edited occurrences too', () => {
  const { S, server, deliver } = loadDataService();
  const master = ev('S', 'Weekly', { recurrencerule: 'FREQ=WEEKLY', recurrenceException: '20260924T100000Z' });
  const occurrence = ev('X', 'Weekly moved', { recurrenceID: 'S' });
  server.c = { id: 'c', events: [ev('A', 'A'), master, occurrence] };
  deliver('c');
  const app = wireNative(S, 'c', server.c.events);

  app.handleDeleteEvent('S');
  assert.deepEqual(serverIds(server, 'c'), ['A']);
  assert.deepEqual(ids(app.calendar.events), ['A']);
});

test('nativecal recovers a refused write on screen and keeps the edit that rode with it', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), ev('B', 'B'), ev('C', 'C')] };
  deliver('c');
  const app = wireNative(S, 'c', server.c.events);

  // A buggy path loses C without declaring it, in the same write as a real edit of A.
  const events = clone(app.calendar.events).filter(e => e.id !== 'C');
  events.find(e => e.id === 'A').title = 'A2';
  app.calendar.setEvents(events);

  assert.equal(app.toasts.length, 1, 'the user is told');
  assert.match(app.toasts[0], /Recovered 1 event/);
  assert.deepEqual(ids(app.calendar.events), ['A', 'B', 'C'], 'C is back on screen');
  assert.deepEqual(serverIds(server, 'c'), ['A', 'B', 'C'], 'the server never lost it');
  assert.equal(server.c.events.find(e => e.id === 'A').title, 'A2', 'the edit still landed');
});
