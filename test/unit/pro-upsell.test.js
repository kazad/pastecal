/**
 * ProUpsell (public/components/Pro.js): when the quiet "Lock this calendar" line may show.
 * Only on a calendar this browser created, unlocked and editable, when someone ELSE changed it
 * since the last visit, at most once per calendar per 30 days. Never for visitors, locked or
 * read-only calendars, the homepage draft, embeds or /beta.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function load(store = {}) {
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const src = fs.readFileSync(path.join(__dirname, '../../public/components/Pro.js'), 'utf8');
  const body = src.slice(src.indexOf('const PRO_UPSELL_KEY'), src.indexOf('function proTrack'));
  return { ProUpsell: new Function('localStorage', `${body}; return ProUpsell;`)(localStorage), store };
}

const DAY = 86400000, NOW = 1800000000000;
const ok = { id: 'team', existing: true, homepage: false, readOnly: false, viewRoute: false, embedded: false, beta: false,
  mine: true, shownAt: null, now: NOW, lockKnown: true, locked: false, visitKnown: true,
  lastSeenAt: NOW - 3 * DAY, lastEditedAt: NOW - DAY };

test('yes for your own unlocked, editable calendar edited since your last visit', () => {
  assert.equal(load().ProUpsell.precheck(ok), 'yes');
});

test('never for a visitor, a locked, read-only, view-link, homepage, embedded or /beta calendar', () => {
  const { ProUpsell } = load();
  for (const patch of [{ mine: false }, { locked: true }, { readOnly: true }, { viewRoute: true }, { homepage: true },
    { existing: false }, { embedded: true }, { beta: true }, { id: '' }]) {
    assert.equal(ProUpsell.precheck({ ...ok, ...patch }), 'no', JSON.stringify(patch));
  }
});

test('no when nothing changed since the last visit, or there was no last visit', () => {
  const { ProUpsell } = load();
  assert.equal(ProUpsell.precheck({ ...ok, lastEditedAt: ok.lastSeenAt - 1 }), 'no');
  assert.equal(ProUpsell.precheck({ ...ok, lastSeenAt: null }), 'no');
});

test('waits while the lock state, the visit or the last-edit stamp is still unknown', () => {
  const { ProUpsell } = load();
  assert.equal(ProUpsell.precheck({ ...ok, lockKnown: false }), 'wait');
  assert.equal(ProUpsell.precheck({ ...ok, visitKnown: false }), 'wait');
  assert.equal(ProUpsell.precheck({ ...ok, lastEditedAt: null }), 'wait');
  assert.equal(ProUpsell.precheck({ ...ok, lockKnown: false, mine: false }), 'no', 'a visitor is a no without waiting');
});

test('at most once per calendar per 30 days, stored as ids and times only', () => {
  const { ProUpsell, store } = load();
  ProUpsell.markShown('team', NOW - 29 * DAY);
  assert.equal(ProUpsell.precheck({ ...ok, shownAt: ProUpsell.shownAt('team') }), 'no');
  ProUpsell.markShown('team', NOW - 31 * DAY);
  assert.equal(ProUpsell.precheck({ ...ok, shownAt: ProUpsell.shownAt('team') }), 'yes');
  assert.equal(ProUpsell.shownAt('other'), null);
  assert.deepEqual(JSON.parse(store.pastecal_pro_upsell), { team: NOW - 31 * DAY });
});

test('storage that is blocked or holds garbage never throws', () => {
  const { ProUpsell } = load({ pastecal_pro_upsell: 'not json' });
  assert.equal(ProUpsell.shownAt('team'), null);
  const blocked = new Function('localStorage', `${fs.readFileSync(path.join(__dirname, '../../public/components/Pro.js'), 'utf8')
    .split('const PRO_UPSELL_KEY')[1].split('function proTrack')[0].replace(/^/, 'const PRO_UPSELL_KEY')}; return ProUpsell;`)({
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
  });
  assert.equal(blocked.shownAt('team'), null);
  assert.doesNotThrow(() => blocked.markShown('team'));
});

test('keeps the 100 most recent calendars', () => {
  const { ProUpsell, store } = load();
  for (let i = 0; i < 120; i++) ProUpsell.markShown('c' + i, NOW + i);
  const kept = Object.keys(JSON.parse(store.pastecal_pro_upsell));
  assert.equal(kept.length, 100); assert.ok(kept.includes('c119')); assert.ok(!kept.includes('c0'));
});

test('changedByOthers: only changes after the visit, by another browser, count', () => {
  const { ProUpsell } = load();
  const since = 1000, me = 'w-me';
  const row = (parts) => ({ savedAt: Math.max(...parts.map(p => p.savedAt)), parts });
  assert.equal(ProUpsell.changedByOthers([row([{ savedAt: 2000, writer: 'w-other' }])], since, me), true);
  assert.equal(ProUpsell.changedByOthers([row([{ savedAt: 2000, writer: me }])], since, me), false, 'your own edits');
  assert.equal(ProUpsell.changedByOthers([row([{ savedAt: 500, writer: 'w-other' }])], since, me), false, 'before your visit');
  assert.equal(ProUpsell.changedByOthers([row([{ savedAt: 2000, writer: null }])], since, me), false, 'no writer (lock changes, old rows)');
  assert.equal(ProUpsell.changedByOthers([row([{ savedAt: 2000, writer: me }, { savedAt: 1500, writer: 'w-other' }])], since, me), true, 'a collapsed row with another writer inside');
  assert.equal(ProUpsell.changedByOthers([], since, me), false);
  assert.equal(ProUpsell.changedByOthers(undefined, since, me), false);
});
