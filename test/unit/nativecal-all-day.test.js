/**
 * nativecal's all-day boundary (public/nativecal/app.js + Event.allDayDisplayRange /
 * Event.allDayStoredRange).
 *
 * nativecal renders stored events directly, so an all-day event authored in another zone
 * showed a day off. It now maps all-day events at its boundary: stored -> local midnight
 * of the first day through local 23:59:59.999 of the last day (its display shape), read
 * through CalDate.allDayDates. Writes keep nativecal's legacy shape (the writer's local
 * midnight .. local 23:59:59.999 of the last day, epoch ms) so a tab still running the
 * old nativecal, which shows stored values as-is, agrees with a new one in its zone.
 *
 * Covers three stored shapes, read from LA and Tokyo:
 *   - UTC midnight, exclusive end (written briefly by an unreleased build)
 *   - legacy Syncfusion: author's local midnight, exclusive end, ISO string
 *   - legacy nativecal: author's local midnight .. local 23:59:59.999, epoch ms
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '../../public');

function loadEvent() {
  const src = fs.readFileSync(path.join(PUBLIC, 'models/caldate.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8');
  return new Function('Utils', `${src}; return Event;`)({ uuidv4: () => 'generated-uuid' });
}

const Event = loadEvent();

// nativecal/app.js is a browser script that mounts a Vue app at the bottom. Evaluate
// everything above the mount with its component globals stubbed and take the options
// object, so the real displayEvents/toStoredEvent/handleSaveEvent code is what runs.
function loadNativeApp() {
  let src = fs.readFileSync(path.join(PUBLIC, 'nativecal/app.js'), 'utf8');
  src = src.slice(0, src.indexOf('const app = Vue.createApp'));
  const stubs = ['CalendarTitle', 'NavigationDropdown', 'Tooltip', 'ToastNotification',
    'QuickAddButton', 'QuickAddDialog', 'NativeCalendar', 'EventEditor', 'EventPopover',
    'QuickCreatePopover', 'Icon', 'CopyIcon', 'SettingsIcon', 'HelpIcon', 'SearchIcon',
    'ShareIcon', 'NotesIcon', 'ChevronDownIcon', 'CloseIcon', 'clickOutside',
    'AppHeader', 'ClaimDialog', 'SharePanel', 'CalendarFlow'];
  const factory = new Function(...stubs, 'Event', 'window',
    `${src}; return CalendarVueApp;`);
  return factory(...stubs.map((n) => (n === 'CalendarFlow' ? { mixin: {} } : {})), Event, {});
}

const NativeApp = loadNativeApp();

// A minimal component instance: calendar + the real computed/methods bound to it.
function nativeVm(events) {
  const vm = {
    calendar: {
      events,
      setEvents(list) { this.events = list.map(e => new Event(e)); },
    },
    closeEditor() {},
  };
  for (const name of ['toStoredEvent', 'handleEventsUpdate', 'handleSaveEvent']) {
    vm[name] = NativeApp.methods[name].bind(vm);
  }
  Object.defineProperty(vm, 'displayEvents', {
    get: () => NativeApp.computed.displayEvents.call(vm),
  });
  return vm;
}

const ORIGINAL_TZ = process.env.TZ;
function inTZ(tz, fn) {
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  }
}

const local = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

// A two-day event: Oct 2 and Oct 3.
const SHAPES = {
  'new UTC midnight': { start: Date.UTC(2026, 9, 2), end: Date.UTC(2026, 9, 4) },
  'new UTC midnight (ISO)': { start: '2026-10-02T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' },
  'legacy Syncfusion, Tokyo author': { start: '2026-10-01T15:00:00.000Z', end: '2026-10-03T15:00:00.000Z' },
  'legacy Syncfusion, LA author': { start: '2026-10-02T07:00:00.000Z', end: '2026-10-04T07:00:00.000Z' },
  // nativecal's own legacy shape: startOfDay .. endOfDay local, epoch ms.
  'legacy nativecal, Tokyo author': { start: Date.parse('2026-10-01T15:00:00.000Z'), end: Date.parse('2026-10-03T14:59:59.999Z') },
  'legacy nativecal, LA author': { start: Date.parse('2026-10-02T07:00:00.000Z'), end: Date.parse('2026-10-04T06:59:59.999Z') },
};

for (const viewer of ['America/Los_Angeles', 'Asia/Tokyo']) {
  for (const [shape, range] of Object.entries(SHAPES)) {
    test(`nativecal in ${viewer} shows ${shape} on Oct 2-3`, () => inTZ(viewer, () => {
      const vm = nativeVm([{ id: 'a', title: 'Trip', isAllDay: true, type: 1, ...range }]);
      const shown = vm.displayEvents[0];
      assert.equal(local(shown.start), '2026-10-02 00:00:00.000');
      assert.equal(local(shown.end), '2026-10-03 23:59:59.999');
    }));

    test(`nativecal in ${viewer} leaves untouched ${shape} as stored`, () => inTZ(viewer, () => {
      // A drag of some OTHER event re-emits the whole display list.
      const stored = { id: 'a', title: 'Trip', isAllDay: true, type: 1, ...range };
      const vm = nativeVm([stored]);
      vm.handleEventsUpdate(vm.displayEvents);
      assert.equal(vm.calendar.events[0].start, range.start);
      assert.equal(vm.calendar.events[0].end, range.end);
    }));
  }
}

test('nativecal writes a new all-day event in its legacy shape: local midnight .. 23:59:59.999', () => {
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/Berlin', 'Pacific/Auckland']) {
    inTZ(tz, () => {
      const vm = nativeVm([]);
      // What QuickCreatePopover/EventEditor hand over: startOfDay .. endOfDay, local.
      vm.handleSaveEvent({ title: 'Holiday', isAllDay: true, type: 1,
        start: new Date(2026, 9, 2).getTime(), end: new Date(2026, 9, 2, 23, 59, 59, 999).getTime() });
      const e = vm.calendar.events[0];
      assert.equal(e.start, new Date(2026, 9, 2).getTime(), `start written in ${tz}`);
      assert.equal(e.end, new Date(2026, 9, 2, 23, 59, 59, 999).getTime(), `end written in ${tz}`);
      // An old nativecal tab in the same zone (raw stored values) shows exactly this.
      assert.equal(local(e.start), '2026-10-02 00:00:00.000', `old tab start in ${tz}`);
      assert.equal(local(e.end), '2026-10-02 23:59:59.999', `old tab end in ${tz}`);
      const shown = nativeVm([e]).displayEvents[0];
      assert.equal(shown.start, e.start, `new tab agrees in ${tz}`);
      assert.equal(shown.end, e.end, `new tab agrees in ${tz}`);
    });
  }
});

test('nativecal: untouched all-day rows stay byte-identical after another event is dragged', () => {
  // handleEventsUpdate re-emits the whole display list; rows where the per-value date
  // check could not hold (zero-length, UTC+13 legacy single-day) were rewritten.
  const rows = inTZ('Pacific/Auckland', () => [
    { id: 'nz1', title: 'NZ', isAllDay: true, type: 1,
      start: new Date(2026, 9, 20).getTime(), end: new Date(2026, 9, 20, 23, 59, 59, 999).getTime() },
    { id: 'z', title: 'Zero', isAllDay: true, type: 1,
      start: '2026-10-20T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' },
    { id: 'ok', title: 'OK', isAllDay: true, type: 1,
      start: '2026-10-20T00:00:00.000Z', end: '2026-10-21T00:00:00.000Z' },
    { id: 't', title: 'Timed', isAllDay: false, type: 1,
      start: Date.parse('2026-10-20T15:00:00.000Z'), end: Date.parse('2026-10-20T16:00:00.000Z') },
  ]);
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
    inTZ(tz, () => {
      const vm = nativeVm(rows.map(r => ({ ...r })));
      const shown = vm.displayEvents.map(e => ({ ...e }));
      shown[3] = { ...shown[3], start: shown[3].start + 3600000, end: shown[3].end + 3600000 };
      vm.handleEventsUpdate(shown);
      rows.slice(0, 3).forEach((r, i) => {
        assert.equal(vm.calendar.events[i].start, r.start, `${r.id} start in ${tz}`);
        assert.equal(vm.calendar.events[i].end, r.end, `${r.id} end in ${tz}`);
      });
      assert.equal(vm.calendar.events[3].start, rows[3].start + 3600000, 'the dragged row moved');
    });
  }
});

test('nativecal: an event written in Tokyo reads back on the same date in LA', () => {
  const stored = inTZ('Asia/Tokyo', () => {
    const vm = nativeVm([]);
    vm.handleSaveEvent({ title: 'Holiday', isAllDay: true, type: 1,
      start: new Date(2026, 9, 2).getTime(), end: new Date(2026, 9, 2, 23, 59, 59, 999).getTime() });
    return vm.calendar.events[0];
  });
  inTZ('America/Los_Angeles', () => {
    const shown = nativeVm([stored]).displayEvents[0];
    assert.equal(local(shown.start), '2026-10-02 00:00:00.000');
    assert.equal(local(shown.end), '2026-10-02 23:59:59.999');
  });
});

test('nativecal: editing the date of a legacy all-day event writes the editor\'s local form', () => {
  inTZ('America/Los_Angeles', () => {
    const stored = { id: 'a', title: 'Trip', isAllDay: true, type: 1,
      start: '2026-10-01T15:00:00.000Z', end: '2026-10-03T15:00:00.000Z' };
    const vm = nativeVm([stored]);
    vm.handleSaveEvent({ ...vm.displayEvents[0],
      start: new Date(2026, 9, 5).getTime(), end: new Date(2026, 9, 5, 23, 59, 59, 999).getTime() });
    assert.equal(vm.calendar.events[0].start, new Date(2026, 9, 5).getTime());
    assert.equal(vm.calendar.events[0].end, new Date(2026, 9, 5, 23, 59, 59, 999).getTime());
  });
});

test('nativecal: timed events pass through untouched, same object', () => {
  const timed = { id: 't', title: 'Call', isAllDay: false, type: 1,
    start: Date.parse('2026-10-01T15:00:00.000Z'), end: Date.parse('2026-10-01T16:00:00.000Z') };
  const vm = nativeVm([timed]);
  assert.equal(vm.displayEvents[0], timed, 'in-place drags must still reach calendar.events');
});

test('nativecal: an all-day series UNTIL is shown at local midnight of its date, stored as-is', () => {
  // The grid expands with rrule, comparing UNTIL by instant against local-midnight
  // occurrences; a floating "T235959" UNTIL read as UTC added Oct 26 east of UTC.
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
    inTZ(tz, () => {
      for (const rule of ['FREQ=DAILY;UNTIL=20261025T235959', 'FREQ=DAILY;UNTIL=20261025T000000Z']) {
        const stored = { id: 's', title: 'S', isAllDay: true, type: 1, recurrencerule: rule,
          start: new Date(2026, 9, 20).getTime(), end: new Date(2026, 9, 20, 23, 59, 59, 999).getTime() };
        const vm = nativeVm([{ ...stored }]);
        const shown = vm.displayEvents[0];
        // Shown as the floating stamp of Oct 25 (the viewer's local midnight of that date).
        assert.match(shown.recurrencerule, /UNTIL=20261025T000000(;|$)/, `${rule} in ${tz}`);
        vm.handleEventsUpdate(vm.displayEvents);
        assert.equal(vm.calendar.events[0].recurrencerule, rule, `kept verbatim in ${tz}`);
        // An UNTIL changed in the editor is written as the floating stamp of its date.
        vm.handleSaveEvent({ ...vm.displayEvents[0],
          recurrencerule: `FREQ=DAILY;UNTIL=${Event.ruleUntilStamp('2026-10-27', true)}` });
        assert.equal(vm.calendar.events[0].recurrencerule,
          'FREQ=DAILY;UNTIL=20261027T000000', `edited in ${tz}`);
      }
    });
  }
});
