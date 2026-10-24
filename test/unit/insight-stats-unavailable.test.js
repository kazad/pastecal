/**
 * /api/stats and /api/pro/stats never turn a missing stats answer into zeros (cloudflare/src/Insight.js).
 * A room running code from before stats (production rooms, reached by preview's Worker until production
 * deploys) answers GET .../stats with the calendar itself: 200, no days[]. The endpoints must report
 * 503 {ok:false, error:'stats-unavailable'} for that, for a non-200, and for junk; and pass a real answer.
 *
 * Insight.js imports Accounts.js, which imports 'cloudflare:workers'; that is stubbed here.
 * Run: node --test test/unit/insight-stats-unavailable.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const nodeModule = require('node:module');

const canStub = typeof nodeModule.registerHooks === 'function';
if (canStub) {
    nodeModule.registerHooks({
        resolve(specifier, context, next) {
            if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {}', shortCircuit: true };
            return next(specifier, context);
        },
    });
}
const load = () => import(pathToFileURL(path.join(__dirname, '../../cloudflare/src/Insight.js')).href);

const REAL = { days: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(11 + i).padStart(2, '0')}`, views: i < 7 ? 1 : 2, visitors: 1, followers: i === 13 ? 3 : 1 })),
    countries: [], cities: [], apps: { google: 0, apple: 3, outlook: 0, other: 0 }, hours: Array(24).fill(0), sources: { embed: 0, search: 0, site: 0, direct: 21 },
    totals: { views: 21, visitors: 14, followers: 3, followersToday: 3 } };
const OLD_ROOM = { calendar: { id: 'c1', title: 'Team', events: [] }, v: 4 };   // an older room: the calendar, not stats

// A CALENDARS binding whose rooms answer lock-status (unlocked, or locked by u1) and stats with `stats`.
function env(stats, { locked = false } = {}) {
    const roomFetch = async (u) => {
        const op = new URL(typeof u === 'string' ? u : u.url).pathname.split('/').pop();
        if (op === 'lock-status') return Response.json({ locked, ownerId: locked ? 'u1' : null, lockedAt: 1 });
        if (op === 'stats') return typeof stats === 'function' ? stats() : Response.json(stats);
        return new Response('not found', { status: 404 });
    };
    return { CALENDARS: { idFromName: (n) => n, get: () => ({ fetch: roomFetch }) } };
}
const call = async (stats, url, opts) => {
    const { handleInsight } = await load();
    const u = new URL(url, 'https://pastecal.com');
    const res = await handleInsight(new Request(u), env(stats, opts), u, async () => 'u1');
    return { status: res.status, body: await res.json() };
};

const cases = [
    ['an older room answering with the calendar (200, no days)', OLD_ROOM],
    ['a room answering 404 (no stats route)', () => new Response('not found', { status: 404 })],
    ['a room answering 500', () => new Response('boom', { status: 500 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['days but no totals', { days: [] }],
    ['days not an array', { days: {}, totals: {} }],
];

for (const [name, stats] of cases) {
    test(`free /api/stats: ${name} -> 503 stats-unavailable, never zeros`, { skip: !canStub && 'module.registerHooks unavailable' }, async () => {
        const r = await call(stats, '/api/stats?calendar=c1');
        assert.equal(r.status, 503);
        assert.deepEqual(r.body, { ok: false, error: 'stats-unavailable' });
    });
    test(`/api/pro/stats: ${name} -> 503 stats-unavailable`, { skip: !canStub && 'module.registerHooks unavailable' }, async () => {
        const r = await call(stats, '/api/pro/stats?calendar=c1', { locked: true });
        assert.equal(r.status, 503);
        assert.deepEqual(r.body, { ok: false, error: 'stats-unavailable' });
    });
}

test('a real stats answer still passes: free gets its 3 counts, Pro the whole payload', { skip: !canStub && 'module.registerHooks unavailable' }, async () => {
    const free = await call(REAL, '/api/stats?calendar=c1');
    assert.equal(free.status, 200);
    assert.deepEqual(free.body, { views: 14, viewsPrev: 7, followers: 3 });
    const pro = await call(REAL, '/api/pro/stats?calendar=c1', { locked: true });
    assert.equal(pro.status, 200);
    assert.deepEqual(pro.body, REAL);
});
