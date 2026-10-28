#!/usr/bin/env node
/**
 * Restore ONE calendar from a day's full archive (R2 archive/daily/YYYY-MM-DD.json.gz, written daily by
 * cloudflare/src/BackupArchive.js). Dry run by default: prints what the restore would change.
 *
 *   node scripts/restore-from-archive.mjs --base https://pastecal.com "<calendar id>" 2026-10-28
 *   node scripts/restore-from-archive.mjs --base https://pastecal.com "<calendar id>" 2026-10-28 --apply
 *   node scripts/restore-from-archive.mjs --base https://pastecal.com --list          # the daily archives
 *
 * --apply goes through the calendar's normal restore (POST /api/admin/backup/restore -> the room's
 * restore-version): the current state is saved first as a restore point (R2 snapshots/<id>/<time>.json, the
 * undo), and the restore is one "Restored the full backup from <date>" entry in Recent changes. It replaces events,
 * title and notes; every other setting (view link, Pro settings, lock) stays. A calendar that no longer
 * exists is recreated. A locked (Pro) calendar also needs --force.
 *
 * --base is required (no default), so production is never the accidental target. The admin secret comes
 * from IMPORT_SECRET, else the macOS Keychain item pastecal-import-secret; it is sent in a header, never
 * printed or put on a command line.
 *
 * Read the dry run before --apply: an archive that is itself empty means the damage predates it.
 * Older (pre-Cloudflare, Firebase layout) full backups are under firebase/ in the same bucket; this script
 * does not read them (see docs/backups.md).
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const apply = flag('--apply'), force = flag('--force'), list = flag('--list');
const base = (opt('--base') || '').replace(/\/+$/, '');
const [calendarId, date] = args;
const usage = 'usage: restore-from-archive.mjs --base <url> <calendar id> <YYYY-MM-DD> [--apply [--force]]  |  --base <url> --list';
if (!base || (!list && (!calendarId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')))) { console.error(usage); process.exit(2); }

let secret = process.env.IMPORT_SECRET || '';
if (!secret) {
    try { secret = execFileSync('security', ['find-generic-password', '-s', 'pastecal-import-secret', '-w'], { encoding: 'utf8' }).trim(); }
    catch { console.error('no IMPORT_SECRET and no Keychain item pastecal-import-secret'); process.exit(2); }
}
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };

if (list) {
    const r = await fetch(`${base}/api/admin/backup/list`, { headers });
    if (!r.ok) { console.error(`HTTP ${r.status}: ${await r.text()}`); process.exit(1); }
    for (const a of (await r.json()).archives) {
        console.log(`${a.date || a.key}  ${String(a.count).padStart(6)} calendars  ${String(a.dirRows).padStart(6)} names  ` +
            `${(a.size / 1e6).toFixed(2)} MB  failed ${a.failed || 0}  finished ${a.finishedAt || a.uploaded}`);
    }
    process.exit(0);
}

const r = await fetch(`${base}/api/admin/backup/restore`, { method: 'POST', headers, body: JSON.stringify({ calendarId, date, apply, force }) });
const out = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
if (!out.archived) { console.error(`${out.error || 'failed'}${out.message ? `: ${out.message}` : ''} (HTTP ${r.status})`); process.exit(1); }

const d = out.diff, a = out.archived, l = out.live;
console.log(`calendar  ${JSON.stringify(calendarId)}`);
console.log(`archive   ${date}: v${a.v}, ${a.events} events, title ${JSON.stringify(a.title || '')}${a.locked ? ', locked' : ''}`);
console.log(`live      ${l ? `v${l.v}, ${l.events} events, title ${JSON.stringify(l.title || '')}${l.locked ? ', locked (Pro)' : ''}` : '(missing: the restore recreates it)'}`);
if (l) {
    console.log(`restoring would: bring back ${d.added}, remove ${d.removed}, change ${d.changed} event(s)` +
        `${d.titleChanged ? ', change the title' : ''}${d.notesChanged ? ', change the notes' : ''}${d.same ? ' -- nothing: live equals the archive' : ''}`);
    for (const [label, t] of [['back', d.addedTitles], ['removed', d.removedTitles], ['changed', d.changedTitles]]) {
        for (const x of t) console.log(`   ${label.padEnd(8)} ${x}`);
    }
}
if (!apply) { console.log('\ndry run: nothing written. Add --apply to restore.'); process.exit(0); }
if (!out.ok) { console.error(`\nnot restored: ${out.error}${out.message ? ` -- ${out.message}` : ''}`); process.exit(1); }
console.log(out.unchanged ? '\nnothing to restore: live already equals the archive.'
    : `\nrestored${out.recreated ? ' (recreated)' : ''}${out.v ? `: live is now v${out.v}` : ''}. The state it replaced was saved first as a restore point (R2 snapshots/<id>/).`);
