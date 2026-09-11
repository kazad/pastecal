/**
 * Tests for recurrence in the ICS feed (functions/index.js).
 *
 * The feed emitted RRULE but never EXDATE or RECURRENCE-ID, so the two things people do
 * most often to a recurring series were invisible to every subscriber:
 *
 *   - Delete one occurrence. The app removed it and recorded the date in
 *     recurrenceException, but the feed still emitted the bare RRULE, so Google/Apple/
 *     Outlook kept generating the cancelled meeting forever.
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
    'without EXDATE subscribers keep seeing a meeting that was cancelled');
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

  // The parent excludes the original slot; the child fills it via RECURRENCE-ID. A
  // subscriber therefore sees exactly one standup that week, at the new time.
  assert.match(ics, /^EXDATE:20260921T170000Z$/m);
  assert.match(ics, /^RECURRENCE-ID:20260921T170000Z$/m);
  assert.equal((ics.match(/^RRULE:/gm) || []).length, 1,
    'exactly one series in the feed, not two');
  assert.equal((ics.match(/^UID:parent-1$/gm) || []).length, 2,
    'parent and its modified occurrence share a UID');
});
