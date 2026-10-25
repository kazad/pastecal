/**
 * Stats counting (cloudflare/src/RoomInsight.js + Insight.js), the production subset: dedup, the
 * caps, the day roll-over, the network prefix, what the Worker marks as a hit, and that the stats
 * tables are added to a room written by master's code without touching its tables.
 * Counting runs on a real SQLite (node:sqlite) behind the Durable Object's sql.exec() shape.
 *
 * Run: node --test test/unit/room-insight-counting.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const nodeModule = require('node:module');

// On pro, Insight.js imports Accounts.js, which imports 'cloudflare:workers'; stubbed as in
// insight-stats-unavailable.test.js.
if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
        resolve(specifier, context, next) {
            if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {}', shortCircuit: true };
            return next(specifier, context);
        },
    });
}

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node: the SQLite tests skip */ }
const noSqlite = !DatabaseSync && 'node:sqlite unavailable';

const load = () => import(pathToFileURL(path.join(__dirname, '../../cloudflare/src/RoomInsight.js')).href);
const loadWorker = () => import(pathToFileURL(path.join(__dirname, '../../cloudflare/src/Insight.js')).href);

function fakeRoom(db, id = 'cal-1') {
    const sql = {
        exec(q, ...params) {
            const st = db.prepare(q);
            const rows = /^\s*(SELECT|WITH|PRAGMA)/i.test(q) ? st.all(...params).map((r) => ({ ...r })) : (st.run(...params), []);
            return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one row'); return rows[0]; } };
        },
    };
    return { sql, state: { id }, statsSalt: null };
}
const hit = (kind, ip, ua, extra = {}) => new Request('http://internal/cal/x', { headers: { 'X-PC-Hit': kind, 'CF-Connecting-IP': ip, 'User-Agent': ua, ...extra } });
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
async function freshRoom() {
    const m = await load();
    const room = fakeRoom(new DatabaseSync(':memory:'));
    m.initInsight(room.sql);
    const row = () => m.statsDump(room).daily.find((r) => r.day === day()) || { views: 0, visitors: 0, followers: 0 };
    return { ...m, room, counts: () => { const r = row(); return [r.views, r.visitors, r.followers]; } };
}
// Run fn with some STATS changed, then put them back (STATS is shared module state).
async function withStats(STATS, patch, fn) {
    const saved = { ...STATS };
    Object.assign(STATS, patch);
    try { await fn(); } finally { Object.assign(STATS, saved); }
}

test('ipPrefix: IPv4 /24, IPv6 /64 (expanded, zeros trimmed), IPv4-mapped IPv6 as IPv4', async () => {
    const { ipPrefix } = await load();
    assert.equal(ipPrefix('203.0.113.11'), '203.0.113');
    assert.equal(ipPrefix('::ffff:198.18.4.99'), '198.18.4');
    assert.equal(ipPrefix('2001:db8:77:1:abcd::1'), '2001:db8:77:1::/64');
    assert.equal(ipPrefix('2001:0db8:0077:0001:ffff:0:0:1'), '2001:db8:77:1::/64');
    assert.equal(ipPrefix('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipPrefix(''), '');
});

test('views: one visitor polling, reconnecting and reloading is one view within 30 minutes', { skip: noSqlite }, async () => {
    const { countHit, room, counts } = await freshRoom();
    for (let i = 0; i < 10; i++) await countHit(room, hit('view', '203.0.113.11', 'Mozilla/5.0 A'));
    await countHit(room, hit('view', '203.0.113.12', 'Mozilla/5.0 A'));      // same /24, same UA: same visitor
    assert.deepEqual(counts(), [1, 1, 0]);
    await countHit(room, hit('view', '198.51.100.12', 'Mozilla/5.0 B'));
    assert.deepEqual(counts(), [2, 2, 0]);
});

test('cap: past 3 user agents on one network, a new one is one of those already seen', { skip: noSqlite }, async () => {
    const { countHit, room, counts, statsDump } = await freshRoom();
    for (let i = 0; i < 50; i++) await countHit(room, hit('view', '198.18.4.20', `Mozilla/5.0 rotating ${i}`));
    assert.deepEqual(counts(), [3, 3, 0]);
    assert.equal(statsDump(room).seen.length, 3, 'only 3 hashes tracked for that network');
});

test('cap: at most maxViewsPerVisitor views per visitor per day', { skip: noSqlite }, async () => {
    const { countHit, room, counts, STATS } = await freshRoom();
    await withStats(STATS, { viewGapMs: 0, maxViewsPerVisitor: 5 }, async () => {
        for (let i = 0; i < 12; i++) await countHit(room, hit('view', '203.0.113.11', 'Mozilla/5.0 A'));
        assert.deepEqual(counts(), [5, 1, 0]);
    });
});

test('cap: past maxSeenPerDay the visitors and followers numbers stop growing; views still count (deduplicated)', { skip: noSqlite }, async () => {
    const { countHit, room, counts, STATS } = await freshRoom();
    await withStats(STATS, { maxSeenPerDay: 3 }, async () => {
        for (let i = 1; i <= 6; i++) await countHit(room, hit('view', `100.64.${i}.1`, 'Mozilla/5.0 V'));
        for (let i = 1; i <= 6; i++) await countHit(room, hit('view', `100.64.${i}.1`, 'Mozilla/5.0 V'));   // again, within the gap
        for (let i = 1; i <= 5; i++) await countHit(room, hit('follow', `100.65.${i}.1`, 'Google-Calendar-Importer'));
        assert.deepEqual(counts(), [6, 3, 3]);
    });
});

test('cap: past maxTrackedPerDay new people are not counted at all (no unbounded views)', { skip: noSqlite }, async () => {
    const { countHit, room, counts, STATS, statsDump } = await freshRoom();
    await withStats(STATS, { maxTrackedPerDay: 4 }, async () => {
        for (let i = 1; i <= 10; i++) await countHit(room, hit('view', `100.66.${i}.1`, 'Mozilla/5.0 V'));
        for (let i = 1; i <= 10; i++) await countHit(room, hit('follow', `100.67.${i}.1`, 'Google-Calendar-Importer'));
        assert.deepEqual(counts(), [4, 4, 4]);
        assert.equal(statsDump(room).seen.length, 8, '4 views + 4 follows tracked');
    });
});

test('follows are never views, and a follower fetching all day counts once', { skip: noSqlite }, async () => {
    const { countHit, room, counts } = await freshRoom();
    for (let i = 0; i < 20; i++) await countHit(room, hit('follow', '66.249.0.1', 'Google-Calendar-Importer'));
    assert.deepEqual(counts(), [0, 0, 1]);
});

test('no hits for a room nobody created, and none without the Worker marker', { skip: noSqlite }, async () => {
    const m = await load();
    const db = new DatabaseSync(':memory:');
    const empty = fakeRoom(db, null);
    m.initInsight(empty.sql);
    await m.countHit(empty, hit('view', '203.0.113.11', 'Mozilla/5.0 A'));
    assert.deepEqual(m.statsDump(empty), { daily: [], seen: [], saltDays: [] });
    const room = fakeRoom(db);
    await m.countHit(room, new Request('http://internal/cal/x', { headers: { 'CF-Connecting-IP': '203.0.113.11', 'User-Agent': 'A' } }));
    await m.countHit(room, hit('bogus', '203.0.113.11', 'A'));
    assert.deepEqual(m.statsDump(room).daily, []);
});

test('the day rolls over: yesterday\'s salt and hashes are deleted, its counts stay, rows past keepDays go', { skip: noSqlite }, async () => {
    const { countHit, room, statsDump, STATS } = await freshRoom();
    const ancient = day(Date.now() - (STATS.keepDays + 5) * 86400000);
    room.sql.exec(`INSERT INTO stats_daily (day, views, visitors, followers) VALUES (?, 9, 9, 9)`, ancient);
    await countHit(room, hit('view', '203.0.113.11', 'Mozilla/5.0 A'));
    const before = statsDump(room);
    const realNow = Date.now;
    Date.now = () => realNow() + 86400000;
    try {
        await countHit(room, hit('view', '203.0.113.11', 'Mozilla/5.0 A'));
        const after = statsDump(room);
        const tomorrow = day(Date.now());
        assert.deepEqual(after.saltDays, [tomorrow]);
        assert.equal(after.seen.length, 1, 'only today\'s one hash');
        assert.notEqual(after.seen[0].hash, before.seen[0].hash, 'a new salt: the same visitor hashes differently');
        assert.ok(after.daily.find((r) => r.day === day(realNow())), 'yesterday\'s counts stay');
        assert.ok(!after.daily.find((r) => r.day === ancient), 'rows older than keepDays are deleted');
        assert.equal(after.daily.find((r) => r.day === tomorrow).visitors, 1);
    } finally { Date.now = realNow; }
});

test('stored: only 16-hex hashes, counts and category tallies; never an IP, a user agent or a referrer', { skip: noSqlite }, async () => {
    const { countHit, room, statsDump } = await freshRoom();
    const ua = 'Mozilla/5.0 (Macintosh) very-unique-ua-7731';
    await countHit(room, hit('view', '203.0.113.77', ua, { Referer: 'https://private-site.example/x', 'X-PC-Source': 'site', 'X-PC-Geo-Country': 'US', 'X-PC-Geo-City': 'Portland' }));
    await countHit(room, hit('follow', '2001:db8:aa:bb::5', 'iOS/18.0 (22A) dataaccessd/1.0'));
    const d = statsDump(room);
    assert.ok(d.seen.every((x) => /^[0-9a-f]{16}$/.test(x.hash)));
    const text = JSON.stringify(d);
    for (const needle of ['203.0.113', 'very-unique-ua', 'private-site', '2001:db8', 'dataaccessd']) assert.ok(!text.includes(needle), needle);
    // The schema itself has nowhere to put them.
    const cols = (t) => room.sql.exec(`PRAGMA table_info(${t})`).toArray().map((c) => c.name).sort().join();
    assert.equal(cols('stats_seen'), 'hash,kind,last_at,views');
    assert.equal(cols('stats_salt'), 'day,k,salt');
    assert.equal(cols('stats_daily'), 'apps_json,cities_json,countries_json,day,followers,hours_json,sources_json,views,visitors');
});

test('migration: initInsight on a room written by master\'s code adds the stats tables and changes nothing else', { skip: noSqlite }, async () => {
    const { initInsight, countHit, statsDump } = await load();
    const db = new DatabaseSync(':memory:');
    // master's CalendarRoom schema, with data.
    db.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)`);
    db.exec(`CREATE TABLE events (k TEXT PRIMARY KEY, pos INTEGER, data TEXT)`);
    db.exec(`CREATE TABLE history (v INTEGER PRIMARY KEY, at INTEGER, source TEXT, commands TEXT, entry TEXT)`);
    db.exec(`CREATE TABLE authors (uid TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, edit_count INTEGER, created_here INTEGER, days TEXT)`);
    db.prepare(`INSERT INTO meta VALUES ('id', '"cal-1"'), ('v', '3'), ('title', '"T"')`).run();
    db.prepare(`INSERT INTO events VALUES ('e1', 0, '{"id":"e1","title":"Soccer"}')`).run();
    db.prepare(`INSERT INTO history VALUES (3, 1, 'save', '[]', '{}')`).run();
    db.prepare(`INSERT INTO authors VALUES ('a', 1, 2, 3, 1, '[]')`).run();
    const snapshot = () => ['meta', 'events', 'history', 'authors'].map((t) => [
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(t).sql,
        db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map((r) => ({ ...r })),
    ]);
    const before = JSON.stringify(snapshot());
    const room = fakeRoom(db);
    initInsight(room.sql);
    initInsight(room.sql);                                  // runs on every start: must be idempotent
    assert.equal(JSON.stringify(snapshot()), before, "master's tables untouched");
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((r) => r.name);
    // restore_log is pro's (restore audit, RoomInsight.js); production's subset had only the stats_* tables.
    assert.deepEqual(tables.filter((t) => t !== 'restore_log'), ['authors', 'events', 'history', 'meta', 'stats_daily', 'stats_salt', 'stats_seen']);
    await countHit(room, hit('view', '203.0.113.11', 'Mozilla/5.0 A'));
    assert.equal(statsDump(room).daily[0].views, 1);
    assert.equal(JSON.stringify(snapshot()), before, 'counting writes only stats tables');
});

test('the Pro branch\'s report reads what production counted (skipped when the pro worktree is absent)', { skip: noSqlite }, async (t) => {
    // Since the launch merge this tree IS pro, so its own RoomInsight.js is the report.
    const proFile = path.join(__dirname, '../../cloudflare/src/RoomInsight.js');
    const pro = await import(pathToFileURL(proFile).href);
    if (typeof pro.statsReport !== 'function') return t.skip('pro has no statsReport');
    const { countHit, room } = await freshRoom();
    await countHit(room, hit('view', '203.0.113.11', 'Mozilla/5.0 A', { 'X-PC-Source': 'search' }));
    await countHit(room, hit('follow', '66.249.0.1', 'Google-Calendar-Importer'));
    pro.initInsight(room.sql);                              // pro's own migration over production's tables
    const r = pro.statsReport(room, 30);
    assert.deepEqual(r.days.at(-1), { day: day(), views: 1, visitors: 1, followers: 1 });
    assert.equal(r.sources.search, 1);
    assert.equal(r.apps.google, 1);
});

// ---- the Worker half (Insight.js) ------------------------------------------------------------
const req = (url, headers = {}, cf) => { const r = new Request(url, { headers }); if (cf) Object.defineProperty(r, 'cf', { value: cf }); return r; };

test('isBot / hitHeaders: crawlers, previews, monitors, curl and empty user agents are not hits', async () => {
    const { hitHeaders, isBot } = await loadWorker();
    for (const ua of ['', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl/8.4.0', 'Slackbot-LinkExpanding 1.0',
        'Mozilla/5.0 UptimeRobot/2.0', 'facebookexternalhit/1.1 preview', 'python-requests/2.31', 'Mozilla/5.0 HeadlessChrome/120']) {
        assert.equal(hitHeaders(req('https://pastecal.com/cal/x', { 'User-Agent': ua }), {}, 'view'), null, ua || '(empty)');
    }
    assert.equal(isBot(req('https://pastecal.com/cal/x', { 'User-Agent': 'Mozilla/5.0' }, { botManagement: { verifiedBot: true } })), true);
    assert.equal(isBot(req('https://pastecal.com/cal/x', { 'User-Agent': 'Mozilla/5.0' }, { botManagement: { score: 5 } })), true);
    for (const ua of ['Google-Calendar-Importer', 'iOS/18.0 (22A) dataaccessd/1.0', 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)']) {
        assert.equal(hitHeaders(req('https://pastecal.com/x.ics', { 'User-Agent': ua }), {}, 'follow')['X-PC-Hit'], 'follow', ua);
    }
});

test('hitHeaders: a view carries only a source category and the place from request.cf', async () => {
    const { hitHeaders } = await loadWorker();
    const ua = { 'User-Agent': 'Mozilla/5.0 (Macintosh)' };
    const h = hitHeaders(req('https://pastecal.com/cal/x', { ...ua, Referer: 'https://www.google.com/search?q=secret' }, { country: 'US', city: 'São Paulo' }), {}, 'view');
    assert.deepEqual(h, { 'X-PC-Hit': 'view', 'X-PC-Geo-Country': 'US', 'X-PC-Geo-City': encodeURIComponent('São Paulo'), 'X-PC-Source': 'search' });
    assert.equal(hitHeaders(req('https://pastecal.com/cal/x', { ...ua, Referer: 'https://pastecal.com/x' }), {}, 'view')['X-PC-Source'], 'direct');
    assert.equal(hitHeaders(req('https://pastecal.com/cal/x', { ...ua, Referer: 'https://myclub.example/' }), {}, 'view')['X-PC-Source'], 'site');
    assert.equal(hitHeaders(req('https://pastecal.com/cal/x', { ...ua, 'Sec-Fetch-Dest': 'iframe' }), {}, 'view')['X-PC-Source'], 'embed');
    assert.equal(hitHeaders(req('https://pastecal.com/cal/x?src=embed', ua), {}, 'view')['X-PC-Source'], 'embed');
    assert.equal(hitHeaders(req('https://pastecal.com/cal/x?src=https://evil.example', ua), {}, 'view')['X-PC-Source'], 'direct');
    assert.equal(hitHeaders(req('https://pastecal.com/x.ics', ua), {}, 'follow')['X-PC-Source'], undefined, 'follows carry no source');
});

test('withoutSourceParams: removes embed/ref/src; any other URL comes back exactly as it was', async () => {
    const { withoutSourceParams } = await loadWorker();
    for (const u of ['https://pastecal.com/cal/a%20b/ws?author=x%20y', 'https://pastecal.com/cal/x', 'https://pastecal.com/cal/x?view=v']) assert.equal(withoutSourceParams(u), u);
    assert.equal(withoutSourceParams('https://pastecal.com/cal/x/ws?author=a&embed=1&ref=site.example&src=site'), 'https://pastecal.com/cal/x/ws?author=a');
});

test('index.js strips every client X-PC-* header before a room sees a request (forRoom on each room forward)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../cloudflare/src/index.js'), 'utf8');
    assert.match(src, /startsWith\('x-pc-'\)\) headers\.delete\(k\)/);
    // Every public request forwarded to a room goes through forRoom; the only other room fetches are
    // the Worker's own http://internal/... requests, which never copy a client's headers wholesale.
    const fetches = src.match(/room\.fetch\([^\n]*/g) || [];
    for (const f of fetches) assert.ok(/forRoom\(|http:\/\/internal\//.test(f), f);
    assert.ok(!/room\.fetch\(request\)/.test(src), 'no raw forward of the client request');
});
