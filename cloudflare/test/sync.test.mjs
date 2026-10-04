// Runs against `wrangler dev` (BASE, default http://localhost:8787): the real Worker and
// Durable Object code, with local SQLite. Checks the properties the Sep 26 incident was
// about, not just that saving works.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const FIXTURE = process.env.FIXTURE;          // optional: a real calendar's JSON
const id = `test-sync-${Date.now()}`;
const wsUrl = BASE.replace(/^http/, 'ws') + `/cal/${id}/ws`;
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();

function tab(name) {
    const ws = new WebSocket(wsUrl);
    const t = { name, ws, got: [], snapshot: null };
    t.ready = new Promise((resolve) => ws.addEventListener('message', function first(ev) {
        const m = JSON.parse(ev.data); if (m.t === 'snapshot') { t.snapshot = m; ws.removeEventListener('message', first); resolve(t); }
    }));
    ws.addEventListener('message', (ev) => t.got.push(JSON.parse(ev.data)));
    t.send = (m) => ws.send(JSON.stringify(m));
    t.waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const poll = () => { const hit = t.got.find(pred); if (hit) return resolve(hit); if (Date.now() - start > ms) return reject(new Error(`${name}: timed out`)); setTimeout(poll, 20); };
        poll();
    });
    return t;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);

// 1. Import: a real-shaped calendar, including two events that share an id.
const base = FIXTURE ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : { title: 'T', options: { notes: 'hi' }, events: [] };
const events = (Array.isArray(base.events) ? base.events : Object.values(base.events || {})).filter(Boolean);
events.push({ id: 7, title: 'First with id 7', start: at(9, 9), end: at(9, 10), type: 1 },
            { id: 7, title: 'Second with id 7', start: at(10, 9), end: at(10, 10), type: 2 });
let r = await fetch(`${BASE}/cal/${id}/import`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ ...base, id, events }) });
r = await r.json();
assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.events, events.length); assert.equal(r.renamedDuplicates, 1 + (FIXTURE ? r.renamedDuplicates - 1 : 0));
step(`import: ${r.events} events, ${r.renamedDuplicates} duplicate id(s) given a fresh id, nothing lost`);

const v1 = r.v; const again = await (await fetch(`${BASE}/cal/${id}/import`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ ...base, id, events: (await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events }) })).json();
assert.equal(again.unchanged, true); assert.equal(again.v, v1);
step('re-importing identical data stores nothing and bumps nothing (no copy loop with Firebase)');

let bad = await fetch(`${BASE}/cal/${id}/import`, { method: 'PUT', body: '{}' });
assert.equal(bad.status, 403); step('import without the secret is refused');

// 2. Two tabs open; both get the same snapshot.
const A = await tab('A').ready, B = await tab('B').ready;
assert.equal(A.snapshot.v, B.snapshot.v);
assert.deepEqual(A.snapshot.calendar.events.map((e) => e.title).sort(), events.map((e) => e.title).sort());
step('two tabs connect and receive the same snapshot');

// 3. A adds and edits; B sees each change; version advances by one per save.
const v0 = A.snapshot.v;
A.send({ t: 'save', id: 's1', v: v0, commands: [{ type: 'add', event: { id: 'soccer-1', title: 'Soccer', start: at(12, 17), end: at(12, 18), type: 3 } }] });
const ack1 = await A.waitFor((m) => m.t === 'ack' && m.id === 's1');
const ch1 = await B.waitFor((m) => m.t === 'change' && m.v === ack1.v);
assert.equal(ack1.v, v0 + 1); assert.equal(ch1.commands[0].event.title, 'Soccer');
step('a save is acknowledged to the sender and pushed to the other tab');

const soccer = (await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events.find((e) => e.title === 'Soccer');
A.send({ t: 'save', id: 's2', v: ack1.v, commands: [{ type: 'update', key: soccer, changes: { title: 'Soccer (moved)', start: at(13, 17), end: at(13, 18) } }] });
const ack2 = await A.waitFor((m) => m.t === 'ack' && m.id === 's2');
await B.waitFor((m) => m.t === 'change' && m.v === ack2.v);
const stored = (await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events;
assert.equal(stored.filter((e) => e.title === 'Soccer (moved)').length, 1);
assert.ok(stored.some((e) => e.title === 'First with id 7') && stored.some((e) => e.title === 'Second with id 7'));
step('an edit is stored once; both same-id events are still there');

// 4. An echo -- saving what is already there -- stores nothing and tells no one.
const beforeB = B.got.length;
A.send({ t: 'save', id: 's3', v: ack2.v, commands: [{ type: 'update', key: { ...soccer }, changes: { title: 'Soccer (moved)' } }] });
const ack3 = await A.waitFor((m) => m.t === 'ack' && m.id === 's3');
await sleep(300);
assert.equal(ack3.unchanged, true); assert.equal(ack3.v, ack2.v); assert.equal(B.got.length, beforeB);
step('a save that changes nothing stores nothing, bumps nothing, broadcasts nothing');

// 5. Idle tabs receive nothing.
const idleA = A.got.length, idleB = B.got.length;
await sleep(3000);
assert.equal(A.got.length, idleA); assert.equal(B.got.length, idleB);
step('idle tabs: no traffic for 3 s');

// 6. A save loop is refused by the server, not just discouraged in the browser.
const loopStart = Date.now();
for (let i = 0; i < 100; i++) A.send({ t: 'save', id: `loop${i}`, v: 0, commands: [{ type: 'update', key: soccer, changes: { description: `loop ${i}` } }] });
await A.waitFor((m) => m.t === 'error' && m.code === 'rate_limited', 5000);
await sleep(500);
const acked = A.got.filter((m) => m.t === 'ack' && String(m.id).startsWith('loop')).length;
const refused = A.got.filter((m) => m.t === 'error' && m.code === 'rate_limited').length;
assert.ok(acked <= 40, `acked ${acked}`); assert.ok(refused >= 60, `refused ${refused}`);
step(`save loop: ${acked} stored, ${refused} refused by the server (in ${Date.now() - loopStart} ms)`);

// 7. Bad input is refused whole; nothing half-applied.
const vBad = (await (await fetch(`${BASE}/cal/${id}`)).json()).v;
const C = await tab('C').ready;
C.send({ t: 'save', id: 'bad', v: vBad, commands: [
    { type: 'add', event: { id: 'ok-1', title: 'ok', start: at(20, 9), end: at(20, 10) } },
    { type: 'update', key: { id: 'nope' }, changes: { title: 'x' } }] });
const err = await C.waitFor((m) => m.t === 'error' && m.id === 'bad');
assert.equal(err.code, 'bad_command');
const after = (await (await fetch(`${BASE}/cal/${id}`)).json());
assert.equal(after.v, vBad); assert.ok(!after.calendar.events.some((e) => e.title === 'ok'));
step('a batch with one bad command is refused whole; nothing stored');

C.send({ t: 'save', id: 'huge', v: vBad, commands: [{ type: 'add', event: { id: 'x-1', title: 'x', description: 'y'.repeat(30000), start: at(20, 9), end: at(20, 10) } }] });
assert.equal((await C.waitFor((m) => m.id === 'huge')).code, 'too_big');
step('an oversized field is refused');

C.send({ t: 'save', id: 'noid', v: vBad, commands: [{ type: 'add', event: { title: 'no id', start: at(20, 9), end: at(20, 10) } }] });
assert.equal((await C.waitFor((m) => m.id === 'noid')).message, 'a new event needs an id');
step('a new event without an id is refused (the tab must choose it)');

// 8. Settings: keys merge, so one tab's settings cannot erase another's (publicViewId).
C.send({ t: 'meta', id: 'm1', options: { publicViewId: 'abc' } });
await C.waitFor((m) => m.t === 'ack' && m.id === 'm1');
C.send({ t: 'meta', id: 'm2', options: { defaultView: 'Week' } });
await C.waitFor((m) => m.t === 'ack' && m.id === 'm2');
const opts = (await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.options;
assert.equal(opts.publicViewId, 'abc'); assert.equal(opts.defaultView, 'Week');
step('settings merge by key');

for (const t of [A, B, C]) t.ws.close();
console.log(`\n${n} checks passed`);
process.exit(0);
