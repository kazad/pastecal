// Copy every calendar from a Firebase export into the Worker, then read each back and
// compare. Usage: node scripts/migrate.mjs <calendars.json> [BASE] ; IMPORT_SECRET in env.
// A dry run is the same against `wrangler dev`.
import { readFileSync } from 'node:fs';
const [file, BASE = 'http://localhost:8787'] = process.argv.slice(2);
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const all = JSON.parse(readFileSync(file, 'utf8'));
const only = process.env.ONLY ? new Set(JSON.parse(process.env.ONLY)) : null;
const ids = Object.keys(all).filter((k) => !only || only.has(k)).filter((k) => all[k] && typeof all[k] === 'object' && !/[.#$\[\]\/]/.test(k));
const skipped = Object.keys(all).filter((k) => !ids.includes(k));
const list = (v) => (Array.isArray(v) ? v : Object.values(v || {})).filter(Boolean);
const stats = { ok: 0, mismatch: [], failed: [], renamed: 0, events: 0 };
const t0 = Date.now();
async function one(id) {
    const cal = all[id];
    const r = await fetch(`${BASE}/cal/${encodeURIComponent(id)}/import`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ ...cal, id }) });
    const res = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!res.ok) return stats.failed.push(`${id}: ${res.error}`);
    stats.renamed += res.renamedDuplicates; stats.events += res.events;
    const back = (await (await fetch(`${BASE}/cal/${encodeURIComponent(id)}`)).json()).calendar;
    const src = list(cal.events), got = back.events;
    // Identical, field for field and in order -- except a renamed duplicate's id.
    const same = src.length === got.length && src.every((e, i) => JSON.stringify({ ...e, id: 0 }) === JSON.stringify({ ...got[i], id: 0 }))
        && (back.title ?? '') === (cal.title ?? '') && JSON.stringify(back.options || {}) === JSON.stringify(cal.options || {});
    if (same) stats.ok++; else stats.mismatch.push(id);
}
for (let i = 0; i < ids.length; i += 25) await Promise.all(ids.slice(i, i + 25).map((id) => one(id).catch((e) => stats.failed.push(`${id}: ${e.message}`))));
console.log(JSON.stringify({ calendars: ids.length, identical: stats.ok, mismatched: stats.mismatch.length, failed: stats.failed.length,
    events: stats.events, duplicateIdsRenamed: stats.renamed, skippedKeys: skipped, seconds: Math.round((Date.now() - t0) / 1000) }, null, 1));
if (stats.mismatch.length) console.log('mismatched:', stats.mismatch.slice(0, 10));
if (stats.failed.length) console.log('failed:', stats.failed.slice(0, 10));
