// Pro stats breakdowns through the Worker: followers by app, views by UTC hour, views by source.
// Against `wrangler dev` with ACCOUNTS_DEV_MODE=1 and IMPORT_SECRET (.dev.vars), e.g.
//   BASE=http://localhost:8894 node test/stats-breakdowns.test.mjs
// If the server's .dev.vars set LOCK_API_BASE=http://127.0.0.1:8832/lockfake, owner checks go to that
// fake, so this test runs it (FAKE_PORT) and registers the calendar there as locked by the owner.
// The Worker derives the source (Sec-Fetch-Dest, ?embed=1, ?ref=<host>, Referer) and forwards only the
// category; the room derives the app from the User-Agent and drops it. Neither string may be stored.
import assert from 'node:assert/strict';
import net from 'node:net';
import { startFakeStripe } from './fake-stripe.mjs';

const BASE = process.env.BASE || 'http://localhost:8894', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const auth = { Authorization: `Bearer ${SECRET}` };
const today = new Date().toISOString().slice(0, 10);

let ipn = 0; const nextIp = () => `10.31.${Math.floor(++ipn / 200)}.${ipn % 200}`;
const post = (path, body, { cookie } = {}) => fetch(BASE + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), 'CF-Connecting-IP': nextIp() } });
async function signIn(email) {
    assert.equal((await post('/api/auth/start', { email })).status, 200);
    const mails = (await (await fetch(`${BASE}/api/admin/accounts/outbox?email=${enc(email)}`, { headers: auth })).json()).emails;
    const token = mails.at(-1).text.match(/\/signin#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    assert.equal(r.status, 200);
    const userId = (await (await fetch(`${BASE}/api/admin/accounts/lookup?email=${enc(email)}`, { headers: auth })).json()).user.id;
    return { cookie: r.headers.get('set-cookie').split(';')[0], userId };
}
const person = (ip, ua) => ({ 'CF-Connecting-IP': ip, 'User-Agent': ua });
const get = (path, headers) => fetch(BASE + path, { headers });
async function connect(path, headers) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + path, { headers });
    await new Promise((res, rej) => { ws.addEventListener('message', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    ws.close();
}
const dump = async (id) => { await sleep(200); return (await get(`/api/admin/cal/${enc(id)}/stats-dump`, auth)).json(); };
const todayRow = async (id) => (await dump(id)).daily.find((d) => d.day === today);
const obj = (s) => JSON.parse(s || '{}');

const owner = await signIn(`breakdowns-${run}@example.com`);
const id = `test-breakdowns-${run}`;
let r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: 'Breakdowns', events: [] }) });
assert.equal(r.status, 201, await r.text());
r = await fetch(`${BASE}/api/admin/cal/${enc(id)}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ ownerId: owner.userId }) });
assert.equal(r.status, 200);
r = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ sourceCalendarId: id }) });
const viewId = (await r.json()).publicViewId;
assert.ok(viewId);
// Only when nothing already listens there (listen reports a busy port as an event, not a rejection).
const fakePort = Number(process.env.FAKE_PORT || 8832);
const portFree = await new Promise((res) => { const c = net.connect(fakePort, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(false); }); c.on('error', () => res(true)); });
const fake = portFree ? await startFakeStripe(fakePort) : null;
if (fake) fake.addCalendar(id, { locked: true, ownerId: owner.userId, plan: 'pro', lockedAt: Date.now() - 1000 });

// 1. Followers by app (real user agents). One iPhone fetching 5 times (a 304 among them) is 1 apple.
const IPHONE = person('17.0.1.6', 'iOS/26.6 (23G71) dataaccessd/1.0');
let etag = null;
for (let i = 0; i < 5; i++) {
    const res = await get(`/${enc(id)}.ics`, { ...IPHONE, ...(etag ? { 'If-None-Match': etag } : {}) });
    assert.ok(res.status === 200 || res.status === 304);
    etag = res.headers.get('etag') || etag;
}
await get(`/view/${enc(viewId)}.ics`, person('17.0.2.7', 'macOS/26.6.2 (25G83) dataaccessd/1.0'));
for (let i = 0; i < 3; i++) await get(`/${enc(id)}.ics`, person('66.249.80.1', 'Google-Calendar-Importer'));
await get(`/${enc(id)}.ics`, person('40.0.0.9', 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)'));
await get(`/${enc(id)}.ics`, person('52.96.0.3', 'Microsoft.Exchange/15.20 (Windows NT 10.0; Win64; x64)'));
await get(`/${enc(id)}.ics`, person('5.9.0.4', 'ICSx5/2.2.5-gplay (ical4j/3.2.19 okhttp/4.12.0 Android/14)'));
await get(`/${enc(id)}.ics`, person('91.198.0.5', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Thunderbird/128.3.0'));
let row = await todayRow(id);
assert.equal(row.followers, 7);
assert.deepEqual(obj(row.apps_json), { apple: 2, google: 1, outlook: 2, other: 2 });
step('followers by app: one iPhone fetching 5x (304 included) = 1 apple; Google 3x = 1; Outlook + Exchange = 2 outlook; ICSx5 + Thunderbird-on-Mac = 2 other');

// 2. Sources, one new visitor each (a visitor's repeat views within 30 min don't count again).
await get(`/cal/${enc(id)}`, { ...person('203.0.113.11', `Mozilla/5.0 direct-${run}`) });
await get(`/cal/${enc(id)}`, { ...person('203.0.114.11', `Mozilla/5.0 self-${run}`), Referer: `${BASE}/${enc(id)}` });
await get(`/cal/${enc(id)}`, { ...person('198.51.100.12', `Mozilla/5.0 search-${run}`), Referer: 'https://www.google.com/' });
await get(`/cal/${enc(id)}?ref=duckduckgo.com`, person('198.51.101.12', `Mozilla/5.0 ref-search-${run}`));
await get(`/cal/view/${enc(viewId)}`, { ...person('192.0.2.13', `Mozilla/5.0 site-${run}`), Referer: 'https://stura-example.de/termine' });
await get(`/cal/${enc(id)}?ref=myclub-example.org`, { ...person('192.0.3.13', `Mozilla/5.0 ref-site-${run}`), Referer: `${BASE}/${enc(id)}` });
await connect(`/cal/${enc(id)}/ws?embed=1&ref=parent-example.com`, person('100.64.7.14', `Mozilla/5.0 embed-ws-${run}`));
await get(`/cal/view/${enc(viewId)}`, { ...person('100.65.7.14', `Mozilla/5.0 embed-dest-${run}`), 'Sec-Fetch-Dest': 'iframe' });
await get(`/cal/${enc(id)}?ref=web.whatsapp.com`, person('100.66.7.14', `Mozilla/5.0 msg-${run}`));
for (let i = 0; i < 3; i++) await get(`/cal/${enc(id)}`, { ...person('198.51.100.12', `Mozilla/5.0 search-${run}`), Referer: 'https://www.google.com/' });   // same visitor polling
// A client can't plant a category: X-PC-* from outside is stripped, the source re-derived (direct).
await get(`/cal/${enc(id)}`, { ...person('100.67.7.14', `Mozilla/5.0 forged-${run}`), 'X-PC-Source': 'embed' });
row = await todayRow(id);
assert.equal(row.views, 10);
assert.deepEqual(obj(row.sources_json), { direct: 4, search: 2, site: 2, embed: 2 });
step('sources: no referrer / pastecal / WhatsApp Web / forged X-PC-Source = direct; Google Referer, ?ref=duckduckgo = search; other site (Referer or ?ref=) = site; ?embed=1 on the socket, Sec-Fetch-Dest: iframe = embed; a polling visitor counts once');

// 3. Hours: every counted view in this UTC hour, none elsewhere.
const hours = JSON.parse(row.hours_json);
const hour = new Date().getUTCHours();
assert.equal(hours.length, 24);
assert.equal(hours.reduce((a, x) => a + x, 0), 10);
assert.ok(hours[hour] >= 9, `this hour holds the views (${hours})`);    // tolerate an hour boundary mid-run
step(`hours: 24 UTC buckets summing to the 10 counted views (hour ${hour} UTC)`);

// 4. The owner's /api/pro/stats carries them; the free /api/stats does not.
r = await get(`/api/pro/stats?calendar=${enc(id)}`, { Cookie: owner.cookie, 'CF-Connecting-IP': nextIp() });
assert.equal(r.status, 200);
const s = await r.json();
assert.deepEqual(s.apps, { google: 1, apple: 2, outlook: 2, other: 2 });
assert.deepEqual(s.sources, { embed: 2, search: 2, site: 2, direct: 4 });
assert.equal(s.hours.length, 24); assert.equal(s.hours.reduce((a, x) => a + x, 0), 10);
assert.equal(s.totals.views, 10); assert.equal(s.totals.followers, 7);
const free = `test-breakdowns-free-${run}`;
await fetch(`${BASE}/cal/${enc(free)}`, { method: 'POST', body: JSON.stringify({ title: 'Free', events: [] }) });
await get(`/cal/${enc(free)}`, { ...person('203.0.113.40', `Mozilla/5.0 free-${run}`), Referer: 'https://www.google.com/' });
await get(`/${enc(free)}.ics`, IPHONE);
await sleep(200);
const fs = await (await get(`/api/stats?calendar=${enc(free)}`, { 'CF-Connecting-IP': nextIp() })).json();
assert.deepEqual(Object.keys(fs).sort(), ['followers', 'views', 'viewsPrev']);
step('/api/pro/stats returns apps {google, apple, outlook, other}, hours [24], sources {embed, search, site, direct}; free /api/stats is still exactly {views, viewsPrev, followers}');

// 5. Stored: categories only. No user agent, referrer, ref host or IP in the stats tables.
const text = JSON.stringify(await dump(id));
for (const needle of ['dataaccessd', 'Google-Calendar', 'Outlook', 'Exchange', 'ICSx5', 'Thunderbird', `-${run}`,
    'google.com', 'duckduckgo', 'stura-example', 'myclub-example', 'parent-example', 'whatsapp', '17.0.1.6', '198.51.100.12']) {
    assert.ok(!text.includes(needle), `"${needle}" stored`);
}
const t = await todayRow(id);
assert.ok(Object.keys(obj(t.apps_json)).every((k) => ['google', 'apple', 'outlook', 'other'].includes(k)));
assert.ok(Object.keys(obj(t.sources_json)).every((k) => ['embed', 'search', 'site', 'direct'].includes(k)));
step('stats-dump rows hold only categories and counts: no UA, referrer, ?ref= host or IP');

fake?.close();
console.log(`\n${n} checks passed`); process.exit(0);
