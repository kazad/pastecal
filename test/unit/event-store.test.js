/**
 * EventStore + ScheduleAdapter: the one owner of events, and its boundary with Syncfusion.
 * Each test names the production bug the rule prevents.
 *
 * Run: node --test test/unit/event-store.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const EventStore = require('../../public/services/EventStore.js');
const ScheduleAdapter = require('../../public/services/ScheduleAdapter.js');

const at = (d, h) => new Date(Date.UTC(2026, 8, d, h)).toISOString();
const ev = (id, title, d = 1, extra = {}) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1, description: '', ...extra });

/** A store over an in-memory list, recording every commit. */
function storeOf(list) {
    const s = { events: list, commits: [], errors: [] };
    s.store = new EventStore({
        getEvents: () => s.events,
        commit: (next, info) => { s.events = next; s.commits.push(info); },
        onError: (err) => s.errors.push(err.message),
    });
    return s;
}

test('normalize reads every stored spelling and keeps the id kind', () => {
    const a = EventStore.normalize({ Id: 5, Subject: ' Standup ', StartTime: at(1, 9), EndTime: at(1, 10), Type: '3' });
    assert.equal(a.id, 5); assert.equal(typeof a.id, 'number');
    assert.equal(a.title, 'Standup'); assert.equal(a.type, 3);
    const b = EventStore.normalize({ id: 'u-1', title: 'X', start: at(1, 9), end: at(1, 10), type: 0 });
    assert.equal(b.id, 'u-1'); assert.equal(b.type, 1);
});

test('#32: an event is found by its id whatever kind the caller has it as', () => {
    const s = storeOf([ev(5, 'Old grid event'), ev('21552eaf-uuid', 'Added with +Event')]);
    assert.ok(s.store.find({ id: '5' }), 'number id found by its text form');
    const r = s.store.dispatch({ type: 'update', key: { id: '5' }, changes: { description: 'note' } });
    assert.ok(r.ok);
    const row = s.events.find((e) => e.title === 'Old grid event');
    assert.equal(row.description, 'note');
    assert.equal(row.id, 5, 'stored id keeps its kind');
});

test('add gives a new event its own uuid; a clashing or missing id is replaced', () => {
    const s = storeOf([ev('a', 'A')]);
    s.store.dispatch({ type: 'add', event: ev(null, 'No id') });
    s.store.dispatch({ type: 'add', event: ev('a', 'Clash') });
    const ids = s.events.map((e) => e.id);
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.slice(1).every((id) => /^[0-9a-f-]{36}$/.test(id)));
});

test('an invalid change is refused whole, and reported -- never half-applied', () => {
    const s = storeOf([ev('a', 'A'), ev('b', 'B')]);
    const before = s.events;
    const r = s.store.dispatch({ type: 'batch', commands: [
        { type: 'update', key: { id: 'a' }, changes: { title: 'A2' } },
        { type: 'update', key: { id: 'b' }, changes: { end: at(1, 8) } },   // end before start
    ] });
    assert.equal(r.ok, false);
    assert.equal(s.events, before, 'list untouched');
    assert.equal(s.commits.length, 0, 'nothing saved');
    assert.match(s.errors[0], /end is before start/);
});

test('#41: an edit keeps only what THIS user changed, so a stale field cannot revert someone else', () => {
    // I open the editor on "Title / old notes". While it is open, someone else changes the
    // notes. I move the time and press Save: Syncfusion's record still says "old notes".
    const s = storeOf([ev('a', 'Title', 1, { description: 'old notes' })]);
    ScheduleAdapter.noteStart({ Id: 'a', Subject: 'Title', Description: 'old notes', StartTime: new Date(at(1, 9)), EndTime: new Date(at(1, 10)), Type: 1 });
    s.events = [{ ...s.events[0], description: 'newer, from someone else' }];      // the other person's edit lands
    const myRecord = { Id: 'a', Subject: 'Title', Description: 'old notes', StartTime: new Date(at(1, 11)), EndTime: new Date(at(1, 12)), Type: 1 };
    assert.ok(s.store.dispatch(ScheduleAdapter.toCommand({ changedRecords: [myRecord] }, s.store)).ok);
    assert.equal(s.events[0].start, at(1, 11), 'my move applied');
    assert.equal(s.events[0].description, 'newer, from someone else', 'their notes kept');
});

test('without a snapshot, an edit still only writes fields that differ from the stored row', () => {
    const s = storeOf([ev('a', 'Title', 1, { description: 'same' })]);
    s.store.dispatch(ScheduleAdapter.toCommand({ changedRecords: [{ Id: 'a', Subject: 'Title', Description: 'same', StartTime: new Date(at(1, 11)), EndTime: new Date(at(1, 12)), Type: 1 }] }, s.store));
    assert.deepEqual(Object.keys(s.commits[0].changed[0]).length > 0, true);
    assert.equal(s.events[0].start, at(1, 11));
});

test('the write gate is told exactly how many rows a change removes', () => {
    const s = storeOf([ev('m', 'Series', 1, { recurrencerule: 'FREQ=WEEKLY;' }), ev('x', 'Edited occurrence', 8, { recurrenceID: 'm' }), ev('k', 'Keep')]);
    s.store.dispatch({ type: 'batch', commands: [{ type: 'remove', key: { id: 'm' } }, { type: 'remove', key: { id: 'x', recurrenceID: 'm' } }] });
    assert.equal(s.commits[0].shrink, 2);
    assert.deepEqual(s.events.map((e) => e.title), ['Keep']);
    s.store.dispatch({ type: 'update', key: { id: 'k' }, changes: { title: 'Kept' } });
    assert.equal(s.commits[1].shrink, 0);
});

test('undo puts a deleted event back with its original id', () => {
    const s = storeOf([ev(5, 'Legacy'), ev('b', 'B')]);
    s.store.dispatch({ type: 'remove', key: { id: '5' } }, { label: 'Deleted "Legacy"' });
    assert.equal(s.events.length, 1);
    assert.equal(s.store.undo(), 'Deleted "Legacy"');
    const back = s.events.find((e) => e.title === 'Legacy');
    assert.equal(back.id, 5);
    assert.equal(s.store.canUndo, false);
});

test('undo of an edit restores only the fields that edit changed', () => {
    const s = storeOf([ev('a', 'A', 1, { description: 'd1' })]);
    s.store.dispatch({ type: 'update', key: { id: 'a' }, changes: { title: 'A2' } });
    s.events = s.events.map((e) => ({ ...e, description: 'd2 (someone else)' }));   // a concurrent edit arrives
    s.store.undo();
    assert.equal(s.events[0].title, 'A');
    assert.equal(s.events[0].description, 'd2 (someone else)', 'undo does not revert the other person');
});

test('an edited occurrence and its series can share an id; each is still addressed exactly', () => {
    const s = storeOf([ev(7, 'Series', 1, { recurrencerule: 'FREQ=WEEKLY;' }), ev(7, 'Moved occurrence', 8, { recurrenceID: 7 })]);
    s.store.dispatch({ type: 'update', key: { id: '7', recurrenceID: '7' }, changes: { title: 'Moved again' } });
    assert.deepEqual(s.events.map((e) => e.title), ['Series', 'Moved again']);
});

test('adapter: Syncfusion sees text ids only, and text is stored as typed', () => {
    const view = ScheduleAdapter.toView([ev(5, 'A'), ev('u', 'B', 2, { recurrenceID: 5 })]);
    assert.equal(view[0].Id, '5'); assert.equal(view[1].RecurrenceID, '5');
    const cmd = ScheduleAdapter.toCommand({ addedRecords: [{ Id: 'sf-guid', Subject: 'Tom &amp; Jerry &gt; 2', StartTime: new Date(at(3, 9)), EndTime: new Date(at(3, 10)), Type: 2 }] }, storeOf([]).store);
    const s = storeOf([]); s.store.dispatch(cmd);
    assert.equal(s.events[0].title, 'Tom & Jerry > 2');
    assert.notEqual(s.events[0].id, 'sf-guid', 'new events get our own id');
});

test('adapter: an edited occurrence points at its series by the series\' STORED id', () => {
    const s = storeOf([ev(5, 'Weekly', 1, { recurrencerule: 'FREQ=WEEKLY;' })]);
    const cmd = ScheduleAdapter.toCommand({
        changedRecords: [{ Id: '5', RecurrenceException: '20260908T090000Z' }],
        addedRecords: [{ Id: '5', RecurrenceID: '5', Subject: 'Moved', StartTime: new Date(at(8, 11)), EndTime: new Date(at(8, 12)), RecurrenceException: '20260908T090000Z' }],
    }, s.store);
    assert.ok(s.store.dispatch(cmd).ok);
    const occ = s.events.find((e) => e.title === 'Moved');
    assert.equal(occ.recurrenceID, 5, 'number, like the series id');
    assert.equal(s.events.find((e) => e.title === 'Weekly').recurrenceException, '20260908T090000Z');
});

test('changesBetween turns a whole-list restore into exact, undoable commands', () => {
    const cur = [ev('a', 'A'), ev('b', 'B'), ev(3, 'C')];
    const target = [ev('a', 'A changed'), ev(3, 'C'), ev('d', 'D')];
    const cmds = EventStore.changesBetween(cur, target);
    assert.deepEqual(cmds.map((c) => c.type).sort(), ['add', 'remove', 'update']);
    const s = storeOf(cur);
    s.store.dispatch({ type: 'batch', commands: cmds });
    assert.deepEqual(s.events.map((e) => e.title).sort(), ['A changed', 'C', 'D']);
    assert.equal(s.events.find((e) => e.title === 'C').id, 3);
    s.store.undo();
    assert.deepEqual(s.events.map((e) => e.title).sort(), ['A', 'B', 'C']);
});

// Shapes captured from Syncfusion 23.2.6 at actionBegin (Sep 26): an edited occurrence arrives
// as a changed record with a NEW Id pointing at the series; a deleted occurrence as a changed
// record carrying the series' own Id. Neither has the series' exception stamp yet.
test('edit one occurrence: series gets the stamp, the edited copy is a new row (Syncfusion format)', () => {
    const s = storeOf([ev(9, 'Weekly', 5, { recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;' })]);
    const args = { requestType: 'eventChange', changedRecords: [{ Id: 'd96c5db5-guid', Subject: 'Weekly (moved)', RecurrenceID: '9',
        StartTime: new Date('2026-10-12T23:00:00Z'), EndTime: new Date('2026-10-13T00:00:00Z'), RecurrenceRule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', Type: 1 }] };
    const r = s.store.dispatch(ScheduleAdapter.toCommand(args, s.store, { action: 'EditOccurrence', occurrenceStart: new Date('2026-10-12T21:00:00Z') }));
    assert.ok(r.ok);
    const master = s.events.find((e) => e.title === 'Weekly'), copy = s.events.find((e) => e.title === 'Weekly (moved)');
    assert.equal(master.recurrenceException, '20261012T210000Z');
    assert.equal(copy.recurrenceID, 9, 'points at the series by its stored (number) id');
    assert.equal(copy.recurrenceException, '20261012T210000Z');
    assert.equal(copy.recurrencerule, 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;');
    assert.equal(copy.start, '2026-10-12T23:00:00.000Z');
    assert.equal(s.commits[0].shrink, 0);
});

test('delete one occurrence: only the series stamp changes; nothing is removed', () => {
    const s = storeOf([ev(9, 'Weekly', 5, { recurrencerule: 'FREQ=WEEKLY;', recurrenceException: '20261012T210000Z' })]);
    const args = { requestType: 'eventRemove', changedRecords: [{ Id: '9', Subject: 'Weekly', RecurrenceID: '9', StartTime: new Date('2026-10-26T21:00:00Z'), RecurrenceRule: 'FREQ=WEEKLY;' }] };
    s.store.dispatch(ScheduleAdapter.toCommand(args, s.store, { action: 'DeleteOccurrence', occurrenceStart: new Date('2026-10-26T21:00:00Z') }));
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0].recurrenceException, '20261012T210000Z,20261026T210000Z');
    assert.equal(s.commits[0].shrink, 0);
    s.store.undo();
    assert.equal(s.events[0].recurrenceException, '20261012T210000Z', 'undo takes the stamp back off');
});

// Sep 26, live: editing a WHOLE series from one of its occurrences. Syncfusion's record at
// actionBegin (EditSeries) carries the occurrence's RecurrenceID = the series' own id.
test('edit a whole series from an occurrence: the series stays a series (#series-vanished)', () => {
    const rule = 'FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;INTERVAL=1;';
    const s = storeOf([ev('series-1', 'Morning routine', 5, { recurrencerule: rule })]);
    const args = { requestType: 'eventChange', changedRecords: [{ Id: 'series-1', Subject: 'Daily routine', RecurrenceID: 'series-1',
        StartTime: new Date(at(5, 9)), EndTime: new Date(at(5, 10)), RecurrenceRule: rule, Type: 1 }] };
    const r = s.store.dispatch(ScheduleAdapter.toCommand(args, s.store, { action: 'EditSeries' }));
    assert.ok(r.ok, r.error && r.error.message);
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0].title, 'Daily routine');
    assert.equal(s.events[0].recurrenceID ?? null, null, 'still the series, not an occurrence of itself');
    assert.equal(s.events[0].recurrencerule, rule);
});

test('an update can never change which row it is', () => {
    const s = storeOf([ev('a', 'A')]);
    s.store.dispatch({ type: 'update', key: { id: 'a' }, changes: { id: 'zzz', recurrenceID: 'a', title: 'A2' } });
    assert.deepEqual([s.events[0].id, s.events[0].recurrenceID ?? null, s.events[0].title], ['a', null, 'A2']);
});

test('a change that would orphan an edited occurrence is refused and reported, not saved', () => {
    const s = storeOf([ev('m', 'Series', 1, { recurrencerule: 'FREQ=WEEKLY;' })]);
    const before = s.events;
    const r = s.store.dispatch({ type: 'add', event: ev(null, 'Occurrence of nothing', 8, { recurrenceID: 'missing-series' }) });
    assert.equal(r.ok, false);
    assert.equal(s.events, before);
    assert.equal(s.commits.length, 0);
    assert.match(s.errors[0], /repeating series that is not in the calendar/);
});

// Sep 26: "delete entire series" from an occurrence. At actionBegin Syncfusion lists the
// series under changedRecords (with RecurrenceID = its own id) and deletes nothing; only
// currentAction = DeleteSeries says what the user meant.
test('delete a whole series from an occurrence: the series and its edited occurrences go', () => {
    const s = storeOf([ev(9, 'Weekly', 5, { recurrencerule: 'FREQ=WEEKLY;' }), ev('x', 'Weekly (one)', 12, { recurrenceID: 9 }), ev(5, 'Other')]);
    const args = { requestType: 'eventRemove', changedRecords: [{ Id: '9', Subject: 'Weekly', RecurrenceID: '9', RecurrenceRule: 'FREQ=WEEKLY;' }], deletedRecords: [] };
    const r = s.store.dispatch(ScheduleAdapter.toCommand(args, s.store, { action: 'DeleteSeries' }));
    assert.ok(r.ok, r.error && r.error.message);
    assert.deepEqual(s.events.map((e) => e.title), ['Other']);
    assert.equal(s.commits[0].shrink, 2);
    s.store.undo();
    assert.equal(s.events.length, 3, 'undo brings the series back');
});

test('an unmapped action on a repeating event is refused, never guessed', () => {
    const s = storeOf([ev(9, 'Weekly', 5, { recurrencerule: 'FREQ=WEEKLY;' })]);
    assert.throws(() => ScheduleAdapter.toCommand({ requestType: 'eventChange', changedRecords: [{ Id: '9', RecurrenceRule: 'FREQ=WEEKLY;' }] }, s.store, { action: 'EditFollowingEvents' }),
        /unsupported action EditFollowingEvents/);
});

// Syncfusion's EditSeries rule: after "match every occurrence to the series again?",
// Yes clears the skipped dates and the separately edited occurrences; No keeps both.
for (const [answer, keep] of [['Yes', false], ['No', true]]) {
test(`edit a whole series after editing one occurrence, "${answer}" to resetting occurrences`, () => {
    const s = storeOf([ev(9, 'Weekly', 5, { recurrencerule: 'FREQ=WEEKLY;', recurrenceException: '20261012T210000Z' }),
        ev('x', 'Weekly (one)', 12, { recurrenceID: 9, recurrenceException: '20261012T210000Z', recurrencerule: 'FREQ=WEEKLY;' })]);
    const args = { requestType: 'eventChange', changedRecords: [{ Id: '9', Subject: 'Weekly all', RecurrenceID: '9', RecurrenceRule: 'FREQ=WEEKLY;',
        RecurrenceException: '20261012T210000Z', StartTime: new Date(at(5, 9)), EndTime: new Date(at(5, 10)), Type: 1 }] };
    const r = s.store.dispatch(ScheduleAdapter.toCommand(args, s.store, { action: 'EditSeries', keepOccurrences: keep }));
    assert.ok(r.ok, r.error && r.error.message);
    const master = s.events.find((e) => e.id === 9);
    assert.equal(master.title, 'Weekly all');
    assert.equal(master.recurrenceID ?? null, null);
    if (keep) {
        assert.equal(master.recurrenceException, '20261012T210000Z');
        assert.ok(s.events.find((e) => e.title === 'Weekly (one)'), 'edited occurrence kept');
    } else {
        assert.equal(master.recurrenceException ?? null, null);
        assert.equal(s.events.length, 1, 'edited occurrence removed');
        assert.equal(s.commits[0].shrink, 1);
    }
});
}
