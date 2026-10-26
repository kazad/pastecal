/**
 * Issue #48 (Oct 2026): "Every year on October last Mon" did not show in 2027. Syncfusion 23.2.6 expands a
 * yearly BYSETPOS rule on the wrong years, so ScheduleAdapter shows it the grid as the same rule every 12
 * months, which Syncfusion draws right, and turns it back on the way out. The stored rule never changes.
 *
 * Run: node --test test/unit/yearly-nth-weekday.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
global.Event = require('../../public/models/Event.js');
const ScheduleAdapter = require('../../public/services/ScheduleAdapter.js');

const LAST_MON_OCT = 'FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;';
const ev = (rule, start = new Date(2026, 9, 26, 10), extra = {}) => ({ id: 's1', title: 'Board meeting', type: 1,
    start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), recurrencerule: rule, ...extra });
const view = (e) => ScheduleAdapter.toView([e])[0];

test('the grid gets the every-12-months form; the stored rule comes back unchanged', () => {
    const r = view(ev(LAST_MON_OCT));
    assert.equal(r.RecurrenceRule, 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;INTERVAL=12;');
    assert.equal(ScheduleAdapter.fromRecord(r).recurrencerule, LAST_MON_OCT);
    assert.equal(ScheduleAdapter.editorRule(r), LAST_MON_OCT);
});

test('every 2 years, a COUNT, and a rule Syncfusion changed (an UNTIL added) map back to yearly', () => {
    const r = view(ev('FREQ=YEARLY;BYDAY=TH;BYSETPOS=4;BYMONTH=10;INTERVAL=2;COUNT=5;', new Date(2026, 9, 22, 9)));
    assert.equal(r.RecurrenceRule, 'FREQ=MONTHLY;BYDAY=TH;BYSETPOS=4;COUNT=5;INTERVAL=24;');
    assert.equal(ScheduleAdapter.fromRecord(r).recurrencerule, 'FREQ=YEARLY;BYDAY=TH;BYSETPOS=4;BYMONTH=10;INTERVAL=2;COUNT=5;');
    const split = { ...view(ev(LAST_MON_OCT)), RecurrenceRule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;INTERVAL=12;UNTIL=20301231T000000Z;' };
    assert.equal(ScheduleAdapter.fromRecord(split).recurrencerule, 'FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;UNTIL=20301231T000000Z;BYMONTH=10;INTERVAL=1;');
});

test('an all-day series keeps its stored text too', () => {
    const r = view(ev(LAST_MON_OCT, new Date(2026, 9, 26), { isAllDay: true }));
    assert.equal(r.RecurrenceRule, 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;INTERVAL=12;');
    assert.equal(ScheduleAdapter.fromRecord(r).recurrencerule, LAST_MON_OCT);
});

test('other rules are shown as stored', () => {
    for (const [rule, start] of [
        ['FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;INTERVAL=1;', new Date(2026, 9, 26, 10)],
        ['FREQ=YEARLY;BYMONTHDAY=26;BYMONTH=10;INTERVAL=1;', new Date(2026, 9, 26, 10)],
        ['FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=11;INTERVAL=1;', new Date(2026, 9, 26, 10)],   // BYMONTH is not the start's month
        ['FREQ=YEARLY;BYDAY=MO,TU;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;', new Date(2026, 9, 26, 10)],
        ['FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', new Date(2026, 9, 26, 10)],
    ]) {
        const r = view(ev(rule, start));
        assert.equal(r.RecurrenceRule, rule, rule);
        assert.equal(r._gridRule, undefined, rule);
        assert.equal(ScheduleAdapter.fromRecord(r).recurrencerule, rule, rule);
    }
});
