// The REAL CloudCalendarService (loaded from public/services like the page loads it) against
// the real Worker under `wrangler dev` (BASE, default http://localhost:8787), over a real
// WebSocket. Each "tab" is an independent copy of the services plus a tiny stand-in for the
// app that does what app.js's applyRemoteCalendar does (merge the snapshot under local edits).
//
//   cd cloudflare && npx wrangler dev   (other terminal)   then   node test/cloud-service.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { loadTab } = createRequire(import.meta.url)('../../test/cloud-loader.js');

const BASE = process.env.BASE || 'http://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, pred, ms = 5000) => {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(20); }
};
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const ev = (id, title, d = 1) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1, description: '' });
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const titles = (events) => Object.fromEntries(events.map((e) => [e.id, e.title]));

function tab(name, id, { reconnectMs = 100 } = {}) {
    const t = { name, sent: [], sockets: [], refused: [], paused: [], snapshots: 0 };
    class CountingWS extends WebSocket {
        constructor(u) { super(u); t.sockets.push(this); }
        send(d) { t.sent.push(JSON.parse(d)); super.send(d); }
    }
    const L = loadTab({ base: BASE, WebSocket: CountingWS });
    const S = t.S = L.Service; t.L = L;
    S.RECONNECT = { baseMs: reconnectMs, maxMs: reconnectMs };
    S.onSyncRefused = (x) => { t.refused.push(x); };
    S.onSyncPaused = (x) => { t.paused.push(x); };
    t.app = { calendar: { id, title: '', options: {}, events: [] } };
    // What app.js does with a server copy: merge it under unsent local edits, then import it.
    const applyRemote = (c) => {
        t.snapshots++;
        const incoming = c.events, base = S._previousSeen[id];
        const events = base && t.app.calendar.events.length ? S._mergeEvents(base, t.app.calendar.events, incoming) : incoming;
        Object.assign(t.app.calendar, c, { events: JSON.parse(JSON.stringify(events)) });   // in place, like Calendar.import
    };
    t.open = () => { S.findAndSubscribe(id, (c) => { if (c) applyRemote(c); else t.missing = true; }); return until(`${name} snapshot`, () => t.snapshots > 0); };
    t.edit = (fn) => { fn(t.app.calendar.events); S.debounce_sync(t.app.calendar); };   // the app's watcher, 500 ms debounce
    t.saves = () => t.sent.filter((m) => m.t === 'save' || m.t === 'meta');
    return t;
}
const server = async (id) => (await (await fetch(`${BASE}/cal/${id}`)).json());
const callMethod = (S, m, ...a) => new Promise((yes, no) => S[m](...a, yes, no));

const id = `cs-${Date.now()}`;
console.log(`cloud-service e2e against ${BASE}, calendar ${id}`);

// ---- create + exists ---------------------------------------------------------------------------
{
    const A = tab('A', id);
    assert.equal(await new Promise((y) => A.S.checkExists(id, () => y(true), () => y(false))), false);
    step('checkExists: a new name is free (HEAD 404)');
    await new Promise((ok) => A.S.createWithId(id, { title: 'Cloud test', options: { notes: 'hi' }, events: [ev('e1', 'One', 1), ev('e2', 'Two', 2)] }, ok));
    assert.equal(await new Promise((y) => A.S.checkExists(id, () => y(true), () => y(false))), true);
    assert.equal(await new Promise((y) => A.S.checkExists('Beta', () => y(true), () => y(false))), true);
    step('createWithId makes it; checkExists now says taken (and reserved names are taken)');
    let created = true; await new Promise((ok) => { A.S.createWithId(id, { title: 'Overwrite?', events: [] }, () => { created = true; ok(); }); setTimeout(() => { created = false; ok(); }, 500); });
    assert.equal(created, false); assert.equal((await server(id)).calendar.title, 'Cloud test');
    step('creating over an existing calendar is refused; the data is untouched');
}

// ---- two clients converge ----------------------------------------------------------------------
const A = tab('A', id, { reconnectMs: 1600 }), B = tab('B', id);
await A.open(); await B.open();
assert.deepEqual(titles(A.app.calendar.events), { e1: 'One', e2: 'Two' });
assert.deepEqual(titles(B.app.calendar.events), { e1: 'One', e2: 'Two' });
step('two clients open the calendar and see the same snapshot');

A.edit((evs) => evs.push(ev('e3', 'Added by A', 3)));
await until('B sees e3', () => B.app.calendar.events.some((e) => e.id === 'e3'));
B.edit((evs) => { evs.find((e) => e.id === 'e1').title = 'One (B)'; });
await until('A sees B edit', () => A.app.calendar.events.find((e) => e.id === 'e1').title === 'One (B)');
B.edit((evs) => evs.splice(evs.findIndex((e) => e.id === 'e2'), 1));   // undeclared delete: the gate refuses it
await sleep(700);
assert.equal(B.saves().length, 1, 'the undeclared delete was not sent'); assert.equal(B.refused.length, 1);
B.app.calendar.events = B.refused[0].events;   // what the apps do with onSyncRefused
B.S.declareIntent(1);
B.edit((evs) => evs.splice(evs.findIndex((e) => e.id === 'e2'), 1));
await until('A sees the delete', () => !A.app.calendar.events.some((e) => e.id === 'e2'));
const s1 = await server(id);
assert.deepEqual(titles(A.app.calendar.events), titles(s1.calendar.events));
assert.deepEqual(titles(B.app.calendar.events), titles(s1.calendar.events));
step(`add / edit / declared delete each reach the other client; both equal the server (v${s1.v})`);

// ---- idle ---------------------------------------------------------------------------------------
{
    const a0 = A.sent.length, b0 = B.sent.length, snaps = [A.snapshots, B.snapshots];
    // "idle" includes the app's own echo: a remote apply makes the watcher call debounce_sync with unchanged data.
    A.S.debounce_sync(A.app.calendar); B.S.debounce_sync(B.app.calendar);
    await sleep(10000);
    assert.equal(A.sent.length - a0, 0); assert.equal(B.sent.length - b0, 0);
    assert.deepEqual([A.snapshots, B.snapshots], snaps);
    step('idle: two open clients sent 0 messages and received 0 in 10 s (even with the app\'s echo sync)');
}

// ---- same-event conflict ------------------------------------------------------------------------
{
    const before = (await server(id)).v;
    A.edit((evs) => { evs.find((e) => e.id === 'e3').title = 'A wins?'; });
    B.edit((evs) => { evs.find((e) => e.id === 'e3').title = 'B wins?'; });
    await sleep(1500);
    const s = await server(id); const want = s.calendar.events.find((e) => e.id === 'e3').title;
    assert.equal(A.app.calendar.events.find((e) => e.id === 'e3').title, want);
    assert.equal(B.app.calendar.events.find((e) => e.id === 'e3').title, want);
    assert.equal(s.v, before + 2);
    step(`both edited the same event at once: both clients show the server's value ("${want}"); ${A.sent.filter((m) => m.t === 'hello').length + B.sent.filter((m) => m.t === 'hello').length} re-sync(s) asked for`);
}

// ---- offline edit replays without duplicates ---------------------------------------------------
{
    const old = A.sockets.at(-1); old.close();                   // connection drops; A retries after ~1.6 s
    await until('A offline', () => old.readyState === 3);
    A.edit((evs) => { evs.push(ev('off1', 'Made offline', 4)); evs.find((e) => e.id === 'e1').description = 'edited offline'; });
    await sleep(700);                                            // debounce fires into a dead socket: journaled, not sent
    B.edit((evs) => evs.push(ev('b1', 'B while A offline', 5)));
    await until('A reconnected and converged', () => A.app.calendar.events.some((e) => e.id === 'b1') && B.app.calendar.events.some((e) => e.id === 'off1'), 8000);
    await sleep(500);
    const s = await server(id);
    const ids = s.calendar.events.map((e) => e.id);
    assert.equal(ids.filter((i) => i === 'off1').length, 1, 'no duplicate');
    assert.equal(s.calendar.events.find((e) => e.id === 'e1').description, 'edited offline');
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(titles(A.app.calendar.events), titles(s.calendar.events));
    assert.deepEqual(titles(B.app.calendar.events), titles(s.calendar.events));
    assert.equal(A.L.store['pastecal_unsent:' + id], undefined, 'journal cleared after the replay');
    step('offline edit + someone else\'s edit meanwhile: after reconnect all three agree, no duplicates, journal cleared');

    // A reload: a journaled write that never reached the server is replayed once, rebuilt against the fresh snapshot.
    const C = tab('C', id);
    C.L.store['pastecal_unsent:' + id] = JSON.stringify({ v: 1, t: Date.now(), base: s.calendar.events, calendar: { id, title: 'Cloud test', options: {}, events: [...s.calendar.events, ev('reload1', 'Typed just before reload', 6)] }, intentRemoving: 0 });
    await C.open();
    await until('reload1 lands', () => C.app.calendar.events.some((e) => e.id === 'reload1'));
    await until('A sees reload1', () => A.app.calendar.events.some((e) => e.id === 'reload1'));
    const again = await server(id);
    assert.equal(again.calendar.events.filter((e) => e.id === 'reload1').length, 1);
    // replaying the SAME journal entry into a fresh tab applies nothing twice
    const D = tab('D', id);
    D.L.store['pastecal_unsent:' + id] = JSON.stringify({ v: 1, t: Date.now(), base: s.calendar.events, calendar: { id, title: 'Cloud test', options: {}, events: [...s.calendar.events, ev('reload1', 'Typed just before reload', 6)] }, intentRemoving: 0 });
    await D.open(); await sleep(500);
    assert.equal(D.saves().length, 0, 'nothing to replay: the server already has it');
    assert.equal((await server(id)).v, again.v);
    C.S.close(id); D.S.close(id);
    step('a journal entry from before a reload is replayed once; replaying it again sends nothing');
}

// ---- a save loop is refused ---------------------------------------------------------------------
{
    // (1) the client budget stops it first (40 writes a minute), as in the Firebase path
    const lid = `cs-loop-${Date.now()}`;
    const seed = tab('seed', lid);
    await new Promise((ok) => seed.S.createWithId(lid, { title: 'Loop', events: [ev('x', 'x')] }, ok));
    const L1 = tab('L1', lid); await L1.open();
    for (let i = 0; i < 70 && !L1.paused.length; i++) { L1.app.calendar.events[0].title = 'loop ' + i; L1.S.sync(L1.app.calendar); await sleep(25); }
    assert.equal(L1.paused.length, 1); assert.equal(L1.paused[0].code, undefined);
    const stored1 = (await server(lid)).v;
    assert.ok(L1.saves().length <= 41, `client stopped at its budget (${L1.saves().length} sent)`);
    step(`a save loop in one tab: the client budget paused it after ${L1.saves().length} saves (onSyncPaused fired)`);

    // (2) with the client budget out of the way, the SERVER refuses, and the callback says so
    const L2 = tab('L2', lid); await L2.open();
    L2.S.WRITE_BUDGET = { max: 10000, windowMs: 60000 };
    for (let i = 0; i < 90 && !L2.paused.length; i++) { L2.app.calendar.events[0].title = 'server loop ' + i; L2.S.sync(L2.app.calendar); await sleep(25); }
    await until('server refusal', () => L2.paused.length > 0, 3000);
    assert.equal(L2.paused[0].code, 'rate_limited'); assert.match(L2.paused[0].message, /too often/);
    const v2 = (await server(lid)).v; await sleep(500);
    const sentAfter = L2.sent.length; L2.S.sync({ ...L2.app.calendar, events: [ev('x', 'still looping')] }); await sleep(200);
    assert.equal(L2.sent.length, sentAfter, 'paused: nothing more sent');
    assert.ok(v2 - stored1 <= 41, `server stored at most its per-tab limit (${v2 - stored1})`);
    step(`with the client budget off, the server refused the loop (rate_limited -> onSyncPaused: "${L2.paused[0].message}"); ${v2 - stored1} stored`);
}

// ---- refusals -----------------------------------------------------------------------------------
{
    const lid = `cs-big-${Date.now()}`;
    const T = tab('T', lid);
    await new Promise((ok) => T.S.createWithId(lid, { title: 'Big', events: [ev('x', 'x')] }, ok));
    await T.open();
    T.app.calendar.events[0].description = 'y'.repeat(30000);       // over the server's field limit
    T.S.sync(T.app.calendar); await until('refusal', () => T.refused.length > 0);
    assert.equal(T.refused[0].code, 'too_big');
    await until('server copy back on screen', () => T.app.calendar.events[0].description === '');
    step('an oversized field is refused by the server, reported through onSyncRefused, and the screen returns to the server\'s copy');
}

// ---- unknown calendar ---------------------------------------------------------------------------
{
    const M = tab('M', `cs-none-${Date.now()}`); M.S.findAndSubscribe(`cs-none-${Date.now()}x`, (c) => { M.missing = c === null; });
    await until('null callback', () => M.missing);
    step('opening a calendar that does not exist calls back null (the app treats it as new)');
}

for (const t of [A, B]) t.S.close(id);
console.log(`\n${n} passed`);
process.exit(0);
