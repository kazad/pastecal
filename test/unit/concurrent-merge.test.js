/**
 * Tests for CalendarDataService._mergeEvents — the concurrency fix.
 *
 * pastecal is a link-shared calendar with no login: two people editing at once is the
 * product, not an edge case. sync() used to `set()` the entire calendar object, so whoever
 * wrote last replaced the other's events array wholesale. An event someone created seconds
 * earlier simply stopped existing, with no error and nothing in the UI to suggest it had
 * happened. The same race hit one person in two tabs, and one person on a flaky connection
 * whose queued write landed late.
 *
 * The write is now a merge run inside a Firebase transaction. Three sets matter: `base`
 * (what the server had when we last heard from it), `local` (what this client holds now),
 * and `remote` (what the server holds at write time). Our additions and edits since base
 * are ours to apply; our deletions since base remove by id; everything else in remote is
 * someone else's work and must survive untouched.
 *
 * These tests run the real function extracted from the shipped source.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../../public/services/CalendarDataService.js'), 'utf8');

// Extract the real static method so a drift between test and source shows up as a failure.
function extractMerge() {
  const sig = /static _mergeEvents\(([^)]*)\)\s*\{/.exec(SRC);
  assert.ok(sig, '_mergeEvents not found in CalendarDataService.js — renamed?');
  const open = SRC.indexOf('{', sig.index + sig[0].length - 1);
  let depth = 0, i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return function(${sig[1]}) {${SRC.slice(open + 1, i)}}`)();
}

const mergeEvents = extractMerge();
const ev = (id, title, extra = {}) => ({ id, title, start: '2026-09-17T10:00:00.000Z',
  end: '2026-09-17T11:00:00.000Z', ...extra });
const ids = (list) => list.map(e => e.id).sort();

// --- The reported race ------------------------------------------------------------------

test("a concurrent editor's new event is not destroyed by our write", () => {
  // Alice and Bob both loaded [A, B]. Bob created D and it reached the server first.
  // Alice then moves A. Her write must not roll back Bob's D.
  const base = [ev('A', 'A'), ev('B', 'B')];
  const local = [ev('A', 'A', { start: '2026-09-17T14:00:00.000Z' }), ev('B', 'B')];
  const remote = [ev('A', 'A'), ev('B', 'B'), ev('D', 'Bob event')];

  const merged = mergeEvents(base, local, remote);

  assert.deepEqual(ids(merged), ['A', 'B', 'D'], "Bob's event survives Alice's write");
  assert.equal(merged.find(e => e.id === 'A').start, '2026-09-17T14:00:00.000Z',
    "Alice's edit is applied");
});

test('our own new event is added without disturbing anyone else', () => {
  const base = [ev('A', 'A')];
  const local = [ev('A', 'A'), ev('MINE', 'mine')];
  const remote = [ev('A', 'A'), ev('THEIRS', 'theirs')];

  assert.deepEqual(ids(mergeEvents(base, local, remote)), ['A', 'MINE', 'THEIRS']);
});

test('a stale client cannot revert a change it never saw', () => {
  // Bob still holds the old A. Someone edited A on the server. Bob writes an unrelated
  // event; his stale copy of A must not overwrite the newer one.
  const base = [ev('A', 'old title')];
  const local = [ev('A', 'old title'), ev('NEW', 'bob')];
  const remote = [ev('A', 'NEWER title')];

  const merged = mergeEvents(base, local, remote);

  assert.equal(merged.find(e => e.id === 'A').title, 'NEWER title',
    'an untouched local copy must never clobber a newer remote one');
  assert.ok(merged.some(e => e.id === 'NEW'));
});

// --- Deletes ----------------------------------------------------------------------------

test('deleting an event locally removes it on the server', () => {
  const base = [ev('A', 'A'), ev('B', 'B')];
  const local = [ev('A', 'A')];           // B deleted here
  const remote = [ev('A', 'A'), ev('B', 'B')];

  assert.deepEqual(ids(mergeEvents(base, local, remote)), ['A'], 'the delete is applied');
});

test('a delete does not resurrect as a side effect of someone else writing', () => {
  // Alice deletes B. Bob's tab, still holding B, writes. Bob's base also had B and he did
  // not touch it, so his write must not re-add it.
  const base = [ev('A', 'A'), ev('B', 'B')];
  const local = [ev('A', 'A'), ev('B', 'B')];   // Bob untouched
  const remote = [ev('A', 'A')];                // Alice already deleted B

  assert.deepEqual(ids(mergeEvents(base, local, remote)), ['A'],
    "Bob's untouched copy must not resurrect Alice's deletion");
});

test('a delete yields to a concurrent edit of the same event', () => {
  // We deleted B; meanwhile someone else edited it. Their edit is newer information than
  // our delete, so the event stays rather than silently taking their work with it.
  const base = [ev('B', 'B')];
  const local = [];                                   // we deleted B
  const remote = [ev('B', 'B', { title: 'edited by someone else' })];

  const merged = mergeEvents(base, local, remote);
  assert.deepEqual(ids(merged), ['B'], 'a concurrent edit outranks our delete');
  assert.equal(merged[0].title, 'edited by someone else');
});

// --- Ordering and shape -----------------------------------------------------------------

test("the server's ordering is preserved and new events append", () => {
  const base = [ev('A', 'A'), ev('B', 'B')];
  const local = [ev('A', 'A'), ev('B', 'B'), ev('C', 'C')];
  const remote = [ev('B', 'B'), ev('A', 'A')];        // server order differs

  const merged = mergeEvents(base, local, remote);
  assert.deepEqual(merged.map(e => e.id), ['B', 'A', 'C'],
    'existing events keep server order; ours is appended');
});

test('a first write against an empty server keeps everything local', () => {
  const local = [ev('A', 'A'), ev('B', 'B')];
  assert.deepEqual(ids(mergeEvents([], local, [])), ['A', 'B']);
});

test('events without ids are dropped rather than duplicated on every write', () => {
  // An id-less event cannot be matched across writes, so keeping it would append a fresh
  // copy every time the debounce fires.
  const merged = mergeEvents([], [{ title: 'no id' }, ev('A', 'A')], []);
  assert.deepEqual(ids(merged), ['A']);
});

test('missing or malformed inputs do not throw', () => {
  assert.doesNotThrow(() => mergeEvents(undefined, undefined, undefined));
  assert.doesNotThrow(() => mergeEvents(null, [ev('A', 'A')], null));
  assert.deepEqual(ids(mergeEvents(null, [ev('A', 'A')], null)), ['A']);
});

test('an unchanged calendar merges to exactly what the server already had', () => {
  const base = [ev('A', 'A'), ev('B', 'B')];
  const merged = mergeEvents(base, base, base);
  assert.deepEqual(merged.map(e => e.id), ['A', 'B']);
});
