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
