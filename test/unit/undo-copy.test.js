/**
 * What the toast says after an action (UndoService.describeDelete / describeEdit), shared by
 * both UIs, run on the real service with the real Event model and CalDate.
 *
 * Each case is something a tester saw:
 *   - deleting ONE occurrence of a series showed no toast at all (the action removes no
 *     row; it adds an exception date), so there was no Undo either;
 *   - a series and its edited occurrence counted as "Deleted 2 events" (counted by id,
 *     but an occurrence row's identity is its recurrenceID);
 *   - every edit read "Edited "Alpha"", saying nothing about where the drag landed;
 *   - an unchanged rule read as "repeat changed" because Syncfusion hands it back with a
 *     trailing ';'.
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadDataService } = require('./helpers/data-service-harness');

process.env.TZ = 'America/Los_Angeles';

function load() {
  const { ctx } = loadDataService();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/services/UndoService.js'), 'utf8')
    + ';this.UndoService = UndoService;', ctx);
  return { U: ctx.UndoService, Event: ctx.Event };
}
const { U, Event } = load();

const master = (ex, extra = {}) => ({ id: 'stand', title: 'Standup', start: '2026-10-05T13:00:00.000Z',
  end: '2026-10-05T13:30:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1', recurrenceException: ex,
  type: 1, ...extra });
const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

test('deleting one occurrence says which day, and offers undo', () => {
  const delta = U.deltaBetween([master(null)], [master('20261012T130000Z')]);
  assert.equal(U.describeDelete(delta), `Deleted "Standup" on ${day('2026-10-12T13:00:00Z')}`);
});

test('a series and its edited occurrence are one thing deleted', () => {
  const moved = { id: 'x', title: 'Standup', start: '2026-10-14T13:00:00.000Z', end: '2026-10-14T13:30:00.000Z',
    recurrenceID: 'stand', recurrenceException: '20261012T130000Z' };
  const delta = U.deltaBetween([master('20261012T130000Z'), moved], []);
  assert.equal(U.describeDelete(delta), 'Deleted every "Standup"');
  const plain = U.deltaBetween([{ id: 'a', title: 'A', start: 0, end: 1 }, { id: 'b', title: '', start: 0, end: 1 }], []);
  assert.equal(U.describeDelete(plain), 'Deleted 2 events');
  assert.equal(U.describeDelete(U.deltaBetween([{ id: 'b', title: '', start: 0, end: 1 }], [])), 'Deleted "Untitled event"');
});

test('an edit says what changed', () => {
  const a = { id: 'a', title: 'Alpha', start: '2026-10-05T14:00:00.000Z', end: '2026-10-05T15:00:00.000Z' };
  const now = new Date('2026-10-03T12:00:00Z');
  const moved = { ...a, start: '2026-10-06T22:00:00.000Z', end: '2026-10-06T23:00:00.000Z' };
  assert.match(U.describeEdit(U.deltaBetween([a], [moved])), /^Moved "Alpha" to (Tue|Oct 6) 3pm$/);
  assert.equal(U.describeEdit(U.deltaBetween([a], [{ ...a, title: 'Beta' }])), 'Renamed "Alpha" to "Beta"');
  const resized = { ...a, end: '2026-10-05T16:00:00.000Z' };
  assert.match(U.describeEdit(U.deltaBetween([a], [resized])), /^Changed "Alpha" to \w+ 7am–9am$/);
  assert.ok(now);
});

test('moving one occurrence names it as one occurrence', () => {
  const before = [master(null)];
  const after = [master('20261005T130000Z'), { id: 'n', title: 'Standup', start: '2026-10-14T13:00:00.000Z',
    end: '2026-10-14T13:30:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1',
    recurrenceID: 'stand', recurrenceException: '20261005T130000Z' }];
  assert.match(U.describeEdit(U.deltaBetween(before, after)), /^Moved "Standup" \(this occurrence\) to .+ 6am$/);
});

test('"this and following" reads as such', () => {
  const before = [master(null, { recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;COUNT=10' })];
  const after = [master(null, { recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;UNTIL=20261018T130000Z' }),
    { id: 'v2', title: 'Standup v2', start: '2026-10-19T13:00:00.000Z', end: '2026-10-19T13:30:00.000Z',
      recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;UNTIL=20261207T140000Z' }];
  // Compared with the series on that date: renamed, not "moved".
  assert.equal(U.describeEdit(U.deltaBetween(before, after)), 'Renamed "Standup" (this and following) to "Standup v2"');
});

test('a rule handed back with a trailing ";" is not a change', () => {
  const stored = master(null);
  const shown = { ...stored, recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;' };
  assert.equal(U.sameEvent(stored, shown), true);
  assert.equal(U.describeEventDiff(stored, shown), null);
  assert.equal(Event.ruleKey('RRULE:FREQ=DAILY;INTERVAL=1;'), Event.ruleKey('FREQ=DAILY'));
  // And the Event model keeps the stored spelling when the grid hands it back unchanged.
  const fromGrid = new Event({ Id: 'stand', Subject: 'Standup', StartTime: new Date(stored.start),
    EndTime: new Date(stored.end), RecurrenceRule: shown.recurrencerule, _storedRule: stored.recurrencerule,
    _storedStart: stored.start, _storedEnd: stored.end });
  assert.equal(fromGrid.recurrencerule, stored.recurrencerule);
});
