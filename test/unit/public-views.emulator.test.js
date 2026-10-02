/**
 * Read-only ("public") views, through the deployed Cloud Function entry points.
 *
 * Every fix to createPublicLink / syncPublicView / removePublicView shipped with no test:
 * the emulator suite runs `--only database`, so no trigger ever fired, and the unit tests
 * called PublicViewService directly -- never the handlers that decide WHEN it runs and on
 * WHAT input. These tests call the exported functions themselves via firebase-functions'
 * `.run()` (the handler, minus the wire decoding), with real DataSnapshots read from the
 * Database emulator.
 *
 *   1. createPublicLink must refuse a path-shaped sourceCalendarId. "atk/<view id>" used to
 *      plant public_views_by_calendar/atk/<view id>, which removePublicView then read as one
 *      of atk's views -- deleting someone else's view so its URL could be re-claimed.
 *   2. removePublicView must delete only views whose binding names the deleted calendar;
 *      the by-calendar reverse map is a hint anyone can (or once could) pollute.
 *   3. syncPublicView must fire on CREATE: a rename writes the copy as a new node, and the
 *      view has to move to it at once, or deleting the old calendar deletes the view.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error(
        'FIREBASE_DATABASE_EMULATOR_HOST is not set. Run via `npm run test:unit` ' +
        '(wraps this in `firebase emulators:exec --only database`), not `node --test` directly.'
    );
}

const admin = require('../../functions/node_modules/firebase-admin');
const fns = require('../../functions/index.js');
const { PublicViewService } = fns._internal;
const db = admin.database();

const BINDINGS = PublicViewService.BINDINGS;
const BY_CAL = PublicViewService.BY_CALENDAR;
const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const val = async (path) => (await db.ref(path).once('value')).val();
const missing = { val: () => null, exists: () => false };

const ev = (id, title) => ({
    id, title, start: '2026-09-17T10:00:00.000Z', end: '2026-09-17T11:00:00.000Z', type: 1,
});

/** A view `pvid` published from calendar `calId`, bound the way createPublicLink binds it. */
async function seedView(calId, pvid, title = 'Original') {
    const cal = { id: calId, title, events: [ev('a', 'One')], options: { publicViewId: pvid } };
    await db.ref().update({
        [`calendars/${calId}`]: cal,
        [`calendars_readonly/${pvid}`]: PublicViewService.mirrorOf(cal, pvid),
        [`${BINDINGS}/${pvid}`]: calId,
        [`${BY_CAL}/${calId}/${pvid}`]: true,
    });
    return cal;
}

async function cleanup(calIds, pvids) {
    const del = {};
    for (const c of calIds) { del[`calendars/${c}`] = null; del[`${BY_CAL}/${c}`] = null; }
    for (const p of pvids) { del[`calendars_readonly/${p}`] = null; del[`${BINDINGS}/${p}`] = null; }
    await db.ref().update(del);
}

test('public views: createPublicLink refuses a path-shaped sourceCalendarId', async () => {
    const atk = uniq('atk');
    const victimView = uniq('victimview');
    // The attacker controls their own calendar, so they can make calendars/<atk>/<victim>
    // exist -- which is all a missing id check needs for the lookup to "find a calendar".
    await db.ref(`calendars/${atk}`).set({
        id: atk, title: 'mine', events: [], options: {},
        [victimView]: { title: 'planted', events: [] },
    });
    try {
        await assert.rejects(
            () => fns.createPublicLink.run({ data: { sourceCalendarId: `${atk}/${victimView}` } }),
            (err) => err.code === 'invalid-argument',
        );
        assert.equal(await val(`${BY_CAL}/${atk}`), null,
            'nothing may be planted under the attacker\'s by-calendar map');
        // ...and an ordinary id still works, so the refusal is not just "everything fails".
        const { publicViewId } = await fns.createPublicLink.run({ data: { sourceCalendarId: atk } });
        assert.equal(await val(`${BINDINGS}/${publicViewId}`), atk);
        await cleanup([], [publicViewId]);
    } finally {
        await cleanup([atk], []);
    }
});

test('public views: removePublicView deletes only views bound to the deleted calendar', async () => {
    const atk = uniq('atk');
    const victim = uniq('victim');
    const own = uniq('ownview');
    const victimView = uniq('victimview');
    await seedView(atk, own);
    await seedView(victim, victimView, 'Victim');
    // The reverse map names the victim's view too (how it got there does not matter: an
    // older createPublicLink, a renamed copy that later moved on, a bad migration).
    await db.ref(`${BY_CAL}/${atk}/${victimView}`).set(true);
    try {
        await db.ref(`calendars/${atk}`).remove();
        await fns.removePublicView.run({ params: { calendarId: atk }, data: await db.ref(`calendars/${atk}/id`).once('value') });

        assert.equal(await val(`calendars_readonly/${own}`), null, 'its own view is removed');
        assert.equal(await val(`${BINDINGS}/${own}`), null);
        assert.equal(await val(`${BY_CAL}/${atk}`), null);
        assert.equal((await val(`calendars_readonly/${victimView}`))?.title, 'Victim',
            'a view bound to another calendar survives');
        assert.equal(await val(`${BINDINGS}/${victimView}`), victim);
    } finally {
        await cleanup([atk, victim], [own, victimView]);
    }
});

test('public views: syncPublicView fires on create, so a renamed copy takes the view at once', async () => {
    // Declared as a write trigger (create, update AND delete) on the whole calendar node. An
    // onValueUpdated trigger never sees the copy a rename creates.
    const trigger = fns.syncPublicView.__endpoint.eventTrigger;
    assert.equal(trigger.eventType, 'google.firebase.database.ref.v1.written');
    assert.equal(trigger.eventFilterPathPatterns?.ref ?? trigger.eventFilters?.ref, 'calendars/{calendarId}');

    const oldId = uniq('old');
    const newId = uniq('new');
    const pvid = uniq('view');
    await seedView(oldId, pvid);
    try {
        const copy = {
            id: newId, title: 'Renamed', events: [ev('a', 'One'), ev('b', 'Two')],
            options: { publicViewId: pvid, renamedFrom: oldId },
        };
        await db.ref(`calendars/${newId}`).set(copy);
        await fns.syncPublicView.run({
            params: { calendarId: newId },
            data: { before: missing, after: await db.ref(`calendars/${newId}`).once('value') },
            time: new Date().toISOString(),
        });

        assert.equal(await val(`${BINDINGS}/${pvid}`), newId, 'the binding follows the copy');
        assert.equal(await val(`${BY_CAL}/${newId}/${pvid}`), true);
        assert.equal(await val(`${BY_CAL}/${oldId}/${pvid}`), null);
        const mirror = await val(`calendars_readonly/${pvid}`);
        assert.equal(mirror.title, 'Renamed');
        assert.equal(mirror.events.length, 2);
        assert.equal(mirror.options.renamedFrom, undefined, 'the editable id is never published');

        // The rename then deletes the old calendar; the view must survive it.
        await db.ref(`calendars/${oldId}`).remove();
        await fns.removePublicView.run({ params: { calendarId: oldId } });
        assert.equal((await val(`calendars_readonly/${pvid}`))?.title, 'Renamed');
    } finally {
        await cleanup([oldId, newId], [pvid]);
    }
});

test.after(async () => {
    await admin.app().delete();
});
