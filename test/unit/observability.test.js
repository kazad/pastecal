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

const ANALYTICS = fs.readFileSync(
  path.join(__dirname, '../../public/utils/analytics.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const SERVICE = fs.readFileSync(
  path.join(__dirname, '../../public/services/CalendarDataService.js'), 'utf8');
const FUNCTIONS = fs.readFileSync(
  path.join(__dirname, '../../functions/index.js'), 'utf8');

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
  A.syncMerged({ addedByOthers: 3, removedByUs: 1 });

  assert.equal(sent[0].name, 'sync_merged');
  assert.equal(sent[0].params.added_by_others, 3);
  assert.equal(sent[0].params.removed_by_us, 1);
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

test('uncaught errors and rejected promises are reported', () => {
  assert.match(APP, /addEventListener\('error'/,
    'an uncaught error was previously visible only in the user\'s own devtools');
  assert.match(APP, /addEventListener\('unhandledrejection'/);
  assert.match(APP, /a\.jsError\(/, 'and they must reach the analytics seam');
});

test('repeated failures are reported once, not once per repaint', () => {
  // A render loop throwing every frame is one signal, not thousands of hits.
  const block = APP.slice(APP.indexOf('installErrorReporting'),
                          APP.indexOf('installErrorReporting') + 1600);
  assert.match(block, /seen\.has\(key\)/, 'duplicate failures are suppressed');
  assert.match(block, /seen\.size > \d+/, 'and a storm is capped');
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

test('an ICS failure is logged as a queryable structured line', () => {
  // Subscribers cannot report a feed that quietly stops updating, so the log is the only
  // place the failure can be noticed.
  assert.match(FUNCTIONS, /event:\s*'ics_failed'/);
  assert.match(FUNCTIONS, /severity:\s*'ERROR'/);
  // And it must not reference a binding that only exists inside the try block: a
  // ReferenceError while reporting would replace the real error with a worse one.
  const block = FUNCTIONS.slice(FUNCTIONS.indexOf("event: 'ics_failed'") - 400,
                                FUNCTIONS.indexOf("event: 'ics_failed'") + 400);
  assert.doesNotMatch(block, /calendar:\s*id\b/,
    'cleanId is scoped to the try block and is not available in the catch');
});
