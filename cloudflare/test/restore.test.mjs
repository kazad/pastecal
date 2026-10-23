// Restore any earlier version (GET /api/pro/versions, /versions/preview, POST /versions/restore;
// RoomInsight.restoreVersion), against `wrangler dev` started as in stats.test.mjs with
// --persist-to $PERSIST. An older daily snapshot is seeded into the local R2 bucket with
// `wrangler r2 object put --local`, and backups are read back with `wrangler r2 object get --local`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8870', SECRET = process.env.IMPORT_SECRET || 'dev-secret', PERSIST = process.env.PERSIST;
assert.ok(PERSIST, 'set PERSIST to the --persist-to directory of the running wrangler dev');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const auth = { Authorization: `Bearer ${SECRET}` };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1 });

// wrangler r2 runs synchronously (execFileSync), and a kept-alive socket can be closed meanwhile:
// retry a request (up to 3 times: the pool may hold several dead sockets) when it fails at the connection.
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
    for (let i = 0; ; i++) { try { return await realFetch(...args); } catch (e) { if (i >= 3 || !['ECONNRESET', 'UND_ERR_SOCKET'].includes(e.cause?.code)) throw e; } }
};
let ipn = 0; const nextIp = () => `10.40.${Math.floor(++ipn / 200)}.${ipn % 200}`;   // non-loopback: the cookie is used
const post = (path, body, { cookie, origin = BASE } = {}) => fetch(BASE + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), 'CF-Connecting-IP': nextIp() } });
const get = (path, cookie) => fetch(BASE + path, { headers: { 'CF-Connecting-IP': nextIp(), ...(cookie ? { Cookie: cookie } : {}) } });
async function signIn(email) {
    assert.equal((await post('/api/auth/start', { email })).status, 200);
    const mails = (await (await fetch(`${BASE}/api/admin/accounts/outbox?email=${enc(email)}`, { headers: auth })).json()).emails;
    const token = mails.at(-1).text.match(/\/signin#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    assert.equal(r.status, 200);
    const userId = (await (await fetch(`${BASE}/api/admin/accounts/lookup?email=${enc(email)}`, { headers: auth })).json()).user.id;
    return { cookie: r.headers.get('set-cookie').split(';')[0], userId };
}
const wrangler = (...args) => execFileSync(process.execPath, ['node_modules/.bin/wrangler', 'r2', 'object', ...args, '--local', '--persist-to', PERSIST], { stdio: 'pipe' });
function r2get(key) {
    const file = `/tmp/restore-test-${process.pid}.json`; rmSync(file, { force: true });
    try { wrangler('get', `pastecal-backups/${key}`, '--file', file); return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
const waitFor = async (pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await pred(); if (v) return v; await sleep(400); } return null; };
const cal = async (id) => (await fetch(`${BASE}/cal/${enc(id)}`)).json();
function tab(id, headers) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(id)}/ws`, headers ? { headers } : undefined); const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const wait = async (pred) => { for (let i = 0; i < 300; i++) { const m = got.find(pred); if (m) return m; await sleep(20); } throw new Error('timed out: ' + JSON.stringify(got.slice(-2))); };
    let k = 0;
    const save = async (commands) => { const sid = `s${++k}`; ws.send(JSON.stringify({ t: 'save', id: sid, v: 0, commands })); return wait((m) => m.id === sid); };
    return { ws, got, wait, save, ready: wait((m) => m.t === 'snapshot') };
}

const owner = await signIn(`restore-owner-${run}@example.com`);
const id = `test-restore ${run} 강`;                           // a space and Hangul, like real names
const prefix = `snapshots/${enc(id)}/`;
let r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: 'Team', options: { notes: 'current notes', color: 'blue' }, events: [ev('a', 'first', 1)] }) });
assert.equal(r.status, 201, await r.text());

// 1. Free calendar: pro-only on every route.
for (const path of [`/api/pro/versions?calendar=${enc(id)}`, `/api/pro/versions/preview?calendar=${enc(id)}&date=${today}`]) {
    r = await get(path, owner.cookie);
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'pro-only' });
}
r = await post('/api/pro/versions/restore', { calendarId: id, date: today }, { cookie: owner.cookie });
assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'pro-only' });
step('free calendar: versions, preview and restore answer 403 {error:"pro-only"}');

// Lock it (Pro), then edit today so today's snapshot exists.
assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(id)}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ ownerId: owner.userId }) })).status, 200);
// (No view link: the directory makes them only for plain ASCII names. The calendar has none, so a
// restore must not pick up the snapshot's.)
const viewId = undefined;
const ownerTab = tab(id, { Cookie: owner.cookie, 'CF-Connecting-IP': nextIp() });
assert.equal((await ownerTab.ready).canEdit, true);
assert.equal((await ownerTab.save([{ type: 'add', event: ev('b', 'second', 2) }])).t, 'ack');
assert.equal((await ownerTab.save([{ type: 'add', event: ev('c', 'third', 3) }])).t, 'ack');
const original = await cal(id);
const todays = await waitFor(() => { const s = r2get(`${prefix}${today}.json`); return s && s.v === original.v ? s : null; });
assert.ok(todays, "today's backup with the latest version");

// Seed an older day the way an old backup looks: no events/savedAt in its metadata. Its savedAt is
// after the lock (as for a calendar locked weeks ago): only versions saved since the current lock are
// this owner's to see (M2). A second one, saved before the lock, must stay hidden.
const OLD = '2026-01-15', PRELOCK = '2026-01-10';
const lockedAt = (await (await fetch(`${BASE}/api/admin/cal/${enc(id)}/lock-status`, { headers: auth })).json()).lockedAt;
const oldSavedAt = new Date(lockedAt + 1000).toISOString();
const oldFile = `/tmp/restore-seed-${process.pid}.json`;
const seed = (key, body) => { writeFileSync(oldFile, JSON.stringify(body)); wrangler('put', `pastecal-backups/${key}`, '--file', oldFile, '--content-type', 'application/json'); };
seed(`${prefix}${OLD}.json`, { v: 1, savedAt: oldSavedAt, calendar: {
    id, title: 'Old title', options: { notes: 'old notes', publicViewId: 'bogus-old-view', color: 'red' }, events: [ev('o1', 'old one', 5), ev('o2', 'old two', 6)] } });
seed(`${prefix}${PRELOCK}.json`, { v: 1, savedAt: '2026-01-10T12:00:00.000Z', calendar: { id, title: 'Before the lock', options: {}, events: [ev('x1', 'not yours', 5)] } });

// 2. The list.
r = await get(`/api/pro/versions?calendar=${enc(id)}`, owner.cookie);
assert.equal(r.status, 200);
let versions = await r.json();
assert.deepEqual(versions.map((x) => x.date), [today, OLD], 'newest first');
const vToday = versions.find((x) => x.date === today), vOld = versions.find((x) => x.date === OLD);
assert.deepEqual(vToday, { date: today, day: today, kind: 'daily', v: original.v, events: 3, savedAt: todays.savedAt });
assert.equal(vOld.events, 2, 'an old object without metadata is read to count its events');
assert.equal(vOld.kind, 'daily'); assert.equal(vOld.savedAt, oldSavedAt);
step(`GET /api/pro/versions: [{date, day, kind, v, events, savedAt}] newest first; today from metadata (v${original.v}, 3 events), an old backup counted by reading it (2 events)`);

// 3. Preview.
r = await get(`/api/pro/versions/preview?calendar=${enc(id)}&date=${OLD}`, owner.cookie);
assert.equal(r.status, 200);
const pv = await r.json();
assert.equal(pv.calendar.title, 'Old title'); assert.equal(pv.calendar.events.length, 2); assert.equal(pv.date, OLD); assert.equal(pv.day, OLD); assert.equal(pv.v, 1);
assert.equal((await get(`/api/pro/versions/preview?calendar=${enc(id)}&date=2020-01-01`, owner.cookie)).status, 404);
assert.equal((await get(`/api/pro/versions/preview?calendar=${enc(id)}&date=../../x`, owner.cookie)).status, 400);
assert.equal((await get(`/api/pro/versions/preview?calendar=${enc(id)}&date=${PRELOCK}`, owner.cookie)).status, 404, 'saved before the lock: hidden');
r = await post('/api/pro/versions/restore', { calendarId: id, date: PRELOCK }, { cookie: owner.cookie });
assert.equal(r.status, 404); assert.equal((await r.json()).error, 'no-such-version');
step('preview returns the snapshot calendar; an unknown date is 404, a malformed one 400; a version saved before the lock is 404 (list, preview, restore)');

// 4. Only the owner, and restore needs CSRF headers.
const other = await signIn(`restore-other-${run}@example.com`);
r = await get(`/api/pro/versions?calendar=${enc(id)}`, other.cookie);
assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'not-owner' });
assert.equal((await get(`/api/pro/versions?calendar=${enc(id)}`)).status, 401);
assert.equal((await post('/api/pro/versions/restore', { calendarId: id, date: OLD }, { cookie: other.cookie })).status, 403);
r = await post('/api/pro/versions/restore', { calendarId: id, date: OLD }, { cookie: owner.cookie, origin: 'https://evil.example' });
assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'forbidden-origin' });
assert.equal((await get(`/cal/${enc(id)}/restore-version`)).status, 404);
assert.equal((await fetch(`${BASE}/cal/${enc(id)}/restore-version`, { method: 'POST', body: JSON.stringify({ version: OLD }) })).status, 404);
assert.equal((await cal(id)).v, original.v, 'nothing changed');
step('non-owner 403 not-owner, signed out 401, a foreign Origin 403 forbidden-origin; the room route is not reachable from outside');

// 5. Restore the old day.
const viewer = tab(id); await viewer.ready;
const histBefore = await (await fetch(`${BASE}/cal/${enc(id)}/history`)).json();
r = await post('/api/pro/versions/restore', { calendarId: id, date: OLD }, { cookie: owner.cookie });
assert.equal(r.status, 200);
const restored = await r.json();
assert.deepEqual(restored, { ok: true, v: original.v + 1, events: 2 });
let now = await cal(id);
assert.equal(now.v, original.v + 1, 'one version bump');
assert.deepEqual(now.calendar.events.map((e) => e.id), ['o1', 'o2']);
assert.equal(now.calendar.title, 'Old title');
assert.equal(now.calendar.options.notes, 'old notes');
assert.equal(now.calendar.options.color, 'blue', 'other options stay');
assert.equal(now.calendar.options.publicViewId, viewId, "the view link stays; the snapshot's is ignored");
assert.equal(now.locked, true);
const st = await (await fetch(`${BASE}/api/admin/cal/${enc(id)}/lock-status`, { headers: auth })).json();
assert.deepEqual([st.locked, st.ownerId], [true, owner.userId]);
step('restore replaces events, title and notes; v+1; other options, the view link and the lock (same owner) are untouched');

const ownerSnap = await ownerTab.wait((m) => m.t === 'snapshot' && m.v === restored.v);
assert.deepEqual(ownerSnap.calendar.events.map((e) => e.id), ['o1', 'o2']); assert.equal(ownerSnap.canEdit, true);
const viewerSnap = await viewer.wait((m) => m.t === 'snapshot' && m.v === restored.v);
assert.equal(viewerSnap.canEdit, false); assert.equal(viewerSnap.calendar.title, 'Old title');
assert.equal((await ownerTab.save([{ type: 'add', event: ev('p', 'after restore', 7) }])).t, 'ack', 'the owner still edits');
assert.equal((await ownerTab.save([{ type: 'remove', key: 'p' }])).t, 'ack');
step('open tabs get the restored snapshot (owner canEdit:true, a visitor canEdit:false); the owner keeps editing');

const hist = await (await fetch(`${BASE}/cal/${enc(id)}/history`)).json();
const entry = hist.find((h) => h.kind === 'restored');
assert.equal(hist.filter((h) => !histBefore.some((b) => b.key === h.key)).filter((h) => h.kind === 'restored').length, 1, 'one history entry for the restore');
assert.equal(entry.key, String(restored.v));
assert.equal(entry.label, `Restored the version from ${OLD}`);
assert.deepEqual([entry.removed, entry.added, entry.eventCount, entry.title], [3, 2, 3, 'Team'], 'counts and the old title');
assert.deepEqual([entry.removedEvents, entry.addedEvents, entry.changedEvents, entry.events], [[], [], [], undefined], 'no event lists (row size)');
step('history: ONE entry {kind:"restored", label:"Restored the version from 2026-01-15"} with counts only (the undo is the R2 restore point)');

// 6. Undo: the pre-restore state is a restore point in R2, even though today's backup gets overwritten.
const afterRestore = await cal(id);
const overwritten = await waitFor(() => { const s = r2get(`${prefix}${today}.json`); return s && s.v === afterRestore.v ? s : null; });
assert.deepEqual(overwritten.calendar.events.map((e) => e.id), ['o1', 'o2'], "today's backup now holds the restored state");
versions = await (await get(`/api/pro/versions?calendar=${enc(id)}`, owner.cookie)).json();
const point = versions.find((x) => x.kind === 'restore-point');
assert.ok(point, 'a restore point is listed');
assert.match(point.date, new RegExp(`^${today}T\\d{9}Z-[0-9a-f]{6}$`), 'to the millisecond, plus a random suffix');
assert.deepEqual([point.day, point.v, point.events], [today, original.v, 3]);
assert.equal(versions[0].date, today, 'newest first: today (saved after the restore), then the restore point');
assert.equal(versions[1].date, point.date);
r = await post('/api/pro/versions/restore', { calendarId: id, date: point.date }, { cookie: owner.cookie });
assert.equal(r.status, 429, 'within 5 s of the previous restore'); assert.deepEqual(await r.json(), { ok: false, error: 'too-soon' });
await sleep(5200);
r = await post('/api/pro/versions/restore', { calendarId: id, date: point.date }, { cookie: owner.cookie });
assert.equal(r.status, 200);
now = await cal(id);
assert.deepEqual(now.calendar.events, original.calendar.events);
assert.equal(now.calendar.title, 'Team'); assert.equal(now.calendar.options.notes, 'current notes');
assert.equal(now.calendar.options.publicViewId, viewId);
step(`undo: restoring the restore point ${point.date} (listed with v${point.v}, 3 events) brings back the exact pre-restore events, title and notes (a restore within 5 s of the last one is 429 too-soon)`);

r = await post('/api/pro/versions/restore', { calendarId: id, date: point.date }, { cookie: owner.cookie });
assert.deepEqual(await r.json(), { ok: true, unchanged: true, v: now.v });
assert.equal((await post('/api/pro/versions/restore', { calendarId: id, date: '2020-01-01' }, { cookie: owner.cookie })).status, 404);
assert.equal((await post('/api/pro/versions/restore', { calendarId: id, date: 'today' }, { cookie: owner.cookie })).status, 400);
step('restoring what is already there changes nothing (unchanged:true); an unknown date is 404, a malformed one 400');

// 8. A big calendar (2,500 events, about 1.2 MB) restored onto a disjoint one of the same size.
const big = `test-restore-big-${run}`, bigPrefix = `snapshots/${enc(big)}/`;
const pad = 'x'.repeat(380);
const many = (tag) => Array.from({ length: 2500 }, (_, i) => ({ ...ev(`${tag}${i}`, `${tag} ${i}`, 1 + (i % 28)), description: pad }));
r = await fetch(`${BASE}/cal/${enc(big)}/import`, { method: 'PUT', headers: auth, body: JSON.stringify({ id: big, title: 'Big', events: many('now') }) });
assert.equal(r.status, 200, await r.text());
assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(big)}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ ownerId: owner.userId }) })).status, 200);
writeFileSync(oldFile, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), calendar: { id: big, title: 'Big then', options: {}, events: many('old') } }));
wrangler('put', `pastecal-backups/${bigPrefix}2026-02-01.json`, '--file', oldFile, '--content-type', 'application/json');
r = await post('/api/pro/versions/restore', { calendarId: big, date: '2026-02-01' }, { cookie: owner.cookie });
assert.equal(r.status, 200, await r.text());
now = await cal(big);
assert.equal(now.calendar.events.length, 2500); assert.equal(now.calendar.events[0].id, 'old0'); assert.equal(now.calendar.title, 'Big then');
const bigEntry = (await (await fetch(`${BASE}/cal/${enc(big)}/history`)).json())[0];
assert.deepEqual([bigEntry.kind, bigEntry.removed, bigEntry.added], ['restored', 2500, 2500]);
step('a 2,500-event calendar (~1.2 MB) restores onto a disjoint one: all 2,500 replaced, one small history entry');

// A Pro calendar with two versions saved since its lock (A and B), for the checks below.
async function proCalendar(tag, ownerId = owner.userId) {
    const cid = `test-restore-${tag}-${run}`, p = `snapshots/${enc(cid)}/`;
    r = await fetch(`${BASE}/cal/${enc(cid)}`, { method: 'POST', body: JSON.stringify({ title: 'Now', events: [ev('n1', 'now', 1)] }) });
    assert.equal(r.status, 201, await r.text());
    assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(cid)}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ ownerId }) })).status, 200);
    const t = new Date().toISOString();
    seed(`${p}2026-03-01.json`, { v: 1, savedAt: t, calendar: { id: cid, title: 'Version A', options: {}, events: [ev('a1', 'a', 2)] } });
    seed(`${p}2026-03-02.json`, { v: 2, savedAt: t, calendar: { id: cid, title: 'Version B', options: {}, events: [ev('b1', 'b', 3), ev('b2', 'b', 4)] } });
    return { cid, p };
}
const restore = (cid, date, cookie = owner.cookie) => post('/api/pro/versions/restore', { calendarId: cid, date }, { cookie });
const points = async (cid, cookie = owner.cookie) => (await (await get(`/api/pro/versions?calendar=${enc(cid)}`, cookie)).json()).filter((x) => x.kind === 'restore-point');

// 9. Two restores at the same moment: one runs, the other is refused (429 too-soon) and writes
// nothing. A second restore after the gap gets its own restore point: names never collide, so both
// pre-restore states stay retrievable.
{
    const { cid } = await proCalendar('pair');
    const [r1, r2] = await Promise.all([restore(cid, '2026-03-01'), restore(cid, '2026-03-02')]);
    const res = [[r1.status, await r1.json()], [r2.status, await r2.json()]].sort((a, b) => a[0] - b[0]);
    assert.deepEqual(res.map((x) => x[0]), [200, 429]);
    assert.deepEqual(res[1][1], { ok: false, error: 'too-soon' });
    const first = await cal(cid);
    let pts = await points(cid);
    assert.equal(pts.length, 1, 'only the restore that ran wrote a restore point');
    await sleep(5200);
    const other = first.calendar.title === 'Version A' ? '2026-03-02' : '2026-03-01';
    assert.equal((await restore(cid, other)).status, 200);
    pts = await points(cid);
    assert.equal(pts.length, 2); assert.notEqual(pts[0].date, pts[1].date);
    const pre = await Promise.all(pts.map(async (x) => (await (await get(`/api/pro/versions/preview?calendar=${enc(cid)}&date=${x.date}`, owner.cookie)).json()).calendar.title));
    assert.deepEqual(pre.sort(), [first.calendar.title, 'Now'].sort(), 'each restore point holds the state its restore replaced');
    step(`two simultaneous restores: one 200, one 429 too-soon (nothing written); a later restore keeps its own point: both pre-states retrievable (${pre.join(', ')})`);
}

// 10. Limits: 10 restores per calendar per hour (429 too-many-restores), and only the newest 20
// restore points are kept (older points deleted after a successful restore; daily snapshots never).
{
    const { cid, p } = await proCalendar('limits');
    for (let i = 0; i < 15; i++) seed(`${p}2026-03-03T0000${String(i).padStart(2, '0')}000Z-aaaa${String(i).padStart(2, '0')}.json`,
        { v: 1, savedAt: new Date().toISOString(), restorePointFor: 'seeded', calendar: { id: cid, title: `seeded ${i}`, options: {}, events: [] } });
    const mine = [];
    for (let i = 0; i < 10; i++) {
        if (i) await sleep(5200);
        r = await restore(cid, i % 2 ? '2026-03-02' : '2026-03-01');
        assert.equal(r.status, 200, `restore ${i + 1}: ${await r.clone().text()}`);
        mine.push((await cal(cid)).v);
    }
    await sleep(5200);
    r = await restore(cid, '2026-03-01');
    assert.equal(r.status, 429); assert.deepEqual(await r.json(), { ok: false, error: 'too-many-restores' });
    const pts = await points(cid);
    assert.equal(pts.length, 20, 'newest 20 kept');
    assert.equal(pts.filter((x) => /-aaaa\d\d$/.test(x.date)).length, 10, 'the 5 oldest seeded points were deleted, the 10 real ones kept');
    for (const d of ['2026-03-01', '2026-03-02']) assert.ok(r2get(`${p}${d}.json`), `daily snapshot ${d} kept`);
    step('limits: the 11th restore within the hour is 429 too-many-restores; 25 restore points pruned to the newest 20 (10 real + 10 seeded); daily snapshots untouched');
}

// 11. Whose history: a new owner (reassign, or a new buyer) sees nothing saved before their lock;
// the earlier owner re-locking later starts over from their new lock too.
{
    const userB = await signIn(`restore-b-${run}@example.com`);
    const { cid, p } = await proCalendar('owners');
    assert.equal((await restore(cid, '2026-03-01')).status, 200);
    const aPoint = (await points(cid))[0];
    assert.ok(aPoint, "owner A's restore point");
    const relock = async (who) => {
        await fetch(`${BASE}/api/admin/cal/${enc(cid)}/unlock`, { method: 'POST', headers: auth, body: '{}' });
        await sleep(5);
        assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(cid)}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ ownerId: who.userId }) })).status, 200);
        return (await (await fetch(`${BASE}/api/admin/cal/${enc(cid)}/lock-status`, { headers: auth })).json()).lockedAt;
    };
    const atB = await relock(userB);
    let list = await (await get(`/api/pro/versions?calendar=${enc(cid)}`, userB.cookie)).json();
    assert.ok(list.every((x) => Date.parse(x.savedAt) >= atB), `B sees only versions saved since B's lock: ${JSON.stringify(list)}`);
    assert.ok(!list.some((x) => x.date === aPoint.date || x.date === '2026-03-01' || x.date === '2026-03-02'), "none of A's versions");
    assert.equal((await get(`/api/pro/versions/preview?calendar=${enc(cid)}&date=${aPoint.date}`, userB.cookie)).status, 404);
    await sleep(5200);
    r = await restore(cid, aPoint.date, userB.cookie);
    assert.equal(r.status, 404); assert.equal((await r.json()).error, 'no-such-version');
    assert.ok(r2get(`${p}${aPoint.date}.json`), "A's restore point is still in R2 (a backup), just not shown");
    const atA = await relock(owner);
    list = await (await get(`/api/pro/versions?calendar=${enc(cid)}`, owner.cookie)).json();
    assert.ok(list.every((x) => Date.parse(x.savedAt) >= atA) && !list.some((x) => x.date === aPoint.date), 'A re-locking sees only versions since the new lock');
    step("a new owner sees none of the previous owner's versions (list, preview, restore 404; still in R2); the first owner re-locking starts from the new lock too");
}

ownerTab.ws.close(); viewer.ws.close();
console.log(`\n${n} checks passed`); process.exit(0);
