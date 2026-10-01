/**
 * The calendar_authors security rules, exercised against the real rules file.
 *
 * This data is read by a human during a takeover to decide who owns a calendar, so the
 * rules are the only thing standing between "evidence" and "whatever the attacker typed".
 * The original rules only type-checked, so a browser could write
 * {createdHere: true, firstSeen: 0, days: {365 keys}, editCount: 1e9} under its own uid
 * and outrank the real owner. Each test here pins one of the constraints that closed
 * that, as an authenticated client would hit it -- the Admin SDK bypasses rules, so
 * writes go through the emulator's REST endpoint with an unsigned ID token (`?auth=`).
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
// Initializes the Admin app against the emulator, exactly as the other emulator suites do.
require('../../functions/index.js');

const db = admin.database();
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const ns = (() => {
    try {
        const u = new URL(admin.app().options.databaseURL || '');
        return u.searchParams.get('ns') || u.hostname.split('.')[0];
    } catch (e) {
        return 'pastecal-web-default-rtdb';
    }
})();

const TS = { '.sv': 'timestamp' };
const INC = (n) => ({ '.sv': { increment: n } });
const today = () => new Date().toISOString().slice(0, 10);

// The emulator accepts unsigned (alg: none) tokens, which is what lets a test act as a
// specific anonymous uid. A Bearer header would be treated as an admin and skip rules.
function token(uid) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const iat = Math.floor(Date.now() / 1000);
    return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({
        sub: uid, user_id: uid, iat, exp: iat + 3600,
        aud: 'pastecal-web', iss: 'https://securetoken.google.com/pastecal-web',
        firebase: { sign_in_provider: 'anonymous' },
    }) + '.';
}

async function rest(method, path, uid, body) {
    const auth = uid ? `&auth=${token(uid)}` : '';
    const res = await fetch(`http://${host}/${path}.json?ns=${ns}${auth}`, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.status;
}

const authorPath = (cal, uid) => `calendar_authors/${cal}/${uid}`;
const record = async (cal, uid) => (await db.ref(authorPath(cal, uid)).once('value')).val();

/** The update the client sends on an ordinary touch. */
function touchUpdate({ withFirstSeen = false } = {}) {
    const u = { lastSeen: TS, editCount: INC(1), [`days/${today()}`]: TS };
    if (withFirstSeen) u.firstSeen = TS;
    return u;
}

let seq = 0;
async function freshCalendar() {
    const id = `author-rules-${Date.now()}-${seq++}`;
    await db.ref(`calendars/${id}`).set({ id, title: 't', events: [] });
    return id;
}

async function cleanup(id) {
    await Promise.all([
        db.ref(`calendars/${id}`).remove(),
        db.ref(`calendar_authors/${id}`).remove(),
        db.ref(`history/${id}`).remove(),
    ]);
}

// --- the legitimate client path must keep working ------------------------------------

test('author rules: an ordinary first touch and later touches are accepted', async () => {
    const cal = await freshCalendar();
    try {
        assert.equal(await rest('PATCH', authorPath(cal, 'u1'), 'u1', touchUpdate({ withFirstSeen: true })), 200);
        assert.equal(await rest('PATCH', authorPath(cal, 'u1'), 'u1', touchUpdate()), 200);
        const r = await record(cal, 'u1');
        assert.equal(r.editCount, 2);
        assert.equal(typeof r.firstSeen, 'number');
        assert.ok(r.lastSeen >= r.firstSeen);
        assert.equal(typeof r.days[today()], 'number', 'a day is stamped with server time, not `true`');
    } finally {
        await cleanup(cal);
    }
});

test('author rules: re-sending firstSeen on an existing record is rejected, then the plain touch lands', async () => {
    // The client cannot read this node, so on its first touch of a session it sends
    // firstSeen optimistically and retries without it -- both halves must behave.
    const cal = await freshCalendar();
    try {
        assert.equal(await rest('PATCH', authorPath(cal, 'u1'), 'u1', touchUpdate({ withFirstSeen: true })), 200);
        const first = (await record(cal, 'u1')).firstSeen;
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(await rest('PATCH', authorPath(cal, 'u1'), 'u1', touchUpdate({ withFirstSeen: true })), 401);
        assert.equal(await rest('PATCH', authorPath(cal, 'u1'), 'u1', touchUpdate()), 200);
        assert.equal((await record(cal, 'u1')).firstSeen, first, 'firstSeen must never move');
    } finally {
        await cleanup(cal);
    }
});

test('author rules: a pre-hardening record (days: true, createdHere) still accepts ordinary touches', async () => {
    const cal = await freshCalendar();
    try {
        await db.ref(authorPath(cal, 'u1')).set({
            firstSeen: 1, lastSeen: 2, editCount: 7, createdHere: true, days: { '2026-01-01': true },
        });
        assert.equal(await rest('PATCH', authorPath(cal, 'u1'), 'u1', touchUpdate()), 200);
        assert.equal((await record(cal, 'u1')).editCount, 8);
    } finally {
        await cleanup(cal);
    }
});

// --- the forgery from the report -----------------------------------------------------

test('author rules: the forged owner record is rejected outright', async () => {
    const cal = await freshCalendar();
    try {
        const days = {};
        for (let i = 1; i <= 28; i++) days[`2025-02-${String(i).padStart(2, '0')}`] = true;
        const status = await rest('PUT', authorPath(cal, 'mallory'), 'mallory', {
            createdHere: true, firstSeen: 0, lastSeen: 0, editCount: 1e9, days,
        });
        assert.equal(status, 401);
        assert.equal(await record(cal, 'mallory'), null);
    } finally {
        await cleanup(cal);
    }
});

test('author rules: firstSeen cannot be backdated on creation, or moved afterwards', async () => {
    const cal = await freshCalendar();
    try {
        assert.equal(await rest('PATCH', authorPath(cal, 'm'), 'm', { ...touchUpdate(), firstSeen: 0 }), 401);
        assert.equal(await rest('PATCH', authorPath(cal, 'm'), 'm', touchUpdate({ withFirstSeen: true })), 200);
        assert.equal(await rest('PATCH', authorPath(cal, 'm'), 'm', { ...touchUpdate(), firstSeen: 0 }), 401);
        assert.equal(await rest('PUT', `${authorPath(cal, 'm')}/firstSeen`, 'm', 0), 401);
    } finally {
        await cleanup(cal);
    }
});

test('author rules: lastSeen must be the server clock', async () => {
    const cal = await freshCalendar();
    try {
        assert.equal(await rest('PATCH', authorPath(cal, 'm'), 'm',
            { ...touchUpdate({ withFirstSeen: true }), lastSeen: Date.now() + 86400000 }), 401);
    } finally {
        await cleanup(cal);
    }
});

test('author rules: editCount starts at 1 and moves by exactly 1 per write', async () => {
    const cal = await freshCalendar();
    try {
        const p = authorPath(cal, 'm');
        assert.equal(await rest('PATCH', p, 'm', { ...touchUpdate({ withFirstSeen: true }), editCount: 1e9 }), 401);
        assert.equal(await rest('PATCH', p, 'm', touchUpdate({ withFirstSeen: true })), 200);
        assert.equal(await rest('PATCH', p, 'm', { ...touchUpdate(), editCount: INC(5) }), 401);
        assert.equal(await rest('PATCH', p, 'm', { ...touchUpdate(), editCount: 1e9 }), 401);
        // Every write must count as one edit, so lastSeen/days cannot be refreshed for free.
        assert.equal(await rest('PATCH', p, 'm', { lastSeen: TS }), 401);
        assert.equal(await rest('PUT', `${p}/days/${today()}`, 'm', TS), 401);
        assert.equal((await record(cal, 'm')).editCount, 1);
    } finally {
        await cleanup(cal);
    }
});

test('author rules: a day must be a YYYY-MM-DD key stamped with server time', async () => {
    const cal = await freshCalendar();
    try {
        const p = authorPath(cal, 'm');
        const base = touchUpdate({ withFirstSeen: true });
        delete base[`days/${today()}`];
        assert.equal(await rest('PATCH', p, 'm', { ...base, 'days/not-a-day': TS }), 401);
        assert.equal(await rest('PATCH', p, 'm', { ...base, 'days/2025-01-01': true }), 401);
        assert.equal(await rest('PATCH', p, 'm', { ...base, 'days/2025-01-01': 1735689600000 }), 401);
        // A past-dated KEY is accepted (rules cannot format a date), but its value is the
        // server's clock -- which is what authors.js counts. 365 keys in one write all
        // carry the same timestamp and so count as one day.
        assert.equal(await rest('PATCH', p, 'm', { ...base, 'days/2025-01-01': TS, 'days/2025-01-02': TS }), 200);
        const days = (await record(cal, 'm')).days;
        assert.equal(days['2025-01-01'], days['2025-01-02']);
    } finally {
        await cleanup(cal);
    }
});

test('author rules: unknown fields are rejected', async () => {
    const cal = await freshCalendar();
    try {
        assert.equal(await rest('PATCH', authorPath(cal, 'm'), 'm',
            { ...touchUpdate({ withFirstSeen: true }), owner: true }), 401);
    } finally {
        await cleanup(cal);
    }
});

// --- createdHere -----------------------------------------------------------------------

test('author rules: createdHere cannot be claimed on a calendar that already exists', async () => {
    const cal = await freshCalendar();
    try {
        assert.equal(await rest('PATCH', authorPath(cal, 'm'), 'm',
            { ...touchUpdate({ withFirstSeen: true }), createdHere: true }), 401);
        // Nor added later to a record that already exists.
        assert.equal(await rest('PATCH', authorPath(cal, 'm'), 'm', touchUpdate({ withFirstSeen: true })), 200);
        assert.equal(await rest('PATCH', authorPath(cal, 'm'), 'm', { ...touchUpdate(), createdHere: true }), 401);
    } finally {
        await cleanup(cal);
    }
});

function creationWrite(cal, uid) {
    return {
        [`calendars/${cal}`]: { id: cal, title: 'new', events: [] },
        [authorPath(cal, uid)]: {
            firstSeen: TS, lastSeen: TS, editCount: 1, createdHere: true, days: { [today()]: TS },
        },
    };
}

test('author rules: createdHere is accepted in the same write that creates the calendar', async () => {
    const cal = `author-rules-create-${Date.now()}`;
    try {
        assert.equal(await rest('PATCH', '', 'u1', creationWrite(cal, 'u1')), 200);
        const r = await record(cal, 'u1');
        assert.equal(r.createdHere, true);
        assert.equal(r.editCount, 1);
        assert.ok((await db.ref(`calendars/${cal}`).once('value')).exists());
    } finally {
        await cleanup(cal);
    }
});

test('author rules: deleting and recreating a calendar does not earn createdHere', async () => {
    // Anyone can delete a calendar (open wiki), so "does not exist right now" alone would
    // let an attacker wipe it and recreate it as its creator. Its history survives the
    // delete, and createdHere requires there be none.
    const cal = `author-rules-recreate-${Date.now()}`;
    try {
        await db.ref(`history/${cal}`).push({ savedAt: 1, events: [] });
        assert.equal(await rest('PATCH', '', 'm', creationWrite(cal, 'm')), 401);
        assert.equal(await record(cal, 'm'), null);
    } finally {
        await cleanup(cal);
    }
});

// --- scope ------------------------------------------------------------------------------

test('author rules: a browser can write only its own uid, and never read or delete', async () => {
    const cal = await freshCalendar();
    try {
        assert.equal(await rest('PATCH', authorPath(cal, 'u2'), 'u1', touchUpdate({ withFirstSeen: true })), 401);
        assert.equal(await rest('PATCH', authorPath(cal, 'u1'), null, touchUpdate({ withFirstSeen: true })), 401);
        assert.equal(await rest('PATCH', authorPath(cal, 'u1'), 'u1', touchUpdate({ withFirstSeen: true })), 200);
        assert.equal(await rest('GET', authorPath(cal, 'u1'), 'u1'), 401);
        // Deleting would let a browser reset firstSeen/editCount and start a "clean" record.
        assert.equal(await rest('DELETE', authorPath(cal, 'u1'), 'u1'), 401);
    } finally {
        await cleanup(cal);
    }
});

test('author rules: no record for a calendar that does not exist', async () => {
    // The homepage holds an unsaved random id; authorship of nothing is noise.
    const cal = `author-rules-missing-${Date.now()}`;
    assert.equal(await rest('PATCH', authorPath(cal, 'u1'), 'u1', touchUpdate({ withFirstSeen: true })), 401);
});

test.after(async () => {
    await admin.app().delete();
});
