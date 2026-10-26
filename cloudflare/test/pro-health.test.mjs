// GET /api/admin/pro/health (scripts/pro-health.sh): subscription counts, subscriptions whose
// calendar isn't locked by their owner (and the reverse), and the 24h sign-in funnel.
// Same setup as billing.test.mjs (BASE with fake Stripe vars, ACCOUNTS_DEV_MODE=1, LOCK_API_BASE at
// this file's fake on FAKE_PORT), then: node test/pro-health.test.mjs
// The Worker's database outlives the fake, so earlier runs' calendars show up as no-calendar:
// every assertion looks only at this run's calendars and at deltas.
import assert from 'node:assert/strict';
import { startFakeStripe, signStripe } from './fake-stripe.mjs';
const BASE = process.env.BASE || 'http://localhost:8822';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret', WHSEC = 'fake-webhook-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const fake = await startFakeStripe(Number(process.env.FAKE_PORT || 8832));
let ip = 0;

const post = (path, body) => fetch(BASE + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': `10.50.0.${++ip % 250}` },
});
const admin = (path, init = {}) => fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } });
const health = async () => { const r = await admin('/api/admin/pro/health'); assert.equal(r.status, 200); return r.json(); };
const devSub = async (email, calendarId, status) => (await (await admin('/api/admin/accounts/dev-subscription', { method: 'POST', body: JSON.stringify({ email, calendarId, status }) })).json());
const webhook = (event) => {
    const body = JSON.stringify(event);
    return fetch(BASE + '/api/stripe/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) } });
};
const mine = (h) => h.mismatches.filter((m) => m.calendarId.endsWith(run));

try {
    assert.equal((await fetch(BASE + '/api/admin/pro/health')).status, 403);
    assert.equal((await fetch(BASE + '/api/admin/pro/health', { headers: { Authorization: 'Bearer wrong' } })).status, 403);
    assert.equal((await admin('/api/admin/pro/health', { method: 'POST', body: '{}' })).status, 405);
    step('the health route needs the admin secret and is GET only');

    const before = await health();
    assert.equal(typeof before.signIn24h.issued, 'number'); assert.equal(typeof before.signIn24h.consumed, 'number');

    // A healthy one: paid through the webhook, locked for its owner.
    const email = `hal-${run}@example.com`;
    const { userId } = await devSub(email, `seed-${run}`, 'canceled');      // makes the user; an ended sub for a calendar the fake doesn't know
    const good = `good-${run}`; fake.addCalendar(good);
    fake.subs.set(`sub_h${run}`, { id: `sub_h${run}`, object: 'subscription', status: 'active', customer: `cus_h${run}`, metadata: { calendar_id: good, user_id: userId },
        items: { data: [{ current_period_end: 1830000000, price: { id: 'price_fake_yearly', recurring: { interval: 'year' } } }] } });
    assert.equal((await webhook({ id: `evt_h${run}`, object: 'event', type: 'customer.subscription.created', data: { object: { id: `sub_h${run}` } } })).status, 200);
    assert.equal(fake.cals.get(good).ownerId, userId);

    // Deliberate mismatches: paid but unlocked, paid but locked by someone else, ended but still
    // locked by the owner, and paid for a calendar that doesn't exist.
    const unlocked = `unlocked-${run}`; fake.addCalendar(unlocked);
    await devSub(email, unlocked, 'active');
    const other = `other-${run}`; fake.addCalendar(other, { locked: true, ownerId: 'u_someone_else' });
    await devSub(email, other, 'past_due');
    const stale = `stale-${run}`; fake.addCalendar(stale, { locked: true, ownerId: userId });
    await devSub(email, stale, 'canceled');
    await devSub(email, `missing-${run}`, 'trialing');

    const h = await health();
    assert.equal(h.ok, false);
    const got = Object.fromEntries(mine(h).map((m) => [m.calendarId, m]));
    assert.deepEqual(Object.keys(got).sort(), [`missing-${run}`, other, stale, unlocked].sort());
    assert.equal(got[unlocked].kind, 'paid-not-locked'); assert.equal(got[unlocked].lockedByOther, false); assert.equal(got[unlocked].status, 'active');
    assert.equal(got[other].kind, 'paid-not-locked'); assert.equal(got[other].lockedByOther, true);
    assert.equal(got[stale].kind, 'locked-not-paid');
    assert.equal(got[`missing-${run}`].kind, 'no-calendar');
    assert.ok(!(`seed-${run}` in got), 'an ended subscription for a calendar that is gone is not a problem');
    assert.ok(!(good in got));
    for (const m of h.mismatches) assert.deepEqual(Object.keys(m).filter((k) => /user|email|owner|key/i.test(k)), [], 'no user ids, emails or keys in the report');
    step('a webhook-locked calendar is healthy; paid-not-locked (unlocked or locked by another), locked-not-paid and no-calendar are each reported');

    assert.equal(h.subscriptions.active - (before.subscriptions.active || 0), 2);
    assert.equal(h.subscriptions.canceled - (before.subscriptions.canceled || 0), 2);
    assert.equal(h.subscriptions.past_due - (before.subscriptions.past_due || 0), 1);
    assert.equal(h.subscriptions.trialing - (before.subscriptions.trialing || 0), 1);
    assert.ok(h.calendars.checked <= 200 && h.calendars.checked >= 6); assert.equal(typeof h.calendars.capped, 'boolean');
    assert.match(h.notChecked, /no index of rooms/);
    step('subscription counts by status move with the new rows; the checked count and its cap are reported');

    // Sign-in funnel: one link issued and used, one issued and left.
    await post('/api/auth/start', { email: `funnel-a-${run}@example.com` });
    await post('/api/auth/start', { email: `funnel-b-${run}@example.com` });
    const box = (await (await admin(`/api/admin/accounts/outbox?email=${encodeURIComponent(`funnel-a-${run}@example.com`)}`)).json()).emails;
    await post('/api/auth/verify', { token: box.at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1] });
    const h2 = await health();
    assert.equal(h2.signIn24h.issued - h.signIn24h.issued, 2);
    assert.equal(h2.signIn24h.consumed - h.signIn24h.consumed, 1);
    assert.ok(!JSON.stringify(h2).includes('@'), 'no email addresses anywhere in the report');
    step('the 24h sign-in funnel counts links issued and used, with no addresses');

    // Fixing the mismatch clears it.
    fake.cals.get(unlocked).locked = true; fake.cals.get(unlocked).ownerId = userId;
    assert.ok(!mine(await health()).some((m) => m.calendarId === unlocked));
    step('once the calendar is locked for its owner, it drops off the list');
} finally {
    fake.close();
}
console.log(`\n${n} checks passed`); process.exit(0);
