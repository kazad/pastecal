/**
 * scripts/firsttwo.mjs (stats.sh firsttwo): who counts as a new calendar, what its first 14 days say, and the
 * weekly funnel. The I/O (R2, the history/authors routes, Analytics Engine) is not exercised here.
 *
 * Run: node --test test/unit/firsttwo.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

const load = () => import(pathToFileURL(path.join(__dirname, '../../scripts/firsttwo.mjs')).href);
const D = 86400000, H = 3600000;
const BIRTH = Date.UTC(2026, 9, 26, 15);                 // Monday Oct 26 2026, 15:00 UTC
const at = (days, hours = 0) => BIRTH + days * D + hours * H;
const save = (days, o = {}) => ({ savedAt: at(days, o.h || 0), kind: 'added', added: 1, removed: 0, changed: 0, writer: 'w1', ...o });
const created = (n = 1) => ({ savedAt: BIRTH, kind: 'created', added: n, removed: 0, changed: 0 });
const meta = (days) => ({ savedAt: at(days), kind: 'edited', added: 0, removed: 0, changed: 0 });   // a settings save: not a change

test('calHash matches RoomInsight (Analytics Engine blob9)', async () => {
    const { calHash } = await load();
    assert.equal(calHash('family'), createHash('sha256').update('cal\nfamily').digest('hex').slice(0, 12));
});

test('birthOf: the created save, unless the calendar is older than its history', async () => {
    const { birthOf } = await load();
    assert.deepEqual(birthOf([save(1), meta(0), created()], BIRTH + 1000), { birth: BIRTH, how: 'created' });
    assert.deepEqual(birthOf([created()], null), { birth: BIRTH, how: 'created' }, 'no directory row (a case variant)');
    assert.equal(birthOf([save(0), save(1)], BIRTH), null, 'no created save in a short history: born before the Worker kept history');
    assert.equal(birthOf([created()], BIRTH - 3 * D), null, 'row much older than created: emptied and refilled');
    assert.equal(birthOf([], BIRTH), null);
    // Busy: 20 saves, the created one scrolled out; the row dates it if nothing is older than the row.
    const busy = Array.from({ length: 20 }, (_, i) => save(0, { h: 1 + i / 10 }));
    assert.deepEqual(birthOf(busy, BIRTH), { birth: BIRTH, how: 'row' });
    assert.equal(birthOf(busy, BIRTH + 5 * H), null, 'saves older than the row: an old calendar re-registered');
    assert.equal(birthOf(busy.slice(0, 19), BIRTH), null, 'under 20 saves the history is whole, so no created save means old');
});

test('birthOf: a calendar Firebase knew earlier is old, whatever its Cloudflare history says', async () => {
    const { birthOf } = await load();
    assert.equal(birthOf([created()], BIRTH, BIRTH - 20 * D), null, 'Firebase saves 20 days earlier: emptied and refilled');
    assert.equal(birthOf([created()], BIRTH, 0), null, 'in Firebase with no date at all: older than its history');
    assert.deepEqual(birthOf([created()], BIRTH, BIRTH - H), { birth: BIRTH, how: 'created' }, 'made in Firebase hours before its sync');
    const busy = Array.from({ length: 20 }, (_, i) => save(0, { h: 1 + i / 10 }));
    assert.equal(birthOf(busy, BIRTH, 0), null, 'a busy old calendar whose row was re-stamped');
});

test('firebaseEvidence: by name key, earliest dated save or author, 0 when undated', async () => {
    const { firebaseEvidence } = await load();
    const ev = firebaseEvidence({
        calendars: { Soccer: {}, quiet: {}, ' band ': {} },
        history: { Soccer: { a: { savedAt: 500 }, b: { savedAt: 300 } }, ' band ': { a: { savedAt: 900 } } },
        calendar_authors: { Soccer: { u1: { firstSeen: 200 } }, gone: { u: { firstSeen: 1 } } },
    });
    assert.equal(ev.get('soccer'), 200, 'looked up by key: a case variant of an old name is old');
    assert.equal(ev.get('quiet'), 0);
    assert.equal(ev.get('band'), 900);
    assert.equal(ev.has('gone'), false, 'authors of a calendar Firebase no longer had');
    assert.equal(firebaseEvidence({}).size, 0);
});

test('editedBefore: a row-dated birth is wrong if someone edited more than a day before it', async () => {
    const { editedBefore } = await load();
    assert.equal(editedBefore([{ firstSeen: BIRTH - 3 * D }], BIRTH), true);
    assert.equal(editedBefore([{ firstSeen: BIRTH - H }, { firstSeen: BIRTH + D }], BIRTH), false);
    assert.equal(editedBefore([], BIRTH), false);
});

test('bulkBirths: 8+ calendars within an hour are not people', async () => {
    const { bulkBirths } = await load();
    const spread = Array.from({ length: 10 }, (_, i) => BIRTH + i * 3 * H);            // one every 3 hours
    assert.equal(bulkBirths(spread).size, 0);
    const burst = Array.from({ length: 8 }, (_, i) => BIRTH + 30 * D + i * 5 * 60000);   // 8 in 35 minutes
    const all = [...spread, ...burst];
    assert.deepEqual([...bulkBirths(all)].sort((a, b) => a - b), [10, 11, 12, 13, 14, 15, 16, 17]);
    assert.equal(bulkBirths(burst.slice(0, 7)).size, 0, 'seven is not a burst');
});

test('firstTwoWeeks: events, a second person, followers and week 2', async () => {
    const { firstTwoWeeks } = await load();
    const history = [created(0), meta(0), save(2), save(2, { writer: 'w2' }), save(3), save(9), save(20)];
    const authors = [{ firstSeen: BIRTH, days: ['2026-10-26'] }, { firstSeen: at(5), days: ['2026-10-31'] }];
    const hits = [
        { day: '2026-10-26', views: 1, visitors: 1, followers: 0 },
        { day: '2026-10-30', views: 3, visitors: 2, followers: 0 },
        { day: '2026-11-01', views: 0, visitors: 0, followers: 1 },
        { day: '2026-11-25', views: 5, visitors: 5, followers: 5 },   // after day 13: ignored
    ];
    const r = firstTwoWeeks({ birth: BIRTH, history, authors, hits, today: '2026-11-20' });
    assert.equal(r.week, '2026-10-26');
    assert.equal(r.firstEventDay, 2, 'created with no events; the first add is day 2');
    assert.equal(r.events, 4, 'day 20 is outside the window');
    assert.equal(r.secondEditorDay, 2, 'writer w2 on day 2 beats the second uid on day 5');
    assert.equal(r.secondViewerDay, 4);
    assert.equal(r.followerDay, 6);
    assert.equal(r.activeWeek2, true, 'an add on day 9');
    assert.equal(r.complete, true);
    assert.equal(r.hitsWhole, true);
});

test('firstTwoWeeks: one browser is not a second person; uids and writer ids never add up', async () => {
    const { firstTwoWeeks } = await load();
    const r = firstTwoWeeks({ birth: BIRTH, history: [created(1), save(0), save(1)], authors: [{ firstSeen: BIRTH, days: ['2026-10-26'] }],
        hits: [{ day: '2026-10-26', views: 2, visitors: 1, followers: 0 }], today: '2026-11-20' });
    assert.equal(r.firstEventDay, 0);
    assert.equal(r.events, 3);
    assert.equal(r.secondEditorDay, null);
    assert.equal(r.secondViewerDay, null);
    assert.equal(r.activeWeek2, false);
});

test('firstTwoWeeks: views before cal_hit existed are unseen, not zero', async () => {
    const { firstTwoWeeks } = await load();
    const early = Date.UTC(2026, 9, 20, 9);
    const r = firstTwoWeeks({ birth: early, history: [{ ...created(2), savedAt: early }], today: '2026-10-30' });
    assert.equal(r.hitsObservedFrom, 6, 'Oct 26 is day 6');
    assert.equal(r.hitsWhole, false);
    assert.equal(r.complete, false, '10 days old');
    const before = firstTwoWeeks({ birth: Date.UTC(2026, 9, 5), history: [{ ...created(), savedAt: Date.UTC(2026, 9, 5) }], today: '2026-10-30' });
    assert.equal(before.hitsObservedFrom, null, 'its 14 days ended before Oct 26');
});

test('funnel and render: counts per birth week, floors marked, no names', async () => {
    const { firstTwoWeeks, funnel, render } = await load();
    const mk = (hours, history, hits = []) => {
        const b = BIRTH + hours * H;
        return { ...firstTwoWeeks({ birth: b, history: history.map((e) => ({ ...e, savedAt: e.savedAt + hours * H })), hits, today: '2026-11-20' }), hash: 'abc123def456' };
    };
    const rows = [
        mk(0, [created(0)]),                                              // never got an event
        mk(1, [created(1)]),                                              // 1 event
        mk(2, [created(3), save(1, { writer: 'a' }), save(1, { writer: 'b' })]),   // 5 events, 2 editors
        mk(3, [created(1)], [{ day: '2026-10-28', views: 1, visitors: 1, followers: 1 }]),
    ];
    const [w] = funnel(rows);
    assert.deepEqual({ week: w.week, created: w.created, event1: w.event1, event3: w.event3, secondPerson: w.secondPerson, follower: w.follower, week2Of: w.week2Of, week2: w.week2 },
        { week: '2026-10-26', created: 4, event1: 3, event3: 1, secondPerson: 1, follower: 1, week2Of: 4, week2: 0 });
    const text = render(rows, { today: '2026-11-20', start: '2026-10-26' });
    assert.match(text, /2026-10-26\s+4\s+3 \(75%\)\s+1 \(25%\)\s+1 \(25%\)\s+1 \(25%\)\s+1 \(25%\)\s+0 \(0%\)/);
    assert.match(render(rows, { today: '2026-11-20', start: '2026-10-26', bulk: 3, reStamped: 2 }), /3 calendar\(s\) left out: made in bulk[^]*2 calendar\(s\) left out: their directory row/);
    assert.match(text, /abc123def456/);
    assert.equal(funnel([]).length, 0);
    assert.match(render([], { today: '2026-11-20', start: '2026-10-26' }), /no new calendars/);
});
