/**
 * Tests for the reliability instrumentation.
 *
 * Every bug found in the #41 investigation was silent in production: events destroyed by
 * concurrent writes, events dropped at the write boundary, a feed serving wrong recurrence
 * to subscribers who are not even on the site. The analytics module tracked adoption
 * thoroughly and correctness not at all, so the only detection channel was a user filing a
 * GitHub issue months later.
 *
 * These pin the properties that make the failures visible:
 *   - the new events exist and carry counts, never calendar contents
 *   - reporting never throws, because instrumentation must not become the outage
 *   - the write path exposes hooks for "we merged with someone" and "the write failed"
 *   - the ICS handler logs a structured, queryable line rather than prose
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

const ANALYTICS = fs.readFileSync(
  path.join(__dirname, '../../public/utils/analytics.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const SERVICE = fs.readFileSync(
  path.join(__dirname, '../../public/services/CalendarDataService.js'), 'utf8');

// Load the Analytics object with its sinks replaced by a recorder, so the real track()
// path is exercised rather than a copy of it.
function loadAnalytics() {
  const sent = [];
  const loc = { pathname: '/', search: '', hostname: 'localhost', href: 'http://localhost/' };
  // The module reads window.location at load time, so the stub window must carry it.
  const win = { gtag: null, location: loc, addEventListener() {} };

  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'navigator', 'document', 'location',
    'console', 'setTimeout', 'requestIdleCallback',
    `${ANALYTICS}; return typeof Analytics !== 'undefined' ? Analytics : null;`);
  const A = factory(
    win,
    { language: 'en-US', userAgent: 'test' },
    { referrer: '', title: 'test' },
    loc,
    { log() {}, warn() {}, error() {} },
    (fn) => { fn(); return 0; },
    undefined);
  assert.ok(A, 'Analytics should be defined by public/utils/analytics.js');

  A.SINKS.recorder = (name, params) => sent.push({ name, params });
  A.active = ['recorder'];
  A.enabled = true;
  return { A, sent };
}

// --- The events exist and report counts, not contents -----------------------------------

test('a dropped event is reported as a count, never as the event', () => {
  const { A, sent } = loadAnalytics();
  A.eventsDropped(2, 'incomplete');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, 'events_dropped');
  assert.equal(sent[0].params.count, 2);
  assert.equal(sent[0].params.reason, 'incomplete');

  const blob = JSON.stringify(sent[0].params);
  assert.doesNotMatch(blob, /title|start|end|description/,
    'an analytics payload must never carry what is on someone\'s calendar');
});

test('a merged write reports how much it reconciled', () => {
  const { A, sent } = loadAnalytics();
  A.syncMerged({ addedByOthers: 3, removedByOthers: 1, changedByOthers: 2 });

  assert.equal(sent[0].name, 'sync_merged');
  assert.equal(sent[0].params.added_by_others, 3);
  assert.equal(sent[0].params.removed_by_others, 1);
  assert.equal(sent[0].params.changed_by_others, 2);
});

test('sync_merged fires only for concurrent server changes, never for our own edits', () => {
  // It used to diff local ids against the server, so a lone user's ADD was reported as
  // "removed_by_us" and every ordinary add/delete counted as a collision.
  const { loadDataService, ev } = require('./helpers/data-service-harness');
  const { S, server, deliver } = loadDataService();
  server.c = { id: 'c', events: [ev('A', 'A'), ev('B', 'B'), ev('C', 'C')] };
  deliver('c');
  const merges = [];
  S.onSyncMerged = (m) => merges.push({ ...m });

  // Single client: add, then delete, then edit.
  S.sync({ id: 'c', events: [ev('A', 'A'), ev('B', 'B'), ev('C', 'C'), ev('MINE', 'mine')] });
  S.declareIntent(1);
  S.sync({ id: 'c', events: [ev('A', 'A'), ev('B', 'B'), ev('MINE', 'mine')] });
  S.sync({ id: 'c', events: [ev('A', 'A2'), ev('B', 'B'), ev('MINE', 'mine')] });
  assert.deepEqual(merges, [], 'our own adds, deletes and edits are not collisions');

  // Someone else adds X, edits B and deletes MINE before our next write lands.
  server.c.events = [ev('A', 'A2'), ev('B', 'B by Bob'), ev('X', 'Bob')];
  S.sync({ id: 'c', events: [ev('A', 'A3'), ev('B', 'B'), ev('MINE', 'mine')] });
  assert.deepEqual(merges, [{ addedByOthers: 1, removedByOthers: 1, changedByOthers: 1 }]);
});

test('a JS error reports its message and origin, bounded in length', () => {
  const { A, sent } = loadAnalytics();
  A.jsError('error', 'x'.repeat(500), 'y'.repeat(400));

  assert.equal(sent[0].name, 'js_error');
  assert.equal(sent[0].params.kind, 'error');
  assert.ok(sent[0].params.message.length <= 200, 'message is truncated');
  assert.ok(sent[0].params.where.length <= 120, 'origin is truncated');
});

test('reporting survives junk input rather than throwing', () => {
  // Instrumentation must never become the failure it is reporting.
  const { A } = loadAnalytics();
  assert.doesNotThrow(() => A.eventsDropped(undefined, undefined));
  assert.doesNotThrow(() => A.syncMerged(undefined));
  assert.doesNotThrow(() => A.jsError(undefined, undefined, undefined));
  assert.doesNotThrow(() => A.icsFailed(undefined));
});

test('a sink that throws does not reach the caller', () => {
  const { A } = loadAnalytics();
  A.SINKS.exploding = () => { throw new Error('sink is broken'); };
  A.active = ['exploding'];

  assert.doesNotThrow(() => A.eventsDropped(1, 'incomplete'),
    'a broken sink must never affect a calendar operation');
});

// --- The wiring -------------------------------------------------------------------------

// Run app.js's real error reporter (track() and the installErrorReporting IIFE, sliced out
// of the shipped file) against a fake window, and dispatch errors at it. These used to
// regex-match the source for `seen.has(key)`, which passes whether or not the dedupe works.
function loadErrorReporter() {
  const start = APP.indexOf('function track(');
  const iife = APP.indexOf('(function installErrorReporting');
  const end = APP.indexOf('})();', iife);
  assert.ok(start >= 0 && iife > start && end > iife,
    'app.js must define track() and then the installErrorReporting IIFE');
  const listeners = {};
  const reports = [];
  const sandbox = {
    window: { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } },
    Analytics: { jsError: (kind, message, where) => reports.push({ kind, message, where }) },
    String, Set,
  };
  vm.runInNewContext(APP.slice(start, end + '})();'.length), sandbox);
  const fire = (type, e) => (listeners[type] || []).forEach(fn => fn(e));
  return { listeners, reports, fire };
}

test('uncaught errors and rejected promises are reported, with message and origin', () => {
  const { reports, fire } = loadErrorReporter();
  fire('error', { error: new Error('boom'), filename: 'https://x/app.js', lineno: 12 });
  fire('unhandledrejection', { reason: { code: 'PERMISSION_DENIED' } });
  assert.deepEqual(reports, [
    { kind: 'error', message: 'boom', where: 'app.js:12' },
    { kind: 'unhandledrejection', message: 'PERMISSION_DENIED', where: 'promise' },
  ]);
});

test('repeated failures are reported once, not once per repaint', () => {
  // A render loop throwing every frame is one signal, not thousands of hits.
  const { reports, fire } = loadErrorReporter();
  for (let i = 0; i < 50; i++) fire('error', { message: 'same', filename: 'a.js', lineno: 1 });
  assert.equal(reports.length, 1, 'duplicate failures are suppressed');
});

test('an error storm is capped', () => {
  const { reports, fire } = loadErrorReporter();
  for (let i = 0; i < 500; i++) fire('error', { message: `distinct ${i}`, filename: 'a.js', lineno: i });
  assert.ok(reports.length > 1 && reports.length <= 25, `capped, got ${reports.length}`);
});

test('a reported error never names the calendar it happened on', () => {
  const { reports, fire } = loadErrorReporter();
  fire('unhandledrejection', { reason: new Error('permission_denied at /calendars/my-secret-slug/events') });
  assert.equal(reports.length, 1);
  assert.doesNotMatch(reports[0].message, /my-secret-slug/);
});

test('the reporter survives the analytics module being absent or broken', () => {
  const { fire } = loadErrorReporter();
  assert.doesNotThrow(() => fire('error', { error: null, message: undefined }));
  assert.doesNotThrow(() => fire('unhandledrejection', { reason: undefined }));
});

test('the write path exposes hooks for merges and failures', () => {
  assert.match(SERVICE, /static onSyncMerged/);
  assert.match(SERVICE, /static onSyncFailed/);
  assert.match(APP, /CalendarDataService\.onSyncMerged\s*=/,
    'the app must register them or they report nothing');
  assert.match(APP, /CalendarDataService\.onSyncFailed\s*=/);
});

test('a failed write tells the user, not only the console', () => {
  const handler = APP.slice(APP.indexOf('CalendarDataService.onSyncFailed'),
                            APP.indexOf('CalendarDataService.onSyncFailed') + 400);
  assert.match(handler, /showToast/,
    'silently keeping an edit that exists only on their screen is the failure mode');
});

// generateICSV2 itself, served over a real HTTP socket (onRequest wraps it in CORS
// middleware that needs a genuine response object), with the slug lookup forced to fail.
async function serveIcs(lookup, urlPath) {
  const fns = require('../../functions/index.js');
  const { SlugService } = fns._internal;
  const saved = SlugService.lookupCalendar;
  const errors = [];
  const savedError = console.error;
  SlugService.lookupCalendar = lookup;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  const server = http.createServer((req, res) => {
    req.path = new URL(req.url, 'http://x').pathname;
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (k, v) => { res.setHeader(k, v); return res; };
    res.send = (b) => { res.end(b); return res; };
    fns.generateICSV2(req, res);
  });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    // Bounded: a handler that throws inside its own catch never answers at all.
    const resp = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`,
      { signal: AbortSignal.timeout(5000) });
    return { status: resp.status, body: await resp.text(), errors };
  } finally {
    server.closeAllConnections();
    server.close();
    SlugService.lookupCalendar = saved;
    console.error = savedError;
  }
}

test('an ICS failure answers 500 and logs one queryable structured line', async () => {
  // Subscribers cannot report a feed that quietly stops updating, so the log is the only
  // place the failure can be noticed.
  const r = await serveIcs(async () => { throw new TypeError('db exploded'); }, '/somecal.ics');
  assert.equal(r.status, 500);
  const lines = r.errors.filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  assert.equal(lines.length, 1, r.errors.join('\n'));
  assert.equal(lines[0].event, 'ics_failed');
  assert.equal(lines[0].severity, 'ERROR');
  assert.equal(lines[0].reason, 'db exploded', 'the real error, not one raised while reporting it');
  assert.equal(lines[0].path, '/somecal.ics');
});

test('a missing calendar answers 404 and is not logged as a server error', async () => {
  const r = await serveIcs(async () => ({ found: false }), '/gone.ics');
  assert.equal(r.status, 404);
  assert.deepEqual(r.errors, []);
});
