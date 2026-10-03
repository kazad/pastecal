/**
 * All-day events across timezones (public/models/Event.js + Calendar.js).
 *
 * Bug: an all-day event was stored as the UTC instant of the AUTHOR's local midnight
 * (Tokyo's Oct 2 -> "2026-10-01T15:00:00.000Z") and every viewer converted that instant
 * back to their own local time, so LA saw the holiday on Oct 1. All-day events are now
 * shown at the viewer's local midnight of their date; the stored instant maps to a date
 * with floor((ms + 13h + 1s) / 1 day), the same mapping the ICS feed uses.
 *
 * WRITES keep the legacy format (the writer's local midnight as a UTC instant): a tab
 * opened before a deploy keeps running the old client, which shows the stored instant
 * as-is, so a UTC-midnight write showed Oct 2 on Oct 1 in an old LA tab and the old
 * tab's next save made that permanent. UTC-midnight data (from an unreleased build)
 * must still read correctly.
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
    `${read('caldate.js')}\n${read('Event.js')}\n${read('Calendar.js')}\nreturn { Event, Calendar };`);
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
const until = (rule) => /UNTIL=([0-9TZ]+)/.exec(rule)[1];

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

test('all-day: a new event is stored in the legacy form, the author\'s local midnight', () => {
  const expected = {
    'Asia/Tokyo': ['2026-10-01T15:00:00.000Z', '2026-10-02T15:00:00.000Z'],
    'America/Los_Angeles': ['2026-10-02T07:00:00.000Z', '2026-10-03T07:00:00.000Z'],
    'Pacific/Auckland': ['2026-10-01T11:00:00.000Z', '2026-10-02T11:00:00.000Z'],
    'Europe/Berlin': ['2026-10-01T22:00:00.000Z', '2026-10-02T22:00:00.000Z'],
    'UTC': ['2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'],
  };
  for (const [tz, [start, end]] of Object.entries(expected)) {
    const e = authorAllDay(tz);
    assert.equal(e.start, start, `start authored in ${tz}`);
    assert.equal(e.end, end, `end authored in ${tz}`);
  }
});

// What a client from before the cross-zone fix shows: the stored instant, as-is, in the
// viewer's zone (Calendar.toDateOrNull for start/end). EXDATE/UNTIL stamps go straight to
// Syncfusion, which reads a UTC stamp as that instant and a FLOATING one as the viewer's
// local wall-clock time (ej.schedule.getDateFromRecurrenceDateString; checked against the
// real bundle below).
const oldClientDate = (value) => ymd(new Date(value));
const schedulerStampMs = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(s);
  const f = [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]];
  return m[7] ? Date.UTC(...f) : new Date(...f).getTime();
};
const stampDate = (s) => ymd(new Date(schedulerStampMs(s)));

test('all-day: an OLD client in the same zone reads a NEW client\'s writes as the same dates', () => {
  // Tabs opened before a deploy keep the old client. Whatever the new client writes for
  // an all-day event, its exception, or its UNTIL, an old tab in the author's zone must
  // show on the same date the new client does.
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/Berlin', 'Pacific/Auckland', 'UTC']) {
    inTZ(tz, () => {
      const created = new Event({ Id: 'h', Subject: 'Holiday', IsAllDay: true,
        StartTime: new Date(2026, 9, 2), EndTime: new Date(2026, 9, 3) });
      assert.equal(oldClientDate(created.start), '2026-10-2', `old start in ${tz}`);
      assert.equal(oldClientDate(created.end), '2026-10-3', `old end in ${tz}`);
      const shown = new Calendar('c', 't', [created]).getSyncFusionEvents()[0];
      assert.equal(ymd(shown.StartTime), oldClientDate(created.start), `new == old start in ${tz}`);
      assert.equal(ymd(shown.EndTime), oldClientDate(created.end), `new == old end in ${tz}`);

      // A daily series, with an occurrence deleted and an UNTIL picked in the new client.
      const series = new Event({ Id: 's', Subject: 'Daily', IsAllDay: true,
        StartTime: new Date(2026, 9, 1), EndTime: new Date(2026, 9, 2),
        RecurrenceRule: `FREQ=DAILY;INTERVAL=1;UNTIL=${Event.recurrenceStamp(new Date(2026, 9, 20))};`,
        RecurrenceException: Event.recurrenceStamp(new Date(2026, 9, 15)) });
      assert.equal(stampDate(series.recurrenceException), '2026-10-15', `old EXDATE in ${tz}`);
      assert.equal(stampDate(Event.allDayRuleUntil(series.recurrencerule)), '2026-10-20', `old UNTIL in ${tz}`);
      // Old clients compare UNTIL by instant against occurrences at local midnight: the
      // stored UNTIL must read as exactly the last day's local midnight to include it.
      assert.equal(schedulerStampMs(Event.allDayRuleUntil(series.recurrencerule)),
        new Date(2026, 9, 20).getTime(), `old UNTIL includes the last day in ${tz}`);
      const r = new Calendar('c', 't', [series]).getSyncFusionEvents()[0];
      assert.equal(stampDate(r.RecurrenceException), '2026-10-15', `new EXDATE in ${tz}`);

      // And the reverse: what an old client writes reads back as the same date.
      const oldWrite = { id: 'o', title: 'Old', isAllDay: true, type: 1,
        start: new Date(2026, 9, 2).toISOString(), end: new Date(2026, 9, 3).toISOString() };
      const back = new Calendar('c', 't', [oldWrite]).getSyncFusionEvents()[0];
      assert.equal(ymd(back.StartTime), '2026-10-2', `old write read by new in ${tz}`);
    });
  }
});

test('all-day: UTC-midnight data (from the unreleased build) still reads as its date', () => {
  const stored = { id: 'u', title: 'U', isAllDay: true, type: 1,
    start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z',
    recurrencerule: 'FREQ=DAILY;UNTIL=20261020T000000Z', recurrenceException: '20261015T000000Z' };
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/Berlin', 'Pacific/Auckland', 'UTC']) {
    inTZ(tz, () => {
      const r = new Calendar('c', 't', [stored]).getSyncFusionEvents()[0];
      assert.equal(ymd(r.StartTime), '2026-10-2', `start in ${tz}`);
      assert.equal(ymd(r.EndTime), '2026-10-3', `end in ${tz}`);
      assert.equal(stampDate(r.RecurrenceException), '2026-10-15', `EXDATE in ${tz}`);
      assert.equal(stampDate(until(r.RecurrenceRule)), '2026-10-20', `UNTIL in ${tz}`);
    });
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

test('all-day: moving a legacy event to another day writes the mover\'s local midnight', () => {
  const stored = { id: 'l', title: 'Old', start: '2026-10-01T15:00:00.000Z',
    end: '2026-10-02T15:00:00.000Z', isAllDay: true, type: 1 };
  inTZ('America/Los_Angeles', () => {
    const r = new Calendar('c', 't', [stored]).getSyncFusionEvents()[0];
    const moved = { ...r, StartTime: new Date(2026, 9, 5), EndTime: new Date(2026, 9, 6) };
    const e = new Event(moved);
    assert.equal(e.start, '2026-10-05T07:00:00.000Z');
    assert.equal(e.end, '2026-10-06T07:00:00.000Z');
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

// A recurrence stamp as the viewer's scheduler reads it (schedulerStampMs above):
// Syncfusion matches an exception to an occurrence by LOCAL date, and stops at UNTIL by
// instant.
const stampMs = schedulerStampMs;

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

test('all-day series: an occurrence deleted now is stored as the floating stamp of its date', () => {
  for (const viewer of ['America/Los_Angeles', 'Asia/Tokyo']) {
    inTZ(viewer, () => {
      const a = SERIES['Asia/Tokyo'];
      const r = new Calendar('c', 't', [seriesRow(a)]).getSyncFusionEvents()[0];
      // Syncfusion appends the occurrence's own start: local midnight of Oct 17.
      const deleted = new Date(2026, 9, 17).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const e = new Event({ ...r, RecurrenceException: `${r.RecurrenceException},${deleted}` });
      // Floating: every reader (this client, an old tab's Syncfusion, the feed) takes Oct
      // 17 from it in every zone, which no UTC instant does for UTC-11 and UTC+14.
      assert.equal(e.recurrenceException, `${a.exdate},20261017T000000`, `in ${viewer}`);
      assert.equal(e.recurrencerule, seriesRow(a).recurrencerule, 'untouched rule kept verbatim');
    });
  }
});

test('all-day series: a new UNTIL is stored as the floating stamp of its date', () => {
  inTZ('Asia/Tokyo', () => {
    const r = new Calendar('c', 't', [seriesRow(SERIES['America/Los_Angeles'])]).getSyncFusionEvents()[0];
    // The editor's until-date picker yields local midnight of Oct 25.
    const picked = new Date(2026, 9, 25).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const e = new Event({ ...r, RecurrenceRule: `FREQ=DAILY;INTERVAL=1;UNTIL=${picked};` });
    // A changed rule is stored in one spelling: Syncfusion's trailing ';' is dropped.
    assert.equal(e.recurrencerule, 'FREQ=DAILY;INTERVAL=1;UNTIL=20261025T000000');
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

// --- Floating UNTIL (nativecal's editor) and UTC+13 inclusive ends ----------------------

test('all-day series: a floating UNTIL names its own date, in the grid and the feed', () => {
  // nativecal's editor wrote UNTIL=20261025T235959 (no Z) for "through Oct 25"; read as
  // a UTC instant through the +13h window it became Oct 26 everywhere.
  const { ICSService } = require('../../functions/index.js')._internal;
  const row = { id: 'n', title: 'N', isAllDay: true, type: 1,
    start: '2026-10-20T07:00:00.000Z', end: '2026-10-21T07:00:00.000Z',
    recurrencerule: 'FREQ=DAILY;UNTIL=20261025T235959' };
  assert.equal(ICSService.seriesRule(row.recurrencerule, true), 'FREQ=DAILY;UNTIL=20261025');
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
    inTZ(tz, () => {
      const r = new Calendar('c', 't', [row]).getSyncFusionEvents()[0];
      const u = new Date(stampMs(until(r.RecurrenceRule)));
      assert.equal(u.getTime(), new Date(2026, 9, 25).getTime(), `UNTIL at local Oct 25 in ${tz}`);
      assert.equal(Event.ruleUntilDate(row.recurrencerule, true), '2026-10-25', `editor reads Oct 25 in ${tz}`);
      // Untouched, it stays verbatim.
      assert.equal(new Event(r).recurrencerule, row.recurrencerule, `kept in ${tz}`);
    });
  }
});

test('nativecal editor: UNTIL reads as the date the grid shows and is written in its format', () => {
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
    inTZ(tz, () => {
      // Grid-written (local midnight), UTC-midnight, and floating stamps all read Oct 25.
      const gridStamp = Event.recurrenceStamp(new Date(2026, 9, 25));
      for (const rule of [`FREQ=DAILY;UNTIL=${gridStamp}`, 'FREQ=DAILY;UNTIL=20261025T000000Z',
        'FREQ=DAILY;UNTIL=20261025T235959', 'FREQ=DAILY;UNTIL=20261025']) {
        assert.equal(Event.ruleUntilDate(rule, true), '2026-10-25', `${rule} in ${tz}`);
      }
      assert.equal(Event.ruleUntilStamp('2026-10-25', true), '20261025T000000', `all-day write in ${tz}`);
      // Timed: a UTC stamp of local 23:59:59, as Syncfusion writes it (a floating
      // T235959 read as UTC in the feed and lost the last occurrence west of UTC).
      assert.equal(Event.ruleUntilStamp('2026-10-25', false),
        Event.recurrenceStamp(new Date(2026, 9, 25, 23, 59, 59)), `timed write in ${tz}`);
      assert.equal(Event.ruleUntilDate('FREQ=DAILY', true), '');
    });
  }
});

test('all-day: a legacy nativecal event authored at UTC+13 keeps its last day', () => {
  // nativecal stored local midnight .. local 23:59:59.999 of the last day. At UTC+13 that
  // end sat exactly 1ms short of the next date under the +13h window.
  const { ICSService } = require('../../functions/index.js')._internal;
  const rows = inTZ('Pacific/Auckland', () => [
    { id: 'm', title: 'M', isAllDay: true, type: 1,
      start: new Date(2026, 9, 20).getTime(), end: new Date(2026, 9, 22, 23, 59, 59, 999).getTime() },
    { id: 'one', title: 'O', isAllDay: true, type: 1,
      start: new Date(2026, 9, 20).getTime(), end: new Date(2026, 9, 20, 23, 59, 59, 999).getTime() },
  ]);
  assert.equal(ICSService.formatDate(rows[0].end), '20261023', 'feed end (exclusive)');
  assert.equal(ICSService.formatDate(rows[1].end), '20261021', 'feed single-day end');
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
    inTZ(tz, () => {
      const cal = new Calendar('c', 't', rows.map(r => ({ ...r })));
      const [m, one] = cal.getSyncFusionEvents();
      assert.equal(ymd(m.StartTime), '2026-10-20', `multi-day start in ${tz}`);
      assert.equal(ymd(m.EndTime), '2026-10-23', `multi-day end (exclusive) in ${tz}`);
      assert.equal(ymd(one.EndTime), '2026-10-21', `single-day end in ${tz}`);
      const shown = Event.allDayDisplayRange(rows[0]);
      assert.equal(ymd(new Date(shown.end)), '2026-10-22', `nativecal last day in ${tz}`);
      cal.setEvents(cal.getSyncFusionEvents());
      cal.events.forEach((e, i) => {
        assert.equal(e.start, rows[i].start, `${rows[i].id} start untouched in ${tz}`);
        assert.equal(e.end, rows[i].end, `${rows[i].id} end untouched in ${tz}`);
      });
    });
  }
});

test('all-day: a zero-length stored row reaches the grid as one day and stays untouched', () => {
  const row = { id: 'z', title: 'Z', isAllDay: true, type: 1,
    start: '2026-10-20T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' };
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
    inTZ(tz, () => {
      const cal = new Calendar('c', 't', [{ ...row }]);
      const r = cal.getSyncFusionEvents()[0];
      assert.equal(ymd(r.StartTime), '2026-10-20', `start in ${tz}`);
      assert.equal(ymd(r.EndTime), '2026-10-21', `end in ${tz}`);
      cal.setEvents([r]);
      assert.equal(cal.events[0].end, row.end, `end untouched in ${tz}`);
      assert.equal(cal.events[0]._shownEnd, undefined, 'helper fields are not persisted');
    });
  }
});
