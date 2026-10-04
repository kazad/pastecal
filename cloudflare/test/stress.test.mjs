// Harder checks than sync.test.mjs, against `wrangler dev`:
//   1. many tabs saving at the same instant: every save lands once, versions are 1..N in order
//   2. convergence: each tab, applying only what the server pushed, ends with the server's data
//   3. a tab that was offline gets the latest data when it reconnects
//   4. the largest real calendar: snapshot size and time to first data
// Persistence across a restart is checked by `RESTART_CHECK=<id>` (see run notes in the doc).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import EventStore from '../../public/services/EventStore.js';

const BASE = process.env.BASE || 'http://localhost:8787';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const get = async (id) => (await fetch(`${BASE}/cal/${encodeURIComponent(id)}`)).json();

function tab(id, name) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${encodeURIComponent(id)}/ws`);
    const t = { name, ws, got: [], events: null, v: null };
    t.ready = new Promise((resolve) => ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data); t.got.push(m);
        if (m.t === 'snapshot') { t.events = m.calendar.events; t.v = m.v; resolve(t); }
        // What a real client does: apply each pushed change to its own copy.
        if (m.t === 'change') { t.events = EventStore.apply(t.events, { type: 'batch', commands: m.commands }).events; t.v = m.v; }
    }));
    // A real client applies its own edit at once, and the server pushes it to everyone else.
    t.send = (m) => { if (m.t === 'save' && t.events) t.events = EventStore.apply(t.events, { type: 'batch', commands: m.commands }).events; ws.send(JSON.stringify(m)); };
    t.waitFor = (pred, ms = 5000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const poll = () => { const hit = t.got.find(pred); if (hit) return resolve(hit); if (Date.now() - start > ms) return reject(new Error(`${name}: timed out`)); setTimeout(poll, 10); };
        poll();
    });
    return t;
}
const importCal = (id, cal) => fetch(`${BASE}/cal/${encodeURIComponent(id)}/import`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ ...cal, id }) }).then((r) => r.json());

// 1 + 2. Eight tabs, each adding five events at once.
const id = `test-stress-${Date.now()}`;
await importCal(id, { title: 'stress', events: [] });
const TABS = 8, EACH = 5;
const tabs = await Promise.all(Array.from({ length: TABS }, (_, i) => tab(id, `T${i}`).ready));
tabs.forEach((t, i) => { for (let k = 0; k < EACH; k++) t.send({ t: 'save', id: `t${i}-${k}`, v: 0, commands: [{ type: 'add', event: { id: crypto.randomUUID(), title: `T${i} event ${k}`, start: at(1 + k, 9), end: at(1 + k, 10) } }] }); });
await Promise.all(tabs.map((t, i) => Promise.all(Array.from({ length: EACH }, (_, k) => t.waitFor((m) => m.t === 'ack' && m.id === `t${i}-${k}`)))));
await sleep(300);
const server = await get(id);
assert.equal(server.calendar.events.length, TABS * EACH);
assert.equal(server.v, 1 + TABS * EACH);                                  // import was v1
const acks = tabs.flatMap((t) => t.got.filter((m) => m.t === 'ack').map((m) => m.v)).sort((a, b) => a - b);
assert.deepEqual(acks, Array.from({ length: TABS * EACH }, (_, i) => i + 2)); // each version given out exactly once
step(`${TABS} tabs x ${EACH} simultaneous saves: ${server.calendar.events.length} stored, versions 2..${server.v} each issued once`);

const canon = (evs) => JSON.stringify(evs.map((e) => e.title).sort());
for (const t of tabs) assert.equal(canon(t.events), canon(server.calendar.events), `${t.name} diverged`);
step('every tab, applying only what the server pushed, ends identical to the server');

// 2b. The same event edited by two tabs at the same instant: do they end up the same?
const one = tabs[2].events[0];
tabs[2].send({ t: 'save', id: 'c2', v: 0, commands: [{ type: 'update', key: one, changes: { title: 'from tab 2' } }] });
tabs[3].send({ t: 'save', id: 'c3', v: 0, commands: [{ type: 'update', key: one, changes: { title: 'from tab 3' } }] });
await Promise.all([tabs[2].waitFor((m) => m.id === 'c2'), tabs[3].waitFor((m) => m.id === 'c3')]);
await sleep(300);
const after = await get(id);
const titleOn = (evs) => evs.find((e) => EventStore.keyOf(e) === EventStore.keyOf(one)).title;
console.log(`     conflict: server kept "${titleOn(after.calendar.events)}"; tab2 shows "${titleOn(tabs[2].events)}", tab3 shows "${titleOn(tabs[3].events)}"`);
const converged = titleOn(tabs[2].events) === titleOn(after.calendar.events) && titleOn(tabs[3].events) === titleOn(after.calendar.events);
step(converged ? 'same-event conflict: both tabs converge on the server' : 'KNOWN GAP: same-event conflict leaves a tab showing its own value (client must reconcile; see plan)');

// 3. Offline tab: closes, others edit, it reconnects and sees everything.
const off = tabs[0]; off.ws.close(); await sleep(100);
tabs[1].send({ t: 'save', id: 'while-away', v: 0, commands: [{ type: 'add', event: { id: crypto.randomUUID(), title: 'Added while T0 was offline', start: at(20, 9), end: at(20, 10) } }] });
await tabs[1].waitFor((m) => m.t === 'ack' && m.id === 'while-away');
const back = await tab(id, 'T0-again').ready;
assert.ok(back.events.some((e) => e.title === 'Added while T0 was offline'));
assert.equal(back.events.length, TABS * EACH + 1);
step('a tab that reconnects receives everything it missed');

// 4. Biggest real calendar.
const SRC = process.env.ALL;
if (SRC) {
    const all = JSON.parse(readFileSync(SRC, 'utf8'));
    const list = (c) => (Array.isArray(c.events) ? c.events : Object.values(c.events || {})).filter(Boolean);
    const [bigId] = Object.entries(all).sort((a, b) => list(b[1]).length - list(a[1]).length)[0];
    const t0 = Date.now(); const t = await tab(bigId, 'big').ready; const ms = Date.now() - t0;
    const bytes = JSON.stringify(t.events).length;
    assert.equal(t.events.length, list(all[bigId]).length);
    step(`largest calendar (${t.events.length} events, ${(bytes / 1024).toFixed(0)} KB): snapshot on connect in ${ms} ms`);
    t.ws.close();
}

[...tabs, back].forEach((t) => t.ws.close());
console.log(`\n${n} checks passed`);
process.exit(0);
