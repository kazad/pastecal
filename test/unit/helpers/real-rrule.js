/**
 * The real rrule.js bundle, at the version public/nativecal/index.html pins, so tests
 * expand recurrence exactly as nativecal does. Same policy as real-ej.js: looked for in
 * PASTECAL_RRULE_PATH, then the copy cached in the OS temp dir, then downloaded (and
 * cached). Returns { rrule } or { reason }.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const INDEX = fs.readFileSync(path.join(__dirname, '../../../public/nativecal/index.html'), 'utf8');

function locate() {
  const version = (/rrule@([\d.]+)\/dist\/es5\/rrule\.min\.js/.exec(INDEX) || [])[1];
  if (!version) return { reason: 'nativecal/index.html no longer pins an rrule version' };
  if (process.env.PASTECAL_RRULE_PATH) return { file: process.env.PASTECAL_RRULE_PATH };
  const cached = path.join(os.tmpdir(), `pastecal-rrule-${version}.min.js`);
  if (fs.existsSync(cached)) return { file: cached };
  const url = `https://cdn.jsdelivr.net/npm/rrule@${version}/dist/es5/rrule.min.js`;
  const tmp = `${cached}.${process.pid}.part`;
  const r = spawnSync('curl', ['-sfL', '--max-time', '60', '-o', tmp, url]);
  if (r.status !== 0) {
    try { fs.unlinkSync(tmp); } catch (err) { /* nothing was written */ }
    return { reason: `could not download ${url}` };
  }
  fs.renameSync(tmp, cached);
  return { file: cached };
}

let loaded;
function loadRealRrule() {
  if (loaded !== undefined) return loaded;
  const where = locate();
  if (!where.file) return (loaded = where);
  // As a browser global (window.rrule), sharing the host's Date.
  const sb = { Date, Math, JSON, Object, Array, String, Number, console };
  sb.self = sb;
  try {
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(where.file, 'utf8'), sb);
  } catch (err) {
    return (loaded = { reason: `rrule failed to load: ${err.message}` });
  }
  if (typeof sb.rrule?.RRule !== 'function') return (loaded = { reason: 'rrule.RRule is missing' });
  return (loaded = { rrule: sb.rrule });
}

module.exports = { loadRealRrule };
