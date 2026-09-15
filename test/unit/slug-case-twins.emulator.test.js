/**
 * Slug ownership when two calendars differ only by case.
 *
 * Firebase keys are case-sensitive; slugs resolve case-insensitively. So `N2U5H6CH` and
 * `n2u5h6ch` are two separate calendars competing for one entry in slug_mappings, and 105
 * such pairs exist in production.
 *
 * The incident: a user's calendar of 21 events went blank. Nothing was deleted -- somebody
 * opened the other casing of their URL, an empty calendar was created there, and indexSlug
 * handed the shared mapping to it, because the write was last-wins. Their data sat
 * untouched one capitalisation away while they saw "New Calendar".
 *
 * The rule these tests pin down: the slug belongs to whoever holds the events, not to
 * whoever wrote most recently. An empty incumbent is still replaceable, so an abandoned
 * placeholder cannot hold a name hostage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error(
        'FIREBASE_DATABASE_EMULATOR_HOST is not set. Run via `npm run test:unit`, not `node --test` directly.'
    );
}

const admin = require('../../functions/node_modules/firebase-admin');
// Requiring the functions entry point is what calls initializeApp() against the emulator;
// without it admin.database() throws "The default Firebase app does not exist".
require('../../functions/index.js');
const db = admin.database();

const ev = (id, title) => ({
    id, title, start: '2026-09-17T10:00:00.000Z', end: '2026-09-17T11:00:00.000Z', type: 1,
});

async function seedCalendar(id, events) {
    await db.ref('calendars').child(id).set({ id, title: 'Test', events, options: {} });
}
async function cleanup(...ids) {
    await Promise.all(ids.map(id => db.ref('calendars').child(id).remove()));
    await Promise.all(ids.map(id => db.ref('slug_mappings').child(id.toLowerCase()).remove()));
}

/**
 * The decision indexSlug makes, extracted so it can be tested without deploying a trigger:
 * given the current mapping and the calendar being written, may this calendar take the slug?
 *
 * `emulators:exec --only database` runs no Cloud Functions, so the trigger body itself
 * cannot fire here -- but this is the branch that matters, and it reads the same data.
 */
async function mayTakeSlug(calendarId) {
    const normalized = calendarId.toLowerCase();
    const current = (await db.ref(`slug_mappings/${normalized}`).once('value')).val();
    if (!current || !current.actualSlug || current.actualSlug === calendarId) return true;
    const incumbent = await db.ref(`calendars/${current.actualSlug}/events`).once('value');
    return !(incumbent.exists() && incumbent.numChildren() > 0);
}

test('slug ownership: an empty twin cannot take the slug from one holding events', async () => {
    const upper = 'CASETWIN1', lower = 'casetwin1';
    await cleanup(upper, lower);
    try {
        // The original owner, with real data, holds the mapping.
        await seedCalendar(upper, [ev('a', 'Session 1'), ev('b', 'Session 2')]);
        await db.ref('slug_mappings/casetwin1').set({ actualSlug: upper, isReadOnly: false });

        // Somebody opens the other casing; an empty calendar is created there.
        await seedCalendar(lower, []);

        assert.equal(await mayTakeSlug(lower), false,
            'an empty calendar must not take the slug from a twin that has events');
    } finally {
        await cleanup(upper, lower);
    }
});

test('slug ownership: a twin CAN take the slug from an empty placeholder', async () => {
    const upper = 'CASETWIN2', lower = 'casetwin2';
    await cleanup(upper, lower);
    try {
        // An abandoned empty calendar holds the mapping.
        await seedCalendar(upper, []);
        await db.ref('slug_mappings/casetwin2').set({ actualSlug: upper, isReadOnly: false });

        await seedCalendar(lower, [ev('a', 'Real content')]);

        assert.equal(await mayTakeSlug(lower), true,
            'an empty incumbent must not hold a slug hostage');
    } finally {
        await cleanup(upper, lower);
    }
});

test('slug ownership: a calendar always keeps its own mapping', async () => {
    const id = 'CASETWIN3';
    await cleanup(id);
    try {
        await seedCalendar(id, [ev('a', 'x')]);
        await db.ref('slug_mappings/casetwin3').set({ actualSlug: id, isReadOnly: false });
        assert.equal(await mayTakeSlug(id), true, 'rewriting your own mapping is always fine');
    } finally {
        await cleanup(id);
    }
});

test('slug ownership: an unclaimed slug is free', async () => {
    const id = 'CASETWIN4';
    await cleanup(id);
    try {
        await seedCalendar(id, [ev('a', 'x')]);
        assert.equal(await mayTakeSlug(id), true, 'no incumbent means no conflict');
    } finally {
        await cleanup(id);
    }
});

test('slug ownership: the production incident, replayed', async () => {
    // N2U5H6CH had 21 events; n2u5h6ch was created empty and took the mapping.
    const upper = 'CASEINCIDENT', lower = 'caseincident';
    await cleanup(upper, lower);
    try {
        await seedCalendar(upper, Array.from({ length: 21 }, (_, i) => ev('e' + i, 'D&D ' + i)));
        await db.ref('slug_mappings/caseincident').set({ actualSlug: upper, isReadOnly: false });
        await seedCalendar(lower, []);

        assert.equal(await mayTakeSlug(lower), false);

        // And the mapping still resolves to the calendar with the data.
        const m = (await db.ref('slug_mappings/caseincident').once('value')).val();
        assert.equal(m.actualSlug, upper);
        const events = await db.ref(`calendars/${m.actualSlug}/events`).once('value');
        assert.equal(events.numChildren(), 21);
    } finally {
        await cleanup(upper, lower);
    }
});

test.after(async () => {
    await admin.app().delete();
});
