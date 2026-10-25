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

// Every calendar here is created by AUTHOR (the creating browser's author uid). Trial, checkout and a trial
// link's verify carry it unless the test sets `author` itself (a stranger's uid, or '' for none).
const AUTHOR = `author-${run}`;
const CREATOR_PATHS = new Set(['/api/pro/trial', '/api/pro/checkout', '/api/auth/verify']);
const post = (path, body, cookie) => fetch(BASE + path, {
    method: 'POST', body: JSON.stringify(CREATOR_PATHS.has(path) && body && body.author === undefined ? { ...body, author: AUTHOR } : body),
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
    const r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: { 'CF-Connecting-IP': `10.41.${Math.floor(++ip / 200)}.${ip % 200}` },   // creates are limited per address
        body: JSON.stringify({ title: `Team ${id}`, options: {}, events: [ev('a', 'first', 1)], author: AUTHOR }) });
    assert.equal(r.status, 201, await r.text());
}
// One browser tab on the calendar's socket; cookie = signed in (the Worker turns it into the owner's id).
function tab(id, cookie, author) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(id)}/ws${author ? `?author=${enc(author)}` : ''}`, cookie ? { headers: { Cookie: cookie, Origin: BASE } } : undefined);
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
    assert.equal(st.locked, true); assert.equal(st.isOwner, true); assert.equal(st.trialUsed, true); assert.equal(st.lapsedMode, 'open', 'a trial ends open unless the owner chooses read-only');
    const daysLeft = (st.trial.endsAt * 1000 - Date.now()) / 86400000;
    assert.ok(daysLeft > 29.9 && daysLeft <= 30, `trial ends in 30 days (got ${daysLeft})`);
    assert.equal(st.trial.hasCard, false);
    const welcome = (await outbox(annEmail)).at(-1);
    assert.match(welcome.subject, /^Your Plus trial is on for /);
    assert.match(welcome.text, /No card is on file, so nothing will be charged/);
    step('a sign-in link from "Try Pro free" starts a 30-day trial on verify: direct subscription, no card, cancel at the end; the calendar is locked for that user');

    // --- Only an editor of record can upgrade: the browser that made it, or one that edited it on 2+ days.
    const calS = `strange-${run}`; await createCalendar(calS);
    const eve = await signIn(`eve-trial-${run}@example.com`);
    const NOT_EDITOR = 'To upgrade, use a device you’ve edited this calendar on, or ask the person who runs it.';
    const refusedFor = async (author, cookie) => {
        let x = await post('/api/pro/trial', { calendarId: calS, author }, cookie);
        assert.equal(x.status, 403); assert.deepEqual(await x.json(), { error: 'not-an-editor', message: NOT_EDITOR });
        x = await post('/api/pro/checkout', { calendarId: calS, author }, cookie);
        assert.equal(x.status, 403); assert.equal((await x.json()).error, 'not-an-editor');
        x = await post('/api/pro/checkout', { calendarId: calS, author });                       // signed out, pay first
        assert.equal(x.status, 403); assert.equal((await x.json()).error, 'not-an-editor');
    };
    await refusedFor('someone-else', eve.cookie);                                                // only knows the URL
    await refusedFor('', eve.cookie);                                                            // no uid at all
    const viewer = tab(calS, null, 'just-looked'); await viewer.ready; viewer.close();          // opened it, never edited
    await refusedFor('just-looked', eve.cookie);
    const once = tab(calS, null, 'edited-once'); await once.ready;
    assert.equal((await once.save([{ type: 'add', event: ev('o1', 'one edit', 3) }])).t, 'ack'); once.close();
    await refusedFor('edited-once', eve.cookie);                                                 // one edit, one day: not enough
    // A trial link's verify without an editor's uid signs in but starts nothing (the calendar page continues it).
    await post('/api/auth/start', { email: `eve-trial-${run}@example.com`, next: `/${enc(calS)}?pro=trial` });
    const eveMail = (await outbox(`eve-trial-${run}@example.com`)).at(-1);
    const ev2 = await (await post('/api/auth/verify', { token: eveMail.text.match(/#t=([A-Za-z0-9_-]+)/)[1], author: 'someone-else' })).json();
    assert.deepEqual(ev2.trial, { ok: false, error: 'not-an-editor' });
    st = await status(calS);
    assert.deepEqual([st.locked, st.trialUsed], [false, false], 'nothing locked, the trial not used up');
    // The uids are never public: the author signal is admin-only, and no history entry carries an author uid.
    assert.equal((await fetch(`${BASE}/cal/${enc(calS)}/authors`)).status, 403);
    const authorsAdmin = await (await admin(`/cal/${enc(calS)}/authors`)).json();
    assert.ok(authorsAdmin.some((a) => a.uid === AUTHOR && a.createdHere), 'the creator is recorded');
    const pub = JSON.stringify(await (await fetch(`${BASE}/cal/${enc(calS)}/history`)).json()) + JSON.stringify(await getCal(calS));
    for (const uid of [AUTHOR, 'edited-once', 'just-looked']) assert.ok(!pub.includes(uid), `${uid} not in history or GET`);
    step('only an editor of record can upgrade: someone who only has the URL, opened it, or edited once on one day gets 403 not-an-editor (trial and checkout, signed in or out); a trial link without an editor\'s uid starts nothing; author uids are never public');

    // A second device: edited on 2 days. It can upgrade, and since it isn't the creator, the creator can undo it for 7 days.
    const two = tab(calS, null, 'second-device'); await two.ready;
    assert.equal((await two.save([{ type: 'add', event: ev('t1', 'second device', 4) }])).t, 'ack'); two.close();
    assert.equal((await admin(`/cal/${enc(calS)}/authors`, { method: 'POST', body: JSON.stringify({ uid: 'second-device', day: '2026-01-02' }) })).status, 200);
    const gus = await signIn(`gus-trial-${run}@example.com`);
    let r0 = await post('/api/pro/trial', { calendarId: calS, author: 'second-device' }, gus.cookie);
    assert.equal(r0.status, 200, 'an editor of record on a second device can start the trial');
    assert.equal((await status(calS, gus.cookie)).isOwner, true);
    const notice = async (author) => (await (await post('/api/pro/upgrade-notice', { calendarId: calS, author })).json()).notice;
    assert.ok((await notice(AUTHOR)).at > 0, 'the creator sees the notice');
    for (const a of ['second-device', 'someone-else', 'edited-once', '']) assert.equal(await notice(a), null, `no notice for ${a || 'nobody'}`);
    for (const a of ['someone-else', 'edited-once', 'second-device', '']) {
        const x = await post('/api/pro/undo-upgrade', { calendarId: calS, author: a });
        assert.equal(x.status, 403, `${a || 'nobody'} cannot undo`);
    }
    r0 = await post('/api/pro/undo-upgrade', { calendarId: calS, author: AUTHOR });
    assert.equal(r0.status, 200); assert.deepEqual(await r0.json(), { ok: true, refunded: false });
    const gusSub = [...fake.subs.values()].find((x) => x.metadata.calendar_id === calS);
    assert.equal(fake.subs.get(gusSub.id).status, 'canceled', 'the trial is canceled in Stripe');
    st = await status(calS);
    assert.deepEqual([st.locked, st.paused, st.trialUsed], [false, false, false]);
    assert.ok((await (await fetch(`${BASE}/cal/${enc(calS)}/history`)).json()).some((h) => h.label === 'Upgrade undone'), 'Activity says so');
    assert.equal((await post('/api/pro/undo-upgrade', { calendarId: calS, author: AUTHOR })).status, 404, 'nothing left to undo');
    assert.equal((await webhook(event('customer.subscription.deleted', { id: gusSub.id, object: 'subscription' }))).status, 200);
    assert.equal((await status(calS)).locked, false, 'the late webhook changes nothing');
    step('an editor of record on a second device (2 days of edits) can upgrade; for 7 days the creator, and only the creator or another editor of record, sees the notice and can undo it: trial canceled, unlocked (not paused), Activity says "Upgrade undone", the trial freed');

    let r = await post('/api/pro/trial', { calendarId: cal }, ann.cookie);
    assert.equal(r.status, 200); assert.equal((await r.json()).already, true);
    assert.equal(fake.log.filter((l) => l.method === 'POST' && l.path === '/stripe/v1/subscriptions' && l.body['metadata[calendar_id]'] === cal).length, 1);
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
    assert.match(reminder.text, /goes back to a free calendar anyone with the edit link can change/);
    step('trial_will_end sends one "Your Plus trial ends <date>" email with a Keep Plus link (a repeat event sends nothing)');

    // --- Day 30, no card, and the owner chose read-only: Stripe cancels it -> FREE and READ-ONLY.
    assert.equal((await post('/api/pro/lapsed-mode', { calendarId: cal, mode: 'readonly' }, ann.cookie)).status, 200);
    assert.equal((await status(cal, ann.cookie)).lapsedMode, 'readonly');
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
    step('no card by day 30, read-only chosen: subscription deleted -> free and read-only (paused): every tab is told, saves refused "Editing is paused by the owner.", the owner too; GET and the .ics feed work; Firebase/import/new view links refused');

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

    // --- A trial that ends with no choice made goes back to OPEN (a squatter's trial can never freeze a calendar).
    const calO = `open-end-${run}`; await createCalendar(calO);
    const dave = await signIn(`dave-trial-${run}@example.com`);
    assert.equal((await post('/api/pro/trial', { calendarId: calO }, dave.cookie)).status, 200);
    const daveSub = [...fake.subs.values()].find((x) => x.metadata.calendar_id === calO);
    fake.subs.get(daveSub.id).status = 'canceled';
    assert.equal((await webhook(event('customer.subscription.deleted', { id: daveSub.id, object: 'subscription' }))).status, 200);
    st = await status(calO, dave.cookie);
    assert.deepEqual([st.locked, st.paused, st.lapsedOwner], [false, false, false]);
    const openTab = tab(calO); snap = await openTab.ready;
    assert.deepEqual([snap.locked, snap.paused, snap.canEdit], [false, false, true]);
    assert.equal((await openTab.save([{ type: 'add', event: ev('o1', 'anyone edits', 5) }])).t, 'ack');
    openTab.close();
    step('a trial that ends with no choice made goes back to open: a normal free calendar anyone with the link can edit');

    // --- Support: reset a calendar's trial (someone else trialed it): canceled in Stripe, unlocked (not paused), trial freed.
    const calR = `reset-${run}`; await createCalendar(calR);
    const fay = await signIn(`fay-trial-${run}@example.com`);
    assert.equal((await post('/api/pro/trial', { calendarId: calR }, fay.cookie)).status, 200);
    assert.equal((await status(calR)).locked, true);
    assert.equal((await fetch(BASE + '/api/admin/accounts/reset-trial', { method: 'POST', body: JSON.stringify({ calendarId: calR }), headers: { 'Content-Type': 'application/json' } })).status, 403);
    r = await admin('/api/admin/accounts/reset-trial', { method: 'POST', body: JSON.stringify({ calendarId: calR }) });
    assert.equal(r.status, 200);
    const reset = await r.json();
    assert.equal(reset.unlocked, true); assert.equal(reset.canceled.length, 1);
    assert.equal(fake.subs.get(reset.canceled[0]).status, 'canceled', 'canceled in Stripe');
    st = await status(calR);
    assert.deepEqual([st.locked, st.paused, st.trialUsed], [false, false, false]);
    const resetTab = tab(calR); snap = await resetTab.ready;
    assert.equal(snap.canEdit, true); resetTab.close();
    step('support reset-trial (Bearer only): cancels the trial in Stripe, unlocks without pausing, and frees the calendar\'s trial');

    // --- The undo after a PAID upgrade refunds it; after 7 days only support can undo.
    const secondDevice = async (calId, uid) => {
        const t = tab(calId, null, uid); await t.ready;
        assert.equal((await t.save([{ type: 'add', event: ev(`${uid}-e`, 'helper edit', 6) }])).t, 'ack'); t.close();
        assert.equal((await admin(`/cal/${enc(calId)}/authors`, { method: 'POST', body: JSON.stringify({ uid, day: '2026-01-03' }) })).status, 200);
    };
    const calP = `undo-paid-${run}`; await createCalendar(calP); await secondDevice(calP, 'hal-device');
    const hal = await signIn(`hal-trial-${run}@example.com`);
    assert.equal((await post('/api/pro/checkout', { calendarId: calP, author: 'hal-device' }, hal.cookie)).status, 200);
    fake.subs.set(`sub_${run}_hal`, { id: `sub_${run}_hal`, object: 'subscription', status: 'active', customer: `cus_${run}_hal`, latest_invoice: `in_${run}_hal`,
        metadata: { calendar_id: calP, user_id: hal.userId }, created: Math.floor(Date.now() / 1000),
        items: { data: [{ current_period_end: 1830000000, price: { id: 'price_fake_yearly', recurring: { interval: 'year' } } }] } });
    fake.invoices.set(`in_${run}_hal`, { id: `in_${run}_hal`, amount_paid: 2900, payment_intent: `pi_${run}_hal`, subscription: `sub_${run}_hal` });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_hal` }))).status, 200);
    assert.equal((await status(calP, hal.cookie)).isOwner, true);
    r = await post('/api/pro/undo-upgrade', { calendarId: calP, author: AUTHOR });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, refunded: true });
    assert.equal(fake.refunds.filter((x) => x.payment_intent === `pi_${run}_hal`).length, 1, 'refunded once');
    assert.equal(fake.subs.get(`sub_${run}_hal`).status, 'canceled');
    st = await status(calP);
    assert.deepEqual([st.locked, st.paused], [false, false]);

    const calQ = `undo-late-${run}`; await createCalendar(calQ); await secondDevice(calQ, 'ivy-device');
    const ivy = await signIn(`ivy-trial-${run}@example.com`);
    assert.equal((await post('/api/pro/trial', { calendarId: calQ, author: 'ivy-device' }, ivy.cookie)).status, 200);
    await admin('/api/admin/accounts/age-upgrade', { method: 'POST', body: JSON.stringify({ calendarId: calQ, ageMs: 8 * 86400000 }) });
    assert.equal((await (await post('/api/pro/upgrade-notice', { calendarId: calQ, author: AUTHOR })).json()).notice, null, 'no notice after 7 days');
    r = await post('/api/pro/undo-upgrade', { calendarId: calQ, author: AUTHOR });
    assert.equal(r.status, 410); assert.equal((await r.json()).error, 'too-late');
    assert.equal((await status(calQ)).locked, true);
    step('undoing a paid upgrade refunds it (once) and cancels it; after 7 days the undo is refused (410) and only support can reset it');

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
    r = await post('/api/pro/checkout', { calendarId: cal3, interval: 'year' }, ann.cookie);
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
    r = await post('/api/pro/checkout', { calendarId: cal2, interval: 'year' }, carl.cookie);
    assert.equal(r.status, 200, 'the trialing owner may check out');
    const cs = fake.log.filter((l) => l.path === '/stripe/v1/checkout/sessions').at(-1);
    assert.equal(cs.body['line_items[0][price]'], 'price_fake_yearly');
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
    step('Keep Plus during a trial is the normal checkout ($29/year); the paid subscription replaces the trial (canceled, not refunded), the lock stays');

    // --- Billing goes to the right Stripe customer: Manage billing opens the named calendar's own customer, and a
    // checkout never reuses a trial's customer (a card saved there would turn that trial into a charge).
    const jo = await signIn(`jo-trial-${run}@example.com`);
    const calJ1 = `jo-trial-${run}`, calJ2 = `jo-paid-${run}`; await createCalendar(calJ1); await createCalendar(calJ2);
    assert.equal((await post('/api/pro/trial', { calendarId: calJ1 }, jo.cookie)).status, 200);
    const joTrialCus = [...fake.subs.values()].find((x) => x.metadata.calendar_id === calJ1).customer;
    let mark = fake.log.length;
    assert.equal((await post('/api/pro/checkout', { calendarId: calJ2 }, jo.cookie)).status, 200);
    const joCheckout = fake.log.slice(mark).find((l) => l.method === 'POST' && l.path === '/stripe/v1/checkout/sessions');
    assert.notEqual(joCheckout.body.customer, joTrialCus, 'never the trial\'s customer');
    assert.equal(joCheckout.body.customer_email, `jo-trial-${run}@example.com`, 'a fresh customer from the email');
    fake.subs.set(`sub_${run}_jo`, { id: `sub_${run}_jo`, object: 'subscription', status: 'active', customer: `cus_${run}_jo_paid`, metadata: { calendar_id: calJ2, user_id: jo.userId },
        created: Math.floor(Date.now() / 1000), items: { data: [{ current_period_end: 1830000000, price: { id: 'price_fake_yearly', recurring: { interval: 'year' } } }] } });
    assert.equal((await webhook(event('customer.subscription.created', { id: `sub_${run}_jo` }))).status, 200);
    // A newer trial row update must not move Manage billing for the paid calendar.
    await webhook(event('customer.subscription.trial_will_end', { id: [...fake.subs.values()].find((x) => x.metadata.calendar_id === calJ1).id, object: 'subscription' }));
    const portalCustomer = async (calendarId) => {
        const m = fake.log.length;
        assert.equal((await post('/api/pro/portal', calendarId ? { calendarId } : {}, jo.cookie)).status, 200);
        return fake.log.slice(m).find((l) => l.path === '/stripe/v1/billing_portal/sessions').body.customer;
    };
    assert.equal(await portalCustomer(calJ2), `cus_${run}_jo_paid`, 'the paid calendar opens its own customer');
    assert.equal(await portalCustomer(calJ1), joTrialCus, 'the trial calendar opens the trial\'s customer');
    assert.equal(await portalCustomer(null), `cus_${run}_jo_paid`, 'no calendar named: the paid customer');
    mark = fake.log.length;
    const calJ3 = `jo-more-${run}`; await createCalendar(calJ3);
    assert.equal((await post('/api/pro/checkout', { calendarId: calJ3 }, jo.cookie)).status, 200);
    assert.equal(fake.log.slice(mark).find((l) => l.path === '/stripe/v1/checkout/sessions').body.customer, `cus_${run}_jo_paid`, 'a later checkout reuses the paid customer');
    step('Manage billing opens the named calendar\'s own Stripe customer (paid or trial), and checkout reuses only a paid customer, never a trial\'s');

    // Plus is yearly only: a monthly checkout is refused even though this server has a monthly price set.
    const calM = `monthly-${run}`; await createCalendar(calM);
    mark = fake.log.length;
    r = await post('/api/pro/checkout', { calendarId: calM, interval: 'month' }, jo.cookie);
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'bad-interval', message: 'Plus is yearly: $29 a year.' });
    assert.equal(fake.log.slice(mark).filter((l) => l.path === '/stripe/v1/checkout/sessions').length, 0);
    step('Plus is yearly only: interval "month" is refused (400) and no Checkout page is made');

    anonTab.close(); ownerTab.close();
    console.log(`\n${n} checks passed`);
} finally {
    fake.close();
}
