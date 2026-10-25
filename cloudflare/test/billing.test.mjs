// Pro billing: Checkout, the Stripe webhook, editor keys, the Billing Portal, /api/pro/status,
// support reassign. Two `wrangler dev` instances (ACCOUNTS_DEV_MODE=1 and LOCK_API_BASE from .dev.vars):
//   BASE (8822)        with fake Stripe vars: STRIPE_SECRET_KEY:fake-stripe-key STRIPE_WEBHOOK_SECRET:fake-webhook-secret
//                      STRIPE_PRICE_PRO_YEARLY:price_fake_yearly STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly
//                      STRIPE_API_BASE:http://127.0.0.1:8832/stripe
//   NOKEYS_BASE (8823) with no Stripe vars at all
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
//   TESTKEY_BASE (8824): a test-mode key WITHOUT dev mode (pass --var ACCOUNTS_DEV_MODE:0 if .dev.vars sets it):
//   node node_modules/.bin/wrangler dev --port 8824 --inspector-port 9243 --persist-to /tmp/pc-billing-state-testkey --var COPY_BACK: \
//     --var ACCOUNTS_DEV_MODE:0 --var STRIPE_SECRET_KEY:sk_test_fake --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret
//   node test/accounts.test.mjs && node test/billing.test.mjs
// This file runs the fake Stripe + fake lock API on 8832 (test/fake-stripe.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startFakeStripe, signStripe } from './fake-stripe.mjs';
const BASE = process.env.BASE || 'http://localhost:8822', NOKEYS = process.env.NOKEYS_BASE || 'http://localhost:8823';
const TESTKEY = process.env.TESTKEY_BASE || 'http://localhost:8824';
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
const lockCalls = (id) => fake.log.filter((l) => l.path.startsWith(`/lockfake/cal/${id}/`) && !l.path.endsWith('lock-status') && !l.path.endsWith('editor-of-record'));   // reads, not lock changes
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
    // /api/pro/config tells the site which Pro offer to show: the trial and checkout, or "Join the Pro beta".
    assert.deepEqual(await (await fetch(NOKEYS + '/api/pro/config')).json(), { billing: false, unlimited: false });
    assert.deepEqual(await (await fetch(BASE + '/api/pro/config')).json(), { billing: true, unlimited: false });
    assert.equal((await post(BASE, '/api/pro/config', {}, nk.cookie)).status, 405);
    step('/api/pro/config: billing true with Stripe keys and the yearly price, false without');

    // --- Checkout
    const ann = await signIn(BASE, `ann-${run}@example.com`);
    const cal = `Team ${run}`;            // a real-looking name with a space: no client_reference_id
    fake.addCalendar(cal);

    // --- Pay first: checkout while signed out, then /pro/done claims it from the same browser.
    const sha = (v) => crypto.createHash('sha256').update(v).digest('base64url');
    const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(name + '=')) || '').split(';')[0];
    const anonCal = `anon-${run}`; fake.addCalendar(anonCal);
    let b0 = fake.log.length;
    r = await post(BASE, '/api/pro/checkout', { calendarId: anonCal });
    assert.equal(r.status, 200, 'signed out may check out');
    const claimSet = r.headers.getSetCookie().find((c) => c.startsWith('pc_claim='));
    assert.match(claimSet, /HttpOnly/); assert.match(claimSet, /Secure/); assert.match(claimSet, /SameSite=Lax/);
    const claimCookie = claimSet.split(';')[0], claim = claimCookie.slice('pc_claim='.length);
    let csA = fake.log.slice(b0).find((l) => l.path === '/stripe/v1/checkout/sessions');
    assert.equal(csA.body['metadata[claim]'], sha(claim), 'Stripe gets only the hash of the browser token');
    assert.equal(csA.body['subscription_data[metadata][claim]'], sha(claim));
    assert.equal(csA.body['metadata[user_id]'], undefined); assert.equal(csA.body.customer_email, undefined); assert.equal(csA.body.customer, undefined);
    assert.equal(csA.body['payment_method_types[0]'], 'card');
    assert.ok(!JSON.stringify(csA.body).includes(claim), 'the token itself never leaves');
    r = await post(BASE, '/api/pro/checkout', { calendarId: anonCal }, claimCookie);
    assert.equal(r.status, 200, 'the same browser may restart its checkout');
    assert.equal((await post(BASE, '/api/pro/checkout', { calendarId: anonCal })).status, 200, 'a signed-out checkout never blocks another buyer');
    step('pay first: signed-out checkout sets an HttpOnly claim cookie; Stripe sees only its hash, no email or user; card only; it holds nobody back');

    const anonSess = [...fake.sessions.values()].filter((x) => x.metadata.claim === sha(claim)).at(-1);
    const buyer = `buyer-${run}@example.com`;
    const claimIt = (cookie, id = anonSess.id) => post(BASE, '/api/pro/claim', { sessionId: id }, cookie);
    assert.equal((await claimIt(null)).status, 403, 'no claim cookie');
    assert.equal((await claimIt(claimCookie)).status, 403, 'not paid yet');
    Object.assign(anonSess, { status: 'complete', payment_status: 'paid', customer_details: { email: buyer.toUpperCase() } });
    assert.equal((await claimIt('pc_claim=' + 'A'.repeat(22))).status, 403, 'another browser\'s token');
    assert.equal((await claimIt(claimCookie, 'cs_test_nope')).status, 404);
    r = await claimIt(claimCookie);
    assert.equal(r.status, 200); let cj = await r.json();
    assert.equal(cj.signedIn, true); assert.equal(cj.email, buyer);
    const buyerCookie = cookieOf(r, 'pc_session');
    assert.ok(buyerCookie.length > 20, 'signed in'); assert.equal(cookieOf(r, 'pc_claim'), 'pc_claim=', 'claim cookie cleared');
    assert.equal((await me(buyerCookie)).email, buyer);
    assert.equal((await claimIt(claimCookie)).status, 409, 'single use');
    step('claim: needs this browser\'s token and a paid checkout; signs in the new account once; the token is single-use and cleared');

    // The webhook alone (no claim yet, or ever) still finds the owner by the email typed at Stripe.
    fake.customers.set(`cus_anon_${run}`, { id: `cus_anon_${run}`, object: 'customer', email: buyer });
    fake.subs.set(`sub_${run}_anon`, { ...sub(`sub_${run}_anon`, anonCal, null, 'active'), customer: `cus_anon_${run}`, metadata: { calendar_id: anonCal, claim: sha(claim) } });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_anon` }))).status, 200);
    const buyerId = (await (await admin(BASE, `/api/admin/accounts/lookup?email=${encodeURIComponent(buyer)}`)).json()).user.id;
    assert.equal(fake.cals.get(anonCal).locked, true); assert.equal(fake.cals.get(anonCal).ownerId, buyerId);
    assert.deepEqual((await me(buyerCookie)).calendars.map((c) => c.id), [anonCal]);
    step('webhook: a signed-out checkout\'s subscription locks the calendar for the account of the email typed at Stripe');

    // An email that already has an account is never signed in from a checkout: it gets a sign-in link.
    const anonCal2 = `anon2-${run}`; fake.addCalendar(anonCal2);
    r = await post(BASE, '/api/pro/checkout', { calendarId: anonCal2 });
    const claim2 = cookieOf(r, 'pc_claim'), sess2 = [...fake.sessions.values()].at(-1);
    Object.assign(sess2, { status: 'complete', payment_status: 'paid', customer_details: { email: `ann-${run}@example.com` } });
    const annMails = async () => (await (await admin(BASE, `/api/admin/accounts/outbox?email=${encodeURIComponent(`ann-${run}@example.com`)}`)).json()).emails.length;
    const mailsBefore = await annMails();
    r = await claimIt(claim2, sess2.id);
    assert.equal(r.status, 200); cj = await r.json();
    assert.equal(cj.signedIn, false); assert.equal(cookieOf(r, 'pc_session'), '', 'no session for an existing account');
    assert.equal(await annMails(), mailsBefore + 1, 'a sign-in link went to that email instead');
    step('claim for an email that already has an account: no session, a sign-in link is emailed instead (a typed address can\'t open an account)');

    // Old checkouts can't be claimed.
    const anonCal3 = `anon3-${run}`; fake.addCalendar(anonCal3);
    r = await post(BASE, '/api/pro/checkout', { calendarId: anonCal3 });
    const claim3 = cookieOf(r, 'pc_claim'), sess3 = [...fake.sessions.values()].at(-1);
    Object.assign(sess3, { status: 'complete', payment_status: 'paid', customer_details: { email: `late-${run}@example.com` }, created: Math.floor(Date.now() / 1000) - 3 * 3600 });
    assert.equal((await claimIt(claim3, sess3.id)).status, 403);
    step('a checkout over 2 hours old can\'t be claimed');

    // Someone who typed another person's (new) address: signed out the moment the real owner signs in.
    const anonCal4 = `anon4-${run}`; fake.addCalendar(anonCal4);
    const victim = `victim-${run}@example.com`;
    r = await post(BASE, '/api/pro/checkout', { calendarId: anonCal4 });
    const claim4 = cookieOf(r, 'pc_claim'), sess4 = [...fake.sessions.values()].at(-1);
    Object.assign(sess4, { status: 'complete', payment_status: 'paid', customer_details: { email: victim } });
    const squatter = cookieOf(await claimIt(claim4, sess4.id), 'pc_session');
    assert.equal((await fetch(BASE + '/api/me', { headers: { Cookie: squatter } })).status, 200);
    await signIn(BASE, victim);
    assert.equal((await fetch(BASE + '/api/me', { headers: { Cookie: squatter } })).status, 401, 'the email\'s real owner signing in ends it');
    step('an account made from a typed address is unverified: the first emailed sign-in ends every other session on it');

    // The signed-in path is unchanged: checkout without a session used to be 401, now it is pay first.

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
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'bad-interval');
    assert.equal(fake.log.slice(b2).filter((l) => l.path === '/stripe/v1/checkout/sessions').length, 0, 'no monthly page, even with a monthly price set');
    r = await post(BASE, '/api/pro/checkout', { calendarId: plainCal, interval: 'year' }, ann.cookie);
    assert.equal(r.status, 200);
    const cs2 = fake.log.slice(b2).find((l) => l.path === '/stripe/v1/checkout/sessions');
    assert.equal(cs2.body['line_items[0][price]'], 'price_fake_yearly'); assert.equal(cs2.body.client_reference_id, plainCal);
    step('Plus is yearly only: interval "month" is refused (400 bad-interval) even with a monthly price configured');

    // One buyer at a time: while ann's checkout for plainCal is open, nobody else can start one.
    const holder2 = await signIn(BASE, `bob-hold-${run}@example.com`);
    r = await post(BASE, '/api/pro/checkout', { calendarId: plainCal }, holder2.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'checkout-in-progress');
    const firstPage = [...fake.sessions.values()].at(-1).id;
    r = await post(BASE, '/api/pro/checkout', { calendarId: plainCal }, ann.cookie);
    assert.equal(r.status, 200, 'the same buyer can restart their own checkout');
    assert.equal(fake.sessions.get(firstPage).status, 'expired', 'restarting expires the previous page first');
    const csHold = fake.log.filter((l) => l.path === "/stripe/v1/checkout/sessions").pop();
    const exp = Number(csHold.body.expires_at) * 1000;
    assert.ok(exp > Date.now() + 30 * 60e3 && exp < Date.now() + 32 * 60e3, 'the Stripe page expires with the hold (31 minutes)');
    step('while one person is checking out a calendar, another gets 409 checkout-in-progress; a restart expires the previous page; the page expires in 31 minutes');

    const capCal = `cap-${run}`; fake.addCalendar(capCal);
    for (let i = 0; i < 4; i++) assert.equal((await post(BASE, '/api/pro/checkout', { calendarId: capCal }, ann.cookie)).status, 200, `start + restart ${i}`);
    r = await post(BASE, '/api/pro/checkout', { calendarId: capCal }, ann.cookie);
    assert.equal(r.status, 429); assert.equal((await r.json()).error, 'too-many-checkouts');
    const capPages = fake.log.filter((l) => l.path === '/stripe/v1/checkout/sessions' && l.body['metadata[calendar_id]'] === capCal).length;
    assert.equal(capPages, 4);
    assert.equal([...fake.sessions.values()].filter((x) => x.status === 'open' && [cal, plainCal, capCal].includes(x.metadata.calendar_id)).length, 3, 'one open page per calendar (cal, plainCal, capCal)');
    const blocked = `blocked-${run}`; fake.addCalendar(blocked);
    assert.equal((await post(BASE, '/api/pro/checkout', { calendarId: blocked }, ann.cookie)).status, 200);
    fake.hooks.expireFails = 1;
    r = await post(BASE, '/api/pro/checkout', { calendarId: blocked }, ann.cookie);
    assert.equal(r.status, 409, 'the previous page could not be expired (and is still open): no second page');
    step('restarts: at most 3 an hour (then 429 too-many-checkouts), only ever one open page; if the old page cannot be expired, no new one');

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
    assert.deepEqual(mine.calendars, [{ id: cal, status: 'active', plan: 'pro', interval: 'year', priceId: 'price_fake_yearly', currentPeriodEnd: 1830000000, trialEnd: null, cancelAtPeriodEnd: false }]);
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
    // Trial fields: the owner also learns what happens when Pro ends (lapsedMode, default read-only).
    assert.deepEqual(s1, { locked: true, pro: true, plan: 'pro', isOwner: true, paused: false, lapsedOwner: false, trialUsed: false, lapsedMode: 'readonly' });
    const s2 = await status(cal);
    assert.deepEqual(s2, { locked: true, pro: true, plan: 'pro', isOwner: false, paused: false, lapsedOwner: false, trialUsed: false });
    assert.deepEqual(Object.keys(s2).sort(), ['isOwner', 'lapsedOwner', 'locked', 'paused', 'plan', 'pro', 'trialUsed']);
    assert.deepEqual(await status(`missing-${run}`), { locked: false, pro: false, plan: null, isOwner: false, paused: false, lapsedOwner: false, trialUsed: false });
    step('status says {locked, pro, plan, isOwner, paused, lapsedOwner, trialUsed} and nothing else (no owner id, no key)');

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
    const b4 = fake.log.length;
    assert.equal((await webhook(event('customer.subscription.deleted', { id: `sub_${run}_a` }))).status, 200);
    assert.equal(fake.cals.get(cal).locked, false);
    // A paid cancel falls back like a lapsed trial: the room is told lapse:true (paused unless the owner chose open).
    const unlockCall = fake.log.slice(b4).find((l) => l.path === `/lockfake/cal/${cal}/unlock`);
    assert.deepEqual(unlockCall.body, { ownerId: ann.userId, lapse: true });
    assert.deepEqual(await status(cal, ann.cookie), { locked: false, pro: false, plan: null, isOwner: false, paused: false, lapsedOwner: false, trialUsed: false });
    step('a failed payment keeps the lock (past_due); cancellation unlocks with lapse:true (the read-only fallback)');

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

    // --- A second payer for a calendar someone else already locked (newer API shape: the invoice has no
    // payment_intent, invoice_payments does): refunded and canceled, the lock stays with the first owner.
    const conf = `conflict-${run}`; fake.addCalendar(conf);
    fake.subs.set(`sub_${run}_own`, { ...sub(`sub_${run}_own`, conf, ann.userId, 'active'), created: 1700000000 });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_own` }))).status, 200);
    assert.equal(fake.cals.get(conf).ownerId, ann.userId);
    assert.equal(lockCalls(conf).at(-1).body.createLink, false, 'a billing lock makes no editor link');
    fake.subs.set(`sub_${run}_2nd`, { ...sub(`sub_${run}_2nd`, conf, bob.userId, 'active'), created: 1700000100, latest_invoice: `in_${run}_2nd` });
    fake.invoices.set(`in_${run}_2nd`, { id: `in_${run}_2nd`, amount_paid: 2400, parent: { subscription_details: { subscription: `sub_${run}_2nd` } } });
    fake.invoicePayments.push({ invoice: `in_${run}_2nd`, status: 'paid', payment: { type: 'payment_intent', payment_intent: `pi_${run}_2nd` } });
    const evConf = event('checkout.session.completed', { id: 'cs_conf', subscription: `sub_${run}_2nd` });
    fake.hooks.refundFails = 1;
    assert.equal((await webhook(evConf)).status, 500, 'refund failed: Stripe retries the event');
    assert.equal(fake.subs.get(`sub_${run}_2nd`).status, 'active', 'not canceled before the refund went through');
    assert.equal((await webhook(evConf)).status, 200);
    const confRefunds = fake.refunds.filter((x) => x.payment_intent === `pi_${run}_2nd`);
    assert.equal(confRefunds.length, 1); assert.equal(confRefunds[0].idem, `refund-conflict-sub_${run}_2nd`);
    assert.equal(fake.subs.get(`sub_${run}_2nd`).status, 'canceled');
    assert.ok(fake.log.some((l) => l.method === 'DELETE' && l.path === `/stripe/v1/subscriptions/sub_${run}_2nd` && l.idem === `cancel-conflict-sub_${run}_2nd`));
    assert.equal(fake.cals.get(conf).ownerId, ann.userId, 'the lock stays with the first owner');
    let conflicts = (await (await admin(BASE, '/api/admin/accounts/conflicts')).json()).conflicts;
    assert.equal(conflicts.find((c) => c.stripe_subscription_id === `sub_${run}_2nd`).status, 'refunded-conflict');
    assert.ok(!(await me(bob.cookie)).calendars.some((c) => c.id === conf), 'not listed as theirs');
    assert.equal((await webhook(event('customer.subscription.deleted', { id: `sub_${run}_2nd` }))).status, 200);
    assert.equal((await webhook(event('charge.refunded', { id: 'ch_conf', refunded: true, payment_intent: `pi_${run}_2nd` }))).status, 200);
    assert.equal(fake.cals.get(conf).ownerId, ann.userId);
    assert.equal(fake.refunds.filter((x) => x.payment_intent === `pi_${run}_2nd`).length, 1);
    conflicts = (await (await admin(BASE, '/api/admin/accounts/conflicts')).json()).conflicts;
    assert.equal(conflicts.find((c) => c.stripe_subscription_id === `sub_${run}_2nd`).status, 'refunded-conflict', 'later events keep it final');
    step('a second payer for a locked calendar: refunded (once, across a retried webhook) then canceled, marked refunded-conflict; the owner keeps the lock');

    // --- The same person paying twice for one calendar (older API shape: invoice.payment_intent): the later one is refunded.
    fake.subs.set(`sub_${run}_dup`, { ...sub(`sub_${run}_dup`, conf, ann.userId, 'active'), created: 1700000200, latest_invoice: `in_${run}_dup` });
    fake.invoices.set(`in_${run}_dup`, { id: `in_${run}_dup`, amount_paid: 2400, payment_intent: `pi_${run}_dup`, subscription: `sub_${run}_dup` });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_dup` }))).status, 200);
    assert.equal(fake.refunds.filter((x) => x.payment_intent === `pi_${run}_dup`).length, 1);
    assert.equal(fake.subs.get(`sub_${run}_dup`).status, 'canceled');
    assert.equal(fake.subs.get(`sub_${run}_own`).status, 'active', 'the original stays');
    assert.equal((await webhook(event('customer.subscription.updated', { id: `sub_${run}_own` }))).status, 200);
    assert.equal(fake.subs.get(`sub_${run}_own`).status, 'active', 'a later event on the original refunds nothing');
    assert.equal(fake.cals.get(conf).ownerId, ann.userId);
    step('a duplicate subscription by the same owner: the later one is refunded and canceled, the original keeps the lock');

    // --- The owner's subscription ends while another person's is still active: the lock passes to them.
    const heirCal = `heir-${run}`; fake.addCalendar(heirCal);
    const dana = await signIn(BASE, `dana-${run}@example.com`);
    fake.subs.set(`sub_${run}_h1`, { ...sub(`sub_${run}_h1`, heirCal, ann.userId, 'active'), created: 1700000000 });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_h1` }))).status, 200);
    assert.equal((await admin(BASE, '/api/admin/accounts/dev-subscription', { method: 'POST', body: JSON.stringify({ email: `dana-${run}@example.com`, calendarId: heirCal }) })).status, 200);
    fake.subs.get(`sub_${run}_h1`).status = 'canceled';
    assert.equal((await webhook(event('customer.subscription.deleted', { id: `sub_${run}_h1` }))).status, 200);
    assert.equal(fake.cals.get(heirCal).locked, true); assert.equal(fake.cals.get(heirCal).ownerId, dana.userId);
    step('when the owner\'s subscription ends and another person\'s is active, the lock is handed to them');

    // --- Full refund and dispute end the subscription (and so the lock); a partial refund does not.
    const rfCal = `refund-${run}`; fake.addCalendar(rfCal);
    fake.subs.set(`sub_${run}_rf`, { ...sub(`sub_${run}_rf`, rfCal, ann.userId, 'active'), created: 1700000000 });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_rf` }))).status, 200);
    fake.invoices.set(`in_${run}_rf`, { id: `in_${run}_rf`, amount_paid: 2400, parent: { subscription_details: { subscription: `sub_${run}_rf` } } });
    fake.invoicePayments.push({ invoice: `in_${run}_rf`, status: 'paid', payment: { type: 'payment_intent', payment_intent: `pi_${run}_rf` } });
    assert.equal((await webhook(event('charge.refunded', { id: 'ch_rf', object: 'charge', refunded: false, amount_refunded: 100, payment_intent: `pi_${run}_rf` }))).status, 200);
    assert.equal(fake.cals.get(rfCal).locked, true, 'a partial refund keeps Pro');
    assert.equal((await webhook(event('charge.refunded', { id: 'ch_rf', object: 'charge', refunded: true, payment_intent: `pi_${run}_rf` }))).status, 200);
    assert.equal(fake.subs.get(`sub_${run}_rf`).status, 'canceled'); assert.equal(fake.cals.get(rfCal).locked, false);
    const dpCal = `dispute-${run}`; fake.addCalendar(dpCal);
    fake.subs.set(`sub_${run}_dp`, { ...sub(`sub_${run}_dp`, dpCal, ann.userId, 'active'), created: 1700000000 });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_dp` }))).status, 200);
    fake.charges.set(`ch_${run}_dp`, { id: `ch_${run}_dp`, object: 'charge', invoice: `in_${run}_dp` });
    fake.invoices.set(`in_${run}_dp`, { id: `in_${run}_dp`, amount_paid: 299, subscription: `sub_${run}_dp` });
    assert.equal((await webhook(event('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: `ch_${run}_dp` }))).status, 200);
    assert.equal(fake.subs.get(`sub_${run}_dp`).status, 'canceled'); assert.equal(fake.cals.get(dpCal).locked, false);
    step('a full refund (newer shape: payment_intent -> invoice_payments) or a dispute (older shape: charge.invoice) cancels the subscription and unlocks; a partial refund does not');

    // --- An event from the other Stripe mode is ignored (this instance's key is a local fake: no mode, so
    // only the TESTKEY instance below shows the refusal). And a test key outside dev mode turns billing off.
    r = await fetch(TESTKEY + '/api/stripe/webhook', { method: 'POST', body: '{}', headers: { 'Stripe-Signature': signStripe(WHSEC, '{}') } });
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'billing-not-configured' });
    assert.deepEqual(await (await fetch(TESTKEY + '/api/pro/config')).json(), { billing: false, unlimited: false });
    step('a test-mode Stripe key without dev mode: billing answers 503 billing-not-configured');
} finally {
    fake.close();
}
console.log(`\n${n} checks passed`); process.exit(0);
