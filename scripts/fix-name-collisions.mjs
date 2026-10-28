#!/usr/bin/env node
/**
 * Repair name collisions: directory rows that say a name is a view link (read-only) while an editable calendar
 * of that name exists, so its edit link forwarded to /view/<name> (45 calendars, Oct 28 2026; the cause and the
 * fix are in cloudflare/src/NameCollisions.js). Dry run by default: lists each collision, its row now and the row
 * the repair would write.
 *
 *   node scripts/fix-name-collisions.mjs --base https://pastecal.com                  # dry run, every view row checked
 *   node scripts/fix-name-collisions.mjs --base https://pastecal.com --apply          # repair the 'self' ones
 *   node scripts/fix-name-collisions.mjs --base https://pastecal.com --apply --include-cross
 *
 * Two kinds:
 *   self   the view link is named after its own calendar. The repair makes the row the calendar's edit row; the
 *          view link keeps working (the Worker serves /view/<name> from the calendar whose view id it is).
 *          Note: that view link IS the edit link's name, so whoever has it can edit. Renaming it is the owner's call.
 *   cross  the view link opens ANOTHER calendar. Repairing it gives the name back to the calendar of that name, and
 *          the other calendar's view link /view/<name> stops working (404). Only with --include-cross.
 *
 * --apply first writes every row it will change, as it is now, to fix-name-collisions-<time>.json in the current
 * folder (the undo: each row's actual_slug / is_readonly / target_id), then repairs them one at a time through
 * POST /api/admin/directory/make-editable (the row becomes {actual_slug: calendar id, is_readonly: 0, target_id:
 * calendar id}; only a live view row changes, and only if that calendar exists).
 *
 * --base is required (no default), so production is never the accidental target. The admin secret comes from
 * IMPORT_SECRET, else the macOS Keychain item pastecal-import-secret; it is sent in a header, never printed.
 * The scan reads every directory row (~14k) and checks each view row's name against the calendars, 300 a page.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const apply = flag('--apply'), includeCross = flag('--include-cross'), selfOnly = flag('--self-only');
const base = (opt('--base') || '').replace(/\/+$/, '');
if (!base || args.length) { console.error('usage: fix-name-collisions.mjs --base <url> [--self-only] [--apply [--include-cross]]'); process.exit(2); }

let secret = process.env.IMPORT_SECRET || '';
if (!secret) {
    try { secret = execFileSync('security', ['find-generic-password', '-s', 'pastecal-import-secret', '-w'], { encoding: 'utf8' }).trim(); }
    catch { console.error('no IMPORT_SECRET and no Keychain item pastecal-import-secret'); process.exit(2); }
}
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };

async function get(path) {
    const r = await fetch(`${base}${path}`, { headers });
    if (!r.ok) { console.error(`GET ${path.split('?')[0]}: HTTP ${r.status}`); process.exit(1); }
    return r.json();
}

// Every collision: --self-only asks only the cheap SQL candidates; otherwise every view row, a page at a time.
const found = [];
if (selfOnly) {
    found.push(...(await get('/api/admin/directory/collisions?scope=self')).collisions);
} else {
    let after = '', scanned = 0;
    do {
        const page = await get(`/api/admin/directory/collisions?limit=300&after=${encodeURIComponent(after)}`);
        found.push(...page.collisions);
        scanned += page.scanned;
        process.stderr.write(`scanned ${scanned} rows, ${found.length} collision(s)\r`);
        after = page.next;
    } while (after);
    process.stderr.write('\n');
}

const planned = (c) => ({ actual_slug: c.calendarId, is_readonly: 0, target_id: c.calendarId });
const show = (r) => `${JSON.stringify(r.actual_slug)} ${r.is_readonly ? 'view' : 'editable'} -> ${JSON.stringify(r.target_id)}`;
for (const kind of ['self', 'cross']) {
    const list = found.filter((c) => c.kind === kind);
    console.log(`\n${kind === 'self' ? 'SELF  (view named after its own calendar)' : 'CROSS (view opens another calendar; repairing ends that view link)'}: ${list.length}`);
    for (const c of list) {
        const made = c.row.created_at ? new Date(c.row.created_at).toISOString().slice(0, 10) : '?';
        console.log(`  ${c.name.padEnd(30)} now ${show(c.row)} (row ${made})\n  ${''.padEnd(30)} fix ${show(planned(c))}`);
    }
}

const todo = found.filter((c) => c.kind === 'self' || includeCross);
if (!apply) {
    console.log(`\nDry run. --apply would repair ${todo.length}${includeCross ? '' : ` (the ${found.length - todo.length} cross one(s) need --include-cross)`}.`);
    process.exit(0);
}
if (!todo.length) { console.log('\nNothing to repair.'); process.exit(0); }

const undo = `fix-name-collisions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(undo, JSON.stringify({ base, savedAt: new Date().toISOString(), rows: todo.map((c) => ({ normalized: c.normalized, kind: c.kind, ...c.row })) }, null, 2));
console.log(`\nSaved the ${todo.length} row(s) as they are now to ${undo} (the undo).`);

let fixed = 0;
for (const c of todo) {
    const r = await fetch(`${base}/api/admin/directory/make-editable`, { method: 'POST', headers, body: JSON.stringify({ name: c.name, calendarId: c.calendarId }) });
    const out = await r.json().catch(() => ({}));
    if (r.ok && out.ok) { fixed++; console.log(`  fixed ${c.name}: ${show(out.after)}`); }
    else console.log(`  NOT fixed ${c.name}: ${out.error || `HTTP ${r.status}`}`);
}
console.log(`\nRepaired ${fixed} of ${todo.length}.`);
process.exit(fixed === todo.length ? 0 : 1);
