/**
 * "Edited N ago" must reflect EVERY change, including pure additions.
 *
 * /history deliberately records only writes that lost something -- it exists to restore,
 * and snapshotting every add would bury the recoverable entries under full event arrays.
 * But the header label claims to say when the calendar was last edited, and a user who
 * added two events and saw the time unchanged was told something false (observed in
 * production on /kalid: 201 live events, newest snapshot 199, label stuck at 22h).
 *
 * history_meta/<id>/lastEditedAt is one number per calendar, stamped on any change.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error('FIREBASE_DATABASE_EMULATOR_HOST is not set. Run via `npm run test:unit`.');
}

const admin = require('../../functions/node_modules/firebase-admin');
require('../../functions/index.js');
const { _internal } = require('../../functions/index.js');
const { HistoryService } = _internal;
const db = admin.database();

const ev = (id, title) => ({
    id, title, start: '2026-09-17T10:00:00.000Z', end: '2026-09-17T11:00:00.000Z', type: 1,
});
const cal = (id, events, extra = {}) => ({ id, title: 'Stamp Test', events, options: {}, ...extra });

const stampOf = async (id) =>
    (await db.ref(`history_meta/${id}/lastEditedAt`).once('value')).val();
const cleanup = (id) => Promise.all([
    db.ref('calendars').child(id).remove(),
    db.ref('history').child(id).remove(),
    db.ref('history_meta').child(id).remove(),
]);

test('lastEdit stamp: ADDING an event updates the time, though history records nothing', async () => {
    const id = 'stamp-add-' + Date.now();
    await cleanup(id);
    try {
        const before = cal(id, [ev('a', 'One')]);
        const after = cal(id, [ev('a', 'One'), ev('b', 'Two')]);

        // The snapshot log ignores a pure addition -- by design.
        assert.equal(HistoryService.changeKind(before, after), null);

        await HistoryService.stampLastEdit(db, id, before, after);
        const stamp = await stampOf(id);
        assert.ok(stamp > 0, 'an addition must still update the last-edited time');
        assert.ok(Date.now() - stamp < 10_000, 'stamp is now, not some older change');
    } finally {
        await cleanup(id);
    }
});

test('lastEdit stamp: deleting and editing update it too', async () => {
    const id = 'stamp-del-' + Date.now();
    await cleanup(id);
    try {
        await HistoryService.stampLastEdit(db, id, cal(id, [ev('a', 'One'), ev('b', 'Two')]), cal(id, [ev('a', 'One')]));
        const afterDelete = await stampOf(id);
        assert.ok(afterDelete > 0);

        await new Promise(r => setTimeout(r, 20));
        await HistoryService.stampLastEdit(db, id, cal(id, [ev('a', 'One')]), cal(id, [ev('a', 'Renamed')]));
        assert.ok(await stampOf(id) >= afterDelete, 'an edit moves the stamp forward');
    } finally {
        await cleanup(id);
    }
});

test('lastEdit stamp: a no-op write does not move the time', async () => {
    const id = 'stamp-noop-' + Date.now();
    await cleanup(id);
    try {
        const same = cal(id, [ev('a', 'One')]);
        const r = await HistoryService.stampLastEdit(db, id, same, JSON.parse(JSON.stringify(same)));
        assert.equal(r, null, 'nothing changed, so nothing is stamped');
        assert.equal(await stampOf(id), null);
    } finally {
        await cleanup(id);
    }
});

test('lastEdit stamp: a title change counts as an edit', async () => {
    const id = 'stamp-title-' + Date.now();
    await cleanup(id);
    try {
        await HistoryService.stampLastEdit(db, id, cal(id, [ev('a', 'One')]), cal(id, [ev('a', 'One')], { title: 'Renamed' }));
        assert.ok(await stampOf(id) > 0, 'renaming the calendar is an edit');
    } finally {
        await cleanup(id);
    }
});

test('lastEdit stamp: clients cannot forge it', async () => {
    const id = 'stamp-rules-' + Date.now();
    const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
    const url = admin.app().options.databaseURL || '';
    let ns = null;
    try { const u = new URL(url); ns = u.searchParams.get('ns') || u.hostname.split('.')[0]; } catch (e) { /* */ }
    if (!ns) ns = `${admin.app().options.projectId || 'pastecal-web'}-default-rtdb`;

    await cleanup(id);
    try {
        await HistoryService.stampLastEdit(db, id, cal(id, [ev('a', 'One')]), cal(id, [ev('a', 'One'), ev('b', 'Two')]));
        const real = await stampOf(id);

        const put = await fetch(`http://${host}/history_meta/${id}/lastEditedAt.json?ns=${ns}`,
            { method: 'PUT', body: JSON.stringify(1) });
        assert.equal(put.status, 401, `client PUT to history_meta must be rejected (got ${put.status})`);
        assert.equal(await stampOf(id), real, 'the real stamp is untouched');
    } finally {
        await cleanup(id);
    }
});

test.after(async () => { await admin.app().delete(); });
