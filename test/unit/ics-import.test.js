/**
 * Import .ics (public/services/ICSImport.js) and the Download .ics backup (ICSService backup mode).
 *
 * Why: a person who lost edit access to a calendar rebuilt it by hand, event by event. A backup she could download and
 * import back would have been one click. Three things are checked here:
 *   - the parser, by table: zones (TZID, UTC, floating, Windows names), all-day dates, DURATION, RRULE + EXDATE,
 *     RECURRENCE-ID overrides, folded lines, escapes, CRLF / LF / CR.
 *   - round trip: a calendar downloaded and imported into an empty one comes back identical, every field of THE list
 *     (EventStore.FIELDS); without the backup rows (any feed) it comes back meaning the same (its feed is the same).
 *   - no duplicates: the same file twice, a calendar's own export, a different UID with the same event.
 * The browser side (Settings, Undo, both calendars) is cloudflare/test/ics-backup.spec.js.
 * Run: node --test test/unit/ics-import.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const EventStore = require('../../public/services/EventStore.js');
const ICSImport = require('../../public/services/ICSImport.js');
const loadICS = () => import(pathToFileURL(path.join(__dirname, '../../cloudflare/src/ICSService.js')).href).then((m) => m.ICSService || m.default);

const LA = { calZone: 'America/Los_Angeles', localZone: 'America/Los_Angeles' };
const cal = (...vevents) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...vevents.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
/** Apply a plan's commands to a list, as the page's store does. */
const applyPlan = (events, p) => (p.commands.length ? EventStore.apply(events, { type: 'batch', commands: p.commands }).events : events);
const imported = (text, opts = LA, existing = []) => applyPlan(existing, ICSImport.plan(existing, text, opts));

// ---- the parser ---------------------------------------------------------------------------------------------

const PARSE = [
    { name: 'TZID: that zone\'s wall clock, and the event keeps the zone',
      ics: cal(vevent('UID:a', 'SUMMARY:Call', 'DTSTART;TZID=America/New_York:20261006T090000', 'DTEND;TZID=America/New_York:20261006T100000')),
      want: { title: 'Call', start: '2026-10-06T13:00:00.000Z', end: '2026-10-06T14:00:00.000Z', isAllDay: false, tz: 'America/New_York' } },
    { name: 'TZID quoted, and the calendar\'s own zone is no zone of its own',
      ics: cal(vevent('UID:a', 'SUMMARY:Practice', 'DTSTART;TZID="America/Los_Angeles":20261006T170000', 'DTEND;TZID="America/Los_Angeles":20261006T183000')),
      want: { start: '2026-10-07T00:00:00.000Z', end: '2026-10-07T01:30:00.000Z', tz: undefined } },
    { name: 'a Windows zone name (Outlook)',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART;TZID=Eastern Standard Time:20261201T090000', 'DTEND;TZID=Eastern Standard Time:20261201T100000')),
      want: { start: '2026-12-01T14:00:00.000Z', tz: 'America/New_York' } },
    { name: 'a zone with a prefix (Thunderbird)',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART;TZID=/mozilla.org/20070129_1/Europe/London:20260701T090000', 'DTEND;TZID=/mozilla.org/20070129_1/Europe/London:20260701T100000')),
      want: { start: '2026-07-01T08:00:00.000Z', tz: 'Europe/London' } },
    { name: 'UTC',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART:20261006T170000Z', 'DTEND:20261006T180000Z')),
      want: { start: '2026-10-06T17:00:00.000Z', end: '2026-10-06T18:00:00.000Z', tz: undefined } },
    { name: 'floating: the calendar\'s zone',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART:20261006T090000', 'DTEND:20261006T093000')),
      want: { start: '2026-10-06T16:00:00.000Z', end: '2026-10-06T16:30:00.000Z', tz: undefined } },
    { name: 'floating in a file that names its zone (X-WR-TIMEZONE)',
      ics: cal('X-WR-TIMEZONE:Asia/Tokyo', vevent('UID:a', 'SUMMARY:x', 'DTSTART:20261006T090000', 'DTEND:20261006T093000')),
      want: { start: '2026-10-06T00:00:00.000Z', tz: 'Asia/Tokyo' } },
    { name: 'all-day: dates, stored as this browser\'s midnights, the end exclusive',
      ics: cal(vevent('UID:a', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261104')),
      want: { isAllDay: true, start: '2026-11-01T07:00:00.000Z', end: '2026-11-04T08:00:00.000Z' } },
    { name: 'all-day with no end: one day',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART;VALUE=DATE:20261006')),
      want: { isAllDay: true, start: '2026-10-06T07:00:00.000Z', end: '2026-10-07T07:00:00.000Z' } },
    { name: 'all-day as a bare date (no VALUE=DATE), and a DURATION of days',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART:20261006', 'DURATION:P2D')),
      want: { isAllDay: true, start: '2026-10-06T07:00:00.000Z', end: '2026-10-08T07:00:00.000Z' } },
    { name: 'DURATION',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART:20261006T170000Z', 'DURATION:PT1H30M')),
      want: { start: '2026-10-06T17:00:00.000Z', end: '2026-10-06T18:30:00.000Z' } },
    { name: 'RRULE and EXDATE (in the event\'s zone): the rule as written, skipped dates as UTC stamps',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART;TZID=America/Los_Angeles:20261006T170000', 'DTEND;TZID=America/Los_Angeles:20261006T180000',
          'RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=America/Los_Angeles:20261013T170000,20261020T170000', 'EXDATE;TZID=America/Los_Angeles:20261103T170000')),
      want: { recurrencerule: 'FREQ=WEEKLY;BYDAY=TU', recurrenceException: '20261014T000000Z,20261021T000000Z,20261104T010000Z' } },
    { name: 'an all-day series\' EXDATE as dates',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART;VALUE=DATE:20261006', 'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20261008')),
      want: { isAllDay: true, recurrencerule: 'FREQ=DAILY;COUNT=5', recurrenceException: '20261008T070000Z' } },
    { name: 'a weekly rule against a UTC start names UTC weekdays: moved to the calendar\'s',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DTSTART:20261006T003000Z', 'DTEND:20261006T020000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH')),
      want: { start: '2026-10-06T00:30:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO,WE' } },
    { name: 'folded lines (a space or a tab), multibyte text across the fold',
      ics: cal(vevent('UID:a', 'SUMMARY:Équipe de foot', ' ball — Saturday', '\tgame', 'DTSTART:20261006T170000Z', 'DTEND:20261006T180000Z')),
      want: { title: 'Équipe de football — Saturdaygame' } },
    { name: 'escapes: commas, semicolons, backslashes, newlines',
      ics: cal(vevent('UID:a', 'SUMMARY:Bring water\\, cones\\; balls', 'DESCRIPTION:Line one\\nLine two\\Nthree \\\\ done',
          'DTSTART:20261006T170000Z', 'DTEND:20261006T180000Z')),
      want: { title: 'Bring water, cones; balls', description: 'Line one\nLine two\nthree \\ done' } },
    { name: 'LOCATION joins the notes; a feed\'s view link (its URL) does not',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'DESCRIPTION:Bring a ball\\n\\nhttps://pastecal.com/view/abc', 'URL:https://pastecal.com/view/abc',
          'LOCATION:Field 3\\, Main St', 'DTSTART:20261006T170000Z', 'DTEND:20261006T180000Z')),
      want: { description: 'Bring a ball\n\nField 3, Main St' } },
    { name: 'LF line ends', ics: cal(vevent('UID:a', 'SUMMARY:lf', 'DTSTART:20261006T170000Z', 'DTEND:20261006T180000Z')).replace(/\r\n/g, '\n'),
      want: { title: 'lf', start: '2026-10-06T17:00:00.000Z' } },
    { name: 'CR line ends', ics: cal(vevent('UID:a', 'SUMMARY:cr', 'DTSTART:20261006T170000Z', 'DTEND:20261006T180000Z')).replace(/\r\n/g, '\r'),
      want: { title: 'cr' } },
    { name: 'a type pastecal wrote (X-PASTECAL-TYPE)',
      ics: cal(vevent('UID:a', 'SUMMARY:x', 'X-PASTECAL-TYPE:5', 'DTSTART:20261006T170000Z', 'DTEND:20261006T180000Z')),
      want: { type: 5 } },
    { name: 'an alarm inside an event is not part of it',
      ics: cal(vevent('UID:a', 'SUMMARY:Real', 'DTSTART:20261006T170000Z', 'DTEND:20261006T180000Z', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM')),
      want: { title: 'Real', description: '' } },
];

for (const c of PARSE) {
    test(`parse: ${c.name}`, () => {
        const rows = imported(c.ics);
        assert.equal(rows.length, 1, 'one event');
        for (const [k, v] of Object.entries(c.want)) assert.deepEqual(rows[0][k], v, k);
    });
}

test('parse: a RECURRENCE-ID override is stored as the editor stores an edited occurrence', () => {
    const rows = imported(cal(
        vevent('UID:s', 'SUMMARY:Practice', 'DTSTART;TZID=America/Los_Angeles:20261006T170000', 'DTEND;TZID=America/Los_Angeles:20261006T180000', 'RRULE:FREQ=WEEKLY;BYDAY=TU'),
        vevent('UID:s', 'SUMMARY:Practice (moved)', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261013T170000',
            'DTSTART;TZID=America/Los_Angeles:20261014T170000', 'DTEND;TZID=America/Los_Angeles:20261014T180000'),
        vevent('UID:s', 'STATUS:CANCELLED', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261020T170000', 'DTSTART;TZID=America/Los_Angeles:20261020T170000')));
    assert.equal(rows.length, 2);
    const [series, moved] = [rows.find((e) => !e.recurrenceID), rows.find((e) => e.recurrenceID)];
    assert.equal(series.recurrenceException, '20261014T000000Z,20261021T000000Z', 'both originals skipped in the series (the cancelled one too)');
    assert.equal(moved.recurrenceID, series.id);
    assert.equal(moved.recurrenceException, '20261014T000000Z', 'the original start');
    assert.equal(moved.recurrencerule, series.recurrencerule);
    assert.equal(moved.start, '2026-10-15T00:00:00.000Z');
});

test('parse: an override whose series is not in the file or the calendar is an event of its own', () => {
    const rows = imported(cal(vevent('UID:gone', 'SUMMARY:Lone', 'RECURRENCE-ID:20261013T170000Z', 'DTSTART:20261014T170000Z', 'DTEND:20261014T180000Z')));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recurrenceID, null);
    assert.equal(rows[0].title, 'Lone');
});

test('parse: files that cannot be imported say why', () => {
    const code = (fn) => { try { fn(); return 'none'; } catch (e) { assert.ok(e instanceof ICSImport.ImportError); assert.ok(e.message); return e.code; } };
    assert.equal(code(() => ICSImport.plan([], 'name,date\nx,1', LA)), 'not_calendar');
    assert.equal(code(() => ICSImport.plan([], '<html>BEGIN:VCALENDAR is not at a line start</html>', LA)), 'not_calendar');
    assert.equal(code(() => ICSImport.plan([], cal(), LA)), 'empty');
    assert.equal(code(() => ICSImport.plan([], cal(vevent('SUMMARY:x', 'DTSTART:20261006T170000Z')) + ' '.repeat(ICSImport.MAX_BYTES), LA)), 'too_big');
    const many = Array.from({ length: ICSImport.MAX_EVENTS + 1 }, (_, i) => vevent(`UID:${i}`, 'DTSTART:20261006T170000Z'));
    assert.equal(code(() => ICSImport.plan([], cal(...many), LA)), 'too_many');
    // Room for the file, but not in this calendar: the server would refuse the save.
    const existing = Array.from({ length: ICSImport.MAX_EVENTS }, (_, i) => ({ id: `e${i}`, title: `E${i}`, start: '2026-10-06T17:00:00.000Z', end: '2026-10-06T18:00:00.000Z' }));
    assert.equal(code(() => ICSImport.plan(existing, cal(vevent('UID:new', 'SUMMARY:new', 'DTSTART:20270106T170000Z')), LA)), 'too_many');
});

test('parse: an event that cannot be read is counted, the rest imported', () => {
    const p = ICSImport.plan([], cal(
        vevent('UID:ok', 'SUMMARY:ok', 'DTSTART:20261006T170000Z'),
        vevent('UID:nodate', 'SUMMARY:no start'),
        vevent('UID:bomb', 'SUMMARY:bomb', 'DTSTART:20261006T170000Z', 'RRULE:FREQ=SECONDLY')), LA);
    assert.equal(p.add, 1);
    assert.equal(p.unreadable, 2);
    assert.equal(ICSImport.summary(p), 'Add 1 event, 2 can’t be read.');
});

// ---- round trip --------------------------------------------------------------------------------------------

// Every field of THE list set (as test/unit/event-fields.test.js), and the shapes stored data really has: a number id,
// an edited occurrence, an all-day trip, a series in its own zone with "the last Monday" as the editor writes it.
const CAL = {
    title: 'U10 Soccer', options: { tz: 'America/Los_Angeles' },
    events: [
        { id: 's1', title: 'Practice', description: 'Bring water, cones; and\nballs, \\ "quotes"', start: '2026-10-06T00:30:00.000Z', end: '2026-10-06T02:00:00.000Z',
          type: 3, isAllDay: false, repeat: 'Weekly', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', recurrenceID: null, recurrenceException: '20261013T003000Z,20261020T003000Z' },
        { id: 'c1', title: 'Practice (moved to Tuesday)', description: '', start: '2026-10-21T00:30:00.000Z', end: '2026-10-21T02:00:00.000Z',
          type: 2, isAllDay: false, repeat: '', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', recurrenceID: 's1', recurrenceException: '20261020T003000Z' },
        { id: 7, title: 'Trip', description: '', start: '2026-11-01T07:00:00.000Z', end: '2026-11-04T08:00:00.000Z',
          type: 6, isAllDay: true, repeat: '', recurrencerule: '', recurrenceID: null, recurrenceException: null },
        { id: 'tk', title: 'Tokyo standup', description: 'Zoom', start: '2026-10-27T01:00:00.000Z', end: '2026-10-27T01:30:00.000Z',
          type: 4, isAllDay: false, repeat: '', recurrencerule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;', recurrenceID: null, recurrenceException: null, tz: 'Asia/Tokyo' },
        { id: 'ad', title: 'Snack duty', description: '', start: '2026-10-10T07:00:00.000Z', end: '2026-10-11T07:00:00.000Z',
          type: 1, isAllDay: true, repeat: '', recurrencerule: 'FREQ=WEEKLY;BYDAY=SA;INTERVAL=1;UNTIL=20261205T070000Z;', recurrenceID: null, recurrenceException: '20261024T070000Z' },
    ],
};

test('round trip: a backup imported into an empty calendar is the same calendar, every field', async () => {
    const ICS = await loadICS();
    for (const f of EventStore.FIELDS) assert.ok(CAL.events.some((e) => f in e), `the sample sets "${f}"`);
    const file = ICS.generateICS(CAL, 'u10-soccer', { backup: true });
    assert.match(file, /X-PASTECAL-ROW:/);
    // In another zone too: a backup does not depend on where it is imported.
    for (const opts of [LA, { calZone: null, localZone: 'Asia/Tokyo' }]) {
        const rows = imported(file, opts);
        assert.equal(rows.length, CAL.events.length);
        for (const e of CAL.events) {
            const got = rows.find((r) => EventStore.keyOf(r) === EventStore.keyOf(e));
            assert.ok(got, `${e.title} is back with its id`);
            assert.equal(got.id, e.id, 'the id keeps its kind (a number stays a number)');
            assert.ok(EventStore.same(got, e), `${e.title}: ${JSON.stringify(EventStore.diff(EventStore.normalize(e), got))}`);
            assert.equal(got.tz, e.tz);
        }
    }
});

test('round trip: any feed of the calendar (no backup rows) imports to the same meaning: its own feed is the same', async () => {
    const ICS = await loadICS();
    const feed = ICS.generateICS(CAL, 'u10-soccer', { viewUrl: 'https://pastecal.com/view/abc' });
    const rows = imported(feed);
    assert.equal(rows.length, CAL.events.length);
    // UIDs are the new ids; everything else a calendar app reads is the same (events in any order).
    const again = ICS.generateICS({ ...CAL, events: rows }, 'u10-soccer', { viewUrl: 'https://pastecal.com/view/abc' });
    const blocks = (ics) => ics.replace(/\r\n /g, '').split('BEGIN:VEVENT').map((b) => b.split('\r\n').filter((l) => !/^(DTSTAMP|UID):|^END:VCALENDAR$/.test(l)).join('\n').trim()).sort();
    assert.deepEqual(blocks(again), blocks(feed));
    const series = rows.find((r) => r.title === 'Practice'), moved = rows.find((r) => r.recurrenceID);
    assert.equal(moved.recurrenceID, series.id, 'the moved practice is the series\' occurrence');
    for (const e of CAL.events) {
        const got = rows.find((r) => r.title === e.title);
        assert.equal(got.description, e.description, 'notes without the view link');
        assert.equal(got.isAllDay, e.isAllDay);
    }
});

// ---- no duplicates -----------------------------------------------------------------------------------------

const GOOGLE = cal('X-WR-CALNAME:Family',
    vevent('UID:abc123@google.com', 'SUMMARY:Dentist', 'DTSTART;TZID=America/Los_Angeles:20261106T090000', 'DTEND;TZID=America/Los_Angeles:20261106T100000'),
    vevent('UID:def456@google.com', 'SUMMARY:Swim', 'DTSTART;TZID=America/Los_Angeles:20261005T160000', 'DTEND;TZID=America/Los_Angeles:20261005T170000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/Los_Angeles:20261012T160000'),
    vevent('UID:def456@google.com', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261019T160000', 'SUMMARY:Swim (late)',
        'DTSTART;TZID=America/Los_Angeles:20261019T180000', 'DTEND;TZID=America/Los_Angeles:20261019T190000'),
    vevent('UID:holiday@google.com', 'SUMMARY:Thanksgiving', 'DTSTART;VALUE=DATE:20261126', 'DTEND;VALUE=DATE:20261127'));

test('no duplicates: the same file twice adds nothing the second time', () => {
    const first = ICSImport.plan([], GOOGLE, LA);
    assert.equal(ICSImport.summary(first), 'Add 4 events.');
    const rows = applyPlan([], first);
    const second = ICSImport.plan(rows, GOOGLE, LA);
    assert.deepEqual(second.commands, []);
    assert.equal(ICSImport.summary(second), 'All 4 already here.');
    // ...from another zone, too (all-day dates, the series' skipped days).
    assert.deepEqual(ICSImport.plan(rows, GOOGLE, { calZone: 'America/Los_Angeles', localZone: 'Europe/Paris' }).commands, []);
});

test('no duplicates: a calendar\'s own export (backup or feed) re-imported changes nothing', async () => {
    const ICS = await loadICS();
    for (const opts of [{ backup: true }, { viewUrl: 'https://pastecal.com/view/abc' }, {}]) {
        const p = ICSImport.plan(CAL.events, ICS.generateICS(CAL, 'u10-soccer', opts), LA);
        assert.deepEqual(p.commands, [], JSON.stringify(opts));
        assert.equal(p.skip, CAL.events.length);
    }
});

test('no duplicates: the same event under another UID (another app\'s copy) is skipped', () => {
    const rows = imported(GOOGLE);
    const copy = GOOGLE.replace(/UID:(\w+)@google.com/g, 'UID:$1-copy@outlook.com');
    const p = ICSImport.plan(rows, copy, LA);
    assert.deepEqual(p.commands, []);
    // Twice in one file: once.
    assert.equal(ICSImport.plan([], cal(vevent('UID:1', 'SUMMARY:A', 'DTSTART:20261006T170000Z'), vevent('UID:2', 'SUMMARY:A', 'DTSTART:20261006T170000Z'),
        vevent('UID:1', 'SUMMARY:A', 'DTSTART:20261006T170000Z')), LA).add, 1);
});

test('a changed event is updated, only in what changed; an external file leaves a type it does not name alone', () => {
    const rows = imported(GOOGLE).map((e) => (e.title === 'Dentist' ? { ...e, type: 4 } : e));
    const p = ICSImport.plan(rows, GOOGLE.replace('SUMMARY:Dentist', 'SUMMARY:Dentist (Dr. Lee)'), LA);
    assert.equal(ICSImport.summary(p), 'Update 1 event, skip 3 already here.');
    assert.deepEqual(p.commands.map((c) => [c.type, c.changes]), [['update', { title: 'Dentist (Dr. Lee)' }]]);
});

test('import never takes away: a date skipped here since stays skipped', () => {
    const rows = imported(GOOGLE).map((e) => (e.title === 'Swim' ? { ...e, recurrenceException: `${e.recurrenceException},20261103T000000Z` } : e));
    assert.deepEqual(ICSImport.plan(rows, GOOGLE, LA).commands, []);
});

test('an imported batch undoes as one change', () => {
    const before = [CAL.events[2]];
    const p = ICSImport.plan(before, GOOGLE, LA);
    const r = EventStore.apply(before, { type: 'batch', commands: p.commands });
    assert.equal(r.events.length, 5);
    const back = EventStore.apply(r.events, r.inverse).events;
    assert.deepEqual(back, before);
});
