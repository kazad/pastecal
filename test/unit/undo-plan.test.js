/**
 * Tests for the targeted undo planner and the "already handled" history match, run on the
 * real methods extracted from app.js.
 *
 * Each case is a bug a reviewer reproduced:
 *   - undoing an edit of ONE occurrence of a series removed the exception row but skipped
 *     the master (its exception dates had changed since), so the occurrence vanished
 *   - isHandledHistory took a colleague's edit of the same event, inside the time window,
 *     for this session's own undo and skipped it
 *   - quick-add never reached the session undo stack, so Cmd+Z after it undid something older
 *   - Cmd+Z fired under the scheduler's open editor dialog
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC, clone } = require('./helpers/data-service-harness');

const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

// Source of a Vue method (`        name(args) { ... }`), brace-matched.
function method(name) {
  const i = APP.indexOf(`\n        ${name}(`);
  assert.ok(i !== -1, `${name} not found in app.js — renamed?`);
  let j = APP.indexOf('{', APP.indexOf(')', i)), d = 0, k = j;
  for (; k < APP.length; k++) {
    if (APP[k] === '{') d++;
    else if (APP[k] === '}') { d--; if (!d) break; }
  }
  return APP.slice(i, k + 1).trim();
}

function loadApp(events) {
  const ctx = { console, JSON, Date, Map, Set, Math, Object, Array, String };
  vm.createContext(ctx);
  vm.runInContext('var Utils = { uuidv4: () => Math.random().toString(36).slice(2) };', ctx);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8') + ';this.Event = Event;', ctx);
  const names = ['planUndo', 'revertExdates', 'sameEvent', 'eventKey', 'deltaBetween',
    'sameDelta', 'isHandledHistory'];
  vm.runInContext(`this.app = {\n${names.map(method).join(',\n')}\n}`, ctx);
  const app = ctx.app;
  app.calendar = { events: clone(events) };
  app._undoneHistoryKeys = new Set();
  app._handledUndo = [];
  return app;
}

// A weekly series (Tue+Wed) and its occurrence exceptions.
const master = (ex) => ({ id: 'S', title: 'Weekly', start: '2026-09-01T10:00:00.000Z',
  end: '2026-09-01T11:00:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU,WE',
  recurrenceException: ex, type: 1 });
const moved = (day) => ({ id: 'X' + day, title: 'Weekly moved', start: `2026-09-${day}T12:00:00.000Z`,
  end: `2026-09-${day}T13:00:00.000Z`, recurrenceID: 'S', type: 1 });
const TUE = '20260908T100000Z', WED = '20260909T100000Z';
const ev = (id, title) => ({ id, title, start: '2026-09-17T10:00:00.000Z',
  end: '2026-09-17T11:00:00.000Z', type: 1 });

// --- Recurring series: master + exception undo as one unit --------------------------------

test('undoing one occurrence edit keeps a later edit of another occurrence', () => {
  const s0 = [master(null)];
  const s1 = [master(TUE), moved('08')];                     // edit Tue
  const s2 = [master(`${TUE},${WED}`), moved('08'), moved('09')];  // then edit Wed
  const app = loadApp(s2);
  const tueEdit = app.deltaBetween(s0, s1);

  const plan = app.planUndo([tueEdit]);
  const byKey = new Map(plan.next.map(e => [app.eventKey(e), e]));
  assert.equal(byKey.has('X08|S'), false, 'the Tue exception row is gone');
  assert.equal(byKey.get('S|').recurrenceException, WED,
    'Tue is un-hidden on the master, Wed stays hidden');
  assert.ok(byKey.has('X09|S'), 'the Wed edit is intact');
  assert.equal(plan.skipped.length, 0);
});

test('a series unit is skipped whole when one part changed since', () => {
  const s0 = [master(null)];
  const s1 = [master(TUE), moved('08')];
  const app = loadApp([master(TUE), { ...moved('08'), title: 'renamed since' }]);
  const plan = app.planUndo([app.deltaBetween(s0, s1)]);
  assert.equal(plan.noop, true, 'neither half is undone alone');
  const byKey = new Map(plan.next.map(e => [app.eventKey(e), e]));
  assert.equal(byKey.get('S|').recurrenceException, TUE,
    'the date stays hidden, so the occurrence is not shown twice');
  assert.equal(plan.skipped.length, 2);
});

test('undoing a deleted occurrence puts back only that date', () => {
  const s0 = [master(null)];
  const s1 = [master(TUE)];                       // delete Tue occurrence
  const app = loadApp([master(`${TUE},${WED}`)]); // then Wed deleted too
  const plan = app.planUndo([app.deltaBetween(s0, s1)]);
  assert.equal(plan.next[0].recurrenceException, WED);
  assert.equal(plan.removing, 0);
});

test('revertExdates takes back only the edit\'s own dates', () => {
  const app = loadApp([]);
  assert.equal(app.revertExdates(`${TUE},${WED}`, { recurrenceException: null },
    { recurrenceException: TUE }), WED);
  assert.equal(app.revertExdates(WED, { recurrenceException: TUE },
    { recurrenceException: null }), `${WED},${TUE}`);
  assert.equal(app.revertExdates(TUE, { recurrenceException: null },
    { recurrenceException: TUE }), null);
});

test('plain events still undo independently', () => {
  const before = [ev('A', 'A'), ev('B', 'B')];
  const after = [ev('A', 'A2'), ev('C', 'C')];      // edit A, delete B, add C
  const app = loadApp(after);
  const plan = app.planUndo([app.deltaBetween(before, after)]);
  assert.deepEqual(plan.next.map(e => `${e.id}:${e.title}`).sort(), ['A:A', 'B:B']);
  assert.deepEqual([...plan.removingKeys], ['C|']);
});

// --- isHandledHistory: match on what was written, not which events ------------------------

test('a colleague\'s edit of the same event is not taken for our undo', () => {
  const app = loadApp([]);
  const ours = { removed: [], added: [], changed: [{ from: ev('A', 'A2'), to: ev('A', 'A') }] };
  app._handledUndo.push({ at: 1000, delta: ours });

  const theirs = { removed: [], added: [], changed: [{ from: ev('A', 'A'), to: ev('A', 'Theirs') }] };
  assert.equal(app.isHandledHistory({ key: 'h1', savedAt: 3000, keys: ['A|'], delta: theirs }), false);
  assert.equal(app.isHandledHistory({ key: 'h2', savedAt: 3000, keys: ['A|'], delta: clone(ours) }), true,
    'our own write, as the server logged it, is still recognized');
  assert.equal(app.isHandledHistory({ key: 'h3', savedAt: 1000 + 61 * 1000, keys: ['A|'], delta: clone(ours) }), false,
    'outside the window it is not');
});

test('a subset delta is not a match', () => {
  const app = loadApp([]);
  app._handledUndo.push({ at: 1000, delta: { removed: [ev('A', 'A'), ev('B', 'B')], changed: [], added: [] } });
  assert.equal(app.isHandledHistory({ key: 'h', savedAt: 1500, keys: ['A|'],
    delta: { removed: [ev('A', 'A')], changed: [], added: [] } }), false);
});

// --- Wiring checks on the source --------------------------------------------------------

test('quick-add goes through the store, so Cmd+Z can take it back', () => {
  const body = method('handleQuickAddEvent');
  // The store records the inverse of every command it applies (undoable by default).
  assert.match(body, /this\.store\(\)\.dispatch\(\{ type: 'add'/);
  assert.doesNotMatch(body, /undoable:\s*false/);
});

test('Cmd+Z does nothing while a dialog is open', () => {
  const at = APP.indexOf('const dialogOpen =');
  assert.ok(at !== -1, 'dialog check not found in the Cmd+Z handler');
  const snippet = APP.slice(at, APP.indexOf('if (dialogOpen) return;', at));
  assert.match(snippet, /e-popup-open/);
  assert.match(snippet, /quickAddDialog/);
  assert.match(snippet, /showRecentChanges/);
});
