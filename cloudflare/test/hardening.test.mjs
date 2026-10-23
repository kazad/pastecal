// Defensive limits, against `wrangler dev` (BASE, default http://localhost:8787):
//   - size caps on event ids, recurrenceIDs, types and the whole calendar, on every way in
//     (create, save, meta, import, from-firebase);
//
//   cd cloudflare && npx wrangler dev   (other terminal)   then   node test/hardening.test.mjs
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const ev = (id, title, d = 1, extra = {}) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1, ...extra });
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const uniq = (p) => `test-hard-${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const url = (id, sub = '') => `${BASE}/cal/${encodeURIComponent(id)}${sub}`;
const create = (id, cal) => fetch(url(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cal) });
const put = (id, sub, cal) => fetch(url(id, sub), { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cal) });
const get = async (id) => (await (await fetch(url(id))).json()).calendar;

function tab(id) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${encodeURIComponent(id)}/ws?author=test-author-${Date.now()}`);
    const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const waitFor = async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 20)); }
        throw new Error('timed out');
    };
    const ready = waitFor((m) => m.t === 'snapshot');
    const send = (m) => { ws.send(JSON.stringify(m)); return waitFor((x) => x.id === m.id && (x.t === 'ack' || x.t === 'error')); };
    return { ws, got, ready, send, close: () => ws.close() };
}

// ---- 2. size caps -------------------------------------------------------------------------
{
    const long = 'x'.repeat(201);
    for (const [what, e] of [
        ['id', ev(long, 'a')],
        ['recurrenceID', ev('ok', 'a', 1, { recurrenceID: long })],
    ]) {
        const id = uniq('cap');
        const r = await create(id, { title: 't', events: [e] });
        assert.equal(r.status, 413, `create with a 201-char ${what} must be refused`);
        assert.equal((await fetch(url(id), { method: 'HEAD' })).status, 404, 'nothing stored');
    }
    step('create refuses an event id / recurrenceID over 200 chars, and stores nothing');

    const id = uniq('cap');
    assert.equal((await create(id, { title: 't', events: [ev('a1', 'first')] })).status, 201);
    const t = tab(id); await t.ready;
    let r = await t.send({ t: 'save', id: 's1', v: 1, commands: [{ type: 'add', event: ev('y'.repeat(201), 'long id') }] });
    assert.equal(r.t, 'error'); assert.equal(r.code, 'too_big');
    r = await t.send({ t: 'save', id: 's2', v: 1, commands: [{ type: 'add', event: ev('a2', 'big', 2, { description: 'z'.repeat(19000) }) }] });
    assert.equal(r.t, 'ack', 'a normal-sized save still works');
    assert.deepEqual((await get(id)).events.map((e) => e.id), ['a1', 'a2']);
    step('a save adding an over-long id is refused; ordinary saves still work');

    // Whole-calendar size: saves of large-but-legal events (each message under the 512 KB message
    // limit), until the total passes 2 MB.
    let refused = null;
    for (let i = 0; i < 8 && !refused; i++) {
        const commands = Array.from({ length: 24 }, (_, j) => ({ type: 'add', event: ev(`big${i}-${j}`, 'big', 3, { description: 'q'.repeat(19500) }) }));
        const m = await t.send({ t: 'save', id: `b${i}`, v: 0, commands });
        if (m.t === 'error') refused = m;
    }
    assert.ok(refused, 'the calendar must stop growing at its size cap');
    assert.equal(refused.code, 'too_big'); assert.match(refused.message, /too large/);
    const stored = await get(id);
    assert.ok(JSON.stringify(stored.events).length <= 2 * 1024 * 1024, 'never stored past the cap');
    step(`a save that would take the calendar past 2 MB is refused (${stored.events.length} events stored)`);

    // Fill to within one event of the cap, then a meta change bigger than what is left is refused too.
    for (let i = 0; i < 26; i++) {
        const m = await t.send({ t: 'save', id: `c${i}`, v: 0, commands: [{ type: 'add', event: ev(`fill${i}`, 'fill', 3, { description: 'q'.repeat(19500) }) }] });
        if (m.t === 'error') break;
    }
    r = await t.send({ t: 'meta', id: 'm1', options: { notes: 'n'.repeat(60000) } });
    assert.equal(r.t, 'error'); assert.equal(r.code, 'too_big');
    assert.notEqual((await get(id)).options.notes, 'n'.repeat(60000));
    step('meta that would take the calendar past the cap is refused, nothing stored');
    t.close();

    // import and from-firebase: refused with a clear error, the stored calendar untouched.
    const huge = Array.from({ length: 120 }, (_, i) => ev(`h${i}`, 'h', 4, { description: 'w'.repeat(19500) }));
    const imp = uniq('cap');
    r = await put(imp, '/import', { id: imp, title: 'x', events: huge });
    assert.equal(r.status, 413); assert.match((await r.json()).error, /too large/);
    assert.equal((await fetch(url(imp), { method: 'HEAD' })).status, 404);
    const fb = uniq('cap');
    assert.equal((await put(fb, '/import', { id: fb, title: 'x', events: [ev('f1', 'one')] })).status, 200);
    r = await put(fb, '/from-firebase', { id: fb, title: 'x', events: huge });
    assert.equal(r.status, 413); const out = await r.json();
    assert.equal(out.ok, false); assert.match(out.error, /too large/);
    assert.deepEqual((await get(fb)).events.map((e) => e.id), ['f1'], 'from-firebase refused: nothing changed');
    step('import and from-firebase over the cap are refused (413, a clear error) and store nothing');

    // type sanity: an object as the type is refused on import; real shapes ("3", "undefined", null) are kept.
    const ty = uniq('cap');
    r = await put(ty, '/import', { id: ty, title: 'x', events: [ev('t1', 'a', 1, { type: { evil: 1 } })] });
    assert.equal(r.status, 413);
    r = await put(ty, '/import', { id: ty, title: 'x', events: [ev('t1', 'a', 1, { type: '3' }), ev('t2', 'b', 1, { type: 'undefined' }), ev('t3', 'c', 1, { type: null })] });
    assert.equal(r.status, 200);
    step('an event type that is not a number or short text is refused; real stored shapes still import');
}

console.log('hardening tests passed');
process.exit(0);
