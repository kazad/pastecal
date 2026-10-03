/**
 * The calendar-name rule and the calendar-node allow-list, as the real database rules
 * enforce them, plus the server sides of the claim/share flow.
 *
 * Writes go through the emulator's REST endpoint unauthenticated, as any browser's would;
 * the Admin SDK (which bypasses rules) only seeds and reads back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error('FIREBASE_DATABASE_EMULATOR_HOST is not set. Run via `npm run test:unit`.');
}

const admin = require('../../functions/node_modules/firebase-admin');
const fns = require('../../functions/index.js');
const { PublicViewService, HistoryService } = fns._internal;
const db = admin.database();
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const ns = (() => {
    try {
        const u = new URL(admin.app().options.databaseURL || '');
        return u.searchParams.get('ns') || u.hostname.split('.')[0];
    } catch (e) { return 'pastecal-web-default-rtdb'; }
})();

async function rest(method, path, body) {
    const res = await fetch(`http://${host}/${path}.json?ns=${ns}`, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.status;
}
const val = async (p) => (await db.ref(p).once('value')).val();
const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const cal = (id, extra = {}) => ({ id, title: 'T', events: [{ id: 'e', title: 'x' }], options: { notes: '' }, ...extra });

test.after(() => admin.app().delete());

test('slug rules: a valid lowercase name can be created by a browser', async () => {
    const id = uniq('ok');
    try {
        assert.equal(await rest('PUT', `calendars/${id}`, cal(id, { _writer: 'w1' })), 200);
    } finally { await db.ref(`calendars/${id}`).remove(); }
});

test('slug rules: new calendars outside the rule are refused', async () => {
    const bad = ['ab', 'a'.repeat(51), 'Mixed-Case-Cal', 'nativecal', 'view', 'api', 'components'];
    for (const id of bad) {
        assert.equal(await rest('PUT', `calendars/${id}`, cal(id)), 401, `${id} must be refused`);
        assert.equal(await val(`calendars/${id}`), null);
    }
});

test('slug rules: a node must name itself, so "x/y" cannot create calendar x', async () => {
    const x = uniq('xx');
    try {
        assert.equal(await rest('PUT', `calendars/${x}/y`, { title: 'junk' }), 401);
        assert.equal(await rest('PUT', `calendars/${x}`, cal('someone-else')), 401);
        assert.equal(await val(`calendars/${x}`), null);
    } finally { await db.ref(`calendars/${x}`).remove(); }
});

test('slug rules: no junk keys inside an existing calendar ("<existing>/notes")', async () => {
    const id = uniq('victim');
    await db.ref(`calendars/${id}`).set(cal(id));
    try {
        assert.equal(await rest('PUT', `calendars/${id}/notes`, 'planted'), 401);
        assert.equal(await rest('PATCH', `calendars/${id}`, { junk: 1 }), 401);
        assert.equal(await val(`calendars/${id}/notes`), null);
        // What clients actually write still lands: a whole-node sync and a field update.
        assert.equal(await rest('PUT', `calendars/${id}`, cal(id, {
            title: 'Renamed', _writer: 'w2', _gesture: 'g1', _undoOf: ['k1'],
        })), 200);
        assert.equal(await rest('PATCH', `calendars/${id}`, { title: 'Again', _writer: 'w2', _undoOf: null, _gesture: null }), 200);
        assert.equal(await rest('PUT', `calendars/${id}/options/notes`, 'hello'), 200);
        assert.equal(await val(`calendars/${id}/title`), 'Again');
    } finally { await db.ref(`calendars/${id}`).remove(); }
});

test('slug rules: legacy calendars (mixed case, odd keys) stay fully editable', async () => {
    const id = 'Legacy' + uniq('Cal');
    // Created under the old rule, carrying a key no current client writes.
    await db.ref(`calendars/${id}`).set({ ...cal(id), legacyField: { kept: true } });
    try {
        const whole = { ...cal(id, { title: 'Edited' }), legacyField: { kept: true }, _writer: 'w' };
        assert.equal(await rest('PUT', `calendars/${id}`, whole), 200, 'a full sync carrying the old key');
        assert.equal(await val(`calendars/${id}/title`), 'Edited');
        assert.equal(await rest('DELETE', `calendars/${id}/legacyField`), 200, 'junk can always be cleaned up');
    } finally { await db.ref(`calendars/${id}`).remove(); }
});

test('slug rules: customizing a view link replaces it -- the old link stops serving', async () => {
    const calId = uniq('owner');
    const oldView = uniq('oldview');
    const c = cal(calId, { options: { publicViewId: oldView } });
    await db.ref().update({
        [`calendars/${calId}`]: c,
        [`calendars_readonly/${oldView}`]: PublicViewService.mirrorOf(c, oldView),
        [`${PublicViewService.BINDINGS}/${oldView}`]: calId,
        [`${PublicViewService.BY_CALENDAR}/${calId}/${oldView}`]: true,
    });
    const custom = uniq('Team-View').toLowerCase();
    try {
        const r = await fns.createPublicLink.run({ data: { sourceCalendarId: calId, customSlug: custom.toUpperCase() } });
        assert.equal(r.publicViewId, custom, 'stored lowercase');
        assert.deepEqual(r.retired, [oldView]);
        assert.equal(await val(`calendars_readonly/${oldView}`), null);
        assert.equal(await val(`${PublicViewService.BINDINGS}/${oldView}`), null);
        assert.equal(await val(`calendars/${calId}/options/publicViewId`), custom);
        assert.equal(await val(`${PublicViewService.BINDINGS}/${custom}`), calId);

        await assert.rejects(() => fns.createPublicLink.run({ data: { sourceCalendarId: calId, customSlug: 'nativecal' } }),
            (e) => e.code === 'invalid-argument' && /reserved/.test(e.message));
    } finally {
        await db.ref().update({
            [`calendars/${calId}`]: null, [`calendars_readonly/${custom}`]: null,
            [`${PublicViewService.BINDINGS}/${custom}`]: null, [`${PublicViewService.BY_CALENDAR}/${calId}`]: null,
        });
    }
});

test('slug rules: creating a calendar is not "Edited just now"; nor is the server minting its view', async () => {
    const id = uniq('fresh');
    try {
        await HistoryService.stampLastEdit(db, id, null, cal(id));
        assert.equal(await val(`history_meta/${id}/lastEditedAt`), null, 'creation is not an edit');
        const before = cal(id);
        const after = cal(id, { options: { notes: '', publicViewId: 'v1', publicViewSource: 'generated' } });
        await HistoryService.stampLastEdit(db, id, before, after);
        assert.equal(await val(`history_meta/${id}/lastEditedAt`), null, 'bookkeeping is not an edit');
        await HistoryService.stampLastEdit(db, id, after, { ...after, title: 'Changed' });
        assert.ok((await val(`history_meta/${id}/lastEditedAt`)) > 0, 'a real change still stamps');
    } finally { await db.ref(`history_meta/${id}`).remove(); }
});
