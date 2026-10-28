// Recent changes history, against `wrangler dev` (BASE, default http://localhost:8787):
// a write that changes no event (settings, a title) still bumps the version but records no
// history entry -- the panel had nothing to say about one but "0 events added". A cleared
// title is the exception: Firebase records it too, with the calendar as it was.
//
//   cd cloudflare && npx wrangler dev   (other terminal)   then   node test/history.test.mjs
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const ev = (id, title, extra = {}) => ({ id, title, start: at(25, 17), end: at(25, 18), type: 2, ...extra });
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const id = `test-history-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const url = (sub = '') => `${BASE}/cal/${encodeURIComponent(id)}${sub}`;
const history = async () => (await fetch(url('/history'))).json();

function tab() {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${encodeURIComponent(id)}/ws`);
    const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const waitFor = async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 20)); }
        throw new Error('timed out');
    };
    const ready = waitFor((m) => m.t === 'snapshot');
    const send = (m) => { ws.send(JSON.stringify(m)); return waitFor((x) => x.id === m.id && (x.t === 'ack' || x.t === 'error')); };
    return { ready, send, close: () => ws.close() };
}

const made = await fetch(url(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'History test', options: {}, events: [ev('ev1', 'Team lunch')] }) });
assert.equal(made.status, 201);
const t = tab(); const snap = await t.ready;
let v = snap.v;

let ack = await t.send({ t: 'save', id: 's1', v, commands: [{ type: 'update', key: 'ev1|', changes: { title: 'Team lunch v2' } }] });
assert.equal(ack.v, ++v);
const afterEdit = await history();
assert.equal(afterEdit[0].kind, 'edited'); assert.equal(afterEdit[0].changed, 1);
step('an event edit is recorded');

// What the app sends right after the first edit in a tab: the option defaults it filled in on load.
ack = await t.send({ t: 'meta', id: 'm1', options: { customViewDuration: 3, customViewUnit: 'Months', typeLabels: ['Type 1', 'Type 2'] } });
assert.equal(ack.v, ++v, 'a settings write still bumps the version (a tab reads anything else as a conflict)');
ack = await t.send({ t: 'meta', id: 'm2', title: 'History test renamed' });
assert.equal(ack.v, ++v);
const afterMeta = await history();
assert.deepEqual(afterMeta.map((e) => e.key), afterEdit.map((e) => e.key), 'settings and title writes record no history entry');
assert.ok(!afterMeta.some((e) => !e.removed && !e.changed && !e.added && e.kind !== 'title-cleared'), 'no entry with nothing in it');
step('a settings-only or title-only write bumps the version and records nothing');

const cal = (await (await fetch(url())).json()).calendar;
const ff = await fetch(url('/from-firebase'), { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...cal, options: { ...cal.options, customViewDuration: 6 } }) });
assert.equal(ff.status, 200, await ff.clone().text());
assert.deepEqual((await history()).map((e) => e.key), afterEdit.map((e) => e.key), 'a settings-only Firebase write records nothing');
step('a settings-only write from Firebase records nothing');

ack = await t.send({ t: 'meta', id: 'm3', title: '' });
const cleared = (await history())[0];
assert.equal(cleared.kind, 'title-cleared');
assert.equal(cleared.events.length, 1, 'with the calendar as it was');
step('a cleared title is still recorded');

// The You tab's name rides with a save and lands on the history entry (Activity: "Edited by <name>"), cleaned by the
// server whatever a client sends: trimmed, control characters gone, at most 40 characters; nothing for a blank or a
// non-string. (YourName.clean, the browser's rule too.)
const named = async (sid, name, title) => {
    const a = await t.send({ t: 'save', id: sid, v, commands: [{ type: 'update', key: 'ev1|', changes: { title } }], ...(name === undefined ? {} : { name }) });
    assert.equal(a.t, 'ack', JSON.stringify(a)); v = a.v;
    return (await history())[0];
};
assert.equal((await named('n1', '  Sam Lee  ', 'Lunch 1')).name, 'Sam Lee');
assert.equal((await named('n2', 'Ann\u0000\u0007\u001b[31m‮Bob\n', 'Lunch 2')).name, 'Ann [31m Bob');
const long = 'x'.repeat(39) + '😀😀😀';
assert.equal((await named('n3', long, 'Lunch 3')).name, 'x'.repeat(39) + '😀', '40 characters (code points), not 40 UTF-16 units');
assert.equal((await named('n4', '   ', 'Lunch 4')).name, undefined, 'a blank name is no name');
assert.equal((await named('n5', { evil: 1 }, 'Lunch 5')).name, undefined, 'not a string: no name');
assert.equal((await named('n6', undefined, 'Lunch 6')).name, undefined, 'none sent: none stored');
assert.equal((await named('n7', 'a'.repeat(5000), 'Lunch 7')).name, 'a'.repeat(40));
step('a name sent with a save is stored on its history entry, trimmed, cleaned and at most 40 characters');

t.close();
console.log('history tests passed');
process.exit(0);
