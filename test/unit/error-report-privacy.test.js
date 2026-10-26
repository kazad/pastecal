/**
 * A failed save is reported to analytics (js_error) as a code and where it came from, never with an event's
 * text. Oct 2026: a save refused because its series had been deleted sent `"Dr. Patel - biopsy results for
 * Maria" would point at a repeating series...` as js_error.message.
 *
 * Run: node --test test/unit/error-report-privacy.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const EventStore = require('../../public/services/EventStore.js');
const ScheduleAdapter = require('../../public/services/ScheduleAdapter.js');

const SECRET = 'Dr. Patel - biopsy results for Maria';
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();

/** Every failure the store and the adapter can produce, with what onError would hand analytics. */
function failures() {
    const events = [{ id: 's1', title: SECRET, description: SECRET, start: at(19, 16), end: at(19, 17), recurrencerule: 'FREQ=DAILY;' }];
    const out = [];
    const store = new EventStore({ getEvents: () => events, commit: () => {}, onError: (err, command) => out.push({ err, command }) });
    store.dispatch({ type: 'add', event: { title: SECRET, start: at(20, 9), end: at(20, 10), recurrenceID: 'gone' }, label: `Edited "${SECRET}"` });
    store.dispatch({ type: 'add', event: { title: SECRET, start: 'not a date', end: at(20, 10) } });
    store.dispatch({ type: 'update', key: { id: 'missing-id' }, changes: { title: SECRET } });
    store.dispatch({ type: 'remove', key: { id: 'missing-id' } });
    store.dispatch({ type: 'batch', label: `Undo Deleted "${SECRET}"`, commands: [{ type: 'remove', key: { id: 'missing-id' } }] });
    // The adapter: an occurrence edited after its series was deleted, and an unmapped action.
    const empty = new EventStore({ getEvents: () => [], commit: () => {}, onError: () => {} });
    const rec = { Id: 'occ', RecurrenceID: 'gone', Subject: SECRET, StartTime: new Date(at(21, 16)), EndTime: new Date(at(21, 17)), RecurrenceRule: 'FREQ=DAILY;' };
    for (const action of ['EditOccurrence', 'DeleteOccurrence', 'EditSeries', 'DeleteSeries', 'EditFollowingEvents']) {
        try { ScheduleAdapter.toCommand({ requestType: 'eventChange', changedRecords: [rec] }, empty, { action, occurrenceStart: rec.StartTime }); }
        catch (err) { out.push({ err, command: { type: 'schedule', where: `eventChange/${action}` } }); }
    }
    return out;
}

test('analytics gets a code and a place for every failed save, never event text', () => {
    const all = failures();
    assert.ok(all.length >= 9, `expected every failure to be caught (${all.length})`);
    for (const { err, command } of all) {
        const sent = EventStore.report(err, command);
        assert.match(sent.message, /^[a-z_]+$/, `a code: ${sent.message}`);
        assert.match(sent.where, /^[\w/]+$/, `a place: ${sent.where}`);
        assert.ok(!JSON.stringify(sent).includes('Patel'), JSON.stringify(sent));
        // The error's own message is title-free too (it reaches the console and logs).
        assert.ok(!String(err.message).includes('Patel'), err.message);
    }
    const codes = all.map(({ err, command }) => EventStore.report(err, command).message);
    assert.ok(codes.includes('orphan_occurrence') && codes.includes('series_deleted'), codes.join());
});

test('the series-deleted refusal tells the person why; the orphan refusal keeps the title for the toast only', () => {
    const all = failures();
    assert.equal(all.find(({ err }) => err.code === 'series_deleted').err.userMessage, "This event's series was deleted.");
    assert.equal(all.find(({ err }) => err.code === 'orphan_occurrence').err.title, SECRET);
});

test('the apps report store failures through EventStore.report, never err.message', () => {
    for (const file of ['public/app.js', 'public/nativecal/app.js']) {
        const src = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
        const calls = src.match(/jsError\('command_failed'[^\n]*/g) || [];
        assert.ok(calls.length, `${file}: no command_failed report found`);
        for (const c of calls) assert.ok(!/err\.message|command\.label/.test(c), `${file}: ${c}`);
    }
});
