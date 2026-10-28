// One name key (public/services/CalendarName.js: trimmed, lowercase, NFC), against `wrangler dev` with
// ACCOUNTS_DEV_MODE=1 (the directory's dev-plant / dev/remove hooks) and a persist dir (the archive is read from local R2).
// Sections:
//   1. tricky names (NFC "TEAM NUÑEZ", leading/trailing spaces, &, %, +, ?, Korean, emoji, İ, ß/ẞ, final sigma), each
//      created through POST /cal/<name>: the exact name opens it (GET /cal, /api/lookup, the edit feed); every other
//      spelling with the same key follows to it; a new calendar under any such spelling is refused 409 "name taken";
//      spellings with another key (two inner spaces, ISTANBUL, STRASSE) are other names and can be made
//   2. an NFD request finds the NFC calendar (lookup, feed); NFD Korean too
//   3. before the re-key: rows planted as the old directory stored them (lowercase-only keys) still answer (lazy
//      fallback), refuse new variants, and a calendar's own save moves its row to the new key
//   4. the re-key (POST /api/admin/directory/rekey): 403 without the secret; dry run lists moves, a duplicate and the
//      planted collisions (canonical beats older, older between non-canonical, live beats stale, editable beats view:
//      that view link listed as ending) and writes nothing; apply; every spelling then follows; losers still open at
//      their exact names and are in the registry; a rerun finds nothing (idempotent)
//   5. scripts/rekey-directory.mjs: dry run and --apply against this server; the undo file is written; no secret printed
//   6. the archive holds every tricky calendar and every collision loser
//
//   scripts/test-all.sh --only name-key
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret', PERSIST = process.env.PERSIST;
const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const T = Date.now().toString(36);
const NFD = (s) => s.normalize('NFD');
const url = (id, sub = '') => `${BASE}/cal/${enc(id)}${sub}`;
const admin = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const at = (d, h = 9) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d = 1) => ({ id, title, start: at(d), end: at(d, 10), type: 1 });
let ip = 0;
const create = (id, title = 'x') => fetch(url(id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.88.${Math.floor(++ip / 200)}.${ip % 200}` },
    body: JSON.stringify({ title, options: {}, events: [ev('e1', `event of ${title}`)] }) });
const imp = async (id, title = id, created) => {
    const r = await fetch(url(id, '/import'), { method: 'PUT', headers: admin, body: JSON.stringify({ id, title, options: {}, events: [ev('e1', `event of ${title}`)] }) });
    assert.equal(r.status, 200, `import ${JSON.stringify(id)}`);
};
const lookup = async (slug) => (await fetch(`${BASE}/api/lookup?slug=${enc(slug)}`)).json();
const cal = async (id) => { const r = await fetch(url(id)); return r.status === 200 ? (await r.json()).calendar : null; };
const feed = async (name) => { const r = await fetch(`${BASE}/${enc(name)}.ics`); return r.status === 200 ? r.text() : ''; };
const post = (p, body, headers = admin) => fetch(`${BASE}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
const dev = (op, body) => post(`/api/admin/directory/dev/${op}`, body);
const plant = (row) => post('/api/admin/directory/dev-plant', row);
const rekey = async (apply = false, headers = admin) => { const r = await post('/api/admin/directory/rekey', { apply }, headers); assert.equal(r.status, 200); return r.json(); };
const known = async (ids) => (await (await post('/api/admin/rooms/backfill', { ids })).json()).known;
const settle = async (fn, ms = 5000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(60); } return v; };
const follows = async (spelling, exact) => (await settle(async () => (await lookup(spelling)).actualSlug === exact)) || assert.fail(`${JSON.stringify(spelling)} follows to ${JSON.stringify(exact)}: ${JSON.stringify(await lookup(spelling))}`);

// ---- 1. tricky names ---------------------------------------------------------------------------------------------------
// [exact name, other spellings with the same key, spellings with another key (other names)]
const TRICKY = [
    [`TEAM NUÑEZ ${T}`, [`team nuñez ${T}`, NFD(`TEAM NUÑEZ ${T}`), ` Team Nuñez ${T}  `], [`TEAM  NUÑEZ ${T}`]],
    [`  Soccer${T}`, [`soccer${T}`, `SOCCER${T} `, `soccer${T}  `], []],
    [`Royal City${T} `, [`royal city${T}`, `ROYAL CITY${T}`, ` royal city${T}`], [`royal  city${T}`]],
    [`D&D8 ${T}`, [`d&d8 ${T}`, `D&d8 ${T} `], []],
    [`50%Off${T}`, [`50%off${T}`, `50%OFF${T} `], [`50% off${T}`]],
    [`A+B${T}`, [`a+b${T}`, ` A+b${T}`], [`a b${T}`]],
    [`A?B${T}`, [`a?b${T}`, `A?b${T} `], []],
    [`강아지봉사${T}`, [`강아지봉사${T.toUpperCase()}`, ` 강아지봉사${T}`, NFD(`강아지봉사${T}`)], []],
    [`🎉Party${T}`, [`🎉party${T}`, `🎉PARTY${T} `], []],
    [`İstanbul${T}`, [`i̇stanbul${T}`, `İSTANBUL${T.toUpperCase()}`], [`ISTANBUL${T}`]],
    [`Straße${T}`, [`STRAẞE${T}`, `straße${T} `], [`STRASSE${T}`]],
    [`${T}ΟΔΟΣ`, [`${T}οδος`, `${T.toUpperCase()}ΟΔΟΣ `], [`${T}οδοσ`]],
];
for (const [name] of TRICKY) {
    const r = await create(name, `Cal ${name}`);
    assert.equal(r.status, 201, `create ${JSON.stringify(name)}: ${r.status} ${await r.text()}`);
}
for (const [name, same, others] of TRICKY) {
    const c = await cal(name);
    assert.equal(c && c.id, name, `${JSON.stringify(name)}: GET /cal/<exact> opens it, stored under its exact name`);
    await follows(name, name);
    assert.match(await feed(name), new RegExp(`X-WR-CALNAME:Cal `), `${JSON.stringify(name)}: its edit feed`);
    for (const s of same) {
        await follows(s, name);
        assert.match(await feed(s), /SUMMARY:event of Cal /, `${JSON.stringify(s)}: the feed of that spelling is the calendar's`);
        const r = await create(s, 'variant');
        assert.equal(r.status, 409, `${JSON.stringify(s)} (same key as ${JSON.stringify(name)}): refused, got ${r.status}`);
        assert.equal((await r.json()).error, 'name taken');
        assert.equal(await cal(s), null, `${JSON.stringify(s)} was not created`);
    }
    for (const o of others) assert.notEqual((await lookup(o)).actualSlug, name, `${JSON.stringify(o)} is another name`);
}
step(`${TRICKY.length} tricky names: each opens at its exact name (GET, lookup, feed); ${TRICKY.reduce((k, t) => k + t[1].length, 0)} other spellings with the same key follow to it, and a new calendar under any of them is refused 409`);

for (const [name, , others] of TRICKY) {
    for (const o of others) {
        const r = await create(o, `Other ${o}`);
        assert.equal(r.status, 201, `${JSON.stringify(o)} (another key than ${JSON.stringify(name)}) can be made: ${r.status}`);
        await follows(o, o);
    }
}
assert.equal((await lookup(`${T}ΟΔΟΣ`)).actualSlug, `${T}ΟΔΟΣ`, 'the first is still itself');
step('spellings with another key are other names, and can be made: two inner spaces, "50% off", "a b", ISTANBUL, STRASSE, a medial sigma');

// ---- 2. NFD finds NFC ------------------------------------------------------------------------------------------------
{
    const nfc = `Nuñez Family ${T}`;
    assert.equal((await create(nfc, 'Nuñez')).status, 201);
    const nfd = NFD(nfc);
    assert.notEqual(nfd, nfc);
    await follows(nfd, nfc);
    await follows(NFD(nfc.toLowerCase()), nfc);
    assert.match(await feed(nfd), /X-WR-CALNAME:Nuñez/);
    assert.equal(await cal(nfd), null, 'no calendar was made at the NFD spelling');
    assert.equal((await create(nfd)).status, 409, 'and none can be');
}
step('an NFD request (some phones) finds the NFC calendar: lookup, its lowercase, the feed; a new NFD calendar is refused');

// ---- 3. before the re-key: rows as the old directory keyed them --------------------------------------------------------
// The calendar exists; its row is removed and planted again at its old key (lowercase only, spaces kept).
async function legacy(id, extra = {}) {
    await dev('remove', { slug: id });
    const r = await plant({ actualSlug: id, legacy: true, ...extra });
    assert.equal(r.status, 200);
}
const Lazy = `Lazy${T} `;
await imp(Lazy);
await legacy(Lazy);
await follows(Lazy, Lazy);
await follows(`LAZY${T} `, Lazy);                                       // same old key
assert.equal((await lookup(`lazy${T}`)).found, false, 'the trimmed spelling finds it only after the re-key (as before)');
let r = await create(`LAZY${T} `); assert.equal(r.status, 409, 'a case variant: refused through the old row');
r = await create(`lazy${T}`); assert.equal(r.status, 409, 'the trimmed name: refused through the registry');
step('lazy fallback: a row at its old key still answers its spellings (lookup) and still refuses new variants');

// A spaced calendar's own save moves its row to the new key (healTrimmedName registers it again).
const Heal = `Heal${T} `;
await imp(Heal);
await legacy(Heal);
{
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(Heal)}/ws`);
    const snap = await new Promise((res, rej) => { ws.addEventListener('message', (e) => res(JSON.parse(e.data))); setTimeout(() => rej(new Error('no snapshot')), 4000); });
    const ack = await new Promise((res) => { ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.t === 'ack' || m.t === 'error') res(m); });
        ws.send(JSON.stringify({ t: 'save', id: 's1', v: snap.v, commands: [{ type: 'add', event: ev('e2', 'saved', 3) }] })); });
    assert.equal(ack.t, 'ack');
    ws.close();
}
await follows(`heal${T}`, Heal);
step('a spaced calendar\'s next save moves its own row to the new key (the trimmed spelling then follows)');

// NFD-named calendar planted at its NFD key
const Nu = NFD(`Ñu Club ${T}`);
await imp(Nu);
await legacy(Nu);
assert.equal((await lookup(Nu)).actualSlug, Nu, 'its own spelling answers');
assert.equal((await lookup(Nu.normalize('NFC'))).found, false, 'the NFC spelling finds it only after the re-key');

// Duplicate: a calendar's row at both keys.
const Dup = `Dup${T} `;
await imp(Dup);
await settle(async () => (await lookup(`dup${T}`)).actualSlug === Dup);
assert.equal((await plant({ actualSlug: Dup, legacy: true })).status, 200);

// Collisions. Pair: "Pair" (canonical, newer) and "pair " (older): the canonical spelling keeps the key.
const Pair = `Pair${T}`, pairSp = `pair${T} `;
await imp(Pair); await imp(pairSp);
await follows(pairSp, pairSp);                                            // exact first, before and after
await legacy(pairSp, { createdAt: 1000 });
await plant({ actualSlug: Pair, createdAt: 5000 });
// Twin: " Twin" (older) and "twin " (newer), neither canonical: the older keeps it.
const Twin = ` Twin${T}`, twinSp = `twin${T} `;
await imp(Twin); await imp(twinSp);
await dev('remove', { slug: `twin${T}` });
await plant({ actualSlug: Twin, legacy: true, createdAt: 1000 });
await plant({ actualSlug: twinSp, legacy: true, createdAt: 2000 });
// Ghost: "Ghost" (canonical, older) has no calendar; "ghost " (newer) has one: the live one keeps it.
const Ghost = `Ghost${T}`, ghostSp = `ghost${T} `;
await imp(ghostSp);
await dev('remove', { slug: ghostSp });
await plant({ actualSlug: Ghost, createdAt: 1000 });
await plant({ actualSlug: ghostSp, legacy: true, createdAt: 9000 });
// Vw: the editable "Vw " (old key) and a view link "vw<T>" of another calendar (at the key): the editable keeps it.
const Vw = `Vw${T} `, vwView = `vw${T}`, Other = `other${T}`;
await imp(Vw); await imp(Other);
await legacy(Vw);
await plant({ actualSlug: vwView, isReadOnly: true, targetId: Other, createdAt: 1000 });
assert.equal((await fetch(`${BASE}/cal/view/${enc(vwView)}`)).status, 200, 'the view link works before');
step('planted (as before the deploy): a row at an NFD key, a duplicate, and four collisions (Pair, Twin, Ghost, Vw)');

// ---- 4. the re-key ---------------------------------------------------------------------------------------------------------
assert.equal((await post('/api/admin/directory/rekey', {}, { 'Content-Type': 'application/json' })).status, 403);
assert.equal((await post('/api/admin/directory/rekey', {}, { ...admin, Authorization: 'Bearer wrong' })).status, 403);
const mine = (list, f) => list.filter((x) => f(x).includes(T));
let plan = await rekey(false);
assert.equal(plan.dryRun, true);
const moved = mine(plan.moves, (m) => m.actualSlug).map((m) => m.actualSlug).sort();
assert.deepEqual(moved, [Lazy, Nu, Twin, Vw, ghostSp].sort(), JSON.stringify(plan.moves));
assert.deepEqual(mine(plan.duplicates, (d) => d.key).map((d) => [d.kept.normalized, d.dropped.normalized]), [[`dup${T}`, `dup${T} `]]);
const col = Object.fromEntries(mine(plan.collisions, (c) => c.key).map((c) => [c.key, c]));
assert.deepEqual(Object.keys(col).sort(), [`ghost${T}`, `pair${T}`, `twin${T}`, `vw${T}`].sort());
const kept = (k) => col[k].kept.actual_slug, dropped = (k) => col[k].dropped.map((d) => [d.actual_slug, d.why]);
assert.equal(kept(`pair${T}`), Pair); assert.deepEqual(dropped(`pair${T}`), [[pairSp, 'not the canonical spelling']]);
assert.equal(kept(`twin${T}`), Twin); assert.deepEqual(dropped(`twin${T}`), [[twinSp, 'newer']]);
assert.equal(kept(`ghost${T}`), ghostSp); assert.deepEqual(dropped(`ghost${T}`), [[Ghost, 'leads to no calendar']]);
assert.equal(kept(`vw${T}`), Vw); assert.deepEqual(dropped(`vw${T}`), [[vwView, 'a view link; the editable calendar keeps the name']]);
assert.deepEqual(mine(plan.viewLinksEnded, (v) => v.viewId), [{ key: `vw${T}`, viewId: vwView, opened: Other, nowOpens: Vw }]);
assert.equal(plan.roomsStale, 0);
assert.deepEqual(plan.anomalies, []);
assert.equal((await lookup(`lazy${T}`)).found, false, 'a dry run changes nothing');
assert.deepEqual(await rekey(false), plan, 'and the same dry run again');
step(`re-key dry run: 403 without the secret; ${moved.length} moves, 1 duplicate, 4 collisions decided by the rules (canonical, older, live, editable), the view link that would end listed; nothing written`);

const done = await rekey(true);
assert.equal(done.dryRun, false);
assert.ok(done.applied && done.applied.moved >= moved.length && done.applied.dropped >= 5, JSON.stringify(done.applied));
assert.deepEqual(mine(done.applied.changed, (x) => x.actual_slug), []); assert.deepEqual(mine(done.applied.taken, (x) => x.actual_slug), []);
await follows(`lazy${T}`, Lazy); await follows(`LAZY${T}`, Lazy);
await follows(Nu.normalize('NFC'), Nu); await follows(`ñu club ${T}`, Nu);
await follows(`DUP${T}`, Dup);
await follows(`PAIR${T}`, Pair); await follows(pairSp, pairSp);          // the loser still opens at its exact name
await follows(`TWIN${T}`, Twin); await follows(twinSp, twinSp);
await follows(`GHOST${T}`, ghostSp);
await follows(`VW${T}`, Vw);
assert.equal((await fetch(`${BASE}/cal/view/${enc(vwView)}`)).status, 404, 'the listed view link ended');
assert.deepEqual((await cal(pairSp)).events.map((e) => e.title), [`event of ${pairSp}`], 'the loser\'s calendar is untouched');
assert.equal(await known([Pair, pairSp, Twin, twinSp, ghostSp, Vw]), 6, 'every live calendar of a collision is in the registry');
for (const s of [`LAZY${T}  `, `pair${T}`, `twin${T}`, Nu.normalize('NFC')]) assert.equal((await create(s)).status, 409, `${JSON.stringify(s)}: refused after too`);
step('re-key apply: every spelling follows to its key\'s calendar; collision losers still open at their exact names, untouched and registered; the planted view link ended (as listed)');

plan = await rekey(true);
assert.deepEqual([plan.moves, plan.duplicates, plan.collisions].map((l) => l.length), [0, 0, 0], JSON.stringify(plan));
assert.deepEqual([plan.applied.moved, plan.applied.dropped, plan.applied.roomsRekeyed], [0, 0, 0]);
step('re-key again: nothing to move, drop or decide (idempotent)');

// ---- 5. the script ---------------------------------------------------------------------------------------------------------
{
    const S = `Script${T} `;
    await imp(S);
    await legacy(S);
    const dir = mkdtempSync(join(tmpdir(), 'rekey-'));
    const run = (...a) => execFileSync(process.execPath, [join(HERE, '../../scripts/rekey-directory.mjs'), '--base', BASE, ...a],
        { encoding: 'utf8', cwd: dir, env: { ...process.env, IMPORT_SECRET: SECRET } });
    let txt = run();
    assert.match(txt, /MOVES \(row to its new key\): 1\n/); assert.match(txt, new RegExp(`"script${T} " -> "script${T}"`)); assert.match(txt, /Dry run\. --apply would make 1 change/);
    assert.deepEqual(readdirSync(dir), [], 'a dry run writes no file');
    assert.equal((await lookup(`script${T}`)).found, false);
    txt = run('--apply');
    assert.match(txt, /Saved every row it will change/); assert.match(txt, /Moved 1, dropped 0, registry re-keyed 0/);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const saved = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(saved.plan.moves[0].row.normalized, `script${T} `, 'the undo file has the row as it was');
    assert.equal(saved.applied.moved, 1);
    await follows(`script${T}`, S);
    assert.match(run('--apply'), /Nothing to re-key/);
    for (const t of [txt, readFileSync(join(dir, files[0]), 'utf8')]) assert.doesNotMatch(t, new RegExp(SECRET));
    rmSync(dir, { recursive: true, force: true });
    try { execFileSync(process.execPath, [join(HERE, '../../scripts/rekey-directory.mjs')], { stdio: 'pipe' }); assert.fail('no --base'); }
    catch (e) { assert.equal(e.status, 2, 'refuses without --base'); }
}
step('scripts/rekey-directory.mjs: dry run (no file), --apply (the rows saved first), again (nothing to do), refuses without --base; the secret is never printed');

// ---- 6. the archive ----------------------------------------------------------------------------------------------------------
if (PERSIST) {
    const today = new Date().toISOString().slice(0, 10);
    const r2 = (...args) => execFileSync(process.execPath, ['node_modules/.bin/wrangler', 'r2', 'object', ...args, '--local', '--persist-to', PERSIST], { stdio: 'pipe' });
    const { job } = await (await post('/api/admin/backup/run', {})).json();
    let cals = null;
    for (let i = 0; i < 400 && !cals; i++) {
        const cur = (await (await fetch(`${BASE}/api/admin/backup/status`, { headers: admin })).json()).job;
        if (cur && cur.done && cur.run === job.run) {
            const f = join(tmpdir(), `name-key-archive-${process.pid}.gz`); rmSync(f, { force: true });
            r2('get', `pastecal-backups/archive/daily/${today}.json.gz`, '--file', f);
            cals = new Set(gunzipSync(readFileSync(f)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.t === 'cal').map((l) => l.id));
            rmSync(f, { force: true });
        } else await sleep(250);
    }
    assert.ok(cals, 'the archive run finished');
    const want = [...TRICKY.map((t) => t[0]), ...TRICKY.flatMap((t) => t[2]), `Nuñez Family ${T}`, Lazy, Heal, Nu, Dup, Pair, pairSp, Twin, twinSp, ghostSp, Vw];
    for (const id of want) assert.ok(cals.has(id), `${JSON.stringify(id)} archived`);
    step(`the daily archive holds all ${want.length}: every tricky name, the other-key names, and every collision winner and loser`);
} else console.log('  (no PERSIST: archive section skipped)');

console.log(`\n${n} checks passed`);
