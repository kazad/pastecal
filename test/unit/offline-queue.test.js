/**
 * ROOT 1 guard (unit half): every write carries only the fields the person changed, measured from where they started,
 * never a whole stale copy of the event -- here for the offline queue (the journal) and the reconnect replay.
 *
 * Stress S15: browser A, offline, changed only the TYPE of "Practice" while browser B renamed it. A's journal held
 * its whole calendar; on reconnect the app merged A's whole row over the server's and saved it, so B's rename was
 * undone. Now the journal holds diffs (only what A changed), the replay keeps every field nobody else touched, and
 * the app's merge takes only A's changed fields. The browser half (every write path, two browsers, online and
 * offline) is cloudflare/test/root-data.spec.js.
 *
 * Run: node --test test/unit/offline-queue.test.js
 */
const test = require('node:test');
const strict = require('node:assert/strict');
const assert = Object.assign((...a) => strict(...a), strict, {
    deepEqual: (a, b, m) => strict.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m),
});
const { loadTab } = require('../cloud-loader.js');

const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const ev = (id, title, d, extra = {}) => ({ id, title, start: at(d, 17), end: at(d, 18), type: 1, description: '', ...extra });
const plain = (x) => JSON.parse(JSON.stringify(x));
const START = [ev('p', 'Practice', 22), ev('q', 'Game', 23), ev('r', 'Party', 21)];

class FakeSocket {
    static all = [];
    constructor(url) { this.url = url; this.sent = []; this.readyState = 1; FakeSocket.all.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
    push(m) { this.onmessage({ data: JSON.stringify(m) }); }
    drop() { this.readyState = 3; this.onclose(); }
}
const snap = (v, events) => ({ t: 'snapshot', v, calendar: { id: 'room', title: 'T', options: {}, lastEditedAt: 1, events } });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tab on 'room', with the app's own merge of what arrives (app.js applyRemoteCalendar: _mergeEvents over local). */
function tab() {
    FakeSocket.all.length = 0;
    const t = loadTab({ WebSocket: FakeSocket });
    t.Cloud.RECONNECT = { baseMs: 1, maxMs: 1 };
    const app = { calendar: null };
    t.Service.findAndSubscribe('room', (c) => {
        const incoming = plain(c);
        const base = t.Service._previousSeen.room;
        if (app.calendar && base) incoming.events = plain(t.Service._mergeEvents(base, app.calendar.events, incoming.events));
        app.calendar = incoming;
    });
    FakeSocket.all[0].push(snap(3, plain(START)));
    return { t, S: t.Service, app, ws: () => FakeSocket.all.at(-1) };
}

test('the offline queue stores only the fields this tab changed, never a whole copy of the event', async () => {
    const { t, S, app, ws } = tab();
    ws().drop();                                                       // offline
    const edited = plain(app.calendar);
    edited.events.find((e) => e.id === 'p').type = 4;                  // only the type
    edited.events.find((e) => e.id === 'q').title = 'Game (away)';     // only the title
    S.debounce_sync(edited);
    const entry = JSON.parse(t.store['pastecal_unsent:room']);
    assert.deepEqual(entry.changes, [
        { type: 'update', key: 'p|', changes: { type: 4 } },
        { type: 'update', key: 'q|', changes: { title: 'Game (away)' } },
    ], 'the journal holds diffs');
    // (Nothing whole in the commands: no title on p's, no type on q's.)
    for (const c of entry.changes) assert.equal(Object.keys(c.changes).length, 1);
    await tick(5);
});

test('reconnect (S15): my offline type change and their rename of the same event both stand', async () => {
    const { S, app, ws } = tab();
    ws().drop();
    const edited = plain(app.calendar);
    edited.events.find((e) => e.id === 'p').type = 4;
    edited.events.find((e) => e.id === 'q').title = 'Game (away)';
    app.calendar = edited;
    S.debounce_sync(edited);
    await tick(600);                                                   // the debounced save found no socket
    // Meanwhile, online, B renamed "Practice" and "Party".
    const server = plain(START);
    server.find((e) => e.id === 'p').title = 'Practice (gym)';
    server.find((e) => e.id === 'r').title = 'Party (moved)';
    await tick(10);                                                    // reconnected
    const sock = ws();
    sock.push(snap(5, plain(server)));
    const save = sock.sent.find((m) => m.t === 'save');
    assert.ok(save, 'the replay is sent');
    assert.deepEqual(save.commands, [
        { type: 'update', key: 'p|', changes: { type: 4 } },
        { type: 'update', key: 'q|', changes: { title: 'Game (away)' } },
    ], 'the replay sends only what I changed');
    // The server applies it on top of its rows.
    const { EventStore } = loadTab();
    const after = EventStore.apply(server, { type: 'batch', commands: save.commands }).events;
    const rows = Object.fromEntries(after.map((e) => [e.id, [e.title, e.type]]));
    assert.deepEqual(rows, { p: ['Practice (gym)', 4], q: ['Game (away)', 1], r: ['Party (moved)', 1] });
    // And the app, merging what arrived over what it holds, keeps their rename (its next save would carry it back).
    const p = app.calendar.events.find((e) => e.id === 'p');
    assert.deepEqual([p.title, p.type], ['Practice (gym)', 4], 'the app shows both');
    sock.push({ t: 'ack', id: save.id, v: 6 });
    const n = sock.sent.length;
    S.sync(app.calendar);
    const more = sock.sent.slice(n).filter((m) => m.t === 'save');
    for (const m of more) for (const c of m.commands) assert.ok(!(c.changes && 'title' in c.changes && c.key === 'p|'), 'no save puts the old title back');
});

test('replay: a field someone else changed since is theirs; my other fields still go; a row they deleted stays deleted', () => {
    const { Cloud } = loadTab();
    const base = plain(START);
    const commands = [
        { type: 'update', key: 'p|', changes: { title: 'mine', type: 4 } },   // they renamed p too: my title yields, my type goes
        { type: 'update', key: 'r|', changes: { description: 'notes' } },     // they deleted r
        { type: 'update', key: 'q|', changes: { title: 'Game' } },            // already so on the server: nothing to send
    ];
    const fresh = plain(START).filter((e) => e.id !== 'r');
    fresh.find((e) => e.id === 'p').title = 'theirs';
    assert.deepEqual(Cloud.replayable(base, commands, fresh), [{ type: 'update', key: 'p|', changes: { type: 4 } }]);
});

test('every update command carries only changed fields (changesBetween), whatever path made the list', () => {
    const { EventStore } = loadTab();
    const cur = plain(START), next = plain(START);
    next[0].type = 3; next[1].description = 'x'; next[2].tz = 'Asia/Tokyo';
    const cmds = EventStore.changesBetween(cur, next);
    assert.deepEqual(cmds.map((c) => c.changes), [{ type: 3 }, { description: 'x' }, { tz: 'Asia/Tokyo' }]);
    // A zone taken away goes as tz: null.
    assert.deepEqual(EventStore.changesBetween(next, cur).map((c) => c.changes), [{ type: 1 }, { description: '' }, { tz: null }]);
});
