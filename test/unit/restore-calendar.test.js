/**
 * scripts/restore-calendar.js writes a history snapshot back over a live calendar. Its merge
 * rules are the dangerous part, and they used to be inline in a CLI that only ever ran
 * against production: a snapshot older than the calendar's read-only link has no
 * publicViewId, and replacing options wholesale dropped the live one -- so the restore
 * never reached any /view/ link already shared.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { restorePatch } = require('../../scripts/restore-calendar.js');

const events = [{ id: 'a', title: 'One' }];

test('restore: the live publicViewId survives a snapshot that predates it', () => {
  const entry = { events, title: 'Old', options: { timeFormat: '12h' } };
  const live = { id: 'cal', events: [], options: { publicViewId: 'view123', timeFormat: '24h' } };
  const patch = restorePatch('cal', entry, live);
  assert.equal(patch['options/publicViewId'], 'view123');
  assert.equal(patch['options/timeFormat'], '12h', 'the snapshot\'s own options are restored');
});

test('restore: the live publicViewId wins over a stale one in the snapshot', () => {
  // The view the world has the link to is the live one.
  const patch = restorePatch('cal', { events, options: { publicViewId: 'old' } },
    { options: { publicViewId: 'current' } });
  assert.equal(patch['options/publicViewId'], 'current');
});

test('restore: options merge key by key, never replace the node', () => {
  const patch = restorePatch('cal', { events, options: { a: 1 } }, { options: { b: 2 } });
  assert.equal('options' in patch, false, 'a whole-node options write would drop live keys');
  assert.equal(patch['options/a'], 1);
  assert.equal('options/b' in patch, false, 'untouched live keys are left alone, not rewritten');
});

test('restore: a deleted calendar comes back with its id, title and events', () => {
  const patch = restorePatch('cal', { events }, null);
  assert.equal(patch.id, 'cal', 'a node without id reads as nonexistent');
  assert.equal(patch.title, '');
  assert.deepEqual(patch.events, events);
});
