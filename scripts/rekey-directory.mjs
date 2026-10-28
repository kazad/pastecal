#!/usr/bin/env node
/**
 * Re-key the directory: move every row stored under its old key (lowercase only) to CalendarName.key (trimmed,
 * lowercase, NFC). The rules, and why a collision keeps the row it keeps, are in cloudflare/src/Rekey.js. Until this
 * runs the Worker also reads a row at its old key, so nothing is broken in between; afterwards a name such as
 * "royal city" also finds the calendar "royal city ". Dry run by default.
 *
 *   node scripts/rekey-directory.mjs --base https://pastecal.com            # dry run: every move, duplicate and collision
 *   node scripts/rekey-directory.mjs --base https://pastecal.com --apply    # saves the rows first, then re-keys
 *
 * --apply first runs the dry run and writes every row it will change, as it is now, to rekey-directory-<time>.json in
 * the current folder (with the plan); then applies, and appends the result to that file. Each change is a
 * compare-and-set: a row that changed since the plan is left alone and listed. Running it again finds nothing to do.
 *
 * --base is required (no default), so production is never the accidental target. The admin secret comes from
 * IMPORT_SECRET, else the macOS Keychain item pastecal-import-secret; it is sent in a header, never printed.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const apply = flag('--apply');
const base = (opt('--base') || '').replace(/\/+$/, '');
if (!base || args.length) { console.error('usage: rekey-directory.mjs --base <url> [--apply]'); process.exit(2); }

let secret = process.env.IMPORT_SECRET || '';
if (!secret) {
    try { secret = execFileSync('security', ['find-generic-password', '-s', 'pastecal-import-secret', '-w'], { encoding: 'utf8' }).trim(); }
    catch { console.error('no IMPORT_SECRET and no Keychain item pastecal-import-secret'); process.exit(2); }
}
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };

async function rekey(doApply) {
    const r = await fetch(`${base}/api/admin/directory/rekey`, { method: 'POST', headers, body: JSON.stringify({ apply: doApply }) });
    const out = await r.json().catch(() => null);
    if (!r.ok || !out || !out.ok) { console.error(`rekey: HTTP ${r.status} ${out && out.error ? out.error : ''}`); process.exit(1); }
    return out;
}
const q = (s) => JSON.stringify(s);
const row = (r) => `${q(r.actual_slug)} ${r.kind}${r.kind === 'view' ? ` -> ${q(r.target_id)}` : ''}${r.live === false ? ' (no calendar)' : ''}`;

const plan = await rekey(false);
console.log(`${plan.scanned} rows scanned.`);
console.log(`\nMOVES (row to its new key): ${plan.moves.length}`);
for (const m of plan.moves) console.log(`  ${q(m.from)} -> ${q(m.to)}   ${q(m.actualSlug)} ${m.kind}`);
console.log(`\nDUPLICATES (one name, one place, two rows; one is dropped): ${plan.duplicates.length}`);
for (const d of plan.duplicates) console.log(`  ${q(d.key)}: keep row at ${q(d.kept.normalized)}, drop row at ${q(d.dropped.normalized)} (${q(d.kept.actual_slug)})`);
console.log(`\nCOLLISIONS (two names, one key; the others stay reachable at their exact names): ${plan.collisions.length}`);
for (const c of plan.collisions) {
    console.log(`  ${q(c.key)}: keep ${row(c.kept)}`);
    for (const d of c.dropped) console.log(`  ${''.padEnd(q(c.key).length)}  drop ${row(d)}: ${d.why}`);
}
if (plan.viewLinksEnded.length) {
    console.log(`\n!! VIEW LINKS THAT WOULD END (the editable calendar keeps the name): ${plan.viewLinksEnded.length}`);
    for (const v of plan.viewLinksEnded) console.log(`  /view/${v.viewId} (opened ${q(v.opened)}) -> the name now opens ${q(v.nowOpens)}`);
}
if (plan.skipped.length) {
    console.log(`\nSKIPPED (a tombstone holds the name; left as is): ${plan.skipped.length}`);
    for (const s of plan.skipped) console.log(`  ${q(s.key)}: ${s.rows.map(row).join(', ')}`);
}
if (plan.anomalies.length) {
    console.log(`\nANOMALIES (stored key is neither the old nor the new one; left as is): ${plan.anomalies.length}`);
    for (const a of plan.anomalies) console.log(`  at ${q(a.normalized)}: ${row(a)}`);
}
console.log(`\nRegistry entries whose name_key changes: ${plan.roomsStale}`);

const changes = plan.moves.length + plan.duplicates.length + plan.collisions.reduce((n, c) => n + c.dropped.length, 0) + plan.roomsStale;
if (!apply) { console.log(`\nDry run. --apply would make ${changes} change(s).`); process.exit(0); }
if (!changes) { console.log('\nNothing to re-key.'); process.exit(0); }

const file = `rekey-directory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ base, savedAt: new Date().toISOString(), plan }, null, 2));
console.log(`\nSaved every row it will change, as it is now, to ${file} (the undo).`);
const done = await rekey(true);
writeFileSync(file, JSON.stringify({ base, savedAt: new Date().toISOString(), plan, applied: done.applied, appliedPlan: done }, null, 2));
const a = done.applied || {};
console.log(`Moved ${a.moved}, dropped ${a.dropped}, registry re-keyed ${a.roomsRekeyed}.`);
if ((a.changed || []).length || (a.taken || []).length) {
    console.log(`Left alone (changed since the plan, or the key was taken): ${[...(a.changed || []), ...(a.taken || [])].map((r) => q(r.actual_slug)).join(', ')}. Run again.`);
    process.exit(1);
}
