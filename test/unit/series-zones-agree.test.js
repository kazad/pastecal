/**
 * A repeating event lands on the same days and times in the calendar feed (as a calendar app reads it) and in both
 * calendars (classic's grid, native), wherever it is viewed.
 *
 * A series is wall-clock: "every Tuesday at 5 PM" means Tuesday 5 PM where it was planned, across DST. The feed wrote
 * every event without its own zone in UTC (DTSTART:20261007T000000Z, RRULE:BYDAY=TU), so a Los Angeles practice
 * repeated on UTC Tuesdays -- Monday evenings -- and an hour off after Nov 1, for every subscriber of every calendar
 * (stress A02). And each calendar repeated it in the VIEWER's zone, so seen from Tokyo it moved to other days too.
 * Now the feed and both calendars use one zone for a series: its own (event.tz), else the calendar's (options.tz,
 * else a confident guess from its all-day events: EventZone.calendarZone), and the feed defines that zone (VTIMEZONE).
 *
 * The table: series (weekly with a skipped and a moved occurrence and COUNT, monthly "2nd Tuesday" with UNTIL, yearly
 * "last Monday of October", daily across midnight and DST, all-day weekly with a skipped date and UNTIL, a series in
 * its own zone, single events) x calendar zones (Los Angeles, London, Tokyo; Los Angeles guessed from all-day events)
 * x viewer zones (Los Angeles, London, Tokyo). Each occurrence is compared as the wall clock it should read in the
 * series' zone. The feed is read with ical.js (Thunderbird's parser), the grid's rule with the real Syncfusion.
 *
 * Run: node --test test/unit/series-zones-agree.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '../../public');
// The Syncfusion the page loads (public/vendor), for the grid's own expansion of a rule.
const vendored = (/\/vendor\/(syncfusion-[\d.]+)\/ej2-calendar\.min\.js/.exec(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')) || [])[1];
if (vendored && !process.env.PASTECAL_EJ2_PATH) process.env.PASTECAL_EJ2_PATH = path.join(PUBLIC, 'vendor', vendored, 'ej2-calendar.min.js');
const { loadRealEj } = require('./helpers/real-ej.js');
const ICAL = require('./helpers/ical-1.5.0.min.js');

globalThis.window = globalThis.window || {};
globalThis.Event = new Function('Utils', `${fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8')}; return Event;`)({ uuidv4: () => 'generated-uuid' });
const EventZone = require('../../public/services/EventZone.js');
const EventStore = require('../../public/services/EventStore.js');
globalThis.EventZone = EventZone; globalThis.EventStore = EventStore;
Object.assign(globalThis.window, { EventZone, EventStore });
const ScheduleAdapter = require('../../public/services/ScheduleAdapter.js');
globalThis.ScheduleAdapter = ScheduleAdapter;
const CalendarView = require('../../public/services/CalendarView.js');
require('../../public/nativecal/components/NativeCalendar.js');
globalThis.NativeCalendar = globalThis.window.NativeCalendar;
const Calendar = new Function('ScheduleAdapter', 'Event', `${fs.readFileSync(path.join(PUBLIC, 'models/Calendar.js'), 'utf8')}; return Calendar;`)(ScheduleAdapter, globalThis.Event);

const inZone = (zone, fn) => { const was = process.env.TZ; process.env.TZ = zone; try { return fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; } };
const p2 = (n) => String(n).padStart(2, '0');
const WINDOW = [Date.UTC(2026, 8, 1), Date.UTC(2029, 0, 1)];

// ---- the calendar, as the app stores it -----------------------------------------------------------------------
const at = (z, y, m, d, h = 0, min = 0) => EventZone.fromWall(y, m - 1, d, h, min, 0, z);
const isoAt = (z, ...a) => new Date(at(z, ...a)).toISOString();
// Recurrence stamps as classic and the card write them: an instant as UTC (a skipped or moved occurrence's start; an
// UNTIL or an all-day date as the writer's local midnight).
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const OWN = 'Asia/Tokyo';

/** The calendar's events, planned in zone z (its people's wall clock), and what each should read, in its zone. */
function calendarIn(z) {
    const weekly = { id: 'wk', title: 'Weekly', type: 1, isAllDay: false, description: '', start: isoAt(z, 2026, 10, 6, 17), end: isoAt(z, 2026, 10, 6, 18),
        recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=8;', recurrenceID: null,
        recurrenceException: [stamp(at(z, 2026, 10, 20, 17)), stamp(at(z, 2026, 11, 10, 17))].join(',') };
    const moved = { id: 'wk-moved', title: 'Weekly', type: 1, isAllDay: false, description: '', start: isoAt(z, 2026, 11, 10, 19), end: isoAt(z, 2026, 11, 10, 20),
        recurrencerule: weekly.recurrencerule, recurrenceID: 'wk', recurrenceException: stamp(at(z, 2026, 11, 10, 17)) };
    const monthly = { id: 'mo', title: 'Monthly', type: 2, isAllDay: false, description: '', start: isoAt(z, 2026, 10, 13, 19), end: isoAt(z, 2026, 10, 13, 20, 30),
        recurrencerule: `FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;INTERVAL=1;UNTIL=${stamp(at(z, 2027, 3, 9))};`, recurrenceID: null, recurrenceException: null };
    const yearly = { id: 'yr', title: 'Yearly', type: 3, isAllDay: false, description: '', start: isoAt(z, 2026, 10, 26, 9), end: isoAt(z, 2026, 10, 26, 10),
        recurrencerule: 'FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;COUNT=3;', recurrenceID: null, recurrenceException: null };
    const daily = { id: 'dy', title: 'Daily late', type: 4, isAllDay: false, description: '', start: isoAt(z, 2026, 10, 22, 23, 30), end: isoAt(z, 2026, 10, 23, 0, 30),
        recurrencerule: 'FREQ=DAILY;INTERVAL=1;COUNT=14;', recurrenceID: null, recurrenceException: null };
    const allDay = { id: 'ad', title: 'Saturdays', type: 5, isAllDay: true, description: '', start: isoAt(z, 2026, 10, 3), end: isoAt(z, 2026, 10, 4),
        recurrencerule: `FREQ=WEEKLY;BYDAY=SA;INTERVAL=1;UNTIL=${stamp(at(z, 2026, 11, 28))};`, recurrenceID: null, recurrenceException: stamp(at(z, 2026, 10, 31)) };
    const own = { id: 'tk', title: 'Tokyo call', type: 6, isAllDay: false, description: '', tz: OWN, start: isoAt(OWN, 2026, 10, 28, 8), end: isoAt(OWN, 2026, 10, 28, 9),
        recurrencerule: 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;COUNT=4;', recurrenceID: null, recurrenceException: null };
    const single = { id: 'one', title: 'Once', type: 7, isAllDay: false, description: '', start: isoAt(z, 2026, 11, 6, 12), end: isoAt(z, 2026, 11, 6, 13),
        recurrencerule: '', recurrenceID: null, recurrenceException: null };
    const days = [[12, 25], [11, 26]].map(([m, d], i) => ({ id: `d${i}`, title: 'Day off', type: 8, isAllDay: true, description: '',
        start: isoAt(z, 2026, m, d), end: isoAt(z, 2026, m, d + 1), recurrencerule: '', recurrenceID: null, recurrenceException: null }));
    return [weekly, moved, monthly, yearly, daily, allDay, own, single, ...days];
}
const EXPECTED = {
    Weekly: ['2026-10-06 17:00', '2026-10-13 17:00', '2026-10-27 17:00', '2026-11-03 17:00', '2026-11-10 19:00', '2026-11-17 17:00', '2026-11-24 17:00'],
    Monthly: ['2026-10-13 19:00', '2026-11-10 19:00', '2026-12-08 19:00', '2027-01-12 19:00', '2027-02-09 19:00', '2027-03-09 19:00'],
    Yearly: ['2026-10-26 09:00', '2027-10-25 09:00', '2028-10-30 09:00'],
    'Daily late': Array.from({ length: 14 }, (_, i) => `${new Date(Date.UTC(2026, 9, 22 + i)).toISOString().slice(0, 10)} 23:30`),
    Saturdays: ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28'],
    'Tokyo call': ['2026-10-28 08:00', '2026-11-04 08:00', '2026-11-11 08:00', '2026-11-18 08:00'],
    Once: ['2026-11-06 12:00'],
    'Day off': ['2026-11-26', '2026-12-25'],
};

// ---- what each reader shows, as the wall clock in the series' zone ---------------------------------------------
/** occurrences [{ title, allDay, ms (timed), day 'YYYY-MM-DD' (all-day, in the viewer's zone) }] -> { title: [...] } */
function asRead(list, z) {
    const out = {};
    for (const o of list) {
        const zone = o.title === 'Tokyo call' ? OWN : z;
        let v;
        if (o.allDay) v = o.day;
        else { const w = EventZone.wall(o.ms, zone); v = `${w.y}-${p2(w.m + 1)}-${p2(w.d)} ${p2(w.h)}:${p2(w.min)}`; }
        (out[o.title] = out[o.title] || []).push(v);
    }
    for (const k of Object.keys(out)) out[k].sort();
    return out;
}
const localDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** The feed, read as a calendar app reads it: its zones registered, each series expanded, its moved occurrences in place. */
function feedRead(ics) {
    const cal = new ICAL.Component(ICAL.parse(ics));
    ICAL.TimezoneService.reset();
    for (const z of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(z);
    const byUid = new Map();
    for (const v of cal.getAllSubcomponents('vevent')) {
        const uid = v.getFirstPropertyValue('uid');
        if (!byUid.has(uid)) byUid.set(uid, { master: null, overrides: [] });
        if (v.hasProperty('recurrence-id')) byUid.get(uid).overrides.push(v); else byUid.get(uid).master = v;
    }
    const out = [];
    const occ = (title, t) => (t.isDate ? { title, allDay: true, day: localDay(t.toJSDate()) } : { title, allDay: false, ms: t.toJSDate().getTime() });
    for (const { master, overrides } of byUid.values()) {
        const replaced = new Set(overrides.map((o) => o.getFirstPropertyValue('recurrence-id').toJSDate().getTime()));
        for (const o of overrides) out.push(occ(o.getFirstPropertyValue('summary'), o.getFirstPropertyValue('dtstart')));
        if (!master) continue;
        const ev = new ICAL.Event(master), title = ev.summary;
        if (!ev.isRecurring()) { out.push(occ(title, ev.startDate)); continue; }
        const it = ev.iterator();
        for (let n, i = 0; (n = it.next()) && i < 2000; i++) {
            if (n.toJSDate().getTime() >= WINDOW[1]) break;
            if (!replaced.has(n.toJSDate().getTime())) out.push(occ(title, n));
        }
    }
    return out.filter((o) => o.allDay || (o.ms >= WINDOW[0] && o.ms < WINDOW[1]));
}

/** Native: what CalendarView.native draws (the app's own expansion path). */
function nativeRead(cal) {
    const view = CalendarView.native({ calendar: cal, isEventVisible: () => true }, () => null);
    return view.occurrences(WINDOW[0], WINDOW[1]).map((o) => (o.allDay ? { title: o.title, allDay: true, day: localDay(o.start) } : { title: o.title, allDay: false, ms: o.start.getTime() }));
}

/** Classic: the records the grid is given (Calendar.getSyncFusionEvents), each rule expanded by the real Syncfusion. */
function classicRead(cal, ej) {
    const out = [];
    for (const r of new Calendar(cal.id, cal.title, cal.events, cal.options).getSyncFusionEvents()) {
        const start = new Date(r.StartTime), dur = new Date(r.EndTime) - start;
        const one = (s) => (r.IsAllDay ? { title: r.Subject, allDay: true, day: localDay(new Date(s)) } : { title: r.Subject, allDay: false, ms: s });
        if (r.RecurrenceRule && (r.RecurrenceID === null || r.RecurrenceID === undefined || r.RecurrenceID === '')) {
            for (const s of ej.schedule.generate(start, r.RecurrenceRule, r.RecurrenceException || null, 0, 2000, new Date(WINDOW[0] - dur))) {
                if (s < WINDOW[1]) out.push(one(s));
            }
        } else out.push(one(start.getTime()));
    }
    return out.filter((o) => o.allDay || (o.ms >= WINDOW[0] && o.ms < WINDOW[1]));
}

const CALENDARS = [
    { name: 'Los Angeles', zone: 'America/Los_Angeles', options: { tz: 'America/Los_Angeles' } },
    { name: 'London', zone: 'Europe/London', options: { tz: 'Europe/London' } },
    { name: 'Tokyo', zone: 'Asia/Tokyo', options: { tz: 'Asia/Tokyo' } },
    // Made before calendars stored their zone (Oct 25 2026): its all-day events say where it is.
    { name: 'Los Angeles, guessed from its all-day events', zone: 'America/Los_Angeles', options: {} },
];
const VIEWERS = ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'];

test('every occurrence reads the same in the feed, native and classic, for every calendar zone and viewer zone', async (t) => {
    const rrule = (await import('../../cloudflare/src/vendor/rrule-2.8.1.esm.js')).default;
    globalThis.window.rrule = rrule;
    const { ICSService } = await import('../../cloudflare/src/ICSService.js');
    const real = loadRealEj();
    assert.ok(real.ej, `the real Syncfusion loads: ${real.reason}`);
    const wrong = [], detail = [];
    for (const c of CALENDARS) {
        const cal = { id: 'c', title: c.name, options: c.options, events: calendarIn(c.zone) };
        const ics = ICSService.generateICS(cal, 'c');
        for (const viewer of VIEWERS) {
            const got = inZone(viewer, () => ({
                feed: asRead(feedRead(ics), c.zone),
                native: asRead(nativeRead(cal), c.zone),
                classic: asRead(classicRead(cal, real.ej), c.zone),
            }));
            for (const [reader, read] of Object.entries(got)) {
                const off = Object.keys(EXPECTED).filter((k) => JSON.stringify(read[k] || []) !== JSON.stringify(EXPECTED[k]));
                if (!off.length) continue;
                wrong.push(`calendar in ${c.name}, seen from ${viewer}: ${reader} (${off.join(', ')})`);
                if (detail.length < 3) detail.push(`${c.name} / ${viewer} / ${reader}: ${JSON.stringify(Object.fromEntries(off.map((k) => [k, read[k]])))}`);
            }
        }
    }
    assert.deepEqual(wrong, [], `every reader reads ${JSON.stringify(EXPECTED)}\n${detail.join('\n')}`);
});

test('a calendar that says nothing about its zone is written in UTC, as before (no TZID, no VTIMEZONE)', async () => {
    const { ICSService } = await import('../../cloudflare/src/ICSService.js');
    const events = calendarIn('America/Los_Angeles').filter((e) => !e.isAllDay && !e.tz);
    const ics = ICSService.generateICS({ id: 'c', title: 'No zone', options: {}, events }, 'c');
    assert.ok(!/TZID|VTIMEZONE|X-WR-TIMEZONE/.test(ics), ics);
    assert.ok(ics.includes('DTSTART:20261007T000000Z'));
});

test('VTIMEZONE: every offset change, then the yearly rule, as Intl has them (north, south, no DST)', () => {
    for (const [tz, y] of [['America/Los_Angeles', 2026], ['Europe/London', 2026], ['Pacific/Auckland', 2026], ['Asia/Tokyo', 2026], ['Australia/Brisbane', 2026]]) {
        const lines = EventZone.vtimezone(tz, y - 1, y + 1);
        const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...lines,
            'BEGIN:VEVENT', 'UID:x', 'DTSTAMP:20260101T000000Z', `DTSTART;TZID=${tz}:20250105T120000`, 'RRULE:FREQ=WEEKLY;UNTIL=20351231T000000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
        const cal = new ICAL.Component(ICAL.parse(ics));
        ICAL.TimezoneService.reset();
        for (const z of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(z);
        const it = new ICAL.Event(cal.getFirstSubcomponent('vevent')).iterator();
        const wrong = [];
        for (let n; (n = it.next());) {
            const ms = n.toJSDate().getTime(), w = EventZone.wall(ms, tz);
            if (`${w.h}:${w.min}` !== '12:0') wrong.push(new Date(ms).toISOString());
        }
        // (Through 2035: ical.js expands a zone's rules no further, ICAL.Timezone.MAX_YEAR.)
        assert.deepEqual(wrong, [], `${tz}: every week at noon, through 2035`);
    }
});

// Oct 26 2026: after A02 shipped, the production demo (no options.tz, no all-day events) still published its Tue/Thu
// 5:30 PM practice with BYDAY=TU,TH against a UTC Wednesday start: Monday/Wednesday evenings in every calendar app. With
// no zone, the feed now moves BYDAY to the start's UTC days, so the DAY is right everywhere (the hour may be off by one
// for half the year: no zone, no DST).
test('no zone at all: a weekly series lands on its local weekdays in a calendar app (west, east, and both neighbors listed)', async () => {
    const { ICSService } = await import('../../cloudflare/src/ICSService.js');
    // [made in, local start, BYDAY, expected local weekdays]
    const CASES = [
        ['America/Los_Angeles', [2026, 8, 1, 17, 30], 'TU,TH', ['TU', 'TH']],   // Tue 5:30 PM = Wed 00:30Z (both neighbors: west)
        ['America/Los_Angeles', [2026, 9, 6, 19, 0], 'TU', ['TU']],              // Tue 7 PM = Wed 02:00Z
        ['Asia/Tokyo', [2026, 9, 6, 8, 0], 'TU', ['TU']],                       // Tue 8 AM = Mon 23:00Z (east)
        ['Europe/London', [2026, 9, 6, 18, 0], 'TU', ['TU']],                   // same UTC day: unchanged
    ];
    for (const [zone, [y, mo, d, h, mi], byday, want] of CASES) {
        const startMs = EventZone.fromWall(y, mo, d, h, mi, 0, zone);
        const events = [{ id: 's', title: 'Practice', start: new Date(startMs).toISOString(), end: new Date(startMs + 3600e3).toISOString(),
            recurrencerule: `FREQ=WEEKLY;BYDAY=${byday};INTERVAL=1;COUNT=8;`, isAllDay: false, type: 1 }];
        const ics = ICSService.generateICS({ id: 'c', title: 'No zone', options: {}, events }, 'c');
        assert.ok(!/TZID/.test(ics), 'still UTC: nothing says where the calendar is');
        const cal = new ICAL.Component(ICAL.parse(ics));
        const it = new ICAL.Event(cal.getFirstSubcomponent('vevent')).iterator();
        const seen = new Set();
        for (let n, k = 0; (n = it.next()) && k < 8; k++) {
            const w = EventZone.wall(n.toJSDate().getTime(), zone);
            seen.add(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(Date.UTC(w.y, w.m, w.d)).getUTCDay()]);
        }
        assert.deepEqual([...seen].sort(), [...want].sort(), `${zone} ${byday}: ${ics.match(/RRULE:.*/)[0]}`);
    }
});

// Issue #48, still failing for the reporter after the site was fixed: the feed sent "the last Monday of October" as
// BYDAY=MO;BYSETPOS=-1, a form some calendar apps get wrong. It now sends BYDAY=-1MO, and the dates are the same ones.
test('feed: a yearly "last Monday of October" is written as BYDAY=-1MO and expands to the last Monday every year', async () => {
    const rrule = (await import('../../cloudflare/src/vendor/rrule-2.8.1.esm.js')).default;
    const { ICSService } = await import('../../cloudflare/src/ICSService.js');
    const events = [{ id: 'board', title: 'Board', type: 1, start: '2026-10-26T17:00:00.000Z', end: '2026-10-26T18:00:00.000Z',
        recurrencerule: 'FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;' }];
    const ics = ICSService.generateICS({ id: 'c', title: 'Board', options: { tz: 'America/Los_Angeles' }, events }, 'c');
    const line = ics.split('BEGIN:VEVENT')[1].split(/\r?\n/).find((l) => l.startsWith('RRULE:'));
    assert.equal(line, 'RRULE:FREQ=YEARLY;BYDAY=-1MO;BYMONTH=10;INTERVAL=1');
    const r = rrule.rrulestr(`DTSTART:20261026T100000\n${line}`);
    const days = r.between(new Date(Date.UTC(2027, 0, 1)), new Date(Date.UTC(2032, 0, 1))).map((d) => d.toISOString().slice(0, 10));
    assert.deepEqual(days, ['2027-10-25', '2028-10-30', '2029-10-29', '2030-10-28', '2031-10-27']);
    // Several weekdays with a position stay as they are (no single-day form says that).
    assert.equal(ICSService.plainPositions('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'), 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1');
    assert.equal(ICSService.plainPositions('FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;'), 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1');
});
