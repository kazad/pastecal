// Shared helpers for the red-team attack scripts (cloudflare/test/redteam/*.mjs).
//
// All scripts run against a single `wrangler dev` started from ~/worktrees/pc-redteam/cloudflare:
//   node node_modules/.bin/wrangler dev --port 8910 --inspector-port 9910 --persist-to <state> \
//     --var FIREBASE_DB_URL: --var COPY_BACK: --var UNSAFE_DEV_SESSION_HEADER:on --var ACCOUNTS_DEV_MODE:1 \
//     --var IMPORT_SECRET:dev-secret \
//     --var STRIPE_SECRET_KEY:fake-stripe-key --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret \
//     --var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly \
//     --var STRIPE_API_BASE:http://127.0.0.1:8911/stripe --var LOCK_API_BASE:http://127.0.0.1:8911/lockfake
//
// Each script is independent and repeatable (every id carries a timestamp). Run one with:
//   BASE=http://localhost:8910 node test/redteam/<name>.mjs
// A script prints `ok N - ...` per check and exits 0 on pass, non-zero on a failed assertion.
// A FINDING (a real weakness) is printed as `FINDING[sev] ...` and does NOT fail the run: the
// script documents the behaviour so the report can rank it. A line the code already defends is a
// passing assertion.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const BASE = process.env.BASE || 'http://localhost:8910';
export const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
export const WS = BASE.replace(/^http/, 'ws');
export const enc = encodeURIComponent;
export const auth = { Authorization: `Bearer ${SECRET}` };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

let n = 0;
export const step = (s) => console.log(`  ok ${++n} - ${s}`);
const findings = [];
export const finding = (sev, s) => { findings.push({ sev, s }); console.log(`  FINDING[${sev}] ${s}`); };
export const done = (name) => {
    if (findings.length) {
        console.log(`\n${name}: ${n} checks passed, ${findings.length} finding(s):`);
        for (const f of findings) console.log(`  - [${f.sev}] ${f.s}`);
    } else {
        console.log(`\n${name}: ${n} checks passed, no findings`);
    }
    process.exit(0);
};

export const uid = (p) => `test-rt-${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
export const at = (d, h) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
export const ev = (id, title, d = 1, extra = {}) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1, ...extra });

export const url = (id, sub = '') => `${BASE}/cal/${enc(id)}${sub}`;
// A random client IP so each create gets its own per-IP create budget (CREATE_LIMITER is 10/min per
// IP). Scripts that test the limiter itself pass a FIXED CF-Connecting-IP to override this.
export const randomIp = () => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
export const create = (id, cal, headers = {}) =>
    fetch(url(id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomIp(), ...headers }, body: JSON.stringify(cal) });
export const getCal = async (id) => (await fetch(url(id))).json();
export const putSecret = (id, sub, cal) =>
    fetch(url(id, sub), { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cal, id }) });
export const admin = async (id, op, body) => {
    const r = await fetch(`${BASE}/api/admin/cal/${enc(id)}/${op}`,
        op === 'lock-status' ? { headers: auth } : { method: 'POST', headers: auth, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
};

// One WebSocket tab. `headers` and `query` let an attack forge headers / smuggle query params.
export function tab(id, { headers, query = '', path = '/cal/', sub = '/ws' } = {}) {
    const ws = new WebSocket(`${WS}${path}${enc(id)}${sub}${query}`, headers ? { headers } : undefined);
    const got = [];
    ws.addEventListener('message', (e) => { try { got.push(JSON.parse(e.data)); } catch { got.push({ raw: e.data }); } });
    let closed = null;
    ws.addEventListener('close', (e) => { closed = { code: e.code, reason: e.reason }; });
    const waitFor = async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await sleep(15); }
        throw new Error('timed out; recent: ' + JSON.stringify(got.slice(-3)));
    };
    const send = (m) => ws.send(JSON.stringify(m));
    let k = 0;
    const save = async (commands) => { const sid = `s${++k}-${Math.random()}`; send({ t: 'save', id: sid, v: 0, commands }); return waitFor((m) => m.id === sid); };
    const meta = async (fields) => { const sid = `m${++k}-${Math.random()}`; send({ t: 'meta', id: sid, ...fields }); return waitFor((m) => m.id === sid); };
    const authKey = async (key) => { const before = got.length; send({ t: 'auth', key }); return waitFor((m) => m.t === 'auth' && got.indexOf(m) >= before); };
    return { ws, got, waitFor, send, save, meta, authKey, closedInfo: () => closed, ready: waitFor((m) => m.t === 'snapshot'), close: () => { try { ws.close(); } catch {} } };
}

export { assert };
