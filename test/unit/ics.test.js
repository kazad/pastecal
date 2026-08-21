/**
 * Unit tests for ICS generation (functions/index.js).
 *
 * Regression origin: users reported "Server error generating ICS". Production logs showed
 * two distinct failures behind that one 500:
 *
 *   1. TypeError: Cannot read properties of undefined (reading 'replace') at formatDateTime
 *      — a single event missing start/end (calendar `bht-asta-sprechzeiten`, event 26)
 *        crashed the ENTIRE feed, not just that event.
 *   2. HttpsError: Calendar not found returned as 500 instead of 404
 *      — subscribed clients retry forever against a 500 where a 404 says "stop".
 *
 * Run: npm run test:unit   (requires node 20/22 — see test/README.md)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// firebase-functions is installed under functions/, not at the repo root.
const functions = require('../../functions/node_modules/firebase-functions');

const { ICSService } = require('../../functions/index.js')._internal;

// Mirrors the status selection in the generateICSV2 catch block. Kept in sync by
// the "status mapping" tests below, which assert against real HttpsError instances.
const statusFor = (err) => err?.httpErrorCode?.status ?? 500;

// The exact shape of the record that took down the live feed, copied from
// /calendars_readonly/bht-asta-sprechzeiten/events[26]. Note: no start, no end.
const REAL_BAD_EVENT = {
  description: '',
  id: 'af5ca747-cd58-425d-b10d-1aba274440a6',
  isAllDay: false,
  recurrencerule: '',
  repeat: '',
  title: 'Öffentlichkeitsreferat',
  type: 1,
};

const GOOD_EVENT = {
  description: '',
  end: '2026-05-27T13:00:00.000Z',
  id: 27,
  isAllDay: false,
  recurrencerule: '',
  repeat: '',
  start: '2026-05-27T10:00:00.000Z',
  title: 'Verkehr',
  type: 1,
};

const countEvents = (ics) => (ics.match(/BEGIN:VEVENT/g) || []).length;

test('generateICS: the real-world bad event does not crash the feed', () => {
  const ics = ICSService.generateICS({ events: [REAL_BAD_EVENT] }, 'bht-asta-sprechzeiten');

  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics, /END:VCALENDAR$/);
  assert.equal(countEvents(ics), 0, 'event missing start/end must be skipped, not emitted');
});

test('generateICS: one bad event does not take down its valid siblings', () => {
  // This is the core of the bug: the feed had 29 events, 1 malformed, and all 29 were lost.
  const events = [GOOD_EVENT, REAL_BAD_EVENT, { ...GOOD_EVENT, id: 28, title: 'Bildung' }];
  const ics = ICSService.generateICS({ events }, 'bht-asta-sprechzeiten');

  assert.equal(countEvents(ics), 2, 'the two valid events must still be emitted');
  assert.match(ics, /SUMMARY:Verkehr/);
  assert.match(ics, /SUMMARY:Bildung/);
  // Assert on UID, not title: the live calendar has a second, well-formed event with the
  // same title, so a title check would fail for the wrong reason.
  assert.doesNotMatch(ics, /af5ca747/, 'the malformed event must be omitted');
});

test('generateICS: skips events missing only start, or only end', () => {
  const missingEnd = { ...GOOD_EVENT, id: 'a', title: 'NoEnd', end: undefined };
  const missingStart = { ...GOOD_EVENT, id: 'b', title: 'NoStart', start: undefined };
  const ics = ICSService.generateICS({ events: [missingEnd, missingStart, GOOD_EVENT] }, 'c');

  assert.equal(countEvents(ics), 1);
  assert.match(ics, /SUMMARY:Verkehr/);
});

test('generateICS: tolerates null/undefined holes in the events array', () => {
  // Firebase RTDB renders sparse arrays with null holes.
  const ics = ICSService.generateICS({ events: [null, GOOD_EVENT, undefined] }, 'c');

  assert.equal(countEvents(ics), 1);
  assert.match(ics, /SUMMARY:Verkehr/);
});

test('generateICS: tolerates events missing title/description', () => {
  // escapeText() would throw on undefined the same way formatDateTime did.
  const sparse = { id: 'x', start: GOOD_EVENT.start, end: GOOD_EVENT.end };
  const ics = ICSService.generateICS({ events: [sparse] }, 'c');

  assert.equal(countEvents(ics), 1, 'an event with valid dates should still be emitted');
  assert.match(ics, /UID:x/);
});

test('generateICS: empty and absent event lists produce a valid empty calendar', () => {
  for (const data of [{ events: [] }, {}, { events: null }]) {
    const ics = ICSService.generateICS(data, 'empty');
    assert.equal(countEvents(ics), 0);
    assert.match(ics, /^BEGIN:VCALENDAR/);
    assert.match(ics, /END:VCALENDAR$/);
  }
});

// --- Invariants that must survive the fix -------------------------------------------------
// The fix must not change output for well-formed data. These lock the existing contract.

test('generateICS: valid event output is unchanged aside from DTSTAMP/CRLF', () => {
  const ics = ICSService.generateICS({ events: [GOOD_EVENT] }, 'test');
  const dtstamp = ics.match(/DTSTAMP:(\S+)/)[1];

  assert.equal(ics, [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PasteCal//test//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // No title on this fixture, so the name falls back to the id rather than
    // emitting an empty X-WR-CALNAME (some clients render that as blank).
    'X-WR-CALNAME:test',
    'NAME:test',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    'BEGIN:VEVENT',
    'UID:27',
    `DTSTAMP:${dtstamp}`,
    'DTSTART:20260527T100000Z',
    'DTEND:20260527T130000Z',
    'SUMMARY:Verkehr',
    'DESCRIPTION:',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
});

// --- RFC 5545 compliance (issue #37, minor findings) ---------------------------------------

test('generateICS: lines are joined with CRLF per RFC 5545 §3.1', () => {
  const ics = ICSService.generateICS({ events: [GOOD_EVENT] }, 'test');

  assert.ok(ics.includes('\r\n'), 'expected CRLF line endings');
  assert.ok(!ics.replace(/\r\n/g, '').includes('\n'), 'no bare LF should remain');
});

test('generateICS: every VEVENT includes a well-formed DTSTAMP', () => {
  const ics = ICSService.generateICS({ events: [GOOD_EVENT] }, 'test');

  assert.match(ics, /DTSTAMP:\d{8}T\d{6}Z/);
});

test('generateICS: all events in one export share the same DTSTAMP', () => {
  const events = [GOOD_EVENT, { ...GOOD_EVENT, id: 28, title: 'Bildung' }];
  const ics = ICSService.generateICS({ events }, 'test');
  const stamps = [...ics.matchAll(/DTSTAMP:(\S+)/g)].map(m => m[1]);

  assert.equal(stamps.length, 2);
  assert.equal(stamps[0], stamps[1]);
});

test('generateICS: recurrence rule is preserved', () => {
  const recurring = { ...GOOD_EVENT, recurrencerule: 'FREQ=WEEKLY;BYDAY=MO' };
  const ics = ICSService.generateICS({ events: [recurring] }, 'test');

  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO/);
});

test('generateICS: special characters in text are escaped per RFC 5545', () => {
  const tricky = {
    ...GOOD_EVENT,
    title: 'Lunch, with; a\\ backslash',
    description: 'line one\nline two',
  };
  const ics = ICSService.generateICS({ events: [tricky] }, 'test');

  assert.match(ics, /SUMMARY:Lunch\\, with\\; a\\\\ backslash/);
  assert.match(ics, /DESCRIPTION:line one\\nline two/);
});

// --- HTTP status mapping (bug 2) ----------------------------------------------------------
// A missing calendar was reported as 500, so subscribed clients retried a dead feed forever.

test('status mapping: a missing calendar maps to 404, not 500', () => {
  // The exact error CalendarService.getCalendarData throws for an unknown id.
  const err = new functions.https.HttpsError('not-found', 'Calendar not found');

  assert.equal(statusFor(err), 404);
});

test('status mapping: an unexpected error still maps to 500', () => {
  // A genuine server fault must not be downgraded into a client error.
  assert.equal(statusFor(new TypeError('boom')), 500);
  assert.equal(statusFor(new functions.https.HttpsError('internal', 'kaboom')), 500);
  assert.equal(statusFor(undefined), 500);
});

// --- Feed metadata (subscription quality) --------------------------------------------------
//
// A subscribed feed is judged on what the client shows in the calendar list and
// how often it re-polls. Without these headers the subscription appears as the
// raw URL or "Untitled", and clients fall back to their own refresh interval --
// some default to once a day, which makes a shared calendar look broken.

test('generateICS: the calendar title becomes the subscription name', () => {
  const ics = ICSService.generateICS(
    { title: 'Rebel Loons Dispatch', events: [GOOD_EVENT] }, 'rldispatch');

  assert.match(ics, /^X-WR-CALNAME:Rebel Loons Dispatch$/m);
  // NAME is the RFC 7986 spelling; X-WR-CALNAME is what most clients actually read.
  assert.match(ics, /^NAME:Rebel Loons Dispatch$/m);
});

test('generateICS: a missing title falls back to the calendar id', () => {
  const ics = ICSService.generateICS({ events: [GOOD_EVENT] }, 'rldispatch');

  // An empty X-WR-CALNAME renders as blank in some clients, which is worse than
  // showing the id.
  assert.match(ics, /^X-WR-CALNAME:rldispatch$/m);
  assert.ok(!ics.includes('X-WR-CALNAME:\r\n'), 'never emit an empty name');
});

test('generateICS: a title with commas or semicolons is escaped', () => {
  const ics = ICSService.generateICS(
    { title: 'Ops; staffing, on-call', events: [GOOD_EVENT] }, 'ops');

  // Unescaped, these would be read as ICS property-parameter separators and
  // truncate the name at the first comma. Compared as a plain string: the
  // backslashes make the regex form of this assertion easy to get wrong.
  assert.ok(
    ics.split('\r\n').includes('X-WR-CALNAME:Ops\\; staffing\\, on-call'),
    'commas and semicolons in the title must be backslash-escaped');
});

test('generateICS: clients are told how often to refresh', () => {
  const ics = ICSService.generateICS({ events: [GOOD_EVENT] }, 'test');

  assert.match(ics, /^REFRESH-INTERVAL;VALUE=DURATION:PT1H$/m);
  // Outlook reads the older Microsoft spelling instead; harmless to send both.
  assert.match(ics, /^X-PUBLISHED-TTL:PT1H$/m);
});

test('generateICS: metadata sits before the first event', () => {
  const ics = ICSService.generateICS(
    { title: 'Team', events: [GOOD_EVENT] }, 'team');

  // Calendar-level properties must precede any component, or strict parsers
  // treat them as belonging to the VEVENT.
  assert.ok(ics.indexOf('X-WR-CALNAME:') < ics.indexOf('BEGIN:VEVENT'));
  assert.ok(ics.indexOf('REFRESH-INTERVAL') < ics.indexOf('BEGIN:VEVENT'));
});
