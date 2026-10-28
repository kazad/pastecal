/**
 * Exact names first on the edit page (Oct 28 2026: the owner of "foo" was taken to "Foo", another calendar, because
 * the directory keeps one row per lowercase name). The page's own decision, with the lookup answering as the
 * directory did before the server learned exact names ({actualSlug: 'Foo'}): it must stay on "foo" when a calendar of
 * exactly that name exists, and follow the row only when none does. Both data paths: Cloudflare (CloudCalendarService)
 * and Firebase (CalendarDataService). The Worker half: cloudflare/test/exact-names.test.mjs; the page itself:
 * cloudflare/test/exact-names.spec.js.
 *
 * Run: node --test test/unit/exact-names.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTab } = require('../cloud-loader.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

class FakeSocket {
    static all = [];
    constructor(url) { this.url = url; this.readyState = 1; FakeSocket.all.push(this); }
    send() {}
    close() { this.readyState = 3; }
}
const roomOf = (ws) => decodeURIComponent(ws.url.match(/\/cal\/([^/]+)\/ws/)[1]);

// A Cloudflare tab whose server holds `calendars` (exact ids) and whose lookup answers `answer`.
function cloudTab(calendars, answer) {
    FakeSocket.all.length = 0;
    const tab = loadTab({ WebSocket: FakeSocket });
    const tracked = [], asked = [];
    tab.ctx.trackSafely = (fn) => fn({ track: (name) => tracked.push(name) });
    tab.ctx.fetch = async (u, init = {}) => {
        const url = new URL(u);
        asked.push(`${init.method || 'GET'} ${decodeURIComponent(url.pathname)}`);
        if (url.pathname === '/api/lookup') return { ok: true, status: 200, json: async () => answer };
        const m = url.pathname.match(/^\/cal\/([^/]+)$/);
        if (m && init.method === 'HEAD') return { ok: true, status: calendars.includes(decodeURIComponent(m[1])) ? 200 : 404 };
        return { ok: false, status: 404, json: async () => ({}) };
    };
    return { tab, tracked, asked };
}
const open = () => FakeSocket.all.filter((ws) => ws.readyState === 1).map(roomOf);

test('cloud: "foo" and "Foo" both exist, the row says Foo: opening /foo stays on foo (edit_case_variant)', async () => {
    const { tab, tracked, asked } = cloudTab(['Foo', 'foo'], { found: true, actualSlug: 'Foo', isReadOnly: false, targetId: 'Foo' });
    tab.Service.findAndSubscribe('foo', () => {});
    await settle();
    assert.deepEqual(open(), ['foo']);
    assert.deepEqual(tracked, ['edit_case_variant']);
    assert.ok(asked.includes('HEAD /cal/foo'));
});

test('cloud: no calendar at exactly "FOO": the row is followed to Foo, as before (a mistyped case)', async () => {
    const { tab, tracked } = cloudTab(['Foo', 'foo'], { found: true, actualSlug: 'Foo', isReadOnly: false, targetId: 'Foo' });
    tab.Service.findAndSubscribe('FOO', () => {});
    await settle();
    assert.deepEqual(open(), ['Foo']);
    assert.deepEqual(tracked, []);
});

test('cloud: a spaced name ("cvpilot ") whose row is the trimmed spelling\'s stays on itself', async () => {
    const { tab } = cloudTab(['cvpilot', 'cvpilot '], { found: true, actualSlug: 'cvpilot', isReadOnly: false, targetId: 'cvpilot' });
    tab.Service.findAndSubscribe('cvpilot ', () => {});
    await settle();
    assert.deepEqual(open(), ['cvpilot ']);
});

test('cloud: the row\'s own spelling asks nothing more (no HEAD)', async () => {
    const { tab, tracked, asked } = cloudTab(['Foo'], { found: true, actualSlug: 'Foo', isReadOnly: false, targetId: 'Foo' });
    tab.Service.findAndSubscribe('Foo', () => {});
    await settle();
    assert.deepEqual(open(), ['Foo']);
    assert.deepEqual(asked, ['GET /api/lookup']);
    assert.deepEqual(tracked, []);
});

test('cloud: the server answered the exact name itself (exact: case / view): stays, and says which', async () => {
    for (const [exact, event] of [['case', 'edit_case_variant'], ['view', 'edit_name_collision']]) {
        const { tab, tracked } = cloudTab(['foo'], { found: true, actualSlug: 'foo', isReadOnly: false, targetId: 'foo', exact });
        tab.Service.findAndSubscribe('foo', () => {});
        await settle();
        assert.deepEqual(open(), ['foo']);
        assert.deepEqual(tracked, [event]);
    }
});

// The Firebase path (CalendarDataService itself): a fake db that holds `calendars` by exact key.
function firebaseTab(calendars, answer) {
    const tab = loadTab({ search: '?backend=firebase' });
    const S = tab.Service;
    assert.equal(S, tab.run('CalendarDataService'));
    const tracked = [], subscribed = [];
    tab.ctx.trackSafely = (fn) => fn({ track: (name) => tracked.push(name) });
    S.db = { child: (k) => ({ once: async () => ({ val: () => (calendars.includes(k) ? { id: k } : null) }), on: () => subscribed.push(k) }) };
    S.lookupCalendar = async () => ({ data: answer });
    return { S, tracked, subscribed };
}

test('firebase: the directory says Foo, a calendar "foo" exists: subscribes foo (edit_case_variant); FOO follows to Foo', async () => {
    let t = firebaseTab(['Foo', 'foo'], { found: true, actualSlug: 'Foo', isReadOnly: false });
    await t.S.findAndSubscribe('foo', () => {});
    assert.deepEqual(t.subscribed, ['foo']);
    assert.deepEqual(t.tracked, ['edit_case_variant']);
    t = firebaseTab(['Foo', 'foo'], { found: true, actualSlug: 'Foo', isReadOnly: false });
    await t.S.findAndSubscribe('FOO', () => {});
    assert.deepEqual(t.subscribed, ['Foo']);
    assert.deepEqual(t.tracked, []);
});
