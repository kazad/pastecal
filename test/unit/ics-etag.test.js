/**
 * Unit tests for the ICS feed's ETag (functions/index.js, icsEtag / generateICSV2).
 *
 * The ETag lets subscribed calendar apps poll with If-None-Match and get a 304. It used
 * to hash only `events`, so renaming a calendar -- which changes X-WR-CALNAME, the name
 * subscribers see in their calendar list -- produced the same ETag and every subscriber
 * got 304 forever. It now hashes the generated body (what subscribers actually get),
 * with DTSTAMP's per-request timestamp masked so unchanged feeds still 304.
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ICSService, icsEtag } = require('../../functions/index.js')._internal;

const EVENTS = [{
  id: 'e1', title: 'Standup', description: '', isAllDay: false,
  start: '2026-10-02T16:00:00.000Z', end: '2026-10-02T16:30:00.000Z',
}];

test('renaming a calendar changes the ETag even when no event changed', () => {
  const before = icsEtag(ICSService.generateICS({ title: 'Team', events: EVENTS }, 'team'));
  const after = icsEtag(ICSService.generateICS({ title: 'Team (Fall)', events: EVENTS }, 'team'));
  assert.notEqual(before, after);
});

test('an unchanged calendar keeps the same ETag across requests (DTSTAMP masked)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T00:00:00Z') });
  const a = ICSService.generateICS({ title: 'Team', events: EVENTS }, 'team');
  t.mock.timers.setTime(Date.parse('2026-10-01T05:17:42Z'));
  const b = ICSService.generateICS({ title: 'Team', events: EVENTS }, 'team');
  assert.notEqual(a, b, 'bodies differ only by DTSTAMP');
  assert.equal(icsEtag(a), icsEtag(b));
});

test('an event edit changes the ETag', () => {
  const edited = [{ ...EVENTS[0], title: 'Standup (moved)' }];
  assert.notEqual(
    icsEtag(ICSService.generateICS({ title: 'Team', events: EVENTS }, 'team')),
    icsEtag(ICSService.generateICS({ title: 'Team', events: edited }, 'team')));
});

test('ETag is a quoted strong validator', () => {
  assert.match(icsEtag('BEGIN:VCALENDAR\r\nEND:VCALENDAR'), /^"[0-9a-f]{40}"$/);
});
