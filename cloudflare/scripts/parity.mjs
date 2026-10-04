// Is the Cloudflare copy current? For every calendar edited in the last N hours (same edit
// stamps scripts/health.py uses: /history_meta/<id>/lastEditedAt), compare Firebase with the
// Worker: events field for field (matched by id + recurrenceID), title and options.
// Usage: node scripts/parity.mjs [hours=24] [BASE=https://pastecal-sync.instacalc.workers.dev]
// Needs `gcloud auth login` (read-only REST, like health.py). Reads only recent calendars.
import { execFileSync } from 'node:child_process';

const hours = Number(process.argv[2] || 24);
const BASE = process.argv[3] || 'https://pastecal-sync.instacalc.workers.dev';
const DB = 'https://pastecal-web-default-rtdb.firebaseio.com';
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim().split('\n').pop();
const fbGet = async (path) => { const r = await fetch(`${DB}${path}.json?access_token=${token}`); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); };

const meta = (await fbGet('/history_meta')) || {};
const cutoff = Date.now() - hours * 3600 * 1000;
const ids = Object.entries(meta).filter(([k, v]) => v && v.lastEditedAt > cutoff && !k.toLowerCase().startsWith('test-')).map(([k]) => k);

// Same keying and duplicate rule as the Worker: a repeated id~recurrenceID becomes id~2, id~3.
const key = (e) => `${e.id ?? ''}|${e.recurrenceID ?? ''}`;
const keyed = (v) => {
    const out = new Map();
    for (const e of (Array.isArray(v) ? v : Object.values(v || {})).filter(Boolean)) {
        let n = e;
        for (let i = 2; out.has(key(n)); i++) n = { ...e, id: `${e.id}~${i}` };
        out.set(key(n), n);
    }
    return out;
};
// Key order must not matter; undefined/null/absent are the same (RTDB drops nulls).
const canon = (x) => JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, y]) => y != null).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

async function compare(id) {
    const [fb, res] = await Promise.all([fbGet(`/calendars/${encodeURIComponent(id)}`), fetch(`${BASE}/cal/${encodeURIComponent(id)}`)]);
    if (!fb) return { id, why: 'gone from Firebase' };
    if (res.status === 404) return { id, why: 'missing on Cloudflare' };
    const cf = (await res.json()).calendar;
    const a = keyed(fb.events), b = keyed(cf.events), why = [];
    const missing = [...a.keys()].filter((k) => !b.has(k)), extra = [...b.keys()].filter((k) => !a.has(k));
    const differ = [...a.keys()].filter((k) => b.has(k) && canon(a.get(k)) !== canon(b.get(k)));
    if (missing.length) why.push(`${missing.length} event(s) missing on Cloudflare`);
    if (extra.length) why.push(`${extra.length} event(s) only on Cloudflare`);
    if (differ.length) why.push(`${differ.length} event(s) differ`);
    if ((fb.title ?? '') !== (cf.title ?? '')) why.push('title differs');
    if (canon(fb.options || {}) !== canon(cf.options || {})) why.push('options differ');
    return why.length ? { id, why: why.join(', ') } : null;
}

const bad = [];
for (let i = 0; i < ids.length; i += 10) {
    for (const r of await Promise.all(ids.slice(i, i + 10).map((id) => compare(id).catch((e) => ({ id, why: `error: ${e.message}` }))))) if (r) bad.push(r);
}
console.log(`parity: ${ids.length} calendar(s) edited in the last ${hours}h, ${ids.length - bad.length} identical, ${bad.length} differ`);
for (const b of bad) console.log(`  DIFF ${b.id}: ${b.why}`);
process.exit(bad.length ? 1 : 0);
