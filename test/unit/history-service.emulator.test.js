/**
 * Emulator-backed tests for HistoryService -- the server-side record of what a calendar
 * looked like before any write that removed or changed events.
 *
 * This is the floor under every other data-loss defence. The client-side ones (merge,
 * gate, local copy) all assume the client is correct, and the Sept 2026 incident (issues
 * #42-#44) was the client being wrong. These tests assert the two properties that make
 * the record trustworthy:
 *
 *   1. A destructive write is recorded with the full prior state, by the Admin SDK.
 *   2. No client can write to /history at all -- checked through the emulator's REST
 *      endpoint as an unauthenticated caller, so it exercises the real rules file, not a
 *      mock of it. If someone loosens database.rules.json, this fails.
 *
 * `emulators:exec --only database` runs no Cloud Functions, so HistoryService.record is
 * called directly, exactly as the recordHistory trigger calls it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error(
        'FIREBASE_DATABASE_EMULATOR_HOST is not set. Run via `npm run test:unit`, not `node --test` directly.'
    );
}

const admin = require('../../functions/node_modules/firebase-admin');
const { _internal } = require('../../functions/index.js');
const { HistoryService, HISTORY_ROOT, HISTORY_KEEP, HISTORY_ADDED_KEEP, HISTORY_HARD_CAP, HISTORY_PROTECT_MS } = _internal;

const db = admin.database();

const ev = (id, title) => ({
    id, title, start: '2026-09-17T10:00:00.000Z', end: '2026-09-17T11:00:00.000Z', type: 1,
});
const cal = (id, events, extra = {}) => ({ id, title: 'History Test', events, options: { defaultView: 'week' }, ...extra });

async function historyOf(id) {
    const snap = await db.ref(`${HISTORY_ROOT}/${id}`).once('value');
    const out = [];
    snap.forEach(c => { out.push({ key: c.key, ...c.val() }); });
    return out;
}
async function cleanup(...ids) {
    await Promise.all(ids.flatMap(id => [
        db.ref('calendars').child(id).remove(),
        db.ref(HISTORY_ROOT).child(id).remove(),
        db.ref(`${HISTORY_ROOT}_index`).child(id).remove(),
        db.ref(`${HISTORY_ROOT}_meta`).child(id).remove(),
        db.ref(`${HISTORY_ROOT}_archive`).child(id).remove(),
    ]));
}

// --- changeKind: pure classification --------------------------------------------------

test('HistoryService.changeKind: a create records nothing', () => {
    assert.equal(HistoryService.changeKind(null, cal('x', [ev('A', 'a')])), null);
});

test('HistoryService.changeKind: an add-only write is recorded as "added"', () => {
    // Additions used to record nothing, on the grounds that there is nothing to restore.
    // But the panel is a list of recent CHANGES: a user who adds an event and sees no
    // trace of it concludes the list is broken, which is what happened in production.
    const before = cal('x', [ev('A', 'a')]);
    const after = cal('x', [ev('A', 'a'), ev('B', 'b')]);
    const r = HistoryService.changeKind(before, after);
    assert.equal(r.kind, 'added');
    assert.equal(r.added, 1);
    assert.equal(r.removed, 0);
    assert.equal(r.changed, 0);
});

test('HistoryService.changeKind: a notes-only edit records nothing', () => {
    const before = cal('x', [ev('A', 'a')], { options: { notes: 'one' } });
    const after = cal('x', [ev('A', 'a')], { options: { notes: 'two' } });
    assert.equal(HistoryService.changeKind(before, after), null);
});

test('HistoryService.changeKind: removing every event is "wiped"', () => {
    const r = HistoryService.changeKind(cal('x', [ev('A', 'a'), ev('B', 'b')]), cal('x', []));
    assert.deepEqual(r, { kind: 'wiped', removed: 2, changed: 0, added: 0 });
});

test('HistoryService.changeKind: removing some is "shrunk", editing is "edited"', () => {
    const base = [ev('A', 'a'), ev('B', 'b'), ev('C', 'c')];
    assert.equal(HistoryService.changeKind(cal('x', base), cal('x', base.slice(1))).kind, 'shrunk');
    assert.equal(HistoryService.changeKind(cal('x', base), cal('x', [ev('A', 'renamed'), ...base.slice(1)])).kind, 'edited');
});

test('HistoryService.changeKind: a recurring master and its exception are distinct rows', () => {
    const master = { ...ev('R', 'series'), recurrencerule: 'FREQ=WEEKLY', recurrenceID: null };
    const exception = { ...ev('R', 'moved'), recurrencerule: 'FREQ=WEEKLY', recurrenceID: 'R' };
    // Dropping only the exception must count as one removal, not zero (id-only keying
    // would see "R" still present and record nothing).
    const r = HistoryService.changeKind(cal('x', [master, exception]), cal('x', [master]));
    assert.deepEqual(r, { kind: 'shrunk', removed: 1, changed: 0, added: 0 });
});

// --- record: the durable write ---------------------------------------------------------

test('HistoryService.record: wiping a calendar stores its full prior state', async () => {
    const id = 'hist-wipe-' + Date.now();
    await cleanup(id);
    try {
        const before = cal(id, [ev('A', 'Standup'), ev('B', 'Review'), ev('C', 'Retro')]);
        const key = await HistoryService.record(db, id, before, cal(id, []));
        assert.ok(key, 'a history entry was written');

        const [entry] = await historyOf(id);
        assert.equal(entry.kind, 'wiped');
        assert.equal(entry.eventCount, 3);
        assert.equal(entry.title, 'History Test');
        assert.deepEqual(entry.options, { defaultView: 'week' });
        // A wipe's removedEvents IS the prior state; it is not stored twice.
        assert.deepEqual(entry.removedEvents.map(e => e.title), ['Standup', 'Review', 'Retro']);
        assert.equal(entry.events, undefined);
        assert.ok(typeof entry.savedAt === 'number' && entry.savedAt > 0);
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: deleting the whole calendar node is recorded, in the archive', async () => {
    const id = 'hist-delete-' + Date.now();
    await cleanup(id);
    try {
        await HistoryService.record(db, id, cal(id, [ev('A', 'a')]), null);
        assert.deepEqual(await historyOf(id), [], 'nothing left where a newcomer at this slug would read');
        const archived = (await db.ref(`${HISTORY_ROOT}_archive/${id}`).once('value')).val();
        const entries = Object.values(Object.values(archived)[0]);
        const del = entries.find(e => e.kind === 'deleted');
        assert.equal(del.events.length, 1);
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: an addition is recorded, and names what arrived', async () => {
    const id = 'hist-add-' + Date.now();
    await cleanup(id);
    try {
        await HistoryService.record(db, id, cal(id, [ev('A', 'a')]), cal(id, [ev('A', 'a'), ev('B', 'New thing')]));
        const [entry] = await historyOf(id);
        assert.equal(entry.kind, 'added');
        assert.equal(entry.added, 1);
        // The stored snapshot is the state BEFORE, so the added event is named separately
        // -- otherwise the row could say "1 event added" and nothing more.
        assert.deepEqual((entry.addedEvents || []).map(e => e.title), ['New thing']);
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: a genuine no-op still records nothing', async () => {
    const id = 'hist-noop-' + Date.now();
    await cleanup(id);
    try {
        const same = cal(id, [ev('A', 'a')]);
        const r = await HistoryService.record(db, id, same, JSON.parse(JSON.stringify(same)));
        assert.equal(r, null);
        assert.deepEqual(await historyOf(id), []);
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.toTrim: destructive and added entries have separate budgets', () => {
    const now = 10 * HISTORY_PROTECT_MS;
    const old = now - 2 * HISTORY_PROTECT_MS;
    const destructive = Array.from({ length: HISTORY_KEEP + 5 }, (_, i) => ({ key: 'd' + i, k: 'shrunk', t: old + i }));
    const adds = Array.from({ length: HISTORY_ADDED_KEEP + 30 }, (_, i) => ({ key: 'a' + i, k: 'added', t: now - i }));
    const drop = new Set(HistoryService.toTrim([...destructive, ...adds], now));

    // A flood of additions, all newer than every destructive entry, evicts none of them.
    assert.equal(destructive.filter(e => drop.has(e.key)).length, 5, 'only the 5 oldest destructive entries go');
    assert.ok(!drop.has('d' + (HISTORY_KEEP + 4)), 'the newest destructive entry survives');
    assert.equal(adds.filter(e => !drop.has(e.key)).length, HISTORY_ADDED_KEEP);
});

test('HistoryService.toTrim: recent destructive entries survive a burst, up to the hard cap', () => {
    const now = 10 * HISTORY_PROTECT_MS;
    const recent = Array.from({ length: HISTORY_HARD_CAP + 10 }, (_, i) => ({ key: 'r' + i, k: 'edited', t: now - i }));
    const drop = HistoryService.toTrim(recent, now);
    assert.equal(drop.length, 10, 'everything inside the protection window is kept up to the cap');
    assert.ok(drop.every(k => Number(k.slice(1)) >= HISTORY_HARD_CAP), 'the oldest are the ones dropped');
});

test('HistoryService.record: twenty additions do not evict the snapshot of a wipe', async () => {
    const id = 'hist-flood-' + Date.now();
    await cleanup(id);
    try {
        const original = [ev('A', 'Precious'), ev('B', 'Also precious')];
        await HistoryService.record(db, id, cal(id, original), cal(id, []));
        let events = [];
        for (let i = 0; i < HISTORY_KEEP + 5; i++) {
            const next = [...events, ev('N' + i, 'noise ' + i)];
            await HistoryService.record(db, id, cal(id, events), cal(id, next));
            events = next;
        }
        const entries = await historyOf(id);
        const wipe = entries.find(e => e.kind === 'wiped');
        assert.ok(wipe, 'the wipe is still on file');
        assert.deepEqual(wipe.removedEvents.map(e => e.title), ['Precious', 'Also precious']);
        // Additions carry no snapshot: nothing was lost, and a copy per add is the cost.
        assert.ok(entries.filter(e => e.kind === 'added').every(e => e.events === undefined));
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: entries are deltas naming what was removed and changed', async () => {
    const id = 'hist-delta-' + Date.now();
    await cleanup(id);
    try {
        const a = ev('A', 'Keep'), b = ev('B', 'Gone'), c = ev('C', 'Before');
        await HistoryService.record(db, id, cal(id, [a, b, c]), cal(id, [a, { ...c, title: 'After' }]));
        const [entry] = await historyOf(id);
        assert.deepEqual(entry.removedEvents.map(e => e.title), ['Gone']);
        assert.equal(entry.changedEvents.length, 1);
        assert.equal(entry.changedEvents[0].from.title, 'Before');
        assert.equal(entry.changedEvents[0].to.title, 'After');
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: a drag is one entry, keeping the pre-gesture state', async () => {
    const id = 'hist-drag-' + Date.now();
    await cleanup(id);
    try {
        const at = (h) => ({ ...ev('A', 'Dragged'), start: `2026-09-17T${h}:00:00.000Z`, end: `2026-09-17T${h}:30:00.000Z` });
        await HistoryService.record(db, id, cal(id, [at('10')]), cal(id, [at('11')], { _writer: 'w1' }));
        await HistoryService.record(db, id, cal(id, [at('11')]), cal(id, [at('12')], { _writer: 'w1' }));
        await HistoryService.record(db, id, cal(id, [at('12')]), cal(id, [at('13')], { _writer: 'w1' }));
        const entries = await historyOf(id);
        assert.equal(entries.length, 1, 'three saves of one drag are one entry');
        assert.equal(entries[0].changedEvents[0].from.start, at('10').start, 'undo returns to before the drag');
        assert.equal(entries[0].changedEvents[0].to.start, at('13').start);
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: a collaborator\'s edit is never folded into my drag', async () => {
    const id = 'hist-drag-two-' + Date.now();
    await cleanup(id);
    try {
        const at = (h) => ({ ...ev('A', 'Dragged'), start: `2026-09-17T${h}:00:00.000Z`, end: `2026-09-17T${h}:30:00.000Z` });
        const t0 = Date.now();
        await HistoryService.record(db, id, cal(id, [at('10')]), cal(id, [at('11')], { _writer: 'alice' }), t0);
        await HistoryService.record(db, id, cal(id, [at('11')]), cal(id, [at('14')], { _writer: 'bob' }), t0 + 1000);
        const entries = (await historyOf(id)).sort((x, y) => x.savedAt - y.savedAt);
        assert.equal(entries.length, 2, 'two people, two entries');
        assert.deepEqual(entries.map(e => e.writer), ['alice', 'bob']);
        assert.equal(entries[0].changedEvents[0].to.start, at('11').start, 'my entry ends where I left it');
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: a save that also adds rows is never folded away', async () => {
    const id = 'hist-drag-add-' + Date.now();
    await cleanup(id);
    try {
        const at = (h) => ({ ...ev('A', 'Weekly'), start: `2026-09-17T${h}:00:00.000Z`, end: `2026-09-17T${h}:30:00.000Z` });
        const t0 = Date.now();
        await HistoryService.record(db, id, cal(id, [at('10')]), cal(id, [at('11')], { _writer: 'w1' }), t0);
        await HistoryService.record(db, id, cal(id, [at('11')]),
            cal(id, [at('12'), ev('X', 'Moved occurrence')], { _writer: 'w1' }), t0 + 1000);
        const entries = await historyOf(id);
        assert.equal(entries.length, 2);
        assert.ok(entries.some(e => (e.addedEvents || []).some(x => x.title === 'Moved occurrence')),
            'the added row is on record');
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: a calendar recreated at a deleted id does not inherit its history', async () => {
    const id = 'hist-reuse-' + Date.now();
    await cleanup(id);
    try {
        const t0 = Date.now();
        await HistoryService.record(db, id, cal(id, [ev('A', 'a'), ev('B', 'b')]), cal(id, [ev('A', 'a')]), t0);

        // Triggers arrive out of order: the newcomer's first edit is processed BEFORE the
        // old owner's deletion, which happened earlier.
        await HistoryService.record(db, id, cal(id, [ev('N', 'new')]), cal(id, []), t0 + 2000);
        await HistoryService.record(db, id, cal(id, [ev('A', 'Private to the first owner')]), null, t0 + 1000);

        const left = await historyOf(id);
        assert.equal(left.length, 1, 'only the newcomer\'s own entry remains');
        assert.ok(!JSON.stringify(left).includes('Private to the first owner'));
        assert.deepEqual(left[0].removedEvents.map(e => e.title), ['new']);

        const archived = (await db.ref(`${HISTORY_ROOT}_archive/${id}`).once('value')).val();
        const entries = Object.values(Object.values(archived)[0]);
        assert.ok(entries.some(e => e.kind === 'deleted'), 'kept for the operator');
        assert.ok(entries.some(e => e.kind === 'shrunk'), 'with the history before it');
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: drag saves processed out of order keep the final position', async () => {
    const id = 'hist-drag-order-' + Date.now();
    await cleanup(id);
    try {
        const at = (h) => ({ ...ev('A', 'Dragged'), start: `2026-09-17T${h}:00:00.000Z`, end: `2026-09-17T${h}:30:00.000Z` });
        const t0 = Date.now();
        await HistoryService.record(db, id, cal(id, [at('10')]), cal(id, [at('11')], { _writer: 'w1' }), t0);
        await HistoryService.record(db, id, cal(id, [at('12')]), cal(id, [at('13')], { _writer: 'w1' }), t0 + 1000);
        await HistoryService.record(db, id, cal(id, [at('11')]), cal(id, [at('12')], { _writer: 'w1' }), t0 + 500);   // late
        const [entry] = await historyOf(id);
        assert.equal(entry.changedEvents[0].from.start, at('10').start);
        assert.equal(entry.changedEvents[0].to.start, at('13').start, 'the late save did not rewind `to`');
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: an edit undone within the gesture window leaves no dead row', async () => {
    const id = 'hist-drag-back-' + Date.now();
    await cleanup(id);
    try {
        const at = (h) => ({ ...ev('A', 'Dragged'), start: `2026-09-17T${h}:00:00.000Z`, end: `2026-09-17T${h}:30:00.000Z` });
        const t0 = Date.now();
        await HistoryService.record(db, id, cal(id, [at('10')]), cal(id, [at('11')], { _writer: 'w1' }), t0);
        await HistoryService.record(db, id, cal(id, [at('11')]), cal(id, [at('10')], { _writer: 'w1' }), t0 + 1000);
        assert.deepEqual(await historyOf(id), [], 'a change that ended where it began is not a change');
    } finally {
        await cleanup(id);
    }
});

test('HistoryService.record: trimming reads the index, not the snapshots', async () => {
    const id = 'hist-bounded-' + Date.now();
    await cleanup(id);
    try {
        await HistoryService.record(db, id, cal(id, [ev('A', 'a'), ev('B', 'b')]), cal(id, [ev('A', 'a')]));
        const index = (await db.ref(`${HISTORY_ROOT}_index/${id}`).once('value')).val();
        const [row] = Object.values(index);
        assert.equal(row.k, 'shrunk');
        assert.ok(!('events' in row), 'the index carries no payload');
    } finally {
        await cleanup(id);
    }
});

// --- rules: clients cannot touch /history ---------------------------------------------

// The emulator applies database.rules.json to unauthenticated REST calls exactly as
// production does. The Admin SDK bypasses rules, so this is the only way to check them
// from here without a client SDK.
function restBase() {
    const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
    // Namespace = the database instance name. Derive it from the Admin app's URL so a
    // renamed instance does not silently point this test at an empty namespace.
    const url = admin.app().options.databaseURL || '';
    let ns = null;
    try {
        const u = new URL(url);
        ns = u.searchParams.get('ns') || u.hostname.split('.')[0];
    } catch (e) { /* fall through */ }
    if (!ns) ns = `${admin.app().options.projectId || 'pastecal-web'}-default-rtdb`;
    return { host, ns };
}

test('HistoryService rules: an unauthenticated client cannot write /history', async () => {
    const id = 'hist-rules-' + Date.now();
    const { host, ns } = restBase();
    await cleanup(id);
    try {
        // Seed a real entry as the server would.
        await HistoryService.record(db, id, cal(id, [ev('A', 'a')]), cal(id, []));
        const [entry] = await historyOf(id);

        const put = await fetch(`http://${host}/${HISTORY_ROOT}/${id}/forged.json?ns=${ns}`, {
            method: 'PUT', body: JSON.stringify({ savedAt: 1, events: [] }),
        });
        assert.equal(put.status, 401, `client PUT to /history must be rejected (got ${put.status})`);

        const del = await fetch(`http://${host}/${HISTORY_ROOT}/${id}/${entry.key}.json?ns=${ns}`, { method: 'DELETE' });
        assert.equal(del.status, 401, `client DELETE of a history entry must be rejected (got ${del.status})`);

        const wipeAll = await fetch(`http://${host}/${HISTORY_ROOT}/${id}.json?ns=${ns}`, { method: 'DELETE' });
        assert.equal(wipeAll.status, 401, `client DELETE of a calendar's history must be rejected (got ${wipeAll.status})`);

        // Still there, untouched.
        const after = await historyOf(id);
        assert.equal(after.length, 1);
        assert.equal(after[0].key, entry.key);
    } finally {
        await cleanup(id);
    }
});

test('HistoryService rules: anyone with the link can read /history (restore is symmetric with edit)', async () => {
    const id = 'hist-read-' + Date.now();
    const { host, ns } = restBase();
    await cleanup(id);
    try {
        await HistoryService.record(db, id, cal(id, [ev('A', 'a')]), cal(id, []));
        const get = await fetch(`http://${host}/${HISTORY_ROOT}/${id}.json?ns=${ns}`);
        assert.equal(get.status, 200);
        const body = await get.json();
        assert.equal(Object.keys(body).length, 1);
    } finally {
        await cleanup(id);
    }
});

// --- regressions found by adversarial review ------------------------------------------

test('HistoryService.changeKind: a legacy-shaped event rewritten by the current client is not an edit', () => {
    // Firebase drops ''/null-valued keys, so an event stored by an older client comes back
    // without description/repeat/recurrencerule/isAllDay -- while the current client
    // rebuilds it through Event's constructor with those present as ''/false. Comparing
    // with JSON.stringify called that a change, so a notes-only edit on any legacy
    // calendar recorded every event as "edited" and pushed a full snapshot.
    const stored = { id: 'a', title: 'T', start: 'S', end: 'E', type: 1 };
    const rebuilt = {
        id: 'a', title: 'T', description: '', repeat: '', recurrencerule: '',
        start: 'S', end: 'E', type: 1, recurrenceID: null, recurrenceException: null, isAllDay: false,
    };
    assert.equal(HistoryService.sameEvent(stored, rebuilt), true);
    assert.equal(HistoryService.changeKind(cal('x', [stored]), cal('x', [rebuilt])), null);
});

test('HistoryService.changeKind: a real edit is still caught', () => {
    const a = { id: 'a', title: 'T', start: 'S', end: 'E', type: 1 };
    assert.equal(HistoryService.changeKind(cal('x', [a]), cal('x', [{ ...a, title: 'CHANGED' }])).kind, 'edited');
    assert.equal(HistoryService.changeKind(cal('x', [a]), cal('x', [{ ...a, start: 'OTHER' }])).kind, 'edited');
});

// The Admin SDK holds its RTDB socket open, so without this the process lingers ~150s
// after the last assertion and `node --test` never advances to the next file. Three files
// without it turned a 3-second suite into an 8-minute one that then timed out and reported
// a false failure. See the same teardown in ics-device-buckets.emulator.test.js.
test.after(async () => {
    await admin.app().delete();
});
