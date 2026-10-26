/**
 * Editing on the native calendar (a native edit link, docs/native-switch.md milestone 2): what it hands
 * classic's write path. The app builds classic's grid records (ScheduleAdapter.toView), notes them when an edit
 * begins (noteStart) and saves through ScheduleAdapter.toCommand + EventStore, so these tests run that exact
 * path with the records the native calendar produces, in Los Angeles, Tokyo and London:
 *   - an all-day event added from the native grid (its display-shape end) is stored as classic stores it
 *   - "this event" on a repeating series stamps the series in classic's format and adds the edited row
 *   - a save measured from where the edit began keeps a field someone else changed meanwhile (finding D1)
 *   - a skipped date of an all-day series is read as the date it names, whoever wrote it (finding D2)
 *   - moving a whole series with one occurrence moves its repeat days with it (CalendarView.edits.shiftRule)
 *
 * Run: node --test test/unit/native-editing.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '../../public');
// The app's Event model (a browser global): ScheduleAdapter's all-day conversions use it.
globalThis.Event = new Function('Utils', `${fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8')}; return Event;`)({ uuidv4: () => 'generated-uuid' });
const EventStore = require('../../public/services/EventStore.js');
const ScheduleAdapter = require('../../public/services/ScheduleAdapter.js');
const CalendarView = require('../../public/services/CalendarView.js');
globalThis.window = globalThis.window || {};
require('../../public/nativecal/components/NativeCalendar.js');
const NativeCalendar = globalThis.window.NativeCalendar;

const ZONES = ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/London'];
const inZone = (zone, fn) => { const was = process.env.TZ; process.env.TZ = zone; try { return fn(); } finally { process.env.TZ = was; } };

function storeOf(list) {
    const s = { events: list, commits: [], errors: [] };
    s.store = new EventStore({
        getEvents: () => s.events,
        commit: (next, info) => { s.events = next; s.commits.push(info); },
        onError: (err) => s.errors.push(err.message),
    });
    return s;
}
const run = (s, args, context) => s.store.dispatch(ScheduleAdapter.toCommand({ addedRecords: [], changedRecords: [], deletedRecords: [], ...args }, s.store, context));

for (const zone of ZONES) {
    test(`an all-day event added on the native grid is stored as classic stores it (${zone})`, () => inZone(zone, () => {
        // The quick box's new event: Oct 24 (EU DST week) through Oct 26, display shape (last day 23:59:59.999).
        const start = new Date(2026, 9, 24), shownEnd = new Date(2026, 9, 26, 23, 59, 59, 999);
        const end = CalendarView.edits.endOf(shownEnd, true);
        assert.equal(end.getTime(), new Date(2026, 9, 27).getTime(), 'the next local midnight');
        const s = storeOf([]);
        const r = run(s, { requestType: 'eventCreate', addedRecords: [{ Subject: 'Camp', StartTime: start, EndTime: end, IsAllDay: true, Type: 1, Description: '', RecurrenceRule: '' }] }, { action: 'Add' });
        assert.ok(r.ok);
        const [e] = s.events;
        assert.deepEqual([e.title, e.isAllDay, e.start, e.end], ['Camp', true, new Date(2026, 9, 24).toISOString(), new Date(2026, 9, 27).toISOString()]);
        // A timed end, and an end already at midnight, are left alone.
        assert.equal(CalendarView.edits.endOf(new Date(2026, 9, 24, 15), false).getTime(), new Date(2026, 9, 24, 15).getTime());
        assert.equal(CalendarView.edits.endOf(new Date(2026, 9, 27), true).getTime(), new Date(2026, 9, 27).getTime());
    }));

    test(`"this event" on a repeating series: classic's stamp on the series and an edited row (${zone})`, () => inZone(zone, () => {
        const series = { id: 'w', title: 'Weekly', start: new Date(2026, 9, 6, 10).toISOString(), end: new Date(2026, 9, 6, 11).toISOString(),
            type: 2, description: '', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', recurrenceID: null, recurrenceException: null, isAllDay: false };
        const s = storeOf([series]);
        // As app.js builds it: the series' record, a temporary id, the occurrence moved (Oct 20 10:00 -> Oct 21 11:00).
        const rec = { ...ScheduleAdapter.toView([series])[0] };
        Object.assign(rec, { Id: '__native_occurrence__', RecurrenceID: rec.Id, StartTime: new Date(2026, 9, 21, 11), EndTime: new Date(2026, 9, 21, 12) });
        const r = run(s, { requestType: 'eventChange', changedRecords: [rec] }, { action: 'EditOccurrence', occurrenceStart: new Date(2026, 9, 20, 10) });
        assert.ok(r.ok, r.error && r.error.message);
        const stamp = ScheduleAdapter.stamp(new Date(2026, 9, 20, 10));
        const master = s.events.find((e) => e.id === 'w'), row = s.events.find((e) => e.id !== 'w');
        assert.equal(master.recurrenceException, stamp);
        assert.deepEqual([row.recurrenceID, row.recurrenceException, row.recurrencerule, row.title, row.type], ['w', stamp, series.recurrencerule, 'Weekly', 2]);
        assert.deepEqual([row.start, row.end], [new Date(2026, 9, 21, 11).toISOString(), new Date(2026, 9, 21, 12).toISOString()]);
    }));

    test(`an all-day series' skipped date is read as the date it names, whoever wrote it (finding D2, ${zone})`, () => inZone(zone, () => {
        // Oct 13 skipped at Tokyo's midnight, Los Angeles' midnight, London's (BST), UTC's, and as a floating stamp.
        for (const s of ['20261012T150000Z', '20261013T070000Z', '20261012T230000Z', '20261013T000000Z', '20261013T000000', '20261013']) {
            assert.equal(NativeCalendar.allDayStampKey(s), '20261013', s);
        }
        // ...and the stamp the app hands the grid after moving it to this viewer's midnight reads the same.
        const shown = Event.allDayExceptionsToLocal('20261012T150000Z');
        assert.equal(NativeCalendar.allDayStampKey(shown), '20261013');
        assert.equal(NativeCalendar.allDayStampKey('not a stamp'), null);
    }));
}

test('a save measured from where the edit began keeps what someone else changed meanwhile (finding D1)', () => {
    const row = { id: 'p', title: 'Planning', start: '2026-10-22T16:00:00.000Z', end: '2026-10-22T17:00:00.000Z', type: 1, description: 'Room 4', isAllDay: false, recurrencerule: '', recurrenceID: null, recurrenceException: null };
    const s = storeOf([row]);
    // The native editor opens: the record is noted as it is now.
    const opened = { ...ScheduleAdapter.toView([row])[0] };
    ScheduleAdapter.noteStart(opened);
    // Another browser renames it while the editor is open.
    s.events = [{ ...row, title: 'Planning (renamed)' }];
    // The editor saves its whole form (old title, new time): only the time is a change.
    const saved = { ...opened, StartTime: new Date('2026-10-22T18:00:00.000Z'), EndTime: new Date('2026-10-22T19:00:00.000Z') };
    assert.ok(run(s, { requestType: 'eventChange', changedRecords: [saved] }, { action: 'Save' }).ok);
    const [e] = s.events;
    assert.deepEqual([e.title, e.start, e.end, e.description], ['Planning (renamed)', '2026-10-22T18:00:00.000Z', '2026-10-22T19:00:00.000Z', 'Room 4']);
});

test('moving a whole series with one occurrence: its repeat days, day of the month and month move with it', () => {
    const { shiftRule, shiftBy } = CalendarView.edits;
    const tue = new Date(2026, 9, 27, 10);
    assert.equal(shiftRule('FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', tue, new Date(2026, 9, 29, 9)), 'FREQ=WEEKLY;BYDAY=TH;INTERVAL=1;');
    assert.equal(shiftRule('FREQ=WEEKLY;BYDAY=MO,WE,SA;INTERVAL=1;', tue, new Date(2026, 9, 28)), 'FREQ=WEEKLY;BYDAY=TU,TH,SU;INTERVAL=1;');
    assert.equal(shiftRule('FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', tue, new Date(2026, 9, 26)), 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;');
    assert.equal(shiftRule('FREQ=MONTHLY;BYMONTHDAY=27;INTERVAL=1;', tue, new Date(2026, 9, 30)), 'FREQ=MONTHLY;BYMONTHDAY=30;INTERVAL=1;');
    assert.equal(shiftRule('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=4;INTERVAL=1;', tue, new Date(2026, 9, 21)), 'FREQ=MONTHLY;BYDAY=WE;BYSETPOS=3;INTERVAL=1;');   // the 3rd Wednesday
    assert.equal(shiftRule('FREQ=YEARLY;BYMONTHDAY=27;BYMONTH=10;INTERVAL=1;', tue, new Date(2026, 10, 3)), 'FREQ=YEARLY;BYMONTHDAY=3;BYMONTH=11;INTERVAL=1;');
    assert.equal(shiftRule('FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=5;', tue, new Date(2026, 9, 27, 15)), 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=5;', 'same day: unchanged');
    assert.equal(shiftRule('FREQ=DAILY;INTERVAL=2;', tue, new Date(2026, 9, 29)), 'FREQ=DAILY;INTERVAL=2;');
    // Wall-clock: across the US DST change (Nov 1) an hour later stays an hour later on the clock.
    inZone('America/Los_Angeles', () => {
        const by = shiftBy(new Date(2026, 9, 27, 10), new Date(2026, 10, 3, 11));
        const moved = by(new Date(2026, 9, 6, 10));
        assert.deepEqual([moved.getDate(), moved.getHours()], [13, 11]);
        const later = by(new Date(2026, 9, 27, 10));
        assert.deepEqual([later.getMonth(), later.getDate(), later.getHours()], [10, 3, 11]);
    });
});
