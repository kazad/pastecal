// The daily full archive (BackupArchive.js), against `wrangler dev --local --test-scheduled --persist-to $PERSIST
// --var ARCHIVE_CHUNK:3`: 3 directory rows or 3 calendars per step, so a handful of calendars spans many alarm
// invocations. Reads the archive from the local R2 bucket with `wrangler r2 object get --local`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret', PERSIST = process.env.PERSIST;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const today = new Date().toISOString().slice(0, 10);
const enc = encodeURIComponent;
const at = (d, h) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1 });
const auth = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const admin = (path, body) => fetch(`${BASE}/api/admin/backup/${path}`, body === undefined ? { headers: auth } : { method: 'POST', headers: auth, body: JSON.stringify(body) });
let ip = 0;
const create = (id, cal) => fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: { 'CF-Connecting-IP': `10.88.0.${++ip}` }, body: JSON.stringify(cal) });
const replace = (id, cal) => fetch(`${BASE}/cal/${enc(id)}/import`, { method: 'PUT', headers: auth, body: JSON.stringify({ id, ...cal }) });
const live = async (id) => (await fetch(`${BASE}/cal/${enc(id)}`)).json();

function archiveLines(date) {
    const f = `/tmp/db-archive-test-${process.pid}.gz`; rmSync(f, { force: true });
    execFileSync(process.execPath, ['node_modules/.bin/wrangler', 'r2', 'object', 'get', `pastecal-backups/archive/daily/${date}.json.gz`,
        '--local', '--persist-to', PERSIST, '--file', f], { stdio: 'pipe' });
    return gunzipSync(readFileSync(f)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
}
async function waitDone(run) {
    for (let i = 0; i < 240; i++) {
        const { job } = await (await admin('status')).json();
        if (job && job.done && (!run || job.run === run)) return job;
        await sleep(250);
    }
    throw new Error('the archive run did not finish');
}
function script(...args) {
    return execFileSync(process.execPath, ['../scripts/restore-from-archive.mjs', '--base', BASE, ...args],
        { encoding: 'utf8', env: { ...process.env, IMPORT_SECRET: SECRET } });
}

// 1. Admin only.
for (const [path, method] of [['run', 'POST'], ['status', 'GET'], ['list', 'GET'], ['health', 'GET'], ['restore', 'POST']]) {
    assert.equal((await fetch(`${BASE}/api/admin/backup/${path}`, { method })).status, 403, path);
    assert.equal((await fetch(`${BASE}/api/admin/backup/${path}`, { method, headers: { Authorization: 'Bearer wrong' } })).status, 403, path);
}
step('every /api/admin/backup route refuses a request without the secret, or with a wrong one');

// 2. No archive yet: health is red.
let r = await admin('health');
assert.equal(r.status, 503);
let h = await r.json();
assert.equal(h.ok, false); assert.match(h.problems[0], /no daily full archive/);
step('health before any archive: 503, "no daily full archive for today or yesterday"');

// 3. Seed free calendars (odd names included) and a view link.
const run = Date.now().toString(36);
const ids = [`dbarch-${run}-0`, `dbarch ${run} 강아지`, `DbArch-${run}-Caps`, `dbarch-${run}-empty`, `dbarch-${run}-4`, `dbarch-${run}-5`, `test-dbarch-${run}-gone`];
for (const [i, id] of ids.entries()) {
    const events = id.endsWith('empty') ? [] : Array.from({ length: i + 1 }, (_, k) => ev(`e${k}`, `${id} event ${k}`, 1 + k));
    r = await create(id, { title: `Calendar ${i}`, events });
    assert.equal(r.status, 201, `${id}: ${await r.text()}`);
}
const view = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.88.1.1' },
    body: JSON.stringify({ sourceCalendarId: ids[0] }) })).json();
assert.ok(view.publicViewId, JSON.stringify(view));
await sleep(1500);                                                       // directory registration runs after the reply
step(`seeded ${ids.length} free calendars (a space and Hangul, capitals, an empty one) and a view link (${view.publicViewId})`);

// 4. The cron starts the run; it finishes over many alarm steps; the file holds every calendar.
r = await fetch(`${BASE}/__scheduled?cron=${enc('0 9 * * *')}`);
assert.ok(r.ok, `__scheduled: ${r.status}`);
let job = await waitDone();
assert.equal(job.date, today);
assert.equal(job.count, ids.length, JSON.stringify(job));
assert.equal(job.failed, 0);
assert.ok(job.part >= 6 && job.steps >= 7, `chunked: ${job.part} parts in ${job.steps} steps`);
let lines = archiveLines(today);
assert.equal(lines[0].t, 'archive'); assert.equal(lines[0].date, today); assert.equal(lines[0].version, 1);
assert.equal(lines.at(-1).t, 'end'); assert.equal(lines.at(-1).count, ids.length);
const cals = new Map(lines.filter((l) => l.t === 'cal').map((l) => [l.id, l]));
assert.deepEqual([...cals.keys()].sort(), [...ids].sort());
for (const id of ids) {
    const got = await live(id);
    assert.deepEqual(cals.get(id).calendar, got.calendar, id);
    assert.equal(cals.get(id).v, got.v);
}
const dirRows = lines.filter((l) => l.t === 'dir').map((l) => l.row);
const viewRow = dirRows.find((x) => x.actual_slug === view.publicViewId);
assert.ok(viewRow && viewRow.is_readonly === 1 && viewRow.target_id === ids[0], 'the view link row');
assert.equal(dirRows.length, ids.length + 1);
assert.ok(!JSON.stringify(lines).match(/key_hash|editorKey/), 'no editor keys');
step(`cron run: ${job.count} calendars in ${job.part} parts over ${job.steps} alarm steps; every calendar equals the live one; the view link row is there`);

r = await admin('list');
let list = (await r.json()).archives;
assert.equal(list.length, 1);
assert.equal(list[0].key, `archive/daily/${today}.json.gz`);
assert.equal(list[0].count, String(ids.length)); assert.equal(list[0].version, '1'); assert.equal(list[0].failed, '0');
assert.ok(Number(list[0].bytes) > Number(list[0].gzBytes) && Number(list[0].gzBytes) === list[0].size);
step(`list: archive/daily/${today}.json.gz with customMetadata count ${list[0].count}, ${list[0].bytes} bytes (${list[0].size} gzipped), version 1`);

// 5. Health is green.
r = await admin('health');
h = await r.json();
assert.equal(r.status, 200, JSON.stringify(h));
assert.equal(h.ok, true); assert.equal(h.newest.date, today); assert.equal(h.newest.count, ids.length); assert.equal(h.editable, ids.length);
assert.ok(h.newest.ageHours < 1);
step(`health: ok (newest ${h.newest.date}, ${h.newest.count} of ${h.editable} calendars, ${h.newest.ageHours}h old)`);

// 6. Rerunning the same day overwrites that day's file.
r = await replace(ids[0], { title: 'Calendar 0', events: [ev('e0', `${ids[0]} event 0`, 1), ev('new', 'added after the first run', 20)] });
assert.ok(r.ok, await r.text());
const started = (await (await admin('run', {})).json()).job;
job = await waitDone(started.run);
lines = archiveLines(today);
const again = lines.find((l) => l.t === 'cal' && l.id === ids[0]);
assert.ok(again.calendar.events.some((e) => e.id === 'new'), 'the rerun holds the later change');
assert.equal(lines.filter((l) => l.t === 'cal').length, ids.length);
list = (await (await admin('list')).json()).archives;
assert.equal(list.length, 1); assert.equal(list[0].run, started.run);
step('rerun (POST /api/admin/backup/run): a new run overwrites the same day\'s file, which now holds the later change');

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
r = await fetch(`${BASE}/api/admin/backup/run?date=${yesterday}`, { method: 'POST', headers: auth });
assert.equal(r.status, 400); assert.equal((await r.json()).error, 'today-only');
assert.deepEqual((await (await admin('list')).json()).archives, list);
assert.equal((await (await admin('status')).json()).job.run, started.run, 'no run started');
step('a run for another day (?date=yesterday) is refused (400 today-only): past days are never rewritten with today\'s calendars');

// 7. Restore dry run: the right diff, nothing written.
const archived = again.calendar;
r = await replace(ids[0], { title: 'Damaged', events: [ev('stray', 'a stray event', 3)] });
assert.ok(r.ok);
const damaged = await live(ids[0]);
let out = script(ids[0], today);
assert.match(out, /restoring would: bring back 2, remove 1, change 0 event\(s\), change the title/);
assert.match(out, /back +.*event 0/); assert.match(out, /removed +a stray event/);
assert.match(out, /dry run: nothing written/);
assert.deepEqual(await live(ids[0]), damaged, 'a dry run writes nothing');
r = await admin('restore', { calendarId: ids[0], date: today });
let res = await r.json();
assert.equal(res.dryRun, true); assert.equal(res.diff.added, 2); assert.equal(res.diff.removed, 1); assert.equal(res.diff.titleChanged, true);
step('restore dry run (script and route): bring back 2, remove 1, title changes; the live calendar is untouched');

// 8. --apply restores through the room's normal restore: history entry, restore point.
out = script(ids[0], today, '--apply');
assert.match(out, /restored: live is now v\d+/);
let after = await live(ids[0]);
assert.deepEqual(after.calendar.events, archived.events);
assert.equal(after.calendar.title, archived.title);
assert.equal(after.v, damaged.v + 1);
const hist = await (await fetch(`${BASE}/cal/${enc(ids[0])}/history`)).json();
assert.equal(hist[0].kind, 'restored'); assert.match(hist[0].label, new RegExp(`full backup from ${today}`));
assert.match(script(ids[0], today, '--apply'), /nothing to restore/);
step(`--apply: events and title back as archived, v${damaged.v} -> v${after.v}, one "${hist[0].label}" history entry; a second apply changes nothing`);

// 9. A calendar that is gone is recreated.
r = await fetch(`${BASE}/cal/${enc(ids[6])}/archive`, { method: 'POST', headers: auth });
assert.equal((await r.json()).ok, true);
assert.equal((await fetch(`${BASE}/cal/${enc(ids[6])}`)).status, 404);
out = script(ids[6], today);
assert.match(out, /missing: the restore recreates it/);
out = script(ids[6], today, '--apply');
assert.match(out, /restored \(recreated\)/);
after = await live(ids[6]);
assert.deepEqual(after.calendar.events, cals.get(ids[6]).calendar.events);
step('a calendar that no longer exists: the dry run says so, --apply recreates it with its archived events');

// 10. Not in the archive, or no archive that day.
r = await admin('restore', { calendarId: 'never-was-here', date: today });
assert.equal(r.status, 404); assert.equal((await r.json()).error, 'not-in-archive');
r = await admin('restore', { calendarId: ids[0], date: '2020-01-01' });
assert.equal(r.status, 404); assert.equal((await r.json()).error, 'no-archive');
r = await admin('restore', { calendarId: ids[0], date: '../x' });
assert.equal(r.status, 400);
step('restore: 404 not-in-archive, 404 no-archive, 400 for a malformed date');

// 11. Health goes red when the directory has grown past the archive (95%).
for (const k of [1, 2]) assert.equal((await create(`dbarch-${run}-later-${k}`, { title: 'later', events: [] })).status, 201);
await sleep(1500);
r = await admin('health');
h = await r.json();
assert.equal(r.status, 503, JSON.stringify(h));
assert.ok(h.problems.some((p) => /under 95% of the directory/.test(p)), JSON.stringify(h.problems));
step(`health: 503 when the archive holds ${h.newest.count} of ${h.editable} calendars (under 95%)`);

console.log(`\n${n} checks passed`); process.exit(0);
