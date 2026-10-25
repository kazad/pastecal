// Pro Unlimited: one subscription per account that locks any number of its owner's calendars, against
// REAL calendar rooms (no LOCK_API_BASE) and fake Stripe (test/fake-stripe.mjs on FAKE_PORT, default 8832).
// One `wrangler dev`, from cloudflare/, fake values only (nothing in .dev.vars is needed):
//   node node_modules/.bin/wrangler dev --port 8827 --inspector-port 9247 --persist-to /tmp/pc-unlimited-state \
//     --var COPY_BACK: --var FIREBASE_DB_URL: --var IMPORT_SECRET:dev-secret --var ACCOUNTS_DEV_MODE:1 \
//     --var STRIPE_SECRET_KEY:fake-stripe-key --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret \
//     --var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly \
//     --var STRIPE_PRICE_UNLIMITED_YEARLY:price_fake_unl_yearly --var STRIPE_PRICE_UNLIMITED_MONTHLY:price_fake_unl_monthly \
//     --var STRIPE_API_BASE:http://127.0.0.1:8832/stripe
//   BASE=http://localhost:8827 node test/unlimited.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startFakeStripe, signStripe } from './fake-stripe.mjs';

const BASE = process.env.BASE || 'http://localhost:8827', SECRET = process.env.IMPORT_SECRET || 'dev-secret', WHSEC = 'fake-webhook-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const fake = await startFakeStripe(Number(process.env.FAKE_PORT || 8832));
let ip = 0;

const post = (path, body, cookie) => fetch(BASE + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': `10.50.${Math.floor(++ip / 200)}.${ip % 200}`, ...(cookie ? { Cookie: cookie } : {}) },
});
const admin = (path, init = {}) => fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } });
const outbox = async (email) => (await (await admin(`/api/admin/accounts/outbox?email=${enc(email)}`)).json()).emails;
const userIdOf = async (email) => (await (await admin(`/api/admin/accounts/lookup?email=${enc(email)}`)).json()).user.id;
async function signIn(email) {
    await post('/api/auth/start', { email });
    const token = (await outbox(email)).at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    return { cookie: r.headers.get('set-cookie').split(';')[0], userId: await userIdOf(email), email };
}
const status = async (id, cookie) => (await fetch(`${BASE}/api/pro/status?calendar=${enc(id)}`, { headers: cookie ? { Cookie: cookie } : {} })).json();
const me = async (cookie) => (await fetch(BASE + '/api/me', { headers: { Cookie: cookie } })).json();
const lockStatus = async (id) => (await admin(`/api/admin/cal/${enc(id)}/lock-status`)).json();
const webhook = (event) => {
    const body = JSON.stringify(event);
    return fetch(BASE + '/api/stripe/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) } });
};
let evN = 0;
const event = (type, object, id) => ({ id: id || `evt_unl_${run}_${++evN}`, object: 'event', type, data: { object } });
async function createCalendar(id) {
    const r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: `Team ${id}`, options: {}, events: [] }) });
    assert.equal(r.status, 201, await r.text());
}
const now = () => Math.floor(Date.now() / 1000);
// A subscription the way Stripe would have it after a paid Checkout.
const paidSub = (id, { customer, metadata, price, created = now() }) => ({ id, object: 'subscription', status: 'active', customer, metadata, created,
    items: { data: [{ current_period_end: 1830000000, price: { id: price, recurring: { interval: /monthly/.test(price) ? 'month' : 'year' } } }] } });
const lastCheckout = () => fake.log.filter((l) => l.path === '/stripe/v1/checkout/sessions').at(-1);

try {
    const [c1, c2, c3, c4] = [1, 2, 3, 4].map((i) => `unl${i}-${run}`);
    for (const c of [c1, c2, c3, c4]) await createCalendar(c);
    const ann = await signIn(`ann-unl-${run}@example.com`);

    // --- With both Unlimited prices set, the site may sell it (/api/pro/config).
    assert.deepEqual(await (await fetch(BASE + '/api/pro/config')).json(), { billing: true, unlimited: true });

    // --- Checkout: plan + interval; bought from c1, which it locks once active.
    assert.equal((await post('/api/pro/checkout', { plan: 'teams', interval: 'year' }, ann.cookie)).status, 400, 'unknown plan');
    let r = await post('/api/pro/checkout', { plan: 'unlimited', interval: 'year', calendarId: c1 }, ann.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    let cs = lastCheckout();
    assert.equal(cs.body['line_items[0][price]'], 'price_fake_unl_yearly');
    assert.equal(cs.body['metadata[plan]'], 'unlimited'); assert.equal(cs.body['subscription_data[metadata][plan]'], 'unlimited');
    assert.equal(cs.body['subscription_data[metadata][user_id]'], ann.userId);
    assert.equal(cs.body['subscription_data[metadata][lock_calendar]'], c1);
    assert.equal(cs.body['subscription_data[metadata][calendar_id]'], undefined, 'the subscription belongs to the account, not one calendar');
    assert.match(cs.body.success_url, /\/pro\/done\?session_id=\{CHECKOUT_SESSION_ID\}&plan=unlimited#/);
    r = await post('/api/pro/checkout', { plan: 'unlimited', interval: 'month' }, ann.cookie);
    assert.equal(r.status, 200, 'restart, and from the pricing page no calendar is needed');
    cs = lastCheckout();
    assert.equal(cs.body['line_items[0][price]'], 'price_fake_unl_monthly'); assert.equal(cs.body['subscription_data[metadata][lock_calendar]'], undefined);
    assert.match(cs.body.cancel_url, /\/pricing$/);
    step('checkout {plan:\'unlimited\', interval}: the Unlimited price, metadata plan=unlimited + user, no calendar_id (lock_calendar when bought from one)');

    const unlA = `sub_unl_${run}_ann`;
    fake.subs.set(unlA, paidSub(unlA, { customer: `cus_${run}_ann`, price: 'price_fake_unl_yearly', metadata: { plan: 'unlimited', user_id: ann.userId, lock_calendar: c1 } }));
    const created = event('checkout.session.completed', { id: 'cs_x', subscription: unlA });
    assert.equal((await webhook(created)).status, 200);
    let st = await status(c1, ann.cookie);
    assert.deepEqual([st.locked, st.isOwner, st.plan, st.unlimited], [true, true, 'unlimited', true]);
    const mails = await outbox(ann.email);
    assert.ok(mails.some((m) => /^Pro is on for /.test(m.subject)), 'the calendar it was bought from: its welcome');
    const hello = mails.filter((m) => m.subject === 'Pro is on: claim your @name');
    assert.equal(hello.length, 1, 'one Pro welcome');
    assert.ok(hello[0].text.includes('https://pastecal.com/account') || /\/account\n/.test(hello[0].text), hello[0].text);
    assert.match(hello[0].text, /view-only calendar/);
    assert.equal((await webhook(created)).status, 200);
    assert.equal((await outbox(ann.email)).filter((m) => m.subject === 'Pro is on: claim your @name').length, 1, 'a replayed event sends no second welcome');
    step('webhook: the Unlimited subscription is active; the calendar it was bought from is locked for its owner (its welcome email), and one "Pro is on: claim your @name" email links to /account (not again on a replay)');

    // --- Lock 3 calendars without another checkout.
    const csBefore = fake.log.filter((l) => l.path === '/stripe/v1/checkout/sessions').length, logBefore = fake.log.length;
    st = await status(c2, ann.cookie);
    assert.deepEqual([st.locked, st.unlimited], [false, true], 'status tells the owner they can lock it with one click');
    for (const c of [c2, c3]) {
        r = await post('/api/pro/lock', { calendarId: c }, ann.cookie);
        assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    }
    assert.deepEqual(await (await post('/api/pro/lock', { calendarId: c2 }, ann.cookie)).json(), { ok: true, already: true });
    assert.equal(fake.log.filter((l) => l.path === '/stripe/v1/checkout/sessions').length, csBefore, 'no checkout');
    assert.equal(fake.log.slice(logBefore).filter((l) => l.method !== 'GET').length, 0, 'nothing sent to Stripe at all');
    for (const c of [c1, c2, c3]) {
        st = await status(c, ann.cookie);
        assert.deepEqual([st.locked, st.isOwner, st.plan], [true, true, 'unlimited'], c);
    }
    let m = await me(ann.cookie);
    assert.equal(m.plan, 'unlimited'); assert.equal(m.unlimited.status, 'active'); assert.equal(m.unlimited.interval, 'year');
    assert.deepEqual(m.calendars.map((c) => [c.id, c.plan, c.status]).sort(), [c1, c2, c3].map((c) => [c, 'unlimited', 'active']).sort());
    assert.equal((await post('/api/pro/lock', { calendarId: `nope-${run}` }, ann.cookie)).status, 404);
    step('POST /api/pro/lock: 3 calendars locked under one Unlimited, no checkout, nothing sent to Stripe; /api/me lists plan unlimited + the 3');

    // --- Nobody else can use Ann's subscription.
    const bob = await signIn(`bob-unl-${run}@example.com`);
    assert.equal((await post('/api/pro/lock', { calendarId: c4 })).status, 401, 'signed out');
    r = await post('/api/pro/lock', { calendarId: c4 }, bob.cookie);
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'no-unlimited');
    assert.equal((await post('/api/pro/lock', { calendarId: c4, userId: ann.userId, subscriptionId: unlA }, bob.cookie)).status, 403, 'ids in the body mean nothing');
    assert.equal((await post('/api/pro/unlock', { calendarId: c2 }, bob.cookie)).status, 409, 'nor release her calendar');
    assert.equal((await lockStatus(c4)).locked, false);
    assert.equal((await status(c4, bob.cookie)).unlimited, undefined);
    // Bob with his own Unlimited still can't take hers.
    const unlB = `sub_unl_${run}_bob`;
    fake.subs.set(unlB, paidSub(unlB, { customer: `cus_${run}_bob`, price: 'price_fake_unl_monthly', metadata: { plan: 'unlimited', user_id: bob.userId } }));
    await webhook(event('customer.subscription.created', { id: unlB }));
    r = await post('/api/pro/lock', { calendarId: c2 }, bob.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'locked-by-other');
    assert.equal((await lockStatus(c2)).ownerId, ann.userId);
    step('someone else can\'t lock through your subscription: signed out 401, no Unlimited 403 (body ids ignored), their own Unlimited 409 on yours');

    // --- Webhook idempotency: the same event twice, and replays under new ids, change nothing.
    const lockedAt = (await lockStatus(c1)).lockedAt, refunds0 = fake.refunds.length;
    let j = await (await webhook(created)).json();
    assert.equal(j.duplicate, true);
    // Release c1 (the calendar the checkout came from) and c3, then replay: neither is locked again.
    for (const c of [c1, c3]) assert.deepEqual(await (await post('/api/pro/unlock', { calendarId: c }, ann.cookie)).json(), { ok: true });
    assert.equal((await lockStatus(c1)).locked, false); assert.equal((await status(c1)).paused, false, 'released: a free calendar, not paused');
    for (const type of ['customer.subscription.updated', 'checkout.session.completed', 'customer.subscription.created']) {
        assert.equal((await webhook(event(type, type.startsWith('checkout') ? { subscription: unlA } : { id: unlA }))).status, 200);
    }
    assert.equal((await lockStatus(c1)).locked, false, 'a renewal never re-locks the calendar it was bought from');
    assert.equal((await lockStatus(c3)).locked, false);
    assert.equal((await lockStatus(c2)).locked, true);
    assert.equal(fake.refunds.length, refunds0, 'no refunds');
    for (const c of [c1, c3]) assert.equal((await post('/api/pro/lock', { calendarId: c }, ann.cookie)).status, 200);
    assert.notEqual((await lockStatus(c1)).lockedAt, lockedAt);
    step('webhook idempotency: a repeated event is a duplicate; replays under new ids re-lock nothing (released calendars stay free) and refund nothing; unlock/relock work');

    // --- A second Unlimited for the same person is refused, and refunded if it got paid anyway.
    assert.equal((await post('/api/pro/checkout', { plan: 'unlimited', interval: 'year' }, ann.cookie)).status, 409);
    const dup = `sub_unl_${run}_ann_dup`;
    fake.subs.set(dup, paidSub(dup, { customer: `cus_${run}_ann`, price: 'price_fake_unl_yearly', created: now() + 10, metadata: { plan: 'unlimited', user_id: ann.userId } }));
    await webhook(event('customer.subscription.created', { id: dup }));
    assert.equal(fake.subs.get(dup).status, 'canceled', 'the later one is canceled (refunded as a duplicate)');
    assert.equal(fake.subs.get(unlA).status, 'active');
    assert.equal((await me(ann.cookie)).plan, 'unlimited');
    // Single checkout and the trial are refused while Unlimited is active.
    r = await post('/api/pro/checkout', { calendarId: c4, interval: 'year' }, ann.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'has-unlimited');
    r = await post('/api/pro/trial', { calendarId: c4 }, ann.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'has-unlimited');
    step('a second Unlimited checkout is 409 (a paid duplicate is refunded); a Single checkout or a trial is 409 has-unlimited');

    // --- Cancel: all 3 fall back like a Single that ended (paused, read-only).
    fake.subs.get(unlA).status = 'canceled';
    const del = event('customer.subscription.deleted', { id: unlA });
    assert.equal((await webhook(del)).status, 200);
    for (const c of [c1, c2, c3]) {
        st = await status(c, ann.cookie);
        assert.deepEqual([st.locked, st.paused, st.lapsedOwner, st.isOwner], [false, true, true, false], c);
    }
    st = await status(c2);
    assert.deepEqual([st.paused, st.lapsedOwner], [true, false]);
    m = await me(ann.cookie);
    assert.equal(m.plan, null); assert.equal(m.unlimited.status, 'canceled'); assert.deepEqual(m.calendars, []);
    assert.equal((await post('/api/pro/lock', { calendarId: c4 }, ann.cookie)).status, 403, 'no Unlimited any more');
    assert.equal((await webhook(event('customer.subscription.deleted', { id: unlA }))).status, 200, 'replayed cancel');
    assert.equal((await status(c1, ann.cookie)).paused, true);
    // Health check sees nothing out of place.
    const h = await (await admin('/api/admin/pro/health')).json();
    const mine = h.mismatches.filter((x) => [c1, c2, c3].includes(x.calendarId));
    assert.deepEqual(mine, []);
    step('cancel: all 3 calendars fall back read-only (paused for their owner), /api/me shows no plan, replays are harmless, health has no mismatches');

    // --- Upgrade from Single: the calendar moves under Unlimited, the Single is canceled with proration.
    const cara = await signIn(`cara-unl-${run}@example.com`);
    const c5 = `unl5-${run}`; await createCalendar(c5);
    const single = `sub_single_${run}_cara`;
    fake.subs.set(single, paidSub(single, { customer: `cus_${run}_cara`, price: 'price_fake_yearly', metadata: { calendar_id: c5, user_id: cara.userId } }));
    await webhook(event('customer.subscription.created', { id: single }));
    st = await status(c5, cara.cookie);
    assert.deepEqual([st.isOwner, st.plan, st.unlimited], [true, 'single', undefined]);
    assert.equal((await me(cara.cookie)).plan, 'single');
    r = await post('/api/pro/checkout', { plan: 'unlimited', interval: 'year', calendarId: c5 }, cara.cookie);
    assert.equal(r.status, 200);
    cs = lastCheckout();
    assert.equal(cs.body.customer, `cus_${run}_cara`, 'billed to the Single\'s customer, where the credit lands');
    assert.match(cs.body['custom_text[submit][message]'], /move to it, and their unused time is credited/);
    const unlC = `sub_unl_${run}_cara`, b0 = fake.log.length;
    fake.subs.set(unlC, paidSub(unlC, { customer: `cus_${run}_cara`, price: 'price_fake_unl_yearly', metadata: { plan: 'unlimited', user_id: cara.userId, lock_calendar: c5 } }));
    await webhook(event('checkout.session.completed', { subscription: unlC }));
    const cancel = fake.log.slice(b0).filter((l) => l.method === 'DELETE' && l.path === `/stripe/v1/subscriptions/${single}`);
    assert.equal(cancel.length, 1);
    assert.equal(cancel[0].body.prorate, 'true'); assert.equal(cancel[0].body.invoice_now, 'true');
    assert.equal(cancel[0].idem, `upgrade-cancel-${single}`);
    assert.equal(fake.subs.get(single).status, 'canceled');
    st = await status(c5, cara.cookie);
    assert.deepEqual([st.locked, st.isOwner, st.plan, st.paused], [true, true, 'unlimited', false], 'still locked, never unlocked in between');
    m = await me(cara.cookie);
    assert.equal(m.plan, 'unlimited'); assert.deepEqual(m.calendars.map((c) => [c.id, c.plan]), [[c5, 'unlimited']]);
    // The Single's own deleted event arrives later: nothing unlocks.
    await webhook(event('customer.subscription.deleted', { id: single }));
    assert.equal((await status(c5, cara.cookie)).isOwner, true);
    assert.equal(fake.refunds.filter((x) => x.metadata && x.metadata.subscription === single).length, 0, 'credited by Stripe, not refunded');
    step('upgrade from Single: the calendar moves under Unlimited, the Single is canceled with prorate+invoice_now (Stripe credits it), the lock never drops');

    // A trial upgrades too: canceled plainly (nothing charged), the calendar stays locked.
    const dan = await signIn(`dan-unl-${run}@example.com`);
    const c6 = `unl6-${run}`; await createCalendar(c6);
    assert.equal((await post('/api/pro/trial', { calendarId: c6 }, dan.cookie)).status, 200);
    const trialSub = [...fake.subs.values()].find((x) => x.metadata.calendar_id === c6);
    const unlD = `sub_unl_${run}_dan`, b1 = fake.log.length;
    fake.subs.set(unlD, paidSub(unlD, { customer: `cus_${run}_dan`, price: 'price_fake_unl_monthly', metadata: { plan: 'unlimited', user_id: dan.userId } }));
    await webhook(event('customer.subscription.created', { id: unlD }));
    const tc = fake.log.slice(b1).find((l) => l.method === 'DELETE' && l.path === `/stripe/v1/subscriptions/${trialSub.id}`);
    assert.ok(tc); assert.equal(tc.body, null, 'a trial is canceled without proration');
    st = await status(c6, dan.cookie);
    assert.deepEqual([st.isOwner, st.plan, st.trial], [true, 'unlimited', undefined]);
    step('a trial upgrades the same way: canceled without proration, the calendar stays locked under Unlimited');

    // --- Pay first: Unlimited bought signed out from the pricing page (no calendar).
    r = await post('/api/pro/checkout', { plan: 'unlimited', interval: 'year' });
    assert.equal(r.status, 200);
    const claimCookie = r.headers.getSetCookie().find((c) => c.startsWith('pc_claim=')).split(';')[0];
    const claimHash = crypto.createHash('sha256').update(claimCookie.slice('pc_claim='.length)).digest('base64url');
    cs = lastCheckout();
    assert.equal(cs.body['subscription_data[metadata][claim]'], claimHash); assert.equal(cs.body['subscription_data[metadata][user_id]'], undefined);
    const eve = `eve-unl-${run}@example.com`, unlE = `sub_unl_${run}_eve`;
    fake.customers.set(`cus_${run}_eve`, { id: `cus_${run}_eve`, object: 'customer', email: eve });
    fake.subs.set(unlE, paidSub(unlE, { customer: `cus_${run}_eve`, price: 'price_fake_unl_yearly', metadata: { plan: 'unlimited', claim: claimHash } }));
    await webhook(event('customer.subscription.created', { id: unlE }));
    const sess = [...fake.sessions.values()].filter((x) => x.metadata.claim === claimHash).at(-1);
    Object.assign(sess, { status: 'complete', payment_status: 'paid', customer_details: { email: eve } });
    r = await post('/api/pro/claim', { sessionId: sess.id }, claimCookie);
    assert.equal(r.status, 200);
    const eveCookie = r.headers.getSetCookie().find((c) => c.startsWith('pc_session=')).split(';')[0];
    assert.equal((await me(eveCookie)).plan, 'unlimited');
    assert.equal((await post('/api/pro/lock', { calendarId: c4 }, eveCookie)).status, 200);
    step('pay first: Unlimited bought signed out (no calendar) makes the account from the email typed at Stripe; /pro/done\'s claim signs in; it locks at once');

    console.log(`\n${n} checks passed`);
} finally {
    fake.close();
}
