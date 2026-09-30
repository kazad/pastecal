/**
 * CloudCalendarService: the decisions that keep a save from losing or duplicating anything,
 * plus the ack/conflict flow over a fake socket. The real socket against the real Worker is
 * cloudflare/test/cloud-service.test.mjs (needs `wrangler dev`).
 *
 * Run: node --test test/unit/cloud-calendar-service.test.js
 */
const test = require('node:test');
const strict = require('node:assert/strict');
// The service runs in a vm context, so its arrays/objects are from another realm: compare as JSON.
const assert = Object.assign((...a) => strict(...a), strict, {
    deepEqual: (a, b, m) => strict.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m),
});
const { loadTab } = require('../cloud-loader.js');

const at = (d, h) => new Date(Date.UTC(2026, 8, d, h)).toISOString();
const ev = (id, title, d = 1, extra = {}) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1, description: '', ...extra });
const { Cloud, EventStore } = loadTab();
const plain = (x) => JSON.parse(JSON.stringify(x));

test('the flag: ?backend=cf turns it on and is remembered; ?backend=firebase turns it off; new.pastecal.com is on', () => {
    const mem = () => { const s = {}; return { getItem: (k) => s[k] ?? null, setItem: (k, v) => { s[k] = v; }, removeItem: (k) => { delete s[k]; } }; };
    const store = mem();
    assert.equal(Cloud.enabled({ search: '', hostname: 'pastecal.com' }, store), false);
    assert.equal(Cloud.enabled({ search: '?backend=cf', hostname: 'pastecal.com' }, store), true);
    assert.equal(Cloud.enabled({ search: '', hostname: 'pastecal.com' }, store), true, 'remembered');
    assert.equal(Cloud.enabled({ search: '?backend=firebase', hostname: 'pastecal.com' }, store), false);
    assert.equal(Cloud.enabled({ search: '', hostname: 'pastecal.com' }, store), false, 'forgotten');
    assert.equal(Cloud.enabled({ search: '', hostname: 'new.pastecal.com' }, mem()), true);
});

test('flag off: the apps keep the Firebase class; flag on: they get the cloud one', () => {
    const off = loadTab({ search: '' });
    assert.equal(off.Service.name, 'CalendarDataService');
    assert.equal(loadTab({ search: '?backend=cf' }).Service.name, 'CloudCalendarService');
});

test('idle: an unchanged calendar produces no commands (an idle tab writes nothing)', () => {
    const server = [ev('a', 'A'), ev('b', 'B', 2)];
    // rows the way the app holds them: other key order, Date-ish/extra fields, number vs string type
    const local = server.map((e) => ({ ...e, type: String(e.type), recurrenceID: null }));
    assert.deepEqual(Cloud.planSave(server, local), []);
});

test('planSave: add, edit and delete become commands; a new event keeps the tab-chosen id', () => {
    const server = [ev('a', 'A'), ev('b', 'B', 2)];
    const cmds = Cloud.planSave(server, [ev('a', 'A renamed'), ev('c', 'C', 3)]);
    assert.deepEqual(cmds.map((c) => c.type).sort(), ['add', 'remove', 'update']);
    assert.equal(cmds.find((c) => c.type === 'add').event.id, 'c');
    assert.equal(cmds.find((c) => c.type === 'remove').key, 'b|');
    // applying them to the server copy gives the local calendar
    const after = EventStore.apply(server, { type: 'batch', commands: cmds }).events;
    assert.deepEqual(after.map((e) => e.title).sort(), ['A renamed', 'C']);
});

test('planSave: an event without an id is not sent (the server would refuse the whole save)', () => {
    assert.deepEqual(Cloud.planSave([], [{ title: 'x', start: at(1, 9), end: at(1, 10) }]), []);
});

test('metaDiff: only what changed; options go as changed keys', () => {
    const server = { title: 'T', options: { a: 1, b: 2 } };
    assert.deepEqual(Cloud.metaDiff(server, { title: 'T', options: { a: 1, b: 2 } }), {});
    assert.deepEqual(Cloud.metaDiff(server, { title: 'U', options: { a: 1, b: 3, c: { x: 1 } } }), { title: 'U', options: { b: 3, c: { x: 1 } } });
});

test('ackOutcome: exactly previous+1 is ours alone; anything else means another save landed first', () => {
    assert.equal(Cloud.ackOutcome(4, { v: 5 }), 'ok');
    assert.equal(Cloud.ackOutcome(4, { v: 6 }), 'conflict');
    assert.equal(Cloud.ackOutcome(4, { v: 4, unchanged: true }), 'unchanged');
});

test('errorKind: rate_limited pauses; everything else is a refusal', () => {
    assert.equal(Cloud.errorKind('rate_limited'), 'paused');
    for (const c of ['too_big', 'bad_command', 'bad_json']) assert.equal(Cloud.errorKind(c), 'refused');
});

test('rebuild: a replay whose ack was lost applies nothing the second time', () => {
    const base = [ev('a', 'A'), ev('b', 'B', 2)];
    const local = [ev('a', 'A2'), ev('c', 'C', 3)];                 // edit a, add c, delete b
    const commands = Cloud.rebuild(base, local, base);
    assert.equal(commands.length, 3);
    const landed = EventStore.apply(base, { type: 'batch', commands }).events;
    assert.deepEqual(Cloud.rebuild(base, local, landed), [], 'server already has all of it');
});

test('rebuild: keeps this tab\'s own changes on top of other people\'s, and yields to their newer edits', () => {
    const base = [ev('a', 'A'), ev('b', 'B', 2), ev('d', 'D', 4)];
    const local = [ev('a', 'mine'), ev('b', 'B mine', 2), ev('d', 'D', 4), ev('n', 'new', 5)];
    // meanwhile someone else edited b, deleted d, and added x
    const fresh = [ev('a', 'A'), ev('b', 'theirs', 2), ev('x', 'X', 6)];
    const commands = Cloud.rebuild(base, local, fresh);
    const out = EventStore.apply(fresh, { type: 'batch', commands }).events;
    const titles = Object.fromEntries(out.map((e) => [e.id, e.title]));
    assert.deepEqual(titles, { a: 'mine', b: 'theirs', x: 'X', n: 'new' });
});

test('rebuild: a deletion of a row someone else already changed is dropped', () => {
    const base = [ev('a', 'A')];
    assert.deepEqual(Cloud.rebuild(base, [], [ev('a', 'edited by them')]), []);
    assert.equal(Cloud.rebuild(base, [], base).length, 1);
});

// ---- the flow over a fake socket --------------------------------------------------------------

class FakeSocket {
    static all = [];
    constructor(url) { this.url = url; this.sent = []; this.readyState = 1; FakeSocket.all.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
    push(m) { this.onmessage({ data: JSON.stringify(m) }); }
}
const snap = (v, events, extra = {}) => ({ t: 'snapshot', v, calendar: { id: 'room', title: 'T', options: {}, lastEditedAt: 1, events, ...extra } });

function open(events) {
    FakeSocket.all.length = 0;
    const tab = loadTab({ WebSocket: FakeSocket });
    const seen = [];
    tab.Service.findAndSubscribe('room', (c) => seen.push(plain(c)));
    const ws = FakeSocket.all[0];
    ws.push(snap(3, events));
    return { tab, ws, seen, S: tab.Service };
}

test('flow: the app receives a snapshot, an idle sync sends nothing, an edit sends one save', () => {
    const { ws, seen, S } = open([ev('a', 'A')]);
    assert.equal(seen.length, 1);
    assert.match(ws.url, /\/cal\/room\/ws$/); assert.match(ws.url, /^ws:/);
    S.sync({ id: 'room', title: 'T', options: {}, events: seen[0].events });
    assert.equal(ws.sent.length, 0, 'idle');
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A2')] });
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].t, 'save'); assert.equal(ws.sent[0].v, 3);
    assert.equal(ws.sent[0].commands[0].type, 'update');
});

test('flow: a clean ack (v+1) updates the baseline and sends no hello', () => {
    const { ws, S } = open([ev('a', 'A')]);
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A2')] });
    ws.push({ t: 'ack', id: ws.sent[0].id, v: 4 });
    assert.equal(ws.sent.length, 1);
    assert.equal(S._lastSeen.room[0].title, 'A2');
    // next identical sync: nothing to say
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A2')] });
    assert.equal(ws.sent.length, 1);
});

test('flow: an ack that skips a version (another save landed first) asks for the snapshot and the app shows the server\'s data', () => {
    const { ws, seen, S } = open([ev('a', 'A')]);
    const mine = { id: 'room', title: 'T', options: {}, events: [ev('a', 'mine')] };
    S.sync(mine);
    // the other tab's save reached the server first: we are told, then our ack arrives with v+2
    ws.push({ t: 'change', v: 4, commands: [{ type: 'update', key: 'a|', changes: { title: 'theirs' } }] });
    ws.push({ t: 'ack', id: ws.sent[0].id, v: 5 });
    assert.deepEqual(ws.sent.map((m) => m.t), ['save', 'hello']);
    ws.push(snap(5, [ev('a', 'mine-on-top-of-theirs')]));
    assert.equal(seen.at(-1).events[0].title, 'mine-on-top-of-theirs');
    // the app's merge baseline is what it had sent, so the server's value wins the merge
    assert.equal(S._previousSeen.room[0].title, 'mine');
});

test('flow: an error refuses the save, asks for the snapshot, and reports through onSyncRefused; rate_limited pauses', () => {
    const { ws, S } = open([ev('a', 'A')]);
    let refused = null, paused = null;
    S.onSyncRefused = (x) => { refused = x; }; S.onSyncPaused = (x) => { paused = x; };
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A2')] });
    ws.push({ t: 'error', id: ws.sent[0].id, code: 'too_big', message: 'an event title is too long' });
    assert.equal(refused.code, 'too_big'); assert.equal(refused.events[0].title, 'A');
    assert.equal(ws.sent.at(-1).t, 'hello');
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A3')] });
    const id = ws.sent.at(-1).id;
    ws.push({ t: 'error', id, code: 'rate_limited', message: 'this calendar is saving too often' });
    assert.equal(paused.code, 'rate_limited');
    const n = ws.sent.length;
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A4')] });
    assert.equal(ws.sent.length, n, 'paused: nothing more is sent');
});

test('flow: an undeclared deletion is refused locally, as in the Firebase path', () => {
    const { ws, S } = open([ev('a', 'A'), ev('b', 'B', 2)]);
    let refused = null; S.onSyncRefused = (x) => { refused = x; };
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A')] });
    assert.equal(ws.sent.length, 0); assert.equal(refused.removing, 1); assert.equal(refused.events.length, 2);
    S.declareIntent(1);
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A')] });
    assert.equal(ws.sent[0].commands[0].type, 'remove');
});

test('flow: debounce_sync goes through the cloud sync (not the inherited Firebase one), journals first, and flush() sends at once', async () => {
    const { ws, tab, S } = open([ev('a', 'A')]);
    const cal = { id: 'room', title: 'T', options: {}, events: [ev('a', 'A2')] };
    S.debounce_sync(cal);
    assert.ok(tab.store['pastecal_unsent:room'], 'journaled before anything is sent');
    assert.equal(ws.sent.length, 0);
    await new Promise((r) => setTimeout(r, 650));
    assert.equal(ws.sent.length, 1); assert.equal(ws.sent[0].t, 'save');
    ws.push({ t: 'ack', id: ws.sent[0].id, v: 4 });
    assert.equal(tab.store['pastecal_unsent:room'], undefined, 'journal cleared by the ack');
    S.debounce_sync({ ...cal, events: [ev('a', 'A3')] });
    S.flush();
    assert.equal(ws.sent.length, 2, 'flush sends without waiting for the debounce');
});
