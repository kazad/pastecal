/**
 * The real Syncfusion bundle (the ej2.min.js version public/index.html pins), loaded into
 * a VM so tests expand recurrence exactly as the grid does.
 *
 * Looked for locally first: PASTECAL_EJ2_PATH, then the copy cached in the OS temp dir by
 * an earlier run, then an installed @syncfusion/ej2 of the same version. Only then is it
 * downloaded (and cached). Returns { ej } or { reason } -- callers decide whether a
 * missing bundle skips (locally) or fails (under CI).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const INDEX = fs.readFileSync(path.join(__dirname, '../../../public/index.html'), 'utf8');

function installedCopy(version) {
  try {
    const pkg = require.resolve('@syncfusion/ej2/package.json');
    if (require(pkg).version !== version) return null;
    const file = path.join(path.dirname(pkg), 'dist', 'ej2.min.js');
    return fs.existsSync(file) ? file : null;
  } catch (err) {
    return null;
  }
}

function locate() {
  const version = (/cdn\.syncfusion\.com\/ej2\/([\d.]+)\/dist\/ej2\.min\.js/.exec(INDEX) || [])[1];
  if (!version) return { reason: 'index.html no longer pins an ej2.min.js version' };
  if (process.env.PASTECAL_EJ2_PATH) return { file: process.env.PASTECAL_EJ2_PATH };
  const cached = path.join(os.tmpdir(), `pastecal-ej2-${version}.min.js`);
  if (fs.existsSync(cached)) return { file: cached };
  const installed = installedCopy(version);
  if (installed) return { file: installed };

  // curl honors the HTTPS proxy settings that node's own fetch ignores.
  const url = `https://cdn.syncfusion.com/ej2/${version}/dist/ej2.min.js`;
  const tmp = `${cached}.${process.pid}.part`;
  const r = spawnSync('curl', ['-sfL', '--max-time', '60', '-o', tmp, url]);
  if (r.status !== 0) {
    try { fs.unlinkSync(tmp); } catch (err) { /* nothing was written */ }
    return { reason: `could not download ${url}` };
  }
  fs.renameSync(tmp, cached);
  return { file: cached };
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
