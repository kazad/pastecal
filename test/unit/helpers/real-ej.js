/**
 * The real Syncfusion bundle (the ej2.min.js version public/index.html pins), loaded into
 * a VM so tests expand recurrence exactly as the grid does.
 *
 * Looked for in this order: PASTECAL_EJ2_PATH, the @syncfusion/ej2 root devDependency
 * (pinned to the same version, so `npm ci` provides it), then a copy cached in the OS temp
 * dir by an earlier run. Only outside CI is it ever downloaded: a test whose fixture depends
 * on the network skips whenever the network is down, and a suite that skips silently is
 * how bugs shipped green. Under CI a missing copy is a { reason } the caller turns into a
 * failure. Returns { ej } or { reason }.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const INDEX = fs.readFileSync(path.join(__dirname, '../../../public/index.html'), 'utf8');

function locate() {
  const version = (/cdn\.syncfusion\.com\/ej2\/([\d.]+)\/dist\/ej2\.min\.js/.exec(INDEX) || [])[1];
  if (!version) return { reason: 'index.html no longer pins an ej2.min.js version' };
  if (process.env.PASTECAL_EJ2_PATH) return { file: process.env.PASTECAL_EJ2_PATH };
  const { ensure, PINS } = require('../../fetch-fixtures');
  if (PINS.ej2.version !== version) {
    return { reason: `test/fixtures.json pins ej2 ${PINS.ej2.version} but index.html loads ${version}` };
  }
  // CI fetches fixtures in its own step (and caches them); a test run never downloads there.
  try { return { file: ensure('ej2', { download: !process.env.CI }) }; }
  catch (err) { return { reason: err.message }; }
}

function load() {
  const where = locate();
  if (!where.file) return where;

  const noop = () => {};
  const any = () => new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : any()), apply: () => any(),
  });
  // Share the host's Date so the dates generate() returns compare with ours.
  const sb = { console, setTimeout, clearTimeout, Date, Math, JSON, Intl, Object, Array };
  Object.assign(sb, {
    window: sb, self: sb, addEventListener: noop, removeEventListener: noop,
    navigator: { userAgent: 'node', platform: '', language: 'en-US' },
    document: {
      addEventListener: noop, createElement: () => any(), querySelector: () => null,
      querySelectorAll: () => [], body: any(), documentElement: any(), head: any(),
      getElementsByTagName: () => [],
    },
    location: { href: '', protocol: 'https:' },
    matchMedia: () => ({ matches: false, addListener: noop }),
    getComputedStyle: () => ({}), localStorage: { getItem: () => null },
    Element: function () {}, HTMLElement: function () {}, Node: function () {},
  });
  try {
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(where.file, 'utf8'), sb, { timeout: 120000 });
  } catch (err) {
    return { reason: `ej2.min.js failed to load: ${err.message}` };
  }
  if (typeof sb.ej?.schedule?.generate !== 'function') {
    return { reason: 'ej.schedule.generate is missing from the bundle' };
  }
  return { ej: sb.ej };
}

let loaded; // once per process: the bundle is ~20MB
function loadRealEj() {
  if (loaded === undefined) loaded = load();
  return loaded;
}

module.exports = { loadRealEj };
