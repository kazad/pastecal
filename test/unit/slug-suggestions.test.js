// What we offer when a chosen name is taken. 60 of the 83 failed claims in 30 days were
// "taken", and the only response was a blocking alert.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../../public/services/SlugManager.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.SlugManager = SlugManager;', ctx);
const { SlugManager } = ctx;

test('a plain name gets -2, the year, -team and -calendar', () => {
  assert.deepEqual([...SlugManager.suggestSlugs('soccer', 2026)],
    ['soccer-2', 'soccer-2026', 'soccer-team', 'soccer-calendar']);
});

test('a numbered name counts up instead of stacking suffixes', () => {
  const out = [...SlugManager.suggestSlugs('team-2', 2026)];
  assert.deepEqual(out.slice(0, 2), ['team-3', 'team-4']);
});

test('never suggests the name that was taken, or a year twice', () => {
  const out = [...SlugManager.suggestSlugs('trip-2026', 2026)];
  assert.ok(!out.includes('trip-2026'));
  assert.ok(!out.includes('trip-2026-2026'));
});

test('case and stray dashes are normalised; empty input suggests nothing', () => {
  assert.equal(SlugManager.suggestSlugs('Soccer-', 2026)[0], 'soccer-2');
  assert.deepEqual([...SlugManager.suggestSlugs('', 2026)], []);
  assert.deepEqual([...SlugManager.suggestSlugs(undefined, 2026)], []);
});

test('every suggestion is a valid, bounded slug', () => {
  for (const s of SlugManager.suggestSlugs('my-calendar', 2026)) {
    assert.ok(s.length <= 60 && !/[.#$\[\]\/\s]/.test(s), s);
  }
});
