/**
 * Homepage "Start from" templates (public/utils/templates.js): every event lands in the month of
 * the date given, nothing overlaps in a way a person would call silly, each template's colors have
 * names, and the same date always gives the same calendar.
 *
 * Run: node --test test/unit/templates.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../public/utils/templates.js');

const IDS = T.list().map((t) => t.id);
// Every month of two years, mid-month and on the edges, including both DST changes.
const DATES = [];
for (const y of [2026, 2027]) for (let m = 0; m < 12; m++) DATES.push(new Date(y, m, 1), new Date(y, m, 15, 13), new Date(y, m + 1, 0, 23, 30));

test('five templates, in the chip order the homepage shows', () => {
    assert.deepEqual(T.list().map((t) => t.label), ['Sports team', 'Family', "Who's out", 'Volunteer shifts', 'Club or class']);
    assert.equal(T.build('nope', new Date()), null);
});

test('every event is in the month of the date given, and ends after it starts', () => {
    for (const id of IDS) for (const today of DATES) {
        const { events } = T.build(id, today);
        assert.ok(events.length >= 3, `${id}: a month with something in it`);
        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        for (const e of events) {
            const s = new Date(e.start), en = new Date(e.end);
            assert.ok(s >= first && s < next, `${id} ${e.title} starts in the month (${e.start}, ${today})`);
            assert.ok(en > s, `${id} ${e.title} ends after it starts`);
            assert.ok(en <= next || e.isAllDay, `${id} ${e.title} ends in the month`);
            if (e.isAllDay) {
                assert.equal(s.getHours(), 0, `${id} ${e.title} all-day starts at local midnight`);
                assert.equal(en.getHours(), 0, `${id} ${e.title} all-day ends at local midnight`);
            } else {
                assert.ok(s.getHours() >= 8 && en.getHours() <= 22, `${id} ${e.title} at a sensible time`);
                assert.equal(s.toDateString(), new Date(en - 1).toDateString(), `${id} ${e.title} within one day`);
            }
        }
    }
});

test('no two timed events overlap, and no one is both out and working from home', () => {
    for (const id of IDS) for (const today of DATES) {
        const { events } = T.build(id, today);
        const timed = events.filter((e) => !e.isAllDay);
        for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
            const a = timed[i], b = timed[j];
            assert.ok(a.end <= b.start || b.end <= a.start, `${id}: "${a.title}" and "${b.title}" overlap (${a.start})`);
        }
        // All-day: the same person (or the whole team, on the offsite) is never in two places a day.
        const days = new Map();
        for (const e of events.filter((x) => x.isAllDay)) {
            const who = e.title.split(':')[0];
            for (let d = new Date(e.start); d < new Date(e.end); d.setDate(d.getDate() + 1)) {
                const key = d.toDateString();
                const there = days.get(key) || [];
                assert.ok(!there.includes(who), `${id}: ${who} twice on ${key}`);
                if (there.includes('Team offsite') || (who === 'Team offsite' && there.length)) {
                    assert.fail(`${id}: someone else is out or remote on the offsite (${key}: ${there.concat(who)})`);
                }
                days.set(key, there.concat(who));
            }
        }
    }
});

test('each template uses 2-4 colors, every one with a name, and the rest of the labels untouched', () => {
    for (const id of IDS) {
        const t = T.build(id, new Date(2026, 9, 24));
        const types = [...new Set(t.events.map((e) => e.type))];
        assert.ok(types.length >= 2 && types.length <= 4, `${id} uses ${types.length} colors`);
        assert.equal(t.typeLabels.length, 8);
        for (const type of types) assert.doesNotMatch(t.typeLabels[type - 1], /^Type \d+$/, `${id} names type ${type}`);
        t.typeLabels.forEach((label, i) => {
            if (!types.includes(i + 1)) assert.equal(label, `Type ${i + 1}`, `${id} leaves slot ${i + 1} alone`);
        });
        assert.ok(t.title && t.title !== 'New Calendar', `${id} has a title`);
        assert.ok(t.notes.split('\n').length >= 3, `${id} has a few lines of notes`);
    }
});

test('the same date gives the same calendar; ids say which template an event came from', () => {
    for (const id of IDS) {
        const a = T.build(id, new Date(2026, 9, 24, 9));
        const b = T.build(id, new Date(2026, 9, 3, 22));
        assert.deepEqual(a, b, `${id}: deterministic for the month`);
        const ids = a.events.map((e) => e.id);
        assert.equal(new Set(ids).size, ids.length, `${id}: unique ids`);
        for (const e of a.events) assert.equal(T.templateOf(e), id);
    }
    assert.equal(T.templateOf({ id: 'a1b2c3' }), null);
    assert.equal(T.templateOf({ id: 'tpl-nope-1' }), null);
});

test('Sports team: practices on Tuesdays and Thursdays, a game every Saturday', () => {
    const { events } = T.build('team', new Date(2026, 9, 24));
    const days = (title) => events.filter((e) => e.title.startsWith(title)).map((e) => new Date(e.start).getDay());
    assert.ok(days('Practice').every((d) => d === 2 || d === 4));
    assert.deepEqual([...new Set(days('Game'))], [6]);
    assert.equal(days('Game').length, 5);   // October 2026 has five Saturdays
});
