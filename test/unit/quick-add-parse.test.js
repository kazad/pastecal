/**
 * Unit tests for Utils.parseHumanWrittenCalendar() (public/utils/utils.js), the quick-add
 * parser.
 *
 *   1. "vacation dec 11 - dec 15" (a built-in example) became a noon-to-noon TIMED event:
 *      chrono fills a missing time with 12:00 and the parser never set isAllDay. Dates
 *      with no explicit hour are now all-day, end exclusive.
 *   2. "for N days" added N * 86400000 ms, which lands an hour off across a DST change.
 *      It now adds calendar days.
 *
 * chrono-node is a CDN script in the browser and not a dependency here, so a minimal fake
 * stands in: start/end components with date() and isCertain('hour'), as in chrono 1.4.9.
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

// A chrono component; withHour false mimics chrono's implied 12:00.
function comp(y, m, d, hour) {
  const certain = hour !== undefined;
  return {
    date: () => new Date(y, m - 1, d, certain ? hour : 12),
    isCertain: (c) => c === 'hour' ? certain : true,
  };
}

function parse(entry, text, start, end) {
  nextParse = [{ text, start, end: end || null }];
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

test('quick-add: a single date with no time is a one-day all-day event', () => {
  const r = parse('dentist oct 5', 'oct 5', comp(2026, 10, 5));
  assert.equal(r.isAllDay, true);
  assert.equal(new Date(r.startDateTime).toString(), new Date(2026, 9, 5).toString());
  assert.equal(new Date(r.endDateTime).toString(), new Date(2026, 9, 6).toString());
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
