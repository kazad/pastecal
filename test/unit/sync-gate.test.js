/**
 * Tests for the write gate and its recovery, run end to end through the real
 * CalendarDataService.sync() against an in-memory Firebase transaction.
 *
 * Each case is a bug a reviewer reproduced:
 *   - a refused write's "recovery" merged the server copy back over the shrunk local list,
 *     and the merge read every dropped row as deleted-by-us and dropped it again
 *   - one legacy event without an `end` made every write look like a removal (refused),
 *     and a write that got through deleted that row from the server
 *   - object-shaped `events` ({"0":A,"2":B}) bypassed the gate and threw inside the
 *     transaction, losing the edit with no report
 *   - a transaction abort was not reported at all
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDataService, ev, clone, PUBLIC } = require('./helpers/data-service-harness');

const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const ids = (list) => list.map(e => e.id).sort();
const serverIds = (server, id) => ids(Object.values(server[id].events));

// Brace-matched source of the block that opens at the first `{` at or after `from`.
function blockAt(src, from) {
  const open = src.indexOf('{', from);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, i + 1);
}

// The app's real recovery glue: its onSyncRefused handler and applyRemoteCalendar,
// extracted from app.js and bound to a minimal stand-in for the Vue instance.
function wireApp(S, calendarId, events) {
  const appVm = {
    calendar: {
      id: calendarId,
      events: clone(events),
      import(c) { Object.assign(this, c); },
    },
    toasts: [],
    showToast(msg) { this.toasts.push(msg); },
    $nextTick(fn) { fn(); },
  };

  const m = /\n\s*applyRemoteCalendar\(([^)]*\}[^)]*|[^)]*)\)\s*\{/.exec(APP);
  assert.ok(m, 'applyRemoteCalendar not found in app.js — renamed?');
  const body = blockAt(APP, m.index + m[0].length - 1);
  // eslint-disable-next-line no-new-func
  appVm.applyRemoteCalendar = new Function('CalendarDataService',
    `return function(${m[1]}) ${body}`)(S).bind(appVm);

  const at = APP.indexOf('CalendarDataService.onSyncRefused =');
  assert.ok(at !== -1, 'onSyncRefused handler not found in app.js');
  const arrowStart = APP.indexOf('(', at);
  const arrow = APP.slice(arrowStart, APP.indexOf('=>', arrowStart) + 2) + ' ' +
    blockAt(APP, APP.indexOf('=>', arrowStart));
  // eslint-disable-next-line no-new-func
  S.onSyncRefused = new Function('CalendarDataService', 'track',
    `return function() { return (${arrow}); }`)(S, () => {}).call(appVm);
  return appVm;
}

// --- Refusal recovery -------------------------------------------------------------------

test('a refused partial loss is recovered on screen and later edits still save', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), ev('B', 'B'), ev('C', 'C'), ev('D', 'D')] };
  deliver('c');
  const app = wireApp(S, 'c', server.c.events);

  // One ordinary write, so the inbound merge has a _previousSeen baseline -- the
  // condition under which the old merge-based recovery re-dropped the rows.
  app.calendar.events[0].title = 'A2';
  S.sync(app.calendar);
  assert.ok(S._previousSeen.c, 'precondition: an inbound-merge baseline exists');

  // A buggy save path drops C and D with no deletion declared.
  let refused = 0;
  const handler = S.onSyncRefused;
  S.onSyncRefused = (x) => { refused++; handler(x); };
  app.calendar.events = app.calendar.events.slice(0, 2);
  S.sync(app.calendar);

  assert.equal(refused, 1, 'the undeclared removal is refused');
  assert.deepEqual(ids(app.calendar.events), ['A', 'B', 'C', 'D'],
    'the dropped events are back on screen, not merged away again');
  assert.deepEqual(serverIds(server, 'c'), ['A', 'B', 'C', 'D'], 'the server never lost them');

  // And the client is not wedged: the next real edit goes through.
  app.calendar.events.find(e => e.id === 'C').title = 'C2';
  S.sync(app.calendar);
  assert.equal(refused, 1, 'a later edit is not refused');
  assert.equal(server.c.events.find(e => e.id === 'C').title, 'C2');
});

test('a refusal that rode on a real deletion still delivers that deletion', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), ev('B', 'B'), ev('C', 'C'), ev('D', 'D')] };
  deliver('c');
  const app = wireApp(S, 'c', server.c.events);

  // The user deletes B (declared), but the write also loses C and D.
  S.declareIntent(1);
  app.calendar.events = app.calendar.events.filter(e => e.id === 'A');
  S.sync(app.calendar);

  assert.deepEqual(ids(app.calendar.events), ['A', 'C', 'D'],
    'C and D come back; B stays deleted rather than being resurrected');
  assert.deepEqual(serverIds(server, 'c'), ['A', 'C', 'D'],
    'the deletion the user asked for still reaches the server');
  assert.equal(S._intent, null, 'no declaration is left over to license a later write');

  let refused = 0;
  S.onSyncRefused = () => refused++;
  app.calendar.events.push(ev('E', 'new'));
  S.sync(app.calendar);
  assert.equal(refused, 0, 'a later edit is not refused');
  assert.deepEqual(serverIds(server, 'c'), ['A', 'C', 'D', 'E']);
});

// --- Incomplete rows already on the server ----------------------------------------------

const LEGACY = { id: 'OLD', title: 'legacy', start: '2026-01-01T00:00:00.000Z' };

test('a legacy event without an end does not block every write', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), LEGACY] };
  deliver('c');
  let refused = 0, reported = 0;
  S.onSyncRefused = () => refused++;
  S.onIncompleteEvents = () => reported++;

  for (let i = 0; i < 3; i++) S.sync({ id: 'c', events: [ev('A', `A edit ${i}`), LEGACY] });

  assert.equal(refused, 0, 'plain edits are not refused');
  assert.equal(reported, 0, 'an untouched server row is not reported as the user\'s unsaved event');
  assert.equal(server.c.events.find(e => e.id === 'A').title, 'A edit 2');
});

test('the client-side filter never deletes an incomplete row from the server', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), LEGACY] };
  deliver('c');
  S.onSyncRefused = () => assert.fail('must not be refused');

  S.sync({ id: 'c', events: [ev('A', 'A renamed'), LEGACY, ev('NEW', 'new')] });
  assert.deepEqual(serverIds(server, 'c'), ['A', 'NEW', 'OLD']);
  assert.deepEqual(server.c.events.find(e => e.id === 'OLD'), LEGACY, 'carried through untouched');

  // Even when this client never held the row at all.
  S.sync({ id: 'c', events: [ev('A', 'A again'), ev('NEW', 'new')] });
  assert.deepEqual(serverIds(server, 'c'), ['A', 'NEW', 'OLD']);
});

test('blanking the dates of a saved event keeps the server copy and reports it', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), ev('B', 'B')] };
  deliver('c');
  const dropped = [];
  S.onIncompleteEvents = (d) => dropped.push(...d);

  S.sync({ id: 'c', events: [ev('A', 'A'), { id: 'B', title: 'B', start: null, end: null }] });
  assert.deepEqual(dropped.map(e => e.id), ['B'], 'the user is told their edit did not save');
  assert.equal(server.c.events.find(e => e.id === 'B').end, '2026-09-17T11:00:00.000Z',
    'and the event is not deleted from the server');
});

test('a brand-new incomplete event is still dropped and reported', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A')] };
  deliver('c');
  const dropped = [];
  S.onIncompleteEvents = (d) => dropped.push(...d);

  S.sync({ id: 'c', events: [ev('A', 'A'), { id: 'X', title: 'no dates' }] });
  assert.deepEqual(dropped.map(e => e.id), ['X']);
  assert.deepEqual(serverIds(server, 'c'), ['A']);
});

// --- Object-shaped events ---------------------------------------------------------------

test('object-shaped events on the server merge instead of throwing', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: { 0: ev('A', 'A'), 2: ev('B', 'B') } };
  deliver('c');
  let failed = 0;
  S.onSyncFailed = () => failed++;

  S.sync({ id: 'c', events: [ev('A', 'A edited'), ev('B', 'B')] });
  assert.equal(failed, 0);
  assert.deepEqual(serverIds(server, 'c'), ['A', 'B']);
  assert.equal(server.c.events.find(e => e.id === 'A').title, 'A edited');
});

test('object-shaped events do not bypass the gate', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: { 0: ev('A', 'A'), 2: ev('B', 'B') } };
  deliver('c');
  let refused = 0;
  S.onSyncRefused = () => refused++;

  S.sync({ id: 'c', events: [ev('A', 'A')] });
  assert.equal(refused, 1, 'an undeclared removal is refused, not compared against NaN');
  assert.deepEqual(serverIds(server, 'c'), ['A', 'B']);
});

// --- Writes that do not land ------------------------------------------------------------

test('a throw inside the transaction is reported, not lost', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A')] };
  deliver('c');
  const failures = [];
  S.onSyncFailed = (e) => failures.push(e);
  S._mergeEvents = () => { throw new Error('boom'); };

  assert.doesNotThrow(() => S.sync({ id: 'c', events: [ev('A', 'A2')] }));
  assert.equal(failures.length, 1);
  assert.match(String(failures[0].message), /boom/);
  assert.equal(server.c.events[0].title, 'A', 'nothing half-written');
});

test('an aborted transaction is reported, not silent', () => {
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A')] };
  deliver('c');
  delete server.c;   // the node is gone (reset/deleted) by the time we write
  let failed = 0;
  S.onSyncFailed = () => failed++;

  S.sync({ id: 'c', events: [ev('A', 'A2')] });
  assert.equal(failed, 1, 'Firebase does not retry an abort, so the user must be told');
  assert.equal(server.c, undefined, 'and a deleted calendar is not recreated');
});

// --- The delete handler's declaration ---------------------------------------------------

test('the delete handler declares exactly the net removal, and nothing when it nets zero', () => {
  const at = APP.indexOf("if (ev.requestType === 'eventRemoved')");
  assert.ok(at !== -1, 'eventRemoved branch not found in app.js');
  const branch = blockAt(APP, at);
  assert.doesNotMatch(branch, /Math\.max\(1,/,
    'a floor of 1 declares a removal when deleting one occurrence removes nothing');
  assert.match(branch, /if \(before > after\) CalendarDataService\.declareIntent\(before - after\)/);
});
