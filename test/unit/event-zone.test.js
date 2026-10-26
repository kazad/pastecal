/**
 * An event's own time zone (event.tz, public/services/EventZone.js).
 *
 * The native card used to show "Pacific Time" as plain text: the zone could not be changed. An event may now name the
 * zone it is planned in. These tests pin what that must mean everywhere it travels:
 *   - wall-clock conversion, across the DST gaps and repeats in Los Angeles and London
 *   - the store keeps it (and an event without one stays byte-for-byte as before), a change can take it away, Undo
 *     puts it back, and a whole-list save sends the removal (EventStore.changesBetween)
 *   - classic round-trips it untouched: a title edited in classic's grid keeps it (ScheduleAdapter, Event model)
 *   - native expansion repeats in that zone (a weekly 2 PM Tokyo meeting, seen from Los Angeles across Nov 1)
 *   - the calendar feed writes DTSTART;TZID=, EXDATE;TZID=, RECURRENCE-ID;TZID=; a calendar without zones is unchanged
 *
 * Run: node --test test/unit/event-zone.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '../../public');
globalThis.Event = new Function('Utils', `${fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8')}; return Event;`)({ uuidv4: () => 'generated-uuid' });
const EventZone = require('../../public/services/EventZone.js');
const EventStore = require('../../public/services/EventStore.js');
const ScheduleAdapter = require('../../public/services/ScheduleAdapter.js');
const CalendarView = require('../../public/services/CalendarView.js');
globalThis.window = globalThis.window || {};
globalThis.window.EventZone = EventZone;
globalThis.window.EventStore = EventStore;
globalThis.EventStore = EventStore;
require('../../public/nativecal/components/NativeCalendar.js');
const NativeCalendar = globalThis.window.NativeCalendar;

const inZone = (zone, fn) => { const was = process.env.TZ; process.env.TZ = zone; try { return fn(); } finally { process.env.TZ = was; } };
const iso = (ms) => new Date(ms).toISOString();

function storeOf(list) {
    const s = { events: list, commits: [], errors: [] };
    s.store = new EventStore({ getEvents: () => s.events, commit: (next) => { s.events = next; }, onError: (err) => s.errors.push(err.message) });
    return s;
}
const run = (s, args, context) => s.store.dispatch(ScheduleAdapter.toCommand({ addedRecords: [], changedRecords: [], deletedRecords: [], ...args }, s.store, context));

// ---- conversion ------------------------------------------------------------------------------------------------
test('wall clock <-> instant: Tokyo, and the DST gap and repeat in Los Angeles and London', () => {
    assert.equal(iso(EventZone.fromWall(2026, 9, 27, 14, 0, 0, 'Asia/Tokyo')), '2026-10-27T05:00:00.000Z', '2 PM Tokyo is 05:00Z');
    // Los Angeles springs forward Mar 8 2026 at 2:00: 2:30 does not exist and moves forward by the gap.
    assert.equal(iso(EventZone.fromWall(2026, 2, 8, 2, 30, 0, 'America/Los_Angeles')), '2026-03-08T10:30:00.000Z', '2:30 is 3:30 PDT');
    assert.equal(iso(EventZone.fromWall(2026, 2, 8, 1, 30, 0, 'America/Los_Angeles')), '2026-03-08T09:30:00.000Z', '1:30 PST');
    assert.equal(iso(EventZone.fromWall(2026, 2, 8, 3, 30, 0, 'America/Los_Angeles')), '2026-03-08T10:30:00.000Z', '3:30 PDT');
    // ...and falls back Nov 1: 1:30 happens twice, the first (PDT) is meant.
    assert.equal(iso(EventZone.fromWall(2026, 10, 1, 1, 30, 0, 'America/Los_Angeles')), '2026-11-01T08:30:00.000Z');
    assert.equal(iso(EventZone.fromWall(2026, 10, 1, 2, 30, 0, 'America/Los_Angeles')), '2026-11-01T10:30:00.000Z', '2:30 PST');
    // London: Mar 29 01:30 is skipped (-> 02:30 BST), Oct 25 01:30 repeats (-> the BST one).
    assert.equal(iso(EventZone.fromWall(2026, 2, 29, 1, 30, 0, 'Europe/London')), '2026-03-29T01:30:00.000Z');
    assert.equal(iso(EventZone.fromWall(2026, 9, 25, 1, 30, 0, 'Europe/London')), '2026-10-25T00:30:00.000Z');
    assert.deepEqual(EventZone.wall(Date.parse('2026-10-25T01:30:00Z'), 'Europe/London'), { y: 2026, m: 9, d: 25, h: 1, min: 30, s: 0 }, 'GMT after the change');
});

test('a card value: a wall clock whose UTC fields read the zone, and back, in Los Angeles, Tokyo and London', () => {
    // (Was toWallDate: a Date whose LOCAL fields read the zone. The viewer's zone bent it -- stress S01 -- so it is gone.)
    assert.equal(EventZone.toWallDate, undefined);
    for (const viewer of ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/London']) inZone(viewer, () => {
        const real = new Date('2026-11-03T05:00:00Z');   // Tue 2 PM in Tokyo
        const w = EventZone.floating(real.getTime(), 'Asia/Tokyo');
        assert.deepEqual([w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes()], [3, 14, 0], viewer);
        assert.equal(EventZone.unfloating(w, 'Asia/Tokyo').toISOString(), real.toISOString(), viewer);
        // Typing 2:00 PM with Tokyo picked: the wall clock 14:00, which is 05:00Z (Japan has no DST).
        assert.equal(EventZone.unfloating(new Date(Date.UTC(2027, 0, 12, 14, 0)), 'Asia/Tokyo').toISOString(), '2027-01-12T05:00:00.000Z', viewer);
        // 2:30 AM in Tokyo on the day Los Angeles springs forward (S01): it exists, whatever the viewer's zone.
        const jp = EventZone.floating(Date.parse('2026-03-07T17:30:00Z'), 'Asia/Tokyo');
        assert.deepEqual([jp.getUTCDate(), jp.getUTCHours(), jp.getUTCMinutes()], [8, 2, 30], viewer);
        assert.equal(EventZone.unfloating(jp, 'Asia/Tokyo').toISOString(), '2026-03-07T17:30:00.000Z', viewer);
    });
});

test('zone names: friendly, searchable, and only real zones are valid', () => {
    assert.equal(EventZone.validZone('Asia/Tokyo'), 'Asia/Tokyo');
    assert.equal(EventZone.validZone('asia/tokyo'), 'Asia/Tokyo', 'canonical spelling');
    for (const bad of ['', 'Mars/Olympus', 'Asia/Tokyo; DROP', 42, null, 'x'.repeat(65)]) assert.equal(EventZone.validZone(bad), null, String(bad));
    assert.equal(EventStore.validZone('Europe/London'), 'Europe/London');
    assert.equal(EventZone.zoneName('Asia/Tokyo'), 'Japan Time');
    assert.equal(EventZone.zoneName('America/Los_Angeles'), 'Pacific Time');
    assert.equal(EventZone.zoneLabel('Asia/Tokyo'), 'Tokyo — Japan Time');
    assert.equal(EventZone.searchZones('tok')[0].id, 'Asia/Tokyo');
    assert.ok(EventZone.searchZones('japan').some((z) => z.id === 'Asia/Tokyo'));
    assert.ok(EventZone.searchZones('new york').some((z) => z.id === 'America/New_York'));
    assert.deepEqual(EventZone.searchZones('zzzz'), []);
});

// ---- the store ---------------------------------------------------------------------------------------------------
const tokyo = { id: 't1', title: 'Standup', description: '', start: '2026-11-03T05:00:00.000Z', end: '2026-11-03T05:30:00.000Z', type: 1, isAllDay: false, tz: 'Asia/Tokyo' };

test('the store keeps a zone, never adds a key to an event without one, and drops one that is not a zone', () => {
    const plain = EventStore.normalize({ id: 'p', title: 'Plain', start: tokyo.start, end: tokyo.end });
    assert.ok(!('tz' in plain), 'an event without a zone is stored as before');
    assert.equal(EventStore.normalize(tokyo).tz, 'Asia/Tokyo');
    const s = storeOf([]);
    assert.ok(s.store.dispatch({ type: 'add', event: { ...tokyo, id: 'a' } }).ok);
    assert.ok(s.store.dispatch({ type: 'add', event: { ...tokyo, id: 'b', tz: 'Mars/Olympus' } }).ok);
    assert.ok(s.store.dispatch({ type: 'add', event: { ...tokyo, id: 'c', tz: '' } }).ok);
    assert.equal(s.events[0].tz, 'Asia/Tokyo');
    assert.ok(!('tz' in s.events[1]) && !('tz' in s.events[2]), 'an unknown or empty zone is no key at all');
});

test('a rename keeps the zone; "Use mine" takes it away (no key left); Undo puts it back', () => {
    const s = storeOf([{ ...tokyo }]);
    s.store.dispatch({ type: 'update', key: tokyo, changes: { title: 'Standup (renamed)' } }, { label: 'rename' });
    assert.equal(s.events[0].tz, 'Asia/Tokyo');
    const r = s.store.dispatch({ type: 'update', key: tokyo, changes: { tz: '' } }, { label: 'zone' });
    assert.ok(r.ok);
    assert.ok(!('tz' in s.events[0]), JSON.stringify(s.events[0]));
    assert.deepEqual(r.result.inverse.changes, { tz: 'Asia/Tokyo' });
    // Sent to the server as JSON: the removal must survive (undefined would vanish).
    assert.deepEqual(JSON.parse(JSON.stringify(EventStore.diff(tokyo, EventStore.normalize({ ...tokyo, tz: '' })))), { tz: null });
    s.store.undo();
    assert.equal(s.events[0].tz, 'Asia/Tokyo');
    s.store.undo();
    assert.equal(s.events[0].title, 'Standup');
    assert.equal(s.events[0].tz, 'Asia/Tokyo');
});

test('a whole-list save (CloudCalendarService.planSave) sends a zone put on and a zone taken away', () => {
    const { tz: _z, ...noZone } = tokyo;
    const on = EventStore.changesBetween([noZone], [tokyo]);
    assert.equal(on.length, 1); assert.equal(on[0].changes.tz, 'Asia/Tokyo');
    const off = EventStore.changesBetween([tokyo], [noZone]);
    assert.equal(off.length, 1);
    assert.equal(JSON.parse(JSON.stringify(off[0].changes)).tz, null, 'tz: null reaches the server');
    assert.deepEqual(EventStore.changesBetween([tokyo], [tokyo]), [], 'nothing to send');
    assert.deepEqual(EventStore.changesBetween([noZone], [noZone]), [], 'nothing to send without zones either');
    // ...and the server, applying it, takes it away.
    const server = EventStore.apply([tokyo], { type: 'batch', commands: JSON.parse(JSON.stringify(off)) }).events;
    assert.ok(!('tz' in server[0]));
});

// ---- classic -----------------------------------------------------------------------------------------------------
test('classic: the grid record carries the zone and hands it back; a title edited in classic keeps it', () => inZone('America/Los_Angeles', () => {
    const rec = ScheduleAdapter.toView([tokyo])[0];
    assert.equal(rec.Tz, 'Asia/Tokyo');
    assert.equal(ScheduleAdapter.fromRecord(rec).tz, 'Asia/Tokyo');
    assert.ok(!('Tz' in ScheduleAdapter.toView([{ ...tokyo, tz: undefined }])[0]), 'no zone, no field');
    // Classic's editor: noted when it opens, saved with a new Subject (its records keep the other fields).
    const s = storeOf([{ ...tokyo }]);
    ScheduleAdapter.noteStart(rec);
    assert.ok(run(s, { requestType: 'eventChange', changedRecords: [{ ...rec, Subject: 'Renamed in classic' }] }, { action: 'Save' }).ok);
    assert.deepEqual([s.events[0].title, s.events[0].tz], ['Renamed in classic', 'Asia/Tokyo']);
    // An editor that rebuilt the record without the field changes nothing about the zone.
    const { Tz: _t, ...bare } = ScheduleAdapter.toView(s.events)[0];
    ScheduleAdapter.noteStart(bare);
    assert.ok(run(s, { requestType: 'eventChange', changedRecords: [{ ...bare, Subject: 'Again' }] }, { action: 'Save' }).ok);
    assert.deepEqual([s.events[0].title, s.events[0].tz], ['Again', 'Asia/Tokyo']);
    // The Event model (classic's setEvents rebuilds every row through it) keeps it too.
    assert.equal(new Event(tokyo).tz, 'Asia/Tokyo');
    assert.ok(!('tz' in new Event({ ...tokyo, tz: undefined })));
}));

test('classic: one occurrence edited on its own keeps its series\' zone', () => inZone('America/Los_Angeles', () => {
    const series = { ...tokyo, id: 'w', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', recurrenceID: null, recurrenceException: null };
    const s = storeOf([series]);
    const rec = { ...ScheduleAdapter.toView([series])[0] };
    delete rec.Tz;   // (whatever classic's editor hands back)
    Object.assign(rec, { Id: '__native_occurrence__', RecurrenceID: rec.Id, StartTime: new Date('2026-11-10T06:00:00Z'), EndTime: new Date('2026-11-10T06:30:00Z') });
    assert.ok(run(s, { requestType: 'eventChange', changedRecords: [rec] }, { action: 'EditOccurrence', occurrenceStart: new Date('2026-11-10T05:00:00Z') }).ok);
    const row = s.events.find((e) => e.id !== 'w');
    assert.equal(row.tz, 'Asia/Tokyo');
}));

// ---- native expansion -------------------------------------------------------------------------------------------
test('a weekly 2 PM Tokyo meeting, seen from Los Angeles: Monday 10 PM, then Monday 9 PM after Nov 1, always 2 PM in Tokyo', async () => {
    const rrule = (await import('../../cloudflare/src/vendor/rrule-2.8.1.esm.js')).default;
    globalThis.window.rrule = rrule;
    const series = { ...tokyo, id: 'w', start: '2026-10-27T05:00:00.000Z', end: '2026-10-27T05:30:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', recurrenceID: null, recurrenceException: '20261117T050000Z' };
    inZone('America/Los_Angeles', () => {
        const occ = NativeCalendar.occurrencesBetween([series], new Date(2026, 9, 25), new Date(2026, 10, 29));
        assert.deepEqual(occ.map((o) => o.start.toISOString()), ['2026-10-27T05:00:00.000Z', '2026-11-03T05:00:00.000Z', '2026-11-10T05:00:00.000Z', '2026-11-24T05:00:00.000Z'],
            'every Tuesday 2 PM Tokyo, Nov 17 skipped');
        assert.deepEqual(occ.map((o) => `${o.start.getDay()} ${o.start.getHours()}`), ['1 22', '1 21', '1 21', '1 21'], 'Monday evening in LA, 10 PM then 9 PM');
        // Without the zone: the same rule repeats on LA's wall clock (as before): Monday 10 PM every week.
        const { tz: _z, ...plain } = series;
        const floating = NativeCalendar.occurrencesBetween([{ ...plain, recurrenceException: null, start: '2026-10-27T05:00:00.000Z', end: '2026-10-27T05:30:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;' }],
            new Date(2026, 9, 25), new Date(2026, 10, 15));
        assert.deepEqual(floating.map((o) => `${o.start.getDay()} ${o.start.getHours()}`), ['1 22', '1 22', '1 22']);
    });
    inZone('Asia/Tokyo', () => {
        const occ = NativeCalendar.occurrencesBetween([series], new Date(2026, 9, 25), new Date(2026, 10, 12));
        assert.deepEqual(occ.map((o) => `${o.start.getDay()} ${o.start.getHours()}`), ['2 14', '2 14', '2 14'], 'Tuesday 2 PM in Tokyo');
    });
    // UNTIL names a day: through its end, in the zone.
    inZone('America/Los_Angeles', () => {
        const until = { ...series, recurrenceException: null, recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;UNTIL=20261110T080000Z;' };
        assert.equal(NativeCalendar.occurrencesBetween([until], new Date(2026, 9, 25), new Date(2026, 11, 29)).length, 3, 'Oct 27, Nov 3, Nov 10');
    });
});

// ---- the calendar feed -------------------------------------------------------------------------------------------
test('ICS: a zoned event is written in its zone with TZID; EXDATE and RECURRENCE-ID too; others unchanged', async () => {
    const { ICSService } = await import('../../cloudflare/src/ICSService.js');
    const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '').split('\r\n');
    const plain = { id: 'p', title: 'Plain', description: '', start: '2026-11-03T05:00:00.000Z', end: '2026-11-03T05:30:00.000Z', type: 1, isAllDay: false };
    // London (DST: an EXDATE written in summer time must still name the winter occurrence it skipped).
    const series = { id: 's', title: 'London weekly', description: '', start: '2026-10-20T13:00:00.000Z', end: '2026-10-20T14:00:00.000Z', type: 1, isAllDay: false,
        tz: 'Europe/London', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', recurrenceID: null, recurrenceException: '20261103T140000Z' };
    const child = { id: 'c', title: 'Moved', description: '', start: '2026-11-03T15:00:00.000Z', end: '2026-11-03T16:00:00.000Z', type: 1, isAllDay: false,
        tz: 'Europe/London', recurrencerule: series.recurrencerule, recurrenceID: 's', recurrenceException: '20261103T140000Z' };
    const lines = unfold(ICSService.generateICS({ title: 'Z', events: [plain, { ...tokyo }, series, child] }, 'z'));
    assert.ok(lines.includes('DTSTART:20261103T050000Z'), 'no zone: UTC, as before');
    assert.ok(lines.includes('DTSTART;TZID=Asia/Tokyo:20261103T140000') && lines.includes('DTEND;TZID=Asia/Tokyo:20261103T143000'));
    assert.ok(lines.includes('DTSTART;TZID=Europe/London:20261020T140000'), 'Oct 20 2 PM BST');
    assert.ok(lines.includes('RECURRENCE-ID;TZID=Europe/London:20261103T140000'), lines.join('\n'));
    assert.ok(!lines.some((l) => l.startsWith('EXDATE')), 'the moved occurrence replaces its slot, no EXDATE');
    const skipped = unfold(ICSService.generateICS({ title: 'Z', events: [series] }, 'z'));
    assert.ok(skipped.includes('EXDATE;TZID=Europe/London:20261103T140000'), skipped.join('\n'));
    // A calendar without zones: exactly what it was (tz absent and tz-less rows read the same).
    const a = ICSService.generateICS({ title: 'Z', events: [plain] }, 'z'), b = ICSService.generateICS({ title: 'Z', events: [{ ...plain, tz: '' }] }, 'z');
    assert.equal(a.replace(/DTSTAMP:\S+/g, ''), b.replace(/DTSTAMP:\S+/g, ''));
    assert.ok(!a.includes('TZID'));
});
