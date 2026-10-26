/**
 * Stress findings in the native event card's pure helpers (public/nativecal/components/cardKit.js), from the editor
 * stress test (cloudflare/test/editor-stress.spec.js has the browser half). Each `todo` test is a finding that still
 * reproduces: it asserts what a person expects and is reported, not failed, until the helper is fixed (then drop the
 * `todo` and it guards the fix). The plain tests pin behavior the stress test checked and found right.
 * Run: node --test test/unit/editor-stress.test.js
 */
process.env.TZ = 'America/Los_Angeles';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../public/nativecal/components/cardKit.js');

const SAT = new Date(2026, 9, 24);   // Saturday Oct 24 2026, "today" in the stress test
const hm = (m) => m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const ymd = (d) => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const smart = (t) => { const r = K.smartParse(t, SAT); return r && { title: t.slice(0, r.at).trim(), day: ymd(r.day), start: hm(r.start), end: hm(r.end) }; };

// F07: a new event titled with a day name at its end moves to that day and loses the word on save.
test('F07 titles that end in a day name are titles: "Black Friday", "Cyber Monday", "Super Bowl Sunday", "Here comes the sun"', { todo: 'F07 smartParse reads a trailing day name as a date' }, () => {
  for (const t of ['Black Friday', 'Cyber Monday', 'Super Bowl Sunday', 'Here comes the sun']) assert.equal(smart(t), null, t);
});

// F08: an end past midnight ("9pm-1am") is clamped to one hour (or to midnight), not read as the next day.
test('F08 a time range that crosses midnight keeps its end: "Party 9pm-1am", "Night shift 10p-6a", "Train 23:30-0:30"', { todo: 'F08 smartParse clamps ends past midnight' }, () => {
  assert.deepEqual(smart('Party 9pm-1am'), { title: 'Party', day: null, start: '21:00', end: '25:00' });
  assert.deepEqual(smart('Night shift 10p-6a'), { title: 'Night shift', day: null, start: '22:00', end: '30:00' });
  assert.deepEqual(smart('Train 23:30-0:30'), { title: 'Train', day: null, start: '23:30', end: '24:30' });
});

// F09: a chapter-and-verse or room code that happens to look like a time moves the event and is cut from the title.
test('F09 "John 3:16" and "Room 4a" are titles, not 3:16 PM and 4 AM', { todo: 'F09 smartParse takes any trailing h:mm or Na as a time' }, () => {
  assert.equal(smart('Bible study John 3:16'), null);
  assert.equal(smart('Room 4a'), null);
});

// F10: typing today's weekday ("Mass Sat 5:30" on a Saturday) puts the event a week out, not today.
test('F10 a day word naming today is today (Saturday: "Mass Sat 5:30" is today at 5:30 PM)', { todo: 'F10 smartParse/parseDate skip today for a weekday name' }, () => {
  assert.deepEqual(smart('Mass Sat 5:30'), { title: 'Mass', day: '2026-10-24', start: '17:30', end: null });
});

// F12 (broken; the journey is in editor-stress.spec.js): a month and day typed into the date picker never means a past date next year.
test('F12 "jan 5" typed in late October means the coming January', { todo: 'F12 parseDate takes the shown year even when the date has passed' }, () => {
  assert.equal(ymd(K.parseDate('jan 5', SAT, new Date(2026, 9, 1))), '2027-01-05');
});

// F20 (nit): a day-first date ("13/10", what a Monday-first, 24-hour, European user types) is refused.
test('F20 a day-first date that cannot be month-first ("13/10") is Oct 13', { todo: 'F20 parseDate reads only M/D' }, () => {
  assert.equal(ymd(K.parseDate('13/10', SAT)), '2026-10-13');
});

// F21 (nit): a daily rule limited to some weekdays (from an import) is described as every day.
test('F21 "FREQ=DAILY;BYDAY=MO,WE" is not "Every day"', { todo: 'F21 describeRule ignores BYDAY on a daily rule' }, () => {
  assert.notEqual(K.describeRule('FREQ=DAILY;BYDAY=MO,WE;INTERVAL=1;', SAT), 'Every day');
});

// F18 (nit) [repeat]: "Every Sun, Mon, Thu, 1 times" (seen in the card after Custom... "After 1 times").
test('F18 a repeat that happens once says so, not "1 times"', { todo: 'F18 describeRule pluralizes COUNT=1' }, () => {
  assert.doesNotMatch(K.describeRule('FREQ=WEEKLY;BYDAY=SA;INTERVAL=1;COUNT=1;', SAT), /\b1 times\b/);
});

// What the stress test checked and found right.
test('smart titles that work: "lunch fri 12-1", "standup 9am", "Practice 5:30", "Meeting 10.30" stays a title, "Shift 22-6" stays a title', () => {
  assert.deepEqual(smart('lunch fri 12-1'), { title: 'lunch', day: '2026-10-30', start: '12:00', end: '13:00' });
  assert.deepEqual(smart('standup 9am'), { title: 'standup', day: null, start: '09:00', end: null });
  assert.deepEqual(smart('Practice 5:30'), { title: 'Practice', day: null, start: '17:30', end: null });
  for (const t of ['Meeting 10.30', 'Shift 22-6', 'Apollo 13', 'Game 7-9', 'Mon']) assert.equal(smart(t), null, t);
});

test('repeat limits clamp rather than store nonsense: interval and count 0 become 1, 5000 becomes 999, day 31 stays 31', () => {
  const s = K.parseRule('', SAT);
  assert.equal(K.buildRule({ ...s, freq: 'DAILY', interval: 0, endMode: 'count', count: 0 }), 'FREQ=DAILY;INTERVAL=1;COUNT=1;');
  assert.equal(K.buildRule({ ...s, freq: 'MONTHLY', interval: 5000, monthMode: 'day', monthDay: 31 }), 'FREQ=MONTHLY;BYMONTHDAY=31;INTERVAL=999;');
});
