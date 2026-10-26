/**
 * Unit tests for ProInsightMath (public/components/ProInsight.js): the pure parts of the Pro
 * Stats and History dialogs -- period comparison, chart scaling, UTC day labels, the 7-day
 * window free calendars get in Recent changes, version grouping, and the restore label.
 *
 * Run: node --test test/unit/pro-insight.test.js
 */
process.env.TZ = 'America/Los_Angeles';   // UTC days must not shift a day west of Greenwich

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProInsightMath: M } = require('../../public/components/ProInsight.js');

const series = (n, f) => Array.from({ length: n }, (_, i) => {
    const day = new Date(Date.UTC(2026, 9, 23) - (n - 1 - i) * 86400000).toISOString().slice(0, 10);
    return { day, ...f(i) };
});

test('compareRange: 30 compares within 90, 90 within 365, a year has nothing before it', () => {
    assert.equal(M.compareRange(30), 90);
    assert.equal(M.compareRange(90), 365);
    assert.equal(M.compareRange(365), null);
});

test('periods: sums views and visitors, takes the busiest day of followers, splits current and previous', () => {
    const rows = series(90, (i) => ({ views: i < 60 ? 1 : 2, visitors: 1, followers: i === 70 ? 9 : i === 10 ? 4 : 1 }));
    const p = M.periods(rows, 30);
    assert.deepEqual(p.now, { views: 60, visitors: 30, followers: 9 });
    assert.deepEqual(p.prev, { views: 30, visitors: 30, followers: 1 });
    assert.equal(M.periods(series(30, () => ({ views: 1 })), 30).prev, null, 'no previous period inside 30 rows');
});

test('delta: percent change; nothing when there is no earlier count to compare with', () => {
    assert.deepEqual(M.delta(60, 30), { text: '+100%', dir: 'up' });
    assert.deepEqual(M.delta(15, 30), { text: '−50%', dir: 'down' });
    assert.deepEqual(M.delta(30, 30), { text: 'Same', dir: 'flat' });
    assert.equal(M.delta(5, 0), null);
    assert.equal(M.delta(0, 0), null);
    assert.equal(M.delta(5, null), null);
});

test('niceMax: a round axis top, never zero', () => {
    assert.deepEqual([0, 1, 3, 7, 10, 11, 41, 99, 101, 2500].map((n) => M.niceMax(n)), [1, 1, 5, 10, 10, 20, 50, 100, 200, 5000]);
});

test('bars: one per day inside the box, tallest reaches the axis top, a lone visit stays visible', () => {
    const rows = series(30, (i) => ({ views: i === 29 ? 10 : i === 0 ? 1 : 0 }));
    const { top, bars } = M.bars(rows, 'views', 600, 150);
    assert.equal(top, 10);
    assert.equal(bars.length, 30);
    const last = bars[29], first = bars[0];
    assert.equal(last.h, 150);
    assert.equal(last.y, 0);
    assert.ok(first.h >= 1.5 && first.h < 150, 'small but visible');
    assert.equal(bars[5].h, 0);
    for (const b of bars) assert.ok(b.x >= 0 && b.x + b.w <= 600.01, `bar inside: ${b.x}+${b.w}`);
    // 365 thin bars still fit and have no gap
    const year = M.bars(series(365, () => ({ views: 1 })), 'views', 600, 150).bars;
    assert.equal(year.length, 365);
    assert.ok(year[364].x + year[364].w <= 600.01);
    // empty series
    assert.deepEqual(M.bars([], 'views', 600, 150).bars, []);
});

test('dayLabel: a server day is that calendar date in every time zone', () => {
    assert.match(M.dayLabel('2026-10-23'), /Oct 23/);
    assert.match(M.dayLabel('2026-01-01', { month: 'short', day: 'numeric', year: 'numeric' }), /Jan 1, 2026/);
});

test('summary: total, average and busiest day; a plain sentence when empty', () => {
    const rows = series(30, (i) => ({ views: i === 29 ? 12 : 1 }));
    const s = M.summary(rows, 'views', 'views');
    assert.match(s, /^41 views in 30 days, about 1\.4 a day\. Busiest day: Fri, Oct 23, 12\.$/);
    assert.equal(M.summary(series(30, () => ({ views: 0 })), 'views', 'views'), 'No views in these 30 days.');
    // One view in a month: "1 view", and "less than one a day" rather than "about 0 a day".
    assert.match(M.summary(series(30, (i) => ({ views: i === 29 ? 1 : 0 })), 'views', 'views'), /^1 view in 30 days, less than one a day\. Busiest day: /);
    // Followers are never added up across days: the same apps fetch every day.
    const f = M.summary(series(30, (i) => ({ followers: i === 10 ? 7 : 3 })), 'followers', 'followers');
    assert.equal(f, 'Up to 7 calendar apps fetched it on one day (Sun, Oct 4). Today: 3.');
});

test('flag: regional indicators from a two-letter code, nothing for anything else', () => {
    assert.equal(M.flag('us'), '🇺🇸');
    assert.equal(M.flag('GB'), '🇬🇧');
    assert.equal(M.flag(''), '');
    assert.equal(M.flag('USA'), '');
});

test('withinDays: the 7-day window for free calendars, by the server clock', () => {
    const now = Date.UTC(2026, 9, 23, 12);
    const d = 86400000;
    const entries = [{ savedAt: now - d }, { savedAt: now - 7 * d + 1000 }, { savedAt: now - 7 * d - 1000 }, { savedAt: now - 30 * d }];
    assert.deepEqual(M.withinDays(entries, 7, now).map((e) => e.savedAt), [now - d, now - 7 * d + 1000]);
    assert.deepEqual(M.withinDays(null, 7, now), []);
});

test('groupVersions: newest first, grouped by the reader’s local day, Today / Yesterday labels', () => {
    const now = Date.parse('2026-10-23T20:00:00Z');   // 1 PM in Los Angeles
    const list = [
        { date: '2026-10-23T190000Z', day: '2026-10-23', kind: 'restore-point', savedAt: '2026-10-23T19:00:00.000Z' },
        { date: '2026-10-23', day: '2026-10-23', kind: 'daily', savedAt: '2026-10-23T18:00:00.000Z' },
        // Saved 03:00 UTC on the 23rd = the evening of the 22nd in Los Angeles
        { date: '2026-10-23x', day: '2026-10-23', kind: 'daily', savedAt: '2026-10-23T03:00:00.000Z' },
        { date: '2026-10-20', day: '2026-10-20', kind: 'daily', savedAt: null },
    ];
    const g = M.groupVersions(list, now);
    assert.deepEqual(g.map((x) => x.label.replace(/ /g, ' ')), ['Today', 'Yesterday', 'Tue, Oct 20']);
    assert.deepEqual(g.map((x) => x.items.length), [2, 1, 1]);
});

test('restoredLabel: the server’s ISO date becomes a readable one', () => {
    assert.equal(M.restoredLabel('Restored the version from 2026-10-21'), 'Restored the version from Oct 21');
    const withTime = M.restoredLabel('Restored the version from 2026-10-21 14:05 UTC');
    assert.match(withTime, /^Restored the version from Oct 21, 7:05\s?AM$/);
    assert.equal(M.restoredLabel(''), 'Restored an earlier version');
});

test('eventsByDate: groups by date, soonest first; all-day events keep their UTC date', () => {
    const groups = M.eventsByDate([
        { title: 'Late', start: '2026-10-25T01:00:00Z' },               // Oct 24, 6 PM in LA
        { title: 'Game', start: '2026-10-24T00:00:00Z', isAllDay: true }, // all day Oct 24 (UTC midnight)
        { title: 'Fair', start: '2026-10-23T15:00:00Z', isAllDay: true }, // Tokyo's midnight of Oct 24
        { title: '', start: '2026-10-20T16:00:00Z', recurrencerule: 'FREQ=WEEKLY' },
        { title: 'No date' },
    ]);
    assert.deepEqual(groups.map((g) => g.events.map((e) => e.title)), [['Untitled event'], ['Fair', 'Game', 'Late'], ['No date']]);
    assert.equal(groups[0].events[0].repeats, true);
    assert.equal(groups[1].events[0].time, 'All day');
    assert.equal(groups[2].label, 'No date');
});
