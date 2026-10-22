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

// Links to calendars whose names are not plain ASCII opened a blank new calendar: the page
// accepted only [a-zA-Z0-9_-] (Oct 2026: 24 real calendars ending in a space, "TEAM NUÑEZ", ...).
test('slugFromPath reads any real calendar name from the path, decoded', () => {
  assert.equal(SlugManager.slugFromPath('/kalid'), 'kalid');
  assert.equal(SlugManager.slugFromPath('/royal%20city%20'), 'royal city ');
  assert.equal(SlugManager.slugFromPath('/TEAM%20NU%C3%91EZ'), 'TEAM NUÑEZ');
  assert.equal(SlugManager.slugFromPath('/d%26d8'), 'd&d8');
  assert.equal(SlugManager.slugFromPath('/%EA%B0%95%EC%95%84%EC%A7%80%EB%B4%89%EC%82%AC'), '강아지봉사');
  assert.equal(SlugManager.slugFromPath('/a-very-long-calendar-name-that-is-over-forty-characters'), 'a-very-long-calendar-name-that-is-over-forty-characters');
});

test('slugFromPath returns null for the homepage and for paths that cannot be a name', () => {
  for (const p of ['/', '', null, '/index.html', '/%20%20', '/bad%E0%A4%A', '/a%23b', '/' + 'x'.repeat(201)]) {
    assert.equal(SlugManager.slugFromPath(p), null, String(p));
  }
});
