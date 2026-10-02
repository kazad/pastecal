#!/usr/bin/env node
/**
 * Downloads the pinned third-party bundles the tests run for real (test/fixtures.json) into
 * test/.fixtures/, verifying each against its SHA-256.
 *
 * One 20MB file, not the npm package: @syncfusion/ej2 as a devDependency put ~790MB in every
 * node_modules (dev machines and every CI job) to obtain the single dist file the page
 * loads. The checksum also pins exactly the bytes production serves from the CDN.
 *
 *   node test/fetch-fixtures.js          # fetch what is missing (CI caches test/.fixtures)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, '.fixtures');
const PINS = require('./fixtures.json');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fileFor = (name) => path.join(DIR, `${name}-${PINS[name].version}${path.extname(PINS[name].url)}`);

/** Path to a verified fixture, downloading it if allowed; throws with the reason otherwise. */
function ensure(name, { download = true } = {}) {
    const pin = PINS[name];
    if (!pin) throw new Error(`no fixture named ${name}`);
    const file = fileFor(name);
    if (fs.existsSync(file) && sha256(file) === pin.sha256) return file;
    if (!download) throw new Error(`${name}@${pin.version} not fetched (run: node test/fetch-fixtures.js)`);
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.part`;
    // curl, not fetch: it honors the HTTPS proxy settings node's fetch ignores.
    const r = spawnSync('curl', ['-sSfL', '--max-time', '120', '-o', tmp, pin.url], { stdio: 'inherit' });
    if (r.status !== 0) { try { fs.unlinkSync(tmp); } catch (e) { /* none written */ } throw new Error(`could not download ${pin.url}`); }
    const got = sha256(tmp);
    if (got !== pin.sha256) { fs.unlinkSync(tmp); throw new Error(`${pin.url}: sha256 ${got}, expected ${pin.sha256}`); }
    fs.renameSync(tmp, file);
    return file;
}

module.exports = { ensure, PINS };

if (require.main === module) {
    for (const name of Object.keys(PINS)) console.log(`${name}: ${ensure(name)}`);
}
