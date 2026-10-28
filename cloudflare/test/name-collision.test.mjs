// Name collisions (Oct 28 2026: 45 calendars' edit links forwarded to /view/<name>), against `wrangler dev` with
// ACCOUNTS_DEV_MODE=1 (the directory's test hooks: dev-plant, dev/{register,claim,remove}). Sections:
//   1. a view name equal to its own calendar's (any case) is refused, even with the calendar's directory row deleted
//   2. a view name equal to ANOTHER calendar's is refused (directory unchanged); a free name works as before
//   3. no directory write path turns an editable row into a view row: directory register (forced) and claim; create-view;
//      a room registering on /import, /from-firebase, a Pro upgrade (lock) and healTrimmedName (a save)
//   4. bulk backfill with an editable and a view of one name, either order: editable wins; backfill-directory.mjs's
//      builder reports the collision
//   6. the collision admin route lists planted collisions (self, cross); make-editable repairs; the repair script writes
//      its undo file; 403 without the secret
//   7. the production case: calendar kazumichi, options.publicViewId 'kazumichi', a view mirror of the same name,
//      migrated through the backfill path, then a Pro-upgrade re-register: still editable, its view link still opens
// (5, the edit page, is the browser half: name-collision.spec.js.)
//
//   scripts/test-all.sh --only name-collision
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDirectoryEntries } from '../scripts/backfill-directory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://localhost:8787';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const T = Date.now().toString(36);
const name = (p) => `nc${p}${T}${Math.floor(Math.random() * 1e4)}`;
const url = (id, sub = '') => `${BASE}/cal/${encodeURIComponent(id)}${sub}`;
const admin = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (d) => new Date(Date.UTC(2026, 9, d, 9)).toISOString();
const ev = (id) => ({ id, title: id, start: at(1), end: at(1).replace('T09', 'T10'), type: 1 });
// PUT /import (not rate-limited like POST): a calendar with one event; it registers itself in the directory.
const make = async (id, options = {}, sub = '/import') => {
    const r = await fetch(url(id, sub), { method: 'PUT', headers: admin, body: JSON.stringify({ id, title: id, options, events: [ev('e1')] }) });
    assert.equal(r.status, 200, `${sub} ${id}`);
};
const lookup = async (slug) => (await fetch(`${BASE}/api/lookup?slug=${encodeURIComponent(slug)}`)).json();
const settle = async (slug, pred, ms = 4000) => {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { last = await lookup(slug); if (pred(last)) return last; await sleep(50); }
    return last;
};
const editable = (l) => !!(l && l.found && l.isReadOnly === false);
// After a write that registers in the background (waitUntil): give it time, then the row must still be editable.
const staysEditable = async (slug, why) => { await sleep(600); assert.ok(editable(await lookup(slug)), `${slug} stays editable: ${why}`); };
const post = (p, body, headers = admin) => fetch(`${BASE}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
const view = (body) => post('/api/create-view', body, { 'Content-Type': 'application/json' });
const dev = (op, body) => post(`/api/admin/directory/dev/${op}`, body);
const plant = (row, headers = admin) => post('/api/admin/directory/dev-plant', row, headers);
const collisions = (q, headers = admin) => fetch(`${BASE}/api/admin/directory/collisions${q}`, { headers });
const backfill = async (items) => { const r = await post('/api/directory/backfill', items); assert.equal(r.status, 200); return r.json(); };

function tab(id) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${encodeURIComponent(id)}/ws`);
    const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const waitFor = async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await sleep(20); }
        throw new Error('timed out');
    };
    return { ready: waitFor((m) => m.t === 'snapshot'), send: (m) => { ws.send(JSON.stringify(m)); return waitFor((x) => x.id === m.id && (x.t === 'ack' || x.t === 'error')); }, close: () => ws.close() };
}

const foo = name('foo'), bar = name('bar');
await make(foo); await make(bar);
assert.ok(editable(await settle(foo, editable)) && editable(await settle(bar, editable)), 'both registered as editable');

// ---- 1. a view name equal to its own calendar's ------------------------------------------------
for (const slug of [foo, foo.toUpperCase()]) {
    const r = await view({ sourceCalendarId: foo, customSlug: slug });
    assert.equal(r.status, 409, `view ${slug} of ${foo}`);
    const out = await r.json();
    assert.equal(out.error, 'already-exists'); assert.equal(out.reason, 'calendar');
}
assert.ok(editable(await lookup(foo)));
// The calendar's directory row deleted (a calendar can exist without one): still refused, and nothing written.
const rowless = name('rowless');
await make(rowless); await settle(rowless, editable);
assert.equal((await dev('remove', { slug: rowless })).status, 200);
assert.equal((await lookup(rowless)).found, false, 'its row is gone');
for (const slug of [rowless, rowless.toUpperCase()]) {
    const r = await view({ sourceCalendarId: rowless, customSlug: slug });
    assert.equal(r.status, 409, `own name ${slug} with no directory row`);
    assert.equal((await r.json()).reason, 'calendar');
}
assert.equal((await lookup(rowless)).found, false, 'no view row was written');
step('1. create-view refuses the calendar\'s own name as its view name (any case), even with its directory row deleted');

// ---- 2. another calendar's name is refused; a free name works ------------------------------------
let r = await view({ sourceCalendarId: bar, customSlug: foo });
assert.equal(r.status, 409); assert.equal((await r.json()).error, 'already-exists');
assert.deepEqual(await lookup(foo), { found: true, actualSlug: foo, isReadOnly: false, targetId: foo }, 'directory unchanged');
const free = name('free');
r = await view({ sourceCalendarId: bar, customSlug: free });
assert.equal(r.status, 200);
assert.equal((await r.json()).publicViewId, free);
assert.equal((await lookup(free)).isReadOnly, true, 'the new view name is a view link');
assert.equal((await (await fetch(`${BASE}/cal/view/${free}`)).json()).calendar.title, bar, '/view/<free> opens bar');
await sleep(300);
assert.equal((await (await fetch(url(bar))).json()).calendar.options.publicViewId, free, 'saved as the calendar\'s view id');
step('2. create-view refuses another calendar\'s name (directory unchanged); a free name works and opens the calendar');

// ---- 3. every write path leaves an editable row editable -----------------------------------------
// The directory's own routes, called directly (their callers refuse first, so these guard the guard).
r = await dev('register', { actualSlug: foo, isReadOnly: true, targetId: bar, force: true });
assert.equal((await r.json()).editable, true, 'register (forced) refused');
assert.ok(editable(await lookup(foo)), 'register');
r = await dev('register', { actualSlug: foo, isReadOnly: true, targetId: foo, force: true });
assert.equal((await r.json()).editable, true, 'register of its own name as a view refused');
assert.ok(editable(await lookup(foo)), 'register, own name');
r = await dev('claim', { slug: foo, targetId: bar, isReadOnly: true });
assert.equal(r.status, 409); assert.ok(editable(await lookup(foo)), 'claim');
const claimOwn = name('claimown');
r = await dev('claim', { slug: claimOwn, targetId: claimOwn, isReadOnly: true });
assert.equal(r.status, 409, 'claim of a view name equal to its target'); assert.equal((await lookup(claimOwn)).found, false);
step('3a. directory register (even forced) and claim never put a view row over an editable one');

r = await view({ sourceCalendarId: bar, customSlug: foo.toUpperCase() });
assert.equal(r.status, 409); assert.ok(editable(await lookup(foo)), 'create-view');
step('3b. create-view never takes an editable calendar\'s name');

// A room registers its name and its view id: on /import, /from-firebase, a Pro upgrade, and its first save (heal).
const viaImport = name('imp');
await make(viaImport, { publicViewId: viaImport });
await settle(viaImport, editable);
await make(viaImport, { publicViewId: viaImport, notes: 'again' });
await staysEditable(viaImport, '/import with its own name as its view id');
step('3c. /import of a calendar whose view id is its own name');

const viaFb = name('fb');
await make(viaFb, { publicViewId: viaFb }, '/from-firebase');   // first sight: a plain copy, which registers name and view id
await settle(viaFb, editable);
await staysEditable(viaFb, '/from-firebase');
assert.equal((await (await fetch(url(viaFb))).json()).calendar.options.publicViewId, viaFb, 'the Firebase write landed');
step('3d. /from-firebase creating a calendar whose view id is its own name');

const viaLock = name('pro');
await make(viaLock, { publicViewId: viaLock });
await settle(viaLock, editable);
r = await post(`/api/admin/cal/${viaLock}/lock`, { ownerId: 'nc-owner', plan: 'pro' });
assert.equal(r.status, 200, 'locked (the Pro upgrade path)');
await staysEditable(viaLock, 'Pro upgrade re-registers its name and view id, forced');
step('3e. a Pro upgrade (lock: forced re-register of name and view id)');

const viaHeal = `${name('heal')} `;   // a trailing space: healTrimmedName re-registers on its first save
await make(viaHeal, { publicViewId: viaHeal });
await settle(viaHeal, editable);
const t = tab(viaHeal); await t.ready;
const ack = await t.send({ t: 'save', id: 's1', v: (await (await fetch(url(viaHeal))).json()).v, commands: [{ type: 'add', event: ev('e2') }] });
assert.equal(ack.t, 'ack');
t.close();
await staysEditable(viaHeal, 'healTrimmedName');
step('3f. healTrimmedName (a save re-registering name and view id)');

// ---- 4. bulk backfill: editable wins, in either order ---------------------------------------------
let out = await backfill([{ actualSlug: foo, isReadOnly: true, targetId: bar }]);
assert.deepEqual(out.skipped, [foo]);
assert.ok(editable(await lookup(foo)), 'an existing editable row');
const ab = name('ab'), ba = name('ba');
out = await backfill([
    { actualSlug: ab, isReadOnly: false, targetId: ab }, { actualSlug: ab, isReadOnly: true, targetId: bar },   // editable, then view
    { actualSlug: ba, isReadOnly: true, targetId: bar }, { actualSlug: ba, isReadOnly: false, targetId: ba },   // view, then editable
]);
assert.deepEqual(out.skipped, [ab]);
assert.ok(editable(await lookup(ab)), 'editable then view: editable');
assert.ok(editable(await lookup(ba)), 'view then editable: editable');
assert.equal((await fetch(`${BASE}/api/directory/backfill`, { method: 'POST', body: '[]' })).status, 403);
// The migration script's builder: editable wins, and the collision is reported.
const built = buildDirectoryEntries({ calKeys: ['Team1'], slugMappings: {}, views: [{ key: 'team1', targetId: 'Team1' }, { key: 'v123', targetId: 'Team1' }] });
assert.deepEqual(built.entries.get('team1'), { actualSlug: 'Team1', isReadOnly: false, targetId: 'Team1' });
assert.deepEqual(built.entries.get('v123'), { actualSlug: 'v123', isReadOnly: true, targetId: 'Team1' });
assert.deepEqual(built.collisions, [{ name: 'team1', calendar: 'Team1', viewOpens: 'Team1' }]);
step('4. backfill never replaces an editable row (either order in one batch; skipped reported); backfill-directory.mjs reports the collision');

// ---- 6. the collision route, the repair route, the repair script ------------------------------------
const self = name('self'), crossA = name('crossa'), crossB = name('crossb');
await make(self, { publicViewId: self });
await make(crossA); await make(crossB);
await settle(self, editable); await settle(crossB, editable);
assert.equal((await plant({ actualSlug: self, isReadOnly: true, targetId: self }, { 'Content-Type': 'application/json' })).status, 403);
assert.equal((await plant({ actualSlug: self, isReadOnly: true, targetId: self })).status, 200);       // the shape the cutover left
assert.equal((await plant({ actualSlug: crossB, isReadOnly: true, targetId: crossA })).status, 200);   // a view named like another calendar
assert.equal((await lookup(self)).isReadOnly, true, 'planted');

assert.equal((await collisions('?scope=self', {})).status, 403);
assert.equal((await collisions('', { Authorization: 'Bearer wrong' })).status, 403);
let found = (await (await collisions('?scope=self')).json()).collisions;
assert.ok(found.some((c) => c.name === self && c.kind === 'self' && c.calendarId === self), 'scope=self lists the self collision');
assert.ok(!found.some((c) => c.name === crossB), 'scope=self does not list the cross one');
const all = []; let after = '', pages = 0;
do {
    const page = await (await collisions(`?limit=3&after=${encodeURIComponent(after)}`)).json();
    all.push(...page.collisions); after = page.next; pages++;
} while (after && pages < 500);
assert.ok(pages > 1, 'paginated');
assert.ok(all.some((c) => c.name === self && c.kind === 'self'), 'full scan: self');
assert.ok(all.some((c) => c.name === crossB && c.kind === 'cross' && c.calendarId === crossB && c.row.target_id === crossA), 'full scan: cross');
assert.ok(!all.some((c) => c.name === foo || c.name === bar), 'editable rows are not collisions');
step('6a. the collision route lists planted self and cross collisions (scope=self and the paginated scan); 403 without the secret');

assert.equal((await fetch(`${BASE}/cal/view/${self}`)).status, 200, 'planted: its view opens');
const repair = (body, headers = admin) => post('/api/admin/directory/make-editable', body, headers);
assert.equal((await repair({ name: self, calendarId: self }, { 'Content-Type': 'application/json' })).status, 403);
assert.equal((await repair({ name: self, calendarId: self }, { Authorization: 'Bearer wrong' })).status, 403);
assert.equal((await repair({ name: name('ghost'), calendarId: name('ghost') })).status, 404, 'no such calendar');
assert.equal((await repair({ name: self, calendarId: crossA })).status, 400, 'calendarId must be this name');
r = await repair({ name: self, calendarId: self });
out = await r.json();
assert.equal(r.status, 200); assert.equal(out.before.is_readonly, 1); assert.equal(out.after.is_readonly, 0); assert.equal(out.after.target_id, self);
assert.ok(editable(await lookup(self)), 'repaired');
const vcal = (await (await fetch(`${BASE}/cal/view/${self}`)).json()).calendar;
assert.equal(vcal.id, self); assert.equal(vcal.options.publicViewId, undefined, 'its view link still opens, as a view');
assert.equal((await fetch(`${BASE}/cal/view/${foo}`)).status, 404, 'an edit name that is not its own view id is no view link');
assert.equal((await repair({ name: self, calendarId: self })).status, 409, 'already editable');
await make(self, { publicViewId: self, notes: 'after repair' });
await staysEditable(self, 'the room registering again after the repair');
step('6b. make-editable repairs it (403 without the secret, 404 no calendar, 409 not a view); /view/<name> keeps working');

// The repair script, end to end: dry run changes nothing; --apply --include-cross writes the undo file, then repairs.
const script = path.join(HERE, '..', '..', 'scripts', 'fix-name-collisions.mjs');
const runScript = (args, cwd) => new Promise((res) => execFile(process.execPath, [script, '--base', BASE, ...args], { cwd, env: { ...process.env, IMPORT_SECRET: SECRET } },
    (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
const self2 = name('selftwo');
await make(self2, { publicViewId: self2 }); await settle(self2, editable);
await plant({ actualSlug: self2, isReadOnly: true, targetId: self2 });
const dir = mkdtempSync(path.join(tmpdir(), 'nc-fix-'));
let res = await runScript([], dir);
assert.equal(res.code, 0, res.stderr);
assert.match(res.stdout, new RegExp(`SELF .*\\n[\\s\\S]*${self2}`)); assert.match(res.stdout, /Dry run/);
assert.equal(readdirSync(dir).length, 0, 'a dry run writes nothing'); assert.equal((await lookup(self2)).isReadOnly, true, 'and changes nothing');
res = await runScript(['--apply', '--include-cross'], dir);
assert.equal(res.code, 0, res.stdout + res.stderr);
const undoFile = readdirSync(dir).find((f) => /^fix-name-collisions-.*\.json$/.test(f));
assert.ok(undoFile, 'the undo file');
const undo = JSON.parse(readFileSync(path.join(dir, undoFile), 'utf8'));
assert.ok(undo.rows.some((row) => row.normalized === self2 && row.is_readonly === 1 && row.target_id === self2 && row.kind === 'self'), 'it holds the row as it was');
assert.ok(undo.rows.some((row) => row.normalized === crossB && row.target_id === crossA && row.kind === 'cross'));
assert.ok(editable(await lookup(self2)) && editable(await lookup(crossB)), 'both repaired');
assert.equal((await fetch(`${BASE}/cal/view/${crossB}`)).status, 404, 'the cross repair ends the other calendar\'s view link under that name (why it needs --include-cross)');
res = await runScript(['--self-only'], dir);
assert.match(res.stdout, /SELF .*: 0/);
const noSecret = await new Promise((res2) => execFile(process.execPath, [script, '--base', BASE], { cwd: dir, env: { ...process.env, IMPORT_SECRET: 'wrong' } }, (err, stdout, stderr) => res2({ code: err ? err.code : 0, stderr })));
assert.notEqual(noSecret.code, 0); assert.match(noSecret.stderr, /HTTP 403/);
step('6c. fix-name-collisions.mjs: dry run changes nothing; --apply writes the undo file first, then repairs; a wrong secret gets 403');

// ---- 7. the production case ------------------------------------------------------------------------
const K = 'kazumichi';
await make(K, { publicViewId: K });                       // the calendar, its view id its own name (July 2025)
await settle(K, editable);
// Migrated as the cutover did: Firebase had /calendars/kazumichi and the view mirror /calendars_readonly/kazumichi.
const mig = buildDirectoryEntries({ calKeys: [K], slugMappings: { [K]: { actualSlug: K, isReadOnly: false } }, views: [{ key: K, targetId: K }] });
assert.equal(mig.collisions.length, 1, 'the migration reports it');
out = await backfill([...mig.entries.values()]);
assert.ok(editable(await lookup(K)), 'after the migration');
out = await backfill([{ actualSlug: K, isReadOnly: true, targetId: K }]);   // the Oct 4 script's row (the view overwrote the map)
assert.deepEqual(out.skipped, [K]);
assert.ok(editable(await lookup(K)), 'after the old script\'s view row');
r = await post(`/api/admin/cal/${K}/lock`, { ownerId: 'kazumichi-owner', plan: 'pro' });
assert.equal(r.status, 200);
await staysEditable(K, 'after a Pro upgrade re-registers name and view id (forced)');
await make(K, { publicViewId: K, notes: 'unlocked import is refused while locked, but try' }).catch(() => {});
assert.ok(editable(await lookup(K)));
const kv = await fetch(`${BASE}/cal/view/${K}`);
assert.equal(kv.status, 200, '/view/kazumichi still opens');
assert.equal((await kv.json()).calendar.options.publicViewId, undefined, 'as a view');
step('7. kazumichi (view id = its name, a view mirror of the same name): editable after the backfill migration and a Pro upgrade; /view/kazumichi still opens');

console.log(`${n} checks passed`);
