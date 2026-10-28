#!/usr/bin/env node
/**
 * Fill the registry of exact calendar ids (CalendarDirectory rooms; cloudflare/src/ExactNames.js) from a list of ids,
 * so the daily archive and the new-name check know every calendar, case variants and spaced names included (Oct 28
 * 2026: 54 calendars with 4,974 events had no directory row of their own and were missing from the archive).
 * Dry run by default: says how many ids are registered already, how many would be added (their calendar exists on
 * Cloudflare), and lists the ones with no calendar there.
 *
 *   node scripts/backfill-rooms.mjs --base https://pastecal.com ids.json            # dry run
 *   node scripts/backfill-rooms.mjs --base https://pastecal.com ids.json --apply    # register them
 *
 * ids.json: a JSON array of calendar ids, exactly as stored ("Foo", "foo" and "2026_2027cvpilot " are three ids: never
 * trimmed or lowercased), or a JSON object whose KEYS are the ids (a Firebase export's calendars). 500 ids a request.
 * Registering is idempotent; only ids whose calendar exists are added.
 *
 * --base is required (no default), so production is never the accidental target. The admin secret comes from
 * IMPORT_SECRET, else the macOS Keychain item pastecal-import-secret; it is sent in a header, never printed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const apply = flag('--apply');
const base = (opt('--base') || '').replace(/\/+$/, '');
const file = args.shift();
if (!base || !file || args.length) { console.error('usage: backfill-rooms.mjs --base <url> <ids.json> [--apply]'); process.exit(2); }

const parsed = JSON.parse(readFileSync(file, 'utf8'));
const ids = [...new Set(Array.isArray(parsed) ? parsed : Object.keys(parsed || {}))].filter((x) => typeof x === 'string');
if (!ids.length) { console.error(`${file}: no ids`); process.exit(2); }

let secret = process.env.IMPORT_SECRET || '';
if (!secret) {
    try { secret = execFileSync('security', ['find-generic-password', '-s', 'pastecal-import-secret', '-w'], { encoding: 'utf8' }).trim(); }
    catch { console.error('no IMPORT_SECRET and no Keychain item pastecal-import-secret'); process.exit(2); }
}
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };

const BATCH = 500;
const total = { asked: 0, known: 0, toAdd: 0, added: 0 };
const missing = [], invalid = [], failed = [];
for (let i = 0; i < ids.length; i += BATCH) {
    const r = await fetch(`${base}/api/admin/rooms/backfill`, { method: 'POST', headers, body: JSON.stringify({ ids: ids.slice(i, i + BATCH), apply }) });
    if (!r.ok) { console.error(`backfill: HTTP ${r.status} at id ${i}`); process.exit(1); }
    const out = await r.json();
    for (const k of Object.keys(total)) total[k] += out[k] || 0;
    missing.push(...out.missing); invalid.push(...out.invalid); failed.push(...out.failed);
    process.stderr.write(`${Math.min(i + BATCH, ids.length)} of ${ids.length} ids\r`);
}
process.stderr.write('\n');

const show = (label, list) => { if (list.length) console.log(`\n${label} (${list.length}):\n${list.slice(0, 200).map((id) => `  ${JSON.stringify(id)}`).join('\n')}${list.length > 200 ? '\n  ...' : ''}`); };
show('No calendar on Cloudflare at this exact id', missing);
show('Not a valid id', invalid);
show('Could not be checked (try again)', failed);
console.log(`\n${ids.length} ids: ${total.known} registered already, ${total.toAdd} ${apply ? 'to add' : 'would be added'}` +
    `${apply ? `, ${total.added} added` : ''}, ${missing.length} with no calendar, ${invalid.length} invalid, ${failed.length} unchecked.`);
if (!apply) console.log('Dry run. --apply registers them.');
const stats = await (await fetch(`${base}/api/admin/rooms/stats`, { headers })).json().catch(() => null);
if (stats) console.log(`Registry: ${stats.rooms} calendars (directory: ${stats.editable} edit names).`);
if (failed.length) process.exit(1);
