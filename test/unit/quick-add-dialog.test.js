/**
 * Unit tests for QuickAddDialog's field model (public/components/QuickAddDialog.js).
 *
 * The dialog parses a sentence into Start/End date+time inputs the user can then edit.
 * Those four inputs used to be independent v-models, which produced:
 *
 *   - moving the start date of "lunch tomorrow 2pm for 1 hour" left the parsed end in
 *     place: a 25-hour event, or (moving it later) an end before the start that blocks
 *     Create with no obvious way out;
 *   - clearing the start time silently meant 00:00, so 14:00-15:00 became 00:00-15:00.
 *
 * The event is now START + DURATION: a start edit moves an end the user hasn't touched
 * by the same amount, and an event is either all-day (no time on either end) or timed
 * (a time on both). It also refuses to open or create on a read-only calendar.
 *
 * The component is a plain options object, so it is driven here without Vue: data(),
 * computed getters and bound methods on one object, the same `this` Vue would give it.
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.TZ = 'America/Los_Angeles';

const src = fs.readFileSync(path.join(__dirname, '../../public/components/QuickAddDialog.js'), 'utf8');
const def = new Function('Utils', `${src}; return QuickAddDialog;`)({
  parseHumanWrittenCalendar: () => ({}),
});

function mount({ canEdit = true } = {}) {
  const vm = { canEdit, emitted: [] };
  Object.assign(vm, def.data.call(vm));
  for (const [name, get] of Object.entries(def.computed)) {
    Object.defineProperty(vm, name, { get: get.bind(vm) });
  }
  for (const [name, fn] of Object.entries(def.methods)) vm[name] = fn.bind(vm);
  vm.$el = { querySelector: () => null };
  vm.$nextTick = () => {};
  vm.$emit = (name, payload) => vm.emitted.push([name, payload]);
  return vm;
}

// What the parser would have filled for "lunch tomorrow 2pm for 1 hour" on 2026-10-02.
function lunch(vm) {
  Object.assign(vm.fields, {
    subject: 'lunch', startDate: '2026-10-02', startTime: '14:00', endDate: '2026-10-02', endTime: '15:00',
  });
}

const local = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

test('moving the start date moves the parsed end with it (no 25-hour event)', () => {
  const vm = mount();
  lunch(vm);
  vm.editStart('Date', '2026-10-03');
  assert.equal(vm.fields.endDate, '2026-10-03');
  assert.equal(vm.fields.endTime, '15:00');
  assert.equal(new Date(vm.endDateTime) - new Date(vm.startDateTime), 3600000);
});

test('moving the start date earlier does not leave the end a day late', () => {
  const vm = mount();
  lunch(vm);
  vm.editStart('Date', '2026-10-01');
  assert.equal(local(vm.endDateTime), '2026-10-01 15:00');
  assert.equal(vm.isValidEvent, true);
});

test('moving the start time keeps the length', () => {
  const vm = mount();
  lunch(vm);
  vm.editStart('Time', '16:30');
  assert.equal(vm.fields.endTime, '17:30');
  assert.equal(vm.endBeforeStart, false);
});

test('a hand-edited end stays where the user put it', () => {
  const vm = mount();
  lunch(vm);
  vm.editEnd('Time', '18:00');
  vm.editStart('Time', '15:00');
  assert.equal(vm.fields.endTime, '18:00');
});

test('clearing the start time makes both ends all-day (not 00:00-15:00)', () => {
  const vm = mount();
  lunch(vm);
  vm.editStart('Time', '');
  assert.equal(vm.fields.endTime, '');
  assert.equal(vm.isAllDay, true);
  assert.equal(local(vm.startDateTime), '2026-10-02 00:00');
  assert.equal(local(vm.endDateTime), '2026-10-03 00:00', 'one whole day, end exclusive');
});

test('clearing the end time makes both ends all-day', () => {
  const vm = mount();
  lunch(vm);
  vm.editEnd('Time', '');
  assert.equal(vm.fields.startTime, '');
  assert.equal(vm.isAllDay, true);
});

test('re-typing a cleared time restores the event length', () => {
  const vm = mount();
  lunch(vm);
  vm.editEnd('Time', '16:30'); // 2.5h
  vm.editStart('Time', '');     // backspaced the hour...
  vm.editStart('Time', '10:00'); // ...and typed a new one
  assert.equal(vm.fields.endTime, '12:30');
});

test('giving an all-day event a start time gives the end one too', () => {
  const vm = mount();
  Object.assign(vm.fields, { subject: 'x', startDate: '2026-10-02', endDate: '2026-10-02' });
  vm.editStart('Time', '09:00');
  assert.equal(vm.fields.endTime, '10:00');
  assert.equal(vm.isAllDay, false);
  assert.equal(vm.isValidEvent, true);
});

test('giving an all-day event an end time gives the start one too', () => {
  const vm = mount();
  Object.assign(vm.fields, { subject: 'x', startDate: '2026-10-02', endDate: '2026-10-02' });
  vm.editEnd('Time', '11:00');
  assert.equal(vm.fields.startTime, '10:00');
  assert.equal(vm.endBeforeStart, false);
});

test('moving an all-day span moves its last day by whole days', () => {
  const vm = mount();
  Object.assign(vm.fields, { subject: 'vacation', startDate: '2026-12-11', endDate: '2026-12-15' });
  vm.editStart('Date', '2026-12-20');
  assert.equal(vm.fields.endDate, '2026-12-24');
  assert.equal(vm.isAllDay, true);
});

test('a start move across the DST change keeps the real length', () => {
  const vm = mount();
  Object.assign(vm.fields, {
    subject: 'x', startDate: '2026-10-31', startTime: '23:00', endDate: '2026-11-01', endTime: '01:00',
  });
  const before = new Date(vm.endDateTime) - new Date(vm.startDateTime);
  vm.editStart('Date', '2026-11-01');
  assert.equal(new Date(vm.endDateTime) - new Date(vm.startDateTime), before);
});

// --- Read-only calendars --------------------------------------------------------------

test('showDialog refuses to open on a read-only calendar', () => {
  const vm = mount({ canEdit: false });
  vm.showDialog();
  assert.equal(vm.dialogVisible, false);
  const editable = mount();
  editable.showDialog();
  assert.equal(editable.dialogVisible, true);
});

test('createEvent emits nothing on a read-only calendar', () => {
  const vm = mount({ canEdit: false });
  lunch(vm);
  vm.createEvent();
  assert.deepEqual(vm.emitted, []);
});

test('the dialog no longer registers its own Ctrl/Cmd+E (the app owns the shortcut)', () => {
  const vm = mount({ canEdit: true });
  let prevented = false;
  vm.handleKeydown({ key: 'e', ctrlKey: true, preventDefault: () => { prevented = true; } });
  assert.equal(vm.dialogVisible, false);
  assert.equal(prevented, false);
});

test('both apps pass canEdit to the dialog and gate handleQuickAddEvent', () => {
  for (const [html, js] of [
    ['../../public/index.html', '../../public/app.js'],
    ['../../public/nativecal/index.html', '../../public/nativecal/app.js'],
  ]) {
    const page = fs.readFileSync(path.join(__dirname, html), 'utf8');
    assert.match(page, /<quick-add-dialog[^>]*:can-edit="canEdit"/, `${html} passes canEdit`);
    const app = fs.readFileSync(path.join(__dirname, js), 'utf8');
    const body = app.slice(app.indexOf('handleQuickAddEvent(event) {'));
    assert.match(body.slice(0, 400), /if \(!this\.canEdit\) return;/, `${js} gates the write`);
  }
});
