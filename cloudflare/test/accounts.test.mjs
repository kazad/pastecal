// Pro accounts: magic-link sign-in, sessions, CSRF, admin lookup, against `wrangler dev` with
// ACCOUNTS_DEV_MODE=1 (sign-in emails land in an outbox the test reads).
// Setup (both files). cloudflare/.dev.vars (gitignored), fake values only:
//   IMPORT_SECRET=dev-secret
//   ACCOUNTS_DEV_MODE=1
//   LOCK_API_BASE=http://127.0.0.1:8832/lockfake
// Then, from cloudflare/, two `wrangler dev` instances:
//   node node_modules/.bin/wrangler dev --port 8822 --inspector-port 9241 --persist-to /tmp/pc-billing-state --var COPY_BACK: \
//     --var STRIPE_SECRET_KEY:fake-stripe-key --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret \
//     --var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly \
//     --var STRIPE_API_BASE:http://127.0.0.1:8832/stripe
//   node node_modules/.bin/wrangler dev --port 8823 --inspector-port 9242 --persist-to /tmp/pc-billing-state-nokeys --var COPY_BACK:
//   node test/accounts.test.mjs && node test/billing.test.mjs
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8822', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
let ip = 0; const nextIp = () => `10.20.${Math.floor(++ip / 200)}.${ip % 200}`;   // its own rate-limit bucket per call

const post = (path, body, { origin = BASE, cookie, type = 'application/json', ipAddr = nextIp() } = {}) => fetch(BASE + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': type, ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), 'CF-Connecting-IP': ipAddr },
});
const admin = (path, init = {}) => fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
const outbox = async (email) => (await (await admin(`/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).json()).emails;
const lastToken = async (email) => { const m = (await outbox(email)).at(-1).text.match(/\/signin#t=([A-Za-z0-9_-]+)/); return m && m[1]; };
const me = (cookie) => fetch(BASE + '/api/me', { headers: cookie ? { Cookie: cookie } : {} });

const ann = `ann-${run}@example.com`;
let r = await post('/api/auth/start', { email: ann.toUpperCase(), next: '/team-calendar' });
assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
const mail = (await outbox(ann))[0];
assert.equal(mail.subject, 'Your pastecal sign-in link');
assert.match(mail.text, /https:\/\/pastecal\.com\/signin#t=[A-Za-z0-9_-]{22}\n/, 'token in the fragment, never the query');
assert.match(mail.text, /expires in 15 minutes/); assert.match(mail.text, /ignore this email/);
step('start: generic ok, one email (lowercased address) with the token in the #fragment');

const token = await lastToken(ann);
r = await post('/api/auth/peek', { token });
assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, email: ann });
assert.equal(r.headers.get('set-cookie'), null, 'peek signs no one in');
assert.equal((await post('/api/auth/peek', { token }, { origin: 'https://evil.example' })).status, 403);
r = await post('/api/auth/peek', { token: 'A'.repeat(22) });
assert.equal(r.status, 400);
const madeUp = (await r.json()).error;
step('peek names the email of a working link without using it up or setting a cookie (same-site only)');

r = await post('/api/auth/verify', { token });
assert.equal(r.status, 200);
const v = await r.json();
assert.equal(v.email, ann); assert.equal(v.next, '/team-calendar');
const setCookie = r.headers.get('set-cookie');
assert.match(setCookie, /^pc_session=[A-Za-z0-9_-]{22}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
const cookie = setCookie.split(';')[0];
r = await me(cookie);
assert.equal(r.status, 200); assert.deepEqual(await r.json(), { email: ann, calendars: [] });
step('verify sets a 30-day HttpOnly Secure SameSite=Lax cookie; /api/me knows the user');

r = await post('/api/auth/verify', { token });
assert.equal(r.status, 400); assert.match((await r.json()).error, /expired or was already used/); assert.equal(r.headers.get('set-cookie'), null);
r = await post('/api/auth/peek', { token });
assert.equal(r.status, 400); assert.equal((await r.json()).error, madeUp, 'a used link and a made-up one look the same');
step('a used link is refused (verify and peek)');

const bob = `bob-${run}@example.com`;
await post('/api/auth/start', { email: bob });
const bobToken = await lastToken(bob);
await admin('/api/admin/accounts/expire-tokens', { method: 'POST', body: JSON.stringify({ email: bob }) });
r = await post('/api/auth/verify', { token: bobToken });
assert.equal(r.status, 400); assert.match((await r.json()).error, /expired/);
r = await post('/api/auth/verify', { token: 'A'.repeat(22) });
assert.equal(r.status, 400);
step('an expired link and a made-up token are refused');

r = await post('/api/auth/start', { email: `nobody-${run}@example.com` });
const unknown = await r.text();
r = await post('/api/auth/start', { email: ann });
assert.equal(unknown, await r.text(), 'same answer for known and unknown emails');
r = await post('/api/auth/start', { email: 'not-an-email' });
assert.equal(r.status, 400);
step('the same answer for a new and an existing email; a bad address gets a plain 400');

const cara = `cara-${run}@example.com`;
for (let i = 0; i < 7; i++) assert.equal((await post('/api/auth/start', { email: cara })).status, 200);
assert.equal((await outbox(cara)).length, 5);
for (const later of [10, 10]) {               // two hours later, twice: the hourly limit has reset each time
    await admin('/api/admin/accounts/expire-tokens', { method: 'POST', body: JSON.stringify({ email: cara, ageMs: 2 * 3600e3 }) });
    for (let i = 0; i < 6; i++) assert.equal((await post('/api/auth/start', { email: cara })).status, 200);
    assert.equal((await outbox(cara)).length, later, 'five more two hours later, then none: the daily cap');
}
step('at most 5 sign-in emails an hour and 10 a day per address (still answers ok)');

let limited = false;
for (let i = 0; i < 15 && !limited; i++) limited = (await post('/api/auth/start', { email: `x${i}-${run}@example.com` }, { ipAddr: `10.99.${run.length}.1` })).status === 429;
assert.ok(limited, 'never rate-limited');
step('rapid sign-in requests from one IP are rate-limited');

r = await post('/api/auth/start', { email: ann }, { origin: 'https://evil.example' });
assert.equal(r.status, 403);
r = await post('/api/auth/start', { email: ann }, { origin: null });
assert.equal(r.status, 403);
r = await post('/api/auth/verify', { token: 'x' }, { type: 'text/plain' });
assert.equal(r.status, 403);
r = await post('/api/auth/signout', {}, { cookie, origin: 'https://evil.example' });
assert.equal(r.status, 403);
assert.equal((await me(cookie)).status, 200, 'a cross-site signout did nothing');
step('CSRF: a foreign or missing Origin, or a non-JSON body, is refused');

const dan = `dan-${run}@example.com`;
await post('/api/auth/start', { email: dan, next: '//evil.example/x' });
r = await post('/api/auth/verify', { token: await lastToken(dan) });
assert.equal((await r.json()).next, null);
await post('/api/auth/start', { email: dan, next: 'https://evil.example' });
r = await post('/api/auth/verify', { token: await lastToken(dan) });
assert.equal((await r.json()).next, null);
let nn = 0;
const nextFor = async (next) => { const e = `next-${++nn}-${run}@example.com`; await post('/api/auth/start', { email: e, next }); return (await (await post('/api/auth/verify', { token: await lastToken(e) })).json()).next; };
assert.equal(await nextFor('/pro/done'), null, 'never back to /pro/done (it makes editor links)');
assert.equal(await nextFor('/pro'), null);
assert.equal(await nextFor('/signin'), null);
assert.equal(await nextFor('/team?x=1'), null, 'no query');
assert.equal(await nextFor('/a/b'), null, 'one segment only');
assert.equal(await nextFor('/%2F%2Fevil.example'), null, 'a slash hidden in an escape');
assert.equal(await nextFor('/'), '/');
assert.equal(await nextFor('/Team%20NU%C3%91EZ'), '/Team%20NU%C3%91EZ', 'an encoded calendar name');
step('next is only ever "/" or one calendar on pastecal (no open redirect, no /pro/ or /signin, no query)');

assert.equal((await me()).status, 401);
assert.equal((await me('pc_session=garbage')).status, 401);
assert.equal((await me('pc_session=' + 'B'.repeat(22))).status, 401);
r = await post('/api/auth/signout', {}, { cookie });
assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /pc_session=; .*Max-Age=0/);
assert.equal((await me(cookie)).status, 401);
step('/api/me is 401 without a valid session; signout ends the session');

assert.equal((await fetch(`${BASE}/api/admin/accounts/lookup?email=${ann}`)).status, 403);
assert.equal((await fetch(`${BASE}/api/admin/accounts/outbox?email=${ann}`)).status, 403);
r = await admin(`/api/admin/accounts/lookup?email=${ann}`);
const look = await r.json();
assert.equal(look.user.email, ann); assert.match(look.user.id, /^u_/); assert.deepEqual(look.subscriptions, []);
assert.ok(!JSON.stringify(look).includes(cookie.split('=')[1]), 'no session token in the lookup');
step('admin lookup and the test outbox need the secret');

const eve = `eve-${run}@example.com`;
await post('/api/auth/start', { email: eve });
r = await post('/api/auth/verify', { token: await lastToken(eve) });
const eveCookie = r.headers.get('set-cookie').split(';')[0];
const devSub = (body, init = {}) => fetch(BASE + '/api/admin/accounts/dev-subscription', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, body: JSON.stringify(body) });
assert.equal((await devSub({ email: eve, calendarId: `eve-cal-${run}` })).status, 403);
r = await devSub({ email: eve, calendarId: `eve-cal-${run}` }, { headers: { Authorization: `Bearer ${SECRET}` } });
assert.equal(r.status, 200);
r = await devSub({ email: eve, calendarId: `eve-late-${run}`, status: 'past_due', interval: 'month', currentPeriodEnd: 1900000000 }, { headers: { Authorization: `Bearer ${SECRET}` } });
assert.equal(r.status, 200);
const eveMe = await (await me(eveCookie)).json();
const byId = Object.fromEntries(eveMe.calendars.map((c) => [c.id, c]));
assert.equal(byId[`eve-cal-${run}`].status, 'active'); assert.equal(byId[`eve-cal-${run}`].interval, 'year');
assert.ok(byId[`eve-cal-${run}`].currentPeriodEnd > Date.now() / 1000);
assert.equal(byId[`eve-late-${run}`].status, 'past_due'); assert.equal(byId[`eve-late-${run}`].currentPeriodEnd, 1900000000);
step('dev-subscription (dev mode + secret) adds a subscription row that /api/me lists');

// The session cookie on a calendar WebSocket counts only from pastecal's own pages (Origin); otherwise the
// socket still opens, as a viewer.
const fay = `fay-${run}@example.com`;
await post('/api/auth/start', { email: fay });
r = await post('/api/auth/verify', { token: await lastToken(fay) });
const fayCookie = r.headers.get('set-cookie').split(';')[0];
const fayId = (await (await admin(`/api/admin/accounts/lookup?email=${encodeURIComponent(fay)}`)).json()).user.id;
const wsCal = `test-ws-origin-${run}`;
assert.equal((await fetch(`${BASE}/cal/${encodeURIComponent(wsCal)}`, { method: 'POST', body: JSON.stringify({ title: 'T', events: [] }), headers: { 'CF-Connecting-IP': nextIp() } })).status, 201);
assert.equal((await admin(`/api/admin/cal/${encodeURIComponent(wsCal)}/lock`, { method: 'POST', body: JSON.stringify({ ownerId: fayId }) })).status, 200);
const roleVia = (origin) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/cal/${encodeURIComponent(wsCal)}/ws`, { headers: { Cookie: fayCookie, ...(origin ? { Origin: origin } : {}) } });
    const t = setTimeout(() => reject(new Error('no snapshot')), 4000);
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.t === 'snapshot') { clearTimeout(t); ws.close(); resolve(m.role); } });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('socket error')); });
});
assert.equal(await roleVia(BASE), 'owner', 'from our own page: the owner');
assert.equal(await roleVia('https://evil.example'), 'viewer', 'from another site: anonymous');
assert.equal(await roleVia(null), 'viewer', 'no Origin: anonymous');
step('a calendar socket trusts the session cookie only with pastecal\'s Origin; from anywhere else it opens read-only');

console.log(`\n${n} checks passed`); process.exit(0);
