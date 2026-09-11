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

// --- Shape differences between server and client -----------------------------------------

test('an untouched event is not treated as edited just because its stored shape differs', () => {
  // Firebase does not store null-valued keys, so an event read back from the server has no
  // recurrenceID/recurrenceException, while the same event rebuilt through Event's
  // constructor has them as null — and the key order differs. A JSON.stringify comparison
  // called those unequal, so EVERY untouched event looked "edited by me" and the merge
  // overwrote the server wholesale. That is last-write-wins, the exact bug this prevents.
  const serverShape = { id: 'A', title: 'A', description: '', repeat: '',
    recurrencerule: '', start: '2026-09-17T10:00:00.000Z',
    end: '2026-09-17T11:00:00.000Z', type: 1, isAllDay: false };
  const clientShape = { id: 'A', title: 'A', description: '', repeat: '',
    recurrencerule: '', start: '2026-09-17T10:00:00.000Z',
    end: '2026-09-17T11:00:00.000Z', type: 1,
    recurrenceID: null, recurrenceException: null, isAllDay: false };

  const theirEdit = { ...serverShape, title: 'EDITED BY SOMEONE ELSE' };
  const merged = mergeEvents([serverShape], [clientShape], [theirEdit]);

  assert.equal(merged.find(e => e.id === 'A').title, 'EDITED BY SOMEONE ELSE',
    'an event we never touched must not overwrite a newer remote copy');
});

test('a real local edit is still detected despite shape differences', () => {
  const serverShape = { id: 'A', title: 'A', start: 'S', end: 'E', type: 1 };
  const clientEdited = { id: 'A', title: 'I CHANGED THIS', start: 'S', end: 'E',
    type: 1, recurrenceID: null, recurrenceException: null, isAllDay: false };

  const merged = mergeEvents([serverShape], [clientEdited], [serverShape]);
  assert.equal(merged.find(e => e.id === 'A').title, 'I CHANGED THIS',
    'our genuine edit must still win over an unchanged remote');
});

test('type is compared by value, not by string-vs-number', () => {
  const base = { id: 'A', title: 'A', start: 'S', end: 'E', type: '4' };
  const local = { id: 'A', title: 'A', start: 'S', end: 'E', type: 4 };
  const theirs = { id: 'A', title: 'THEIRS', start: 'S', end: 'E', type: '4' };

  assert.equal(mergeEvents([base], [local], [theirs]).find(e => e.id === 'A').title,
    'THEIRS', 'a numeric/string type difference is not a local edit');
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

test('with no baseline, our events upload and nobody else\'s are removed', () => {
  // sync() passes an empty base when it has never seen a server snapshot. Everything local
  // then reads as an addition, which is what we want -- it still needs uploading -- and no
  // deletion is inferred, because we have no evidence anything was deleted.
  const merged = mergeEvents([],
    [ev('A', 'A'), ev('MINE', 'mine')],
    [ev('A', 'A'), ev('THEIRS', 'theirs')]);

  assert.deepEqual(ids(merged), ['A', 'MINE', 'THEIRS'],
    'ours uploads; a concurrent event we never knew about survives');
});

test('an event missing from remote is only re-added if we created it', () => {
  // "Absent from remote" is ambiguous: it means somebody deleted it, OR we just made it.
  // Treating both as "ours to add" resurrects other people's deletions.
  const deletedByOther = mergeEvents(
    [ev('A', 'A'), ev('B', 'B')],   // base had B
    [ev('A', 'A'), ev('B', 'B')],   // we still hold B, untouched
    [ev('A', 'A')]);                // someone deleted it
  assert.deepEqual(ids(deletedByOther), ['A'], "their delete stands");

  const weCreatedIt = mergeEvents(
    [ev('A', 'A')],                 // base did not have NEW
    [ev('A', 'A'), ev('NEW', 'n')], // we created it
    [ev('A', 'A')]);
  assert.deepEqual(ids(weCreatedIt), ['A', 'NEW'], 'our creation uploads');
});

test('an unchanged calendar merges to exactly what the server already had', () => {
  const base = [ev('A', 'A'), ev('B', 'B')];
  const merged = mergeEvents(base, base, base);
  assert.deepEqual(merged.map(e => e.id), ['A', 'B']);
});
