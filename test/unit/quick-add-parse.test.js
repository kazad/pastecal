/**
 * Unit tests for Utils.parseHumanWrittenCalendar() (public/utils/utils.js), the quick-add
 * parser.
 *
 *   1. "vacation dec 11 - dec 15" (a built-in example) became a noon-to-noon TIMED event:
 *      chrono fills a missing time with 12:00 and the parser never set isAllDay. Dates
 *      with no explicit hour are now all-day, end exclusive.
 *   2. "for N days" added N * 86400000 ms, which lands an hour off across a DST change.
 *      It now adds calendar days.
 *   3. The fix for 1 keyed all-day off isCertain('hour'), but chrono 1.4.9 reports a part
 *      of day ("morning", "night", "tonight") as an IMPLIED hour, so "call tomorrow
 *      morning" became all-day. All-day needs no time-of-day signal at all.
 *   4. "Titled dates stay timed" (chrono's implied noon) made "Mom birthday Oct 12" a
 *      noon-1pm meeting. Any date with no time is all-day now; a meal word is a time
 *      ("lunch tomorrow" is noon). And only the FIRST chrono result was read, so "1:1
 *      with Alex Tue 2pm" was 01:01 and "interview 10am PST tomorrow" lost its date.
 *
 * chrono-node is a CDN script in the browser and not a dependency here. The bulk of the
 * file uses a fake shaped like chrono 1.4.9's results (knownValues / impliedValues /
 * tags, recorded from the real library); the last block runs the real chrono 1.4.9 that
 * index.html pins, cached in the OS temp dir after one download (PASTECAL_CHRONO_PATH
 * points at a local copy). Without it that block skips, or fails under CI.
 * Runs in America/Los_Angeles so the DST case is real (Nov 1, 2026 falls back).
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.TZ = 'America/Los_Angeles';

let nextParse = [];
const fakeChrono = { parse: () => nextParse };

function loadUtils() {
  const src = fs.readFileSync(path.join(__dirname, '../../public/utils/utils.js'), 'utf8');
  const fakeDocument = {
    body: null,
    addEventListener: () => {},
    querySelector: () => null,
    createElement: () => ({}),
  };
  const factory = new Function(
    'window', 'document', 'crypto', 'localStorage', 'MutationObserver', 'chrono',
    `${src}; return window.Utils;`
  );
  return factory({}, fakeDocument, { getRandomValues: (a) => a },
    { getItem: () => null, setItem: () => {} }, class { observe() {} }, fakeChrono);
}

const Utils = loadUtils();

// A chrono 1.4.9 component. `known` holds what the text said; everything else is implied
// (chrono's noon for a bare date, or the part-of-day hour plus meridiem in `implied`).
function comp(y, m, d, hour, implied = {}) {
  const knownValues = { day: d, month: m, year: y };
  if (hour !== undefined) knownValues.hour = hour;
  const impliedValues = { hour: 12, minute: 0, ...implied };
  if (hour !== undefined) delete impliedValues.hour;
  const h = hour !== undefined ? hour : impliedValues.hour;
  return {
    knownValues, impliedValues,
    date: () => new Date(y, m - 1, d, h),
    isCertain: (c) => c in knownValues,
  };
}

function parse(entry, text, start, end, tags) {
  nextParse = [{ text, start, end: end || null, tags: tags || {} }];
  return Utils.parseHumanWrittenCalendar(entry);
}

test('quick-add: a date range with no time is an all-day event, end exclusive', () => {
  const r = parse('vacation dec 11 - dec 15', 'dec 11 - dec 15',
    comp(2026, 12, 11), comp(2026, 12, 15));
  assert.equal(r.subject, 'vacation');
  assert.equal(r.isAllDay, true);
  assert.equal(new Date(r.startDateTime).toString(), new Date(2026, 11, 11).toString());
  assert.equal(new Date(r.endDateTime).toString(), new Date(2026, 11, 16).toString());
});

test('quick-add: a bare date with no time is a one-day all-day event', () => {
  for (const [entry, text] of [['tomorrow', 'tomorrow'], ['dec 11', 'dec 11']]) {
    const r = parse(entry, text, comp(2026, 12, 11));
    assert.equal(r.isAllDay, true, entry);
    assert.equal(new Date(r.startDateTime).toString(), new Date(2026, 11, 11).toString());
    assert.equal(new Date(r.endDateTime).toString(), new Date(2026, 11, 12).toString());
  }
});

test('quick-add: a titled date with no time is all-day; a meal word is its hour', () => {
  // "Mom birthday Oct 12" used to be a noon-to-1pm meeting (chrono's implied noon):
  // nobody typing a date with no time means noon. A meal says when, though.
  const bday = parse('Mom birthday Oct 12', 'Oct 12', comp(2026, 10, 12));
  assert.equal(bday.subject, 'Mom birthday');
  assert.equal(bday.isAllDay, true);
  assert.equal(new Date(bday.startDateTime).toString(), new Date(2026, 9, 12).toString());
  assert.equal(new Date(bday.endDateTime).toString(), new Date(2026, 9, 13).toString());

  const lunch = parse('lunch tomorrow', 'tomorrow', comp(2026, 10, 5));
  assert.equal(lunch.isAllDay, false);
  assert.equal(new Date(lunch.startDateTime).getHours(), 12);
  assert.equal(new Date(lunch.endDateTime).getHours(), 13);
});

test('quick-add: a part of day is a time, not all-day', () => {
  // chrono 1.4.9 leaves these hours implied; the ENCasualTimeParser tag and the implied
  // meridiem are what mark them.
  const casual = { ENCasualDateParser: true, ENCasualTimeParser: true, ENMergeDateAndTimeRefiner: true };
  const morning = parse('call tomorrow morning', 'tomorrow morning',
    comp(2026, 10, 2, undefined, { hour: 6, meridiem: 0 }), null, casual);
  assert.equal(morning.isAllDay, false);
  assert.equal(new Date(morning.startDateTime).getHours(), 6);

  const night = parse('dinner friday night', 'friday night',
    comp(2026, 10, 2, undefined, { hour: 20, meridiem: 1 }), null,
    { ENWeekdayParser: true, ENCasualTimeParser: true });
  assert.equal(night.isAllDay, false);
  assert.equal(new Date(night.startDateTime).getHours(), 20);

  // "tonight" comes from the casual DATE parser alone; only the meridiem gives it away.
  const tonight = parse('tonight', 'tonight',
    comp(2026, 10, 1, undefined, { hour: 22, meridiem: 1 }), null, { ENCasualDateParser: true });
  assert.equal(tonight.isAllDay, false);
  assert.equal(new Date(tonight.startDateTime).getHours(), 22);
});

test('quick-add: a range typed backwards gets the default length, not an inverted end', () => {
  const r = parse('shift oct 5 5pm - 3pm', 'oct 5 5pm - 3pm', comp(2026, 10, 5, 17), comp(2026, 10, 5, 15));
  assert.equal(r.isAllDay, false);
  assert.equal(new Date(r.endDateTime) - new Date(r.startDateTime), 3600000);
});

test('quick-add: an explicit time stays a timed event', () => {
  const r = parse('lunch oct 5 2pm', 'oct 5 2pm', comp(2026, 10, 5, 14));
  assert.equal(r.isAllDay, false);
  assert.equal(new Date(r.startDateTime).getHours(), 14);
  assert.equal(new Date(r.endDateTime).getHours(), 15);
});

test('quick-add: an hour duration on a bare date stays timed', () => {
  // "for 1 hour" only makes sense as a timed event, so it is not promoted to all-day.
  const r = parse('call oct 5 for 1 hour', 'oct 5', comp(2026, 10, 5));
  assert.equal(r.isAllDay, false);
});

test('quick-add: "for N days" on a bare date is all-day spanning N calendar days', () => {
  const r = parse('conference oct 31 for 3 days', 'oct 31', comp(2026, 10, 31));
  assert.equal(r.subject, 'conference');
  assert.equal(r.isAllDay, true);
  // Spans the Nov 1 fall-back; still exactly local midnight of Nov 3.
  assert.equal(new Date(r.endDateTime).toString(), new Date(2026, 10, 3).toString());
});

test('quick-add: "for N days" with a time keeps the wall-clock time across DST', () => {
  // Was start + 2 * 86400000 ms: 8am on Nov 2 after the fall-back, not 9am.
  const r = parse('offsite oct 31 9am for 2 days', 'oct 31 9am', comp(2026, 10, 31, 9));
  assert.equal(r.isAllDay, false);
  const end = new Date(r.endDateTime);
  assert.equal(end.getDate(), 2);
  assert.equal(end.getHours(), 9);
});

// The real chrono 1.4.9 (the version index.html pins), so the fake above cannot drift from
// what the browser actually parses.
function installedChrono(version) {
  try {
    const pkg = require.resolve('chrono-node/package.json');
    if (require(pkg).version !== version) return null;
    const file = path.join(path.dirname(pkg), 'dist', 'chrono.min.js');
    return fs.existsSync(file) ? file : null;
  } catch (err) {
    return null;
  }
}

function loadRealChrono() {
  const index = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const version = (/chrono-node@([\d.]+)\/dist\/chrono\.min\.js/.exec(index) || [])[1];
  if (!version) return { reason: 'index.html no longer pins a chrono-node version' };
  const file = process.env.PASTECAL_CHRONO_PATH || installedChrono(version)
    || path.join(require('node:os').tmpdir(), `pastecal-chrono-${version}.min.js`);
  if (!fs.existsSync(file)) {
    // The root devDependency is the source of truth; downloading is a local convenience
    // only. Under CI nothing is fetched, so a missing copy fails instead of skipping.
    if (process.env.CI) {
      return { reason: `chrono-node@${version} is not installed (run \`npm ci\`; the root devDependency must match index.html)` };
    }
    const url = `https://cdn.jsdelivr.net/npm/chrono-node@${version}/dist/chrono.min.js`;
    // curl honors the HTTPS proxy settings that node's own fetch ignores.
    const tmp = `${file}.${process.pid}.part`;
    const r = require('node:child_process').spawnSync('curl', ['-sfL', '--max-time', '60', '-o', tmp, url]);
    if (r.status !== 0) return { reason: `could not download ${url}` };
    fs.renameSync(tmp, file);
  }
  const mod = { exports: {} };
  try {
    new Function('module', 'exports', 'define', fs.readFileSync(file, 'utf8'))(mod, mod.exports, undefined);
  } catch (err) {
    return { reason: `chrono failed to load: ${err.message}` };
  }
  return typeof mod.exports.parse === 'function' ? { chrono: mod.exports } : { reason: 'no chrono.parse' };
}

test('quick-add with the real chrono 1.4.9: all-day only for bare dates and spans', (t) => {
  const real = loadRealChrono();
  if (!real.chrono) {
    if (process.env.CI) assert.fail(real.reason);
    t.skip(real.reason);
    return;
  }
  const RealUtils = (() => {
    const saved = fakeChrono.parse;
    fakeChrono.parse = (...args) => real.chrono.parse(...args);
    return { parse: (s) => Utils.parseHumanWrittenCalendar(s), restore: () => { fakeChrono.parse = saved; } };
  })();
  try {
    const cases = {
      'call tomorrow morning': false,
      'dinner friday night': false,
      'party saturday evening': false,
      'standup tomorrow afternoon': false,
      'meet tonight': false,
      'noon tomorrow': false,
      'lunch tomorrow': false,
      'dentist oct 5': true,
      'Mom birthday Oct 12': true,
      'lunch oct 5 2pm': false,
      'call oct 5 for 1 hour': false,
      'tomorrow': true,
      'dec 11': true,
      'vacation dec 11 - dec 15': true,
      'conference oct 31 for 3 days': true,
    };
    for (const [entry, allDay] of Object.entries(cases)) {
      const r = RealUtils.parse(entry);
      assert.equal(r.isAllDay, allDay, entry);
      assert.ok(new Date(r.endDateTime) > new Date(r.startDateTime), `${entry}: end after start`);
    }
    assert.equal(new Date(RealUtils.parse('call tomorrow morning').startDateTime).getHours(), 6);
    assert.equal(new Date(RealUtils.parse('lunch tomorrow').startDateTime).getHours(), 12);
  } finally {
    RealUtils.restore();
  }
});

// Every misparse a tester hit, through the real chrono. "Now" is pinned to Fri Oct 2 2026
// 10:00 local so weekday words land on known dates.
function withRealChrono(t, fn) {
  const real = loadRealChrono();
  if (!real.chrono) {
    if (process.env.CI) assert.fail(real.reason);
    t.skip(real.reason);
    return;
  }
  const saved = fakeChrono.parse;
  fakeChrono.parse = (...args) => real.chrono.parse(...args);
  try { fn((s) => Utils.parseHumanWrittenCalendar(s, new Date(2026, 9, 2, 10, 0))); } finally { fakeChrono.parse = saved; }
}
const at = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

test('quick-add (real chrono): every result is used, not just the first', (t) => withRealChrono(t, (parse) => {
  // "1:1" is a meeting, not 01:01; the date and time are both read.
  const oneOnOne = parse('1:1 with Alex Tue 2pm');
  assert.equal(oneOnOne.subject, '1:1 with Alex');
  assert.equal(at(oneOnOne.startDateTime), '2026-10-06 14:00');

  // A zoned time and a date in separate phrases: tomorrow, 10am Pacific Standard = 11am PDT.
  const interview = parse('interview 10am PST tomorrow');
  assert.equal(interview.subject, 'interview');
  assert.equal(at(interview.startDateTime), '2026-10-03 11:00');
  assert.equal(new Date(interview.startDateTime).toISOString(), '2026-10-03T18:00:00.000Z');
}));

test('quick-add (real chrono): "8pm-midnight" ends at midnight', (t) => withRealChrono(t, (parse) => {
  for (const s of ['Party Saturday 8pm-midnight', 'Party Saturday 8pm to midnight']) {
    const r = parse(s);
    assert.equal(r.subject, 'Party', s);
    assert.equal(at(r.startDateTime), '2026-10-03 20:00', s);
    assert.equal(at(r.endDateTime), '2026-10-04 00:00', s);
  }
}));

test('quick-add (real chrono): short durations "2h", "90m", "1h30m"', (t) => withRealChrono(t, (parse) => {
  const cases = {
    'dentist tomorrow 3pm for 2h': ['dentist', '2026-10-03 15:00', '2026-10-03 17:00'],
    'call Friday 2pm 90m': ['call', '2026-10-02 14:00', '2026-10-02 15:30'],
    'sync 1h30m tomorrow 10am': ['sync', '2026-10-03 10:00', '2026-10-03 11:30'],
  };
  for (const [s, [subject, start, end]] of Object.entries(cases)) {
    const r = parse(s);
    assert.deepEqual([r.subject, at(r.startDateTime), at(r.endDateTime)], [subject, start, end], s);
    assert.equal(r.isAllDay, false, s);
  }
  assert.equal(parse('dentist tomorrow 3pm for 2h').durationMs, 7200000);
}));

test('quick-add (real chrono): repeats become an RRULE starting on a matching day', (t) => withRealChrono(t, (parse) => {
  const weekday = parse('standup every weekday 9am');
  assert.equal(weekday.subject, 'standup');
  assert.equal(weekday.recurrenceRule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=1');
  assert.equal(at(weekday.startDateTime), '2026-10-02 09:00');
  assert.equal(Utils.describeRecurrence(weekday.recurrenceRule), 'every weekday');

  const gym = parse('gym every Monday');
  assert.equal(gym.subject, 'gym');
  assert.equal(gym.recurrenceRule, 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1');
  assert.equal(gym.isAllDay, true);
  assert.equal(at(gym.startDateTime), '2026-10-05 00:00', 'the first Monday, not today');

  const daily = parse('daily standup 9:30am');
  assert.equal(daily.recurrenceRule, 'FREQ=DAILY;INTERVAL=1');
  assert.equal(daily.subject, 'standup');

  const yoga = parse('yoga every tuesday and thursday 7am');
  assert.equal(yoga.recurrenceRule, 'FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=1');
  assert.equal(at(yoga.startDateTime), '2026-10-06 07:00');

  assert.equal(parse('retro every other friday 4pm').recurrenceRule, 'FREQ=WEEKLY;BYDAY=FR;INTERVAL=2');
  assert.equal(parse('lunch tomorrow 2pm').recurrenceRule, null, 'no repeat unless asked');
}));

test('quick-add (real chrono): no date found says so', (t) => withRealChrono(t, (parse) => {
  const r = parse('hello world');
  assert.equal(r.startDateTime, null);
  assert.equal(r.reason, 'no-date');
  assert.equal(parse('for 2 hours').reason, 'no-date');
}));
