// Contact form (POST /api/contact, GET /api/admin/messages), against `wrangler dev` started with
// ACCOUNTS_DEV_MODE=1 (so a localhost Origin counts as same-site) and IMPORT_SECRET.
// The 5-an-hour limit is per IP and lasts an hour: run it against a fresh --persist-to directory.
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const ORIGIN = new URL(BASE).origin;
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const send = (body, { origin = ORIGIN, type = 'application/json', raw } = {}) => fetch(`${BASE}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': type, ...(origin ? { Origin: origin } : {}) },
    body: raw ?? JSON.stringify(body),
});
const list = async (auth = true) => fetch(`${BASE}/api/admin/messages`, { headers: auth ? { Authorization: `Bearer ${SECRET}` } : {} });
const stored = async () => (await (await list()).json()).messages;
const tag = `t${Date.now()}`;
const ok = (extra = {}) => ({ type: 'question', message: `How do I embed a calendar? ${tag}`, elapsed: 8000, ...extra });
const err = async (r, status, re) => { assert.equal(r.status, status); if (re) assert.match((await r.json()).error, re); };

// Nothing below is stored, so none of it uses up the hourly limit.
await err(await send(ok(), { origin: 'https://evil.example' }), 403);
await err(await send(ok(), { origin: null }), 403);
await err(await send(ok(), { type: 'text/plain' }), 403);
step('another site, no Origin, or a non-JSON post is refused');

await err(await send(ok({ type: 'report', calendar: '' })), 400, /calendar's link/);
await err(await send(ok({ type: 'report', calendar: 'https://evil.example/x' })), 400, /isn't a pastecal calendar link/);
await err(await send(ok({ calendar: 'http://pastecal.com.evil.example/abc' })), 400, /isn't a pastecal calendar link/);
await err(await send(ok({ calendar: 'pastecal.com/pricing' })), 400, /isn't a pastecal calendar link/);
step('a report needs a calendar link, and any link given must be a pastecal calendar');

await err(await send(ok({ message: 'x'.repeat(2001) })), 400, /2000 characters/);
await err(await send(null, { raw: JSON.stringify(ok({ message: 'x'.repeat(20000) })) }), 413);
step('an over-long message and an oversized body are refused');

await err(await send(ok({ elapsed: 900 })), 400, /Wait a few seconds/);
await err(await send(ok({ elapsed: undefined })), 400, /Wait a few seconds/);
await err(await send(ok({ elapsed: 2 * 86400000 })), 400, /Reload it/);
step('a form sent in under 3 seconds, without a fill time, or after a day is refused');

await err(await send(ok({ type: 'nonsense' })), 400, /Pick what this is about/);
await err(await send(ok({ message: '  ' })), 400, /Write a message/);
await err(await send(ok({ email: 'not-an-email' })), 400, /email address/);
step('a bad type, an empty message, or a bad email says what to fix');

let r = await send(ok({ message: `bot ${tag}`, website: 'http://spam.example' }));
assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
step('the hidden bot field: answered "ok"');

assert.equal((await list(false)).status, 403);
assert.equal((await fetch(`${BASE}/api/admin/messages`, { headers: { Authorization: 'Bearer wrong' } })).status, 403);
step('the admin list needs the secret');

r = await send(ok({ type: 'report', calendar: 'https://www.pastecal.com/view/AbC-12?x=1', message: `Asks for card numbers ${tag}`, email: 'ann@example.com' }));
assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
let rows = await stored();
const mine = rows.find((m) => m.message === `Asks for card numbers ${tag}`);
assert.ok(mine, 'stored');
assert.equal(mine.type, 'report'); assert.equal(mine.calendar, 'view/AbC-12'); assert.equal(mine.email, 'ann@example.com');
assert.ok(mine.created_at && 'country' in mine);
assert.ok(!JSON.stringify(rows).includes('127.0.0.1') && !('ip' in mine) && !('ip_hash' in mine), 'no IP on the row');
assert.ok(!rows.some((m) => m.message === `bot ${tag}`), 'the bot message was not stored');
step('a report is stored with its type, calendar path and email, and no IP; the bot message is not');

for (let i = 2; i <= 5; i++) assert.equal((await send(ok({ type: 'idea', message: `idea ${i} ${tag}` }))).status, 200, `message ${i}`);
await err(await send(ok({ message: `sixth ${tag}` })), 429, /Wait an hour/);
rows = await stored();
assert.equal(rows.filter((m) => m.message.endsWith(tag)).length, 5);
step('5 messages an hour from one address; the 6th is refused and not stored');
console.log(`\n${n} checks passed`); process.exit(0);
