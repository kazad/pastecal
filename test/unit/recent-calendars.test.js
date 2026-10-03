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
    src.indexOf('// Every localStorage-backed list'),
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

// --- 5. Existing pin/remove behavior still holds -----------------------------------------

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

// --- visit counting -------------------------------------------------------
//
// Return depth is the signal that separates a calendar someone keeps using from
// one they made once. lastVisited alone can't express it, so add() keeps a count.

test('visitCount starts at 1 and increments on each subsequent visit', () => {
  const { manager } = makeManager();

  manager.add('team-cal', 'Team');
  assert.equal(manager.getAll()[0].visitCount, 1, 'first visit is 1, not 0 or 2');

  manager.add('team-cal', 'Team');
  manager.add('team-cal', 'Team');
  assert.equal(manager.getAll()[0].visitCount, 3);
});

test('visitCount is tracked per calendar, not globally', () => {
  const { manager } = makeManager();

  manager.add('a', 'A');
  manager.add('a', 'A');
  manager.add('b', 'B');

  const all = manager.getAll();
  assert.equal(all.find((c) => c.id === 'a').visitCount, 2);
  assert.equal(all.find((c) => c.id === 'b').visitCount, 1);
});

test('an entry saved before visitCount existed is treated as one prior visit', () => {
  // A browser that used pastecal before the counter shipped.
  const { manager } = makeManager({
    recentCalendars: JSON.stringify([
      { id: 'legacy', title: 'Legacy', pinned: false, mine: false,
        lastVisited: '2026-01-01T00:00:00.000Z' },
    ]),
  });

  manager.add('legacy', 'Legacy');
  // Must not be NaN, and must not reset the history to 1.
  assert.equal(manager.getAll()[0].visitCount, 2);
});

test('visitCount survives a save/load round trip', () => {
  const { manager, store, RecentCalendars } = makeManager();

  manager.add('persisted', 'Persisted');
  manager.add('persisted', 'Persisted');

  // A fresh manager over the same backing store, as a reload would see it.
  const reloaded = new RecentCalendars();
  assert.equal(reloaded.getAll().find((c) => c.id === 'persisted').visitCount, 2);
  assert.ok(store.recentCalendars.includes('visitCount'), 'counter is persisted');
});

test('touchTitle updates the title without counting a visit', () => {
  const { manager } = makeManager();

  manager.add('team-cal', 'Old Name');
  manager.touchTitle('team-cal', 'New Name');

  const entry = manager.getAll()[0];
  assert.equal(entry.title, 'New Name', 'title is updated');
  assert.equal(entry.visitCount, 1, 'a title change is not a visit');
});

test('touchTitle ignores unknown calendars and empty titles', () => {
  const { manager } = makeManager();
  manager.add('team-cal', 'Name');

  manager.touchTitle('does-not-exist', 'Whatever');
  manager.touchTitle('team-cal', '');

  const entry = manager.getAll()[0];
  assert.equal(entry.title, 'Name', 'an empty title never clobbers a real one');
  assert.equal(manager.getAll().length, 1, 'no phantom entry is created');
});

test('touchTitle does not reorder the list', () => {
  const { manager } = makeManager();
  manager.add('first', 'First');
  manager.add('second', 'Second');

  // 'second' is most recent, so it sorts ahead of 'first'.
  assert.equal(manager.getAll()[0].id, 'second');

  manager.touchTitle('first', 'First Renamed');
  assert.equal(manager.getAll()[0].id, 'second',
    'renaming an older calendar must not promote it to most-recent');
});

// --- Corrupt storage must never take the app down ----------------------------------------
//
// RecentCalendars is constructed in the app's created() hook. Any throw there blanks the
// whole app, on every load, until the user clears site data. These are the exact values
// that did it.

for (const [key, value] of [
  ['myCalendars', '{bad'],
  ['myCalendars', '"x"'],
  ['recentCalendars', '{"a":1}'],
  ['recentCalendars', '[null]'],
  ['recentCalendars', '[1, "s", [], {"title":"no id"}, {"id": 7}]'],
  ['myCalendars', 'null'],
]) {
  test(`corrupt ${key}=${value} loads as empty and is repaired in storage`, () => {
    const { manager, store } = makeManager({ [key]: value });
    assert.deepEqual(manager.getAll(), []);
    assert.deepEqual(JSON.parse(store[key]), [], 'bad value is rewritten, not re-tolerated');
    manager.add('ok', 'OK');
    assert.equal(manager.getAll()[0].id, 'ok', 'fully usable afterwards');
  });
}

test('valid entries survive alongside corrupt ones', () => {
  const { manager, store } = makeManager({
    recentCalendars: JSON.stringify([null, { id: 'keep', title: 'Keep' }, 42]),
  });
  assert.deepEqual(manager.getAll().map((c) => c.id), ['keep']);
  assert.deepEqual(JSON.parse(store.recentCalendars).map((c) => c.id), ['keep']);
});

// A localStorage whose reads and/or writes throw (blocked storage, full quota).
function classWith(localStorage) {
  const src = fs.readFileSync(path.join(__dirname, '../../public/utils/utils.js'), 'utf8');
  const body = src.slice(src.indexOf('// Every localStorage-backed list'), src.indexOf('// Legacy calendar helpers'));
  return new Function('localStorage', `${body}; return RecentCalendars;`)(localStorage);
}

test('blocked storage (getItem/setItem throw) loads as empty and add() does not throw', () => {
  const boom = () => { throw new Error('SecurityError'); };
  const RC = classWith({ getItem: boom, setItem: boom, removeItem: boom });
  const m = new RC();
  assert.deepEqual(m.getAll(), []);
  assert.doesNotThrow(() => m.add('a', 'A'));
  assert.equal(m.getAll()[0].id, 'a', 'in-memory list still correct');
});

test('a quota error on save does not throw into the caller', () => {
  const store = {};
  let full = false;
  const RC = classWith({
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); store[k] = String(v); },
  });
  const m = new RC();
  m.add('x', 'X', true);
  full = true;
  assert.doesNotThrow(() => m.add('y', 'Y', true));
});

test('the create path records the new calendar in recents before clearing the draft', () => {
  // Shared by both apps since 2026-10 (public/services/CalendarFlow.js).
  const src = fs.readFileSync(path.join(__dirname, '../../public/services/CalendarFlow.js'), 'utf8');
  const add = src.indexOf('this.recentManager.add(slug, toSave.title, true);');
  const clear = src.indexOf('this.clearLocalStorage();', add - 2000);
  assert.ok(add > 0 && clear > add, 'add() must precede clearLocalStorage() in the create path');
});

// --- Read-only links are a kind, not a title suffix --------------------------------------

test('a view visit is stored with kind "view" and a clean title', () => {
  const { manager, store } = makeManager();
  manager.visit('abc', 'Team Roster', { kind: 'view' });
  const entry = JSON.parse(store.recentCalendars)[0];
  assert.equal(entry.kind, 'view');
  assert.equal(entry.title, 'Team Roster');
});

test('old " (View Only)" entries migrate to kind "view" on load', () => {
  const { manager, store } = makeManager({
    recentCalendars: JSON.stringify([
      { id: 'abc', title: 'Team Roster (View Only)', mine: false, lastVisited: '2026-01-02T00:00:00Z' },
      { id: 'def', title: 'Editable', mine: false, lastVisited: '2026-01-01T00:00:00Z' },
    ]),
  });
  const [abc, def] = ['abc', 'def'].map((id) => manager.getAll().find((c) => c.id === id));
  assert.equal(abc.kind, 'view');
  assert.equal(abc.title, 'Team Roster');
  assert.equal(def.kind, undefined);
  assert.equal(JSON.parse(store.recentCalendars)[0].kind, 'view', 'migration is persisted');
});

test('kind survives a later add() that does not name it', () => {
  const { manager } = makeManager();
  manager.add('abc', 'R', false, 'view');
  manager.add('abc', 'R2');
  assert.equal(manager.getAll()[0].kind, 'view');
});

test('the dropdown links a view entry to /view/<id> and others to /<id>', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/components/NavigationDropdown.js'), 'utf8');
  const NavigationDropdown = new Function(`${src}; return NavigationDropdown;`)();
  const { pathFor } = NavigationDropdown.methods;
  assert.equal(pathFor({ id: 'abc', kind: 'view' }), '/view/abc');
  assert.equal(pathFor({ id: 'abc' }), '/abc');
  assert.match(src, /:href="pathFor\(item\)"/, 'the link uses pathFor');
});

// --- visit(): one count per page load, shared by every subscription path ------------------

test('visit() counts the first call and only refreshes the title after', () => {
  const { manager } = makeManager({
    recentCalendars: JSON.stringify([{ id: 'c', title: 'C', visitCount: 3, lastVisited: '2026-01-01T00:00:00Z' }]),
  });
  assert.deepEqual(manager.visit('c', 'C'), { firstLoad: true, visitCount: 4 });
  for (let i = 0; i < 20; i++) {
    assert.equal(manager.visit('c', 'C renamed').firstLoad, false, 'remote edits are not visits');
  }
  const entry = manager.getAll()[0];
  assert.equal(entry.visitCount, 4);
  assert.equal(entry.title, 'C renamed');
});

test('visit() on the /view/ path does not inflate visitCount on remote edits', () => {
  const { manager } = makeManager();
  for (let i = 0; i < 10; i++) manager.visit('ro', 'RO', { kind: 'view' });
  assert.equal(manager.getAll()[0].visitCount, 1);
});

test('an id recorded by add() this page load is not counted again by visit()', () => {
  const { manager } = makeManager();
  manager.add('new', 'New', true);
  assert.equal(manager.visit('new', 'New').firstLoad, false);
  assert.equal(manager.getAll()[0].visitCount, 1);
});

test('both apps route both subscription paths through visit(), not add()', () => {
  for (const file of ['../../public/app.js', '../../public/nativecal/app.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(!src.includes('(View Only)`'), `${file}: no title-suffix kind`);
    assert.equal((src.match(/this\.recentManager\.visit\(/g) || []).length, 2, `${file}: editable and /view/ paths`);
  }
});
