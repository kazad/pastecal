/**
 * YourName (public/services/YourName.js): the You tab's name, sent with saves so Activity says "Edited by <name>".
 * The browser and the server (CalendarRoom) clean it with the same clean(), so these rules are the stored ones.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const YourName = require('../../public/services/YourName.js');

test('clean: trimmed, spaces collapsed, control and bidi-override characters gone, at most 40 characters', () => {
    const rows = [
        ['  Sam Lee  ', 'Sam Lee'],
        ['Sam\n\tLee', 'Sam Lee'],
        ['\u0000\u0007Ann\u001b\u007f\u0085', 'Ann'],
        ['‮evil‬', 'evil'],
        ['x'.repeat(60), 'x'.repeat(40)],
        ['é'.repeat(39) + '😀😀', 'é'.repeat(39) + '😀'],     // code points, never half an emoji
        ['x'.repeat(39) + ' y', 'x'.repeat(39)],             // cut at a space: trimmed again
        ['', ''], ['   ', ''],
        [null, ''], [undefined, ''], [42, ''], [{ name: 'x' }, ''], [['Sam'], ''],
    ];
    for (const [input, want] of rows) assert.equal(YourName.clean(input), want, JSON.stringify(input));
});

test('initials: first letters of the first and last word, upper case; none without a name', () => {
    assert.equal(YourName.initials('Sam Lee'), 'SL');
    assert.equal(YourName.initials('sam'), 'S');
    assert.equal(YourName.initials('ana maria de la cruz'), 'AC');
    assert.equal(YourName.initials('😀 smile'), '😀S');
    assert.equal(YourName.initials('   '), '');
    assert.equal(YourName.initials(null), '');
});

test('get / set: kept in localStorage cleaned, removed when blank, and never throws when storage is blocked', () => {
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
    try {
        assert.equal(YourName.get(), '');
        assert.equal(YourName.set('  Sam  '), 'Sam');
        assert.equal(store.get(YourName.KEY), 'Sam');
        assert.equal(YourName.get(), 'Sam');
        store.set(YourName.KEY, '\u0000Bob\u0000');           // whatever is stored is cleaned on the way out too
        assert.equal(YourName.get(), 'Bob');
        assert.equal(YourName.set('   '), '');
        assert.equal(store.has(YourName.KEY), false);
        globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
        assert.equal(YourName.get(), '');
        assert.equal(YourName.set('Ann'), 'Ann');
    } finally {
        delete globalThis.localStorage;
    }
});
