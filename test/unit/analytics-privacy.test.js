/**
 * Google never receives a calendar's name. The path IS the edit key (pastecal.com/<name> lets
 * anyone change that calendar), and every gtag/GTM hit carries the page URL, so index.html and
 * nativecal/index.html set a generic page_location/page_path/page_referrer before anything is sent.
 *
 * Run: npm run test:unit
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');

// The inline <script> in `file` that sets page_location, run against a fake page.
function runSnippet(file, href, referrer = '') {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("gtag('set'"));
  assert.ok(script, `${file}: no gtag('set', ...) block`);
  const url = new URL(href);
  const calls = [];
  const window = { location: { href, pathname: url.pathname, search: url.search, origin: url.origin, host: url.host }, dataLayer: [] };
  window.gtag = function () { calls.push([...arguments]); };
  const document = { referrer, createElement: () => ({}), head: { appendChild() {} } };
  new Function('window', 'document', 'location', 'URL', 'URLSearchParams', script)(window, document, window.location, URL, URLSearchParams);
  // index.html's block replaces window.gtag with the dataLayer shim; read the commands from there too.
  for (const a of window.dataLayer) calls.push([...a]);
  const set = calls.find((c) => c[0] === 'set');
  assert.ok(set, `${file}: gtag('set') was not called`);
  const configIdx = calls.findIndex((c) => c[0] === 'config');
  if (configIdx >= 0) assert.ok(calls.indexOf(set) < configIdx, 'set must come before config');
  return set[1];
}

for (const file of ['public/index.html', 'public/nativecal/index.html']) {
  test(`${file}: an edit link sends /cal, never the calendar name`, () => {
    const s = runSnippet(file, 'https://pastecal.com/my-secret-team?utm_source=news&key=abc', 'https://pastecal.com/other-secret');
    assert.equal(s.page_location, 'https://pastecal.com/cal?utm_source=news');
    assert.equal(s.page_path, '/cal');
    assert.equal(s.page_referrer, 'https://pastecal.com/');
    assert.ok(!JSON.stringify(s).includes('secret'));
  });

  test(`${file}: home, read-only and beta paths are generic too; outside referrers kept`, () => {
    assert.equal(runSnippet(file, 'https://pastecal.com/').page_location, 'https://pastecal.com/');
    assert.equal(runSnippet(file, 'https://pastecal.com/view/ab12cd34ef').page_path, '/view');
    assert.equal(runSnippet(file, 'https://pastecal.com/beta/secretname').page_path, '/beta');
    assert.equal(runSnippet(file, 'https://pastecal.com/x', 'https://www.google.com/').page_referrer, 'https://www.google.com/');
  });
}
