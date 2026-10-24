// Free stats (GET /api/stats, Insight.js): the headline counts for an unlocked calendar's edit link,
// against `wrangler dev` (any vars; .dev.vars: IMPORT_SECRET=dev-secret). Run:
//   BASE=http://localhost:8894 node cloudflare/test/free-stats.test.mjs
// The previous week can't be seeded without dev hooks, so viewsPrev is only checked to be 0 here;
// the comparison badge is unit-tested (ProInsightMath.delta, test/unit/pro-insight.test.js).
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8894', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const person = (ip, ua) => ({ 'CF-Connecting-IP': ip, 'User-Agent': `${ua} free-${run}` });
const stats = (id) => fetch(`${BASE}/api/stats?calendar=${enc(id)}`);

const id = `test-free-stats-${run}`;
let r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: 'Free stats', events: [] }) });
assert.equal(r.status, 201, await r.text());

// 1. A new calendar: zeros, and nothing but the three totals.
r = await stats(id);
assert.equal(r.status, 200);
assert.deepEqual(await r.json(), { views: 0, viewsPrev: 0, followers: 0 });
step('a new unlocked calendar answers {views:0, viewsPrev:0, followers:0}');

// 2. Two visitors and one calendar app: counts only, no days, no places.
await fetch(`${BASE}/cal/${enc(id)}`, { headers: person('203.0.113.21', 'Mozilla/5.0 (Macintosh)') });
await fetch(`${BASE}/cal/${enc(id)}`, { headers: person('198.51.100.22', 'Mozilla/5.0 (iPhone)') });
await fetch(`${BASE}/${enc(id)}.ics`, { headers: person('192.0.2.23', 'Google-Calendar-Importer') });
await sleep(200);   // counting runs just after the response
r = await stats(id);
assert.equal(r.status, 200);
const body = await r.json();
assert.equal(Object.keys(body).sort().join(), 'followers,views,viewsPrev', 'totals only: no per-day rows, countries or cities');
assert.deepEqual(body, { views: 2, viewsPrev: 0, followers: 1 });
assert.equal(r.headers.get('Cache-Control'), 'no-store');
step('two visitors and one calendar app: {views:2, viewsPrev:0, followers:1}, totals only');

// 3. A read-only link's id is not the calendar: it finds nothing.
r = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.40.0.1' }, body: JSON.stringify({ sourceCalendarId: id }) });
const viewId = (await r.json()).publicViewId;
assert.ok(viewId, 'made a view link');
// ...and its holder never learns the real id: neither the view's data nor the directory names it.
assert.ok(!(await (await fetch(`${BASE}/cal/view/${enc(viewId)}`)).text()).includes(id), 'the view copy does not name the calendar');
assert.ok(!(await (await fetch(`${BASE}/api/lookup?slug=${enc(viewId)}`)).text()).includes(id), 'lookup does not name the calendar');
r = await stats(viewId);
assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: 'no-calendar' });
step('a read-only link never names the calendar, and its own id answers 404 {error:"no-calendar"}');

// 4. Unknown and malformed ids; only GET.
r = await stats(`nope-${run}`);
assert.equal(r.status, 404);
r = await fetch(`${BASE}/api/stats`);
assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'bad-calendar' });
r = await fetch(`${BASE}/api/stats?calendar=a/b`);
assert.equal(r.status, 400);
r = await fetch(`${BASE}/api/stats?calendar=${enc(id)}`, { method: 'POST' });
assert.equal(r.status, 405);
step('unknown id 404, missing or malformed id 400, POST 405');

// 5. Locked (Pro): the free route refuses; the owner reads /api/pro/stats.
r = await fetch(`${BASE}/api/admin/cal/${enc(id)}/lock`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ ownerId: `free-stats-owner-${run}` }) });
assert.equal(r.status, 200, await r.text());
r = await stats(id);
assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'locked' });
step('a locked calendar answers 403 {error:"locked"}, even with the old edit link');

console.log(`\n${n} checks passed`); process.exit(0);
