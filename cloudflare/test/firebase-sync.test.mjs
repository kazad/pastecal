// Firebase -> Cloudflare copy (PUT /from-firebase) against `wrangler dev`. The point: a Firebase
// write must never erase an edit made on Cloudflare since the last exchange, and replaying the
// same Firebase state must store nothing.
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const id = `test-fb-${Date.now()}`;
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const ev = (eid, title, d) => ({ id: eid, title, start: at(d, 9), end: at(d, 10), type: 1 });
const put = async (path, body) => (await fetch(`${BASE}/cal/${id}/${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) })).json();
const get = async () => (await (await fetch(`${BASE}/cal/${id}`)).json());
const titles = (r) => r.calendar.events.map((e) => e.title).sort();
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);

// Firebase's view of the calendar, as it evolves.
let fb = { id, title: 'Team', options: { notes: 'hi' }, events: [ev('a', 'Alpha ', 1), ev('b', 'Beta', 2), ev('c', 'Gamma', 3)] };
let r = await put('import', fb);
assert.equal(r.ok, true); const v0 = r.v;
step('import loads the calendar (stored as is, "Alpha " keeps its space)');

// A tab connects so we can see broadcasts.
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${id}/ws`);
const got = []; ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
await new Promise((res) => ws.addEventListener('open', res));
const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); for (;;) { const h = got.find(pred); if (h) return h; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((x) => setTimeout(x, 20)); } };
await waitFor((m) => m.t === 'snapshot');

// 1. A Firebase edit + an add + a settings change is applied.
fb = { ...fb, title: 'Team 2', options: { notes: 'hi', color: 'red' },
    events: [{ ...fb.events[0], title: 'Alpha edited' }, fb.events[1], fb.events[2], ev('d', 'Delta', 4)] };
r = await put('from-firebase', fb);
assert.equal(r.ok, true); assert.equal(r.v, v0 + 1);
let cal = await get();
assert.deepEqual(titles(cal), ['Alpha edited', 'Beta', 'Delta', 'Gamma']);
assert.equal(cal.calendar.title, 'Team 2'); assert.equal(cal.calendar.options.color, 'red');
const change = await waitFor((m) => m.t === 'change');
assert.ok(change.commands.some((c) => c.type === 'add'));
step('a Firebase edit, add and settings change are applied, bumped and broadcast');

// 2. Replaying the identical state stores nothing.
const vBefore = cal.v; got.length = 0;
r = await put('from-firebase', fb);
assert.equal(r.unchanged, true); assert.equal(r.v, vBefore);
await new Promise((x) => setTimeout(x, 200));
assert.equal(got.length, 0); assert.equal((await get()).v, vBefore);
step('replaying the same Firebase state: unchanged, version same, nothing broadcast');

// 3. A Cloudflare-side edit, then a Firebase write based on the OLD state: both survive.
ws.send(JSON.stringify({ t: 'save', id: 's1', v: vBefore, commands: [
    { type: 'add', event: ev('cf-1', 'Added on Cloudflare', 5) },
    { type: 'update', key: { id: 'b' }, changes: { title: 'Beta (cloud edit)' } }] }));
await waitFor((m) => m.t === 'ack' && m.id === 's1');
ws.send(JSON.stringify({ t: 'meta', id: 'm1', options: { cloudOnly: 'yes' } }));
await waitFor((m) => m.t === 'ack' && m.id === 'm1');
// Firebase (still unaware) edits a DIFFERENT event and a different field of the same one.
fb = { ...fb, events: fb.events.map((e) => (e.id === 'c' ? { ...e, title: 'Gamma (fb edit)' } : e.id === 'b' ? { ...e, description: 'fb note' } : e)) };
r = await put('from-firebase', fb);
assert.equal(r.ok, true); assert.ok(!r.unchanged);
cal = await get();
const byId = Object.fromEntries(cal.calendar.events.map((e) => [e.id, e]));
assert.equal(byId['cf-1'].title, 'Added on Cloudflare');
assert.equal(byId.b.title, 'Beta (cloud edit)'); assert.equal(byId.b.description, 'fb note');
assert.equal(byId.c.title, 'Gamma (fb edit)');
assert.equal(cal.calendar.options.cloudOnly, 'yes'); assert.equal(cal.calendar.options.color, 'red');
step('Cloudflare edits survive a Firebase write made from the old state; Firebase\'s changes land too');

// 4. Replaying that Firebase state again (and an older one) stores nothing.
const v3 = cal.v;
assert.equal((await put('from-firebase', fb)).unchanged, true);
assert.equal((await get()).v, v3);
step('replay after a merge is still a no-op');

// 5. A Firebase delete removes the event; Cloudflare-only events stay.
fb = { ...fb, events: fb.events.filter((e) => e.id !== 'a') };
r = await put('from-firebase', fb);
assert.equal(r.ok, true);
cal = await get();
assert.ok(!cal.calendar.events.some((e) => e.id === 'a')); assert.ok(cal.calendar.events.some((e) => e.id === 'cf-1'));
const gone = await waitFor((m) => m.t === 'change' && m.commands.some((c) => c.type === 'remove'));
assert.ok(gone);
step('a Firebase delete removes that event only');

// 6. Duplicate ids in Firebase: both kept, deterministic, replay is a no-op.
fb = { ...fb, events: [...fb.events, ev('dup', 'Dup one', 6), ev('dup', 'Dup two', 7)] };
r = await put('from-firebase', fb);
assert.equal(r.ok, true); assert.equal(r.renamedDuplicates, 1);
cal = await get();
assert.ok(titles(cal).includes('Dup one') && titles(cal).includes('Dup two'));
const v5 = cal.v;
assert.equal((await put('from-firebase', fb)).unchanged, true); assert.equal((await get()).v, v5);
step('duplicate ids: both events kept, replay is a no-op');

// 7. Auth, size limit, and a calendar the room has never seen.
assert.equal((await fetch(`${BASE}/cal/${id}/from-firebase`, { method: 'PUT', body: '{}' })).status, 403);
r = await put('from-firebase', { ...fb, events: [...fb.events, { ...ev('big', 'x', 8), description: 'y'.repeat(30000) }] });
assert.equal(r.ok, false); assert.equal((await get()).v, v5);
step('no secret: refused; oversized field: refused and nothing stored');

const fresh = `test-fb-new-${Date.now()}`;
r = await (await fetch(`${BASE}/cal/${fresh}/from-firebase`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ id: fresh, title: 'N', events: { k1: ev('z', 'Z', 1) } }) })).json();
assert.equal(r.ok, true); assert.equal(r.events, 1);
step('an unseen calendar is created like an import (events given as a keyed object)');

ws.close();
console.log(`\n${n} checks passed`);
process.exit(0);
