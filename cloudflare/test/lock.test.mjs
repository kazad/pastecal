// Pro lock (CalendarRoom lock table + Worker gates), against `wrangler dev` started with
//   --var COPY_BACK: --var FIREBASE_DB_URL:http://127.0.0.1:9 --var UNSAFE_DEV_SESSION_HEADER:on
// The last one lets X-Dev-Session-User stand in for a signed-in session (sessionUserId), so the
// owner path can be tested before accounts exist. Lock operations go through the IMPORT_SECRET
// admin route, which calls the same internal room routes the billing code will.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const at = (d, h) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1 });
const enc = encodeURIComponent;
const auth = { Authorization: `Bearer ${SECRET}` };

const admin = async (id, op, body) => {
    const r = await fetch(`${BASE}/api/admin/cal/${enc(id)}/${op}`, op === 'lock-status' ? { headers: auth } : { method: 'POST', headers: auth, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (id) => (await fetch(`${BASE}/cal/${enc(id)}`)).json();

function tab(id, { headers, query = '' } = {}) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(id)}/ws${query}`, headers ? { headers } : undefined);
    const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const waitFor = async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await sleep(20); }
        throw new Error('timed out; got ' + JSON.stringify(got.slice(-3)));
    };
    const send = (m) => ws.send(JSON.stringify(m));
    let k = 0;
    const save = async (commands) => { const sid = `s${++k}-${Math.random()}`; send({ t: 'save', id: sid, v: 0, commands }); return waitFor((m) => m.id === sid); };
    const meta = async (fields) => { const sid = `m${++k}-${Math.random()}`; send({ t: 'meta', id: sid, ...fields }); return waitFor((m) => m.id === sid); };
    const authKey = async (key) => { const before = got.length; send({ t: 'auth', key }); return waitFor((m) => m.t === 'auth' && got.indexOf(m) >= before); };
    const lastSnapshot = () => [...got].reverse().find((m) => m.t === 'snapshot');
    return { ws, got, waitFor, send, save, meta, authKey, lastSnapshot, ready: waitFor((m) => m.t === 'snapshot') };
}

const id = `test-lock-${Date.now()}`;
const OWNER = `owner-${Date.now()}`;

// 1. Unlocked: exactly as today, plus booleans that say so.
let r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: 'Team', options: { pro: true, locked: true, ownerId: 'x' }, events: [ev('a', 'first', 1)] }) });
assert.equal(r.status, 201, await r.text());
let cal = await get(id);
assert.deepEqual([cal.locked, cal.pro], [false, false]);
assert.equal(cal.calendar.options.pro, undefined, 'a client cannot grant itself pro through options');
assert.equal(cal.calendar.options.locked, undefined);
const anon0 = tab(id); let snap = await anon0.ready;
assert.deepEqual([snap.locked, snap.pro, snap.canEdit], [false, false, true]);
assert.equal((await anon0.save([{ type: 'add', event: ev('b', 'second', 2) }])).t, 'ack');
assert.equal((await anon0.meta({ options: { pro: true, color: 'blue' } })).t, 'ack');
cal = await get(id);
assert.equal(cal.calendar.events.length, 2); assert.equal(cal.calendar.options.color, 'blue'); assert.equal(cal.calendar.options.pro, undefined);
step('an unlocked calendar saves as before; snapshot says locked:false, pro:false, canEdit:true; lock-ish option keys from clients are dropped');

// 2. The lock routes cannot be reached from outside.
for (const [method, suffix] of [['POST', 'lock'], ['POST', 'unlock'], ['POST', 'rotate-editor-key'], ['GET', 'lock-status'], ['POST', 'can-edit'], ['POST', 'set-view-id']]) {
    const rr = await fetch(`${BASE}/cal/${enc(id)}/${suffix}`, { method, ...(method === 'POST' ? { body: JSON.stringify({ ownerId: 'attacker', publicViewId: 'x' }) } : {}) });
    assert.ok(rr.status === 404 || rr.status === 403, `${method} /cal/<id>/${suffix} answered ${rr.status}`);
}
for (const op of ['lock', 'unlock', 'rotate-editor-key']) {
    assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(id)}/${op}`, { method: 'POST', body: '{"ownerId":"attacker"}' })).status, 403);
    assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(id)}/${op}`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{"ownerId":"attacker"}' })).status, 403);
}
assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(id)}/lock-status`)).status, 403);
// Calendars NAMED like routes: /cal/lock is the calendar "lock", never the lock route of anything.
for (const name of ['lock', 'lock-status', 'import']) {
    const c = await fetch(`${BASE}/cal/${name}`, { method: 'POST', body: JSON.stringify({ ownerId: 'attacker', plan: 'pro', title: name }) });
    assert.ok(c.status === 201 || c.status === 409, `create ${name}: ${c.status}`);
    const st = await admin(name, 'lock-status');
    assert.equal(st.body.locked, false, `${name} got locked by a public POST`);
}
const ls = await fetch(`${BASE}/cal/lock-status`);
assert.equal((await ls.json()).ownerId, undefined, 'GET /cal/lock-status is just the calendar "lock-status"');
const imp = await fetch(`${BASE}/cal/import`, { method: 'PUT', body: JSON.stringify({ id: 'import', title: 'hijacked', events: [] }) });
assert.notEqual(imp.status, 200, 'PUT /cal/import (no secret) must not replace the calendar named "import"');
assert.equal((await get('import')).calendar.title, 'import');
step('lock, unlock, rotate-editor-key, lock-status, can-edit, set-view-id are 404/403 from outside; the admin route needs the secret; calendars named "lock"/"lock-status"/"import" are just calendars');

// 3. Lock.
assert.equal((await admin(`test-lock-missing-${Date.now()}`, 'lock', { ownerId: OWNER, plan: 'pro' })).status, 404);
const locked = await admin(id, 'lock', { ownerId: OWNER, plan: 'pro' });
assert.equal(locked.status, 200); assert.equal(locked.body.ok, true);
const KEY = locked.body.editorKey;
assert.match(KEY, /^[A-Za-z0-9_-]{22}$/, '128-bit base64url key');
const KEY_HASH = createHash('sha256').update(KEY).digest('hex');
let st = await admin(id, 'lock-status');
assert.equal(st.body.locked, true); assert.equal(st.body.ownerId, OWNER); assert.equal(st.body.plan, 'pro'); assert.ok(st.body.lockedAt > 0);
const again = await admin(id, 'lock', { ownerId: OWNER, plan: 'pro' });
assert.equal(again.body.ok, true); assert.equal(again.body.alreadyLocked, true); assert.equal(again.body.editorKey, undefined);
const other = await admin(id, 'lock', { ownerId: 'someone-else', plan: 'pro' });
assert.equal(other.status, 409); assert.equal(other.body.error, 'locked-by-other');
step('lock returns a one-time 128-bit editor key; lock-status reports owner/plan/lockedAt; re-lock by the owner is ok with no key; another owner gets 409 locked-by-other; a missing calendar 404');

// 4. Anyone else: read, never write.
snap = await anon0.waitFor((m) => m.t === 'snapshot' && m.locked);
assert.deepEqual([snap.locked, snap.pro, snap.canEdit], [true, true, false]);
const before = await get(id);
let res = await anon0.save([{ type: 'add', event: ev('c', 'sneaky', 3) }]);
assert.deepEqual([res.t, res.code], ['error', 'locked']);
res = await anon0.meta({ title: 'pwned', options: { color: 'red' } });
assert.deepEqual([res.t, res.code], ['error', 'locked']);
const anon = tab(id); snap = await anon.ready;
assert.deepEqual([snap.locked, snap.canEdit, snap.calendar.events.length], [true, false, 2]);
assert.equal((await anon.save([{ type: 'remove', key: 'a' }])).code, 'locked');
const viaQuery = tab(id, { query: `?key=${enc(KEY)}` }); snap = await viaQuery.ready;
assert.equal(snap.canEdit, false, 'a key in the URL grants nothing');
let after = await get(id);
assert.equal(after.v, before.v); assert.deepEqual(after.calendar, before.calendar);
step('locked: a tab open before the lock is told (locked:true, canEdit:false); saves and meta from tabs without a key are refused {t:error, code:locked}; nothing changes; ?key= in a URL grants nothing');

// 5. Editor key over the socket.
res = await anon.authKey('not-the-key');
assert.deepEqual([res.ok, res.canEdit], [false, false]);
res = await anon.authKey(KEY);
assert.deepEqual([res.ok, res.canEdit, res.locked], [true, true, true]);
assert.equal((await anon.save([{ type: 'add', event: ev('k', 'by editor', 4) }])).t, 'ack');
const editor2 = tab(id); await editor2.ready; await editor2.authKey(KEY);
step('a wrong key is refused; the editor key ({t:auth,key}) is accepted and that tab can save');

// 6. A client's own X-PC-User is ignored; the owner via a (dev) session can write.
const spoof = tab(id, { headers: { 'X-PC-User': OWNER } }); snap = await spoof.ready;
assert.equal(snap.canEdit, false);
assert.equal((await spoof.save([{ type: 'add', event: ev('x', 'spoofed', 5) }])).code, 'locked');
const owner = tab(id, { headers: { 'X-Dev-Session-User': OWNER } }); snap = await owner.ready;
assert.equal(snap.canEdit, true);
assert.equal((await owner.save([{ type: 'add', event: ev('o', 'by owner', 6) }])).t, 'ack');
const notOwner = tab(id, { headers: { 'X-Dev-Session-User': 'someone-else' } }); snap = await notOwner.ready;
assert.equal(snap.canEdit, false);
assert.equal((await owner.meta({ options: { pro: false, locked: false, ownerId: 'me', color: 'green' } })).t, 'ack');
cal = await get(id);
assert.equal(cal.calendar.options.color, 'green'); assert.equal(cal.calendar.options.locked, undefined); assert.equal(cal.locked, true);
step('X-PC-User sent by a client is ignored; the owner (session user = ownerId) can save; another signed-in user cannot; lock-ish options from even the owner are dropped');

// 7. Every other write path refuses a locked calendar.
const v0 = (await get(id)).v;
r = await fetch(`${BASE}/cal/${enc(id)}/from-firebase`, { method: 'PUT', headers: auth, body: JSON.stringify({ id, title: 'from fb', events: [] }) });
let body = await r.json();
assert.equal(body.ok, false); assert.equal(body.error, 'locked');
r = await fetch(`${BASE}/cal/${enc(id)}/import`, { method: 'PUT', headers: auth, body: JSON.stringify({ id, title: 'imported', events: [] }) });
body = await r.json();
assert.equal(r.status, 423); assert.equal(body.error, 'locked');
r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: 'replaced', events: [] }) });
assert.equal(r.status, 409);
r = await fetch(`${BASE}/api/create-view`, { method: 'POST', body: JSON.stringify({ sourceCalendarId: id }) });
assert.equal(r.status, 403); assert.equal((await r.json()).error, 'locked');
r = await fetch(`${BASE}/createPublicLink`, { method: 'POST', body: JSON.stringify({ data: { sourceCalendarId: id, editorKey: 'wrong' } }) });
assert.equal(r.status, 403);
r = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'X-PC-User': OWNER }, body: JSON.stringify({ sourceCalendarId: id }) });
assert.equal(r.status, 403, 'X-PC-User from a client does not authorize create-view');
cal = await get(id);
assert.equal(cal.v, v0); assert.equal(cal.calendar.options.publicViewId, undefined);
r = await fetch(`${BASE}/api/create-view`, { method: 'POST', body: JSON.stringify({ sourceCalendarId: id, editorKey: KEY }) });
body = await r.json();
assert.equal(r.status, 200, JSON.stringify(body)); assert.ok(body.publicViewId);
const VIEW = body.publicViewId;
await owner.waitFor((m) => m.t === 'meta' && m.options?.publicViewId === VIEW);
assert.equal((await get(id)).calendar.options.publicViewId, VIEW);
r = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'X-Dev-Session-User': OWNER }, body: JSON.stringify({ sourceCalendarId: id }) });
assert.equal(r.status, 200, 'the owner (session) may make a view link');
step('locked: /from-firebase refused (ok:false, error:locked), /import 423, POST create 409, create-view 403 without a key (and a client X-PC-User does not count); with the editor key or the owner session it works and records publicViewId');

// 8. No one can take over a locked calendar's view link or its name.
const thief = `test-lock-thief-${Date.now()}`;
r = await fetch(`${BASE}/cal/${enc(thief)}`, { method: 'POST', body: JSON.stringify({ title: 'thief', options: { publicViewId: VIEW, renamedFrom: id }, events: [ev('t', 'fake', 7)] }) });
assert.equal(r.status, 201);
await sleep(300);
let view = await (await fetch(`${BASE}/cal/view/${enc(VIEW)}`)).json();
assert.ok(view.calendar.events.some((e) => e.title === 'by owner'), 'the view link still shows the locked calendar');
r = await fetch(`${BASE}/cal/${enc(id.toUpperCase())}`, { method: 'POST', body: JSON.stringify({ title: 'case thief', events: [] }) });
assert.equal(r.status, 201);
await sleep(300);
const lk = await (await fetch(`${BASE}/api/lookup?slug=${enc(id)}`)).json();
assert.equal(lk.actualSlug, id, 'the name still leads to the locked calendar, not its case variant');
// A case variant can't take an unlocked calendar's lookup either (red team, Oct 24 2026), and locking keeps it.
const claim = `test-lock-claim-${Date.now()}`;
assert.equal((await fetch(`${BASE}/cal/${enc(claim)}`, { method: 'POST', body: JSON.stringify({ title: 'real', events: [] }) })).status, 201);
await sleep(300);
assert.equal((await fetch(`${BASE}/cal/${enc(claim.toUpperCase())}`, { method: 'POST', body: JSON.stringify({ title: 'variant', events: [] }) })).status, 201);
await sleep(300);
assert.equal((await (await fetch(`${BASE}/api/lookup?slug=${enc(claim)}`)).json()).actualSlug, claim, 'before the lock: the original keeps the lookup');
assert.equal((await admin(claim, 'lock', { ownerId: OWNER })).status, 200);
await sleep(300);
assert.equal((await (await fetch(`${BASE}/api/lookup?slug=${enc(claim)}`)).json()).actualSlug, claim, 'after the lock: still the original');
r = await fetch(`${BASE}/cal/${enc(claim)}/archive`, { method: 'POST', headers: auth });
assert.deepEqual(await r.json(), { ok: false, error: 'locked' }, 'a locked calendar is never archived');
assert.equal((await get(claim)).calendar.title, 'real');
await admin(claim, 'unlock', {});
step('a new calendar carrying a locked calendar\'s publicViewId (the rename path), or a case variant of its name, does not re-point the view link or the name, locked or not');

// 9. No key material or owner id anywhere public.
const leaks = [];
for (const [what, url, init] of [
    ['GET /cal', `/cal/${enc(id)}`], ['history', `/cal/${enc(id)}/history`], ['authors', `/cal/${enc(id)}/authors`],
    ['lookup', `/api/lookup?slug=${enc(id)}`], ['lookupCalendar', '/lookupCalendar', { method: 'POST', body: JSON.stringify({ data: { slug: id } }) }],
    ['ICS', `/${enc(id)}.ics`], ['view ICS', `/view/${enc(VIEW)}.ics`], ['view', `/cal/view/${enc(VIEW)}`]]) {
    const text = await (await fetch(BASE + url, init)).text();
    for (const secret of [KEY, KEY_HASH, OWNER]) if (text.includes(secret)) leaks.push(`${what} contains ${secret === OWNER ? 'ownerId' : 'key material'}`);
}
for (const m of [...anon.got, ...owner.got, ...spoof.got]) for (const secret of [KEY, KEY_HASH, OWNER]) if (JSON.stringify(m).includes(secret)) leaks.push(`ws ${m.t} leaks`);
assert.deepEqual(leaks, []);
const hist = await (await fetch(`${BASE}/cal/${enc(id)}/history`)).json();
assert.ok(hist.some((h) => h.kind === 'locked' && h.label === 'Upgraded with Plus'));
step('no editor key, key hash or ownerId in GET /cal, history, authors, lookups, ICS, the view, or any socket message; history shows "Upgraded with Plus"');

// 10. Rotation: the old key stops working at once, including on sockets already authenticated.
assert.equal((await admin(id, 'rotate-editor-key', { ownerId: 'someone-else' })).status, 403);
const rot = await admin(id, 'rotate-editor-key', { ownerId: OWNER });
assert.equal(rot.body.ok, true);
const KEY2 = rot.body.editorKey;
assert.notEqual(KEY2, KEY); assert.match(KEY2, /^[A-Za-z0-9_-]{22}$/);
res = await anon.waitFor((m) => m.t === 'auth' && m.reason === 'key-rotated');
assert.deepEqual([res.ok, res.canEdit], [false, false]);
assert.equal((await anon.save([{ type: 'add', event: ev('late', 'after rotate', 8) }])).code, 'locked');
assert.equal((await editor2.save([{ type: 'add', event: ev('late2', 'after rotate', 8) }])).code, 'locked');
const fresh = tab(id); await fresh.ready;
assert.equal((await fresh.authKey(KEY)).ok, false, 'the old key is refused');
assert.equal((await fresh.authKey(KEY2)).ok, true);
assert.equal((await fresh.save([{ type: 'add', event: ev('n', 'new key', 9) }])).t, 'ack');
assert.equal((await owner.save([{ type: 'add', event: ev('o2', 'owner still', 9) }])).t, 'ack');
const relock = await admin(id, 'lock', { ownerId: OWNER, rotate: true });
assert.ok(relock.body.editorKey && relock.body.editorKey !== KEY2, 'lock with rotate:true rotates');
assert.equal((await fresh.save([{ type: 'remove', key: 'n' }])).code, 'locked');
const keyed3 = tab(id); await keyed3.ready;
assert.equal((await keyed3.authKey(relock.body.editorKey)).ok, true);
step('rotate-editor-key: wrong owner 403; old-key sockets are told (auth ok:false, key-rotated) and can no longer save; the old key is refused; the new one works; the owner is unaffected');

// 11. Unlock: back to the free plan, world-editable, with everything in it.
assert.equal((await admin(id, 'unlock', { ownerId: 'someone-else' })).status, 409);
const evCount = (await get(id)).calendar.events.length;
assert.equal((await admin(id, 'unlock', { ownerId: OWNER })).body.ok, true);
snap = await anon.waitFor((m) => m.t === 'snapshot' && m.locked === false);
assert.deepEqual([snap.pro, snap.canEdit], [false, true]);
assert.equal((await anon.save([{ type: 'add', event: ev('free', 'free again', 10) }])).t, 'ack');
cal = await get(id);
assert.equal(cal.locked, false); assert.equal(cal.calendar.events.length, evCount + 1);
assert.equal((await admin(id, 'lock-status')).body.locked, false);
assert.equal((await admin(id, 'unlock', {})).body.alreadyUnlocked, true);
assert.ok((await (await fetch(`${BASE}/cal/${enc(id)}/history`)).json()).some((h) => h.kind === 'unlocked' && h.label === 'Unlocked'));
r = await fetch(`${BASE}/cal/${enc(id)}/import`, { method: 'PUT', headers: auth, body: JSON.stringify({ id, title: 'Team', options: cal.calendar.options, events: cal.calendar.events }) });
assert.equal(r.status, 200);
// Changed deliberately (security review #7): an unlock PAUSES editor links instead of revoking them.
// A re-lock by the same owner turns them back on (no new key is made); a lock by anyone else revokes them.
const reopened = tab(id); await reopened.ready;
assert.equal((await reopened.authKey(relock.body.editorKey)).ok, true, 'while unlocked, a paused link still names itself');
const l2 = await admin(id, 'lock', { ownerId: OWNER });
assert.equal(l2.body.ok, true); assert.equal(l2.body.editorKey, null, 'same owner: the paused link comes back, no new one');
assert.equal((await keyed3.save([{ type: 'add', event: ev('back', 'paused link works again', 11) }])).t, 'ack');
assert.equal((await reopened.save([{ type: 'add', event: ev('back2', 'opened while unlocked', 11) }])).t, 'ack');
assert.equal((await fresh.save([{ type: 'add', event: ev('stale', 'rotated-away key', 11) }])).code, 'locked', 'a key rotated away before the unlock stays dead');
await admin(id, 'unlock', {});
const l3 = await admin(id, 'lock', { ownerId: 'new-owner-' + OWNER });
assert.ok(l3.body.editorKey, 'a new owner starts with one fresh link');
res = await keyed3.waitFor((m) => m.t === 'auth' && m.reason === 'link-revoked');
assert.deepEqual([res.ok, res.canEdit], [false, false]);
assert.equal((await keyed3.save([{ type: 'add', event: ev('stale2', 'old owner link', 12) }])).code, 'locked');
const late = tab(id); await late.ready;
res = await late.authKey(relock.body.editorKey);
assert.deepEqual([res.ok, res.reason], [false, 'link-revoked'], 'a tab opened later with that key is told it was revoked');
await admin(id, 'unlock', {});
const l4 = await admin(id, 'lock', { ownerId: OWNER, createLink: false });
assert.equal(l4.body.editorKey, null, 'createLink:false (billing) makes no link');
assert.equal((await late.authKey(relock.body.editorKey)).ok, false, 'the old owner coming back does not revive links a new owner revoked');
await admin(id, 'unlock', {});
step('unlock (wrong owner 409): every tab is told locked:false, canEdit:true, anyone can save again, events kept, history shows "Unlocked", /import works; links are paused: the same owner re-locking turns them back on, a new owner revokes them (tabs told link-revoked)');

for (const t of [anon0, anon, viaQuery, editor2, spoof, owner, notOwner, fresh, keyed3, reopened, late]) t.ws.close();
console.log(`\n${n} checks passed`); process.exit(0);
