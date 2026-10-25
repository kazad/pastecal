/**
 * Trial analytics: which Pro features trial users use. The events carry fixed vocabularies only
 * (never a calendar name, email or id), and trial_feature_used fires once per feature per calendar
 * per day (TrialUsage in public/components/Pro.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ANALYTICS = fs.readFileSync(path.join(__dirname, '../../public/utils/analytics.js'), 'utf8');
const PRO = fs.readFileSync(path.join(__dirname, '../../public/components/Pro.js'), 'utf8');

function loadAnalytics() {
  const sent = [];
  const loc = { pathname: '/', search: '', hostname: 'localhost', href: 'http://localhost/' };
  const win = { gtag: null, location: loc, addEventListener() {} };
  const A = new Function('window', 'navigator', 'document', 'location', 'console', 'setTimeout', 'requestIdleCallback',
    `${ANALYTICS}; return Analytics;`)(win, { language: 'en-US', userAgent: 'test' }, { referrer: '', title: 'test' }, loc,
    { log() {}, warn() {}, error() {} }, (fn) => { fn(); return 0; }, undefined);
  A.SINKS.recorder = (name, params) => sent.push({ name, params });
  A.active = ['recorder']; A.enabled = true;
  return { A, sent };
}

// TrialUsage + trialFeature from Pro.js, with a fake localStorage, a fixed "today", and proTrack recorded.
function loadUsage(today = '2026-10-24', store = {}) {
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const body = PRO.slice(PRO.indexOf('const TRIAL_USAGE_KEY'), PRO.indexOf('function proTrack'));
  const tracked = [];
  const proTrack = (fn) => fn({ trialFeatureUsed: (f) => tracked.push(f) });
  const out = new Function('localStorage', 'proTrack', `${body}; return { TrialUsage, trialFeature };`)(localStorage, proTrack);
  out.TrialUsage.today = () => today;
  return { ...out, tracked, store };
}

test('trial events: fixed values only, anything else falls back or is dropped', () => {
  const { A, sent } = loadAnalytics();
  A.trialStarted('stats'); A.trialStarted('my-secret-calendar');
  A.trialFeatureUsed('history'); A.trialFeatureUsed('my-secret-calendar');
  A.trialConverted('month'); A.trialConverted('weekly');
  A.trialLapsed('open'); A.trialLapsed('x');
  A.trialReminderClicked();
  const mine = sent.filter((e) => e.name.startsWith('trial_')).map((e) => [e.name, Object.fromEntries(Object.entries(e.params).filter(([k]) => ['trial_surface', 'feature', 'interval', 'mode'].includes(k)))]);
  assert.deepEqual(mine, [
    ['trial_started', { trial_surface: 'stats' }], ['trial_started', { trial_surface: 'share' }],
    ['trial_feature_used', { feature: 'history' }],
    ['trial_converted', { interval: 'month' }], ['trial_converted', { interval: 'year' }],
    ['trial_lapsed', { mode: 'open' }], ['trial_lapsed', { mode: 'readonly' }],
    ['trial_reminder_clicked', {}],
  ]);
  assert.ok(!JSON.stringify(sent).includes('secret'));
  assert.ok(sent.every((e) => e.params.surface === 'web'), 'the base surface (web/test) is never overridden');
});

test('trial_feature_used: once per feature per calendar per day', () => {
  const u = loadUsage('2026-10-24');
  u.trialFeature('Team', 'stats_pro'); u.trialFeature('team', 'stats_pro'); u.trialFeature('team', 'history'); u.trialFeature('other', 'stats_pro');
  assert.deepEqual(u.tracked, ['stats_pro', 'history', 'stats_pro']);
  const next = loadUsage('2026-10-25', u.store);
  next.trialFeature('team', 'stats_pro');
  assert.deepEqual(next.tracked, ['stats_pro'], 'counts again the next day');
});

test('trialing flag is kept per calendar until cleared', () => {
  const u = loadUsage();
  assert.equal(u.TrialUsage.flag('team', 'trialing'), false);
  u.TrialUsage.flag('team', 'trialing', true);
  assert.equal(u.TrialUsage.flag('Team', 'trialing'), true);
  u.TrialUsage.flag('team', 'trialing', false);
  assert.equal(u.TrialUsage.flag('team', 'trialing'), false);
});
