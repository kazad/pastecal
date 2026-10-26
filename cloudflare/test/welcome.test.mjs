// The Pro welcome email: sent once, the first time the Stripe webhook locks a calendar for its
// owner, and never on a replay, a renewal, a second event for the same subscription or a retry.
// Same setup as billing.test.mjs (the BASE instance with fake Stripe vars, ACCOUNTS_DEV_MODE=1 and
// LOCK_API_BASE pointing at this file's fake on FAKE_PORT), then: node test/welcome.test.mjs
import assert from 'node:assert/strict';
import { startFakeStripe, signStripe } from './fake-stripe.mjs';
const BASE = process.env.BASE || 'http://localhost:8822';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret', WHSEC = 'fake-webhook-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const fake = await startFakeStripe(Number(process.env.FAKE_PORT || 8832));
let ip = 0;

const post = (path, body, cookie) => fetch(BASE + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': `10.40.0.${++ip % 250}`, ...(cookie ? { Cookie: cookie } : {}) },
});
const admin = (path) => fetch(BASE + path, { headers: { Authorization: `Bearer ${SECRET}` } });
const outbox = async (email) => (await (await admin(`/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).json()).emails;
const welcomes = async (email) => (await outbox(email)).filter((m) => m.subject.startsWith('Plus is on for'));
async function signIn(email) {
    await post('/api/auth/start', { email });
    const token = (await outbox(email)).at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    await post('/api/auth/verify', { token });
    return (await (await admin(`/api/admin/accounts/lookup?email=${encodeURIComponent(email)}`)).json()).user.id;
}
const webhook = (event) => {
    const body = JSON.stringify(event);
    return fetch(BASE + '/api/stripe/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) } });
};
let evN = 0;
const event = (type, object) => ({ id: `evt_w${run}_${++evN}`, object: 'event', type, data: { object } });
const sub = (id, calendarId, userId, status, periodEnd = 1830000000) => ({
    id, object: 'subscription', status, customer: `cus_w${run}`, metadata: { calendar_id: calendarId, user_id: userId },
    items: { data: [{ current_period_end: periodEnd, price: { id: 'price_fake_yearly', recurring: { interval: 'year' } } }] },
});

try {
    // --- First lock: one email, the right link, the calendar's title (cleaned), no key.
    const email = `wendy-${run}@example.com`;
    const userId = await signIn(email);
    const cal = `Robotics ${run}`;
    fake.addCalendar(cal, { title: 'Robotics team\r\nBcc: someone@example.com' });
    fake.subs.set(`sub_w${run}_a`, sub(`sub_w${run}_a`, cal, userId, 'active'));
    const created = event('customer.subscription.created', { id: `sub_w${run}_a` });
    assert.equal((await webhook(created)).status, 200);
    assert.equal(fake.cals.get(cal).locked, true);
    let mail = await welcomes(email);
    assert.equal(mail.length, 1);
    const [m] = mail;
    assert.equal(m.subject, 'Plus is on for Robotics team Bcc: someone@example.com', 'no line breaks reach the subject');
    assert.ok(m.text.includes(`https://pastecal.com/${encodeURIComponent(cal)}\n`), 'links to the encoded calendar id');
    assert.match(m.text, /Plus tab/); assert.match(m.text, /Editor link/); assert.match(m.text, /reset or revoke/);
    assert.match(m.text, /Manage billing/); assert.match(m.text, /sign in at pastecal\.com with this email/);
    assert.match(m.text, /support@pastecal\.com/);
    const key = fake.cals.get(cal).editorKey;
    assert.ok(key && !m.text.includes(key) && !m.subject.includes(key), 'the editor key from the lock never appears');
    assert.ok(!/ek-|#k=|#t=|[A-Za-z0-9_-]{22}/.test(m.text), 'nothing key- or token-like in the body');
    step('the first lock sends one welcome email: cleaned title in the subject, encoded link, how to add editors and manage billing, no key');

    // --- Replay, renewal, a second event for the same subscription: nothing more.
    assert.equal((await (await webhook(created)).json()).duplicate, true);
    fake.subs.get(`sub_w${run}_a`).items.data[0].current_period_end = 1860000000;
    assert.equal((await webhook(event('customer.subscription.updated', { id: `sub_w${run}_a` }))).status, 200);
    assert.equal((await webhook(event('checkout.session.completed', { id: 'cs_w', subscription: `sub_w${run}_a` }))).status, 200);
    assert.equal((await webhook(event('invoice.payment_failed', { id: 'in_w', subscription: `sub_w${run}_a` }))).status, 200);
    assert.equal((await welcomes(email)).length, 1);
    step('a replayed event, a renewal, checkout.completed and a failed-payment event for the same subscription send nothing');

    // --- Cancel, then subscribe again: the owner already had the welcome for this calendar.
    fake.subs.get(`sub_w${run}_a`).status = 'canceled';
    assert.equal((await webhook(event('customer.subscription.deleted', { id: `sub_w${run}_a` }))).status, 200);
    assert.equal(fake.cals.get(cal).locked, false);
    fake.subs.set(`sub_w${run}_b`, sub(`sub_w${run}_b`, cal, userId, 'active'));
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_w${run}_b` }))).status, 200);
    assert.equal(fake.cals.get(cal).locked, true);
    assert.equal((await welcomes(email)).length, 1);
    step('cancel then subscribe again to the same calendar: locked again, no second welcome');

    // --- The lock failing once: 500, then the retry locks and sends exactly one. No title: the id.
    const cal2 = `retry-w${run}`; fake.addCalendar(cal2);
    fake.subs.set(`sub_w${run}_c`, sub(`sub_w${run}_c`, cal2, userId, 'active'));
    const ev2 = event('checkout.session.completed', { id: 'cs_w2', subscription: `sub_w${run}_c` });
    fake.hooks.lockFails = 1;
    assert.equal((await webhook(ev2)).status, 500);
    assert.equal((await welcomes(email)).length, 1, 'no email when the lock did not happen');
    assert.equal((await webhook(ev2)).status, 200);
    mail = await welcomes(email);
    assert.equal(mail.length, 2); assert.equal(mail[1].subject, `Plus is on for ${cal2}`);
    assert.ok(mail[1].text.includes(`https://pastecal.com/${cal2}\n`));
    step('a failed lock sends nothing; its retry locks and sends one, titled with the id when the calendar has no title');

    // --- Two events for a new subscription at once: still one email.
    const cal3 = `race-w${run}`; fake.addCalendar(cal3, { title: 'Race' });
    fake.subs.set(`sub_w${run}_d`, sub(`sub_w${run}_d`, cal3, userId, 'active'));
    const rs = await Promise.all([
        webhook(event('customer.subscription.created', { id: `sub_w${run}_d` })),
        webhook(event('checkout.session.completed', { id: 'cs_w3', subscription: `sub_w${run}_d` })),
    ]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200]);
    assert.equal((await welcomes(email)).filter((x) => x.subject === 'Plus is on for Race').length, 1);
    step('subscription.created and checkout.completed arriving together send one email');

    // --- Not active (incomplete): no lock, no email.
    const cal4 = `incomplete-w${run}`; fake.addCalendar(cal4);
    fake.subs.set(`sub_w${run}_e`, sub(`sub_w${run}_e`, cal4, userId, 'incomplete'));
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_w${run}_e` }))).status, 200);
    assert.equal(fake.cals.get(cal4).locked, false);
    assert.equal((await welcomes(email)).length, 3);
    step('an incomplete subscription neither locks nor sends');
} finally {
    fake.close();
}
console.log(`\n${n} checks passed`); process.exit(0);
