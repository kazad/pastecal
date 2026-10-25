// Stats COUNTING (RoomInsight.countHit, marked by Insight.hitHeaders in the Worker), against `wrangler dev`:
//   wrangler dev --port 8950 --persist-to $PERSIST --var FIREBASE_DB_URL: --var COPY_BACK: \
//     --var IMPORT_SECRET:dev-secret --var ACCOUNTS_DEV_MODE:1
//   BASE=http://localhost:8950 PERSIST=$PERSIST node test/stats.test.mjs
// Ported from the Pro branch's test/stats.test.mjs. Production has no stats read endpoint, so every
// check reads the room's rows through the dev-only dump (/api/admin/cal/<id>/stats-dump). Visitors
// are told apart by CF-Connecting-IP + User-Agent, which the test sets.
//
// GATE=1: against a server started WITHOUT ACCOUNTS_DEV_MODE (as production is): the dump must be
// refused even with the secret, and counting still happens (checked only through the response codes).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:8950', SECRET = process.env.IMPORT_SECRET || 'dev-secret', PERSIST = process.env.PERSIST;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const auth = { Authorization: `Bearer ${SECRET}` };
const today = new Date().toISOString().slice(0, 10);
let ipn = 0; const nextIp = () => `10.30.${Math.floor(++ipn / 200)}.${ipn % 200}`;
// New calendars are rate-limited per IP (10 a minute): each create comes from its own address.
const create = async (id, title = 'Stats') => {
    const r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: { 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ title, events: [] }) });
    assert.equal(r.status, 201, await r.text());
};

if (process.env.GATE) {
    const id = `test-stats-gate-${run}`;
    await create(id);
    assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(id)}/stats-dump`, { headers: auth })).status, 403, 'no dev mode: the dump is refused even with the secret');
    assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(id)}/stats-dump`)).status, 403);
    assert.equal((await fetch(`${BASE}/cal/${enc(id)}/stats-dump`)).status, 404);
    assert.equal((await fetch(`${BASE}/cal/${enc(id)}`, { headers: { 'CF-Connecting-IP': '203.0.113.5', 'User-Agent': 'Mozilla/5.0 gate' } })).status, 200);
    step('without ACCOUNTS_DEV_MODE (production): /api/admin/cal/<id>/stats-dump is 403 with or without the secret; /cal/<id>/stats-dump 404; reads still 200');
    console.log(`\n${n} checks passed`); process.exit(0);
}

// ---- visitors: an IP + a user agent. A visitor is a network (IPv4 /24, IPv6 /64) plus, for up to 3
// people per network per day, the user agent: so the four people here are on four different /24s.
const person = (ip, ua) => ({ 'CF-Connecting-IP': ip, 'User-Agent': ua });
const A = person('203.0.113.11', `Mozilla/5.0 (Macintosh) statsA-${run}`);
const B = person('198.51.100.12', `Mozilla/5.0 (iPhone) statsB-${run}`);
const C = person('192.0.2.13', `Mozilla/5.0 (Windows) statsC-${run}`);
const D = person('100.64.7.14', `Mozilla/5.0 (Linux) statsD-${run}`);
const get = (path, headers) => fetch(BASE + path, { headers });
async function connect(id, headers, path = `/cal/${enc(id)}/ws`) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + path, { headers });
    await new Promise((res, rej) => { ws.addEventListener('message', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    ws.close();
}
const dump = async (id) => { const r = await get(`/api/admin/cal/${enc(id)}/stats-dump`, auth); assert.equal(r.status, 200, 'dump (is ACCOUNTS_DEV_MODE=1 set?)'); return r.json(); };
const todayRow = async (id) => (await dump(id)).daily.find((d) => d.day === today) || { views: 0, visitors: 0, followers: 0 };
const counts = async (id) => { await sleep(150); const r = await todayRow(id); return [r.views, r.visitors, r.followers]; };   // counting runs just after the response

const id = `test-stats-${run}`;
await create(id);

// 1. A calendar read is counted (every calendar, nothing shown).
await get(`/cal/${enc(id)}`, A);
assert.deepEqual(await counts(id), [1, 1, 0]);
step('GET /cal/<id> by a browser: 1 view, 1 visitor');

// 2. The same visitor again the same day: still one visitor, and one view (a poll, a reload, the socket).
for (let i = 0; i < 3; i++) await get(`/cal/${enc(id)}`, A);
await connect(id, A);
assert.deepEqual(await counts(id), [1, 1, 0]);
step('the same visitor polling GET /cal/<id> and opening the socket counts once: 1 view, 1 visitor');

// 3. New visitors through the socket and the read-only link (GET and its socket).
await connect(id, B);
let r = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ sourceCalendarId: id }) });
const viewId = (await r.json()).publicViewId;
assert.ok(viewId, 'made a view link');
await get(`/cal/view/${enc(viewId)}`, C);
await get(`/cal/view/${enc(viewId)}`, C);
await connect(id, C, `/cal/view/${enc(viewId)}/ws`);
assert.deepEqual(await counts(id), [3, 3, 0]);
step('a new visitor on the socket and one on the read-only link (GET twice + its socket): 3 views, 3 visitors');

// 4. Bots are skipped.
for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl/8.4.0', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 UptimeRobot/2.0', 'facebookexternalhit/1.1 preview', '']) {
    await get(`/cal/${enc(id)}`, person('198.51.100.7', ua));
    await get(`/${enc(id)}.ics`, person('198.51.100.7', ua));
}
assert.deepEqual(await counts(id), [3, 3, 0]);
step('crawlers, link previews, monitors, curl and empty user agents count nothing (views, visitors, followers unchanged)');

// 5. Followers: distinct calendar apps fetching the ICS feed today.
const gcal = person('66.249.0.1', 'Google-Calendar-Importer');
for (let i = 0; i < 3; i++) assert.equal((await get(`/${enc(id)}.ics`, gcal)).status, 200);
await get(`/${enc(id)}.ics`, person('40.0.0.9', 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)'));
await get(`/view/${enc(viewId)}.ics`, person('17.0.0.5', 'iOS/18.0 (22A) dataaccessd/1.0'));
const etagRes = await get(`/${enc(id)}.ics`, person('17.0.1.6', 'iOS/18.0 (22A) dataaccessd/1.0'));
const r304 = await get(`/${enc(id)}.ics`, { ...person('17.0.1.6', 'iOS/18.0 (22A) dataaccessd/1.0'), 'If-None-Match': etagRes.headers.get('etag') });
assert.equal(r304.status, 304);
assert.deepEqual(await counts(id), [3, 3, 4], 'ICS fetches are follows, never views');
const apps = JSON.parse((await todayRow(id)).apps_json);
assert.deepEqual(apps, { google: 1, outlook: 1, apple: 2 });
step('ICS: one app fetching 3 times counts once; 4 distinct apps (edit and view feeds, 304s included) = 4 followers {google 1, outlook 1, apple 2}; views unchanged');

// 6. The stats routes are not reachable from outside.
assert.equal((await get(`/api/admin/cal/${enc(id)}/stats-dump`)).status, 403, 'the dump needs the secret');
assert.equal((await get(`/api/admin/cal/${enc(id)}/stats-dump`, { Authorization: 'Bearer wrong' })).status, 403);
assert.equal((await get(`/cal/${enc(id)}/stats-dump`)).status, 404, 'the room route is internal');
assert.equal((await get(`/cal/${enc(id)}/stats`)).status, 404);
assert.equal((await get(`/cal/view/${enc(viewId)}/stats-dump`)).status, 404);
for (const p of [`/api/stats?calendar=${enc(id)}`, `/api/pro/stats?calendar=${enc(id)}`]) assert.ok(!(await (await get(p)).text()).includes('"views"'), `${p}: no stats read endpoint`);
step('the dump needs dev mode + the secret (403 otherwise); /cal/<id>/stats-dump, /cal/<id>/stats and the view variant are 404; no /api/stats or /api/pro/stats');

// 7. A client can't forge hits.
const before = await counts(id);
await get(`/cal/${enc(id)}/history`, { ...person('203.0.113.99', `Mozilla/5.0 forged-${run}`), 'X-PC-Hit': 'view', 'X-PC-Geo-City': 'Nowhere' });
await get(`/cal/${enc(id)}/authors`, { ...person('203.0.113.99', `Mozilla/5.0 forged-${run}`), 'X-PC-Hit': 'view' });
await fetch(`${BASE}/cal/${enc(id)}`, { method: 'HEAD', headers: { ...person('203.0.113.98', `Mozilla/5.0 forged2-${run}`), 'X-PC-Hit': 'view' } });
await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: { ...person('203.0.113.97', `Mozilla/5.0 forged3-${run}`), 'X-PC-Hit': 'view' }, body: '{}' });
assert.deepEqual(await counts(id), before);
await get(`/cal/${enc(id)}`, { ...D, 'X-PC-Hit': 'follow', 'X-PC-Geo-City': 'Forged%20City', 'X-PC-Geo-Country': 'ZZ', 'X-PC-Source': 'embed' });
const afterD = await todayRow(id);
assert.deepEqual([afterD.views, afterD.visitors, afterD.followers], [4, 4, 4], 'counted as the view it was, not a follow');
assert.ok(!afterD.cities_json?.includes('Forged') && !afterD.countries_json?.includes('ZZ'), 'client geo headers are ignored');
assert.ok(!JSON.parse(afterD.sources_json).embed, 'a client X-PC-Source is ignored');
step('X-PC-Hit / X-PC-Geo-* / X-PC-Source from a client are stripped: /history, /authors, HEAD, POST count nothing; a forged "follow" counts as the view it was; forged places and source are ignored');

// 8. Rotating user agents (or IPv6 addresses within one /64) doesn't make more visitors.
{
    const idr = `test-stats-rotate-${run}`;
    await create(idr, 'Rotate');
    for (let i = 0; i < 200; i += 20) await Promise.all(Array.from({ length: 20 }, (_, j) => get(`/cal/${enc(idr)}`, person('198.18.4.20', `Mozilla/5.0 (rotating ${i + j}) ${run}`))));
    assert.deepEqual(await counts(idr), [3, 3, 0], '200 user agents from one IP: 3 visitors, 3 views');
    for (let i = 0; i < 50; i++) await get(`/cal/${enc(idr)}`, person(`2001:db8:77:1:${(i + 1).toString(16)}::${i + 1}`, `Mozilla/5.0 (v6) ${run}`));
    await get(`/cal/${enc(idr)}`, person('2001:0db8:0077:0001:ffff:0:0:1', `Mozilla/5.0 (v6) ${run}`));
    assert.deepEqual(await counts(idr), [4, 4, 0], '51 addresses in one IPv6 /64, one user agent: 1 visitor');
    await get(`/cal/${enc(idr)}`, person('::ffff:198.18.4.99', `Mozilla/5.0 (rotating 0) ${run}`));
    assert.deepEqual(await counts(idr), [4, 4, 0], 'an IPv4-mapped IPv6 address is its IPv4 network');
    step('200 requests from one IP with 200 user agents count as 3 visitors (3 views); 51 addresses in one IPv6 /64 as 1; ::ffff:a.b.c.d as its IPv4 /24');
}

// 9. A name nobody created stores nothing.
{
    const ghost = `test-stats-ghost-${run}`;
    assert.equal((await get(`/cal/${enc(ghost)}`, A)).status, 404);
    await get(`/${enc(ghost)}.ics`, gcal);
    await sleep(150);
    assert.deepEqual(await dump(ghost), { daily: [], seen: [], saltDays: [] });
    step('reads of a calendar that does not exist (404) store no stats rows');
}

// 10. No IP or user agent stored anywhere.
const d = await dump(id);
assert.ok(d.seen.every((x) => /^[0-9a-f]{16}$/.test(x.hash) && Object.keys(x).sort().join() === 'hash,kind,last_at'), 'only 8-byte hashes');
assert.deepEqual(d.saltDays, [today]);
const text = JSON.stringify(d);
for (const p of [A, B, C, D]) { assert.ok(!text.includes(p['CF-Connecting-IP'])); assert.ok(!text.includes(p['User-Agent'])); }
if (PERSIST) {
    await sleep(1000);
    for (const p of [A, B, C, D]) {
        const marker = p['User-Agent'].split(' ').at(-1);           // statsA-<run>, unique to this run
        for (const needle of [marker, p['CF-Connecting-IP']]) {
            let hits = '';
            try { hits = execFileSync('grep', ['-r', '-a', '-l', '-F', needle, PERSIST], { encoding: 'utf8' }); } catch { /* grep exits 1: no match */ }
            assert.equal(hits.trim(), '', `"${needle}" found on disk in ${hits}`);
        }
    }
    step(`no IP or user agent in the stats tables (only 16-hex hashes and today's salt day), nor anywhere under ${PERSIST} (SQLite + WAL, grep)`);
} else {
    step('no IP or user agent in the stats tables (set PERSIST to also grep the whole local store)');
}

console.log(`\n${n} checks passed`); process.exit(0);
