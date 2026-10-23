// Pro billing: Checkout, the Stripe webhook, editor keys, the Billing Portal, /api/pro/status,
// support reassign. Two `wrangler dev` instances (ACCOUNTS_DEV_MODE=1 and LOCK_API_BASE from .dev.vars):
//   BASE (8822)        with fake Stripe vars: STRIPE_SECRET_KEY:fake-stripe-key STRIPE_WEBHOOK_SECRET:fake-webhook-secret
//                      STRIPE_PRICE_PRO_YEARLY:price_fake_yearly STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly
//                      STRIPE_API_BASE:http://127.0.0.1:8832/stripe
//   NOKEYS_BASE (8823) with no Stripe vars at all
// This file runs the fake Stripe + fake lock API on 8832 (test/fake-stripe.mjs).
import assert from 'node:assert/strict';
import { startFakeStripe, signStripe } from './fake-stripe.mjs';
const BASE = process.env.BASE || 'http://localhost:8822', NOKEYS = process.env.NOKEYS_BASE || 'http://localhost:8823';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret', WHSEC = 'fake-webhook-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const fake = await startFakeStripe(Number(process.env.FAKE_PORT || 8832));
let ip = 0;

const post = (base, path, body, cookie) => fetch(base + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: base, 'CF-Connecting-IP': `10.30.0.${++ip % 250}`, ...(cookie ? { Cookie: cookie } : {}) },
});
const admin = (base, path, init = {}) => fetch(base + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } });
async function signIn(base, email) {
    await post(base, '/api/auth/start', { email });
    const emails = (await (await admin(base, `/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).json()).emails;
    const token = emails.at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post(base, '/api/auth/verify', { token });
    const userId = (await (await admin(base, `/api/admin/accounts/lookup?email=${encodeURIComponent(email)}`)).json()).user.id;
    return { cookie: r.headers.get('set-cookie').split(';')[0], userId };
}
const webhook = (event, { sig, t } = {}) => {
    const body = JSON.stringify(event);
    return fetch(BASE + '/api/stripe/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig ?? signStripe(WHSEC, body, t) } });
};
let evN = 0;
const event = (type, object) => ({ id: `evt_${run}_${++evN}`, object: 'event', type, data: { object } });
const sub = (id, calendarId, userId, status, interval = 'year') => ({
    id, object: 'subscription', status, customer: `cus_${run}`, metadata: { calendar_id: calendarId, user_id: userId },
    items: { data: [{ current_period_end: 1830000000, price: { id: interval === 'year' ? 'price_fake_yearly' : 'price_fake_monthly', recurring: { interval } } }] },
});
const lockCalls = (id) => fake.log.filter((l) => l.path.startsWith(`/lockfake/cal/${id}/`) && !l.path.endsWith('lock-status'));
const me = async (cookie) => (await fetch(BASE + '/api/me', { headers: { Cookie: cookie } })).json();
const status = async (id, cookie) => (await fetch(`${BASE}/api/pro/status?calendar=${encodeURIComponent(id)}`, { headers: cookie ? { Cookie: cookie } : {} })).json();

try {
    // --- No keys: everything billing answers 503, nothing reaches Stripe.
    const nk = await signIn(NOKEYS, `nokeys-${run}@example.com`);
    let r = await post(NOKEYS, '/api/pro/checkout', { calendarId: 'anything' }, nk.cookie);
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'billing-not-configured' });
    assert.equal((await post(NOKEYS, '/api/pro/portal', {}, nk.cookie)).status, 503);
    r = await fetch(NOKEYS + '/api/stripe/webhook', { method: 'POST', body: '{}', headers: { 'Stripe-Signature': signStripe(WHSEC, '{}') } });
    assert.equal(r.status, 503);
    step('without Stripe keys, checkout, portal and the webhook answer 503 billing-not-configured');

    // --- Checkout
    const ann = await signIn(BASE, `ann-${run}@example.com`);
    const cal = `Team ${run}`;            // a real-looking name with a space: no client_reference_id
    fake.addCalendar(cal);
    assert.equal((await post(BASE, '/api/pro/checkout', { calendarId: cal })).status, 401);
    step('checkout without a session is 401');

    r = await post(BASE, '/api/pro/checkout', { calendarId: cal, interval: 'week' }, ann.cookie);
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'bad-interval');
    r = await post(BASE, '/api/pro/checkout', { calendarId: `missing-${run}` }, ann.cookie);
    assert.equal(r.status, 404);
    step('checkout refuses an unknown interval (400) and a calendar that does not exist (404)');

    const before = fake.log.length;
    r = await post(BASE, '/api/pro/checkout', { calendarId: cal, editName: `team-${run}` }, ann.cookie);
    assert.equal(r.status, 200); assert.match((await r.json()).url, /^https:\/\/checkout\.stripe\.test\//);
    const cs = fake.log.slice(before).find((l) => l.path === '/stripe/v1/checkout/sessions');
    assert.equal(cs.auth, 'Bearer fake-stripe-key');
    assert.equal(cs.body.mode, 'subscription');
    assert.equal(cs.body['line_items[0][price]'], 'price_fake_yearly'); assert.equal(cs.body['line_items[0][quantity]'], '1');
    assert.equal(cs.body.customer_email, `ann-${run}@example.com`);
    assert.equal(cs.body['metadata[calendar_id]'], cal); assert.equal(cs.body['metadata[user_id]'], ann.userId);
    assert.equal(cs.body['subscription_data[metadata][calendar_id]'], cal); assert.equal(cs.body['subscription_data[metadata][user_id]'], ann.userId);
    assert.equal(cs.body.success_url, `https://pastecal.com/pro/done?session_id={CHECKOUT_SESSION_ID}#${encodeURIComponent(cal)}`);
    assert.equal(cs.body.cancel_url, `https://pastecal.com/team-${run}`);
    assert.equal(cs.body.client_reference_id, undefined);
    assert.ok(!Object.keys(cs.body).some((k) => k.includes('trial')), 'no free trial');
    step('checkout (default yearly): subscription mode, the yearly price, metadata on session and subscription, literal {CHECKOUT_SESSION_ID}, no trial');

    const plainCal = `plain-${run}`; fake.addCalendar(plainCal);
    const b2 = fake.log.length;
    r = await post(BASE, '/api/pro/checkout', { calendarId: plainCal, interval: 'month' }, ann.cookie);
    assert.equal(r.status, 200);
    const cs2 = fake.log.slice(b2).find((l) => l.path === '/stripe/v1/checkout/sessions');
    assert.equal(cs2.body['line_items[0][price]'], 'price_fake_monthly'); assert.equal(cs2.body.client_reference_id, plainCal);
    step('checkout interval "month" uses the monthly price');

    // --- Webhook signatures
    const ev1 = event('customer.subscription.created', { id: `sub_${run}_a` });
    fake.subs.set(`sub_${run}_a`, sub(`sub_${run}_a`, cal, ann.userId, 'active'));
    assert.equal((await webhook(ev1, { sig: signStripe('wrong-secret', JSON.stringify(ev1)) })).status, 400);
    assert.equal((await webhook(ev1, { sig: '' })).status, 400);
    assert.equal((await webhook(ev1, { sig: 't=abc,v1=00' })).status, 400);
    r = await webhook(ev1, { t: Math.floor(Date.now() / 1000) - 400 });
    assert.equal(r.status, 400); assert.equal((await r.json()).reason, 'stale timestamp');
    assert.equal(lockCalls(cal).length, 0);
    step('webhook: a wrong, missing or malformed signature, or a timestamp over 5 minutes old, is 400 and does nothing');

    r = await webhook(ev1);
    assert.equal(r.status, 200);
    assert.equal(fake.cals.get(cal).locked, true); assert.equal(fake.cals.get(cal).ownerId, ann.userId);
    let mine = await me(ann.cookie);
    assert.deepEqual(mine.calendars, [{ id: cal, status: 'active', plan: 'pro', interval: 'year', priceId: 'price_fake_yearly', currentPeriodEnd: 1830000000 }]);
    step('a signed subscription.created locks the calendar for its owner; /api/me lists it with status and interval');

    const calls = lockCalls(cal).length;
    r = await webhook(ev1);
    assert.equal(r.status, 200); assert.equal((await r.json()).duplicate, true);
    assert.equal(lockCalls(cal).length, calls);
    r = await webhook(event('customer.subscription.updated', { id: `sub_${run}_a` }));
    assert.equal(r.status, 200); assert.equal(lockCalls(cal).length, calls, 'already locked by the owner: no new lock (no new key)');
    step('a replayed event id is a no-op; a repeat update for a locked calendar changes nothing');

    // --- Status, editor key, portal
    const s1 = await status(cal, ann.cookie);
    assert.deepEqual(s1, { locked: true, pro: true, isOwner: true });
    const s2 = await status(cal);
    assert.deepEqual(s2, { locked: true, pro: true, isOwner: false });
    assert.deepEqual(Object.keys(s2).sort(), ['isOwner', 'locked', 'pro']);
    assert.deepEqual(await status(`missing-${run}`), { locked: false, pro: false, isOwner: false });
    step('status says {locked, pro, isOwner} and nothing else (no owner id, no key)');

    const bob = await signIn(BASE, `bob-${run}@example.com`);
    assert.equal((await post(BASE, '/api/pro/editor-key', { calendarId: cal })).status, 401);
    assert.equal((await post(BASE, '/api/pro/editor-key', { calendarId: cal }, bob.cookie)).status, 403);
    r = await post(BASE, '/api/pro/editor-key', { calendarId: cal }, ann.cookie);
    assert.equal(r.status, 200);
    const { editorKey } = await r.json();
    assert.equal(editorKey, fake.cals.get(cal).editorKey);
    r = await post(BASE, '/api/pro/checkout', { calendarId: cal }, bob.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'locked-by-other');
    step('editor key: only the owner gets a fresh one; checkout on someone else\'s Pro calendar is 409');

    assert.equal((await post(BASE, '/api/pro/portal', {})).status, 401);
    assert.equal((await post(BASE, '/api/pro/portal', {}, bob.cookie)).status, 404);
    const b3 = fake.log.length;
    r = await post(BASE, '/api/pro/portal', { calendarId: cal }, ann.cookie);
    assert.equal(r.status, 200); assert.equal((await r.json()).url, 'https://billing.stripe.test/p/session');
    const ps = fake.log.slice(b3).find((l) => l.path === '/stripe/v1/billing_portal/sessions');
    assert.equal(ps.body.customer, `cus_${run}`); assert.equal(ps.body.return_url, `https://pastecal.com/${encodeURIComponent(cal)}`);
    r = await post(BASE, '/api/pro/checkout', { calendarId: plainCal }, ann.cookie);
    const cs3 = fake.log.at(-1);
    assert.equal(cs3.body.customer, `cus_${run}`); assert.equal(cs3.body.customer_email, undefined);
    step('portal needs a session and a Stripe customer; a returning customer checks out as that customer');

    // --- Out of order: deleted arrives before created. Stripe says canceled now, so it stays unlocked.
    const cal2 = `late-${run}`; fake.addCalendar(cal2);
    fake.subs.set(`sub_${run}_b`, sub(`sub_${run}_b`, cal2, ann.userId, 'canceled', 'month'));
    assert.equal((await webhook(event('customer.subscription.deleted', { id: `sub_${run}_b` }))).status, 200);
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_b`, status: 'active' }))).status, 200);
    assert.equal((await webhook(event('checkout.session.completed', { id: 'cs_x', subscription: `sub_${run}_b` }))).status, 200);
    assert.equal(fake.cals.get(cal2).locked, false); assert.equal(lockCalls(cal2).length, 0);
    mine = await me(ann.cookie);
    assert.equal(mine.calendars.find((c) => c.id === cal2).status, 'canceled');
    assert.equal(mine.calendars.find((c) => c.id === cal2).interval, 'month');
    step('out of order (deleted, then created and checkout.completed): acts on the current status, stays unlocked');

    // --- The lock API failing: 500 so Stripe retries, and the event is not marked as done.
    const cal3 = `retry-${run}`; fake.addCalendar(cal3);
    fake.subs.set(`sub_${run}_c`, sub(`sub_${run}_c`, cal3, bob.userId, 'active', 'month'));
    const ev3 = event('checkout.session.completed', { id: 'cs_y', subscription: `sub_${run}_c` });
    fake.hooks.lockFails = 1;
    assert.equal((await webhook(ev3)).status, 500);
    assert.equal(fake.cals.get(cal3).locked, false);
    r = await webhook(ev3);
    assert.equal(r.status, 200); assert.equal((await r.json()).duplicate, undefined);
    assert.equal(fake.cals.get(cal3).ownerId, bob.userId);
    step('if the calendar cannot be reached the webhook is 500 and the same event succeeds on retry');

    // --- invoice.payment_failed (newer API shape) only refreshes; cancel unlocks.
    fake.subs.get(`sub_${run}_a`).status = 'past_due';
    r = await webhook(event('invoice.payment_failed', { id: 'in_1', parent: { subscription_details: { subscription: `sub_${run}_a` } } }));
    assert.equal(r.status, 200); assert.equal(fake.cals.get(cal).locked, true);
    assert.equal((await me(ann.cookie)).calendars.find((c) => c.id === cal).status, 'past_due');
    fake.subs.get(`sub_${run}_a`).status = 'canceled';
    assert.equal((await webhook(event('customer.subscription.deleted', { id: `sub_${run}_a` }))).status, 200);
    assert.equal(fake.cals.get(cal).locked, false);
    assert.deepEqual(await status(cal, ann.cookie), { locked: false, pro: false, isOwner: false });
    step('a failed payment keeps the lock (past_due); cancellation unlocks');

    // --- Support: reassign a paid calendar to another email.
    const newOwner = `cara-${run}@example.com`;
    assert.equal((await fetch(BASE + '/api/admin/accounts/reassign', { method: 'POST', body: '{}' })).status, 403);
    r = await admin(BASE, '/api/admin/accounts/reassign', { method: 'POST', body: JSON.stringify({ calendarId: cal3, email: newOwner }) });
    assert.equal(r.status, 200);
    const re = await r.json();
    assert.equal(re.relocked, true); assert.ok(!('editorKey' in re));
    assert.equal(fake.cals.get(cal3).ownerId, re.userId);
    const cara = await signIn(BASE, newOwner);
    assert.equal(cara.userId, re.userId);
    assert.equal((await me(cara.cookie)).calendars[0].id, cal3);
    assert.deepEqual((await me(bob.cookie)).calendars, []);
    // A later Stripe event still carries bob's id in metadata; our row wins.
    assert.equal((await webhook(event('customer.subscription.updated', { id: `sub_${run}_c` }))).status, 200);
    assert.equal(fake.cals.get(cal3).ownerId, re.userId);
    step('admin reassign moves the subscription and the lock to the new email, and later events keep it there');
} finally {
    fake.close();
}
console.log(`\n${n} checks passed`); process.exit(0);
