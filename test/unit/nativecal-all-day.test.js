/**
 * nativecal's all-day boundary (public/nativecal/app.js + Event.allDayDisplayRange /
 * Event.allDayStoredRange).
 *
 * nativecal renders stored events directly, so once the legacy app began storing all-day
 * events as UTC midnight of their date (see all-day-timezone.test.js), nativecal would
 * have shown them a day early west of UTC. It now maps all-day events at its boundary:
 * stored -> local midnight of the first day through local 23:59:59.999 of the last day
 * (its display shape), and back to UTC midnight with an exclusive end, epoch ms.
 *
 * Covers three stored shapes, read from LA and Tokyo:
 *   - new:    UTC midnight, exclusive end (both apps write this now)
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
  const src = fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8');
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
    'ShareIcon', 'NotesIcon', 'ChevronDownIcon', 'CloseIcon', 'clickOutside'];
  const factory = new Function(...stubs, 'Event', 'window',
    `${src}; return CalendarVueApp;`);
  return factory(...stubs.map(() => ({})), Event, {});
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

test('nativecal writes a new all-day event as UTC midnight epoch ms, end exclusive', () => {
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland']) {
    inTZ(tz, () => {
      const vm = nativeVm([]);
      // What QuickCreatePopover/EventEditor hand over: startOfDay .. endOfDay, local.
      vm.handleSaveEvent({ title: 'Holiday', isAllDay: true, type: 1,
        start: new Date(2026, 9, 2).getTime(), end: new Date(2026, 9, 2, 23, 59, 59, 999).getTime() });
      const e = vm.calendar.events[0];
      assert.equal(e.start, Date.UTC(2026, 9, 2), `start written in ${tz}`);
      assert.equal(e.end, Date.UTC(2026, 9, 3), `end written in ${tz}`);
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

test('nativecal: editing the date of a legacy all-day event writes the new form', () => {
  inTZ('America/Los_Angeles', () => {
    const stored = { id: 'a', title: 'Trip', isAllDay: true, type: 1,
      start: '2026-10-01T15:00:00.000Z', end: '2026-10-03T15:00:00.000Z' };
    const vm = nativeVm([stored]);
    vm.handleSaveEvent({ ...vm.displayEvents[0],
      start: new Date(2026, 9, 5).getTime(), end: new Date(2026, 9, 5, 23, 59, 59, 999).getTime() });
    assert.equal(vm.calendar.events[0].start, Date.UTC(2026, 9, 5));
    assert.equal(vm.calendar.events[0].end, Date.UTC(2026, 9, 6));
  });
});

test('nativecal: timed events pass through untouched, same object', () => {
  const timed = { id: 't', title: 'Call', isAllDay: false, type: 1,
    start: Date.parse('2026-10-01T15:00:00.000Z'), end: Date.parse('2026-10-01T16:00:00.000Z') };
  const vm = nativeVm([timed]);
  assert.equal(vm.displayEvents[0], timed, 'in-place drags must still reach calendar.events');
});
