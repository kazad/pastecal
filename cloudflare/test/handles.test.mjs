// Pro Plus (internally Pro Unlimited) names and /account: @handle, calendars under it, top-level short names,
// the 10-calendar cap with the @handle exemption, view-only enforcement, lapse + the 90-day hold, account delete.
// REAL calendar rooms and fake Stripe, the same single `wrangler dev` as unlimited.test.mjs:
//   node node_modules/.bin/wrangler dev --port 8827 --inspector-port 9247 --persist-to /tmp/pc-unlimited-state \
//     --var COPY_BACK: --var FIREBASE_DB_URL: --var IMPORT_SECRET:dev-secret --var ACCOUNTS_DEV_MODE:1 \
//     --var STRIPE_SECRET_KEY:fake-stripe-key --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret \
//     --var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly \
//     --var STRIPE_PRICE_UNLIMITED_YEARLY:price_fake_unl_yearly --var STRIPE_PRICE_UNLIMITED_MONTHLY:price_fake_unl_monthly \
//     --var STRIPE_API_BASE:http://127.0.0.1:8832/stripe
//   BASE=http://localhost:8827 node test/handles.test.mjs        (FAKE_PORT if fake Stripe is not on 8832)
import assert from 'node:assert/strict';
import { startFakeStripe, signStripe } from './fake-stripe.mjs';

const BASE = process.env.BASE || 'http://localhost:8827', SECRET = process.env.IMPORT_SECRET || 'dev-secret', WHSEC = 'fake-webhook-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const fake = await startFakeStripe(Number(process.env.FAKE_PORT || 8832));
let ip = 0;
const post = (path, body, cookie) => fetch(BASE + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': `10.60.${Math.floor(++ip / 200)}.${ip % 200}`, ...(cookie ? { Cookie: cookie } : {}) },
});
const pj = async (path, body, cookie) => { const r = await post(path, body, cookie); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const get = (path, cookie) => fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });
const admin = (path, init = {}) => fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } });
const outbox = async (email) => (await (await admin(`/api/admin/accounts/outbox?email=${enc(email)}`)).json()).emails;
const userIdOf = async (email) => (await (await admin(`/api/admin/accounts/lookup?email=${enc(email)}`)).json()).user.id;
async function signIn(email) {
    await post('/api/auth/start', { email });
    const token = (await outbox(email)).at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    return { cookie: r.headers.get('set-cookie').split(';')[0], userId: await userIdOf(email), email };
}
const lockStatus = async (id) => (await admin(`/api/admin/cal/${enc(id)}/lock-status`)).json();
const account = async (cookie) => (await get('/api/account', cookie)).json();
const webhook = (event) => {
    const body = JSON.stringify(event);
    return fetch(BASE + '/api/stripe/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) } });
};
let evN = 0;
const event = (type, object) => ({ id: `evt_names_${run}_${++evN}`, object: 'event', type, data: { object } });
async function createCalendar(id, title) {
    const r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: { 'CF-Connecting-IP': `10.61.${Math.floor(++ip / 200)}.${ip % 200}` }, body: JSON.stringify({ title, options: {}, events: [{ id: 'e1', title: 'Practice', start: '2026-11-01T10:00:00.000Z', end: '2026-11-01T11:00:00.000Z' }] }) });
    assert.equal(r.status, 201, await r.text());
}
const now = () => Math.floor(Date.now() / 1000);
const paidSub = (id, customer, userId, status = 'active') => ({ id, object: 'subscription', status, customer, metadata: { plan: 'unlimited', user_id: userId }, created: now(),
    items: { data: [{ current_period_end: 1830000000, price: { id: 'price_fake_unl_yearly', recurring: { interval: 'year' } } }] } });
async function giveUnlimited(who, tag) {
    const id = `sub_names_${run}_${tag}`;
    fake.subs.set(id, paidSub(id, `cus_${run}_${tag}`, who.userId));
    assert.equal((await webhook(event('customer.subscription.created', { id }))).status, 200);
    return id;
}
async function endUnlimited(id, who, tag) {
    const ended = { ...paidSub(id, `cus_${run}_${tag}`, who.userId), status: 'canceled' };
    fake.subs.set(id, ended);
    assert.equal((await webhook(event('customer.subscription.deleted', ended))).status, 200);
}
// The response must never carry the calendar's edit id: not in the body, not in a header.
async function noEditId(res, editId, what) {
    const text = await res.text();
    assert.ok(!text.includes(editId), `${what}: the body holds the edit id`);
    for (const [k, v] of res.headers) assert.ok(!v.includes(editId), `${what}: header ${k} holds the edit id`);
    return text;
}

try {
    const ann = await signIn(`ann-names-${run}@example.com`);
    const h = `ann-${run}`.slice(0, 30);

    // --- /api/account
    assert.equal((await get('/api/account')).status, 401);
    let a = await account(ann.cookie);
    assert.equal(a.email, ann.email); assert.equal(a.plan, null); assert.equal(a.handle, null);
    assert.equal((await pj('/api/names/handle', { handle: h }, ann.cookie)).status, 403, 'no Pro Plus: no name');
    const subA = await giveUnlimited(ann, 'ann');
    a = await account(ann.cookie);
    assert.equal(a.plan, 'unlimited'); assert.equal(a.active, true); assert.equal(a.proCount, 0); assert.equal(a.proLimit, 10);
    step('/api/account: 401 signed out; plan, Pro calendars 0 of 10; a name needs Pro Plus (403)');

    // --- claim a handle
    let r = await pj('/api/names/handle', { handle: 'ab' }, ann.cookie);
    assert.equal(r.status, 400); assert.equal(r.d.error, 'bad-name');
    for (const bad of ['pricing', 'account', 'api', '-ann', 'an_n', '@ann', 'pastecal', 'PasteCal', 'pastecal-team', 'pa5tecal', 'official', 'staff', 'support', 'billing', 'security', 'adrnin']) {
        r = await pj('/api/names/handle', { handle: bad }, ann.cookie);
        assert.equal(r.status, 400, bad); assert.equal(r.d.error, 'bad-name', bad);
    }
    r = await pj('/api/names/handle', { handle: h.toUpperCase() }, ann.cookie);
    assert.equal(r.status, 200); assert.equal(r.d.handle, h, 'stored lowercase');
    assert.equal((await pj('/api/names/handle', { handle: `zz${run}` }, ann.cookie)).d.error, 'has-handle', 'claimed once');
    const bob = await signIn(`bob-names-${run}@example.com`);
    const subB = await giveUnlimited(bob, 'bob');
    r = await pj('/api/names/handle', { handle: h.toUpperCase() }, bob.cookie);
    assert.equal(r.status, 409); assert.equal(r.d.error, 'taken', 'unique, case-insensitive');
    step('claim @handle: format and reserved words refused (400), stored lowercase, once per account, unique case-insensitively');

    // --- a new calendar under the handle
    r = await pj('/api/names/calendar', { name: 'Soccer', title: 'U10 Soccer' }, ann.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.d));
    const soccer = r.d.calendarId;
    assert.equal(r.d.path, `/@${h}/soccer`);
    let st = await lockStatus(soccer);
    assert.deepEqual([st.locked, st.ownerId, st.title], [true, ann.userId, 'U10 Soccer']);
    assert.equal((await pj('/api/names/calendar', { name: 'soccer' }, ann.cookie)).d.error, 'name-taken');
    a = await account(ann.cookie);
    assert.equal(a.proCount, 0, 'under the handle it does not count toward the 10');
    const row = a.calendars.find((c) => c.id === soccer);
    assert.deepEqual([row.state, row.atName, row.show, row.title], ['unlimited', 'soccer', false, 'U10 Soccer']);
    step('new calendar under @handle: made, locked for its owner under Pro Plus, owned (in /api/account), not counted toward the 10');

    // --- the @ link is view-only and never shows the edit id
    let res = await get(`/@${h}/soccer`);
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/html/);
    let html = await noEditId(res, soccer, '@ page');
    const alias = /<meta name="pc-view" content="([a-z0-9]+)">/.exec(html)[1];
    assert.match(html, new RegExp(`<meta name="pc-at" content="@${h}/soccer">`));
    assert.equal((await get(`/@${h.toUpperCase()}/SOCCER`)).status, 200, 'case-insensitive');
    res = await get(`/cal/view/${alias}`);
    const viewText = await noEditId(res.clone(), soccer, 'view JSON');
    assert.equal(JSON.parse(viewText).calendar.title, 'U10 Soccer');
    res = await get(`/@${h}/soccer.ics`);
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/calendar/);
    const ics = await noEditId(res, soccer, '@ feed');
    assert.match(ics, /X-WR-CALNAME:U10 Soccer/); assert.match(ics, /PRODID:-\/\/PasteCal\/\/a[a-z0-9]+\/\/EN/, 'named by its hidden view name');
    // Writing through the view is impossible: the room treats ?view= as read-only (no write route exists for it).
    const ws = await fetch(`${BASE}/cal/view/${alias}`, { method: 'PUT', body: '{}' });
    assert.notEqual(ws.status, 200);
    assert.equal((await lockStatus(soccer)).locked, true);
    assert.equal((await get(`/@${h}/nope`)).status, 404);
    assert.equal((await get(`/@nobody-${run}/soccer`)).status, 404);
    step('/@handle/soccer: the view page (pc-view alias, never the edit id in body or headers), view JSON and .ics the same; unknown names 404');

    // --- the handle page: neutral until something is shown; titles escaped
    res = await get(`/@${h}`);
    assert.equal(res.status, 200);
    html = await noEditId(res, soccer, 'handle page');
    assert.match(html, new RegExp(`data-testid="handle-name">@${h}<`)); assert.match(html, /data-testid="handle-empty"/);
    r = await pj('/api/names/calendar', { name: 'xss', title: '<img src=x onerror=alert(1)>"&' }, ann.cookie);
    const xss = r.d.calendarId;
    assert.equal((await pj('/api/names/show', { calendarId: soccer, show: true }, ann.cookie)).status, 200);
    assert.equal((await pj('/api/names/show', { calendarId: xss, show: true }, ann.cookie)).status, 200);
    html = await noEditId(await get(`/@${h}`), soccer, 'handle page');
    assert.ok(!html.includes(xss), 'no edit id of the other calendar either');
    assert.match(html, new RegExp(`href="/@${h}/soccer"`)); assert.match(html, /U10 Soccer/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&amp;/); assert.ok(!html.includes('<img src=x'));
    assert.equal((await pj('/api/names/show', { calendarId: xss, show: false }, ann.cookie)).status, 200);
    assert.ok(!(await (await get(`/@${h}`)).text()).includes('onerror'), 'hidden again at once (cache purged)');
    assert.equal((await get(`/@nobody-${run}`)).status, 404);
    step('/@handle: a neutral page until calendars are shown; then their titles (escaped) and links, no edit ids; show/hide takes effect at once; unknown 404');

    // --- an existing calendar gets an @name; rename; remove
    const club = `club-${run}`;
    await createCalendar(club, 'Book club');
    assert.equal((await pj('/api/pro/lock', { calendarId: club }, ann.cookie)).status, 200);
    assert.equal((await account(ann.cookie)).proCount, 1);
    assert.equal((await pj('/api/names/link', { calendarId: club, name: 'books' }, ann.cookie)).status, 200);
    assert.equal((await account(ann.cookie)).proCount, 0, 'moved under the handle');
    assert.equal((await get(`/@${h}/books`)).status, 200);
    assert.equal((await pj('/api/names/link', { calendarId: club, name: 'soccer' }, ann.cookie)).d.error, 'name-taken');
    assert.equal((await pj('/api/names/link', { calendarId: club, name: 'reading' }, ann.cookie)).status, 200);
    assert.equal((await get(`/@${h}/books`)).status, 404, 'the old name stops at once');
    assert.equal((await get(`/@${h}/reading`)).status, 200);
    assert.equal((await pj('/api/names/link', { calendarId: club, name: 'x' }, bob.cookie)).status, 404, 'bob has no handle');
    await pj('/api/names/handle', { handle: `bob-${run}`.slice(0, 30) }, bob.cookie);
    assert.equal((await pj('/api/names/link', { calendarId: club, name: 'mine' }, bob.cookie)).d.error, 'not-owner', 'not his calendar');
    assert.equal((await pj('/api/names/unlink', { calendarId: club }, ann.cookie)).status, 200);
    assert.equal((await get(`/@${h}/reading`)).status, 404);
    assert.equal((await account(ann.cookie)).proCount, 1);
    step('existing calendar: @name moves it under the handle (not counted), rename (old name 404), someone else\'s refused, remove (counted again)');

    // --- the 10 cap and the @handle exemption
    const extra = [];
    for (let i = 0; i < 10; i++) { const id = `cap${i}-${run}`; extra.push(id); await createCalendar(id, `Cap ${i}`); }
    for (const id of extra.slice(0, 9)) assert.equal((await pj('/api/pro/lock', { calendarId: id }, ann.cookie)).status, 200, id);
    assert.equal((await account(ann.cookie)).proCount, 10);
    const st11 = await (await get(`/api/pro/status?calendar=${enc(extra[9])}`, ann.cookie)).json();
    assert.deepEqual([st11.unlimited, st11.unlimitedFull, st11.handle], [true, true, h]);
    r = await pj('/api/pro/lock', { calendarId: extra[9] }, ann.cookie);
    assert.equal(r.status, 409); assert.equal(r.d.error, 'unlimited-full');
    assert.equal((await lockStatus(extra[9])).locked, false);
    assert.equal((await pj('/api/names/link', { calendarId: extra[9], name: 'cap-ten' }, ann.cookie)).status, 200, 'under the handle it can still be Pro');
    st = await lockStatus(extra[9]);
    assert.deepEqual([st.locked, st.ownerId], [true, ann.userId]);
    assert.equal((await account(ann.cookie)).proCount, 10);
    assert.equal((await pj('/api/names/calendar', { name: 'more' }, ann.cookie)).status, 200, 'new calendars under the handle: no limit');
    r = await pj('/api/names/unlink', { calendarId: extra[9] }, ann.cookie);
    assert.equal(r.status, 409); assert.equal(r.d.error, 'unlimited-full', 'can\'t leave the handle past the 10');
    assert.equal((await pj('/api/pro/lock', { calendarId: club }, ann.cookie)).d.already, true, 'an already-covered calendar is fine');
    step('the cap: 10 Pro calendars outside @handle (11th 409 unlimited-full, status says so), unlimited under it (link moves + locks a free calendar; new ones), unlink refused past 10');

    // --- top-level short names
    const s1 = `go-${run}`.slice(0, 30);
    r = await pj('/api/names/short', { name: s1, calendarId: club }, ann.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.d));
    let look = await (await get(`/api/lookup?slug=${s1}`)).json();
    assert.deepEqual(look, { found: true, actualSlug: s1, isReadOnly: true }, 'the app opens it as a view page; no target id');
    res = await get(`/${s1}.ics`);
    assert.equal(res.status, 200);
    assert.match(await noEditId(res, club, 'short feed'), /X-WR-CALNAME:Book club/);
    assert.equal(JSON.parse(await noEditId(await get(`/cal/view/${s1}`), club, 'short view')).calendar.title, 'Book club');
    assert.equal((await pj('/api/names/short', { name: s1, calendarId: extra[0] }, bob.cookie)).d.error, 'not-owner');
    await createCalendar(`bobcal-${run}`, 'Bob');
    await pj('/api/pro/lock', { calendarId: `bobcal-${run}` }, bob.cookie);
    assert.equal((await pj('/api/names/short', { name: s1, calendarId: `bobcal-${run}` }, bob.cookie)).d.error, 'taken');
    const existing = `existing-${run}`;
    await createCalendar(existing, 'Somebody else');
    assert.equal((await pj('/api/names/short', { name: existing, calendarId: club }, ann.cookie)).d.error, 'taken', 'a calendar keeps its address');
    for (const reserved of ['pricing', 'api', 'view', 'signin', 'account', 'handle', 'pricing-next', 'poll', 'pastecal', 'sign-in', 'log-in', 'favicon', 'sitemap', 'official', 'help']) {
        assert.equal((await pj('/api/names/short', { name: reserved, calendarId: club }, ann.cookie)).status, 400, reserved);
    }
    const vr = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: existing, customSlug: `vw-${run}` }) });
    assert.equal(vr.status, 200, await vr.clone().text());
    assert.equal((await pj('/api/names/short', { name: `vw-${run}`, calendarId: club }, ann.cookie)).d.error, 'taken', 'a view link keeps its name');
    // Nobody can make a calendar that a short name (or a view name) already answers for, or one starting with "@".
    assert.equal((await fetch(`${BASE}/cal/${s1}`, { method: 'POST', body: JSON.stringify({ title: 'x', options: {}, events: [] }) })).status, 409);
    assert.equal((await fetch(`${BASE}/cal/${enc('@' + h)}`, { method: 'POST', body: JSON.stringify({ title: 'x', options: {}, events: [] }) })).status, 409);
    step('short name: claimed for your calendar; the app\'s lookup says read-only (no target), feed + view JSON with no edit id; refused when taken, a calendar\'s or view link\'s name, or reserved (site pages, pastecal*, staff words); no calendar can take it, or start with @');

    const shorts = [s1];
    for (let i = 1; i < 10; i++) { const nm = `s${i}-${run}`.slice(0, 30); assert.equal((await pj('/api/names/short', { name: nm, calendarId: extra[i] }, ann.cookie)).status, 200, nm); shorts.push(nm); }
    r = await pj('/api/names/short', { name: `s10-${run}`.slice(0, 30), calendarId: club }, ann.cookie);
    assert.equal(r.status, 409); assert.equal(r.d.error, 'short-limit');
    assert.equal((await pj('/api/names/short/remap', { name: s1, calendarId: soccer }, ann.cookie)).status, 200);
    assert.equal(JSON.parse(await (await get(`/cal/view/${s1}`)).text()).calendar.title, 'U10 Soccer', 'remapped');
    const ownerSt = await (await get(`/api/pro/status?calendar=${enc(soccer)}`, ann.cookie)).json();
    assert.deepEqual([ownerSt.atName, ownerSt.shortNames, ownerSt.otherShortNames.length], ['soccer', [s1], 9], 'the owner panel lists its own short links and the ones it could take');
    assert.equal((await pj('/api/names/short/remap', { name: s1, calendarId: `bobcal-${run}` }, ann.cookie)).d.error, 'not-owner');
    assert.equal((await pj('/api/names/short/remap', { name: s1, calendarId: club }, bob.cookie)).status, 404, 'not his name');
    a = await account(ann.cookie);
    assert.equal(a.shortNames.length, 10); assert.equal(a.shortLimit, 10); assert.equal(a.holdDays, 90);
    assert.equal((await pj('/api/names/short/release', { name: shorts[9] }, ann.cookie)).status, 200);
    assert.equal((await (await get(`/api/lookup?slug=${shorts[9]}`)).json()).found, false);
    step('short names: 10 at most (409 short-limit), remap to another of yours (not someone else\'s), release frees it');

    // --- lapse: links keep working, nothing can be added or changed; the handle stays theirs
    await endUnlimited(subA, ann, 'ann');
    a = await account(ann.cookie);
    assert.equal(a.plan, null); assert.equal(a.active, false); assert.equal(a.unlimited.status, 'canceled'); assert.equal(a.handle, h);
    assert.equal(a.calendars.find((c) => c.id === soccer).state, 'paused', 'its calendars stay listed, paused');
    assert.equal((await get(`/@${h}/soccer`)).status, 200);
    assert.equal((await get(`/@${h}/soccer.ics`)).status, 200);
    assert.equal((await (await get(`/api/lookup?slug=${s1}`)).json()).found, true);
    for (const [path, body] of [['/api/names/calendar', { name: 'late' }], ['/api/names/link', { calendarId: club, name: 'late' }],
        ['/api/names/short/remap', { name: s1, calendarId: club }], ['/api/names/short', { name: `late-${run}`, calendarId: club }]]) {
        r = await pj(path, body, ann.cookie);
        assert.equal(r.status, 403, path); assert.equal(r.d.error, 'unlimited-ended');
    }
    assert.equal((await pj('/api/names/show', { calendarId: soccer, show: false }, ann.cookie)).status, 200, 'show/hide still works');
    assert.equal((await pj('/api/names/handle', { handle: h }, bob.cookie)).status, 409, 'the handle stays reserved for her');
    step('lapsed: @ links, feeds and short names keep working; adding, renaming and remapping 403 unlimited-ended; calendars listed as paused; the handle stays hers');

    // --- the 90-day hold, then release
    let rel = await (await admin('/api/admin/accounts/age-short-holds', { method: 'POST', body: JSON.stringify({ email: ann.email, ageMs: 89 * 86400000 }) })).json();
    assert.deepEqual(rel.released, []);
    assert.equal((await (await get(`/api/lookup?slug=${s1}`)).json()).found, true);
    rel = await (await admin('/api/admin/accounts/age-short-holds', { method: 'POST', body: JSON.stringify({ email: ann.email, ageMs: 2 * 86400000 }) })).json();
    assert.deepEqual(rel.released.sort(), shorts.slice(0, 9).sort());
    assert.equal((await (await get(`/api/lookup?slug=${s1}`)).json()).found, false);
    assert.equal((await account(ann.cookie)).shortNames.length, 0);
    assert.equal((await pj('/api/names/short', { name: s1, calendarId: `bobcal-${run}` }, bob.cookie)).status, 200, 'free for anyone after the hold');
    assert.equal((await get(`/@${h}/soccer`)).status, 200, '@ links are not released');
    step('90 days after the lapse (time simulated): short names are released (89 days: still held) and anyone can claim them; @ links stay');

    // --- delete account
    r = await pj('/api/account/delete', {}, bob.cookie);
    assert.equal(r.status, 409, 'an active subscription must be canceled first'); assert.equal(r.d.error, 'active-subscription');
    r = await pj('/api/account/delete', {}, ann.cookie);
    assert.equal(r.status, 200); assert.equal(r.d.deleted, true);
    assert.equal((await get('/api/account', ann.cookie)).status, 401, 'signed out everywhere');
    assert.equal((await get(`/@${h}/soccer`)).status, 404, 'links stop');
    assert.equal((await get(`/@${h}`)).status, 404);
    assert.equal((await (await get(`/api/lookup?slug=${alias}`)).json()).found, false, 'the hidden view name is gone');
    st = await lockStatus(soccer);
    assert.equal(st.locked, false); assert.equal(st.lapsed && st.lapsed.mode, 'readonly', 'the calendar stays, paused per its setting');
    assert.equal((await get(`/cal/${soccer}`)).status, 200);
    assert.equal((await pj('/api/names/handle', { handle: h }, bob.cookie)).status, 409, 'a deleted account\'s handle is never reissued');
    step('delete account: refused (409) while billing is active; otherwise sessions end, @ links and their hidden names stop, calendars stay (paused), the handle is never reissued');

    // --- a deleted account's short names: held as tombstones for 90 days, never anyone's calendar meanwhile
    {
        const cory = await signIn(`cory-names-${run}@example.com`), eve = await signIn(`eve-names-${run}@example.com`);
        const subC = await giveUnlimited(cory, 'cory'); await giveUnlimited(eve, 'eve');
        const tigers = `tigers-${run}`, tname = `tg-${run}`.slice(0, 30);
        await createCalendar(tigers, 'Tigers U10');
        assert.equal((await pj('/api/pro/lock', { calendarId: tigers }, cory.cookie)).status, 200);
        assert.equal((await pj('/api/names/short', { name: tname, calendarId: tigers }, cory.cookie)).status, 200);
        await endUnlimited(subC, cory, 'cory');
        assert.equal((await pj('/api/account/delete', {}, cory.cookie)).status, 200);
        const look = await (await get(`/api/lookup?slug=${tname}`)).json();
        assert.deepEqual(look, { found: true, actualSlug: tname, isReadOnly: true, ended: true }, 'a tombstone, never a target');
        assert.equal((await fetch(`${BASE}/cal/${tname}`, { method: 'POST', headers: { 'CF-Connecting-IP': '10.62.0.1' }, body: JSON.stringify({ title: 'Tigers U10 (new link!)', options: {}, events: [] }) })).status, 409, 'nobody can make a calendar there');
        assert.equal((await fetch(`${BASE}/cal/${tname.toUpperCase()}`, { method: 'POST', headers: { 'CF-Connecting-IP': '10.62.0.2' }, body: JSON.stringify({ title: 'x', options: {}, events: [] }) })).status, 409, 'nor in another case');
        const evecal = `evecal-${run}`; await createCalendar(evecal, 'Eve'); await pj('/api/pro/lock', { calendarId: evecal }, eve.cookie);
        const ec = await pj('/api/names/short', { name: tname, calendarId: evecal }, eve.cookie);
        assert.equal(ec.status, 409, 'nor claim it'); assert.equal(ec.d.error, 'taken');
        const cv = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: existing, customSlug: tname }) });
        assert.equal(cv.status, 409, 'nor name a view link after it');
        // The calendar pages are static: the app's lookup sees {ended} and goes to /link-ended/<name> (the Worker's).
        let page = await get(`/link-ended/${tname}`);
        assert.equal(page.status, 410);
        const html = await page.text();
        assert.match(html, /data-testid="link-ended">This link has ended/);
        assert.ok(!html.includes('Tigers') && !html.includes(tigers), 'the ended page names nothing');
        assert.equal(page.headers.get('x-robots-tag'), 'noindex');
        assert.equal((await get(`/link-ended/${s1}`)).status, 404, 'a live name is never called ended');
        assert.equal((await get(`/link-ended/nothing-${run}`)).status, 404);
        assert.equal((await get(`/${tname}.ics`)).status, 410);
        assert.equal((await get(`/view/${tname}.ics`)).status, 410);
        assert.equal((await get(`/cal/view/${tname}`)).status, 410);
        assert.equal((await get(`/cal/${tigers}`)).status, 200, 'the calendar itself stays at its own address');
        // 89 days: still held. Past 90: released, and the name is anyone's (a new free calendar, a new claim).
        let rel = await (await admin('/api/admin/accounts/age-short-holds', { method: 'POST', body: JSON.stringify({ names: [tname], ageMs: 89 * 86400000 }) })).json();
        assert.ok(!rel.released.includes(tname));
        assert.equal((await get(`/link-ended/${tname}`)).status, 410);
        rel = await (await admin('/api/admin/accounts/age-short-holds', { method: 'POST', body: JSON.stringify({ names: [tname], ageMs: 2 * 86400000 }) })).json();
        assert.ok(rel.released.includes(tname), JSON.stringify(rel));
        assert.equal((await (await get(`/api/lookup?slug=${tname}`)).json()).found, false);
        assert.equal((await get(`/link-ended/${tname}`)).status, 404);
        assert.equal((await fetch(`${BASE}/cal/${tname}`, { method: 'POST', headers: { 'CF-Connecting-IP': '10.62.0.3' }, body: JSON.stringify({ title: 'Fresh', options: {}, events: [] }) })).status, 201, 'released: creatable again');
        step('deleted account: each short name is a tombstone (lookup ended, POST /cal 409 in any case, no claim or view link, feeds and view JSON 410, /link-ended/<name> says so (404 for any other name), the calendar stays); released after 90 days, then creatable');
    }

    // --- rate limit on name changes
    const dan = await signIn(`dan-names-${run}@example.com`);
    await giveUnlimited(dan, 'dan');
    await pj('/api/names/handle', { handle: `dan-${run}`.slice(0, 30) }, dan.cookie);
    const d1 = await pj('/api/names/calendar', { name: 'r0' }, dan.cookie);
    let last;
    for (let i = 1; i < 25; i++) { last = await pj('/api/names/link', { calendarId: d1.d.calendarId, name: `r${i}` }, dan.cookie); if (last.status === 429) break; }
    assert.equal(last.status, 429); assert.equal(last.d.error, 'slow-down');
    step('name changes are rate limited per account (20 an hour: 429 slow-down)');

    void subB;
    console.log(`\n${n} checks passed`);
} finally {
    fake.close && fake.close();
    await fake.stop?.();
}
process.exit(0);
