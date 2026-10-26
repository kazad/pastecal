/**
 * ROOT 2 guard: the event card's wall-clock math is done in the EVENT's zone, never with local JS Dates (the viewer's).
 *
 * Why: the card held an event's times as Dates whose LOCAL fields read the event's wall clock (EventZone.toWallDate).
 * A local Date cannot hold a time the viewer's zone skips, and its arithmetic bends at the viewer's DST changes:
 *   S01  a Tokyo event at 2:30 AM on the day Los Angeles springs forward read 3:30 - 3:30 AM (0m) to an LA viewer;
 *   S02  the "no such time" check asked the viewer's zone, not the event's;
 *   F13  (fixed before for the viewer's own zone only).
 * Now the card's values are wall clocks in Dates whose UTC fields read them (cardKit.wallDate, EventZone.floating), and
 * whether a time exists, how long an event is and "an hour later" are asked of the event's zone.
 *
 * (a) No file of the card builds a Date from wall parts outside the one helper (cardKit.wallDate), or reads the
 *     viewer's local fields; (b) a table over DST days (US Mar 8 / Nov 1 2026, EU Mar 29 / Oct 25, Tokyo none) x
 *     viewers in Los Angeles, London and Tokyo x event zones (the same three, and none).
 * Run: node --test test/unit/wall-clock.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const EventZone = require('../../public/services/EventZone.js');
const K = require('../../public/nativecal/components/cardKit.js');

const PUB = path.join(__dirname, '../../public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

/** Every `new Date(...)` call in src with its top-level argument count. */
function dateCalls(src) {
  const out = [];
  for (let i = src.indexOf('new Date('); i !== -1; i = src.indexOf('new Date(', i + 1)) {
    let depth = 0, args = 0, j = i + 'new Date'.length, empty = true;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(' || c === '[' || c === '{') { depth++; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; continue; }
      if (depth === 1 && c === ',') args++;
      if (depth >= 1 && !/\s/.test(c)) empty = false;
    }
    const line = src.slice(0, i).split('\n').length;
    out.push({ line, args: empty ? 0 : args + 1, text: src.slice(i, j + 1) });
  }
  return out;
}
const LOCAL = /\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)\(|toDateString\(|toLocaleTimeString\(/;

test('(a) the card builds no local Date from wall parts, and reads no local fields, outside the one helper', () => {
  for (const f of ['nativecal/components/EventCard.js', 'nativecal/components/cardKit.js', 'services/EventZone.js', 'services/CalendarView.js']) {
    const src = read(f);
    for (const c of dateCalls(src)) {
      // new Date(y, m, d, h, ...) reads its parts in the VIEWER's zone: a wall time it skips moves (S01).
      assert.ok(c.args < 4, `${f}:${c.line} builds a Date from wall parts in the viewer's zone: ${c.text} (use cardKit.wallDate / EventZone.fromWall)`);
    }
  }
  // The card itself: no local getters or setters at all (every date and time goes through cardKit's wall helpers).
  const card = read('nativecal/components/EventCard.js').split('\n');
  card.forEach((l, i) => assert.ok(!LOCAL.test(l), `EventCard.js:${i + 1} reads the viewer's local fields: ${l.trim()}`));
  // cardKit: only untilDay reads local fields (a repeat's UNTIL is classic's: the VIEWER's date of a stamp), and only
  // buildRule builds a local midnight (the same UNTIL, written).
  const kit = read('nativecal/components/cardKit.js').split('\n');
  kit.forEach((l, i) => {
    if (/const untilDay = /.test(l)) return;
    assert.ok(!LOCAL.test(l), `cardKit.js:${i + 1} reads the viewer's local fields: ${l.trim()}`);
  });
  // EventZone: the local-fields frame is gone (toWallDate/fromWallDate).
  assert.equal(EventZone.toWallDate, undefined);
  assert.equal(EventZone.fromWallDate, undefined);
  read('services/EventZone.js').split('\n').forEach((l, i) => assert.ok(!LOCAL.test(l), `EventZone.js:${i + 1}: ${l.trim()}`));
  // The app's card code: no toWallDate left anywhere.
  assert.ok(!/toWallDate|fromWallDate/.test(read('app.js')), 'app.js still uses the local-fields wall frame');
});

// ---- (b) the DST table -------------------------------------------------------------------------------------------
const VIEWERS = ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'];
const ZONES = ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', ''];   // '' = the event has none: the viewer's
const DAYS = { 'US spring (Mar 8)': [2026, 2, 8], 'US fall (Nov 1)': [2026, 10, 1], 'EU spring (Mar 29)': [2026, 2, 29], 'EU fall (Oct 25)': [2026, 9, 25] };
// The clock times (minutes) each zone skips on each day: ground truth, written out.
const GAPS = {
  'America/Los_Angeles': { 'US spring (Mar 8)': [120, 135, 150, 165] },
  'Europe/London': { 'EU spring (Mar 29)': [60, 75, 90, 105] },
  'Asia/Tokyo': {},
};
const ORIGINAL_TZ = process.env.TZ;
function inTZ(tz, fn) {
  process.env.TZ = tz;
  try { return fn(); } finally { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; }
}
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

for (const viewer of VIEWERS) {
  test(`(b) viewer in ${viewer}: every event zone, every DST day -- the times offered, read, lengths, an hour later`, () => inTZ(viewer, () => {
    assert.equal(EventZone.localZone(), viewer);
    for (const ez of ZONES) {
      const zone = K.zoneOf({ tz: ez, isAllDay: false });
      assert.equal(zone, ez || viewer);
      for (const [name, [y, mo, d]] of Object.entries(DAYS)) {
        const where = `${ez || 'no zone'} on ${name}, viewed from ${viewer}`;
        const day = K.wallDate(y, mo, d);
        // The times offered are exactly the ones the EVENT's zone has that day (S02: not the viewer's).
        const skipped = (GAPS[zone] || {})[name] || [];
        const all = Array.from({ length: 96 }, (_, i) => i * 15);
        assert.deepEqual(K.dayTimes(day, zone), all.filter((m) => !skipped.includes(m)), where);
        for (const m of skipped) assert.equal(K.endAt(K.at(day, 0), K.at(day, 30), m, zone), null, `${where}: ${hm(m)} is refused as an end`);
        for (const m of K.dayTimes(day, zone)) {
          // A time picked or typed means that wall time in the EVENT's zone, and the card reads it back as typed (S01).
          const real = K.instantOf(K.at(day, m), zone);
          const back = EventZone.wall(real.getTime(), zone);
          assert.deepEqual([back.d, back.h * 60 + back.min], [d, m], `${where}: ${hm(m)} -> ${real.toISOString()}`);
          assert.equal(K.minutesOf(K.wallOf(real, zone)), m, `${where}: ${hm(m)} reads back`);
        }
        // Every instant of the day (both 1:30s of a fall-back) reads as the zone's own clock says, and an hour later
        // (the card measures lengths on instants) reads an hour of the zone's clock later -- never the viewer's.
        const from = K.instantOf(day, zone).getTime();
        for (let t = from; t < from + 26 * 3600000; t += 15 * 60000) {
          const w = K.wallOf(t, zone), truth = EventZone.wall(t, zone);
          assert.deepEqual([w.getUTCDate(), K.minutesOf(w)], [truth.d, truth.h * 60 + truth.min], `${where}: ${new Date(t).toISOString()}`);
        }
      }
    }
  }));
}

test('S01: a Tokyo event at 2:30 AM on Los Angeles\' spring-forward day reads 2:30 - 3:30 AM, 1h, to an LA viewer', () => inTZ('America/Los_Angeles', () => {
  const z = K.zoneOf({ tz: 'Asia/Tokyo', isAllDay: false });
  const start = new Date('2026-03-07T17:30:00Z'), end = new Date('2026-03-07T18:30:00Z');
  const s = K.wallOf(start, z), e = K.wallOf(end, z);
  assert.deepEqual([K.fmtTime(s, '12'), K.fmtTime(e, '12'), K.fmtLen((end - start) / 60000)], ['2:30 AM', '3:30 AM', '1h']);
  assert.equal(K.exists(s, z), true);
  // The wall time maps back to the same instant: a length change (instants) keeps the start.
  assert.equal(K.instantOf(s, z).toISOString(), start.toISOString());
}));

test('S02: viewed from Tokyo, an LA event on LA\'s spring-forward day is not offered 2:00-2:45 AM, and "2:30a" is refused', () => inTZ('Asia/Tokyo', () => {
  const z = K.zoneOf({ tz: 'America/Los_Angeles', isAllDay: false });
  const s = K.wallOf('2026-03-08T09:00:00Z', z), e = K.wallOf('2026-03-08T09:30:00Z', z);
  assert.equal(K.fmtTime(s, '12'), '1:00 AM');
  assert.deepEqual(K.dayTimes(s, z).filter((m) => m >= 120 && m < 180), []);
  assert.equal(K.exists(K.at(s, 150), z), false);
  assert.equal(K.endAt(s, e, 150, z), null);
}));

test('S05: an end is read against the start -- 11 PM to midnight, "11:30p" ends 11:30 PM that day; "1a" the next day', () => {
  for (const viewer of VIEWERS) inTZ(viewer, () => {
    for (const ez of ZONES) {
      const z = K.zoneOf({ tz: ez, isAllDay: false });
      const s = K.wallDate(2026, 9, 27, 23, 0), e = K.wallDate(2026, 9, 28, 0, 0);
      assert.equal(K.endsOnStartDay(s, e), true);
      assert.deepEqual(K.dateStr(K.endAt(s, e, 23 * 60 + 30, z)) + ' ' + K.fmtTime(K.endAt(s, e, 23 * 60 + 30, z), '24'), '2026-10-27 23:30', `${viewer} ${ez}`);
      assert.equal(K.dateStr(K.endAt(s, e, 60, z)) + ' ' + K.fmtTime(K.endAt(s, e, 60, z), '24'), '2026-10-28 01:00');
      assert.equal(K.endAt(s, e, 23 * 60, z), null, 'the start\'s own time');
      assert.equal(K.dateStr(K.endAt(s, e, 1440, z)) + ' ' + K.fmtTime(K.endAt(s, e, 1440, z), '24'), '2026-10-28 00:00', 'midnight');
      // A two-day event: the end's own date.
      const e2 = K.wallDate(2026, 9, 29, 10, 0);
      assert.equal(K.dateStr(K.endAt(s, e2, 9 * 60, z)), '2026-10-29');
    }
  });
});
