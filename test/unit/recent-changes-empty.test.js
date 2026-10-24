/**
 * Recent changes must never list a change that changed nothing.
 *
 * The bug: on Cloudflare data, the first edit in a tab is followed by a settings-only
 * write (the option defaults the app fills in on load: customViewDuration, typeLabels).
 * The room recorded it as an 'edited' history entry with 0 removed, 0 changed, 0 added,
 * and the panel's wording fell through to its last line: "0 events added", between the
 * two real edits of the same event. Rooms no longer record such writes, but entries
 * already stored must not show either. Run on the real methods extracted from app.js.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC } = require('./helpers/data-service-harness');

const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

// Source of a Vue method (`        [async ]name(args) { ... }`), brace-matched.
function method(name) {
  const m = new RegExp(`\\n {8}(async )?${name}\\(`).exec(APP);
  assert.ok(m, `${name} not found in app.js — renamed?`);
  const i = m.index;
  let j = APP.indexOf('{', APP.indexOf(')', i)), d = 0, k = j;
  for (; k < APP.length; k++) {
    if (APP[k] === '{') d++;
    else if (APP[k] === '}') { d--; if (!d) break; }
  }
  return APP.slice(i, k + 1).trim();
}

function loadApp(rows, events) {
  const ctx = { console, JSON, Date, Map, Set, Math, Object, Array, String };
  vm.createContext(ctx);
  ctx.CalendarDataService = { loadUndoEntries: async () => JSON.parse(JSON.stringify(rows)) };
  const names = ['loadUndoEntries', 'describeChange', 'isEmptyChange', 'describeEventDiff', 'describeEventTime',
    'describeWhen', 'describeAgo', 'describeExact', 'collapseSessions', 'describeSession',
    'serverNow', 'eventKey', 'eventName', 'refreshRelativeTimes'];
  // isEmptyChange is optional so this file runs (and fails on behavior) against a build without it.
  const src = names.filter(n => n !== 'isEmptyChange' || APP.includes('\n        isEmptyChange('))
    .map(n => n === 'refreshRelativeTimes' ? 'refreshRelativeTimes() {}' : method(n));
  vm.runInContext(`this.app = {\n${src.join(',\n')}\n}`, ctx);
  const app = ctx.app;
  app.isExisting = true;
  app.calendar = { id: 'c', events };
  app.undoEntries = [];
  return app;
}

const lunch = (title, description) => ({ id: 'ev1', title, description, start: '2026-10-25T17:00:00.000Z',
  end: '2026-10-25T18:00:00.000Z', type: 2 });
const edit = (savedAt, from, to) => ({ savedAt, kind: 'edited', removed: 0, changed: 1, added: 0,
  removedEvents: [], changedEvents: [{ from, to, at: savedAt }], addedEvents: [], writer: 'w1' });
const T = Date.UTC(2026, 9, 24, 16, 18);

// Exactly what a room stored for: rename, settings-only write, notes edit (newest first).
const STORED = [
  { key: '4', ...edit(T + 4000, lunch('Team lunch v2', ''), lunch('Team lunch v2', 'bring napkins')) },
  { key: '3', savedAt: T + 2000, kind: 'edited', removed: 0, changed: 0, added: 0,
    removedEvents: [], changedEvents: [], addedEvents: [], writer: 'w1' },
  { key: '2', ...edit(T, lunch('Team lunch', ''), lunch('Team lunch v2', '')) },
];

test('a stored change that changed nothing is not listed as "0 events added"', async () => {
  const app = loadApp(STORED, [lunch('Team lunch v2', 'bring napkins')]);
  const rows = await app.loadUndoEntries();
  const what = [...rows].map(r => r.what);
  assert.ok(!what.some(w => /^0 events/.test(w)), `listed: ${JSON.stringify(what)}`);
  // With the empty entry gone, the two edits of one event are one row again.
  assert.deepEqual(what, ['Edited "Team lunch v2" 2 times']);
});

test('the wording never says "0 events" for an entry with no counts', () => {
  const app = loadApp([], []);
  for (const kind of ['edited', 'added', 'meta', 'save']) {
    const w = app.describeChange({ kind, removed: 0, changed: 0, added: 0 }, [], [], []);
    assert.ok(!/^0 /.test(w || ''), `${kind}: ${w}`);
  }
  assert.equal(app.describeChange({ kind: 'title-cleared', removed: 0, changed: 0, added: 0 }, [], [], []),
    'Calendar title cleared');
});

test('a cleared title is still listed (Firebase records it, with the calendar before)', async () => {
  const app = loadApp([{ key: 'k', savedAt: T, kind: 'title-cleared', removed: 0, changed: 0, added: 0,
    events: [lunch('Team lunch', '')] }], [lunch('Team lunch', '')]);
  const rows = await app.loadUndoEntries();
  assert.deepEqual([...rows].map(r => r.what), ['Calendar title cleared']);
});
