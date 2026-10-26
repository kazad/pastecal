/**
 * Repeat rules that freeze a browser (Oct 25 2026 red team): FREQ=SECONDLY was 3.6 million
 * occurrences in the native Month view (9 s frozen, then out of memory), COUNT=10000000 never
 * drew the classic view, INTERVAL=0 hung its Agenda. Anyone with an edit link could save one and
 * every editor's calendar froze on load, so no one could delete it.
 *
 * The server refuses them on every save path (CalendarRoom.tooBig); /import and restores keep
 * legacy rows; the views show such a stored event once (ScheduleAdapter.toView, NativeCalendar).
 *
 * Run: node --test test/unit/rrule-bomb.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const nodeModule = require('node:module');
const EventStore = require('../../public/services/EventStore.js');

if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
        resolve(specifier, context, next) {
            if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {}', shortCircuit: true };
            return next(specifier, context);
        },
    });
}
const noHooks = typeof nodeModule.registerHooks !== 'function' && 'module.registerHooks unavailable (Node < 22.15)';
const loadRoom = () => import(pathToFileURL(path.join(__dirname, '../../cloudflare/src/CalendarRoom.js')).href);

// Rules real calendars use (shapes Syncfusion and the native editor write, and imported .ics).
const ACCEPTED = [
    '',
    'FREQ=DAILY;INTERVAL=1;',
    'FREQ=DAILY;INTERVAL=1;COUNT=10;',
    'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261231T075959Z;',
    'FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=1;',
    'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;INTERVAL=1;',
    'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=2;INTERVAL=1;COUNT=12;',
    'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=25;INTERVAL=1;',
    'RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=TH',
    'freq=weekly;byday=mo',
    'FREQ=DAILY;COUNT=5000',
    'FREQ=HOURLY;INTERVAL=4',
    'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30',
    'FREQ=HOURLY;BYMINUTE=0,15,30,45',
];
const REJECTED = [
    ['FREQ=SECONDLY', /second/],
    ['FREQ=MINUTELY', /minute/],
    ['FREQ=MINUTELY;COUNT=10', /minute/],
    ['RRULE:freq=secondly;interval=1', /second/],
    ['FREQ=DAILY;BYSECOND=0', /second/],
    ['FREQ=MINUTELY;BYSECOND=' + Array.from({ length: 60 }, (_, i) => i).join(','), /minute/],
    ['FREQ=DAILY;BYHOUR=1;BYMINUTE=0,1,2,3,4', /hour/],
    ['FREQ=DAILY;COUNT=10000000', /5000/],
    ['FREQ=DAILY;COUNT=5001', /5000/],
    ['FREQ=DAILY;COUNT=0', /5000/],
    ['FREQ=DAILY;COUNT=-1', /5000/],
    ['FREQ=DAILY;INTERVAL=0', /interval/],
    ['FREQ=DAILY;INTERVAL=-2', /interval/],
    ['FREQ=DAILY;INTERVAL=1.5', /interval/],
    ['FREQ=DAILY;INTERVAL=', /interval/],
];

test('unsafeRecurrence: every rule real calendars use is allowed', () => {
    for (const r of [...ACCEPTED, null, undefined]) assert.equal(EventStore.unsafeRecurrence(r), null, r);
});

test('unsafeRecurrence: rules that expand into millions of occurrences are named', () => {
    for (const [r, why] of REJECTED) assert.match(String(EventStore.unsafeRecurrence(r)), why, r);
    assert.match(EventStore.unsafeRecurrence({ freq: 'SECONDLY' }), /not text/);
});

const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const ev = (id, extra = {}) => ({ id, title: 'Choir', start: at(1, 9), end: at(1, 10), type: 1, description: '', ...extra });
const room = (CalendarRoom) => ({ state: { title: 'T', options: {} }, tooBig: CalendarRoom.prototype.tooBig });

test('server: a save, create or Firebase write with a bomb rule is refused; real rules pass', { skip: noHooks }, async () => {
    const { CalendarRoom } = await loadRoom();
    const r = room(CalendarRoom);
    for (const rule of ACCEPTED) assert.equal(r.tooBig([ev('a', { recurrencerule: rule })]), null, rule);
    for (const [rule, why] of REJECTED) assert.match(String(r.tooBig([ev('a', { recurrencerule: rule })])), why, rule);
    assert.match(r.tooBig([ev('a', { title: { x: 1 } })]), /title is not text/);
    assert.match(r.tooBig([ev('a', { title: 7 })]), /title is not text/);
    assert.match(r.tooBig([ev('a', { description: ['x'] })]), /description is not text/);
    assert.equal(r.tooBig([ev('a', { title: undefined, description: null })]), null);
    assert.match(r.tooBig([ev('a', { recurrencerule: 42 })]), /not text/);
});

test('server: only the rows a save touches are checked, so a stored legacy bomb never locks a calendar out', { skip: noHooks }, async () => {
    const { CalendarRoom } = await loadRoom();
    const r = room(CalendarRoom);
    const legacy = ev('old', { recurrencerule: 'FREQ=SECONDLY' });
    const edit = ev('new', { title: 'Lunch' });
    assert.equal(r.tooBig([legacy, edit], { rows: [edit] }), null);
    assert.match(r.tooBig([legacy, edit], { rows: [legacy] }), /second/);
});

test('server: /import and restores (rules off) keep legacy rows; size limits still apply', { skip: noHooks }, async () => {
    const { CalendarRoom, LIMITS } = await loadRoom();
    const r = room(CalendarRoom);
    assert.equal(r.tooBig([ev('old', { recurrencerule: 'FREQ=SECONDLY', title: 5 })], { rules: false }), null);
    assert.match(r.tooBig([ev('old', { recurrencerule: 'F'.repeat(LIMITS.maxField + 1) })], { rules: false }), /too long/);
});

test('classic view: a stored bomb is shown once, unrepeated; a real series keeps its rule', () => {
    global.EventStore = EventStore;
    const warn = console.warn; const warned = []; console.warn = (m) => warned.push(m);
    try {
        const ScheduleAdapter = require('../../public/services/ScheduleAdapter.js');
        const [bomb, weekly] = ScheduleAdapter.toView([
            ev('b', { recurrencerule: 'FREQ=DAILY;COUNT=10000000' }),
            ev('w', { recurrencerule: 'FREQ=WEEKLY;BYDAY=TH;' }),
        ]);
        assert.equal(bomb.RecurrenceRule, '');
        assert.equal(weekly.RecurrenceRule, 'FREQ=WEEKLY;BYDAY=TH;');
        assert.equal(warned.length, 1); assert.match(warned[0], /event b: repeats more than 5000 times/);
    } finally { console.warn = warn; delete global.EventStore; }
});
