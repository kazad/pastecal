/**
 * Activity names every change to an event (EventStore.describeChange, from the one field table EventStore.RECORD).
 *
 * Activity described an edit from its own hand-kept field list. It had no recurrenceException and no tz, so deleting
 * one occurrence of a series, or changing only an event's time zone, had no words: the row lost its event's name and
 * read "1 event edited" (stress A16). The same drift as the eight field lists EventStore.RECORD replaced. Now the words
 * are a table keyed by RECORD's fields, checked complete at load, and app.js's describeEventDiff only asks it.
 *
 * Run: node --test test/unit/change-words.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EventStore = require('../../public/services/EventStore.js');
globalThis.EventZone = require('../../public/services/EventZone.js');

const ev = { id: 'w', title: 'Weekly sync', description: '', start: '2026-10-06T17:00:00.000Z', end: '2026-10-06T18:00:00.000Z', type: 1, isAllDay: false,
    repeat: '', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;', recurrenceID: null, recurrenceException: null };

test('every field of the one list has words for a change to it', () => {
    assert.deepEqual(Object.keys(EventStore.RECORD).filter((f) => typeof (EventStore.CHANGE_WORDS || {})[f] !== 'function'), []);
});

test('a deleted occurrence and a zone-only change are described, so their row names the event', () => {
    const d = (to) => EventStore.describeChange(ev, { ...ev, ...to }, () => 'Tue, Oct 6');
    assert.equal(d({ recurrenceException: '20261013T170000Z' }), 'one date skipped');
    assert.equal(d({ tz: 'America/Vancouver' }), 'time zone set to Vancouver');
    assert.equal(EventStore.describeChange({ ...ev, tz: 'America/Vancouver' }, ev), 'time zone removed');
    assert.equal(d({ title: 'Game', start: '2026-10-06T18:00:00.000Z', end: '2026-10-06T19:00:00.000Z' }), 'renamed to "Game", moved to Tue, Oct 6');
    assert.equal(d({}), null, 'nothing a person would see');
    assert.equal(d({ start: new Date(ev.start) }), null, 'the same instant, another spelling');
});

test('Activity (app.js describeEventDiff) uses those words and keeps no field list of its own', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
    const body = src.slice(src.indexOf('describeEventDiff(from, to) {'), src.indexOf('collapseSessions(entries) {'));
    assert.match(body, /EventStore\.describeChange\(/);
    assert.doesNotMatch(body, /from\.(title|start|description|type|isAllDay|recurrencerule)/, 'no field named by hand');
});
