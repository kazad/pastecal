/**
 * Tests for the targeted undo planner and the "already handled" history match, run on the
 * real methods extracted from app.js.
 *
 * Each case is a bug a reviewer reproduced:
 *   - undoing an edit of ONE occurrence of a series removed the exception row but skipped
 *     the master (its exception dates had changed since), so the occurrence vanished
 *   - isHandledHistory took a colleague's edit of the same event, inside the time window,
 *     for this session's own undo and skipped it -- and after a reload its in-memory
 *     guess was gone, so Cmd+Z redid the user's last undo. Undo writes now say what they
 *     reverse (`_undoOf`, stored on the history entry), and Cmd+Z reads that back.
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
  let i = APP.indexOf(`\n        ${name}(`);
  if (i === -1) i = APP.indexOf(`\n        async ${name}(`);
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
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'models/caldate.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8') + ';this.Event = Event;', ctx);
  // The real service: app.sameEvent delegates to its _sameEvent, the one client definition.
  ctx.CalendarDataService = require('./helpers/data-service-harness').loadDataService().S;
  // The planner itself lives in the shared UndoService; app.js delegates to it.
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'services/UndoService.js'), 'utf8')
    + ';this.UndoService = UndoService;', ctx);
  const names = ['planUndo', 'revertExdates', 'sameEvent', 'eventKey', 'deltaBetween',
    'isHandledHistory', 'reversedHistory'];
  vm.runInContext(`this.app = {\n${names.map(method).join(',\n')}\n}`, ctx);
  const app = ctx.app;
  app.calendar = { events: clone(events) };
  app._undoneHistoryKeys = new Set();
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

// --- isHandledHistory: identities read from /history, not guesses --------------------------

test('an undo entry, and what it reversed, are passed over by key or gesture', () => {
  const app = loadApp([]);
  const rows = [
    { key: 'U2', undoOf: ['E1'] },          // a history-path undo names entry keys
    { key: 'U1', undoOf: ['g7'] },          // a session undo names the action's gesture
    { key: 'E3', gesture: 'g7' },
    { key: 'E2', gesture: 'g7' },
    { key: 'E1', gesture: 'g1' },
    { key: 'E0', gesture: 'g0' },
  ];
  const reversed = app.reversedHistory(rows);
  assert.deepEqual([...reversed].sort(), ['E1', 'E2', 'E3']);
  const part = (r) => ({ ...r, reversed: reversed.has(r.key) });
  assert.deepEqual(rows.filter(r => !app.isHandledHistory(part(r))).map(r => r.key), ['E0']);
});

test('a colleague\'s identical edit is never taken for our undo', () => {
  // Nothing is matched on content or timing any more: only what an undo NAMED.
  const app = loadApp([]);
  app._undoneHistoryKeys.add('mine');
  assert.equal(app.isHandledHistory({ key: 'theirs', gesture: 'gT', reversed: false }), false);
  assert.equal(app.isHandledHistory({ key: 'mine', reversed: false }), true);
});

// Reviewer repro (r4c): drag X, Cmd+Z it, reload, Cmd+Z again. The undo had left no
// trace but a timing guess held in memory, so after the reload Cmd+Z took the undo entry
// for a fresh change and redid the drag -- then undid that, flip-flopping forever.
test('after a reload, Cmd+Z never redoes an undo', async () => {
  const X = (h) => ({ id: 'X', title: 'X', start: `2026-09-17T${h}:00:00.000Z`,
    end: `2026-09-17T${h + 1}:00:00.000Z`, type: 1 });
  const x0 = X(10), x1 = X(14), xa = X(8);
  // The server's log, newest first. E0: an earlier move xa -> x0; E1: a drag x0 -> x1.
  const history = [
    { key: 'E1', writer: 'me', gesture: 'g1', delta: { removed: [], added: [], changed: [{ from: x0, to: x1 }] } },
    { key: 'E0', writer: 'me', gesture: 'g0', delta: { removed: [], added: [], changed: [{ from: xa, to: x0 }] } },
  ];
  let n = 0;
  // Each undo write becomes an entry of its own, carrying the _undoOf it was stamped with.
  function boot(events) {
    const app = loadApp(events);
    const marked = [];
    const names = ['undoLastChange', 'undoLocalAction', 'commitUndo'];
    const ctx = vm.createContext({ console, JSON, Map, Set, Math, Object, Array, String, Promise,
      CalendarDataService: { writerId: 'me', declareIntent() {}, markUndo: (ids) => marked.push(...ids) } });
    // commitUndo writes through the shared UndoService, which reads this fake service.
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'services/UndoService.js'), 'utf8'), ctx);
    vm.runInContext(`this.m = {\n${names.map(method).join(',\n')}\n}`, ctx);
    Object.assign(app, ctx.m, {
      _undoBusy: false, _sessionUndo: [], isExisting: true, toasts: [],
      describeUndo: () => 'undone',
      showToast(msg) { this.toasts.push(msg); },
      async loadUndoEntries() {
        const reversed = this.reversedHistory(history);
        return history.map(r => ({ parts: [{ ...r, reversed: reversed.has(r.key) }] }));
      },
    });
    app.calendar.setEvents = function (list) {
      const before = this.events;
      this.events = clone(list);
      const delta = app.deltaBetween(before, this.events);
      history.unshift({ key: `U${n++}`, writer: 'me', undoOf: marked.splice(0), delta });
    };
    return app;
  }

  // Before the reload: Cmd+Z undid the drag from this session's memory, naming its gesture.
  let app = boot([x1]);
  app._sessionUndo.push({ delta: history[0].delta, gesture: 'g1', done: false });
  await app.undoLastChange();
  assert.equal(app.calendar.events[0].start, x0.start);
  assert.deepEqual(clone(history[0].undoOf), ['g1'], 'the undo write names the drag it reversed');

  // Reload: no memory. Cmd+Z goes past the undo and the drag to the change before them.
  app = boot([x0]);
  await app.undoLastChange();
  assert.equal(app.calendar.events[0].start, xa.start, 'it undoes E0 -- it does not redo the drag');
  assert.deepEqual(clone(history[0].undoOf), ['E0']);

  // And again, after another reload: nothing of ours is left to undo.
  app = boot([xa]);
  await app.undoLastChange();
  assert.equal(app.calendar.events[0].start, xa.start);
  assert.deepEqual(app.toasts, ['Nothing to undo']);
});

// --- Wiring checks on the source --------------------------------------------------------

test('quick-add is recorded as a local action', () => {
  const body = method('handleQuickAddEvent');
  assert.match(body, /recordLocalAction\('eventCreated', priorEvents, CalendarDataService\.actionGesture\(\)\)/);
  assert.ok(body.indexOf('priorEvents =') < body.indexOf('events.push('),
    'the prior state is captured before the push');
});

test('Cmd+Z does nothing while a dialog is open', () => {
  const at = APP.indexOf('const dialogOpen =');
  assert.ok(at !== -1, 'dialog check not found in the Cmd+Z handler');
  const snippet = APP.slice(at, APP.indexOf('if (dialogOpen) return;', at));
  assert.match(snippet, /e-popup-open/);
  assert.match(snippet, /quickAddDialog/);
  assert.match(snippet, /showRecentChanges/);
});
