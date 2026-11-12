/**
 * A save the server refuses is never silent and never mislabeled: the app gets onSyncRefused with the code, and
 * every code the server can send (read from CalendarRoom.js, so a new one is covered) has a "Couldn't save" message,
 * not the delete gate's "Recovered N events". Run: node --test test/unit/refused-save.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTab } = require('../cloud-loader.js');

const at = (d, h) => new Date(Date.UTC(2026, 8, d, h)).toISOString();
const ev = (id, title) => ({ id, title, start: at(1, 9), end: at(1, 10), type: 1, description: '' });
class FakeSocket {
    static all = [];
    constructor(url) { this.url = url; this.sent = []; this.readyState = 1; FakeSocket.all.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
    push(m) { this.onmessage({ data: JSON.stringify(m) }); }
}
const room = fs.readFileSync(path.join(__dirname, '../../cloudflare/src/CalendarRoom.js'), 'utf8');
const codes = [...new Set([...room.matchAll(/refuse\('([a-z_]+)'/g)].map((m) => m[1]))];

test('the server refusal codes are found', () => {
    assert.ok(codes.includes('too_big') && codes.includes('bad_command'), JSON.stringify(codes));
});

for (const code of codes.filter((c) => c !== 'rate_limited')) {
    test(`a save refused with ${code} reaches the app with its code, and a message that says it was not saved`, () => {
        FakeSocket.all.length = 0;
        const { Service: S } = loadTab({ WebSocket: FakeSocket });
        const refused = [];
        S.onSyncRefused = (r) => refused.push(JSON.parse(JSON.stringify(r)));
        S.findAndSubscribe('room', () => {});
        const ws = FakeSocket.all[0];
        ws.push({ t: 'snapshot', v: 3, calendar: { id: 'room', title: 'T', options: {}, lastEditedAt: 1, events: [ev('a', 'A')] } });
        S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A mine')] });
        const save = ws.sent.find((m) => m.t === 'save');
        assert.ok(save, 'the edit was sent');
        ws.push({ t: 'error', id: save.id, code, message: 'nope' });
        assert.equal(refused.length, 1, 'the app is told');
        assert.equal(refused[0].code, code);
        assert.deepEqual(refused[0].events.map((e) => e.title), ['A'], "the server's copy comes back with it");
        assert.ok(ws.sent.some((m) => m.t === 'hello'), 'and a fresh snapshot is asked for');
        const msg = S.refusedSaveMessage(code);
        assert.match(msg, /^Couldn’t save/);
        assert.doesNotMatch(msg, /Recovered/);
    });
}

test('rate_limited pauses saving and says so (onSyncPaused), it is not a refusal', () => {
    FakeSocket.all.length = 0;
    const { Service: S } = loadTab({ WebSocket: FakeSocket });
    const paused = [], refused = [];
    S.onSyncPaused = (p) => paused.push(p); S.onSyncRefused = (r) => refused.push(r);
    S.findAndSubscribe('room', () => {});
    const ws = FakeSocket.all[0];
    ws.push({ t: 'snapshot', v: 3, calendar: { id: 'room', title: 'T', options: {}, lastEditedAt: 1, events: [ev('a', 'A')] } });
    S.sync({ id: 'room', title: 'T', options: {}, events: [ev('a', 'A mine')] });
    ws.push({ t: 'error', id: ws.sent.find((m) => m.t === 'save').id, code: 'rate_limited' });
    assert.equal(paused.length, 1);
    assert.equal(refused.length, 0);
});

test('both apps word a refusal with a code through refusedSaveMessage, not as recovered events', () => {
    for (const f of ['public/app.js', 'public/nativecal/app.js']) {
        const src = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
        const handler = src.slice(src.indexOf('CalendarDataService.onSyncRefused'), src.indexOf('Recovered ${n}'));
        assert.match(handler, /if \(code\)[\s\S]*refusedSaveMessage\(code\)[\s\S]*jsError\('sync_refused'/, f);
    }
});
