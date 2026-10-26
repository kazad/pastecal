/**
 * The native event card's pure helpers (public/nativecal/components/cardKit.js): typed times and dates,
 * times typed into a new event's title, the words the card shows, and repeat rules in classic's form.
 * Run: node --test test/unit/native-card-kit.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../public/nativecal/components/cardKit.js');

const SAT = new Date(2026, 9, 24);   // Saturday Oct 24 2026
const ymd = (d) => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (m) => m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

test('parseTime: 12-hour shorthands, 24-hour, noon, bad input', () => {
  const cases = { '5p': '17:00', '5 pm': '17:00', '5:30': '17:30', '530p': '17:30', '9': '09:00', '9:15a': '09:15', '12a': '00:00',
    '12p': '12:00', 'noon': '12:00', 'midnight': '00:00', '17:30': '17:30', '07:00': '07:00', '11 PM': '23:00' };
  for (const [k, v] of Object.entries(cases)) assert.equal(hm(K.parseTime(k)), v, k);
  for (const bad of ['', '25', '13pm', '5:75', 'soon', '0p']) assert.equal(K.parseTime(bad), null, bad);
  assert.equal(hm(K.parseTime('5', '24')), '05:00');
  assert.equal(hm(K.parseTime('17:30', '24')), '17:30');
});

test('parseDate: words, weekdays after today, month names, numbers, the reference month', () => {
  assert.equal(ymd(K.parseDate('today', SAT)), '2026-10-24');
  assert.equal(ymd(K.parseDate('tomorrow', SAT)), '2026-10-25');
  assert.equal(ymd(K.parseDate('fri', SAT)), '2026-10-30');
  assert.equal(ymd(K.parseDate('Saturday', SAT)), '2026-10-31', 'a weekday is the next one, never today');
  assert.equal(ymd(K.parseDate('oct 20', SAT)), '2026-10-20');
  assert.equal(ymd(K.parseDate('October 20, 2027', SAT)), '2027-10-20');
  assert.equal(ymd(K.parseDate('20 oct', SAT)), '2026-10-20');
  assert.equal(ymd(K.parseDate('10/20', SAT)), '2026-10-20');
  assert.equal(ymd(K.parseDate('2/3/27', SAT)), '2027-02-03');
  assert.equal(ymd(K.parseDate('2026-12-01', SAT)), '2026-12-01');
  assert.equal(ymd(K.parseDate('5', SAT, new Date(2026, 11, 9))), '2026-12-05', 'a lone day is in the month shown');
  for (const bad of ['', 'feb 30', 'someday', '13/1']) assert.equal(K.parseDate(bad, SAT), null, bad);
});

test('smartParse: times typed into a new title move the event; titles that only look like times do not', () => {
  const p = (t) => { const r = K.smartParse(t, SAT); return r && { title: t.slice(0, r.at).trim(), day: ymd(r.day), start: hm(r.start), end: hm(r.end) }; };
  assert.deepEqual(p('Practice Thu 5-6'), { title: 'Practice', day: '2026-10-29', start: '17:00', end: '18:00' });
  assert.deepEqual(p('Snack run tomorrow 3:30pm'), { title: 'Snack run', day: '2026-10-25', start: '15:30', end: null });
  assert.deepEqual(p('Game fri 10-11:30'), { title: 'Game', day: '2026-10-30', start: '10:00', end: '11:30' });
  assert.deepEqual(p('Call 7-9pm'), { title: 'Call', day: null, start: '19:00', end: '21:00' });
  assert.deepEqual(p('Brunch 11-1pm'), { title: 'Brunch', day: null, start: '11:00', end: '13:00' });
  assert.deepEqual(p('Lunch at noon'), { title: 'Lunch', day: null, start: '12:00', end: null });
  assert.deepEqual(p('Practice Thu'), { title: 'Practice', day: '2026-10-29', start: null, end: null });
  assert.deepEqual(p('Pickup tue 9-1'), { title: 'Pickup', day: '2026-10-27', start: '09:00', end: '13:00' }, 'a day word and no AM/PM: an end before the start is 12 hours on');
  for (const plain of ['Room 5', 'Grades 3-5', 'Game 7-9', 'Monica', 'Saturn trip', 'Meet Monica', 'Thu', '5pm']) assert.equal(p(plain), null, plain);
});

test('words: times, lengths, ages, ordinals', () => {
  assert.equal(K.fmtMinutes(17 * 60, '12', true), '5 PM');
  assert.equal(K.fmtMinutes(17 * 60 + 30, '12', true), '5:30 PM');
  assert.equal(K.fmtMinutes(9 * 60), '9:00 AM');
  assert.equal(K.fmtMinutes(17 * 60, '24'), '17:00');
  assert.equal(K.fmtLen(90), '1h 30m');
  assert.equal(K.fmtLen(45), '45m');
  assert.equal(K.fmtLen(60), '1h');
  assert.equal(K.fmtLen(1440 * 4 + 480), '4 days 8h');
  const now = Date.UTC(2026, 9, 24, 12);
  assert.equal(K.ago(now - 20e3, now), 'just now');
  assert.equal(K.ago(now - 5 * 60e3, now), '5m ago');
  assert.equal(K.ago(now - 26 * 3600e3, now), '26h ago');
  assert.equal(K.ago(now - 50 * 3600e3, now), '2d ago');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(K.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
});

test('repeat rules: presets in classic\'s form, descriptions, a round trip that keeps every part', () => {
  const wed = new Date(2026, 9, 21);
  assert.deepEqual(K.presets(wed).map((p) => p.rule), ['', 'FREQ=DAILY;INTERVAL=1;', 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;', 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=2;',
    'FREQ=MONTHLY;BYMONTHDAY=21;INTERVAL=1;', 'FREQ=YEARLY;BYMONTHDAY=21;BYMONTH=10;INTERVAL=1;', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=1;']);
  // Each one-tap choice is written exactly as the Custom panel (classic's form) would write it.
  for (const p of K.presets(wed).slice(1)) assert.equal(K.buildRule(K.parseRule(p.rule, wed)), p.rule, p.id);
  assert.equal(K.presetOf('FREQ=WEEKLY;BYDAY=WE;INTERVAL=1', wed), 'week');
  assert.equal(K.presetOf('FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;COUNT=4;', wed), 'custom');
  const d = (r) => K.describeRule(r, wed);
  assert.equal(d(''), "Doesn't repeat");
  assert.equal(d('FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;'), 'Every Wednesday');
  assert.equal(d('FREQ=WEEKLY;BYDAY=WE;INTERVAL=2;'), 'Every 2 weeks on Wednesday');
  assert.equal(d('FREQ=MONTHLY;BYMONTHDAY=21;INTERVAL=1;'), 'Monthly on the 21st');
  assert.equal(d('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3;INTERVAL=1;'), 'Monthly on the third Friday');
  assert.equal(d('FREQ=YEARLY;BYMONTHDAY=21;BYMONTH=10;INTERVAL=1;'), 'Yearly on October 21');
  assert.equal(d('FREQ=DAILY;INTERVAL=1;COUNT=5;'), 'Every day, 5 times');
  assert.equal(d('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=1;'), 'Every weekday');
  for (const r of ['FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=2;COUNT=6;', 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;INTERVAL=1;', 'FREQ=YEARLY;BYDAY=MO;BYSETPOS=2;BYMONTH=5;INTERVAL=1;',
    'FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;WKST=MO;']) assert.equal(K.buildRule(K.parseRule(r, wed)), r, r);
  const s = K.parseRule('FREQ=DAILY;INTERVAL=1;', wed); s.endMode = 'until'; s.until = '2026-11-01';
  assert.equal(K.buildRule(s), `FREQ=DAILY;INTERVAL=1;UNTIL=${new Date(2026, 10, 1).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")};`, "UNTIL: that date's local midnight as a UTC stamp, as classic's date picker writes it");
  assert.equal(K.ruleProblem({ ...s, until: '2026-10-01' }, wed, wed, false), 'The repeat ends before the event starts.');
  assert.match(K.ruleProblem(K.parseRule('FREQ=DAILY;INTERVAL=1;', wed), wed, new Date(2026, 9, 23), false), /longer than the time between/);
});

// Rules classic's repeat editor wrote (Syncfusion 23.2.6 RecurrenceEditor.getRecurrenceRule, read from the running app
// in Los Angeles, Oct 2026): the Custom panel reads each and, unchanged, writes the same characters back.
test('classic\'s rules: read into the Custom panel and written back character for character; weekdays in the week\'s order', () => {
  const thu = new Date(2026, 9, 15, 17, 0);   // Thursday Oct 15 2026, 5 PM
  const until = new Date(2026, 11, 31).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   // 20261231T080000Z in LA
  const classic = [
    ['FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;', 0, 'Yearly on the last Monday of October'],
    ['FREQ=YEARLY;BYMONTHDAY=15;BYMONTH=10;INTERVAL=1;', 0, 'Yearly on October 15'],
    ['FREQ=MONTHLY;BYDAY=TH;BYSETPOS=2;INTERVAL=2;COUNT=5;', 0, 'Every 2 months on the second Thursday, 5 times'],
    ['FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=1;', 0, 'Monthly on the 15th'],
    ['FREQ=WEEKLY;BYDAY=SU,MO,WE,TH,FR;INTERVAL=2;COUNT=5;', 0, 'Every 2 weeks on Sun, Mon, Wed, Thu, Fri, 5 times'],
    ['FREQ=WEEKLY;BYDAY=MO,WE,TH,FR,SU;INTERVAL=2;COUNT=5;', 1, 'Every 2 weeks on Sun, Mon, Wed, Thu, Fri, 5 times'],
    [`FREQ=WEEKLY;BYDAY=MO,WE,TH,FR,SU;INTERVAL=2;UNTIL=${until};`, 1, 'Every 2 weeks on Sun, Mon, Wed, Thu, Fri, until Dec 31'],
    [`FREQ=DAILY;INTERVAL=2;UNTIL=${until};`, 0, 'Every 2 days, until Dec 31'],
    ['FREQ=DAILY;INTERVAL=3;', 0, 'Every 3 days'],
  ];
  for (const [rule, firstDay, words] of classic) {
    assert.equal(K.buildRule(K.parseRule(rule, thu), { firstDay }), rule, rule);
    assert.equal(K.describeRule(rule, thu), words, rule);
  }
  const p = K.parseRule('FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;', thu);
  assert.deepEqual([p.freq, p.monthMode, p.setPos, p.posDay, p.month], ['YEARLY', 'weekday', -1, 1, 10]);
  // Built from the panel's fields as a person sets them: the last Monday of October, yearly.
  const s = K.parseRule('', thu); Object.assign(s, { freq: 'YEARLY', monthMode: 'weekday', setPos: -1, posDay: 1, month: 10 });
  assert.equal(K.buildRule(s), 'FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;');
  const w = K.parseRule('', thu); Object.assign(w, { freq: 'WEEKLY', byDay: [0, 1, 3] });
  assert.equal(K.buildRule(w), 'FREQ=WEEKLY;BYDAY=SU,MO,WE;INTERVAL=1;', 'Sunday first');
  assert.equal(K.buildRule(w, { firstDay: 1 }), 'FREQ=WEEKLY;BYDAY=MO,WE,SU;INTERVAL=1;', 'Monday first: Sunday last, as classic\'s buttons');
  assert.equal(K.buildRule({ ...w, interval: 1500, endMode: 'count', count: 5000 }), 'FREQ=WEEKLY;BYDAY=SU,MO,WE;INTERVAL=999;COUNT=999;', 'classic\'s limits: 999');
});

test('monthCells: leading blanks follow the first day of the week', () => {
  const sun = K.monthCells(2026, 9, 0), mon = K.monthCells(2026, 9, 1);   // Oct 1 2026 is a Thursday
  assert.equal(sun.filter((x) => x === null).length, 4);
  assert.equal(mon.filter((x) => x === null).length, 3);
  assert.equal(sun.filter(Boolean).length, 31);
});
