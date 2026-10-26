/**
 * Stress findings in the native event card's pure helpers (public/nativecal/components/cardKit.js), from the editor
 * stress test (cloudflare/test/editor-stress.spec.js has the browser half). Each F<n> test was a finding, now fixed; it
 * asserts what a person expects and guards the fix. The rest pin behavior the stress test checked and found right.
 * Run: node --test test/unit/editor-stress.test.js
 */
process.env.TZ = 'America/Los_Angeles';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../public/nativecal/components/cardKit.js');

const SAT = new Date(2026, 9, 24);   // Saturday Oct 24 2026, "today" in the stress test
const ymd = (d) => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// F07-F10 (titles read as times) are gone with the card's smart titles: a title is saved exactly as typed and the event
// stays where it was made (the browser half, editor-stress.spec.js F07-F10, checks each title).

// F12 (the journey is in editor-stress.spec.js): a month and day typed into the date picker is the nearest such date, not one nine months ago.
test('F12 "jan 5" typed in late October means the coming January', () => {
  assert.equal(ymd(K.parseDate('jan 5', SAT, new Date(2026, 9, 1))), '2027-01-05');
  assert.equal(ymd(K.parseDate('1/5', SAT, new Date(2026, 9, 1))), '2027-01-05');
  assert.equal(ymd(K.parseDate('oct 20', SAT)), '2026-10-20', 'a date just past stays this year');
});

// F20: a day-first date ("13/10", what a Monday-first, 24-hour, European user types) is read when it can only be day-first.
test('F20 a day-first date that cannot be month-first ("13/10") is Oct 13', () => {
  assert.equal(ymd(K.parseDate('13/10', SAT)), '2026-10-13');
  assert.equal(ymd(K.parseDate('10/13', SAT)), '2026-10-13', 'month-first still comes first');
  assert.equal(K.parseDate('13/13', SAT), null);
});

// F21: a daily rule limited to some weekdays (from an import) names its days.
test('F21 "FREQ=DAILY;BYDAY=MO,WE" is "Every Mon and Wed", not "Every day"', () => {
  assert.notEqual(K.describeRule('FREQ=DAILY;BYDAY=MO,WE;INTERVAL=1;', SAT), 'Every day');
  assert.equal(K.describeRule('FREQ=DAILY;BYDAY=MO,WE;INTERVAL=1;', SAT), 'Every Mon and Wed');
  assert.equal(K.describeRule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=1;', SAT), 'Every weekday');
});

// F18 [repeat]: once is "1 time" (was "Every Sun, Mon, Thu, 1 times" after Custom... "After 1").
test('F18 a repeat that happens once says so, not "1 times"', () => {
  assert.doesNotMatch(K.describeRule('FREQ=WEEKLY;BYDAY=SA;INTERVAL=1;COUNT=1;', SAT), /\b1 times\b/);
  assert.equal(K.describeRule('FREQ=WEEKLY;BYDAY=SA;INTERVAL=1;COUNT=1;', SAT), 'Every Saturday, 1 time');
});

// What the stress test checked and found right.
test('repeat limits clamp rather than store nonsense: interval and count 0 become 1, 5000 becomes 999, day 31 stays 31', () => {
  const s = K.parseRule('', SAT);
  assert.equal(K.buildRule({ ...s, freq: 'DAILY', interval: 0, endMode: 'count', count: 0 }), 'FREQ=DAILY;INTERVAL=1;COUNT=1;');
  assert.equal(K.buildRule({ ...s, freq: 'MONTHLY', interval: 5000, monthMode: 'day', monthDay: 31 }), 'FREQ=MONTHLY;BYMONTHDAY=31;INTERVAL=999;');
});
