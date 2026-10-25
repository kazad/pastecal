// The 30-day Pro trial end to end against a REAL Stripe sandbox (test mode), with a browser.
// Same setup as stripe-sandbox-e2e.mjs: wrangler dev on BASE with .dev.vars.e2e + .dev.vars.stripe
// (sandbox sk_test key, price ids, the `stripe listen` secret, ACCOUNTS_DEV_MODE=1), and `stripe listen`
// forwarding the events in that file's header, INCLUDING customer.subscription.trial_will_end.
// The stripe CLI must act on the same sandbox: export STRIPE_API_KEY (the sk_test key). Never production.
// Run: NODE_PATH=<repo>/node_modules PRICE_YEARLY=<price id> node test/trial-sandbox-e2e.mjs [screenshot dir]
//
// A. Start the trial (no card) -> locked -> Keep Pro through the REAL Checkout page, test card typed in
//    -> the paid subscription replaces the trial (trial canceled, not refunded), the lock stays.
// B. Start the trial -> end it now (trial_end=now) -> Stripe cancels it (no card) -> read-only (paused)
//    -> the owner chooses Open -> anyone can write.
// C. Day 27 reminder: a trial subscription on a Stripe TEST CLOCK (the product's /api/pro/trial makes its
//    own customer with no clock, so this one is made by hand with the same parameters; the webhook takes it
//    as a trial) -> advance to 2 days before the end -> Stripe sends trial_will_end -> one reminder email;
//    advance past the end -> canceled -> paused.
// D. Billing Portal: /api/pro/portal (and flow add-card) opens the real portal for the trial's customer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.NODE_PATH + '/x')('playwright');

const BASE = process.env.BASE || 'http://localhost:8850', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const OUT = process.argv[2] || '/tmp', PRICE_YEARLY = process.env.PRICE_YEARLY;
assert.ok(PRICE_YEARLY, 'PRICE_YEARLY (the sandbox yearly price id) is required');
assert.match(process.env.STRIPE_API_KEY || '', /^sk_test_/, 'the stripe CLI must use a TEST key');
const H = { Origin: BASE, 'Content-Type': 'application/json' };
const enc = encodeURIComponent;
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, every = 1500) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every); } }
const admin = (p) => fetch(BASE + p, { headers: { Authorization: `Bearer ${SECRET}` } }).then((r) => r.json());
const outbox = async (email) => (await admin(`/api/admin/accounts/outbox?email=${enc(email)}`)).emails;
const userIdOf = async (email) => (await admin(`/api/admin/accounts/lookup?email=${enc(email)}`)).user.id;
const stripe = (args) => { const o = execFileSync('stripe', args, { encoding: 'utf8' }); return JSON.parse(o.slice(o.indexOf('{'))); };
const sget = (path) => stripe(['get', path]);
const spost = (path, data) => stripe(['post', path, ...Object.entries(data).flatMap(([k, v]) => ['-d', `${k}=${v}`])]);
const status = async (cal, cookie) => (await fetch(`${BASE}/api/pro/status?calendar=${enc(cal)}`, { headers: cookie ? { Cookie: cookie } : {} })).json();
const post = (path, body, cookie) => fetch(BASE + path, { method: 'POST', headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const vm = (page, fn, arg) => page.evaluate(([src, a]) => {
    const el = [...document.querySelectorAll('*')].find((e) => e.__vue_app__); const app = el.__vue_app__;
    const v = app._instance?.proxy || app._container._vnode.component.proxy; return new Function('vm', 'a', src)(v, a);
}, [fn, arg]);
// The newest subscription in the sandbox whose metadata names this calendar.
const subsFor = (cal) => stripe(['subscriptions', 'list', '--limit', '30', '--status', 'all']).data.filter((s) => s.metadata && s.metadata.calendar_id === cal);

const run = Date.now().toString(36);
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
async function createCalendar(cal, title) {
    const r = await fetch(`${BASE}/cal/${enc(cal)}`, { method: 'POST', body: JSON.stringify({ title, events: [
        { id: 'e1', title: 'Practice', start: `${day(1)}T17:00:00.000Z`, end: `${day(1)}T18:00:00.000Z`, type: 1 }] }) });
    assert.equal(r.status, 201, await r.text());
}
async function signIn(email, next) {
    await post('/api/auth/start', { email, ...(next ? { next } : {}) });
    const mail = (await outbox(email)).at(-1);
    const token = mail.text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    return { cookie: r.headers.get('set-cookie').split(';')[0], verify: await r.json(), mail, userId: await userIdOf(email) };
}
async function trySave(cal, cookie) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(cal)}/ws`, cookie ? { headers: { Cookie: cookie, Origin: BASE } } : undefined); const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    await until(() => got.some((m) => m.t === 'snapshot'), 10000, 50);
    const id = 's' + Math.random().toString(36).slice(2), v = got.find((m) => m.t === 'snapshot').v;
    ws.send(JSON.stringify({ t: 'save', id, v, commands: [{ type: 'add', event: { id, title: 'x', start: `${day(3)}T17:00:00.000Z`, end: `${day(3)}T18:00:00.000Z`, type: 1 } }] }));
    const reply = await until(() => got.find((m) => m.id === id), 10000, 50); ws.close(); return reply;
}
// A browser context signed in as this cookie (localhost session cookie).
const browser = await chromium.launch();
async function ctxWith(cookie) {
    const c = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    // Checkout's success_url / portal return_url use SITE_URL, which is production when unset locally: never go there.
    await c.route(/^https:\/\/(www\.)?pastecal\.com\//, (r) => r.abort());
    if (cookie) { const i = cookie.indexOf('='); await c.addCookies([{ name: cookie.slice(0, i), value: cookie.slice(i + 1), url: BASE }]); }
    return c;
}
async function openPanel(page, cal) {
    await page.goto(`${BASE}/${cal}?backend=cf`); await page.waitForTimeout(3500);
    await vm(page, 'vm.showShare = true'); await page.waitForTimeout(1200);
    await page.locator('[data-testid=pro-panel]').waitFor({ timeout: 15000 });
}
let clockId = null;

try {
    // ---------------- A. Trial -> Keep Pro through the real Checkout ----------------
    const calA = `trial-a-${run}`, emailA = `trial-a-${run}@example.com`;
    await createCalendar(calA, 'Choir');
    const ann = await signIn(emailA, `/${enc(calA)}?pro=trial`);
    assert.deepEqual(ann.verify.trial, { ok: true });
    let st = await status(calA, ann.cookie);
    assert.deepEqual([st.locked, st.isOwner, st.trialUsed, st.trial && st.trial.hasCard], [true, true, true, false]);
    const [trialA] = subsFor(calA);
    assert.ok(trialA, 'trial subscription not in Stripe');
    assert.equal(trialA.status, 'trialing'); assert.equal(trialA.metadata.trial, '1');
    assert.equal(trialA.trial_settings.end_behavior.missing_payment_method, 'cancel');
    assert.equal(trialA.default_payment_method, null, 'no card collected');
    assert.equal(trialA.items.data[0].price.id, PRICE_YEARLY);
    const daysLeft = (trialA.trial_end - Date.now() / 1000) / 86400;
    assert.ok(daysLeft > 29.9 && daysLeft <= 30.01, `30 days (got ${daysLeft})`);
    assert.match((await outbox(emailA)).at(-1).subject, /^Your Plus trial is on for /);
    assert.equal((await trySave(calA)).code, 'locked');
    step('"Try Pro free" sign-in link started a real Stripe trial: trialing, 30 days, no card, cancel-if-no-card; calendar locked, visitors refused');

    const ownerA = await ctxWith(ann.cookie); const pa = await ownerA.newPage();
    await openPanel(pa, calA);
    await pa.locator('[data-testid=pro-trial-line]').waitFor({ timeout: 15000 });
    assert.match(await pa.locator('[data-testid=pro-trial-line]').innerText(), /Plus trial/);
    await pa.screenshot({ path: `${OUT}/A1-trial-owner-panel.png` });
    await pa.locator('[data-testid=pro-keep-trial]').click();
    await pa.locator('[data-testid=pro-keep-plans]').filter({ visible: true }).first().waitFor();
    await pa.locator('input[name=pc-pro-keep-interval][value=month]').check();
    await pa.screenshot({ path: `${OUT}/A2-keep-pro-plans.png` });
    await pa.locator('[data-testid=pro-keep-checkout]').filter({ visible: true }).first().click();
    await pa.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
    await pa.locator('#cardNumber').waitFor({ timeout: 30000 });
    await pa.screenshot({ path: `${OUT}/A3-checkout-keep-pro.png` });
    const checkoutText = await pa.locator('body').innerText();
    await pa.locator('#cardNumber').fill('4242424242424242');
    await pa.locator('#cardExpiry').fill('12 / 34');
    await pa.locator('#cardCvc').fill('123');
    await pa.locator('#billingName').fill('Trial Tester');
    const zip = pa.locator('#billingPostalCode'); if (await zip.count()) await zip.fill('94110');
    await pa.screenshot({ path: `${OUT}/A4-checkout-filled.png` });
    await pa.locator('button[type=submit], .SubmitButton').first().click();
    step(`Keep Pro (monthly) opened the real Checkout page${/trial|free|days/i.test(checkoutText) ? ' (it shows the remaining free days)' : ''}; Stripe test card 4242 typed in and submitted`);

    // The paid subscription replaces the trial.
    const paid = await until(() => subsFor(calA).find((s) => s.id !== trialA.id && s.status !== 'canceled'), 90000, 3000);
    assert.ok(paid, 'no paid subscription from Checkout');
    assert.equal(paid.items.data[0].price.recurring.interval, 'month');
    assert.ok(paid.default_payment_method, 'card saved on the new subscription');
    assert.equal(paid.status, 'trialing', 'remaining trial days carry over: trialing with a card');
    assert.equal(paid.trial_end, trialA.trial_end, 'same trial end as the free trial');
    const trialGone = await until(() => { const s = sget(`/v1/subscriptions/${trialA.id}`); return s.status === 'canceled' ? s : null; }, 60000, 2000);
    assert.ok(trialGone, 'the free trial was not canceled');
    st = await until(async () => { const s = await status(calA, ann.cookie); return s.locked && s.trial && s.trial.hasCard ? s : null; }, 30000);
    assert.ok(st, 'status never showed the card'); assert.deepEqual([st.locked, st.isOwner, st.paused], [true, true, false]);
    const refunds = stripe(['refunds', 'list', '--limit', '20']).data.filter((x) => x.metadata && x.metadata.calendar_id === calA);
    assert.equal(refunds.length, 0, 'nothing refunded');
    await sleep(5000);   // the trial's own customer.subscription.deleted has arrived by now
    st = await status(calA, ann.cookie); assert.deepEqual([st.locked, st.isOwner], [true, true], 'the old trial\'s deleted event did not unlock it');
    await openPanel(pa, calA); await pa.screenshot({ path: `${OUT}/A5-after-keep-pro.png` });
    step('converted: paid monthly subscription (trialing with a card, same trial end) replaced the trial; the trial is canceled, nothing refunded; still locked to the owner after the trial\'s deleted event');

    // ---------------- D. Billing Portal (the trial owner's customer) ----------------
    let r = await post('/api/pro/portal', { calendarId: calA }, ann.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const portalUrl = (await r.json()).url; assert.match(portalUrl, /^https:\/\/billing\.stripe\.com\//);
    await pa.goto(portalUrl); await pa.waitForTimeout(4000);
    const portalText = await pa.locator('body').innerText();
    await pa.screenshot({ path: `${OUT}/D1-portal.png`, fullPage: true });
    assert.match(portalText, /pastecal Pro/); assert.match(portalText, /Add payment method|Payment method/i);
    r = await post('/api/pro/portal', { calendarId: calA, flow: 'add-card' }, ann.cookie);
    assert.equal(r.status, 200, 'flow add-card (payment_method_update) accepted by the portal configuration');
    await pa.goto((await r.json()).url);
    await pa.frameLocator('iframe').first().locator('input').first().waitFor({ timeout: 30000 }).catch(() => {});   // the card form (Payment Element)
    await pa.waitForTimeout(3000);
    await pa.screenshot({ path: `${OUT}/D2-portal-add-card.png` });
    assert.match(await pa.locator('body').innerText(), /payment method|card/i);
    step('Billing Portal: /api/pro/portal opens the real portal (subscription, payment method, add payment method); flow add-card opens the update-payment-method page');
    await ownerA.close();

    // ---------------- B. Trial ends with no card -> paused -> owner opens it ----------------
    const calB = `trial-b-${run}`, emailB = `trial-b-${run}@example.com`;
    await createCalendar(calB, 'Book club');
    const bob = await signIn(emailB);
    r = await post('/api/pro/trial', { calendarId: calB }, bob.cookie);
    assert.equal(r.status, 200, await r.clone().text()); assert.equal((await r.json()).ok, true);
    st = await status(calB, bob.cookie); assert.deepEqual([st.locked, st.isOwner, st.trial.hasCard], [true, true, false]);
    const [trialB] = subsFor(calB); assert.equal(trialB.status, 'trialing');
    step('second calendar: POST /api/pro/trial started a real trial (no card); locked to its owner');

    const ended = spost(`/v1/subscriptions/${trialB.id}`, { trial_end: 'now' });
    const endedNow = await until(() => { const s = sget(`/v1/subscriptions/${trialB.id}`); return s.status !== 'trialing' ? s : null; }, 30000, 2000);
    assert.equal(endedNow && endedNow.status, 'canceled', `trial end with no card should cancel (got ${endedNow && endedNow.status}, update answered ${ended.status})`);
    st = await until(async () => { const s = await status(calB, bob.cookie); return s.paused ? s : null; });
    assert.ok(st, 'never fell back to paused');
    assert.deepEqual([st.locked, st.paused, st.lapsedOwner, st.lapsedTrial], [false, true, true, true]);
    assert.equal((await trySave(calB)).code, 'paused'); assert.equal((await trySave(calB, bob.cookie)).code, 'paused', 'the owner too');
    const ownerB = await ctxWith(bob.cookie); const pb = await ownerB.newPage();
    const visitor = await ctxWith(null); const vp = await visitor.newPage();
    await vp.goto(`${BASE}/${calB}?backend=cf`); await vp.waitForTimeout(3500);
    assert.equal(await vm(vp, 'return vm.isReadOnly'), true);
    await vp.screenshot({ path: `${OUT}/B1-visitor-paused.png` });
    await openPanel(pb, calB);
    assert.match(await pb.locator('[data-testid=pro-lapsed-title]').innerText(), /Trial ended/);
    await pb.screenshot({ path: `${OUT}/B2-owner-trial-ended.png` });
    step('trial_end=now with no card: Stripe canceled it; the webhook made it read-only (paused) for everyone, owner included; the owner sees "Trial ended — read-only"');

    pb.once('dialog', (d) => d.accept());
    await pb.locator('[data-testid=pro-open-btn]').click();
    const opened = await until(async () => (await vm(vp, 'return !vm.isReadOnly')) ? true : null, 30000);
    assert.ok(opened, 'visitor page never became editable');
    assert.equal((await trySave(calB)).t, 'ack');
    await vp.screenshot({ path: `${OUT}/B3-visitor-after-open.png` });
    step('owner clicked "Open to everyone": the visitor\'s open page became editable live and a visitor save is acked');
    await ownerB.close(); await visitor.close();

    // ---------------- C. trial_will_end on a test clock ----------------
    const calC = `trial-c-${run}`, emailC = `trial-c-${run}@example.com`;
    await createCalendar(calC, 'Soccer');
    const cara = await signIn(emailC);
    const now = Math.floor(Date.now() / 1000);
    const clock = spost('/v1/test_helpers/test_clocks', { frozen_time: now, name: `pastecal trial ${run}` }); clockId = clock.id;
    const cust = spost('/v1/customers', { email: emailC, test_clock: clockId, 'metadata[user_id]': cara.userId, 'metadata[trial_calendar]': calC });
    const subC = spost('/v1/subscriptions', { customer: cust.id, 'items[0][price]': PRICE_YEARLY, 'items[0][quantity]': 1, trial_period_days: 30,
        'trial_settings[end_behavior][missing_payment_method]': 'cancel', 'payment_settings[save_default_payment_method]': 'on_subscription',
        'metadata[calendar_id]': calC, 'metadata[user_id]': cara.userId, 'metadata[trial]': '1' });
    assert.equal(subC.status, 'trialing');
    st = await until(async () => { const s = await status(calC, cara.cookie); return s.locked ? s : null; });
    assert.ok(st, 'the webhook never locked the clock trial'); assert.deepEqual([st.isOwner, st.trialUsed, !!st.trial], [true, true, true]);
    step('a trial subscription on a Stripe test clock (same parameters as /api/pro/trial) was taken by the webhook: locked, counted as a trial');

    const advance = async (to) => {
        spost(`/v1/test_helpers/test_clocks/${clockId}/advance`, { frozen_time: to });
        const ok = await until(() => sget(`/v1/test_helpers/test_clocks/${clockId}`).status === 'ready', 120000, 3000);
        assert.ok(ok, 'test clock never became ready');
    };
    const mailsBefore = (await outbox(emailC)).length;
    await advance(subC.trial_end - 2 * 86400);
    const reminder = await until(async () => (await outbox(emailC)).slice(mailsBefore).find((m) => /^Your Plus trial ends /.test(m.subject)), 90000, 2000);
    assert.ok(reminder, 'no trial_will_end reminder email');
    assert.ok(reminder.text.includes(`?pro=keep`), 'Keep Pro link');
    assert.match(reminder.text, /read-only/);
    await sleep(4000);
    assert.equal((await outbox(emailC)).slice(mailsBefore).filter((m) => /^Your Plus trial ends /.test(m.subject)).length, 1, 'exactly one reminder');
    step(`test clock advanced to 2 days before the end: Stripe sent trial_will_end and the owner got one "${reminder.subject.replace(/\d{4}/, 'YYYY')}" email with a Keep Pro link`);

    await advance(subC.trial_end + 3600);
    const cEnded = await until(() => { const s = sget(`/v1/subscriptions/${subC.id}`); return s.status !== 'trialing' ? s : null; }, 60000, 2000);
    assert.equal(cEnded && cEnded.status, 'canceled');
    st = await until(async () => { const s = await status(calC, cara.cookie); return s.paused ? s : null; });
    assert.ok(st, 'clock trial never fell back to paused'); assert.deepEqual([st.locked, st.lapsedOwner], [false, true]);
    step('test clock advanced past the end with no card: Stripe canceled it, the calendar fell back to read-only (paused)');

    console.log(`\n${n} checks passed`);
} finally {
    if (clockId) { try { stripe(['delete', `/v1/test_helpers/test_clocks/${clockId}`, '--confirm']); } catch {} }
    await browser.close();
}
process.exit(0);
