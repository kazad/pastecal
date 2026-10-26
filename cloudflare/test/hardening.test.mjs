// Defensive limits, against `wrangler dev` (BASE, default http://localhost:8787):
//   - size caps on event ids, recurrenceIDs, types and the whole calendar, on every way in
//     (create, save, meta, import, from-firebase);
//   - a WebSocket save/meta to a calendar nobody created is refused and stores nothing.
//
//   cd cloudflare && npx wrangler dev   (other terminal)   then   node test/hardening.test.mjs
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const ev = (id, title, d = 1, extra = {}) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1, ...extra });
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const uniq = (p) => `test-hard-${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const url = (id, sub = '') => `${BASE}/cal/${encodeURIComponent(id)}${sub}`;
const create = (id, cal) => fetch(url(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cal) });
const put = (id, sub, cal) => fetch(url(id, sub), { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cal) });
const get = async (id) => (await (await fetch(url(id))).json()).calendar;

function tab(id) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${encodeURIComponent(id)}/ws?author=test-author-${Date.now()}`);
    const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const waitFor = async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 20)); }
        throw new Error('timed out');
    };
    const ready = waitFor((m) => m.t === 'snapshot');
    const send = (m) => { ws.send(JSON.stringify(m)); return waitFor((x) => x.id === m.id && (x.t === 'ack' || x.t === 'error')); };
    return { ws, got, ready, send, close: () => ws.close() };
}

// ---- 2. size caps -------------------------------------------------------------------------
{
    const long = 'x'.repeat(201);
    for (const [what, e] of [
        ['id', ev(long, 'a')],
        ['recurrenceID', ev('ok', 'a', 1, { recurrenceID: long })],
    ]) {
        const id = uniq('cap');
        const r = await create(id, { title: 't', events: [e] });
        assert.equal(r.status, 413, `create with a 201-char ${what} must be refused`);
        assert.equal((await fetch(url(id), { method: 'HEAD' })).status, 404, 'nothing stored');
    }
    step('create refuses an event id / recurrenceID over 200 chars, and stores nothing');

    const id = uniq('cap');
    assert.equal((await create(id, { title: 't', events: [ev('a1', 'first')] })).status, 201);
    const t = tab(id); await t.ready;
    let r = await t.send({ t: 'save', id: 's1', v: 1, commands: [{ type: 'add', event: ev('y'.repeat(201), 'long id') }] });
    assert.equal(r.t, 'error'); assert.equal(r.code, 'too_big');
    r = await t.send({ t: 'save', id: 's2', v: 1, commands: [{ type: 'add', event: ev('a2', 'big', 2, { description: 'z'.repeat(19000) }) }] });
    assert.equal(r.t, 'ack', 'a normal-sized save still works');
    assert.deepEqual((await get(id)).events.map((e) => e.id), ['a1', 'a2']);
    step('a save adding an over-long id is refused; ordinary saves still work');

    // Whole-calendar size: saves of large-but-legal events (each message under the 512 KB message
    // limit), until the total passes 2 MB.
    let refused = null;
    for (let i = 0; i < 8 && !refused; i++) {
        const commands = Array.from({ length: 24 }, (_, j) => ({ type: 'add', event: ev(`big${i}-${j}`, 'big', 3, { description: 'q'.repeat(19500) }) }));
        const m = await t.send({ t: 'save', id: `b${i}`, v: 0, commands });
        if (m.t === 'error') refused = m;
    }
    assert.ok(refused, 'the calendar must stop growing at its size cap');
    assert.equal(refused.code, 'too_big'); assert.match(refused.message, /too large/);
    const stored = await get(id);
    assert.ok(JSON.stringify(stored.events).length <= 2 * 1024 * 1024, 'never stored past the cap');
    step(`a save that would take the calendar past 2 MB is refused (${stored.events.length} events stored)`);

    // Fill to within one event of the cap, then a meta change bigger than what is left is refused too.
    for (let i = 0; i < 26; i++) {
        const m = await t.send({ t: 'save', id: `c${i}`, v: 0, commands: [{ type: 'add', event: ev(`fill${i}`, 'fill', 3, { description: 'q'.repeat(19500) }) }] });
        if (m.t === 'error') break;
    }
    r = await t.send({ t: 'meta', id: 'm1', options: { notes: 'n'.repeat(60000) } });
    assert.equal(r.t, 'error'); assert.equal(r.code, 'too_big');
    assert.notEqual((await get(id)).options.notes, 'n'.repeat(60000));
    step('meta that would take the calendar past the cap is refused, nothing stored');
    t.close();

    // import and from-firebase: refused with a clear error, the stored calendar untouched.
    const huge = Array.from({ length: 120 }, (_, i) => ev(`h${i}`, 'h', 4, { description: 'w'.repeat(19500) }));
    const imp = uniq('cap');
    r = await put(imp, '/import', { id: imp, title: 'x', events: huge });
    assert.equal(r.status, 413); assert.match((await r.json()).error, /too large/);
    assert.equal((await fetch(url(imp), { method: 'HEAD' })).status, 404);
    const fb = uniq('cap');
    assert.equal((await put(fb, '/import', { id: fb, title: 'x', events: [ev('f1', 'one')] })).status, 200);
    r = await put(fb, '/from-firebase', { id: fb, title: 'x', events: huge });
    assert.equal(r.status, 413); const out = await r.json();
    assert.equal(out.ok, false); assert.match(out.error, /too large/);
    assert.deepEqual((await get(fb)).events.map((e) => e.id), ['f1'], 'from-firebase refused: nothing changed');
    step('import and from-firebase over the cap are refused (413, a clear error) and store nothing');

    // type sanity: an object as the type is refused on import; real shapes ("3", "undefined", null) are kept.
    const ty = uniq('cap');
    r = await put(ty, '/import', { id: ty, title: 'x', events: [ev('t1', 'a', 1, { type: { evil: 1 } })] });
    assert.equal(r.status, 413);
    r = await put(ty, '/import', { id: ty, title: 'x', events: [ev('t1', 'a', 1, { type: '3' }), ev('t2', 'b', 1, { type: 'undefined' }), ev('t3', 'c', 1, { type: null })] });
    assert.equal(r.status, 200);
    step('an event type that is not a number or short text is refused; real stored shapes still import');
}

// ---- 3. a WebSocket cannot create a calendar ----------------------------------------------
{
    const id = uniq('nocal');
    const t = tab(id); const snap = await t.ready;
    assert.equal(snap.calendar.id, null);
    let r = await t.send({ t: 'save', id: 's1', v: 0, commands: [{ type: 'add', event: ev('a1', 'sneaky') }] });
    assert.equal(r.t, 'error'); assert.equal(r.code, 'no_calendar');
    r = await t.send({ t: 'meta', id: 'm1', title: 'sneaky', options: { notes: 'x' } });
    assert.equal(r.t, 'error'); assert.equal(r.code, 'no_calendar');
    t.close();
    assert.equal((await fetch(url(id))).status, 404, 'still no calendar');
    assert.deepEqual(await (await fetch(url(id, '/authors'), { headers: { Authorization: `Bearer ${SECRET}` } })).json(), [], 'no author row stored either');
    assert.deepEqual(await (await fetch(url(id, '/history'))).json(), [], 'no history');
    // The real way still works, and the name is then writable over the socket.
    assert.equal((await create(id, { title: 'real', events: [] })).status, 201);
    const t2 = tab(id); await t2.ready;
    r = await t2.send({ t: 'save', id: 's2', v: 1, commands: [{ type: 'add', event: ev('a1', 'fine') }] });
    assert.equal(r.t, 'ack');
    t2.close();
    step('save/meta over a socket to an uncreated calendar: refused (no_calendar), nothing stored; POST then works');
}

// ---- 4. read-only links: real source, no stealing a calendar's name, rate-limited ---------
{
    const view = (body, route = '/api/create-view') => fetch(`${BASE}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(route === '/createPublicLink' ? { data: body } : body) });
    const ghost = `testhardghost${Date.now()}`;
    let r = await view({ sourceCalendarId: ghost });
    assert.equal(r.status, 404); assert.equal((await r.json()).error, 'not-found');
    r = await view({ sourceCalendarId: ghost, customSlug: `${ghost}v` }, '/createPublicLink');
    assert.equal(r.status, 404); assert.equal((await r.json()).error.error, 'not-found');
    const lk = await (await fetch(`${BASE}/api/lookup?slug=${ghost}v`)).json();
    assert.equal(lk.found, false, 'nothing registered for a calendar that does not exist');
    step('a read-only link for a calendar that does not exist is refused (404) and registers nothing');

    const src = `testhardsrc${Date.now()}`, other = `TestHardOther${Date.now()}`;
    assert.equal((await create(src, { title: 's', events: [] })).status, 201);
    assert.equal((await create(other, { title: 'o', events: [] })).status, 201);
    for (const slug of [other, other.toLowerCase(), other.toUpperCase()]) {
        r = await view({ sourceCalendarId: src, customSlug: slug });
        assert.equal(r.status, 409, `customSlug ${slug} names an existing calendar`);
        assert.equal((await r.json()).error, 'already-exists');
    }
    r = await view({ sourceCalendarId: src, customSlug: other }, '/createPublicLink');
    assert.equal(r.status, 409); assert.equal((await r.json()).error.error, 'already-exists');
    assert.equal((await (await fetch(url(other))).json()).calendar.id, other, 'the other calendar is untouched');
    step('a custom read-only name equal (any case) to an existing calendar is refused with the 409 shape');

    r = await view({ sourceCalendarId: src });
    assert.equal(r.status, 200); const made = await r.json();
    assert.equal(made.ok, true); assert.ok(made.publicViewId.length >= 10);
    step('a read-only link for a real calendar is still created');

    // Per-IP rate limit (CREATE_LIMITER, key view:<ip>, 10 a minute).
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await view({ sourceCalendarId: src })).status);
    assert.ok(statuses.includes(429), `expected a 429 among ${statuses}`);
    step('creating read-only links is rate-limited per IP');
}

// Calendar names the site routes itself can't be created (any case), before the rate limit is spent;
// a calendar that already has one (imported) still reads.
{
    for (const name of ['report', 'signin', 'pro', 'pricing', 'explore', 'Pricing']) {
        const r = await create(name, { title: 'x', events: [] });
        assert.equal(r.status, 409, `${name}: ${r.status}`);
        assert.equal((await r.json()).error, 'reserved name');
    }
    assert.equal((await fetch(url('explore'))).status, 404, 'nothing was stored');
    const imp = await fetch(url('terms', '/import'), { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ id: 'terms', title: 'Old', events: [], options: {} }) });
    assert.equal(imp.status, 200);
    assert.equal((await fetch(url('terms'))).status, 200);
    step('reserved calendar names are refused on create; an existing one still reads');
}

// Red team, Oct 24 2026: a free calendar's view link and case-insensitive lookups could be taken over by
// creating another calendar carrying its publicViewId, or a case variant of its name.
{
    const lookup = async (slug) => (await fetch(`${BASE}/api/lookup?slug=${encodeURIComponent(slug)}`)).json();
    // (The earlier rate-limit step used up this IP's create-view budget, so the victim carries its view id from creation.)
    const victim = uniq('victim'), v = { publicViewId: uniq('vid') };
    assert.equal((await create(victim, { title: 'Victim', options: { publicViewId: v.publicViewId }, events: [ev('v1', 'Real event')] })).status, 201);
    await new Promise((r) => setTimeout(r, 400));
    const before = await lookup(v.publicViewId);
    assert.ok(before.found, 'the view id leads somewhere');
    const attacker = uniq('attacker');
    assert.equal((await create(attacker, { title: 'Hijack', options: { publicViewId: v.publicViewId }, events: [ev('a1', 'Fake event')] })).status, 201);
    await new Promise((r) => setTimeout(r, 400));                 // registration runs after the response
    const after = await lookup(v.publicViewId);
    assert.deepEqual(after, before, 'the view id still leads to the victim');
    const ics = await (await fetch(`${BASE}/view/${encodeURIComponent(v.publicViewId)}.ics`)).text();
    assert.match(ics, /SUMMARY:Real event/); assert.doesNotMatch(ics, /Fake event/);
    step("another calendar can't take over a free calendar's view link by carrying its view id");

    const name = uniq('casecal');
    assert.equal((await create(name, { title: 'Original', events: [ev('o1', 'Original event')] })).status, 201);
    await new Promise((r) => setTimeout(r, 300));
    const was = await lookup(name.toUpperCase());
    const twin = name.toUpperCase();
    const t = await create(twin, { title: 'Twin', events: [ev('t1', 'Twin event')] });
    await new Promise((r) => setTimeout(r, 400));
    const now = await lookup(name.toUpperCase());
    assert.equal(now.actualSlug || now.targetId, was.actualSlug || was.targetId, `case-insensitive lookups still lead to the original (twin create: ${t.status})`);
    step("a case variant can't take over a free calendar's case-insensitive lookups");
}

// Security review, Oct 25 2026: a view link only reads. A POST through /cal/view/<id> once reached the room's
// create path, so a viewer could recreate an EMPTY room (an archived calendar, a view row backfilled from
// Firebase) and get back its edit name, as its creator of record.
{
    const name = uniq('viewpost');
    // Its own address: the steps above use up this IP's create allowance (CREATE_LIMITER, 10 a minute).
    assert.equal((await fetch(url(name), { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.71.0.9' }, body: JSON.stringify({ title: 'Owner', events: [ev('o1', 'Owner event')] }) })).status, 201);
    const view = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.71.0.9' }, body: JSON.stringify({ sourceCalendarId: name }) })).json();
    assert.ok(view.publicViewId, JSON.stringify(view));
    const viewPost = () => fetch(`${BASE}/cal/view/${encodeURIComponent(view.publicViewId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'HIJACKED', author: 'attacker', events: [ev('x', 'x')] }) });
    let r = await viewPost();
    assert.equal(r.status, 405, 'a live calendar: refused');
    assert.ok(!(await r.text()).includes(name), 'and the edit name never comes back');
    // The case that leaked: the room behind the view id is empty.
    assert.equal((await fetch(url(name, '/archive'), { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } })).status, 200);
    r = await viewPost();
    const body = await r.text();
    assert.equal(r.status, 405, `an empty room behind a view id: refused (got ${r.status})`);
    assert.ok(!body.includes(name), 'and the edit name never comes back');
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(`${BASE}/cal/view/${encodeURIComponent(view.publicViewId)}`, { method })).status, 405, `${method} refused`);
    step('a view link cannot create, change or reveal the calendar behind it (POST/PUT/PATCH/DELETE refused, even on an empty room)');
}

console.log('hardening tests passed');
process.exit(0);
