/**
 * The calendar's own fields (title, notes, type labels, zone...) merge field by field when a snapshot arrives, as its
 * events do (CalendarDataService.mergeMeta, used by app.js applyRemoteCalendar).
 *
 * applyRemoteCalendar merged events three ways but then called calendar.import(), a bare Object.assign: the options
 * were replaced whole. Notes typed while someone else added an event lost every keystroke still inside the 500 ms save
 * debounce: the snapshot carrying the event put the server's notes back (stress A01). A whole-object write, the same
 * root as the events' old last-write-wins.
 *
 * Run: node --test test/unit/meta-merge.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDataService } = require('./helpers/data-service-harness');

const CDS = loadDataService().S;
const plain = (v) => JSON.parse(JSON.stringify(v));   // (out of the sandbox's realm)
const merge = (b, m, t) => plain(CDS.mergeMeta(b, m, t));
const opts = (o) => ({ notes: 'Old notes', typeLabels: ['Type 1', 'Type 2', 'Type 3'], tz: 'America/Los_Angeles', ...o });

test('notes being typed survive a snapshot that carries someone else\'s change', () => {
    const base = { title: 'Team', options: opts() };
    const mine = { title: 'Team', options: opts({ notes: 'Old notes and a new line' }) };
    assert.deepEqual(merge(base, mine, base), mine, 'a snapshot with nothing new for these fields');
    assert.deepEqual(merge(base, mine, { title: 'Team 2026', options: opts() }), { title: 'Team 2026', options: opts({ notes: 'Old notes and a new line' }) },
        'their rename and my notes, both');
});

test('each field on its own: theirs where this tab changed nothing, mine where it did, type labels label by label', () => {
    const base = { title: 'Team', options: opts() };
    const mine = { title: 'Team', options: opts({ typeLabels: ['Practice', 'Type 2', 'Type 3'] }) };
    const theirs = { title: 'Team', options: opts({ typeLabels: ['Type 1', 'Type 2', 'Games'], notes: 'Their notes' }) };
    assert.deepEqual(merge(base, mine, theirs), { title: 'Team', options: opts({ typeLabels: ['Practice', 'Type 2', 'Games'], notes: 'Their notes' }) });
    assert.deepEqual(merge(base, base, theirs), theirs, 'no local change: the snapshot as it is');
    const gone = { title: 'Team', options: { notes: 'Old notes', typeLabels: base.options.typeLabels } };
    assert.deepEqual(merge(base, base, gone), gone, 'an option they removed is removed');
    assert.deepEqual(merge(base, mine, { title: 'Team', options: opts({ typeLabels: ['Drills', 'Type 2', 'Type 3'] }) }).options.typeLabels,
        ['Practice', 'Type 2', 'Type 3'], 'both renamed one label: this tab\'s, the one it is about to send');
});

test('applyRemoteCalendar merges the title and options, and the watcher compares them too', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
    const body = src.slice(src.indexOf('        applyRemoteCalendar(c, {'), src.indexOf('        hasTypeLabel(index) {'));
    assert.match(body, /CalendarDataService\.mergeMeta\(/, 'the calendar\'s own fields are merged before import()');
    assert.match(body, /remoteAppliedSignature = this\.calendarSignature\(\)/);
    assert.match(src, /calendarSignature\(\) \{\s*return JSON\.stringify\(\[this\.calendar\.events \|\| \[\], this\.calendar\.title \?\? '', this\.calendar\.options \|\| \{\}\]\);/);
});

test('the baseline remembers the title and options of each snapshot', () => {
    CDS._rememberSnapshot({ id: 'm', title: 'A', options: { notes: '1' }, events: [] });
    CDS._rememberSnapshot({ id: 'm', title: 'B', options: { notes: '2' }, events: [] });
    assert.deepEqual(plain(CDS._previousSeenMeta.m), { title: 'A', options: { notes: '1' } });
    assert.deepEqual(plain(CDS._lastSeenMeta.m), { title: 'B', options: { notes: '2' } });
    CDS._rememberSnapshot({ id: 'm', events: [] });   // an events-only snapshot (Firebase's journal path)
    assert.deepEqual(plain(CDS._lastSeenMeta.m), { title: 'B', options: { notes: '2' } });
});
