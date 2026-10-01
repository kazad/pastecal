/**
 * The write path by identity rather than by count, clock or timing -- run end to end
 * through the real CalendarDataService.sync() and subscription against the in-memory
 * Firebase stand-in.
 *
 * Reviewer repros (r4, r4b, r4c -- r4c lives in undo-plan.test.js):
 *   - the gate authorised removal by NET COUNT: an addition masked a loss, a declaration
 *     of A licensed losing B, and a delete+add netting zero left the declaration live for
 *     the next buggy write
 *   - declarations expired after 5s while the debounce restarted on every keystroke, so
 *     a delete followed by typing was refused, the row came back and the typing was lost
 *   - nativecal imported snapshots bare, overwriting unsent edits and resurrecting
 *     deletes; the main app merged against a global "previous snapshot"
 *   - writes did not say what they were: undos and drag gestures were guessed later
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDataService, ev, clone, PUBLIC } = require('./helpers/data-service-harness');

const ids = (list) => Object.values(list).map(e => e.id).sort();
const serverIds = (server, id = 'c') => ids(server[id].events);

function setup(events = [ev('A', 'A'), ev('B', 'B'), ev('C', 'C')]) {
  const h = loadDataService();
  h.server.c = { id: 'c', title: 't', events };
  h.deliver('c');
  h.refused = [];
  h.S.onSyncRefused = (r) => h.refused.push(r);
  return h;
}

// --- The gate: every row that leaves must be named ----------------------------------------

test('r4/1a: an addition does not hide an unnamed removal', () => {
  const { S, server, refused } = setup();
  S.sync({ id: 'c', events: [ev('A', 'A'), ev('C', 'C'), ev('D', 'D')] });
  assert.equal(refused.length, 1, 'B vanished without a delete: refused despite the net zero');
  assert.deepEqual(serverIds(server), ['A', 'B', 'C', 'D'], 'B kept, the addition still saved');
});

test('r4/1b: declaring A does not license losing B', () => {
  const { S, server, refused } = setup();
  S.declareIntent(['A|']);
  S.sync({ id: 'c', events: [ev('A', 'A'), ev('C', 'C')] });
  assert.equal(refused.length, 1);
  assert.deepEqual(serverIds(server), ['A', 'B', 'C']);
  assert.equal(S._pendingDeletes.size, 0,
    'the corrected write carried A, so the stale declaration is settled, not left live');
});

test('r4/1c: a delete+add write spends its declaration; a later drop is refused', () => {
  const { S, server, deliver, refused } = setup();
  S.declareIntent(['A|']);
  S.sync({ id: 'c', events: [ev('B', 'B'), ev('C', 'C'), ev('D', 'D')] });
  assert.equal(refused.length, 0);
  assert.deepEqual(serverIds(server), ['B', 'C', 'D']);
  deliver('c');

  // A buggy path drops C two seconds later.
  S.sync({ id: 'c', events: [ev('B', 'B'), ev('D', 'D')] });
  assert.equal(refused.length, 1, 'nothing is left over to license it');
  assert.deepEqual(serverIds(server), ['B', 'C', 'D']);
});

test('r4/2: a delete survives any amount of typing before the write; no clock', () => {
  const { S, server, ctx, refused } = setup();
  const RealDate = Date;
  let offset = 0;
  ctx.Date = class extends RealDate { static now() { return RealDate.now() + offset; } };
  S.declareIntent(['B|']);
  offset = 60 * 1000;   // the debounce kept restarting while notes were typed
  S.sync({ id: 'c', title: 't', options: { notes: 'typed for a minute' },
    events: [ev('A', 'A'), ev('C', 'C')] });
  assert.equal(refused.length, 0, 'the declaration lives with the pending change, not a timer');
  assert.deepEqual(serverIds(server), ['A', 'C']);
  assert.equal(server.c.options.notes, 'typed for a minute');
});

test('a refused write still delivers its title and notes', () => {
  const { S, server, refused } = setup();
  // Nothing but a buggy drop and some typing -- no event added or edited.
  S.sync({ id: 'c', title: 'Renamed', options: { notes: 'hello' }, events: [ev('A', 'A'), ev('B', 'B')] });
  assert.equal(refused.length, 1);
  assert.deepEqual(serverIds(server), ['A', 'B', 'C']);
  assert.equal(server.c.title, 'Renamed');
  assert.equal(server.c.options.notes, 'hello');
});

test('a declaration made while a write is computed is not spent by it', () => {
  const { S, server, deliver } = setup();
  S.declareIntent(['A|']);
  // The transaction body runs, then -- before it commits -- the user deletes B.
  const realChild = S.db.child;
  S.db = { child: (id) => ({ ...realChild(id), transaction(fn, done) {
    const r = fn(clone(server[id]));
    S.declareIntent(['B|']);
    server[id] = clone(r);
    done(null, true, { val: () => clone(server[id]) });
  } }) };
  S.sync({ id: 'c', events: [ev('B', 'B'), ev('C', 'C')] });
  assert.deepEqual([...S._pendingDeletes], ['B|']);
  S.db = { child: realChild };
  deliver('c');
  S.sync({ id: 'c', events: [ev('C', 'C')] });
  assert.deepEqual(serverIds(server), ['C']);
});

test('a bare count is not a declaration', () => {
  const { S, errors } = loadDataService();
  S.declareIntent(1);
  assert.equal(S._pendingDeletes.size, 0);
  assert.ok(errors.some(e => /declareIntent/.test(e)));
});

// --- Inbound: the service merges each snapshot with the local copy ---------------------

// What both apps now do with a snapshot: import exactly what the service hands them.
function subscribeApp(S, events) {
  const app = { calendar: { id: 'c', events: clone(events), import(c) { Object.assign(this, c); } } };
  S._subscribeExact('c', (c) => { if (c) app.calendar.import(c); }, () => app.calendar);
  return app;
}

test('r4b: a snapshot arriving inside the debounce window keeps unsent edits and deletes', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), ev('B', 'B')] };
  const app = subscribeApp(S, []);
  assert.deepEqual(ids(app.calendar.events), ['A', 'B'], 'the first snapshot is taken whole');

  // In the debounce window: the user retitles A and deletes B...
  S.declareIntent(['B|']);
  app.calendar.events = [{ ...app.calendar.events[0], title: 'A-edited' }];
  // ...and another device's addition of Z arrives first.
  server.c.events.push(ev('Z', 'Z'));
  deliver('c');
  assert.deepEqual(app.calendar.events.map(e => `${e.id}:${e.title}`).sort(), ['A:A-edited', 'Z:Z'],
    'the edit survives, the delete is not resurrected, and the arrival is shown');

  S.sync(app.calendar);
  assert.deepEqual(server.c.events.map(e => `${e.id}:${e.title}`).sort(), ['A:A-edited', 'Z:Z']);
  assert.equal(S._pendingDeletes.size, 0);
});

test('a write\'s committed state reaches the local copy, so others\' rows are not lost later', () => {
  const { S, server } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A')] };
  const app = subscribeApp(S, []);
  S.connected = 'c';
  S.onSyncRefused = () => assert.fail('nothing was removed');

  // Another device adds Z; our transaction sees it before our snapshot does.
  server.c.events.push(ev('Z', 'Z'));
  app.calendar.events[0].title = 'A2';
  S.sync(app.calendar);
  assert.deepEqual(ids(app.calendar.events), ['A', 'Z'], 'the merged result came back to the screen');

  app.calendar.events[0].title = 'A3';
  S.sync(app.calendar);
  assert.deepEqual(serverIds(server), ['A', 'Z'], 'Z was not read as deleted by us');
});

test('a snapshot for another calendar id is not merged with this local copy', () => {
  const { S, server } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A')] };
  const app = { calendar: { id: 'homepage', events: [ev('H', 'draft')], import(c) { Object.assign(this, c); } } };
  S._subscribeExact('c', (c) => app.calendar.import(c), () => app.calendar);
  assert.deepEqual(ids(app.calendar.events), ['A']);
});

test('both apps subscribe with their local copy and import what they are given', () => {
  const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const NATIVE = fs.readFileSync(path.join(PUBLIC, 'nativecal/app.js'), 'utf8');
  for (const [name, src] of [['app.js', APP], ['nativecal/app.js', NATIVE]]) {
    assert.match(src, /\}, \(\) => this\.calendar\);/, `${name}: findAndSubscribe gets the local copy`);
  }
  assert.doesNotMatch(APP, /_previousSeen|_lastSeen|_mergeEvents/, 'app.js does no merging of its own');
  assert.doesNotMatch(NATIVE, /_previousSeen|_lastSeen|_mergeEvents/);
});

// --- What a write says it is: _undoOf and _gesture ------------------------------------

test('every write sets _undoOf and _gesture, clearing what the last one left', () => {
  const { S, server } = setup();
  server.c._undoOf = ['old'];
  server.c._gesture = 'gOld';
  S.sync({ id: 'c', events: [ev('A', 'A2'), ev('B', 'B'), ev('C', 'C')] });
  assert.equal('_undoOf' in server.c && server.c._undoOf !== null, false);
  assert.equal('_gesture' in server.c && server.c._gesture !== null, false);
});

test('an undo write names what it reverses, once', () => {
  const { S, server } = setup();
  S.markUndo(['E1', 'E2']);
  S.sync({ id: 'c', events: [ev('A', 'A2'), ev('B', 'B'), ev('C', 'C')] });
  assert.deepEqual(server.c._undoOf, ['E1', 'E2']);
  S.sync({ id: 'c', events: [ev('A', 'A3'), ev('B', 'B'), ev('C', 'C')] });
  assert.equal(server.c._undoOf ?? null, null, 'the next write is not an undo');
});

test('a drag\'s saves share one gesture id through its final save, then it is cleared', () => {
  const { S, server } = setup();
  const g = S.beginGesture();
  S.sync({ id: 'c', events: [ev('A', 'A1'), ev('B', 'B'), ev('C', 'C')] });
  assert.equal(server.c._gesture, g);
  S.endGesture();
  assert.equal(S.actionGesture(), g, 'the drop\'s action belongs to the drag');
  S.sync({ id: 'c', events: [ev('A', 'A2'), ev('B', 'B'), ev('C', 'C')] });
  assert.equal(server.c._gesture, g, 'the final save carries it');
  S.sync({ id: 'c', events: [ev('A', 'A3'), ev('B', 'B'), ev('C', 'C')] });
  assert.equal(server.c._gesture ?? null, null, 'a later write is not part of it');

  // A second drag of the same event is a different gesture, however soon.
  const g2 = S.beginGesture();
  assert.notEqual(g2, g);
  assert.match(g2, /^[A-Za-z0-9_-]{1,40}$/, 'valid as an _undoOf entry on the server');
});

test('a refused write does not spend the undo marks', () => {
  const { S, server, refused } = setup();
  S.markUndo(['E1']);
  S.sync({ id: 'c', events: [ev('A', 'A2'), ev('B', 'B')] });   // drops C unnamed
  assert.equal(refused.length, 1);
  assert.deepEqual(server.c._undoOf, ['E1'], 'the corrected write carries it');
});

test('snapshots reach the app without _undoOf or _gesture', () => {
  const { S, server } = loadDataService();
  server.c = { id: 'c', _writer: 'w', _undoOf: ['E1'], _gesture: 'g1', events: [ev('A', 'A')] };
  const app = subscribeApp(S, []);
  for (const k of ['_writer', '_undoOf', '_gesture']) assert.equal(k in app.calendar, false, k);
});

test('the grid opens a gesture at drag/resize start and ends it at stop', () => {
  const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(APP, /scheduleObj\.dragStart = \(\) => \{ CalendarDataService\.beginGesture\(\); \}/);
  assert.match(APP, /scheduleObj\.resizeStart = \(\) => \{ CalendarDataService\.beginGesture\(\); \}/);
  assert.match(APP, /scheduleObj\.dragStop = \(\) => \{ CalendarDataService\.endGesture\(\); \}/);
  assert.match(APP, /scheduleObj\.resizeStop = \(\) => \{ CalendarDataService\.endGesture\(\); \}/);
  assert.doesNotMatch(APP, /_handledUndo/, 'the timing heuristic is gone');
});
