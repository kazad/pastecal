/**
 * public/utils/emulators.js decides whether the page talks to production Firebase or the
 * local emulators. The e2e suite used to write into the production database because
 * nothing made that switch; these run the real file against a fake `firebase` global.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/utils/emulators.js'), 'utf8');
const FIREBASE_JSON = require('../../firebase.json');
const PROD = { projectId: 'pastecal-web', databaseURL: 'https://pastecal-web-default-rtdb.firebaseio.com', apiKey: 'k' };

function load(url, { flag = false, storage = {} } = {}) {
  const u = new URL(url);
  const calls = [];
  const firebase = {
    initializeApp: (cfg) => { calls.push(['initializeApp', cfg]); return { name: '[DEFAULT]' }; },
    database: () => ({ useEmulator: (h, p) => calls.push(['database', h, p]) }),
    functions: () => ({ useEmulator: (h, p) => calls.push(['functions', h, p]) }),
    auth: () => ({ useEmulator: (url) => calls.push(['auth', url]) }),
  };
  const window = { __PASTECAL_EMULATOR__: flag || undefined };
  const sandbox = {
    window, firebase, console: { info() {} }, Object, String,
    location: { hostname: u.hostname, port: u.port, search: u.search },
    sessionStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); } },
  };
  vm.runInNewContext(SRC, sandbox);
  firebase.initializeApp(PROD);
  return { calls, window, storage };
}

const usedEmulators = (calls) => calls.some(c => c[0] === 'database');

test('emulators: production hosts never switch, whatever the page is told', () => {
  for (const url of ['https://pastecal.com/abc', 'https://pastecal-web.web.app/x?emulator']) {
    const { calls } = load(url, { flag: true });
    assert.deepEqual(calls, [['initializeApp', PROD]], url);
  }
});

test('emulators: plain localhost development keeps its old behavior unless asked', () => {
  const { calls } = load('http://localhost:8000/abc');
  assert.equal(usedEmulators(calls), false);
});

test('emulators: the hosting emulator, the e2e flag, or ?emulator switch everything', () => {
  const hosting = FIREBASE_JSON.emulators.hosting.port;
  for (const [url, opts] of [
    [`http://127.0.0.1:${hosting}/cal`, {}],
    ['http://localhost:8000/cal', { flag: true }],
    ['http://localhost:8000/cal?emulator', {}],
  ]) {
    const { calls, window } = load(url, opts);
    const cfg = calls[0][1];
    assert.equal(cfg.projectId, 'demo-pastecal', url);
    assert.doesNotMatch(cfg.databaseURL, /firebaseio\.com/, `${url}: no production databaseURL`);
    assert.equal(cfg.apiKey, 'k', 'the rest of the config is kept');
    assert.deepEqual(calls.slice(1), [
      ['database', '127.0.0.1', FIREBASE_JSON.emulators.database.port],
      ['functions', '127.0.0.1', FIREBASE_JSON.emulators.functions.port],
      ['auth', `http://127.0.0.1:${FIREBASE_JSON.emulators.auth.port}`],
    ], url);
    assert.equal(window.__PASTECAL_USING_EMULATOR__, true);
  }
});

test('emulators: ?emulator is remembered for the tab, since the app rewrites the URL', () => {
  const storage = {};
  load('http://localhost:8000/cal?emulator', { storage });
  const { calls } = load('http://localhost:8000/cal', { storage });
  assert.equal(usedEmulators(calls), true);
});

test('emulators: the ports in the page match firebase.json', () => {
  const { window } = load('https://pastecal.com/');
  for (const k of ['hosting', 'database', 'functions', 'auth']) {
    assert.equal(window.PASTECAL_EMULATORS[k], FIREBASE_JSON.emulators[k].port, k);
  }
});

test('emulators: every page that initializes Firebase loads the switch first', () => {
  for (const page of ['public/index.html', 'public/nativecal/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../..', page), 'utf8');
    const sw = html.indexOf('/utils/emulators.js');
    const sdk = html.indexOf('firebase-compat.js');
    const init = html.indexOf('firebase.initializeApp(');
    assert.ok(sdk !== -1 && init !== -1, `${page} initializes Firebase`);
    assert.ok(sw > sdk && sw < init, `${page}: emulators.js must load after the SDK and before initializeApp`);
  }
});
