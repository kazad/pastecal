// Live view links: a read-only WebSocket at /cal/view/<viewId>/ws, against `wrangler dev` (BASE, default
// http://localhost:8787, IMPORT_SECRET for the admin lock route). The view socket must get each edit at
// once, never carry the edit name, an editor key or the owner, never take a write, keep streaming while
// the calendar is locked or paused, and not open at all for a view id that does not exist.
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const WS = BASE.replace(/^http/, 'ws');
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const at = (d, h) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1 });
const admin = async (id, op, body) => {
    const r = await fetch(`${BASE}/api/admin/cal/${enc(id)}/${op}`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
};

function sock(url) {
    const ws = new WebSocket(url);
    const got = [], raw = [];
    ws.addEventListener('message', (e) => { raw.push(String(e.data)); got.push(JSON.parse(e.data)); });
    const closed = new Promise((r) => ws.addEventListener('close', (e) => r(e)));
    const failed = new Promise((r) => ws.addEventListener('error', () => r(true)));
    const waitFor = async (pred, ms = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await sleep(10); }
        throw new Error('timed out; got ' + JSON.stringify(got.slice(-3)));
    };
    const send = (m) => ws.send(JSON.stringify(m));
    let k = 0;
    const save = async (commands) => { const id = `s${++k}-${Math.random()}`; send({ t: 'save', id, v: 0, commands }); return waitFor((m) => m.id === id); };
    return { ws, got, raw, closed, failed, waitFor, send, save, ready: waitFor((m) => m.t === 'snapshot') };
}

// A distinctive edit name, so any frame that leaks it is easy to spot.
const id = `test-viewsock-EDITNAME-${Date.now()}`;
const OWNER = `owner-SECRETOWNER-${Date.now()}`;
let r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: 'Live view', options: { notes: 'Bring water.' }, events: [ev('a', 'first', 1)] }) });
assert.equal(r.status, 201, await r.text());
const view = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', body: JSON.stringify({ sourceCalendarId: id }) })).json();
assert.equal(view.ok, true, JSON.stringify(view));
const viewId = view.publicViewId;

// 1. The view socket's snapshot is the view JSON's calendar, under the view id.
const viewer = sock(`${WS}/cal/view/${enc(viewId)}/ws`);
const snap = await viewer.ready;
const viewGet = await (await fetch(`${BASE}/cal/view/${enc(viewId)}`)).json();
assert.deepEqual(snap.calendar, viewGet.calendar, 'the socket sends exactly the calendar GET /cal/view sends');
assert.equal(snap.calendar.id, viewId);
assert.equal(snap.calendar.options.notes, 'Bring water.', 'notes are part of the view (as in GET)');
assert.equal(snap.calendar.options.publicViewId, undefined);
assert.deepEqual([snap.canEdit, snap.role, snap.locked], [false, 'viewer', false]);
step('the view socket opens with the view copy (same calendar as GET /cal/view), canEdit:false, role viewer');

// 2. An edit reaches the viewer within a second.
const editor = sock(`${WS}/cal/${enc(id)}/ws`);
await editor.ready;
let t0 = Date.now();
const ack = await editor.save([{ type: 'add', event: ev('b', 'added live', 2) }]);
assert.equal(ack.t, 'ack');
const change = await viewer.waitFor((m) => m.t === 'change' && m.v === ack.v, 1000);
assert.equal(change.commands[0].event.title, 'added live');
step(`an edit reaches the view socket in ${Date.now() - t0} ms (limit 1000)`);

// Title and options changes too (meta), with publicViewId stripped.
editor.send({ t: 'meta', id: 'm1', title: 'Live view (renamed)', options: { notes: 'Bring water and snacks.' } });
const metaAck = await editor.waitFor((m) => m.id === 'm1');
const meta = await viewer.waitFor((m) => m.t === 'meta' && m.v === metaAck.v, 1000);
assert.equal(meta.title, 'Live view (renamed)'); assert.equal(meta.options.notes, 'Bring water and snacks.');
assert.equal(meta.options.publicViewId, undefined);
step('a title/notes change reaches the view socket, without publicViewId');

// 3. Writes on the view socket are refused and change nothing.
const before = await (await fetch(`${BASE}/cal/view/${enc(viewId)}`)).json();
assert.equal((await viewer.save([{ type: 'add', event: ev('x', 'from a viewer', 3) }])).code, 'read_only');
viewer.send({ t: 'meta', id: 'vm', title: 'hijacked' });
assert.equal((await viewer.waitFor((m) => m.id === 'vm')).code, 'read_only');
viewer.send({ t: 'auth', key: 'guess' });
const authAns = await viewer.waitFor((m) => m.t === 'auth');
assert.deepEqual([authAns.ok, authAns.canEdit], [false, false]);
const after = await (await fetch(`${BASE}/cal/view/${enc(viewId)}`)).json();
assert.deepEqual(after, before, 'nothing stored');
step('save, meta and an editor key on the view socket are refused (read_only); the calendar is unchanged');

// 4. Locked: editor-link writes still stream to the view; paused (Pro ended, read-only): the viewer is
//    told and stays connected.
const lock = await admin(id, 'lock', { ownerId: OWNER, plan: 'pro' });
assert.equal(lock.status, 200, JSON.stringify(lock.body));
const editorKey = lock.body.editorKey;
assert.ok(editorKey, 'lock hands out an editor key');
const lockedSnap = await viewer.waitFor((m) => m.t === 'snapshot' && m.locked === true);
assert.deepEqual([lockedSnap.canEdit, lockedSnap.role], [false, 'viewer']);
const keyed = sock(`${WS}/cal/${enc(id)}/ws`);
await keyed.ready;
keyed.send({ t: 'auth', key: editorKey });
assert.equal((await keyed.waitFor((m) => m.t === 'auth')).ok, true);
t0 = Date.now();
const lockedAck = await keyed.save([{ type: 'add', event: ev('c', 'added while locked', 4) }]);
assert.equal(lockedAck.t, 'ack');
await viewer.waitFor((m) => m.t === 'change' && m.v === lockedAck.v, 1000);
step(`locked: an editor link's save reaches the view socket in ${Date.now() - t0} ms`);

const unlock = await admin(id, 'unlock', { ownerId: OWNER, lapse: true });
assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
const pausedSnap = await viewer.waitFor((m) => m.t === 'snapshot' && m.paused === true);
assert.equal(pausedSnap.locked, false);
assert.ok(pausedSnap.calendar.events.some((e) => e.title === 'added while locked'));
assert.equal(viewer.ws.readyState, WebSocket.OPEN, 'the view socket stays open');
viewer.send({ t: 'hello' });
await viewer.waitFor((m) => m.t === 'snapshot' && m.paused === true && viewer.got.indexOf(m) > viewer.got.indexOf(pausedSnap));
step('paused after Pro: the view socket is told (snapshot paused:true) and keeps serving');

// 5. No frame on the view socket ever carried the edit name, a key, or the owner.
const all = viewer.raw.join('\n');
for (const secret of [id, 'EDITNAME', OWNER, 'SECRETOWNER', editorKey, 'editorKey', 'keyHash', 'key_hash', 'ownerId']) {
    assert.ok(!all.includes(secret), `a view frame leaked ${secret}`);
}
step(`${viewer.raw.length} view frames: no edit name, editor key, key hash or owner in any of them`);

// 6. A view id that does not exist (or an edit name used as one) opens nothing.
for (const bogus of [`nope-${Date.now()}`, id]) {
    const s = sock(`${WS}/cal/view/${enc(bogus)}/ws`);
    const ev1 = await Promise.race([s.closed, s.ready.then(() => 'opened', () => null)]);
    assert.notEqual(ev1, 'opened', `${bogus} opened a view socket`);
    assert.equal(s.got.length, 0);
}
assert.equal((await fetch(`${BASE}/cal/view/${enc(viewId)}/ws`)).status, 426, 'a plain GET on /ws is not a socket');
step('an unknown view id, or an edit name, is refused before any frame; a non-upgrade /ws answers 426');

// 7. Archived (the room is emptied): the view socket is closed and a new one is refused, as GET is.
const archived = await fetch(`${BASE}/cal/${enc(id)}/archive`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } });
assert.equal(archived.status, 200, await archived.text());
await Promise.race([viewer.closed, sleep(2000).then(() => { throw new Error('view socket not closed on archive'); })]);
const late = sock(`${WS}/cal/view/${enc(viewId)}/ws`);
assert.notEqual(await Promise.race([late.closed, late.ready.then(() => 'opened', () => null)]), 'opened', 'a view socket opened on an empty room');
step('archived: the view socket is closed, and a view socket to the emptied room is refused');

for (const s of [viewer, editor, keyed]) s.ws.close();
console.log(`view-socket: ${n} steps passed`);
