/**
 * Pro stats breakdowns (cloudflare/src/RoomInsight.js): followers by app, views by UTC hour, and
 * views by source. The classifiers are pure; the counting runs on a real SQLite (node:sqlite) behind
 * the same sql.exec(...).toArray()/.one() shape a Durable Object has, so the dedup, the migration of
 * an older table and what ends up stored are checked for real.
 *
 * Run: node --test test/unit/room-insight-breakdowns.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node: the SQLite tests skip */ }

const load = () => import(pathToFileURL(path.join(__dirname, '../../cloudflare/src/RoomInsight.js')).href);

// Real User-Agents of calendar apps fetching ICS feeds.
const UA = {
    google: ['Google-Calendar-Importer'],
    apple: [
        'iOS/26.6 (23G71) dataaccessd/1.0',
        'iOS/18.0 (22A3354) dataaccessd/1.0',
        'macOS/26.6.2 (25G83) dataaccessd/1.0',
        'iPadOS/18.1 (22B83) dataaccessd/1.0',
        'Mac OS X/10.15.7 (19H15) CalendarAgent/954',
        'Mac_OS_X/10.13.6 (17G14042) CalendarAgent/399.6.1',
        'iOS/17.5 (21F79) accountsd/1.0',
    ],
    outlook: [
        'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)',
        'Microsoft Office/16.0 (Macintosh; Mac OS X 14.5; Microsoft Outlook 16.86)',   // Mac, still Outlook
        'Outlook-iOS/723.4027091.prod.iphone (4.2422.0)',
        'Outlook-Android/2.0',
        'Microsoft.Exchange/15.20 (Windows NT 10.0; Win64; x64)',
        'ExchangeWebServices/15.0',
        'Microsoft Exchange',
    ],
    other: [
        'ICSx5/2.2.5-gplay (ical4j/3.2.19 okhttp/4.12.0 Android/14)',
        'DAVx5/4.4.1-ose (2024/06/11; dav4jvm; okhttp/4.12.0) Android/14',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Thunderbird/128.3.0',  // Mac, not Apple's app
        'Mozilla/5.0 (X11; Linux x86_64; rv:115.0) Gecko/20100101 Thunderbird/115.15.0',
        'Fastmail/1.0 (+https://www.fastmail.com/)',
        'ProtonCalendar/1.0',
        '',
    ],
};

test('appOf: real calendar-app user agents land in the right app', async () => {
    const { appOf } = await load();
    for (const [app, list] of Object.entries(UA)) for (const ua of list) assert.equal(appOf(ua), app, ua || '(empty)');
});

test('sourceOf: embed, search, other site, direct', async () => {
    const { sourceOf } = await load();
    const host = 'pastecal.com';
    const cases = [
        [{ embed: '1', ref: 'myclub.de' }, 'embed'],                          // the embedded page's marker wins
        [{ dest: 'iframe' }, 'embed'],
        [{ referer: 'https://www.google.com/' }, 'search'],
        [{ referer: 'https://www.google.co.uk/' }, 'search'],
        [{ ref: 'www.bing.com' }, 'search'],
        [{ ref: 'duckduckgo.com' }, 'search'],
        [{ referer: 'https://search.brave.com/search?q=x' }, 'search'],
        [{ referer: 'https://www.ecosia.org/' }, 'search'],
        [{ referer: 'https://calendar.google.com/' }, 'site'],               // Google, but not search
        [{ referer: 'https://myclub.de/termine' }, 'site'],
        [{ ref: 'stura.uni-example.de' }, 'site'],
        [{ referer: 'https://www.reddit.com/r/x' }, 'site'],
        [{}, 'direct'],
        [{ referer: 'https://pastecal.com/abc' }, 'direct'],
        [{ referer: 'https://www.pastecal.com/abc' }, 'direct'],
        [{ referer: 'http://localhost:8894/abc', host: 'localhost:8894' }, 'direct'],
        [{ ref: 'mail.google.com' }, 'direct'],                               // a link someone sent
        [{ ref: 'web.whatsapp.com' }, 'direct'],
        [{ ref: '<script>' }, 'direct'],                                       // junk is ignored
        [{ ref: 'myclub.de', referer: 'https://pastecal.com/x' }, 'site'],     // the page's ref beats its own Referer
    ];
    for (const [input, want] of cases) assert.equal(sourceOf({ host, ...input }), want, JSON.stringify(input));
});

// ---- a room on a real SQLite -----------------------------------------------------------------
function fakeRoom(db, id = 'cal-1') {
    const sql = {
        exec(q, ...params) {
            const st = db.prepare(q);
            const rows = /^\s*(SELECT|WITH)/i.test(q) ? st.all(...params).map((r) => ({ ...r })) : (st.run(...params), []);
            return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one row'); return rows[0]; } };
        },
    };
    return { sql, state: { id }, statsSalt: null };
}
const hit = (kind, ip, ua, extra = {}) => new Request('http://internal/cal/x', { headers: { 'X-PC-Hit': kind, 'CF-Connecting-IP': ip, 'User-Agent': ua, ...extra } });
const today = () => new Date().toISOString().slice(0, 10);

test('countHit: one follower fetching 5 times is 1 in its app; distinct apps tally separately', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
    const { initInsight, countHit, statsReport } = await load();
    const room = fakeRoom(new DatabaseSync(':memory:'));
    initInsight(room.sql);
    for (let i = 0; i < 5; i++) await countHit(room, hit('follow', '17.0.1.6', UA.apple[0]));
    await countHit(room, hit('follow', '66.249.0.1', UA.google[0]));
    await countHit(room, hit('follow', '40.0.0.9', UA.outlook[0]));
    await countHit(room, hit('follow', '100.70.0.1', UA.other[0]));
    await countHit(room, hit('follow', '100.71.0.1', UA.apple[2]));
    const r = statsReport(room, 30);
    assert.equal(r.days.at(-1).followers, 5);
    assert.deepEqual(r.apps, { google: 1, apple: 2, outlook: 1, other: 1 });
    assert.equal(r.days.at(-1).views, 0, 'follows are never views');
    assert.deepEqual(r.hours, Array(24).fill(0), 'follows add no hours');
    assert.deepEqual(r.sources, { embed: 0, search: 0, site: 0, direct: 0 }, 'follows add no sources');
});

test('countHit: views tally by UTC hour and by source, deduplicated like the view count', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
    const { initInsight, countHit, statsReport } = await load();
    const room = fakeRoom(new DatabaseSync(':memory:'));
    initInsight(room.sql);
    const hour = new Date().getUTCHours();
    for (let i = 0; i < 4; i++) await countHit(room, hit('view', '203.0.113.11', 'Mozilla/5.0 A', { 'X-PC-Source': 'embed' }));   // one visit, polled
    await countHit(room, hit('view', '198.51.100.12', 'Mozilla/5.0 B', { 'X-PC-Source': 'search' }));
    await countHit(room, hit('view', '192.0.2.13', 'Mozilla/5.0 C', { 'X-PC-Source': 'site' }));
    await countHit(room, hit('view', '100.64.7.14', 'Mozilla/5.0 D'));                                            // no source: direct
    await countHit(room, hit('view', '100.65.7.14', 'Mozilla/5.0 E', { 'X-PC-Source': 'https://evil.example' })); // not a category: direct
    const r = statsReport(room, 30);
    assert.equal(r.totals.views, 5);
    assert.equal(r.hours.length, 24);
    assert.equal(r.hours[hour], 5);
    assert.equal(r.hours.reduce((a, n) => a + n, 0), r.totals.views, 'hours sum to the counted views');
    assert.deepEqual(r.sources, { embed: 1, search: 1, site: 1, direct: 2 });
    assert.deepEqual(r.apps, { google: 0, apple: 0, outlook: 0, other: 0 });
});

test('migration: an older stats_daily (no breakdown columns) keeps its rows and gains the columns', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
    const { initInsight, countHit, statsReport, statsDump } = await load();
    const db = new DatabaseSync(':memory:');
    const room = fakeRoom(db);
    // The schema as it shipped before the breakdowns, with a day already counted.
    db.exec(`CREATE TABLE stats_daily (day TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0, visitors INTEGER NOT NULL DEFAULT 0,
        followers INTEGER NOT NULL DEFAULT 0, countries_json TEXT, cities_json TEXT)`);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    db.prepare(`INSERT INTO stats_daily VALUES (?, 7, 4, 2, '{"US":4}', '{}')`).run(yesterday);
    initInsight(room.sql);
    initInsight(room.sql);                                  // runs on every start: must be idempotent
    const cols = db.prepare(`PRAGMA table_info(stats_daily)`).all().map((c) => c.name);
    for (const c of ['apps_json', 'hours_json', 'sources_json']) assert.ok(cols.includes(c), c);
    await countHit(room, hit('view', '203.0.113.11', 'Mozilla/5.0 A', { 'X-PC-Source': 'site' }));
    const r = statsReport(room, 30);
    assert.deepEqual(r.days.at(-2), { day: yesterday, views: 7, visitors: 4, followers: 2 }, 'the old row survives');
    assert.equal(r.totals.views, 8);
    assert.equal(r.hours.reduce((a, n) => a + n, 0), 1, 'old rows (NULL breakdowns) add nothing');
    assert.deepEqual(r.sources, { embed: 0, search: 0, site: 1, direct: 0 });
    assert.equal(statsDump(room).daily.find((d) => d.day === yesterday).apps_json, null);
});

test('stored rows hold only categories: no user agent, IP or referrer anywhere', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
    const { initInsight, countHit, statsDump, APPS, SOURCES } = await load();
    const room = fakeRoom(new DatabaseSync(':memory:'));
    initInsight(room.sql);
    const all = Object.values(UA).flat().filter(Boolean);
    let i = 0;
    for (const ua of all) await countHit(room, hit('follow', `10.9.${++i}.1`, ua));
    await countHit(room, hit('view', '10.8.0.1', 'Mozilla/5.0 viewer-xyz', { Referer: 'https://secret-site.example/page', 'X-PC-Source': 'site' }));
    const d = statsDump(room);
    const text = JSON.stringify(d);
    for (const ua of all) assert.ok(!text.includes(ua), `UA stored: ${ua}`);
    for (const needle of ['viewer-xyz', 'secret-site', '10.9.', '10.8.0']) assert.ok(!text.includes(needle), needle);
    const row = d.daily.find((r) => r.day === today());
    assert.ok(Object.keys(JSON.parse(row.apps_json)).every((k) => APPS.includes(k)));
    assert.ok(Object.keys(JSON.parse(row.sources_json)).every((k) => SOURCES.includes(k)));
    assert.ok(JSON.parse(row.hours_json).every((n) => Number.isInteger(n)));
});
