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
  // The series starts at 23:00Z so these exceptions sit on real instances; one at another
  // time of day would now be snapped onto the series' grid (see the DST tests below).
  const block = ICSService.createEventBlock(series({
    start: '2026-03-03T23:00:00.000Z', end: '2026-03-03T23:30:00.000Z',
    recurrenceException: '20260310T230000Z,20260908T230000Z',
  }), DTSTAMP);

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

// --- Time zones, DST, slot assignment, validity -----------------------------------------

const field = (ics, name) => (new RegExp(`^${name}[^:\\r\\n]*:(.*?)\\r?$`, 'm').exec(ics) || [])[1];
const unfold = (ics) => ics.replace(/\r\n /g, '');

test('an all-day event keeps its date for users east and west of UTC', () => {
  // All-day dates are stored as the user's LOCAL midnight in UTC. Taking the UTC date put
  // Berlin's Sep 7 on Sep 6; the server can't know the zone, so it must recover the date.
  const cases = [
    ['UTC', '2026-09-07T00:00:00.000Z', '20260907', '20260908'],
    ['Berlin', '2026-09-06T22:00:00.000Z', '20260907', '20260908'],
    ['New York', '2026-09-07T04:00:00.000Z', '20260907', '20260908'],
    ['Honolulu', '2026-09-07T10:00:00.000Z', '20260907', '20260908'],
    ['Auckland, NZST (UTC+12)', '2026-09-06T12:00:00.000Z', '20260907', '20260908'],
    ['Auckland, NZDT (UTC+13)', '2026-12-06T11:00:00.000Z', '20261207', '20261208'],
  ];
  for (const [zone, start, date, nextDate] of cases) {
    const end = new Date(Date.parse(start) + 24 * 3600 * 1000).toISOString();
    const block = ICSService.createEventBlock({
      id: 'a', title: 'Day off', description: '', isAllDay: true, start, end,
    }, DTSTAMP);
    assert.equal(field(block, 'DTSTART'), date, zone);
    assert.equal(field(block, 'DTEND'), nextDate, zone);
  }
});

test('an all-day series east of UTC excludes the right day', () => {
  // Berlin, weekly from Mon Sep 7; the user deletes Mon Sep 14 (stored as 13th 22:00Z).
  const block = ICSService.createEventBlock({
    id: 'h', title: 'Gym', description: '', isAllDay: true,
    start: '2026-09-06T22:00:00.000Z', end: '2026-09-07T22:00:00.000Z',
    recurrencerule: 'FREQ=WEEKLY;INTERVAL=1;', recurrenceException: '20260913T220000Z',
  }, DTSTAMP);
  assert.equal(field(block, 'DTSTART'), '20260907');
  assert.equal(field(block, 'EXDATE'), '20260914');
});

test('an all-day moved occurrence east of UTC names the right day', () => {
  const ics = ICSService.generateICS({ events: [
    { id: 'p', title: 'Gym', description: '', isAllDay: true,
      start: '2026-09-06T22:00:00.000Z', end: '2026-09-07T22:00:00.000Z',
      recurrencerule: 'FREQ=WEEKLY;INTERVAL=1;', recurrenceException: '20260913T220000Z' },
    { id: 'p', title: 'Gym', description: '', isAllDay: true, recurrenceID: 'p',
      start: '2026-09-15T22:00:00.000Z', end: '2026-09-16T22:00:00.000Z',
      recurrenceException: '20260913T220000Z' },
  ] }, 'all-day-move');
  assert.match(ics, /^RECURRENCE-ID;VALUE=DATE:20260914\r?$/m);
  assert.match(ics, /^DTSTART;VALUE=DATE:20260916\r?$/m);
  assert.doesNotMatch(ics, /^EXDATE/m);
});

test('moved occurrences carrying the whole exception list never share one slot', () => {
  // Children saved through some paths carry the parent's full list, so each is ambiguous.
  // Both new dates (9/24, 9/22) are nearest 9/21; nearest-per-child gave both
  // RECURRENCE-ID 9/21 and clients dropped one meeting. Slots are now one-to-one.
  const both = '20260921T170000Z,20260928T170000Z';
  const ics = ICSService.generateICS({ events: [
    series({ recurrenceException: both }),
    { id: 'c1', title: 'Moved A', description: '', recurrenceID: 'parent-1',
      start: '2026-09-24T17:00:00.000Z', end: '2026-09-24T17:30:00.000Z', recurrenceException: both },
    { id: 'c2', title: 'Moved B', description: '', recurrenceID: 'parent-1',
      start: '2026-09-22T17:00:00.000Z', end: '2026-09-22T17:30:00.000Z', recurrenceException: both },
  ] }, 'ambiguous');
  const rids = [...ics.matchAll(/^RECURRENCE-ID:(\S+?)\r?$/gm)].map(m => m[1]);
  assert.deepEqual(rids.sort(), ['20260921T170000Z', '20260928T170000Z']);
});

test('two moved occurrences that are both nearest one slot each keep their own', () => {
  // Weekly 9/7 17:00Z. 9/21 moved to 9/24, and 9/28 moved to 9/22 -- both new dates are
  // nearest 9/21, so the old nearest-slot guess gave both RECURRENCE-ID 9/21 and clients
  // kept one, dropping the other meeting. Syncfusion stamps each moved occurrence with the
  // one slot it replaced; that stamp, not proximity, decides.
  const ics = ICSService.generateICS({ events: [
    series({ recurrenceException: '20260921T170000Z,20260928T170000Z' }),
    { id: 'c1', title: 'From the 21st', description: '', recurrenceID: 'parent-1',
      start: '2026-09-24T17:00:00.000Z', end: '2026-09-24T17:30:00.000Z',
      recurrencerule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceException: '20260921T170000Z' },
    { id: 'c2', title: 'From the 28th', description: '', recurrenceID: 'parent-1',
      start: '2026-09-22T17:00:00.000Z', end: '2026-09-22T17:30:00.000Z',
      recurrencerule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceException: '20260928T170000Z' },
  ] }, 'crossing');

  const blocks = ics.split('BEGIN:VEVENT').slice(1);
  const slotOf = (title) => {
    const b = blocks.find(x => x.includes(`SUMMARY:${title}`));
    return (b.match(/^RECURRENCE-ID:(\S+?)\r?$/m) || [])[1];
  };
  assert.equal(slotOf('From the 21st'), '20260921T170000Z');
  assert.equal(slotOf('From the 28th'), '20260928T170000Z');
  assert.doesNotMatch(ics, /^EXDATE/m, 'both slots are overrides, not deletions');
  assert.equal((ics.match(/^RRULE:/gm) || []).length, 1, 'children never re-emit the rule');
});

test('a child holding a single exception keeps exactly that slot', () => {
  // Syncfusion's EditOccurrence writes just the occurrence's own start, which is
  // authoritative; an accumulated list on another child must not take it away.
  const ics = ICSService.generateICS({ events: [
    series({ recurrenceException: '20260921T170000Z,20260928T170000Z' }),
    { id: 'c1', title: 'A', description: '', recurrenceID: 'parent-1',
      start: '2026-09-26T17:00:00.000Z', end: '2026-09-26T17:30:00.000Z',
      recurrenceException: '20260921T170000Z' },
    { id: 'c2', title: 'B', description: '', recurrenceID: 'parent-1',
      start: '2026-09-22T17:00:00.000Z', end: '2026-09-22T17:30:00.000Z',
      recurrenceException: '20260921T170000Z,20260928T170000Z' },
  ] }, 'single');
  const blocks = ics.split('BEGIN:VEVENT').slice(1);
  const ridOf = (title) => field(blocks.find(b => b.includes(`SUMMARY:${title}`)), 'RECURRENCE-ID');
  assert.equal(ridOf('A'), '20260921T170000Z');
  assert.equal(ridOf('B'), '20260928T170000Z');
});

test('exceptions recorded after a DST change still match the series', () => {
  // Berlin, Mondays 18:00 from Oct 5 (CEST, 16:00Z). After Oct 25 the app records 18:00
  // CET = 17:00Z, but the UTC RRULE still expands to 16:00Z, so neither EXDATE nor
  // RECURRENCE-ID matched: the deleted meeting stayed and the moved one appeared twice.
  const ics = ICSService.generateICS({ events: [
    series({ start: '2026-10-05T16:00:00.000Z', end: '2026-10-05T17:00:00.000Z',
      recurrenceException: '20261102T170000Z,20261109T170000Z' }),
    { id: 'c1', title: 'Moved', description: '', recurrenceID: 'parent-1',
      start: '2026-11-10T17:00:00.000Z', end: '2026-11-10T18:00:00.000Z',
      recurrenceException: '20261109T170000Z' },
  ] }, 'dst');
  assert.equal(field(ics, 'EXDATE'), '20261102T160000Z', 'the deletion lands on the instance');
  assert.equal(field(ics, 'RECURRENCE-ID'), '20261109T160000Z', 'so does the override');
});

test('RECURRENCE-ID takes the parent\'s value type, not the child\'s', () => {
  // A timed series whose moved occurrence was made all-day, and the reverse.
  const timedParent = ICSService.generateICS({ events: [
    series({ recurrenceException: '20260921T170000Z' }),
    { id: 'c', title: 'Now all day', description: '', recurrenceID: 'parent-1', isAllDay: true,
      start: '2026-09-22T00:00:00.000Z', end: '2026-09-23T00:00:00.000Z',
      recurrenceException: '20260921T170000Z' },
  ] }, 't');
  assert.match(timedParent, /^RECURRENCE-ID:20260921T170000Z\r?$/m);

  const allDayParent = ICSService.generateICS({ events: [
    { id: 'p', title: 'Holiday', description: '', isAllDay: true,
      start: '2026-09-06T22:00:00.000Z', end: '2026-09-07T22:00:00.000Z',
      recurrencerule: 'FREQ=WEEKLY', recurrenceException: '20260913T220000Z' },
    { id: 'c', title: 'Now timed', description: '', recurrenceID: 'p',
      start: '2026-09-14T09:00:00.000Z', end: '2026-09-14T10:00:00.000Z',
      recurrenceException: '20260913T220000Z' },
  ] }, 'a');
  assert.match(allDayParent, /^RECURRENCE-ID;VALUE=DATE:20260914\r?$/m);
});

test('an end before the start still yields a valid component', () => {
  const timed = ICSService.createEventBlock({
    id: 't', title: 'Backwards', description: '',
    start: '2026-09-07T17:00:00.000Z', end: '2026-09-07T16:00:00.000Z',
  }, DTSTAMP);
  assert.equal(field(timed, 'DTEND'), field(timed, 'DTSTART'),
    'a negative duration becomes a zero-length event at its start');

  const allDay = ICSService.createEventBlock({
    id: 'a', title: 'Same day', description: '', isAllDay: true,
    start: '2026-09-07T00:00:00.000Z', end: '2026-09-07T00:00:00.000Z',
  }, DTSTAMP);
  assert.equal(field(allDay, 'DTSTART'), '20260907');
  assert.equal(field(allDay, 'DTEND'), '20260908', 'an all-day event spans at least its day');
});

test('an all-day series gets a DATE UNTIL to match its DATE DTSTART', () => {
  const block = ICSService.createEventBlock({
    id: 'a', title: 'Camp', description: '', isAllDay: true,
    start: '2026-09-06T22:00:00.000Z', end: '2026-09-07T22:00:00.000Z',
    recurrencerule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20260912T220000Z;',
  }, DTSTAMP);
  assert.equal(field(block, 'RRULE'), 'FREQ=DAILY;INTERVAL=1;UNTIL=20260913;');

  const timed = ICSService.createEventBlock(
    series({ recurrencerule: 'FREQ=DAILY;UNTIL=20260912T170000Z' }), DTSTAMP);
  assert.equal(field(timed, 'RRULE'), 'FREQ=DAILY;UNTIL=20260912T170000Z', 'timed rules untouched');
});

test('a moved occurrence that falls back to standalone neither repeats nor reuses the series UID', () => {
  // Syncfusion gives the child the parent's id and rule. Without a slot it must not become
  // a second series, nor share a UID with the real one.
  const block = ICSService.createEventBlock({
    id: 'parent-1', title: 'Orphan', description: '', recurrenceID: 'parent-1',
    start: '2026-09-21T21:00:00.000Z', end: '2026-09-21T21:30:00.000Z',
    recurrencerule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceException: '',
  }, DTSTAMP);
  assert.doesNotMatch(block, /^RRULE/m);
  assert.notEqual(field(block, 'UID'), 'parent-1');
});

test('long lines are folded at 75 octets without splitting a character', () => {
  const text = 'Réunion d’équipe 👩‍💻 — ' + 'Ünïcødé ✓ 日本語 🎉 '.repeat(12);
  const ics = ICSService.generateICS({ title: text, events: [{
    id: 'f', title: text, description: text,
    start: '2026-09-07T17:00:00.000Z', end: '2026-09-07T18:00:00.000Z',
  }] }, 'fold');

  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `over 75 octets: ${line}`);
    assert.doesNotMatch(line, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/,
      'a surrogate pair was split across lines');
  }
  const escaped = ICSService.escapeText(text);
  assert.equal(field(unfold(ics), 'SUMMARY'), escaped, 'unfolding restores the text exactly');
  assert.equal(field(unfold(ics), 'X-WR-CALNAME'), escaped);
});

test('carriage returns in text are normalized, never emitted raw', () => {
  assert.equal(ICSService.escapeText('a\r\nb\rc\nd'), 'a\\nb\\nc\\nd');
  const block = ICSService.createEventBlock({
    id: 'cr', title: 'Line\rbreak', description: 'one\r\ntwo',
    start: '2026-09-07T17:00:00.000Z', end: '2026-09-07T18:00:00.000Z',
  }, DTSTAMP);
  assert.doesNotMatch(block.replace(/\r\n/g, ''), /\r/, 'no bare CR inside a content line');
  assert.match(block, /^DESCRIPTION:one\\ntwo\r?$/m);
});
