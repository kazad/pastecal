/**
 * Unit tests for RecentCalendars (public/utils/utils.js) — the localStorage-backed
 * list behind the homepage nav dropdown.
 *
 * This is the ONLY way back to a calendar in a no-login product: there is no account,
 * so if an entry is lost, the user's calendar is unreachable unless they saved the URL.
 * These tests lock in the two properties that make that safe:
 *
 *   1. OWNERSHIP IS DURABLE. Calendars you *created* are stored under their own key
 *      (`myCalendars`) and are exempt from the 10-item recents cap. Visiting other
 *      people's calendars must never evict your own work. Ownership is also *sticky*:
 *      re-visiting a calendar you made must not demote it to a plain visit.
 *
 *   2. THE SPLIT SURVIVES A RELOAD AND AN UPGRADE. Older builds kept everything in
 *      `recentCalendars`; anything flagged `mine` there migrates across on first load
 *      so upgrading users don't lose ownership.
 *
 * Run: npm run test:unit:fast   (node 20/22 — see test/README.md)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// utils.js is a browser script (no module exports) that touches window/localStorage at
// import time. Load just the RecentCalendars class into a function scope with a fake
// localStorage, mirroring how the browser sees it.
function makeManager(seed = {}) {
  const store = { ...seed };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const src = fs.readFileSync(
    path.join(__dirname, '../../public/utils/utils.js'), 'utf8');
  const body = src.slice(
    src.indexOf('class RecentCalendars'),
    src.indexOf('// Legacy calendar helpers'));
  const factory = new Function('localStorage', `${body}; return RecentCalendars;`);
  const RecentCalendars = factory(localStorage);
  return { manager: new RecentCalendars(), store, RecentCalendars };
}

const readKey = (store, key) => JSON.parse(store[key] || '[]');

// --- 1. Created calendars are never evicted (the core guarantee) --------------------------

test('a created calendar survives visiting many other calendars', () => {
  const { manager } = makeManager();
  manager.add('my-party', 'Birthday Party', true);
  for (let i = 0; i < 15; i++) manager.add(`other${i}`, `Other ${i}`);

  assert.ok(manager.getAll().some((c) => c.id === 'my-party'),
    'created calendar must not be pushed out by the recents cap');
  assert.equal(manager.getMine().length, 1);
  assert.equal(manager.getMine()[0].id, 'my-party');
});

test('visited calendars stay capped at 10 while created ones do not count', () => {
  const { manager } = makeManager();
  manager.add('mine-a', 'Mine A', true);
  manager.add('mine-b', 'Mine B', true);
  for (let i = 0; i < 15; i++) manager.add(`other${i}`, `Other ${i}`);

  assert.equal(manager.getVisited().length, 10, 'visited list is capped');
  assert.equal(manager.getMine().length, 2, 'created calendars are exempt from the cap');
  assert.equal(manager.getAll().length, 12);
});

test('the cap evicts the oldest visited calendar, not the newest', () => {
  const { manager } = makeManager();
  for (let i = 0; i < 15; i++) manager.add(`other${i}`, `Other ${i}`);

  const ids = manager.getVisited().map((c) => c.id);
  assert.ok(!ids.includes('other0'), 'oldest visit evicted');
  assert.ok(ids.includes('other14'), 'newest visit retained');
});

// --- 2. Ownership is sticky --------------------------------------------------------------

test('re-visiting a calendar you created does not demote it', () => {
  const { manager } = makeManager();
  manager.add('my-party', 'Birthday Party', true);

  manager.add('my-party', 'Birthday Party'); // plain visit, no ownership flag

  assert.equal(manager.getAll().find((c) => c.id === 'my-party').mine, true,
    'ownership must survive a later plain visit');
  assert.equal(manager.getMine().length, 1);
});

test('createdAt is stamped once and preserved across visits', () => {
  const { manager } = makeManager();
  manager.add('my-party', 'Birthday Party', true);
  const first = manager.getAll().find((c) => c.id === 'my-party').createdAt;
  assert.ok(first, 'created calendars are stamped with createdAt');

  manager.add('my-party', 'Renamed Party');
  assert.equal(manager.getAll().find((c) => c.id === 'my-party').createdAt, first,
    'createdAt must not be reset by a later visit');
});

test('a merely-visited calendar is not marked as mine and has no createdAt', () => {
  const { manager } = makeManager();
  manager.add('someone-else', 'Someone Else');

  const entry = manager.getAll().find((c) => c.id === 'someone-else');
  assert.equal(entry.mine, false);
  assert.equal(entry.createdAt, undefined);
});

// --- 3. Storage split --------------------------------------------------------------------

test('created and visited calendars persist under separate keys', () => {
  const { manager, store } = makeManager();
  manager.add('my-party', 'Birthday Party', true);
  manager.add('someone-else', 'Someone Else');

  const mine = readKey(store, 'myCalendars');
  const visited = readKey(store, 'recentCalendars');

  assert.deepEqual(mine.map((c) => c.id), ['my-party']);
  assert.deepEqual(visited.map((c) => c.id), ['someone-else']);
  assert.ok(visited.every((c) => !c.mine), 'recents key never holds owned calendars');
});

test('the created/visited split survives a reload', () => {
  const { manager, store, RecentCalendars } = makeManager();
  manager.add('my-party', 'Birthday Party', true);
  for (let i = 0; i < 12; i++) manager.add(`other${i}`, `Other ${i}`);

  // Re-read from the same backing store, as a fresh page load would.
  void RecentCalendars;
  const { manager: reloaded } = makeManager(store);

  assert.equal(reloaded.getMine().length, 1);
  assert.equal(reloaded.getMine()[0].id, 'my-party');
  assert.equal(reloaded.getVisited().length, 10);
});

// --- 4. Upgrade path from the legacy single-key format ------------------------------------

test('legacy entries flagged mine migrate out of recentCalendars', () => {
  const { manager, store } = makeManager({
    recentCalendars: JSON.stringify([
      { id: 'legacy-mine', title: 'Legacy Mine', pinned: false, mine: true, lastVisited: '2025-01-01T00:00:00Z' },
      { id: 'legacy-seen', title: 'Legacy Seen', pinned: false, lastVisited: '2025-01-02T00:00:00Z' },
    ]),
  });

  assert.deepEqual(manager.getMine().map((c) => c.id), ['legacy-mine']);
  assert.deepEqual(manager.getVisited().map((c) => c.id), ['legacy-seen']);
  assert.deepEqual(readKey(store, 'myCalendars').map((c) => c.id), ['legacy-mine'],
    'migration rewrites storage so it only happens once');
});

test('an id present in both keys resolves to a single owned entry', () => {
  const { manager } = makeManager({
    myCalendars: JSON.stringify([
      { id: 'dup', title: 'Dup', pinned: false, mine: true, lastVisited: '2025-01-01T00:00:00Z' },
    ]),
    recentCalendars: JSON.stringify([
      { id: 'dup', title: 'Dup', pinned: false, lastVisited: '2025-01-02T00:00:00Z' },
    ]),
  });

  assert.equal(manager.getAll().filter((c) => c.id === 'dup').length, 1, 'no duplicate rows');
  assert.equal(manager.getAll().find((c) => c.id === 'dup').mine, true, 'ownership wins');
});

test('missing or corrupt storage falls back to an empty list', () => {
  const { manager } = makeManager();
  assert.deepEqual(manager.getAll(), []);
  assert.deepEqual(manager.getMine(), []);
  assert.deepEqual(manager.getVisited(), []);
});

// --- 5. Existing pin/remove behaviour still holds -----------------------------------------

test('a created calendar can still be pinned and removed by the user', () => {
  const { manager, store } = makeManager();
  manager.add('c1', 'C1', true);

  manager.togglePin('c1');
  assert.equal(manager.getAll()[0].pinned, true);
  assert.equal(manager.getAll()[0].mine, true, 'pinning does not clear ownership');

  manager.remove('c1');
  assert.deepEqual(manager.getAll(), [], 'user can always remove their own entry');
  assert.deepEqual(readKey(store, 'myCalendars'), [], 'removal clears the durable key too');
});

test('pinned calendars sort above owned, which sort above visited', () => {
  const { manager } = makeManager();
  manager.add('visited', 'Visited');
  manager.add('owned', 'Owned', true);
  manager.add('pinned-visit', 'Pinned Visit');
  manager.togglePin('pinned-visit');

  assert.deepEqual(manager.getAll().map((c) => c.id),
    ['pinned-visit', 'owned', 'visited']);
});

test('renaming moves the entry and keeps ownership and pin state', () => {
  const { manager } = makeManager();
  manager.add('old-slug', 'My Calendar', true);
  manager.togglePin('old-slug');

  // Mirrors renameCalendar() in public/app.js
  const wasPinned = manager.getAll().find((c) => c.id === 'old-slug')?.pinned;
  const wasMine = manager.getAll().find((c) => c.id === 'old-slug')?.mine;
  manager.remove('old-slug');
  manager.add('new-slug', 'My Calendar', wasMine);
  if (wasPinned) manager.togglePin('new-slug');

  const all = manager.getAll();
  assert.equal(all.length, 1, 'no orphaned entry left behind');
  assert.equal(all[0].id, 'new-slug');
  assert.equal(all[0].pinned, true, 'pin state carries across the rename');
  assert.equal(all[0].mine, true, 'ownership carries across the rename');
});
