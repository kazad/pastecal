/**
 * nativecal grid layout (public/nativecal/components/NativeCalendar.js, NativeCalLayout).
 *
 * The pure functions that decide where an event is drawn:
 *   - layoutTimedDay: overlapping timed events side by side (they used to draw on top of
 *     each other, every box 80% of a 1/N column whatever the overlap)
 *   - layoutBars: multi-day events as one bar per week row, lanes, "+N more"
 *     (they used to show on their first day only, and a busy day grew without bound)
 *   - buildDayIndex: day -> events, built once (the grid used to scan every event for
 *     every cell on every render -- 5,000 events took 3.2s to paint a month)
 *   - formatTime / formatRange: no leading zeros, en-dash ranges
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '../../public');

function loadLayout() {
  const src = fs.readFileSync(path.join(PUBLIC, 'nativecal/components/NativeCalendar.js'), 'utf8');
  const caldate = fs.readFileSync(path.join(PUBLIC, 'models/caldate.js'), 'utf8');
  const eventSrc = fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8');
  const Event = new Function('Utils', `${caldate}\n${eventSrc}; return Event;`)({ uuidv4: () => 'id' });
  const L = new Function('window', `${src}; return NativeCalLayout;`)({});
  return { L, Event };
}

const { L, Event } = loadLayout();
const H = 3600 * 1000;
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// An all-day event as the grid receives it (app.js displayEvents -> Event.allDayDisplayRange).
const allDay = (id, y, m, d, days = 1) => ({ id, isAllDay: true, start: at(y, m, d), end: at(y, m, d + days) - 1 });
const timed = (id, s, e) => ({ id, start: s, end: e });

// ---------------------------------------------------------------- layoutTimedDay

function pack(events, minDuration) {
  const out = L.layoutTimedDay(events.map((e) => ({ ...e })), minDuration);
  return Object.fromEntries(out.map((p) => [p.item.id, p]));
}

test('a lone event takes the whole column', () => {
  const p = pack([timed('a', at(2026, 10, 5, 9), at(2026, 10, 5, 10))]);
  assert.equal(p.a.left, 0);
  assert.equal(p.a.width, 1);
});

test('two overlapping events sit side by side, half width each', () => {
  const p = pack([
    timed('a', at(2026, 10, 5, 9), at(2026, 10, 5, 10)),
    timed('b', at(2026, 10, 5, 9, 30), at(2026, 10, 5, 11)),
  ]);
  assert.deepEqual([p.a.left, p.a.width, p.b.left, p.b.width], [0, 0.5, 0.5, 0.5]);
});

test('identical times never stack on top of each other', () => {
  const evs = ['a', 'b', 'c'].map((id) => timed(id, at(2026, 10, 5, 9), at(2026, 10, 5, 10)));
  const p = pack(evs);
  const lefts = Object.values(p).map((x) => x.left).sort();
  assert.deepEqual(lefts, [0, 1 / 3, 2 / 3]);
  for (const x of Object.values(p)) assert.equal(x.width, 1 / 3);
});

test('back-to-back events are not "overlapping"', () => {
  const p = pack([
    timed('a', at(2026, 10, 5, 9), at(2026, 10, 5, 10)),
    timed('b', at(2026, 10, 5, 10), at(2026, 10, 5, 11)),
  ]);
  assert.equal(p.a.width, 1);
  assert.equal(p.b.width, 1);
});

test('separate clusters get their own column counts', () => {
  const p = pack([
    timed('a', at(2026, 10, 5, 9), at(2026, 10, 5, 10)),
    timed('b', at(2026, 10, 5, 9), at(2026, 10, 5, 10)),
    timed('c', at(2026, 10, 5, 14), at(2026, 10, 5, 15)),
  ]);
  assert.equal(p.a.cols, 2);
  assert.equal(p.c.cols, 1);
  assert.equal(p.c.width, 1);
});

test('an event expands right over columns that are free for its whole span', () => {
  // a 9-12 long; b 9-10 and c 10-11 share column 1; d 9-9:30 forces a third column at the
  // start. c (10-11) then has column 2 free -> spans 2 columns.
  const p = pack([
    timed('a', at(2026, 10, 5, 9), at(2026, 10, 5, 12)),
    timed('b', at(2026, 10, 5, 9), at(2026, 10, 5, 10)),
    timed('d', at(2026, 10, 5, 9), at(2026, 10, 5, 9, 30)),
    timed('c', at(2026, 10, 5, 10), at(2026, 10, 5, 11)),
  ]);
  assert.equal(p.a.cols, 3);
  assert.equal(p.c.col, 1);
  assert.equal(p.c.span, 2);
  assert.equal(p.c.width, 2 / 3);
  assert.equal(p.d.span, 1);
  // No two boxes overlap on screen.
  const boxes = Object.values(p);
  for (const x of boxes) for (const y of boxes) {
    if (x === y) continue;
    const timeOverlap = x.item.start < y.item.end && y.item.start < x.item.end;
    const colOverlap = x.left < y.left + y.width - 1e-9 && y.left < x.left + x.width - 1e-9;
    assert.ok(!(timeOverlap && colOverlap), `${x.item.id} and ${y.item.id} overlap`);
  }
});

test('short events overlap by their DRAWN height (minDuration)', () => {
  const evs = [
    timed('a', at(2026, 10, 5, 9), at(2026, 10, 5, 9, 5)),
    timed('b', at(2026, 10, 5, 9, 10), at(2026, 10, 5, 9, 15)),
  ];
  assert.equal(pack(evs).a.width, 1, 'without a minimum they do not overlap');
  assert.equal(pack(evs, 25 * 60000).a.width, 0.5, 'drawn 25 minutes tall they do');
});

test('packing a hostile day (200 events at once) stays linear-ish and bounded', () => {
  const evs = Array.from({ length: 200 }, (_, i) => timed('e' + i, at(2026, 10, 5, 9), at(2026, 10, 5, 10)));
  const t0 = Date.now();
  const out = L.layoutTimedDay(evs, 0);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(out.length, 200);
  assert.equal(out[0].cols, 200);
});

// ---------------------------------------------------------------- layoutBars

const SUN = at(2026, 10, 4); // Sunday Oct 4 2026

test('a multi-day all-day event is one bar spanning its days', () => {
  const r = L.layoutBars([allDay('trip', 2026, 10, 6, 3)], SUN, 7, 3);
  assert.equal(r.bars.length, 1);
  assert.deepEqual([r.bars[0].startCol, r.bars[0].span], [2, 3]); // Tue..Thu
  assert.equal(r.bars[0].continuesBefore, false);
  assert.equal(r.bars[0].continuesAfter, false);
});

test('a bar crossing the week boundary is clipped and marked as continuing', () => {
  const ev = allDay('trip', 2026, 10, 9, 4); // Fri Oct 9 .. Mon Oct 12
  const w1 = L.layoutBars([ev], SUN, 7, 3).bars[0];
  const w2 = L.layoutBars([ev], at(2026, 10, 11), 7, 3).bars[0];
  assert.deepEqual([w1.startCol, w1.span, w1.continuesAfter], [5, 2, true]);
  assert.deepEqual([w2.startCol, w2.span, w2.continuesBefore], [0, 2, true]);
});

test('every all-day stored shape lands on the same days (via Event.allDayDisplayRange)', () => {
  // Stored by Syncfusion (exclusive local-midnight end, ISO) and by nativecal (inclusive
  // 23:59:59.999, epoch). Through the app's display mapping both cover Oct 6-7 only.
  const sf = { id: 'sf', isAllDay: true, start: new Date(2026, 9, 6).toISOString(), end: new Date(2026, 9, 8).toISOString() };
  const nc = { id: 'nc', isAllDay: true, start: at(2026, 10, 6), end: at(2026, 10, 8) - 1 };
  for (const stored of [sf, nc]) {
    const shown = { ...stored, ...Event.allDayDisplayRange(stored) };
    const bar = L.layoutBars([shown], SUN, 7, 3).bars[0];
    assert.deepEqual([bar.startCol, bar.span], [2, 2], stored.id);
  }
});

test('a timed event ending exactly at midnight does not spill into the next day', () => {
  const ev = timed('late', at(2026, 10, 6, 22), at(2026, 10, 7));
  const bar = L.layoutBars([ev], SUN, 7, 3).bars[0];
  assert.deepEqual([bar.startCol, bar.span], [2, 1]);
  const idx = L.buildDayIndex([ev], SUN, at(2026, 10, 11));
  assert.deepEqual([...idx.keys()], ['2026-10-06']);
});

test('an overnight timed event covers both days', () => {
  const ev = timed('red-eye', at(2026, 10, 6, 22), at(2026, 10, 7, 2));
  const bar = L.layoutBars([ev], SUN, 7, 3).bars[0];
  assert.deepEqual([bar.startCol, bar.span], [2, 2]);
});

test('lanes: spans first, no two bars share a lane on the same day', () => {
  const evs = [
    timed('t1', at(2026, 10, 6, 9), at(2026, 10, 6, 10)),
    allDay('span', 2026, 10, 5, 4),
    allDay('one', 2026, 10, 6),
  ];
  const { bars } = L.layoutBars(evs, SUN, 7, 5);
  const byId = Object.fromEntries(bars.map((b) => [b.event.id, b]));
  assert.equal(byId.span.lane, 0);
  const lanesOnTue = bars.filter((b) => b.startCol <= 2 && b.startCol + b.span > 2).map((b) => b.lane);
  assert.equal(new Set(lanesOnTue).size, lanesOnTue.length);
  assert.ok(byId.one.lane < byId.t1.lane, 'all-day before timed');
});

test('"+N more": a day with more than fits keeps its last lane for the label', () => {
  const evs = Array.from({ length: 6 }, (_, i) => timed('e' + i, at(2026, 10, 6, 8 + i), at(2026, 10, 6, 9 + i)));
  const r = L.layoutBars(evs, SUN, 7, 3);
  assert.equal(r.bars.length, 2, 'two shown + the "+N more" lane');
  assert.equal(r.more[2], 4);
  assert.equal(r.bars.length + r.more[2], 6, 'nothing lost');
  assert.ok(r.bars.every((b) => b.lane < 2));
});

test('"+N more": a day that exactly fits shows everything', () => {
  const evs = Array.from({ length: 3 }, (_, i) => timed('e' + i, at(2026, 10, 6, 8 + i), at(2026, 10, 6, 9 + i)));
  const r = L.layoutBars(evs, SUN, 7, 3);
  assert.equal(r.bars.length, 3);
  assert.deepEqual(r.more, [0, 0, 0, 0, 0, 0, 0]);
});

test('"+N more": a span in the label lane is hidden on every day and counted', () => {
  // Mon has 2 spans (lanes 0,1) and the 3-day span lands in lane 2 = label lane; Tue
  // overflows, so the span must hide and be counted on Mon, Tue and Wed.
  const evs = [
    allDay('s0', 2026, 10, 5, 3), allDay('s1', 2026, 10, 5, 3), allDay('s2', 2026, 10, 5, 3),
    timed('x', at(2026, 10, 6, 9), at(2026, 10, 6, 10)),
  ];
  const r = L.layoutBars(evs, SUN, 7, 3);
  const ids = r.bars.map((b) => b.event.id).sort();
  assert.deepEqual(ids, ['s0', 's1']);
  assert.deepEqual(r.more.slice(1, 4), [1, 2, 1]);
  // Every visible bar is below the label lane wherever a label is shown.
  for (const b of r.bars) for (let c = b.startCol; c < b.startCol + b.span; c++) {
    if (r.more[c] > 0) assert.ok(b.lane < 2);
  }
});

test('the label lane is free on every day that shows a label (randomised)', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let round = 0; round < 200; round++) {
    const evs = Array.from({ length: Math.floor(rnd() * 14) }, (_, i) => {
      const d = 3 + Math.floor(rnd() * 9);
      return rnd() < 0.5 ? allDay('a' + i, 2026, 10, d, 1 + Math.floor(rnd() * 4))
        : timed('t' + i, at(2026, 10, d, 9), at(2026, 10, d, 10));
    });
    const lanes = 1 + Math.floor(rnd() * 4);
    const r = L.layoutBars(evs, SUN, 7, lanes);
    for (let c = 0; c < 7; c++) {
      const on = r.bars.filter((b) => c >= b.startCol && c < b.startCol + b.span);
      assert.equal(new Set(on.map((b) => b.lane)).size, on.length, 'lane collision');
      assert.ok(on.every((b) => b.lane < lanes));
      if (r.more[c] > 0) assert.ok(on.every((b) => b.lane < lanes - 1), `label collides, round ${round} day ${c}`);
      const total = L.buildDayIndex(evs, SUN, at(2026, 10, 11)).get(L.dayKey(L.addDays(SUN, c)))?.length || 0;
      assert.equal(on.length + r.more[c], total, `day ${c} shows or counts every event`);
    }
  }
});

// ---------------------------------------------------------------- buildDayIndex

test('day index: events outside the range are skipped, multi-day ones listed on each day', () => {
  const evs = [
    allDay('in', 2026, 10, 6, 2),
    timed('out', at(2026, 12, 1, 9), at(2026, 12, 1, 10)),
    allDay('edge', 2026, 9, 30, 6), // Sep 30 .. Oct 5, clipped to the range start
  ];
  const idx = L.buildDayIndex(evs, SUN, at(2026, 10, 11));
  assert.deepEqual(idx.get('2026-10-06').map((e) => e.id).sort(), ['in']);
  assert.deepEqual(idx.get('2026-10-07').map((e) => e.id), ['in']);
  assert.deepEqual(idx.get('2026-10-04').map((e) => e.id), ['edge']);
  assert.equal(idx.get('2026-10-03'), undefined);
  assert.ok(![...idx.values()].flat().some((e) => e.id === 'out'));
});

test('day index: hostile rows are skipped, not thrown on', () => {
  const evs = [null, 7, 'x', {}, { start: 'nope' }, { start: {} }, { id: 'neg', start: at(2026, 10, 6, 10), end: at(2026, 10, 6, 9) },
    { id: 'iso', start: new Date(2026, 9, 6, 9).toISOString(), end: new Date(2026, 9, 6, 10).toISOString() }];
  const idx = L.buildDayIndex(evs, SUN, at(2026, 10, 11));
  assert.deepEqual(idx.get('2026-10-06').map((e) => e.id).sort(), ['iso', 'neg']);
  // start > end collapses to a point, never a negative box
  assert.deepEqual(L.eventRange(evs[6]), { start: at(2026, 10, 6, 10), end: at(2026, 10, 6, 10) });
});

test('day index + month layout for 5,000 events stays fast (perf regression)', () => {
  // Month grid range: 6 weeks. Events spread over two years, ~1/16 of them in range.
  const evs = [];
  for (let i = 0; i < 5000; i++) {
    const day = i % 730;
    evs.push(timed('e' + i, at(2026, 1, 1 + day, 8 + (i % 10)), at(2026, 1, 1 + day, 9 + (i % 10))));
  }
  const gridStart = at(2026, 9, 27);
  const t0 = process.hrtime.bigint();
  let shown = 0;
  for (let rep = 0; rep < 10; rep++) {
    const idx = L.buildDayIndex(evs, gridStart, L.addDays(gridStart, 42));
    shown = 0;
    for (let w = 0; w < 6; w++) {
      const rowStart = L.addDays(gridStart, w * 7);
      const cands = [];
      for (let c = 0; c < 7; c++) cands.push(...(idx.get(L.dayKey(L.addDays(rowStart, c))) || []));
      const r = L.layoutBars(cands, rowStart, 7, 4);
      shown += r.bars.length;
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
  assert.ok(ms < 60, `month layout of 5,000 events took ${ms.toFixed(1)}ms`);
  assert.ok(shown <= 6 * 7 * 4, `drawn bars capped by lanes (${shown})`);
});

// ---------------------------------------------------------------- formatting

test('times: no leading zeros, compact on the hour', () => {
  assert.equal(L.formatTime(at(2026, 10, 6, 9), '12'), '9:00 AM');
  assert.equal(L.formatTime(at(2026, 10, 6, 9), '12', { compact: true }), '9 AM');
  assert.equal(L.formatTime(at(2026, 10, 6, 0, 30), '12', { compact: true }), '12:30 AM');
  assert.equal(L.formatTime(at(2026, 10, 6, 12), '12', { compact: true }), '12 PM');
  assert.equal(L.formatTime(at(2026, 10, 6, 9, 5), '24'), '9:05');
  assert.equal(L.formatTime(at(2026, 10, 6, 17, 30), '24'), '17:30');
  assert.equal(L.formatTime(NaN, '12'), '');
});

test('ranges use an en dash and drop a repeated AM/PM', () => {
  assert.equal(L.formatRange(at(2026, 10, 6, 9), at(2026, 10, 6, 10, 30), '12'), '9 – 10:30 AM');
  assert.equal(L.formatRange(at(2026, 10, 6, 11), at(2026, 10, 6, 13), '12'), '11 AM – 1 PM');
  assert.equal(L.formatRange(at(2026, 10, 6, 9), at(2026, 10, 6, 17, 30), '24'), '9:00 – 17:30');
  assert.equal(L.formatRange(at(2026, 10, 6, 9), at(2026, 10, 6, 9), '12'), '9 AM');
});

test('colours and titles survive hostile values', () => {
  for (const t of [undefined, 0, -3, 1e9, 'x', 2.7, null]) assert.match(L.colorFor(t), /^#[0-9a-f]{6}$/);
  assert.equal(L.colorFor(2), L.COLORS[1]);
  assert.equal(L.titleOf({ title: { evil: 1 } }), '(No title)');
  assert.equal(L.titleOf({ title: '  ' }), '(No title)');
  assert.equal(L.titleOf({ title: 42 }), '42');
});

// ---------------------------------------------------------------- isBar

test('all-day and day-long events are bars; shorter overnight ones are boxes', () => {
  assert.equal(L.isBar(allDay('a', 2026, 10, 6)), true);
  assert.equal(L.isBar(timed('x', at(2026, 10, 6, 9), at(2026, 10, 7, 9))), true);
  assert.equal(L.isBar(timed('y', at(2026, 10, 6, 22), at(2026, 10, 7, 2))), false);
  assert.ok(H > 0);
});
