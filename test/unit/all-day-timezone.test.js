/**
 * All-day events across timezones (public/models/Event.js + Calendar.js).
 *
 * Bug: an all-day event was stored as the UTC instant of the AUTHOR's local midnight
 * (Tokyo's Oct 2 -> "2026-10-01T15:00:00.000Z") and every viewer converted that instant
 * back to their own local time, so LA saw the holiday on Oct 1. All-day events are now
 * stored as UTC midnight of their date and shown at the viewer's local midnight of that
 * date; legacy instants map to a date with floor((ms + 13h) / 1 day), the same mapping
 * the ICS feed uses.
 *
 * Node honors runtime changes to process.env.TZ, so each case switches zone in-process.
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadModels() {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../../public/models', f), 'utf8');
  const factory = new Function('Utils', 'CalendarDataService',
    `${read('Event.js')}\n${read('Calendar.js')}\nreturn { Event, Calendar };`);
  return factory({ uuidv4: () => 'generated-uuid' }, { debounce_sync() {} });
}

const { Event, Calendar } = loadModels();
const { loadRealEj } = require('./helpers/real-ej.js');
const ORIGINAL_TZ = process.env.TZ;

function inTZ(tz, fn) {
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  }
}

const ymd = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// What the scheduler emits when an author creates an all-day event on Oct 2 local.
function authorAllDay(tz) {
  return inTZ(tz, () => new Event({
    Id: 'h', Subject: 'Holiday', IsAllDay: true,
    StartTime: new Date(2026, 9, 2), EndTime: new Date(2026, 9, 3),
  }));
}

function viewerSees(tz, stored) {
  return inTZ(tz, () => {
    const r = new Calendar('c', 't', [stored]).getSyncFusionEvents()[0];
    return { start: ymd(r.StartTime), end: ymd(r.EndTime),
      startHour: r.StartTime.getHours(), allDay: r.IsAllDay };
  });
}

test('all-day: a new event is stored as UTC midnight of its date, whatever the author zone', () => {
  for (const tz of ['Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    const e = authorAllDay(tz);
    assert.equal(e.start, '2026-10-02T00:00:00.000Z', `start authored in ${tz}`);
    assert.equal(e.end, '2026-10-03T00:00:00.000Z', `end authored in ${tz}`);
  }
});

test('all-day: every viewer sees the authored date at their own local midnight', () => {
  const stored = authorAllDay('Asia/Tokyo');
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/Berlin', 'Pacific/Honolulu', 'Pacific/Auckland']) {
    const v = viewerSees(tz, stored);
    assert.equal(v.start, '2026-10-2', `start seen in ${tz}`);
    assert.equal(v.end, '2026-10-3', `end seen in ${tz}`);
    assert.equal(v.startHour, 0, `local midnight in ${tz}`);
    assert.equal(v.allDay, true);
  }
});

test('all-day: legacy local-midnight data keeps its date for viewers elsewhere', () => {
  // Author local midnight of Oct 2 in each zone, as the old code stored it.
  const legacy = {
    'Asia/Tokyo': '2026-10-01T15:00:00.000Z',          // UTC+9
    'Pacific/Auckland': '2026-10-01T11:00:00.000Z',    // UTC+13 (NZ summer)
    'America/Los_Angeles': '2026-10-02T07:00:00.000Z', // UTC-7
    'Pacific/Honolulu': '2026-10-02T10:00:00.000Z',    // UTC-10
  };
  for (const [author, start] of Object.entries(legacy)) {
    const stored = { id: 'l', title: 'Old', start, end: start, isAllDay: true, type: 1 };
    for (const viewer of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      assert.equal(viewerSees(viewer, stored).start, '2026-10-2', `${author} data seen in ${viewer}`);
    }
  }
});

test('all-day: an untouched legacy event survives a save round-trip byte-for-byte', () => {
  // Every grid edit runs ALL events through getSyncFusionEvents -> setEvents. An event
  // the user did not touch must not be rewritten (and so cannot drift).
  const stored = { id: 'l', title: 'Old', start: '2026-10-01T15:00:00.000Z',
    end: '2026-10-02T15:00:00.000Z', isAllDay: true, type: 1 };
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/London']) {
    inTZ(tz, () => {
      const cal = new Calendar('c', 't', [stored]);
      cal.setEvents(cal.getSyncFusionEvents());
      assert.equal(cal.events[0].start, stored.start, `start after round-trip in ${tz}`);
      assert.equal(cal.events[0].end, stored.end, `end after round-trip in ${tz}`);
      assert.equal(cal.events[0]._storedStart, undefined, 'helper fields are not persisted');
    });
  }
});

test('all-day: moving a legacy event to another day writes the new UTC-midnight form', () => {
  const stored = { id: 'l', title: 'Old', start: '2026-10-01T15:00:00.000Z',
    end: '2026-10-02T15:00:00.000Z', isAllDay: true, type: 1 };
  inTZ('America/Los_Angeles', () => {
    const r = new Calendar('c', 't', [stored]).getSyncFusionEvents()[0];
    const moved = { ...r, StartTime: new Date(2026, 9, 5), EndTime: new Date(2026, 9, 6) };
    const e = new Event(moved);
    assert.equal(e.start, '2026-10-05T00:00:00.000Z');
    assert.equal(e.end, '2026-10-06T00:00:00.000Z');
  });
});

test('timed events are unaffected: the instant is preserved', () => {
  const stored = { id: 't', title: 'Call', start: '2026-10-01T15:00:00.000Z',
    end: '2026-10-01T16:00:00.000Z', isAllDay: false, type: 1 };
  inTZ('America/Los_Angeles', () => {
    const cal = new Calendar('c', 't', [stored]);
    const r = cal.getSyncFusionEvents()[0];
    assert.equal(r.StartTime.toISOString(), stored.start);
    cal.setEvents([r]);
    assert.equal(cal.events[0].start, stored.start);
    assert.equal(cal.events[0].end, stored.end);
  });
});

// --- Every field of an untouched stored event survives setEvents -------------------------

const FIELDS = ['id', 'title', 'description', 'start', 'end', 'type', 'isAllDay', 'repeat',
  'recurrencerule', 'recurrenceID', 'recurrenceException'];

test('setEvents: an untouched stored event keeps every field, inverted ranges included', () => {
  // Any grid action rebuilds ALL events through getSyncFusionEvents -> setEvents. A legacy
  // row with end < start used to be "repaired" there, which the merge then treated as this
  // client's edit and wrote over someone else's concurrent change to that row.
  const rows = [
    { id: 'inv', title: 'Inverted', description: 'd', type: 2, isAllDay: false, repeat: '',
      recurrencerule: '', recurrenceID: null, recurrenceException: null,
      start: '2026-10-05T17:00:00.000Z', end: '2026-10-05T16:00:00.000Z' },
    { id: 'invAD', title: 'Inverted all-day', description: '', type: 1, isAllDay: true, repeat: '',
      recurrencerule: '', recurrenceID: null, recurrenceException: null,
      start: '2026-10-02T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    { id: 'epoch', title: 'nativecal', description: '', type: 1, isAllDay: false, repeat: '',
      recurrencerule: '', recurrenceID: null, recurrenceException: null,
      start: Date.UTC(2026, 9, 5, 17), end: Date.UTC(2026, 9, 5, 18) },
    { id: 'series', title: 'Tokyo series', description: '', type: 1, isAllDay: true, repeat: '',
      recurrencerule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20261019T150000Z;',
      recurrenceID: null, recurrenceException: '20261014T150000Z,20261016T000000Z',
      start: '2026-09-30T15:00:00.000Z', end: '2026-10-01T15:00:00.000Z' },
    { id: 'bad', title: 'Garbage', description: '', type: 1, isAllDay: true, repeat: '',
      recurrencerule: '', recurrenceID: null, recurrenceException: null,
      start: 'not a date', end: '2026-10-01T00:00:00.000Z' },
  ];
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
    inTZ(tz, () => {
      const cal = new Calendar('c', 't', rows.map(r => ({ ...r })));
      cal.setEvents(cal.getSyncFusionEvents());
      cal.events.forEach((e, i) => {
        for (const f of FIELDS) assert.equal(e[f], rows[i][f], `${rows[i].id}.${f} in ${tz}`);
      });
    });
  }
});

// --- All-day series: EXDATE and UNTIL ride the same date mapping as the start -------------

// A recurrence stamp as the viewer's scheduler reads it: Syncfusion matches an exception
// to an occurrence by LOCAL date, and stops at UNTIL by instant.
const stampMs = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};
const until = (rule) => /UNTIL=([0-9TZ]+)/.exec(rule)[1];

// An LA-authored daily series (legacy local-midnight instants), Oct 15 deleted, until Oct 20,
// and the same series authored in Tokyo.
const SERIES = {
  'America/Los_Angeles': { start: '2026-10-01T07:00:00.000Z', end: '2026-10-02T07:00:00.000Z',
    exdate: '20261015T070000Z', until: '20261020T070000Z' },
  'Asia/Tokyo': { start: '2026-09-30T15:00:00.000Z', end: '2026-10-01T15:00:00.000Z',
    exdate: '20261014T150000Z', until: '20261019T150000Z' },
};
const seriesRow = (a) => ({ id: 's', title: 'Daily', isAllDay: true, type: 1,
  start: a.start, end: a.end, recurrenceException: a.exdate,
  recurrencerule: `FREQ=DAILY;INTERVAL=1;UNTIL=${a.until};` });

test('all-day series: a deleted occurrence and UNTIL keep their dates for every viewer', () => {
  for (const [author, a] of Object.entries(SERIES)) {
    for (const viewer of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
      inTZ(viewer, () => {
        const r = new Calendar('c', 't', [seriesRow(a)]).getSyncFusionEvents()[0];
        const ex = new Date(stampMs(r.RecurrenceException));
        assert.equal(ymd(ex), '2026-10-15', `${author} EXDATE seen in ${viewer}`);
        const u = new Date(stampMs(until(r.RecurrenceRule)));
        assert.equal(ymd(u), '2026-10-20', `${author} UNTIL seen in ${viewer}`);
        // At local midnight, like the occurrences: UNTIL is compared by instant, so the
        // last day is in and the day after is out.
        assert.equal(u.getTime(), new Date(2026, 9, 20).getTime());
      });
    }
  }
});

test('all-day series: the real scheduler hides the deleted date, not the day before', (t) => {
  const real = loadRealEj();
  if (!real.ej) {
    if (process.env.CI) assert.fail(real.reason);
    t.skip(real.reason);
    return;
  }
  for (const [author, a] of Object.entries(SERIES)) {
    for (const viewer of ['America/Los_Angeles', 'Asia/Tokyo']) {
      inTZ(viewer, () => {
        const r = new Calendar('c', 't', [seriesRow(a)]).getSyncFusionEvents()[0];
        const days = real.ej.schedule.generate(r.StartTime, r.RecurrenceRule,
          r.RecurrenceException, 0, 40, null).map(d => ymd(new Date(d)));
        assert.ok(!days.includes('2026-10-15'), `${author} Oct 15 hidden in ${viewer}`);
        assert.ok(days.includes('2026-10-14'), `${author} Oct 14 shown in ${viewer}`);
        assert.equal(days[days.length - 1], '2026-10-20', `${author} last day in ${viewer}`);
      });
    }
  }
});

test('all-day series: an occurrence deleted now is stored as a UTC-midnight stamp', () => {
  for (const viewer of ['America/Los_Angeles', 'Asia/Tokyo']) {
    inTZ(viewer, () => {
      const a = SERIES['Asia/Tokyo'];
      const r = new Calendar('c', 't', [seriesRow(a)]).getSyncFusionEvents()[0];
      // Syncfusion appends the occurrence's own start: local midnight of Oct 17.
      const deleted = new Date(2026, 9, 17).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const e = new Event({ ...r, RecurrenceException: `${r.RecurrenceException},${deleted}` });
      assert.equal(e.recurrenceException, `${a.exdate},20261017T000000Z`, `in ${viewer}`);
      assert.equal(e.recurrencerule, seriesRow(a).recurrencerule, 'untouched rule kept verbatim');
    });
  }
});

test('all-day series: a new UNTIL is stored as UTC midnight of its date', () => {
  inTZ('Asia/Tokyo', () => {
    const r = new Calendar('c', 't', [seriesRow(SERIES['America/Los_Angeles'])]).getSyncFusionEvents()[0];
    // The editor's until-date picker yields local midnight of Oct 25.
    const picked = new Date(2026, 9, 25).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const e = new Event({ ...r, RecurrenceRule: `FREQ=DAILY;INTERVAL=1;UNTIL=${picked};` });
    assert.equal(e.recurrencerule, 'FREQ=DAILY;INTERVAL=1;UNTIL=20261025T000000Z;');
    assert.equal(e.recurrenceException, SERIES['America/Los_Angeles'].exdate);
  });
});

test('all-day series: the grid and the ICS feed read EXDATE and UNTIL as the same dates', () => {
  const { ICSService } = require('../../functions/index.js')._internal;
  const stamps = ['20261015T000000Z', '20261014T150000Z', '20261015T070000Z',
    '20261014T110000Z', '20261015T120000Z'];
  for (const viewer of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
    inTZ(viewer, () => {
      for (const s of stamps) {
        const shown = new Date(stampMs(Event.allDayStampToLocal(s)));
        assert.equal(ymd(shown).replace(/-(\d)(?=-|$)/g, '-0$1').replace(/-/g, ''),
          ICSService.formatDate(s), `${s} in ${viewer}`);
        // and the stamp stored for that date reads back as the same date in the feed
        assert.equal(ICSService.formatDate(Event.allDayStampFromLocal(Event.allDayStampToLocal(s))),
          ICSService.formatDate(s), `${s} stored form in ${viewer}`);
      }
      const rule = ICSService.seriesRule(Event.allDayRuleFromLocal(
        Event.allDayRuleToLocal('FREQ=DAILY;UNTIL=20261019T150000Z')), true);
      assert.equal(rule, 'FREQ=DAILY;UNTIL=20261020');
    });
  }
});
