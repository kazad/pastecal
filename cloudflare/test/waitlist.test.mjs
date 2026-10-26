// Pro waitlist (POST /api/waitlist, GET /api/waitlist/export), against `wrangler dev`.
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const join = (body) => fetch(`${BASE}/api/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const exportCsv = async (auth = true) => fetch(`${BASE}/api/waitlist/export`, { headers: auth ? { Authorization: `Bearer ${SECRET}` } : {} });
const who = `ann${Date.now()}@example.com`;

let r = await join({ email: who, plan: 'pro', use: 'Sports or a club', ideas: 'Let parents RSVP', page: '/pricing' });
assert.equal(r.status, 200); assert.equal((await r.json()).returning, false);
let csv = await (await exportCsv()).text();
assert.ok(csv.includes(who) && csv.includes('Let parents RSVP') && csv.includes(',"pro",'));
step('a sign-up is saved and appears in the export with its plan and idea');

r = await join({ email: who.toUpperCase(), plan: 'teams', use: 'Work or a team', ideas: 'Subcalendars per team' });
assert.equal((await r.json()).returning, true);
csv = await (await exportCsv()).text();
assert.equal(csv.split(who).length - 1, 1, 'one row per email');
assert.ok(csv.includes('Let parents RSVP') && csv.includes('Subcalendars per team') && csv.includes(',"teams",'));
step('signing up again (any letter case) updates the same row and keeps both ideas');

r = await join({ email: 'not-an-email' });
assert.equal(r.status, 400); assert.match((await r.json()).error, /Enter an email address/);
step('a bad email is refused with a plain message');

const bot = `bot${Date.now()}@example.com`;
r = await join({ email: bot, website: 'http://spam.example' });
assert.equal(r.status, 200);
assert.ok(!(await (await exportCsv()).text()).includes(bot));
step('the hidden bot field: answered "ok", stored nothing');

assert.equal((await exportCsv(false)).status, 403);
step('the export needs the secret');

let limited = false;
for (let i = 0; i < 15 && !limited; i++) limited = (await join({ email: `x${i}${Date.now()}@example.com` })).status === 429;
assert.ok(limited, 'never rate-limited');
step('rapid repeat sign-ups from one address are rate-limited');
console.log(`\n${n} checks passed`); process.exit(0);
