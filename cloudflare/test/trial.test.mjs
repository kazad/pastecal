// The 30-day Pro trial and the read-only fallback when Pro ends, against REAL calendar rooms (no
// LOCK_API_BASE) and fake Stripe (test/fake-stripe.mjs on FAKE_PORT, default 8832).
// One `wrangler dev`, from cloudflare/, fake values only (nothing in .dev.vars is needed):
//   node node_modules/.bin/wrangler dev --port 8826 --inspector-port 9246 --persist-to /tmp/pc-trial-state \
//     --var COPY_BACK: --var FIREBASE_DB_URL:http://127.0.0.1:9 --var IMPORT_SECRET:dev-secret --var ACCOUNTS_DEV_MODE:1 \
//     --var STRIPE_SECRET_KEY:fake-stripe-key --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret \
//     --var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly \
//     --var STRIPE_API_BASE:http://127.0.0.1:8832/stripe
//   BASE=http://localhost:8826 node test/trial.test.mjs
import assert from 'node:assert/strict';
import { startFakeStripe, signStripe } from './fake-stripe.mjs';

const BASE = process.env.BASE || 'http://localhost:8826', SECRET = process.env.IMPORT_SECRET || 'dev-secret', WHSEC = 'fake-webhook-secret';
const FAKE_PORT = Number(process.env.FAKE_PORT || 8832);
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = await startFakeStripe(FAKE_PORT);
let ip = 0;

const post = (path, body, cookie) => fetch(BASE + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': `10.40.${Math.floor(++ip / 200)}.${ip % 200}`, ...(cookie ? { Cookie: cookie } : {}) },
});
const admin = (path, init = {}) => fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } });
const outbox = async (email) => (await (await admin(`/api/admin/accounts/outbox?email=${enc(email)}`)).json()).emails;
const userIdOf = async (email) => (await (await admin(`/api/admin/accounts/lookup?email=${enc(email)}`)).json()).user.id;
// A sign-in link, verified. next: where the link leads (a "Try Pro free" link is /<calendar>?pro=trial).
async function signIn(email, next) {
    await post('/api/auth/start', { email, ...(next ? { next } : {}) });
    const mail = (await outbox(email)).at(-1);
    const token = mail.text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    return { cookie: r.headers.get('set-cookie').split(';')[0], verify: await r.json(), mail, userId: await userIdOf(email) };
}
const status = async (id, cookie) => (await fetch(`${BASE}/api/pro/status?calendar=${enc(id)}`, { headers: cookie ? { Cookie: cookie } : {} })).json();
const getCal = async (id) => (await fetch(`${BASE}/cal/${enc(id)}`)).json();
const webhook = (event) => {
    const body = JSON.stringify(event);
    return fetch(BASE + '/api/stripe/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) } });
};
let evN = 0;
const event = (type, object) => ({ id: `evt_trial_${run}_${++evN}`, object: 'event', type, data: { object } });
const at = (d, h) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1 });
async function createCalendar(id) {
    const r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: `Team ${id}`, options: {}, events: [ev('a', 'first', 1)] }) });
    assert.equal(r.status, 201, await r.text());
}
// One browser tab on the calendar's socket; cookie = signed in (the Worker turns it into the owner's id).
function tab(id, cookie) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(id)}/ws`, cookie ? { headers: { Cookie: cookie, Origin: BASE } } : undefined);
    const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const waitFor = async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await sleep(20); }
        throw new Error('timed out; got ' + JSON.stringify(got.slice(-3)));
    };
    let k = 0;
    const save = async (commands) => { const sid = `s${++k}-${Math.random()}`; ws.send(JSON.stringify({ t: 'save', id: sid, v: 0, commands })); return waitFor((m) => m.id === sid); };
    return { ws, got, waitFor, save, ready: waitFor((m) => m.t === 'snapshot'), close: () => ws.close() };
}

try {
    // --- Start: a saved calendar, "Try Pro free" -> email -> the sign-in link starts the trial.
    const cal = `trial-${run}`;
    await createCalendar(cal);
    const annEmail = `ann-trial-${run}@example.com`;
    const before = fake.log.length;
    const ann = await signIn(annEmail, `/${enc(cal)}?pro=trial`);
    assert.equal(ann.mail.subject, 'Your pastecal sign-in link: start your free Plus trial');
    assert.match(ann.mail.text, /free 30-day Plus trial\. No card needed/);
    assert.deepEqual(ann.verify.trial, { ok: true });
    assert.equal(ann.verify.next, `/${enc(cal)}?pro=trial`);
    const subCall = fake.log.slice(before).find((l) => l.method === 'POST' && l.path === '/stripe/v1/subscriptions');
    assert.equal(subCall.body.trial_period_days, '30');
    assert.equal(subCall.body['trial_settings[end_behavior][missing_payment_method]'], 'cancel');
    assert.equal(subCall.body['items[0][price]'], 'price_fake_yearly');
    assert.equal(subCall.body['metadata[calendar_id]'], cal); assert.equal(subCall.body['metadata[trial]'], '1');
    assert.equal(subCall.body.default_payment_method, undefined, 'no card collected');
    assert.ok(fake.log.slice(before).some((l) => l.method === 'POST' && l.path === '/stripe/v1/customers' && l.body.email === annEmail));
    assert.equal(fake.log.slice(before).filter((l) => l.path === '/stripe/v1/checkout/sessions').length, 0, 'no Checkout page');
    let st = await status(cal, ann.cookie);
    assert.equal(st.locked, true); assert.equal(st.isOwner, true); assert.equal(st.trialUsed, true); assert.equal(st.lapsedMode, 'readonly');
    const daysLeft = (st.trial.endsAt * 1000 - Date.now()) / 86400000;
    assert.ok(daysLeft > 29.9 && daysLeft <= 30, `trial ends in 30 days (got ${daysLeft})`);
    assert.equal(st.trial.hasCard, false);
    const welcome = (await outbox(annEmail)).at(-1);
    assert.match(welcome.subject, /^Your Plus trial is on for /);
    assert.match(welcome.text, /No card is on file, so nothing will be charged/);
    step('a sign-in link from "Try Pro free" starts a 30-day trial on verify: direct subscription, no card, cancel at the end; the calendar is locked for that user');

    let r = await post('/api/pro/trial', { calendarId: cal }, ann.cookie);
    assert.equal(r.status, 200); assert.equal((await r.json()).already, true);
    assert.equal(fake.log.filter((l) => l.method === 'POST' && l.path === '/stripe/v1/subscriptions').length, 1);
    assert.equal((await post('/api/pro/trial', { calendarId: cal })).status, 401);
    r = await fetch(BASE + '/api/pro/trial', { method: 'POST', body: JSON.stringify({ calendarId: cal }), headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: ann.cookie } });
    assert.equal(r.status, 403);
    step('pressing it again answers already:true (no second subscription); signed out 401; another origin 403');

    const anonTab = tab(cal); let snap = await anonTab.ready;
    assert.deepEqual([snap.locked, snap.canEdit, snap.paused], [true, false, false]);
    assert.equal((await anonTab.save([{ type: 'add', event: ev('x', 'nope', 2) }])).code, 'locked');
    const ownerTab = tab(cal, ann.cookie); snap = await ownerTab.ready;
    assert.deepEqual([snap.role, snap.canEdit], ['owner', true]);
    assert.equal((await ownerTab.save([{ type: 'add', event: ev('b', 'owner edit', 2) }])).t, 'ack');
    step('during the trial it is a normal Pro lock: visitors read only, the owner edits');

    // --- Drafts can't trial (a draft has no room); one trial per account.
    const bobEmail = `bob-trial-${run}@example.com`;
    const bob = await signIn(bobEmail);
    r = await post('/api/pro/trial', { calendarId: `draft-${run}` }, bob.cookie);
    assert.equal(r.status, 404); assert.equal((await r.json()).error, 'no-calendar');
    r = await post('/api/pro/trial', { calendarId: cal }, bob.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'locked-by-other');
    const cal2 = `trial2-${run}`; await createCalendar(cal2);
    r = await post('/api/pro/trial', { calendarId: cal2 }, ann.cookie);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'trial-used-account', message: 'You have already used your free trial.' });
    assert.equal((await status(cal2)).locked, false);
    step('a draft (never saved) cannot trial (404); someone else\'s Pro calendar 409; the same email on another calendar: 409 trial-used-account');

    // --- A Stripe refusal releases the claim, so the trial can be tried again.
    fake.hooks.createFails = 1;
    const carlEmail = `carl-trial-${run}@example.com`;
    const carl = await signIn(carlEmail);
    r = await post('/api/pro/trial', { calendarId: cal2 }, carl.cookie);
    assert.equal(r.status, 502);
    assert.equal((await status(cal2)).trialUsed, false);
    step('when Stripe refuses, nothing is locked and the trial is not used up');

    // --- Day 27: trial_will_end -> one reminder email.
    const subId = subCall && [...fake.subs.values()].find((x) => x.metadata.calendar_id === cal).id;
    const mails0 = (await outbox(annEmail)).length;
    assert.equal((await webhook(event('customer.subscription.trial_will_end', { id: subId, object: 'subscription' }))).status, 200);
    assert.equal((await webhook(event('customer.subscription.trial_will_end', { id: subId, object: 'subscription' }))).status, 200);
    const mails = await outbox(annEmail);
    assert.equal(mails.length, mails0 + 1, 'one reminder, even if Stripe sends the event twice');
    const reminder = mails.at(-1);
    const endDay = new Date(fake.subs.get(subId).trial_end * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    assert.equal(reminder.subject, `Your Plus trial ends ${endDay}`);
    assert.ok(reminder.text.includes(`https://pastecal.com/${enc(cal)}?pro=keep`), 'Keep Pro link to the calendar');
    assert.match(reminder.text, /becomes read-only: everyone can still view it/);
    step('trial_will_end sends one "Your Pro trial ends <date>" email with a Keep Pro link (a repeat event sends nothing)');

    // --- Day 30, no card: Stripe cancels it -> FREE and READ-ONLY by default.
    fake.subs.get(subId).status = 'canceled';
    assert.equal((await webhook(event('customer.subscription.deleted', { id: subId, object: 'subscription' }))).status, 200);
    st = await status(cal, ann.cookie);
    assert.deepEqual([st.locked, st.isOwner, st.paused, st.lapsedOwner], [false, false, true, true]);
    const visitorSt = await status(cal);
    assert.deepEqual([visitorSt.paused, visitorSt.lapsedOwner], [true, false]);
    const told = await anonTab.waitFor((m) => m.t === 'snapshot' && m.paused === true);
    assert.deepEqual([told.locked, told.canEdit], [false, false]);
    await ownerTab.waitFor((m) => m.t === 'snapshot' && m.paused === true);
    let refused = await anonTab.save([{ type: 'add', event: ev('y', 'nope', 3) }]);
    assert.deepEqual([refused.t, refused.code, refused.message], ['error', 'paused', 'Editing is paused by the owner.']);
    refused = await ownerTab.save([{ type: 'add', event: ev('z', 'nope', 3) }]);
    assert.equal(refused.code, 'paused', 'nobody edits, the owner included');
    const fresh = tab(cal); snap = await fresh.ready;
    assert.deepEqual([snap.locked, snap.paused, snap.canEdit, snap.role], [false, true, false, 'viewer']);
    fresh.close();
    let got = await getCal(cal);
    assert.equal(got.paused, true); assert.equal(got.calendar.events.length, 2, 'reads as before');
    const feed = await fetch(`${BASE}/${enc(cal)}.ics`);
    assert.equal(feed.status, 200); const ics = await feed.text();
    assert.match(ics, /BEGIN:VCALENDAR/); assert.match(ics, /owner edit/);
    r = await fetch(`${BASE}/cal/${enc(cal)}/from-firebase`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ id: cal, title: 'x', options: {}, events: [] }) });
    assert.equal(r.status, 423); assert.equal((await r.json()).error, 'paused');
    r = await fetch(`${BASE}/cal/${enc(cal)}/import`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ id: cal, title: 'x', options: {}, events: [] }) });
    assert.equal(r.status, 423);
    r = await post('/createPublicLink', { sourceCalendarId: cal });
    assert.equal(r.status, 403); assert.equal((await r.json()).error.error, 'paused');
    assert.equal((await getCal(cal)).calendar.events.length, 2);
    step('no card by day 30: subscription deleted -> free and read-only (paused): every tab is told, saves refused "Editing is paused by the owner.", the owner too; GET and the .ics feed work; Firebase/import/new view links refused');

    // Nobody else can take a paused calendar.
    r = await post('/api/pro/trial', { calendarId: cal }, bob.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'locked-by-other');
    r = await post('/api/pro/checkout', { calendarId: cal }, bob.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'locked-by-other');
    fake.subs.set(`sub_${run}_bob`, { id: `sub_${run}_bob`, object: 'subscription', status: 'active', customer: `cus_${run}_bob`, metadata: { calendar_id: cal, user_id: bob.userId },
        items: { data: [{ current_period_end: 1830000000, price: { id: 'price_fake_yearly', recurring: { interval: 'year' } } }] } });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_bob` }))).status, 200);
    assert.equal((await status(cal)).paused, true, 'still paused: a stranger\'s payment cannot lock it (it is refunded as a conflict)');
    const conflicts = (await (await admin('/api/admin/accounts/conflicts')).json()).conflicts;
    assert.ok(conflicts.some((c) => c.stripe_subscription_id === `sub_${run}_bob`));
    step('a paused calendar stays its owner\'s: someone else\'s trial or checkout is 409, and a stranger\'s subscription is refunded instead of locking it');

    // --- The owner opens it: a normal free calendar.
    assert.equal((await post('/api/pro/lapsed-mode', { calendarId: cal, mode: 'open' })).status, 401);
    r = await post('/api/pro/lapsed-mode', { calendarId: cal, mode: 'open' }, bob.cookie);
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'not-owner');
    r = await post('/api/pro/lapsed-mode', { calendarId: cal, mode: 'sideways' }, ann.cookie);
    assert.equal(r.status, 400);
    r = await post('/api/pro/lapsed-mode', { calendarId: cal, mode: 'open' }, ann.cookie);
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, mode: 'open', paused: false });
    await anonTab.waitFor((m) => m.t === 'snapshot' && m.paused === false && m.canEdit === true);
    assert.equal((await anonTab.save([{ type: 'add', event: ev('c', 'anyone again', 4) }])).t, 'ack');
    st = await status(cal, ann.cookie);
    assert.deepEqual([st.locked, st.paused, st.lapsedOwner], [false, false, false]);
    got = await getCal(cal);
    assert.equal(got.paused, false); assert.equal(got.calendar.events.length, 3);
    step('the owner chooses "open" (others 403, signed out 401, a bad mode 400): every tab can edit again, a normal free calendar');

    // One trial per calendar EVER, whatever the email.
    r = await post('/api/pro/trial', { calendarId: cal }, bob.cookie);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'trial-used-calendar', message: 'This calendar has already had a free trial.' });
    r = await post('/api/pro/trial', { calendarId: cal }, ann.cookie);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'trial-used-calendar', 'its own owner neither');
    step('a second trial on the same calendar is refused with any email: 409 trial-used-calendar');

    // --- Resubscribing relocks (paid flow, same fallback): cancel -> paused -> resubscribe -> locked.
    const cal3 = `paid-${run}`; await createCalendar(cal3);
    const paidSub = (id, status) => ({ id, object: 'subscription', status, customer: `cus_${run}_ann`, metadata: { calendar_id: cal3, user_id: ann.userId },
        created: Math.floor(Date.now() / 1000), items: { data: [{ current_period_end: 1830000000, price: { id: 'price_fake_monthly', recurring: { interval: 'month' } } }] } });
    fake.subs.set(`sub_${run}_p1`, paidSub(`sub_${run}_p1`, 'active'));
    await webhook(event('customer.subscription.created', { id: `sub_${run}_p1` }));
    assert.equal((await status(cal3, ann.cookie)).isOwner, true);
    fake.subs.get(`sub_${run}_p1`).status = 'canceled';
    await webhook(event('customer.subscription.deleted', { id: `sub_${run}_p1` }));
    st = await status(cal3, ann.cookie);
    assert.deepEqual([st.locked, st.paused, st.lapsedOwner], [false, true, true]);
    // The owner, paused, buys again: checkout is allowed for them.
    r = await post('/api/pro/checkout', { calendarId: cal3, interval: 'month' }, ann.cookie);
    assert.equal(r.status, 200);
    fake.subs.set(`sub_${run}_p2`, paidSub(`sub_${run}_p2`, 'active'));
    await webhook(event('customer.subscription.created', { id: `sub_${run}_p2` }));
    st = await status(cal3, ann.cookie);
    assert.deepEqual([st.locked, st.isOwner, st.paused], [true, true, false]);
    const t3 = tab(cal3, ann.cookie); snap = await t3.ready;
    assert.equal((await t3.save([{ type: 'add', event: ev('d', 'back', 5) }])).t, 'ack');
    t3.close();
    step('a paid subscription that ends falls back the same way (paused); the owner resubscribes and it is locked again, owner editing');

    // --- The owner's choice made ahead of time: "open" when Pro ends.
    r = await post('/api/pro/lapsed-mode', { calendarId: cal3, mode: 'open' }, ann.cookie);
    assert.deepEqual(await r.json(), { ok: true, mode: 'open', paused: false });
    assert.equal((await status(cal3, ann.cookie)).lapsedMode, 'open');
    fake.subs.get(`sub_${run}_p2`).status = 'canceled';
    await webhook(event('customer.subscription.deleted', { id: `sub_${run}_p2` }));
    st = await status(cal3);
    assert.deepEqual([st.locked, st.paused], [false, false]);
    const t4 = tab(cal3); snap = await t4.ready;
    assert.equal(snap.canEdit, true); assert.equal((await t4.save([{ type: 'add', event: ev('e', 'free again', 6) }])).t, 'ack');
    t4.close();
    step('an owner who chose "open" while locked gets a normal free calendar when Pro ends');

    // --- A card on file: the reminder never says "nothing is charged".
    r = await post('/api/pro/trial', { calendarId: cal2 }, carl.cookie);
    assert.equal(r.status, 200, 'carl\'s first try failed at Stripe, so his trial and cal2\'s are still unused');
    const carlSub = [...fake.subs.values()].find((x) => x.metadata.calendar_id === cal2);
    assert.notEqual(carlSub.customer, undefined);
    fake.customers.get(carlSub.customer).invoice_settings = { default_payment_method: 'pm_fake_visa' };
    assert.equal((await status(cal2, carl.cookie)).trial.hasCard, true);
    await webhook(event('customer.subscription.trial_will_end', { id: carlSub.id, object: 'subscription' }));
    const cardMail = (await outbox(carlEmail)).at(-1);
    assert.match(cardMail.subject, /^Your Plus trial ends /);
    assert.match(cardMail.text, /A card is on file/); assert.doesNotMatch(cardMail.text, /nothing is charged/);
    step('with a card on file, status says hasCard and the day-27 email says the card is charged (never "nothing is charged")');

    // --- Keep Pro during the trial = the ordinary checkout; the paid subscription replaces the trial.
    r = await post('/api/pro/checkout', { calendarId: cal2, interval: 'month' }, carl.cookie);
    assert.equal(r.status, 200, 'the trialing owner may check out');
    const cs = fake.log.filter((l) => l.path === '/stripe/v1/checkout/sessions').at(-1);
    assert.equal(cs.body['line_items[0][price]'], 'price_fake_monthly');
    assert.equal(Number(cs.body['subscription_data[trial_end]']), carlSub.trial_end, 'the remaining trial days carry over');
    assert.equal((await post('/api/pro/checkout', { calendarId: cal2 }, bob.cookie)).status, 409);
    const refundsBefore = fake.refunds.length, bk = fake.log.length;
    fake.subs.set(`sub_${run}_carl_paid`, { id: `sub_${run}_carl_paid`, object: 'subscription', status: 'active', customer: `cus_${run}_carl`, created: Math.floor(Date.now() / 1000) + 5,
        metadata: { calendar_id: cal2, user_id: carl.userId }, items: { data: [{ current_period_end: 1830000000, price: { id: 'price_fake_monthly', recurring: { interval: 'month' } } }] } });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_carl_paid` }))).status, 200);
    assert.ok(fake.log.slice(bk).some((l) => l.method === 'DELETE' && l.path === `/stripe/v1/subscriptions/${carlSub.id}`), 'the trial is canceled');
    assert.equal(fake.refunds.length, refundsBefore, 'nothing refunded: the paid subscription is not a duplicate');
    assert.equal(fake.subs.get(carlSub.id).status, 'canceled');
    st = await status(cal2, carl.cookie);
    assert.deepEqual([st.locked, st.isOwner, st.trial, st.paused], [true, true, undefined, false]);
    await webhook(event('customer.subscription.deleted', { id: carlSub.id, object: 'subscription' }));
    assert.equal((await status(cal2, carl.cookie)).isOwner, true, 'the trial\'s own deleted event does not unlock a paid calendar');
    step('Keep Pro during a trial is the normal checkout ($24/year or $2.99/month); the paid subscription replaces the trial (canceled, not refunded), the lock stays');

    anonTab.close(); ownerTab.close();
    console.log(`\n${n} checks passed`);
} finally {
    fake.close();
}
