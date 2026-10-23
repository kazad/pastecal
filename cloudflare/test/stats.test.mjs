// Pro calendar stats (RoomInsight.countHit + GET /api/pro/stats), against `wrangler dev` started with
//   --persist-to $PERSIST --var COPY_BACK: --var FIREBASE_DB_URL:http://127.0.0.1:9 --var UNSAFE_DEV_SESSION_HEADER:on --var ACCOUNTS_DEV_MODE:1
// (.dev.vars: IMPORT_SECRET=dev-secret, and no LOCK_API_BASE). Visitors are told apart by
// CF-Connecting-IP + User-Agent, which the test sets; places come from wrangler dev's request.cf
// (this machine's location), so the city check uses whatever city that is.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:8870', SECRET = process.env.IMPORT_SECRET || 'dev-secret', PERSIST = process.env.PERSIST;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const auth = { Authorization: `Bearer ${SECRET}` };
const today = new Date().toISOString().slice(0, 10);

// ---- sign-in (dev outbox), as in accounts.test.mjs
let ipn = 0; const nextIp = () => `10.30.${Math.floor(++ipn / 200)}.${ipn % 200}`;
const post = (path, body, { cookie, origin = BASE } = {}) => fetch(BASE + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), 'CF-Connecting-IP': nextIp() } });
async function signIn(email) {
    assert.equal((await post('/api/auth/start', { email })).status, 200);
    const mails = (await (await fetch(`${BASE}/api/admin/accounts/outbox?email=${enc(email)}`, { headers: auth })).json()).emails;
    const token = mails.at(-1).text.match(/\/signin#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    assert.equal(r.status, 200);
    const userId = (await (await fetch(`${BASE}/api/admin/accounts/lookup?email=${enc(email)}`, { headers: auth })).json()).user.id;
    return { cookie: r.headers.get('set-cookie').split(';')[0], userId };
}

// ---- visitors: an IP + a user agent
const person = (ip, ua) => ({ 'CF-Connecting-IP': ip, 'User-Agent': ua });
const A = person('203.0.113.11', `Mozilla/5.0 (Macintosh) statsA-${run}`);
const B = person('203.0.113.12', `Mozilla/5.0 (iPhone) statsB-${run}`);
const C = person('203.0.113.13', `Mozilla/5.0 (Windows) statsC-${run}`);
const D = person('203.0.113.14', `Mozilla/5.0 (Linux) statsD-${run}`);
const get = (path, headers) => fetch(BASE + path, { headers });
async function connect(id, headers) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(id)}/ws`, { headers });
    await new Promise((res, rej) => { ws.addEventListener('message', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    ws.close();
}
const dump = async (id) => (await get(`/api/admin/cal/${enc(id)}/stats-dump`, auth)).json();
const todayRow = async (id) => (await dump(id)).daily.find((d) => d.day === today) || { views: 0, visitors: 0, followers: 0 };
const counts = async (id) => { await sleep(150); const r = await todayRow(id); return [r.views, r.visitors, r.followers]; };   // counting runs just after the response
// A non-loopback client address: with UNSAFE_DEV_SESSION_HEADER on, loopback requests take their user
// from X-Dev-Session-User instead of the cookie.
const stats = (id, cookie, days) => get(`/api/pro/stats?calendar=${enc(id)}${days ? `&days=${days}` : ''}`, { 'CF-Connecting-IP': nextIp(), ...(cookie ? { Cookie: cookie } : {}) });

const owner = await signIn(`stats-owner-${run}@example.com`);
const id = `test-stats-${run}`;
let r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: 'Stats', events: [] }) });
assert.equal(r.status, 201, await r.text());

// 1. Free calendar: counted, but not shown.
r = await stats(id, owner.cookie);
assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'pro-only' });
await get(`/cal/${enc(id)}`, A);
assert.deepEqual(await counts(id), [1, 1, 0]);
step('a free calendar is counted (1 view, 1 visitor) but /api/pro/stats answers 403 {error:"pro-only"}');

r = await fetch(`${BASE}/api/admin/cal/${enc(id)}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ ownerId: owner.userId }) });
assert.equal(r.status, 200);

// 2. The same visitor again the same day: still one visitor, and one view (a poll, a reload, the socket).
for (let i = 0; i < 3; i++) await get(`/cal/${enc(id)}`, A);
await connect(id, A);
assert.deepEqual(await counts(id), [1, 1, 0]);
step('the same visitor polling GET /cal/<id> and opening the socket counts once: 1 view, 1 visitor');

// 3. New visitors through the socket and the read-only link.
await connect(id, B);
r = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ sourceCalendarId: id }) });
const viewId = (await r.json()).publicViewId;
assert.ok(viewId, 'owner made a view link');
const twoVisitors = await todayRow(id);
await get(`/cal/view/${enc(viewId)}`, C);
await get(`/cal/view/${enc(viewId)}`, C);
assert.deepEqual(await counts(id), [3, 3, 0]);
step('a new visitor on the socket and one on the read-only link (polled twice): 3 views, 3 visitors');

// 4. Bots are skipped.
for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl/8.4.0', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 UptimeRobot/2.0', 'facebookexternalhit/1.1 preview']) {
    await get(`/cal/${enc(id)}`, person('198.51.100.7', ua));
    await get(`/${enc(id)}.ics`, person('198.51.100.7', ua));
}
assert.deepEqual(await counts(id), [3, 3, 0]);
step('crawlers, link previews, monitors and curl count nothing (views, visitors, followers unchanged)');

// 5. Followers: distinct calendar apps fetching the ICS feed today.
const gcal = person('66.249.0.1', 'Google-Calendar-Importer');
for (let i = 0; i < 3; i++) assert.equal((await get(`/${enc(id)}.ics`, gcal)).status, 200);
await get(`/${enc(id)}.ics`, person('40.0.0.9', 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)'));
await get(`/view/${enc(viewId)}.ics`, person('17.0.0.5', 'iOS/18.0 (22A) dataaccessd/1.0'));
const etagRes = await get(`/${enc(id)}.ics`, person('17.0.0.6', 'iOS/18.0 (22A) dataaccessd/1.0'));
await get(`/${enc(id)}.ics`, { ...person('17.0.0.6', 'iOS/18.0 (22A) dataaccessd/1.0'), 'If-None-Match': etagRes.headers.get('etag') });
assert.deepEqual(await counts(id), [3, 3, 4], 'ICS fetches are follows, never views');
step('ICS: one app fetching 3 times counts once; 4 distinct apps (edit and view feeds, 304s included) = 4 followers; views unchanged');

// 6. What the owner sees.
r = await stats(id, owner.cookie);
assert.equal(r.status, 200);
let s = await r.json();
assert.equal(s.days.length, 30); assert.equal(s.days.at(-1).day, today);
assert.deepEqual(s.days.at(-1), { day: today, views: 3, visitors: 3, followers: 4 });
assert.ok(s.days.slice(0, -1).every((d) => d.views === 0 && d.visitors === 0 && d.followers === 0), 'earlier days are zeros');
assert.deepEqual(s.totals, { views: 3, visitors: 3, followers: 4, followersToday: 4 });
assert.ok(Array.isArray(s.countries) && Array.isArray(s.cities));
for (const days of [90, 365]) { const x = await (await stats(id, owner.cookie, days)).json(); assert.equal(x.days.length, days); }
assert.equal((await stats(id, owner.cookie, 7)).status, 400);
step('GET /api/pro/stats: 30 days oldest first (90 and 365 too, anything else 400), today 3/3/4, totals {views, visitors, followers, followersToday}');

// 7. Places: countries tallied per visitor; a city only once 3 visitors came from it.
const place = (twoVisitors.cities_json && Object.keys(JSON.parse(twoVisitors.cities_json))[0]) || null;
if (place) {
    const [city, cc] = place.split('|');
    // A second calendar where only 2 people came (one of them reloading): its city stays hidden.
    const id2 = `test-stats-two-${run}`;
    await fetch(`${BASE}/cal/${enc(id2)}`, { method: 'POST', body: JSON.stringify({ title: 'Two', events: [] }) });
    await fetch(`${BASE}/api/admin/cal/${enc(id2)}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ ownerId: owner.userId }) });
    await get(`/cal/${enc(id2)}`, A); await get(`/cal/${enc(id2)}`, B);
    for (let i = 0; i < 5; i++) await get(`/cal/${enc(id2)}`, A);              // one person reloading must not reach 3
    await sleep(150);
    const two = await (await stats(id2, owner.cookie)).json();
    assert.deepEqual(two.cities, [], 'a city with 2 visitors is hidden');
    assert.deepEqual(two.countries, cc ? [{ code: cc, count: 2 }] : []);
    assert.deepEqual(s.cities, [{ name: city, country: cc || null, count: 3 }]);
    if (cc) assert.deepEqual(s.countries, [{ code: cc, count: 3 }]);
    step(`places: countries counted per visitor (${cc}: 3); "${city}" hidden at 2 visitors (reloads don't add), shown at 3`);
} else {
    step('SKIPPED places: wrangler dev gave no request.cf.city on this machine');
}

// 8. Only the owner.
const other = await signIn(`stats-other-${run}@example.com`);
r = await stats(id, other.cookie);
assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'not-owner' });
r = await stats(id);
assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'signed-out' });
assert.equal((await stats(`test-stats-missing-${run}`, owner.cookie)).status, 404);
r = await get(`/api/pro/stats?calendar=${enc(id)}`, { Cookie: owner.cookie, 'X-PC-User': other.userId, 'CF-Connecting-IP': nextIp() });
assert.equal(r.status, 200, 'a client-sent X-PC-User changes nothing');
assert.equal((await get(`/api/admin/cal/${enc(id)}/stats-dump`)).status, 403, 'the dump needs the secret');
assert.equal((await get(`/cal/${enc(id)}/stats`)).status, 404, 'the room route is internal');
assert.equal((await get(`/cal/${enc(id)}/stats-dump`)).status, 404);
step('another signed-in user gets 403 not-owner, signed out 401, a missing calendar 404; room routes are not reachable from outside');

// 9. A client can't forge hits.
const before = await counts(id);
await get(`/cal/${enc(id)}/history`, { ...person('203.0.113.99', `Mozilla/5.0 forged-${run}`), 'X-PC-Hit': 'view', 'X-PC-Geo-City': 'Nowhere' });
await fetch(`${BASE}/cal/${enc(id)}`, { method: 'HEAD', headers: { ...person('203.0.113.98', `Mozilla/5.0 forged2-${run}`), 'X-PC-Hit': 'view' } });
assert.deepEqual(await counts(id), before);
await get(`/cal/${enc(id)}`, { ...D, 'X-PC-Hit': 'follow', 'X-PC-Geo-City': 'Forged%20City', 'X-PC-Geo-Country': 'ZZ' });
const afterD = await todayRow(id);
assert.deepEqual([afterD.views, afterD.visitors, afterD.followers], [4, 4, 4], 'counted as the view it was, not a follow');
assert.ok(!afterD.cities_json.includes('Forged') && !afterD.countries_json.includes('ZZ'), 'client geo headers are ignored');
step('X-PC-Hit / X-PC-Geo-* from a client are stripped: /history and HEAD count nothing, a forged "follow" counts as the view it was, forged places are ignored');

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
