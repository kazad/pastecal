// Calendar names the site routes itself (L3): the Worker refuses to create them
// (cloudflare/src/SlugService.js RESERVED_CALENDAR_NAMES), and both apps' checkExists call
// them taken so the claim dialog offers another name. The three lists must stay the same.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const words = (src) => [...src.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

test('the Worker and both apps reserve the same calendar names', () => {
  const server = /RESERVED_CALENDAR_NAMES = new Set\(\[([\s\S]*?)\]\)/.exec(read('cloudflare/src/SlugService.js'));
  assert.ok(server, 'RESERVED_CALENDAR_NAMES not found');
  const want = words(server[1]);
  for (const name of ['report', 'signin', 'pro', 'pricing', 'explore']) assert.ok(want.includes(name), `${name} is reserved`);
  for (const file of ['public/services/CalendarDataService.js', 'public/services/CloudCalendarService.js']) {
    const m = /static (?:async )?checkExists[\s\S]*?\[([^\]]*)\]\.includes/.exec(read(file));
    assert.ok(m, `${file}: checkExists list not found`);
    assert.deepEqual(words(m[1]), want, `${file} lists the same names as the Worker`);
  }
});

test('read-only link names cannot take report or explore either', () => {
  const src = read('cloudflare/src/SlugService.js');
  const m = /RESERVED_WORDS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  for (const name of ['report', 'explore', 'signin', 'pro', 'pricing']) assert.ok(words(m[1]).includes(name), name);
});
