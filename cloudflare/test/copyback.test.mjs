// Copy-back to Firebase, against `wrangler dev` plus a stand-in Firebase on :9099.
// wrangler dev needs (cloudflare/.dev.vars):  FIREBASE_DB_URL=http://localhost:9099  COPY_BACK=test-cb-*
import assert from 'node:assert/strict';
import { startFakeFirebase } from './fake-firebase.mjs';

const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const fb = await startFakeFirebase(9099);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const cfGet = async (id) => (await fetch(`${BASE}/cal/${id}`)).json();
const waitFor = async (pred, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await pred(); if (v) return v; await sleep(150); } throw new Error('timed out'); };
const puts = (id) => fb.log.filter((l) => l === `PUT ${id}`).length;
const ev = (id, title, d) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1 });
function tab(id) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${id}/ws`); const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    return { ws, got, ready: waitFor(() => got.find((m) => m.t === 'snapshot')).then(() => ws),
        save: (sid, commands) => { ws.send(JSON.stringify({ t: 'save', id: sid, v: 0, commands })); return waitFor(() => got.find((m) => m.id === sid && (m.t === 'ack' || m.t === 'error'))); } };
}

// 1. A calendar created on Cloudflare shows up in Firebase, in Firebase's shape.
const id = `test-cb-${Date.now()}`;
let r = await fetch(`${BASE}/cal/${id}`, { method: 'POST', body: JSON.stringify({ title: 'cb', options: { notes: 'hi' }, events: [ev('a1', 'first', 1)] }) });
assert.equal(r.status, 201);
const first = await waitFor(() => fb.store.get(id));
assert.equal(first.id, id); assert.equal(first.title, 'cb'); assert.equal(first.options.notes, 'hi');
assert.deepEqual(first.events.map((e) => e.title), ['first']); assert.equal(typeof first.lastEditedAt, 'number');
step('a new calendar made on Cloudflare is written to Firebase (id, title, options, events, lastEditedAt)');

// 2. A burst of saves is ONE write to Firebase, a few seconds later.
const T = tab(id); await T.ready; await sleep(4000);
const putsBefore = puts(id);
for (let i = 0; i < 5; i++) await T.save(`b${i}`, [{ type: 'add', event: ev(`b${i}`, `burst ${i}`, 2 + i) }]);
assert.equal(puts(id), putsBefore, 'wrote before the delay');
await waitFor(() => fb.store.get(id).events.length === 6);
await sleep(1500);
assert.equal(puts(id), putsBefore + 1);
step('five quick saves become one Firebase write after the delay');

// 3. The echo: Firebase's function sends back exactly what was written. Nothing happens.
const v0 = (await cfGet(id)).v, writes0 = puts(id);
r = await (await fetch(`${BASE}/cal/${id}/from-firebase`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(fb.store.get(id)) })).json();
assert.equal(r.unchanged, true); assert.equal((await cfGet(id)).v, v0);
await sleep(5000); assert.equal(puts(id), writes0);
step('the echo from Firebase changes nothing and triggers no further write (no ping-pong)');

// 4. A pc.com browser edits the same calendar; the next copy-back keeps both sides' edits.
const cur = structuredClone(fb.store.get(id)); cur.events.push(ev('p1', 'from pc.com', 20));
fb.browserWrite(id, cur);
await T.save('c1', [{ type: 'add', event: ev('c1', 'from new.pastecal.com', 21) }]);
await waitFor(() => fb.store.get(id).events.some((e) => e.title === 'from new.pastecal.com'));
const titles = (evs) => evs.map((e) => e.title).sort().join('|');
assert.equal(titles(fb.store.get(id).events), titles((await cfGet(id)).calendar.events));
assert.ok(fb.store.get(id).events.some((e) => e.title === 'from pc.com'));
step('a pc.com edit and a new.pastecal.com edit made together both survive, and both sides end identical');

// 5. A write that collides in flight is retried, not lost and not forced.
fb.hooks.onNextPut = () => { const c = structuredClone(fb.store.get(id)); c.events.push(ev('p2', 'raced in', 22)); fb.browserWrite(id, c); };
await T.save('d1', [{ type: 'add', event: ev('d1', 'mine', 23) }]);
await waitFor(() => { const t = fb.store.get(id).events.map((e) => e.title); return t.includes('mine') && t.includes('raced in'); });
assert.equal(titles(fb.store.get(id).events), titles((await cfGet(id)).calendar.events));
step('a Firebase write that lands in between makes the copy-back retry (412) and keep both');

// 6. A calendar that is not on the allowlist is never written to Firebase.
const other = `test-other-${Date.now()}`;
await fetch(`${BASE}/cal/${other}`, { method: 'POST', body: JSON.stringify({ title: 'x', events: [ev('z', 'z', 1)] }) });
await sleep(6000); assert.equal(fb.store.has(other), false); assert.equal(puts(other), 0);
step('a calendar outside COPY_BACK is never written to Firebase');

T.ws.close(); fb.close(); console.log(`\n${n} checks passed`); process.exit(0);
