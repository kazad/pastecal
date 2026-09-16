/**
 * Tests for recurrence in the ICS feed (functions/index.js).
 *
 * The feed emitted RRULE but never EXDATE or RECURRENCE-ID, so the two things people do
 * most often to a recurring series were invisible to every subscriber:
 *
 *   - Delete one occurrence. The app removed it and recorded the date in
 *     recurrenceException, but the feed still emitted the bare RRULE, so Google/Apple/
 *     Outlook kept generating the canceled meeting forever.
 *   - Move one occurrence. The app stores a child event carrying recurrenceID (and, from
 *     Syncfusion, the parent's RecurrenceRule). The feed emitted the parent's unmodified
 *     rule AND the child as a standalone event, so subscribers saw the occurrence twice,
 *     at both the old time and the new one. Worse, the child's inherited rule made it a
 *     second full series.
 *
 * This is not rare: a scan of production found 3,017 events carrying an exception and
 * 1,936 edited occurrences. The people affected are precisely those who subscribed in
 * order to stay in sync.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ICSService } = require('../../functions/index.js')._internal;

const DTSTAMP = '20260911T000000Z';

const series = (extra = {}) => ({
  id: 'parent-1',
  title: 'Weekly Standup',
  description: '',
  start: '2026-09-07T17:00:00.000Z',
  end: '2026-09-07T17:30:00.000Z',
  recurrencerule: 'FREQ=WEEKLY;INTERVAL=1',
  ...extra,
});

// --- Deleted occurrences ----------------------------------------------------------------

test('a deleted occurrence is excluded from the feed', () => {
  const block = ICSService.createEventBlock(
    series({ recurrenceException: '20260921T170000Z' }), DTSTAMP);

  assert.match(block, /^RRULE:FREQ=WEEKLY;INTERVAL=1$/m, 'the series still recurs');
  assert.match(block, /^EXDATE:20260921T170000Z$/m,
    'without EXDATE subscribers keep seeing a meeting that was canceled');
});

test('several deleted occurrences are all excluded', () => {
  const block = ICSService.createEventBlock(
    series({ recurrenceException: '20260310T230000Z,20260908T230000Z' }), DTSTAMP);

  assert.match(block, /^EXDATE:20260310T230000Z,20260908T230000Z$/m);
});

test('a series with no deletions emits no EXDATE', () => {
  const block = ICSService.createEventBlock(series(), DTSTAMP);
  assert.doesNotMatch(block, /EXDATE/, 'an empty EXDATE is invalid in several clients');
});

test('unparseable exception dates are dropped rather than emitted', () => {
  // A malformed EXDATE can invalidate the whole calendar for a strict client, which is a
  // far worse outcome than one occurrence reappearing.
  const block = ICSService.createEventBlock(
    series({ recurrenceException: 'garbage,20260921T170000Z,,nope' }), DTSTAMP);

  assert.match(block, /^EXDATE:20260921T170000Z$/m, 'only the valid date survives');
});

// --- Moved (edited) occurrences ---------------------------------------------------------

test('a moved occurrence replaces its instance instead of duplicating it', () => {
  // Real shape from production: the child carries recurrenceID and the original start in
  // recurrenceException, and Syncfusion leaves the parent's rule on it.
  const child = {
    id: 'child-1',
    title: 'Weekly Standup',
    description: '',
    start: '2026-09-21T21:00:00.000Z',
    end: '2026-09-21T21:30:00.000Z',
    recurrencerule: 'FREQ=WEEKLY;INTERVAL=1',
    recurrenceID: 'parent-1',
    recurrenceException: '20260921T170000Z',
  };

  const block = ICSService.createEventBlock(child, DTSTAMP);

  assert.match(block, /^UID:parent-1$/m,
    'a modified occurrence shares the parent UID; a distinct one shows as an extra event');
  assert.match(block, /^RECURRENCE-ID:20260921T170000Z$/m,
    'names which instance this replaces');
  assert.doesNotMatch(block, /^RRULE:/m,
    'the inherited rule would turn one moved occurrence into a second series');
});

test('a normal one-off event is unaffected', () => {
  const block = ICSService.createEventBlock({
    id: 'plain-1', title: 'Movie Night', description: '',
    start: '2026-09-17T22:00:00.000Z', end: '2026-09-18T01:00:00.000Z',
  }, DTSTAMP);

  assert.match(block, /^UID:plain-1$/m);
  assert.doesNotMatch(block, /RRULE|EXDATE|RECURRENCE-ID/);
});

test('a second moved occurrence gets its OWN slot, not the first one\'s', () => {
  // Syncfusion accumulates the parent's whole exception list onto every child, so taking
  // exceptionDates()[0] gave both children the same RECURRENCE-ID. A duplicate
  // (UID, RECURRENCE-ID) pair is invalid: clients keep one VEVENT and discard the other,
  // so the second meeting disappears entirely -- worse than the duplication it replaced.
  const both = '20260921T170000Z,20261005T170000Z';
  const first = ICSService.createEventBlock({
    id: 'c1', title: 'Standup', description: '',
    start: '2026-09-21T21:00:00.000Z', end: '2026-09-21T21:30:00.000Z',
    recurrenceID: 'parent-1', recurrenceException: both,
  }, DTSTAMP);
  const second = ICSService.createEventBlock({
    id: 'c2', title: 'Standup', description: '',
    start: '2026-10-05T21:00:00.000Z', end: '2026-10-05T21:30:00.000Z',
    recurrenceID: 'parent-1', recurrenceException: both,
  }, DTSTAMP);

  const idOf = (b) => (/^RECURRENCE-ID.*:(\S+)$/m.exec(b) || [])[1];
  assert.equal(idOf(first), '20260921T170000Z');
  assert.equal(idOf(second), '20261005T170000Z');
  assert.notEqual(idOf(first), idOf(second),
    'two occurrences of one series must not claim the same instance');
});

test('a moved occurrence with no usable exception stays a standalone event', () => {
  // Sharing the parent UID is only valid alongside a RECURRENCE-ID. Emitting the parent's
  // UID without one makes clients read the VEVENT as a redefinition of the whole series,
  // collapsing every other occurrence.
  const block = ICSService.createEventBlock({
    id: 'orphan-1', title: 'Standup', description: '',
    start: '2026-09-21T21:00:00.000Z', end: '2026-09-21T21:30:00.000Z',
    recurrenceID: 'parent-1', recurrenceException: 'garbage',
  }, DTSTAMP);

  assert.match(block, /^UID:orphan-1$/m, 'falls back to its own UID');
  assert.doesNotMatch(block, /RECURRENCE-ID/, 'and claims no instance');
});

test('a moved occurrence is overridden, not excluded', () => {
  // The app records a move in the parent's exception list exactly as it records a
  // deletion. EXDATE'ing that slot removes the instance the RECURRENCE-ID override was
  // meant to fill, so the moved event vanishes from the feed entirely.
  //
  // Verified against ical.js (Thunderbird's parser): with the EXDATE present, expanding
  // the series yields no occurrence on that date at all -- the move is simply lost. With
  // it removed, the occurrence resolves at its new time carrying its own summary. So
  // EXDATE must list only genuinely deleted dates.
  const ics = ICSService.generateICS({
    title: 'Mixed',
    events: [
      series({ recurrencerule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=8',
        recurrenceException: '20260914T170000Z,20260921T170000Z' }),
      { id: 'c1', title: 'Weekly Standup (moved)', description: '',
        start: '2026-09-21T21:00:00.000Z', end: '2026-09-21T21:30:00.000Z',
        recurrencerule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=8',
        recurrenceID: 'parent-1', recurrenceException: '20260921T170000Z' },
    ],
  }, 'mixed');

  const exdate = (/^EXDATE.*?:(\S+)$/m.exec(ics) || [])[1];
  assert.equal(exdate, '20260914T170000Z',
    'only the deleted date belongs in EXDATE; the moved one is claimed by RECURRENCE-ID');
  assert.match(ics, /^RECURRENCE-ID:20260921T170000Z$/m,
    'and the moved occurrence still claims its slot');
});

// --- All-day events ---------------------------------------------------------------------

test('an all-day series uses DATE values so its exclusions actually match', () => {
  // RFC 5545 requires EXDATE to use DTSTART's value type. A DATE-TIME EXDATE against a
  // DATE-valued series matches no instance, so the deleted day keeps appearing.
  const block = ICSService.createEventBlock({
    id: 'holiday-1', title: 'Office closed', description: '', isAllDay: true,
    start: '2026-09-07T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z',
    recurrencerule: 'FREQ=WEEKLY;INTERVAL=1',
    recurrenceException: '20260914T000000Z',
  }, DTSTAMP);

  assert.match(block, /^DTSTART;VALUE=DATE:20260907$/m);
  assert.match(block, /^EXDATE;VALUE=DATE:20260914$/m);
});

// --- Date formatting --------------------------------------------------------------------

test('offset and naive timestamps normalize to UTC instead of corrupting the feed', () => {
  // The old string fast-path stripped separators without converting the zone, so an offset
  // stamp became "20260907T1700000400" -- an invalid DTSTART that a strict client rejects,
  // taking the whole calendar with it.
  assert.equal(ICSService.formatDateTime('2026-09-07T17:00:00-04:00'), '20260907T210000Z');
  assert.equal(ICSService.formatDateTime('2026-09-07T17:00:00.000Z'), '20260907T170000Z');
  assert.equal(ICSService.formatDateTime(new Date('2026-09-07T17:00:00Z')), '20260907T170000Z');

  for (const bad of ['nonsense', '', null, undefined]) {
    assert.equal(ICSService.formatDateTime(bad), null, `${JSON.stringify(bad)} is unusable`);
  }
});

test('every emitted timestamp is a well-formed UTC stamp', () => {
  const out = ICSService.formatDateTime('2026-09-07T17:00:00-04:00');
  assert.match(out, /^\d{8}T\d{6}Z$/);
});

// --- The whole feed ---------------------------------------------------------------------

test('a series and its moved occurrence agree with each other in one feed', () => {
  const ics = ICSService.generateICS({
    title: 'Solidarity Calendar',
    events: [
      series({ recurrenceException: '20260921T170000Z' }),
      {
        id: 'child-1', title: 'Weekly Standup', description: '',
        start: '2026-09-21T21:00:00.000Z', end: '2026-09-21T21:30:00.000Z',
        recurrencerule: 'FREQ=WEEKLY;INTERVAL=1',
        recurrenceID: 'parent-1', recurrenceException: '20260921T170000Z',
      },
    ],
  }, 'solidarity_calendar');

  // The child claims the slot via RECURRENCE-ID, and the parent must NOT also EXDATE it:
  // excluding an overridden slot deletes the instance the override exists to replace, so
  // the moved occurrence disappears (confirmed by expanding the feed in a real parser).
  assert.doesNotMatch(ics, /^EXDATE/m,
    'the only exception here is a move, which is an override rather than a deletion');
  assert.match(ics, /^RECURRENCE-ID:20260921T170000Z$/m);
  assert.equal((ics.match(/^RRULE:/gm) || []).length, 1,
    'exactly one series in the feed, not two');
  assert.equal((ics.match(/^UID:parent-1$/gm) || []).length, 2,
    'parent and its modified occurrence share a UID');
});

test('no two components in a feed claim the same instance', () => {
  // Counting UIDs cannot tell a correct shared-UID pair from a collision. The identity of
  // a component is (UID, RECURRENCE-ID); duplicates there mean a client silently drops one.
  const both = '20260921T170000Z,20261005T170000Z';
  const ics = ICSService.generateICS({
    title: 'Series with two moved occurrences',
    events: [
      series({ recurrenceException: both }),
      { id: 'c1', title: 'Standup', description: '',
        start: '2026-09-21T21:00:00.000Z', end: '2026-09-21T21:30:00.000Z',
        recurrenceID: 'parent-1', recurrenceException: both },
      { id: 'c2', title: 'Standup', description: '',
        start: '2026-10-05T21:00:00.000Z', end: '2026-10-05T21:30:00.000Z',
        recurrenceID: 'parent-1', recurrenceException: both },
    ],
  }, 'two-moves');

  const keys = ics.split('BEGIN:VEVENT').slice(1).map(block => {
    const uid = (/^UID:(\S+)$/m.exec(block) || [])[1];
    const rid = (/^RECURRENCE-ID.*?:(\S+)$/m.exec(block) || [])[1] || '';
    return `${uid}|${rid}`;
  });

  assert.equal(new Set(keys).size, keys.length,
    `duplicate component identity in feed: ${keys.join(' , ')}`);
});
