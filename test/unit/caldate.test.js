/**
 * One date mapping, everywhere (functions/caldate.js, copied to public/models/caldate.js).
 *
 * Root cause covered here: the grid (Event.js) and the ICS feed (ICSService) each kept
 * their own copy of "which date does this stored value name", and the copies drifted --
 * a floating EXDATE "20261009T120000" on an all-day series was Oct 9 in the grid and Oct
 * 10 in the feed. Both now call caldate.js, the browser gets a byte-identical copy, and
 * these tests hold that in place.
 *
 * Also covered: all-day events at UTC-11 (Pago Pago) and UTC+14 (Kiritimati), outside
 * the +13h window the legacy instants are read through -- an event created there read
 * back a day off and could not be corrected. All-day events now store their dates
 * (allDayDates) next to the legacy instants, and an all-day series' EXDATE/UNTIL are
 * floating stamps of their dates. Plus nativecal's recurrence expansion against the real
 * scheduler, timed-series UNTIL, and the editor's all-day <-> timed switch.
 *
 * Node honors runtime changes to process.env.TZ, so each case switches zone in-process.
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const { Event, Calendar } = new Function('Utils', 'CalendarDataService',
  `${read('public/models/caldate.js')}\n${read('public/models/Event.js')}\n${read('public/models/Calendar.js')}
   return { Event, Calendar };`)({ uuidv4: () => 'generated-uuid' }, { debounce_sync() {} });
const CalDate = require('../../functions/caldate.js');
const { ICSService, HistoryService } = require('../../functions/index.js')._internal;
const { loadDataService } = require('./helpers/data-service-harness.js');
const { loadRealEj } = require('./helpers/real-ej.js');
const { loadRealRrule } = require('./helpers/real-rrule.js');

const ORIGINAL_TZ = process.env.TZ;
function inTZ(tz, fn) {
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  }
}

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland',
  'Pacific/Pago_Pago', 'Pacific/Kiritimati', 'Europe/Berlin', 'Pacific/Honolulu'];
const ymd = (d) => CalDate.localYmd(d);
const feed = (events) => ICSService.generateICS({ events }, 'c');
const prop = (ics, name) => (new RegExp(`^${name}[;:][^\\r\\n]*`, 'm').exec(ics) || [''])[0].replace(/^[^:]*:/, '');

function need(t, loaded) {
  if (loaded.reason) {
    if (process.env.CI) assert.fail(loaded.reason);
    t.skip(loaded.reason);
    return false;
  }
  return true;
}

// ---- one module ---------------------------------------------------------------------------

test('caldate: the browser copy is byte-identical to functions/caldate.js', () => {
  assert.equal(read('public/models/caldate.js'), read('functions/caldate.js'),
    'public/models/caldate.js is stale: run scripts/sync-shared.sh');
  const r = spawnSync('bash', [path.join(ROOT, 'scripts/sync-shared.sh'), '--check']);
  assert.equal(r.status, 0, String(r.stdout) + String(r.stderr));
});

test('caldate: deploys sync the copy first', () => {
  assert.match(read('deploy.sh'), /scripts\/sync-shared\.sh/);
  const hosting = JSON.parse(read('firebase.json')).hosting;
  assert.ok((hosting.predeploy || []).some(c => c.includes('sync-shared.sh')), 'hosting predeploy');
  for (const page of ['public/index.html', 'public/nativecal/index.html']) {
    const html = read(page);
    const at = (s) => html.indexOf(s);
    assert.ok(at('/models/caldate.js') > 0 && at('/models/caldate.js') < at('/models/Event.js'),
      `${page} loads caldate.js before Event.js`);
  }
});

test('caldate: Event.js and ICSService keep no copy of the mapping', () => {
  // The window constant and the floating-stamp rule live in caldate.js only.
  for (const f of ['public/models/Event.js', 'functions/index.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /13\s*\*\s*(3600000|HOUR|HOUR_MS|60\s*\*\s*60)/, `${f}: +13h window`);
    assert.doesNotMatch(src, /value\.slice\(0,\s*8\)/, `${f}: hand-rolled floating stamp date`);
  }
});

test('caldate: a floating stamp names its own wall-clock date', () => {
  for (const s of ['20261009T120000', '20261009T000000', '20261009T235959', '20261009']) {
    assert.equal(CalDate.stampDate(s), '2026-10-09', s);
  }
  // UTC stamps are instants: the writer's local midnight, through the window.
  assert.equal(CalDate.stampDate('20261008T150000Z'), '2026-10-09'); // Tokyo
  assert.equal(CalDate.stampDate('20261009T070000Z'), '2026-10-09'); // LA
  assert.equal(CalDate.stampDate('20261009T000000Z'), '2026-10-09'); // UTC
});

test('grid and feed agree on every EXDATE of an all-day series, floating ones included', () => {
  const stamps = ['20261009T120000', '20261009T000000', '20261009T235959', '20261008T150000Z',
    '20261009T070000Z', '20261009T000000Z', '20261008T110000Z'];
  for (const s of stamps) {
    const row = { id: 's', title: 'S', isAllDay: true, type: 1,
      start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z',
      recurrencerule: 'FREQ=DAILY;COUNT=30', recurrenceException: s };
    assert.equal(prop(feed([row]), 'EXDATE'), '20261009', `feed EXDATE for ${s}`);
    for (const tz of ZONES) {
      inTZ(tz, () => {
        const r = new Calendar('c', 't', [row]).getSyncFusionEvents()[0];
        assert.equal(CalDate.stampDate(r.RecurrenceException), '2026-10-09', `grid ${s} in ${tz}`);
      });
    }
  }
});

// ---- all-day dates at UTC-11 and UTC+14 -------------------------------------------------------

const createdIn = (tz) => inTZ(tz, () => new Event({ Id: 'h', Subject: 'Holiday', IsAllDay: true,
  StartTime: new Date(2026, 9, 2), EndTime: new Date(2026, 9, 4) }));

test('all-day: created anywhere, including UTC-11 and UTC+14, every reader sees its dates', () => {
  for (const author of ZONES) {
    const e = createdIn(author);
    assert.deepEqual(e.allDayDates, { start: '2026-10-02', end: '2026-10-04' }, `dates written in ${author}`);
    // The legacy instants stay the author's local midnight, for tabs still on old code.
    inTZ(author, () => {
      assert.equal(ymd(new Date(e.start)), '2026-10-02', `old-tab start in ${author}`);
      assert.equal(ymd(new Date(e.end)), '2026-10-04', `old-tab end in ${author}`);
    });
    const ics = feed([e]);
    assert.equal(prop(ics, 'DTSTART'), '20261002', `feed start, authored in ${author}`);
    assert.equal(prop(ics, 'DTEND'), '20261004', `feed end, authored in ${author}`);
    for (const viewer of ZONES) {
      inTZ(viewer, () => {
        const r = new Calendar('c', 't', [e]).getSyncFusionEvents()[0];
        assert.equal(ymd(r.StartTime), '2026-10-02', `${author} -> ${viewer} grid start`);
        assert.equal(ymd(r.EndTime), '2026-10-04', `${author} -> ${viewer} grid end`);
        const shown = Event.allDayDisplayRange(e);
        assert.equal(ymd(shown.start), '2026-10-02', `${author} -> ${viewer} nativecal start`);
        assert.equal(ymd(shown.end), '2026-10-03', `${author} -> ${viewer} nativecal last day`);
        assert.equal(ymd(Event.allDayLocalRange(e).start), '2026-10-02', `${author} -> ${viewer} labels`);
      });
    }
  }
});

test('all-day: a quick-added event (minted here, no id) records the dates it was given', () => {
  for (const tz of ZONES) {
    inTZ(tz, () => {
      // QuickAddDialog's payload, as both apps hand it to new Event(...).
      const e = new Event({ title: 'Q', isAllDay: true,
        start: new Date(2026, 9, 2).toISOString(), end: new Date(2026, 9, 4).toISOString() });
      assert.deepEqual(e.allDayDates, { start: '2026-10-02', end: '2026-10-04' }, tz);
      // nativecal's inclusive end reads the same.
      const n = new Event({ title: 'N', isAllDay: true, start: new Date(2026, 9, 2).getTime(),
        end: new Date(2026, 9, 3, 23, 59, 59, 999).getTime() });
      assert.deepEqual(n.allDayDates, { start: '2026-10-02', end: '2026-10-04' }, tz);
      // A stored row (it has an id) is never re-dated by whoever happens to read it.
      assert.equal(new Event({ ...e, id: 'x', allDayDates: null }).allDayDates, null, tz);
    });
  }
});

test('all-day: an untouched row keeps every field, allDayDates included, through setEvents', () => {
  for (const author of ['Pacific/Pago_Pago', 'Pacific/Kiritimati']) {
    const stored = JSON.parse(JSON.stringify(createdIn(author)));
    for (const viewer of ZONES) {
      inTZ(viewer, () => {
        const cal = new Calendar('c', 't', [{ ...stored }]);
        cal.setEvents(cal.getSyncFusionEvents());
        assert.deepEqual(JSON.parse(JSON.stringify(cal.events[0])), stored, `${author} row in ${viewer}`);
      });
    }
  }
});

test('all-day: a legacy row from UTC-11 that reads a day off can be corrected, and the fix saves', () => {
  // Written by a client that predates allDayDates, in Pago Pago: local midnight of Oct 2
  // is 11:00Z, which the window reads as Oct 3 -- the regression.
  const legacy = { id: 'p', title: 'P', isAllDay: true, type: 1,
    start: '2026-10-02T11:00:00.000Z', end: '2026-10-03T11:00:00.000Z' };
  const { S } = loadDataService();
  inTZ('Pacific/Pago_Pago', () => {
    const r = new Calendar('c', 't', [legacy]).getSyncFusionEvents()[0];
    assert.equal(ymd(r.StartTime), '2026-10-03', 'the legacy limitation this field fixes');
    // The user drags it back to Oct 2. The instants come out unchanged -- only the dates
    // carry the correction, so they must count as an edit everywhere.
    const fixed = new Event({ ...r, StartTime: new Date(2026, 9, 2), EndTime: new Date(2026, 9, 3) });
    assert.equal(fixed.start, legacy.start);
    assert.deepEqual(fixed.allDayDates, { start: '2026-10-02', end: '2026-10-03' });
    assert.equal(S._sameEvent(legacy, fixed), false, 'merge sees the correction');
    assert.equal(HistoryService.sameEvent(legacy, fixed), false, 'history sees the correction');
    for (const viewer of ZONES) {
      inTZ(viewer, () => {
        const back = new Calendar('c', 't', [fixed]).getSyncFusionEvents()[0];
        assert.equal(ymd(back.StartTime), '2026-10-02', `corrected, seen in ${viewer}`);
      });
    }
    assert.equal(prop(feed([fixed]), 'DTSTART'), '20261002');
  });
});

test('all-day: merge and history treat a row with and without allDayDates as one event', () => {
  const { S } = loadDataService();
  const e = JSON.parse(JSON.stringify(createdIn('Asia/Tokyo')));
  const { allDayDates, ...old } = e;
  assert.ok(allDayDates);
  assert.equal(S._sameEvent(e, old), true);
  assert.equal(HistoryService.sameEvent(e, old), true);
  // A timed event never compares on it.
  const timed = { ...old, isAllDay: false, allDayDates };
  assert.equal(S._sameEvent(timed, { ...old, isAllDay: false }), true);
});

test('all-day: dates that no longer match start/end are ignored, and timed rows drop them', () => {
  // An old client moved the event to Oct 9 and (hypothetically) carried stale dates along.
  const stale = { id: 's', title: 'S', isAllDay: true, type: 1,
    allDayDates: { start: '2026-10-02', end: '2026-10-03' },
    start: '2026-10-09T07:00:00.000Z', end: '2026-10-10T07:00:00.000Z' };
  assert.deepEqual(CalDate.allDayDates(stale), { start: '2026-10-09', end: '2026-10-10' });
  assert.equal(prop(feed([stale]), 'DTSTART'), '20261009');
  assert.equal(new Event({ ...stale, isAllDay: false }).allDayDates, null);
  assert.equal(new Event({ ...stale, allDayDates: { start: 'nope', end: 1 } }).allDayDates, null);
  inTZ('America/Los_Angeles', () => {
    const r = new Calendar('c', 't', [stale]).getSyncFusionEvents()[0];
    // Switched to timed in the grid: no dates.
    assert.equal(new Event({ ...r, IsAllDay: false }).allDayDates, null);
  });
});

test('nativecal: an all-day event written at UTC-11/UTC+14 reads back on its dates', () => {
  for (const tz of ['Pacific/Pago_Pago', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    const stored = inTZ(tz, () => new Event({ id: 'n', title: 'N', isAllDay: true, type: 1,
      ...Event.allDayStoredRange(new Date(2026, 9, 2).getTime(),
        new Date(2026, 9, 3, 23, 59, 59, 999).getTime(), null) }));
    assert.deepEqual(stored.allDayDates, { start: '2026-10-02', end: '2026-10-04' }, tz);
    for (const viewer of ZONES) {
      inTZ(viewer, () => {
        const shown = Event.allDayDisplayRange(stored);
        assert.equal(ymd(shown.start), '2026-10-02', `${tz} -> ${viewer}`);
        assert.equal(ymd(shown.end), '2026-10-03', `${tz} -> ${viewer}`);
        // Shown back unchanged: byte-identical.
        const again = Event.allDayStoredRange(shown.start, shown.end, stored);
        assert.equal(again.start, stored.start);
        assert.equal(again.end, stored.end);
        assert.deepEqual(again.allDayDates, stored.allDayDates);
      });
    }
  }
});

test('all-day series: an occurrence deleted at UTC-11/UTC+14 stays deleted for everyone', (t) => {
  const ej = loadRealEj();
  if (!need(t, ej)) return;
  for (const author of ['Pacific/Pago_Pago', 'Pacific/Kiritimati', 'Asia/Tokyo']) {
    const series = inTZ(author, () => new Event({ Id: 's', Subject: 'Fri', IsAllDay: true,
      StartTime: new Date(2026, 9, 2), EndTime: new Date(2026, 9, 3),
      RecurrenceRule: `FREQ=WEEKLY;BYDAY=FR;INTERVAL=1;UNTIL=${CalDate.utcStamp(new Date(2026, 9, 30))};`,
      // What Syncfusion appends when Oct 16 is deleted: its local midnight, as UTC.
      RecurrenceException: CalDate.utcStamp(new Date(2026, 9, 16)) }));
    assert.equal(series.recurrenceException, '20261016T000000', `stored floating in ${author}`);
    const ics = feed([series]);
    assert.equal(prop(ics, 'EXDATE'), '20261016', `feed, ${author}`);
    assert.match(prop(ics, 'RRULE'), /UNTIL=20261030(;|$)/, `feed UNTIL, ${author}`);
    for (const viewer of ZONES) {
      inTZ(viewer, () => {
        const r = new Calendar('c', 't', [series]).getSyncFusionEvents()[0];
        const days = Array.from(ej.ej.schedule.generate(r.StartTime, r.RecurrenceRule, r.RecurrenceException,
          0, 20, null), d => ymd(new Date(d)));
        assert.deepEqual(days, ['2026-10-02', '2026-10-09', '2026-10-23', '2026-10-30'],
          `${author} -> ${viewer}`);
        // An old tab hands the stored stamps to Syncfusion as-is: same answer.
        const old = Array.from(ej.ej.schedule.generate(new Date(series.start), series.recurrencerule,
          series.recurrenceException, 0, 20, null), d => ymd(new Date(d)));
        if (viewer === author) assert.deepEqual(old, days, `old tab in ${author}`);
      });
    }
  }
});

// ---- nativecal expansion == the grid's ---------------------------------------------------

const SERIES = [
  { id: 'a', title: 'weekly BYDAY', isAllDay: false, start: '2026-09-07T16:30:00.000Z',
    end: '2026-09-07T17:30:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1;COUNT=20;' },
  { id: 'b', title: 'monthly', isAllDay: false, start: '2026-09-15T02:00:00.000Z',
    end: '2026-09-15T03:00:00.000Z', recurrencerule: 'FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=1;' },
  { id: 'b2', title: 'monthly, no BYMONTHDAY', isAllDay: false, start: '2026-09-15T02:00:00.000Z',
    end: '2026-09-15T03:00:00.000Z', recurrencerule: 'FREQ=MONTHLY;INTERVAL=1' },
  { id: 'c', title: 'daily, deletions', isAllDay: false, start: '2026-10-20T18:00:00.000Z',
    end: '2026-10-20T19:00:00.000Z', recurrencerule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20261110T235959Z',
    recurrenceException: '20261025T180000Z,20261102T190000Z' },
  { id: 'd', title: 'all-day weekly', isAllDay: true, start: '2026-10-01T15:00:00.000Z',
    end: '2026-10-02T15:00:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=FR;INTERVAL=1;UNTIL=20261127T150000Z;',
    recurrenceException: '20261015T150000Z,20261030T000000' },
  { id: 'e', title: 'all-day multi-day', isAllDay: true, start: '2026-10-01T07:00:00.000Z',
    end: '2026-10-04T07:00:00.000Z', recurrencerule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=5' },
  { id: 'f', title: 'all-day with dates', isAllDay: true, allDayDates: { start: '2026-10-02', end: '2026-10-03' },
    start: '2026-10-02T11:00:00.000Z', end: '2026-10-03T11:00:00.000Z',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=FR;UNTIL=20261030T000000', recurrenceException: '20261016T000000' },
  { id: 'g', title: 'yearly', isAllDay: false, start: '2026-02-28T20:00:00.000Z',
    end: '2026-02-28T21:00:00.000Z', recurrencerule: 'FREQ=YEARLY;BYMONTHDAY=28;BYMONTH=2;INTERVAL=1' },
  { id: 'h', title: 'weekly across DST', isAllDay: false, start: '2026-10-20T08:30:00.000Z',
    end: '2026-10-20T09:30:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;UNTIL=20261124T083000Z' },
];

// What nativecal/app.js displayEvents hands NativeCalendar.
const display = (e) => (e.isAllDay
  ? { ...e, ...Event.allDayDisplayRange(e), recurrencerule: Event.allDayRuleToLocal(e.recurrencerule) } : e);

test('nativecal: recurrence expands to exactly the grid\'s occurrences, in every zone', (t) => {
  const ej = loadRealEj();
  const rr = loadRealRrule();
  if (!need(t, ej) || !need(t, rr)) return;
  const fmt = (ms) => { const d = new Date(ms); return `${ymd(d)} ${d.getHours()}:${d.getMinutes()}`; };
  for (const tz of ZONES) {
    inTZ(tz, () => {
      const from = new Date(2026, 8, 1), to = new Date(2028, 3, 30);
      for (const row of SERIES) {
        const r = new Calendar('c', 't', [row]).getSyncFusionEvents()[0];
        const grid = Array.from(ej.ej.schedule.generate(r.StartTime, r.RecurrenceRule, r.RecurrenceException,
          0, 200, null)).filter(d => d >= from.getTime() && d <= to.getTime()).map(fmt);
        const shown = Event.expandOccurrences(display(row), from, to, rr.rrule);
        assert.ok(grid.length > 0, `${row.title}: grid has occurrences`);
        assert.deepEqual(Array.from(shown, o => fmt(o.start)), grid, `${row.title} in ${tz}`);
        for (const o of shown) {
          const len = o.end - o.start;
          if (row.isAllDay) assert.equal(ymd(new Date(o.end)) > ymd(new Date(o.start)) || row.id !== 'e', true);
          else assert.equal(len, Date.parse(row.end) - Date.parse(row.start), `${row.title} length`);
        }
      }
    });
  }
});

test('nativecal: a weekly series no longer lands on today\'s weekday at page-load time', (t) => {
  const rr = loadRealRrule();
  if (!need(t, rr)) return;
  inTZ('America/Los_Angeles', () => {
    // Mondays 9:30 local; "today" (whatever it is) must not matter.
    const row = { id: 'w', title: 'W', isAllDay: false, start: new Date(2026, 8, 7, 9, 30).getTime(),
      end: new Date(2026, 8, 7, 10, 30).getTime(), recurrencerule: 'FREQ=WEEKLY;INTERVAL=1' };
    const shown = Event.expandOccurrences(row, new Date(2026, 8, 1), new Date(2026, 9, 1), rr.rrule);
    assert.equal(shown.length, 4);
    for (const o of shown) {
      const d = new Date(o.start);
      assert.deepEqual([d.getDay(), d.getHours(), d.getMinutes()], [1, 9, 30]);
    }
  });
});

test('nativecal: an edited occurrence row is drawn once, not expanded as a second series', () => {
  const src = read('public/nativecal/components/NativeCalendar.js');
  assert.match(src, /event\.recurrenceID/, 'NativeCalendar skips recurrenceID rows');
  assert.match(src, /Event\.expandOccurrences\(/);
  assert.doesNotMatch(src, /rrulestr\(/, 'rrulestr(...).options fills BY* fields from NOW');
});

// ---- UNTIL writes ---------------------------------------------------------------------------

test('timed series: a picked UNTIL is a UTC stamp of local 23:59:59 and keeps the last day', () => {
  for (const tz of ZONES) {
    inTZ(tz, () => {
      const stamp = Event.ruleUntilStamp('2026-10-25', false);
      assert.equal(stamp, CalDate.utcStamp(new Date(2026, 9, 25, 23, 59, 59)), tz);
      assert.equal(Event.ruleUntilDate(`FREQ=DAILY;UNTIL=${stamp}`, false), '2026-10-25', tz);
      // The feed passes a timed rule through: its last occurrence (local 18:00 Oct 25)
      // is before that UNTIL instant.
      assert.ok(new Date(2026, 9, 25, 18).getTime() <= CalDate.toMs(stamp), tz);
    });
  }
});

test('editor: switching a series between all-day and timed keeps its UNTIL date', () => {
  for (const tz of ZONES) {
    inTZ(tz, () => {
      const allDay = 'FREQ=DAILY;UNTIL=20261025T000000';
      const timed = Event.ruleUntilForType(allDay, false, true);
      assert.equal(timed, `FREQ=DAILY;UNTIL=${CalDate.utcStamp(new Date(2026, 9, 25, 23, 59, 59))}`, tz);
      assert.equal(Event.ruleUntilForType(timed, true, false), allDay, tz);
      assert.equal(Event.ruleUntilForType('FREQ=DAILY', false, true), 'FREQ=DAILY');
    });
  }
  const src = read('public/nativecal/components/EventEditor.js');
  assert.match(src, /Event\.ruleUntilForType\(/, 'EventEditor rewrites UNTIL on a type switch');
});

// ---- app.js labels ---------------------------------------------------------------------------

function appMethod(name) {
  const SRC = read('public/app.js');
  const m = new RegExp(`\\n\\s{8}${name}\\(([^)]*)\\)\\s*\\{`).exec(SRC);
  assert.ok(m, name);
  const open = SRC.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return { args: m[1], body: SRC.slice(open + 1, i) };
}

test('app: Recent changes labels and jump-to show an all-day event on its own date', () => {
  const describe = appMethod('describeEventTime');
  const jump = appMethod('jumpToEvent');
  const e = createdIn('Asia/Tokyo');
  for (const tz of ZONES) {
    inTZ(tz, () => {
      const label = new Function('Event', `return function(${describe.args}) {${describe.body}}`)(Event)(e);
      const expected = new Date(2026, 9, 2).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      assert.equal(label, `${expected}, all day`, tz);
      const scheduleObj = {};
      new Function('Event', 'scheduleObj', `return function(${jump.args}) {${jump.body}}`)(Event, scheduleObj)(e);
      assert.equal(ymd(scheduleObj.selectedDate), '2026-10-02', tz);
    });
  }
});
