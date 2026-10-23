// End to end against a REAL Stripe sandbox (test mode): magic-link sign-in, Checkout paid with
// Stripe's test card, webhook locks the calendar, cancel, webhook unlocks it.
// Needs: wrangler dev on BASE with .dev.vars.e2e + .dev.vars.stripe (sandbox sk_test key, price
// ids, the `stripe listen` signing secret, ACCOUNTS_DEV_MODE=1), and
//   stripe listen --forward-to localhost:8850/api/stripe/webhook --events checkout.session.completed,
//     customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.payment_failed,
//     charge.refunded,charge.dispute.created
// Run: NODE_PATH=<repo>/node_modules node test/stripe-sandbox-e2e.mjs   (never against production)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:8850', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const ORIGIN = { Origin: BASE, 'Content-Type': 'application/json' };
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = (p) => fetch(BASE + p, { headers: { Authorization: `Bearer ${SECRET}` } }).then((r) => r.json());
async function until(fn, ms = 60000, every = 1500) {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every); }
}

const run = Date.now().toString(36), cal = `e2e-pro-${run}`, email = `e2e-${run}@example.com`;

// 1. A calendar and a signed-in owner
let r = await fetch(`${BASE}/cal/${cal}`, { method: 'POST', body: JSON.stringify({ title: 'E2E Pro', events: [] }) });
assert.equal(r.status, 201, await r.text());
await fetch(BASE + '/api/auth/start', { method: 'POST', headers: ORIGIN, body: JSON.stringify({ email }) });
const mail = (await admin(`/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).emails.at(-1);
const token = mail.text.match(/#t=([A-Za-z0-9_-]+)/)[1];
r = await fetch(BASE + '/api/auth/verify', { method: 'POST', headers: ORIGIN, body: JSON.stringify({ token }) });
const cookie = r.headers.get('set-cookie').split(';')[0];
const authed = { ...ORIGIN, Cookie: cookie };
step('calendar created; owner signed in through the emailed link');

// 2. Checkout, monthly, on Stripe's real hosted page
r = await fetch(BASE + '/api/pro/checkout', { method: 'POST', headers: authed, body: JSON.stringify({ calendarId: cal, interval: 'month' }) });
const out = await r.json();
assert.equal(r.status, 200, JSON.stringify(out)); assert.match(out.url, /^https:\/\/checkout\.stripe\.com\//);
step('checkout returns a real Stripe Checkout URL');

// Stripe's hosted page keeps card fields in a secure iframe, so pay the way Checkout would: a
// customer with Stripe's test card, subscribed to the same price, with the metadata checkout sets.
const owner = (await admin(`/api/admin/accounts/lookup?email=${encodeURIComponent(email)}`)).user.id;
const stripeJson = (args) => JSON.parse(execFileSync('stripe', args, { encoding: 'utf8' }).replace(/^[^{]*/, ''));
const customer = stripeJson(['customers', 'create', '--email', email, '-d', 'payment_method=pm_card_visa', '-d', 'invoice_settings[default_payment_method]=pm_card_visa']);
const priceMonthly = (process.env.PRICE_MONTHLY || 'price_1UTr8bEPgWTHeJ7WOtXnUtB1');
const created = stripeJson(['subscriptions', 'create', '--customer', customer.id, '-d', `items[0][price]=${priceMonthly}`,
    '-d', `metadata[calendar_id]=${cal}`, '-d', `metadata[user_id]=${owner}`]);
assert.equal(created.status, 'active', `subscription status ${created.status}`);
step('paid with Stripe test card pm_card_visa: a real sandbox subscription is active');

// 3. The webhook (via stripe listen) locks the calendar for this owner
const st = await until(async () => { const s = await (await fetch(`${BASE}/api/pro/status?calendar=${cal}`, { headers: { Cookie: cookie } })).json(); return s.locked ? s : null; });
assert.ok(st, 'calendar never locked'); assert.deepEqual(st, { locked: true, pro: true, isOwner: true });
const me = await (await fetch(BASE + '/api/me', { headers: { Cookie: cookie } })).json();
const row = me.calendars.find((c) => c.id === cal);
assert.equal(row.status, 'active'); assert.equal(row.interval, 'month');
step('webhook locked it: status {locked, pro, isOwner} all true; /api/me shows an active monthly subscription');

// 4. A visitor can't change it; the owner's editor key can
r = await fetch(BASE + '/api/pro/editor-key', { method: 'POST', headers: authed, body: JSON.stringify({ calendarId: cal }) });
const { editorKey } = await r.json(); assert.ok(editorKey);
async function trySave(key) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${cal}/ws`); const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    await until(() => got.some((m) => m.t === 'snapshot'), 10000, 50);
    if (key) { ws.send(JSON.stringify({ t: 'auth', key })); await until(() => got.some((m) => m.t === 'auth'), 10000, 50); }
    const id = 's' + Math.random().toString(36).slice(2);
    const v = got.find((m) => m.t === 'snapshot').v;
    ws.send(JSON.stringify({ t: 'save', id, v, commands: [{ type: 'add', event: { id: id, title: 'x', start: '2026-11-02T17:00:00.000Z', end: '2026-11-02T18:00:00.000Z', type: 1 } }] }));
    const reply = await until(() => got.find((m) => m.id === id), 10000, 50); ws.close(); return reply;
}
assert.equal((await trySave(null)).code, 'locked');
assert.notEqual((await trySave(editorKey)).t, 'error');
step('a visitor\'s save is refused (locked); the owner\'s editor key can save');

// 5. Cancel in Stripe; the webhook unlocks it
const sub = JSON.parse(execFileSync('stripe', ['subscriptions', 'list', '--limit', '5'], { encoding: 'utf8' }).replace(/^[^{]*/, ''))
    .data.find((s) => s.metadata && s.metadata.calendar_id === cal);
assert.ok(sub, 'subscription not found in Stripe');
execFileSync('stripe', ['subscriptions', 'cancel', sub.id, '--confirm'], { stdio: 'ignore' });
const unlocked = await until(async () => { const s = await (await fetch(`${BASE}/api/pro/status?calendar=${cal}`, { headers: { Cookie: cookie } })).json(); return s.locked ? null : s; });
assert.ok(unlocked, 'calendar never unlocked'); assert.equal((await trySave(null)).t === 'error', false);
step('cancelled in Stripe: the webhook unlocked it and anyone can edit again');

console.log(`\n${n} checks passed`); process.exit(0);
