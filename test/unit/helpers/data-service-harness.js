// Loads the real CalendarDataService (and Event) into a sandbox with an in-memory stand-in
// for the Firebase transaction API, so the write path -- gate, merge, commit callback --
// runs end to end instead of being re-implemented in the test.
//
// The fake transaction follows the SDK's contract where it matters: the update function
// gets a deep copy of the node (null when absent), returning undefined ABORTS (no retry;
// the completion callback receives (null, false, null)), and a committed write hands the
// callback a snapshot of what was stored.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '../../../public');
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function loadDataService() {
  const errors = [];
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
    Date, JSON, Map, Set, Object, Array, String, Math, Error, setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(`
    var firebase = { database: () => ({ ref: () => ({}) }) };
    var Utils = { debounce: (f) => f, uuidv4: () => Math.random().toString(36).slice(2) };`, ctx);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'models/Event.js'), 'utf8') +
    ';this.Event = Event;', ctx);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'services/CalendarDataService.js'), 'utf8') +
    ';this.CalendarDataService = CalendarDataService;', ctx);
  const S = ctx.CalendarDataService;

  const server = {};
  S.db = {
    child: (id) => ({
      transaction(fn, done) {
        const result = fn(server[id] === undefined ? null : clone(server[id]));
        if (result === undefined) { done(null, false, null); return; }
        server[id] = clone(result);
        done(null, true, { val: () => clone(server[id]) });
      },
    }),
  };

  // What a live subscription does when the server pushes a value.
  const deliver = (id) => {
    S.connected = id;
    S._rememberSnapshot({ id, ...clone(server[id]) });
  };

  return { S, server, deliver, errors, ctx };
}

const ev = (id, title, extra = {}) => ({ id, title, start: '2026-09-17T10:00:00.000Z',
  end: '2026-09-17T11:00:00.000Z', type: 1, ...extra });

module.exports = { loadDataService, ev, clone, PUBLIC };
