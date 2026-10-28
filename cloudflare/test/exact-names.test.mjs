// Exact names first (ExactNames.js; Oct 28 2026: 91 owners' links opened the other spelling's calendar, and 54
// calendars were missing from the daily archive), against `wrangler dev` with ACCOUNTS_DEV_MODE=1 (the registry's
// dev-forget hook). Sections:
//   1. "XFoo" (many events) and "xfoo" (1 event), the directory row on XFoo: /api/lookup, /lookupCalendar and the edit
//      feed answer the exact name; the third spelling "XFOO" (no calendar) follows the row; a socket on xfoo is xfoo's
//   2. spaced names: "Xsp " and "xsp " (case variants with a trailing space) and "xsp" each answer for themselves
//   3. a name whose only row is a view link of another calendar, in another case: the calendar opens editable
//      (exact 'view'); the view link still opens its own calendar, read-only, and never says the edit name
//   4. new names: POST /cal/<a variant> is refused (409 name taken) for case and space variants, with or without a
//      directory row; a free name is created
//   5. the registry is written on create (POST), /import and /from-firebase
//   6. backfill: dry run (nothing written; missing and invalid ids listed), apply, idempotent; 403 without the secret
//   7. the archive: with their snapshots gone and their registry entries forgotten, xfoo and the spaced names are
//      missing; after a backfill, the archive holds XFoo, xfoo and every spaced name, each equal to the live one
//
//   scripts/test-all.sh --only exact-names
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret', PERSIST = process.env.PERSIST;
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const T = Date.now().toString(36);
const url = (id, sub = '') => `${BASE}/cal/${enc(id)}${sub}`;
const admin = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const at = (d, h = 9) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d = 1) => ({ id, title, start: at(d), end: at(d, 10), type: 1 });
const events = (k, label) => Array.from({ length: k }, (_, i) => ev(`e${i}`, `${label} ${i}`, 1 + (i % 27)));
let ip = 0;
const put = (id, sub, cal) => fetch(url(id, sub), { method: 'PUT', headers: admin, body: JSON.stringify({ id, title: id, options: {}, ...cal }) });
const create = (id, cal = {}) => fetch(url(id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.77.0.${++ip}` },
    body: JSON.stringify({ title: id, options: {}, events: [], ...cal }) });
const lookup = async (slug) => (await fetch(`${BASE}/api/lookup?slug=${enc(slug)}`)).json();
const titles = async (id) => (await (await fetch(url(id))).json()).calendar.events.map((e) => e.title).sort();
const post = (p, body, headers = admin) => fetch(`${BASE}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
const backfill = async (ids, apply = false) => { const r = await post('/api/admin/rooms/backfill', { ids, apply }); assert.equal(r.status, 200); return r.json(); };
const rooms = async () => (await (await fetch(`${BASE}/api/admin/rooms/stats`, { headers: admin })).json()).rooms;
const settle = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(50); } return false; };

// ---- 1. two calendars, two spellings, one directory row --------------------------------------------
const Foo = `XFoo${T}`, foo = Foo.toLowerCase(), FOO = Foo.toUpperCase();
assert.equal((await put(Foo, '/import', { events: events(30, 'Foo event') })).status, 200);
assert.ok(await settle(async () => (await lookup(FOO)).actualSlug === Foo), 'the row is Foo\'s');
assert.equal((await put(foo, '/import', { events: [ev('only', 'foo’s only event')] })).status, 200);
await sleep(600);   // foo's own registration: refused (the name leads to Foo, a live calendar)
assert.deepEqual(await lookup(FOO), { found: true, actualSlug: Foo, isReadOnly: false, targetId: Foo }, 'the row still points at Foo');
step(`setup: ${Foo} (30 events) and ${foo} (1 event); the directory row (seen through ${FOO}, which has no calendar) is ${Foo}'s`);

assert.deepEqual(await lookup(foo), { found: true, actualSlug: foo, isReadOnly: false, targetId: foo, exact: 'case' });
assert.deepEqual(await lookup(Foo), { found: true, actualSlug: Foo, isReadOnly: false, targetId: Foo });
let r = await fetch(`${BASE}/api/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: foo }) });
assert.equal((await r.json()).actualSlug, foo);
r = await fetch(`${BASE}/lookupCalendar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { slug: foo } }) });
assert.equal((await r.json()).data.actualSlug, foo);
step('/api/lookup (GET and POST) and /lookupCalendar: the exact name wins (exact: "case"); the row\'s own spelling is unchanged');

let ics = await (await fetch(`${BASE}/${enc(foo)}.ics`)).text();
assert.match(ics, /only event/); assert.doesNotMatch(ics, /Foo event/);
ics = await (await fetch(`${BASE}/${enc(Foo)}.ics`)).text();
assert.match(ics, /Foo event 0/); assert.doesNotMatch(ics, /only event/);
ics = await (await fetch(`${BASE}/${enc(FOO)}.ics`)).text();
assert.match(ics, /Foo event 0/);
step('the edit feed: /xfoo.ics is xfoo\'s, /XFoo.ics and /XFOO.ics (no calendar) are XFoo\'s');

{
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(foo)}/ws`);
    const snap = await new Promise((res, rej) => { ws.addEventListener('message', (e) => res(JSON.parse(e.data))); setTimeout(() => rej(new Error('no snapshot')), 4000); });
    assert.deepEqual(snap.calendar.events.map((e) => e.title), ['foo’s only event']);
    const ack = await new Promise((res) => { ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.t === 'ack' || m.t === 'error') res(m); });
        ws.send(JSON.stringify({ t: 'save', id: 's1', v: snap.v, commands: [{ type: 'add', event: ev('new', 'saved to foo', 3) }] })); });
    assert.equal(ack.t, 'ack', JSON.stringify(ack));
    ws.close();
    assert.deepEqual(await titles(foo), ['foo’s only event', 'saved to foo']);
    assert.equal((await titles(Foo)).length, 30);
}
step('a save on xfoo\'s socket lands in xfoo; XFoo keeps its 30 events');

// ---- 2. spaced names ---------------------------------------------------------------------------------
const Sp = `XSp${T} `, sp = Sp.toLowerCase(), trimmed = sp.trim();
assert.equal((await put(Sp, '/import', { events: events(5, 'Sp event') })).status, 200);
await sleep(400);
assert.equal((await put(sp, '/import', { events: [ev('only', 'spaced only')] })).status, 200);
assert.equal((await put(trimmed, '/import', { events: [ev('t', 'trimmed one')] })).status, 200);
await sleep(600);
assert.equal((await lookup(sp)).actualSlug, sp);
assert.equal((await lookup(Sp)).actualSlug, Sp);
assert.equal((await lookup(trimmed)).actualSlug, trimmed);
assert.deepEqual(await titles(sp), ['spaced only']);
assert.match(await (await fetch(`${BASE}/${enc(sp)}.ics`)).text(), /spaced only/);
step(`spaced names: "${Sp}", "${sp}" and "${trimmed}" each answer for themselves (lookup, calendar, feed)`);

// ---- 3. the only row is a view link, in another case ----------------------------------------------------
const other = `xother${T}`, Vbar = `VBar${T}`, vbar = Vbar.toLowerCase();
assert.equal((await put(other, '/import', { title: 'Other calendar', events: [ev('o', 'other event')] })).status, 200);
assert.equal((await post('/api/directory/backfill', [{ actualSlug: vbar, isReadOnly: true, targetId: other }])).status, 200);
assert.equal((await put(Vbar, '/import', { title: 'Vbar calendar', events: [ev('v', 'vbar event')] })).status, 200);
await sleep(600);
assert.deepEqual(await lookup(vbar), { found: true, actualSlug: vbar, isReadOnly: true }, 'the row is a view (and never says its calendar)');
assert.deepEqual(await lookup(Vbar), { found: true, actualSlug: Vbar, isReadOnly: false, targetId: Vbar, exact: 'view' });
r = await fetch(`${BASE}/cal/view/${enc(vbar)}`);
assert.equal(r.status, 200); assert.equal((await r.json()).calendar.title, 'Other calendar');
assert.match(await (await fetch(`${BASE}/view/${enc(vbar)}.ics`)).text(), /other event/);
step(`a calendar (${Vbar}) whose name's only row is a view link of another calendar: editable at its name (exact "view"); /view/${vbar} still opens the other calendar`);

// ---- 4. new names can't make a new spelling --------------------------------------------------------------
for (const id of [FOO, `${Foo} `, `xFoO${T}`, Sp.trim(), `XSP${T}  `, Vbar.toUpperCase()]) {
    r = await create(id);
    assert.equal(r.status, 409, `${JSON.stringify(id)}: ${r.status}`);
    assert.equal((await r.json()).error, 'name taken');
    assert.equal((await fetch(url(id), { method: 'HEAD' })).status, 404, `${JSON.stringify(id)} was not created`);
}
// A spaced calendar with no directory row for its trimmed name, and none in this case: the registry alone knows it.
const Lone = `YLone${T} `;
assert.equal((await put(Lone, '/import', { events: [ev('l', 'lone')] })).status, 200);
await sleep(400);
assert.equal((await lookup(Lone.trim().toLowerCase())).found, false, 'no row for the trimmed lowercase name');
r = await create(Lone.trim().toLowerCase());
assert.equal(r.status, 409, 'refused through the registry');
r = await create(`free${T}`, { events: [ev('f', 'free')] });
assert.equal(r.status, 201);
r = await create(Foo);
assert.equal(r.status, 409, 'the exact name of an existing calendar: refused as ever');
step('POST /cal/<variant> is refused 409 "name taken" (case, trailing spaces, a view row\'s case, a registry-only spaced name); a free name is created');

// ---- 5. the registry is written on create, /import and /from-firebase ----------------------------------------
const fb = `xfb${T}`;
assert.equal((await put(fb, '/from-firebase', { events: [ev('f', 'from firebase')] })).status, 200);
await sleep(500);
let out = await backfill([Foo, foo, Sp, sp, trimmed, Vbar, other, Lone, `free${T}`, fb]);
assert.equal(out.known, 10, JSON.stringify(out)); assert.equal(out.toAdd, 0);
step('registry written on create (POST), /import and /from-firebase\'s first sight: all 10 ids known');

// ---- 6. backfill ---------------------------------------------------------------------------------------------
assert.equal((await post('/api/admin/rooms/backfill', { ids: [foo] }, { 'Content-Type': 'application/json' })).status, 403);
assert.equal((await post('/api/admin/rooms/backfill', { ids: [foo] }, { ...admin, Authorization: 'Bearer wrong' })).status, 403);
const forget = [foo, Sp, sp, trimmed];
for (const id of forget) assert.equal((await post('/api/admin/rooms/dev-forget', { id })).status, 200);
const before = await rooms();
out = await backfill([...forget, Foo, `nosuch${T}`, 'a/b']);
assert.deepEqual({ dryRun: out.dryRun, known: out.known, toAdd: out.toAdd, added: out.added, missing: out.missing, invalid: out.invalid, failed: out.failed },
    { dryRun: true, known: 1, toAdd: 4, added: 0, missing: [`nosuch${T}`], invalid: ['a/b'], failed: [] });
assert.equal(await rooms(), before, 'a dry run writes nothing');
step('backfill: 403 without the secret; dry run lists 4 to add, 1 known, the missing and the invalid id, and writes nothing');

// ---- 7. the archive ----------------------------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
function r2(...args) { return execFileSync(process.execPath, ['node_modules/.bin/wrangler', 'r2', 'object', ...args, '--local', '--persist-to', PERSIST], { stdio: 'pipe' }); }
const snapKey = (id) => `pastecal-backups/snapshots/${enc(id)}/${today}.json`;
const hasSnap = (id) => { try { r2('get', snapKey(id), '--pipe'); return true; } catch { return false; } };
// The per-calendar snapshots (written a few seconds after a change) go: as a calendar unchanged since they began.
await sleep(5000);                                                   // past the 3 s backup delay
for (const id of [foo, sp]) r2('delete', snapKey(id));
async function archive() {
    const { job } = await (await post('/api/admin/backup/run', {})).json();
    for (let i = 0; i < 240; i++) {
        const cur = (await (await fetch(`${BASE}/api/admin/backup/status`, { headers: admin })).json()).job;
        if (cur && cur.done && cur.run === job.run) {
            const f = `/tmp/exact-names-test-${process.pid}.gz`; rmSync(f, { force: true });
            r2('get', `pastecal-backups/archive/daily/${today}.json.gz`, '--file', f);
            const lines = gunzipSync(readFileSync(f)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
            return { job: cur, cals: new Map(lines.filter((l) => l.t === 'cal').map((l) => [l.id, l])) };
        }
        await sleep(250);
    }
    throw new Error('the archive run did not finish');
}
let a = await archive();
for (const id of [foo, sp]) assert.ok(!a.cals.has(id), `${JSON.stringify(id)} is missing before the backfill`);
for (const id of [Foo, Sp, trimmed, Vbar]) assert.ok(a.cals.has(id), `${JSON.stringify(id)} has a row of its own (or is registered)`);
step(`archive before the backfill: ${JSON.stringify(foo)} and ${JSON.stringify(sp)} missing (no row of their own, no snapshot, not registered); the spellings with rows are there`);

out = await backfill(forget, true);
assert.equal(out.added, 4, JSON.stringify(out));
assert.equal(await rooms(), before + 4);
assert.equal((await backfill(forget, true)).added, 0, 'idempotent');
a = await archive();
for (const id of [Foo, foo, Sp, sp, trimmed, Vbar, Lone, fb]) {
    assert.ok(a.cals.has(id), `${JSON.stringify(id)} archived`);
    assert.deepEqual(a.cals.get(id).calendar, (await (await fetch(url(id))).json()).calendar, id);
}
assert.equal(a.cals.get(foo).calendar.events.length, 2); assert.equal(a.cals.get(Foo).calendar.events.length, 30);
assert.ok(a.job.rooms >= 10, `the registry phase walked ${a.job.rooms} ids`);
const h = await (await fetch(`${BASE}/api/admin/backup/health`, { headers: admin })).json();
assert.equal(h.rooms, await rooms()); assert.equal(h.newest.rooms, a.job.rooms);
step(`backfill --apply adds 4 (again: 0); the archive then holds XFoo (30), xfoo (2) and every spaced name, each equal to the live calendar; health reports the registry (${h.rooms})`);

// ---- the script, against this server -------------------------------------------------------------------------------
const f = `/tmp/exact-names-ids-${process.pid}.json`;
const { writeFileSync } = await import('node:fs');
writeFileSync(f, JSON.stringify([foo, `nosuch${T}`]));
let txt = execFileSync(process.execPath, ['../scripts/backfill-rooms.mjs', '--base', BASE, f], { encoding: 'utf8', env: { ...process.env, IMPORT_SECRET: SECRET } });
assert.match(txt, /2 ids: 1 registered already, 0 would be added, 1 with no calendar/); assert.match(txt, /Dry run/);
writeFileSync(f, JSON.stringify({ [Lone]: {}, [`nosuch${T}`]: {} }));   // a Firebase export's shape: the keys are the ids
txt = execFileSync(process.execPath, ['../scripts/backfill-rooms.mjs', '--base', BASE, f, '--apply'], { encoding: 'utf8', env: { ...process.env, IMPORT_SECRET: SECRET } });
assert.match(txt, /2 ids: 1 registered already, 0 to add, 0 added, 1 with no calendar/);
assert.doesNotMatch(txt, new RegExp(SECRET));
rmSync(f, { force: true });
step('scripts/backfill-rooms.mjs: dry run and --apply against this server (an array, and an export object\'s keys); the secret is never printed');

console.log(`\nexact-names: ${n} checks passed`);
