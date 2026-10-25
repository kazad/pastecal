// Production-counting branch: proves the new Worker reads rooms written by master's code exactly as
// master did, and that every non-stats response is unchanged.
//   MODE=seed  (against master's code)  creates calendars, saves over the socket, makes a view link,
//              and writes the golden responses to GOLDEN (a JSON file).
//   MODE=check (against the new code, same --persist-to)  reads the same calendars and compares.
// Run against `wrangler dev --port 8950 --persist-to $PERSIST --var FIREBASE_DB_URL: --var COPY_BACK:
//   --var IMPORT_SECRET:dev-secret`, e.g. MODE=seed GOLDEN=/path/golden.json BASE=http://localhost:8950 node test/master-compat.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8950', MODE = process.env.MODE || 'check', GOLDEN = process.env.GOLDEN;
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
if (!GOLDEN) throw new Error('set GOLDEN');
const enc = encodeURIComponent;
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const ip = (i) => ({ 'CF-Connecting-IP': `198.18.200.${i}`, 'User-Agent': 'Mozilla/5.0 (compat test)' });

async function save(id, commands) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(id)}/ws?author=compat-author`);
    const got = [];
    ws.addEventListener('message', (ev) => got.push(JSON.parse(ev.data)));
    const wait = async (pred) => { for (let i = 0; i < 150; i++) { const m = got.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
    const snap = await wait((m) => m.t === 'snapshot');
    ws.send(JSON.stringify({ t: 'save', id: 's', v: snap.v, commands }));
    const ack = await wait((m) => m.t === 'ack' || m.t === 'error');
    ws.close();
    assert.equal(ack.t, 'ack', JSON.stringify(ack));
}

async function capture(g) {
    const id = g.id, out = {};
    const text = async (r) => ({ status: r.status, body: await r.text() });
    out.get = await text(await fetch(`${BASE}/cal/${enc(id)}`, { headers: ip(1) }));
    out.history = await text(await fetch(`${BASE}/cal/${enc(id)}/history`, { headers: ip(1) }));
    out.authors = await text(await fetch(`${BASE}/cal/${enc(id)}/authors`, { headers: ip(1) }));
    out.view = await text(await fetch(`${BASE}/cal/view/${enc(g.viewId)}`, { headers: ip(2) }));
    const ics = await fetch(`${BASE}/${enc(id)}.ics`, { headers: { ...ip(3), 'User-Agent': 'Google-Calendar-Importer' } });
    out.icsStatus = ics.status; out.icsEtag = ics.headers.get('etag'); out.icsType = ics.headers.get('content-type');
    out.ics304 = (await fetch(`${BASE}/${enc(id)}.ics`, { headers: { ...ip(3), 'If-None-Match': out.icsEtag } })).status;
    const vics = await fetch(`${BASE}/view/${enc(g.viewId)}.ics`, { headers: ip(4) });
    out.viewIcsEtag = vics.headers.get('etag');
    out.head = (await fetch(`${BASE}/cal/${enc(id)}`, { method: 'HEAD' })).status;
    out.headMissing = (await fetch(`${BASE}/cal/${enc(id)}-missing`, { method: 'HEAD' })).status;
    out.getMissing = await text(await fetch(`${BASE}/cal/${enc(id)}-missing`, { headers: ip(5) }));
    out.wsNoUpgrade = (await fetch(`${BASE}/cal/${enc(id)}/ws`)).status;
    out.importNoSecret = (await fetch(`${BASE}/cal/${enc(id)}/import`, { method: 'PUT', body: '{}' })).status;
    out.createExisting = await text(await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: ip(6), body: JSON.stringify({ title: 'x', events: [] }) }));
    out.unknownSuffix = (await fetch(`${BASE}/cal/${enc(id)}/stats-dump`)).status;
    out.options = (await fetch(`${BASE}/cal/${enc(id)}`, { method: 'OPTIONS' })).status;
    out.lookup = await text(await fetch(`${BASE}/api/lookup?slug=${enc(g.viewId)}`));
    return out;
}

if (MODE === 'seed') {
    const run = Date.now().toString(36);
    const id = `compat-${run}`;
    let r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: ip(10), body: JSON.stringify({ title: 'Compat', options: { notes: 'n' },
        events: [{ id: 'e1', title: 'Soccer', start: at(12, 17), end: at(12, 18), type: 3 }] }) });
    assert.equal(r.status, 201, await r.text());
    await save(id, [{ type: 'add', event: { id: 'e2', title: 'Piano', start: at(13, 9), end: at(13, 10), type: 1 } }]);
    const e1 = (await (await fetch(`${BASE}/cal/${enc(id)}`)).json()).calendar.events.find((e) => e.id === 'e1');
    await save(id, [{ type: 'update', key: e1, changes: { title: 'Soccer practice' } }]);
    r = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) });
    const viewId = (await r.json()).publicViewId;
    assert.ok(viewId, 'view link made');
    const g = { id, viewId };
    g.responses = await capture(g);
    writeFileSync(GOLDEN, JSON.stringify(g, null, 2));
    step(`seeded ${id} (2 socket saves, view link ${viewId}) on master's code; golden responses written to ${GOLDEN}`);
} else {
    const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    const now = await capture(g);
    // Pro (launch-prep) adds these top-level fields to a calendar read; on a FREE calendar they must
    // have exactly these values. Anything else in the body must still be byte-identical.
    const PRO_ADDITIVE = { locked: false, pro: false, paused: false, proSettings: null };
    const stripPro = (r) => {
        if (!r || typeof r.body !== 'string' || !r.body.startsWith('{')) return r;
        let j; try { j = JSON.parse(r.body); } catch { return r; }
        if (!j || !j.calendar) return r;
        for (const [k, v] of Object.entries(PRO_ADDITIVE)) if (k in j) { assert.deepEqual(j[k], v, `${k} on a free calendar`); delete j[k]; }
        return { ...r, body: JSON.stringify(j) };
    };
    for (const k of Object.keys(g.responses)) assert.deepEqual(stripPro(now[k]), stripPro(g.responses[k]), `${k} changed`);
    step(`room ${g.id} written by master's code reads identically on the new code: ${Object.keys(g.responses).join(', ')}`);
}
process.exit(0);
