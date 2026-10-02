/**
 * Hostile stored content, found by the adversarial UX pass (scratchpad/ux/hostile):
 *   - a description linkifier that re-scanned its own markup (stored XSS on hover, /view/
 *     pages included),
 *   - stored type colors spliced into a <style> sheet unvalidated (page blanked),
 *   - a boot-time localStorage read that threw when site data is blocked (app never loads).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Linkify = require('../../public/utils/linkify.js');
const PUBLIC = path.join(__dirname, '../../public');

function utilsHelpers(localStorage) {
  const src = fs.readFileSync(path.join(PUBLIC, 'utils/utils.js'), 'utf8');
  const body = src.slice(src.indexOf('// Every stored-JSON read'), src.indexOf('// Legacy calendar helpers'));
  return new Function('localStorage', `${body}; return { safeReadJSON, safeCssColor };`)(localStorage);
}

test('linkify: the hover-XSS payload becomes one inert link', () => {
  const evil = 'Join: https://a.com/?q=www.zz.com/onmouseover=window.__pwn=document.domain//x';
  const html = Linkify.toHtml(evil);
  assert.equal((html.match(/<a /g) || []).length, 1, 'one link, not a link nested in an href');
  assert.doesNotMatch(html, /\sonmouseover=/i, 'no attribute outside the href');
});

test('linkify: markup in user text is escaped, never rendered', () => {
  const html = Linkify.toHtml('<img src=x onerror=alert(1)> "quoted" \'single\'');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot;quoted&quot;/);
});

test('linkify: only http(s) and mailto become links', () => {
  for (const s of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x']) {
    assert.doesNotMatch(Linkify.toHtml(s), /<a /, s);
  }
  const t = Linkify.tokenize('see www.x.com, write a@b.co or https://y.org/p.');
  assert.deepEqual(t.filter(x => x.href).map(x => x.href),
    ['http://www.x.com', 'mailto:a@b.co', 'https://y.org/p']);
});

test('linkify: newlines become <br> only when asked, and nothing else is lost', () => {
  assert.equal(Linkify.toHtml('a\nb', { breaks: true }), 'a<br>b');
  const text = 'plain text, no links at all';
  assert.equal(Linkify.toHtml(text), text);
});

test('every linkifier routes through the shared module', () => {
  const sources = ['utils/utils.js', 'app.js', 'nativecal/app.js', 'nativecal/components/EventPopover.js']
    .map(f => fs.readFileSync(path.join(PUBLIC, f), 'utf8'));
  for (const src of sources) {
    assert.doesNotMatch(src, /innerHTML\s*=\s*linkify\(/, 'no innerHTML round-trip');
    assert.doesNotMatch(src, /notes\.replace\(\/\(\\b\(https\?/, 'no hand-rolled notes linkifier');
  }
  for (const html of ['index.html', 'nativecal/index.html']) {
    const page = fs.readFileSync(path.join(PUBLIC, html), 'utf8');
    assert.ok(page.indexOf('/utils/linkify.js') > -1 && page.indexOf('/utils/linkify.js') < page.indexOf('/utils/utils.js'),
      `${html} loads linkify.js before utils.js`);
  }
});

test('safeCssColor: real colors pass, rule-breaking values fall back', () => {
  const { safeCssColor } = utilsHelpers({});
  for (const ok of ['#fff', '#A1B2C3', '#a1b2c3d4', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(120 50% 50%)', 'teal']) {
    assert.equal(safeCssColor(ok, 'FB'), ok, ok);
  }
  for (const bad of ['red} body{display:none!important} .x{color:red', 'url(http://evil/t)',
    'red;background-image:url(x)', 'expression(alert(1))', '', null, 42, {}]) {
    assert.equal(safeCssColor(bad, 'FB'), 'FB', String(bad));
  }
});

test('safeReadJSON: blocked or corrupt storage never throws', () => {
  const blocked = utilsHelpers({ getItem() { throw new Error('SecurityError: storage blocked'); } });
  assert.equal(blocked.safeReadJSON('pastecal_global_settings'), null);
  assert.deepEqual(blocked.safeReadJSON('x', {}), {});
  const corrupt = utilsHelpers({ getItem: () => '{bad' });
  assert.equal(corrupt.safeReadJSON('k', 'fallback'), 'fallback');
  const good = utilsHelpers({ getItem: () => '{"a":1}' });
  assert.deepEqual(good.safeReadJSON('k'), { a: 1 });
});

test('no unguarded JSON.parse of localStorage remains in either app', () => {
  for (const f of ['app.js', 'nativecal/app.js', 'utils/utils.js']) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    assert.doesNotMatch(src, /JSON\.parse\(\s*localStorage\.getItem/, f);
  }
});
