/**
 * Analytics must never carry the edit credential, and must report what it claims to.
 *
 * On pastecal the URL path IS the credential: anyone holding /<slug> can edit that
 * calendar. GTM and gtag sent the full URL with every hit, so every edit link visited
 * was being handed to Google and listed in GA reports. These pin the fixes:
 *   - one shared bootstrap (both pages), one gate (test, opt-out, GPC/DNT, host)
 *   - hits carry a route template and a hashed cal_key, never the path or slug
 *   - js_error `where`, free-text params and the referrer can't smuggle the slug
 *   - has_custom_slug, slug_autoassigned and calendar_created report what happened
 *   - every param sent is in the schema stats.sh registers from
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BOOT = require(path.join(ROOT, 'public/utils/analytics-boot.js'));
const ANALYTICS = read('public/utils/analytics.js');
const SLUGS = read('public/services/SlugManager.js');
const APP = read('public/app.js');
const FUNCTIONS = read('functions/index.js');
const STATS = read('scripts/stats.sh');
const SCHEMA = JSON.parse(read('public/utils/analytics-schema.json')).params;

const tick = () => new Promise((r) => setImmediate(r));
const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function fakeWindow({ host = 'pastecal.com', pathname = '/', search = '', referrer = '', nav = {}, extra = {} } = {}) {
  const appended = [];
  const el = { appendChild: (n) => appended.push(n) };
  return Object.assign({
    location: { hostname: host, pathname, search, origin: `https://${host}`, href: `https://${host}${pathname}${search}` },
    navigator: nav,
    document: { referrer, head: el, createElement: () => ({}), getElementsByTagName: () => [el] },
    crypto: crypto.webcrypto,
    console: { log() {} },
    _appended: appended,
  }, extra);
}

// Load analytics.js against a window with a real bootstrap state, sinks recorded.
function loadAnalytics(win) {
  const sent = [];
  const factory = new Function('window', 'navigator', 'document', 'location',
    'console', 'setTimeout', 'requestIdleCallback',
    `${ANALYTICS}; return Analytics;`);
  const A = factory(win, win.navigator, { addEventListener() {} }, win.location,
    { log() {}, warn() {} }, (fn) => { fn(); return 0; }, undefined);
  A.SINKS.recorder = (name, params, urgent) => sent.push({ name, params, urgent });
  A.active = ['recorder', 'ga4'];
  return { A, sent };
}

// --- The gate ---------------------------------------------------------------------------

test('analytics is on only on production hosts, and off for any privacy signal', () => {
  for (const h of BOOT.PROD_HOSTS) assert.equal(BOOT.gate(fakeWindow({ host: h })).enabled, true, h);
  assert.equal(BOOT.gate(fakeWindow({ host: 'localhost' })).reason, 'host');
  assert.equal(BOOT.gate(fakeWindow({ host: 'pastecal-web--pr12-abc.web.app' })).reason, 'host');
  assert.equal(BOOT.gate(fakeWindow({ extra: { __TEST__: true } })).reason, 'test');
  assert.equal(BOOT.gate(fakeWindow({ search: '?no-analytics' })).reason, 'opt_out');
  assert.equal(BOOT.gate(fakeWindow({ nav: { globalPrivacyControl: true } })).reason, 'gpc');
  assert.equal(BOOT.gate(fakeWindow({ nav: { doNotTrack: '1' } })).reason, 'dnt');
  assert.equal(BOOT.gate(fakeWindow({ nav: { doNotTrack: '0' } })).enabled, true);
  assert.equal(BOOT.gate(fakeWindow({ host: 'localhost', extra: { __ANALYTICS_ALLOW_HOST__: true } })).enabled, true);
});

test('a gated-off page loads nothing and defines no gtag', () => {
  const win = fakeWindow({ host: 'localhost' });
  const state = BOOT.boot(win);
  assert.equal(state.enabled, false);
  assert.equal(win.gtag, undefined);
  assert.equal(win.dataLayer, undefined);
  assert.equal(win._appended.length, 0);
});

test('analytics.js follows the bootstrap gate and has no test-surface branch', () => {
  assert.equal(loadAnalytics(fakeWindow({ extra: { AnalyticsBoot: { enabled: false } } })).A.enabled, false);
  assert.equal(loadAnalytics(fakeWindow({ extra: { AnalyticsBoot: { enabled: true } } })).A.enabled, true);
  assert.equal(loadAnalytics(fakeWindow()).A.enabled, false, 'no bootstrap, nothing can deliver');
  assert.doesNotMatch(ANALYTICS, /'test'\s*:\s*'web'|surface:\s*window\.__TEST__/);
});

// --- No path, no slug -------------------------------------------------------------------

test('routes become templates; the slug is only ever hashed', () => {
  const cases = {
    '/': ['/', null],
    '/Team-Roster': ['/cal', 'team-roster'],
    '/edit/Team': ['/cal', 'team'],
    '/view/abc123xyz0': ['/view', 'abc123xyz0'],
    '/nativecal': ['/nativecal', null],
    '/nativecal/Foo': ['/nativecal/cal', 'foo'],
    '/nativecal/view/v1': ['/nativecal/view', 'v1'],
  };
  for (const [p, [template, slug]] of Object.entries(cases)) {
    assert.deepEqual(BOOT.route(p), { template, slug }, p);
  }
});

test('cal_key is the first 16 hex of sha256(lowercased slug), or omitted', async () => {
  assert.equal(await BOOT.calKey('Kazumichi', crypto.webcrypto), sha16('kazumichi'));
  assert.equal(await BOOT.calKey('kazumichi', undefined), null, 'no Web Crypto, no key');
  assert.equal(await BOOT.calKey(null, crypto.webcrypto), null);
});

test('no hit gtag builds can contain the path, the slug, or a pastecal referrer path', async () => {
  const slug = 'SecretEditSlug';
  const win = fakeWindow({ pathname: `/${slug}`, search: '?date=2026-10-01', referrer: `https://pastecal.com/OtherSecret` });
  const state = BOOT.boot(win);
  await state.ready;

  const blob = JSON.stringify(win.dataLayer.map((a) => Array.from(a)));
  assert.doesNotMatch(blob, /secretedit|othersecret/i);
  const config = win.dataLayer.map((a) => Array.from(a)).find((a) => a[0] === 'config');
  assert.ok(config, 'config (which sends the one page_view) is issued');
  assert.equal(config[2].page_location, 'https://pastecal.com/cal');
  assert.equal(config[2].page_referrer, 'https://pastecal.com/');
  assert.equal(config[2].cal_key, sha16('secreteditslug'));
  assert.notEqual(config[2].send_page_view, false, 'GTM is gone, so gtag sends the page_view');
  const set = win.dataLayer.map((a) => Array.from(a)).find((a) => a[0] === 'set');
  assert.equal(set[1].page_location, 'https://pastecal.com/cal', 'set covers hits gtag sends on its own');
  assert.equal(win._appended.length, 1, 'gtag.js is loaded once');
});

test('both pages load the one shared bootstrap, before analytics.js, and nothing inline', () => {
  for (const page of ['public/index.html', 'public/nativecal/index.html']) {
    const html = read(page);
    const boot = html.search(/<script src="\/utils\/analytics-boot\.js[^"]*"><\/script>/);
    const seam = html.indexOf('/utils/analytics.js');
    assert.ok(boot > 0, `${page} loads analytics-boot.js`);
    assert.ok(boot < seam, `${page} loads it before analytics.js`);
    assert.doesNotMatch(html, /googletagmanager|GTM-|gtag\(|dataLayer/, `${page} has no inline loader to drift`);
  }
});

test('free-text params cannot carry the current slug', async () => {
  const win = fakeWindow({ pathname: '/team-roster' });
  win.AnalyticsBoot = BOOT.boot(win);
  await win.AnalyticsBoot.ready;
  const { A, sent } = loadAnalytics(win);
  A.jsError('error', 'cannot read team-roster/options of undefined', 'inline');
  await tick(); await tick();
  assert.equal(sent[0].params.message, 'cannot read <id>/options of undefined');
  assert.equal(sent[0].params.cal_key, sha16('team-roster'));
  assert.equal(sent[0].params.surface, 'web');

  // A short slug that is a substring of a label does not mangle it.
  const win2 = fakeWindow({ pathname: '/home' });
  win2.AnalyticsBoot = BOOT.boot(win2);
  await win2.AnalyticsBoot.ready;
  const r2 = loadAnalytics(win2);
  r2.A.slugPromptShown('homepage_bar', {});
  await tick(); await tick();
  assert.equal(r2.sent[0].params.where, 'homepage_bar');
});

test('js_error `where` names our own scripts only, never the page URL', () => {
  const { A } = loadAnalytics(fakeWindow({ pathname: '/team-roster' }));
  assert.equal(A.errorSource('https://pastecal.com/app.js?v=1', 12), 'app.js:12');
  assert.equal(A.errorSource('https://pastecal.com/team-roster', 40), 'inline',
    'an inline script reports the page URL as its filename');
  assert.equal(A.errorSource('https://pastecal.com/team-roster?x=1#y', 1), 'inline');
  assert.equal(A.errorSource('https://cdn.example.com/lib.js', 3), 'external');
  assert.equal(A.errorSource('', 0), 'unknown');
  assert.match(APP, /a\.errorSource\(e\.filename, e\.lineno\)/);
  assert.doesNotMatch(APP, /filename\)\.split\('\/'\)\.pop\(\)/);
});

// --- Events report what happened --------------------------------------------------------

test('has_custom_slug comes from the recorded source, never the id shape', async () => {
  const win = fakeWindow({ extra: { AnalyticsBoot: { enabled: true, ready: Promise.resolve() } } });
  const { A, sent } = loadAnalytics(win);
  A.calendarReturned({ options: { publicViewId: 'k3j9x0q2ab', publicViewSource: 'generated' } }, 2);
  A.calendarReturned({ options: { publicViewId: 'roster', publicViewSource: 'custom' } }, 2);
  A.calendarReturned({ options: { publicViewId: 'k3j9x0q2ab' } }, 2);
  await tick(); await tick();
  assert.equal(sent[0].params.has_custom_slug, false);
  assert.equal(sent[1].params.has_custom_slug, true);
  assert.equal('has_custom_slug' in sent[2].params, false, 'unknown is omitted, not guessed');
});

test('calendar_created is sent synchronously, by beacon, before the redirect', () => {
  const calls = [];
  const win = fakeWindow({ extra: { AnalyticsBoot: { enabled: true, ready: new Promise(() => {}) } } });
  win.gtag = (...args) => calls.push(args);
  const { A, sent } = loadAnalytics(win);
  A.calendarCreated(true, { events: [] });
  // Nothing awaited: a page that navigates on the next line must already have sent it.
  assert.equal(sent.length, 1);
  assert.equal(calls[0][1], 'calendar_created');
  assert.equal(calls[0][2].transport_type, 'beacon');
  // The create path lives in CalendarFlow (shared by both apps) since 2026-10.
  assert.match(read('public/services/CalendarFlow.js'), /slug_autoassigned', \{[\s\S]{0,200}\}, \{ urgent: true \}\)/,
    'the slug events beside it are on the same redirect');
});

test('auto-creating a read-only link asks the server once per calendar per page', async () => {
  let calls = 0, resolve;
  const tracked = [];
  const firebase = { functions: () => ({ httpsCallable: () => () => {
    calls++;
    return new Promise((r) => { resolve = r; });
  } }) };
  const Analytics = { track: (n, p) => tracked.push(n), bucketEvents: () => '0' };
  const S = new Function('firebase', 'CalendarDataService', 'Analytics', 'console', 'alert',
    `${SLUGS}; return SlugManager;`)(firebase, { sync() {} }, Analytics, { log() {}, error() {} }, () => {});

  const snap = () => ({ id: 'cal1', options: {}, events: [] });
  S.autoCreateReadOnlyLink(snap());
  S.autoCreateReadOnlyLink(snap());
  S.autoCreateReadOnlyLink(snap());
  assert.equal(calls, 1, 'every snapshot before the write echoes back lacks publicViewId');
  resolve({ data: { publicViewId: 'v1', created: true } });
  await tick();
  assert.deepEqual(tracked, ['slug_autoassigned']);

  // The server returned an existing view: nothing was assigned, nothing is counted.
  const c2 = { id: 'cal2', options: {}, events: [] };
  S.autoCreateReadOnlyLink(c2);
  resolve({ data: { publicViewId: 'v0', created: false } });
  await tick();
  assert.deepEqual(tracked, ['slug_autoassigned']);
  assert.equal(c2.options.publicViewSource, undefined, 'source is only recorded on creation');
});

test('createPublicLink returns the bound view instead of minting another', () => {
  const fn = FUNCTIONS.slice(FUNCTIONS.indexOf('exports.createPublicLink'),
                             FUNCTIONS.indexOf('exports.indexSlug'));
  assert.match(fn, /!customSlug[\s\S]{0,300}BINDINGS[\s\S]{0,200}=== sourceCalendarId/,
    'only a server-side binding proves ownership; options.publicViewId is client-writable');
  assert.match(fn, /return \{ publicViewId: existing, created: false \}/);
  assert.match(fn, /publicViewSource: customSlug \? 'custom' : 'generated'/);
});

// --- One schema -------------------------------------------------------------------------

test('every param analytics sends is registered in the schema stats.sh reads', async () => {
  const win = fakeWindow({ pathname: '/x1y2z3', extra: {} });
  win.AnalyticsBoot = BOOT.boot(win);
  await win.AnalyticsBoot.ready;
  const { A, sent } = loadAnalytics(win);
  A.active = ['recorder'];
  const cal = { events: [1], options: { publicViewId: 'a', publicViewSource: 'custom' } };
  A.slugAutoAssigned(cal); A.slugPromptShown('w', cal); A.slugPromptDismissed('w');
  A.slugClaimed('abc', cal); A.slugClaimFailed('taken'); A.calendarReturned(cal, 3);
  A.eventAdded('grid', cal); A.calendarShared('copy'); A.calendarCreated(true, cal);
  A.featureUsed('notes', 'd'); A.syncMerged({}); A.eventsDropped(1, 'r'); A.icsFailed('r');
  A.jsError('error', 'm', 'w'); A.syncShape({ before: 1, after: 2, intent: 'x' });
  A.syncRefused({ before: 1, removing: 1 });
  await tick(); await tick();

  const keys = new Set(sent.flatMap((e) => Object.keys(e.params)));
  // Raw track() calls outside the helpers.
  for (const src of [APP, SLUGS]) {
    for (const m of src.matchAll(/a\.track\('[a-z_]+', \{([\s\S]*?)\}/g)) {
      for (const k of m[1].matchAll(/^\s*([a-z_]+):/gm)) keys.add(k[1]);
    }
  }
  for (const k of keys) assert.ok(SCHEMA[k], `param "${k}" is sent but not in analytics-schema.json`);
  for (const [k, v] of Object.entries(SCHEMA)) assert.match(v.type, /^(dimension|metric)$/, k);
  for (const k of ['added_by_others', 'count', 'before', 'after', 'delta', 'removing']) {
    assert.equal(SCHEMA[k].type, 'metric', `${k} is a counter, summable only as a metric`);
  }
});

test('stats.sh registers from the schema and counts calendars by cal_key', () => {
  assert.match(STATS, /SCHEMA=.*analytics-schema\.json/);
  assert.doesNotMatch(STATS, /for p in where source/, 'no hand-typed param list');
  assert.match(STATS, /customMetrics/);
  assert.match(STATS, /customEvent:cal_key/);
  assert.match(STATS, /LEGACY/, 'the pre-deploy pagePath fallback is labeled');

  // stats.sh hashes legacy paths into the same key the page sends.
  const fn = STATS.slice(STATS.indexOf('sha16() {'), STATS.indexOf('}', STATS.indexOf('sha16() {')) + 1);
  const out = execFileSync('bash', ['-c', `${fn}\nsha16 team-roster`]).toString().trim();
  assert.equal(out, sha16('team-roster'));
});
