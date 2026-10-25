/**
 * The staging copy, preview.pastecal.com (public/utils/preview.js, CloudCalendarService.enabled):
 * it is a Cloudflare host (never the production Firebase fallback), it shows the test-mode banner
 * only there, dismissible per session and never in an embed, and the Pro checkout hint names the
 * test card. On pastecal.com none of it applies.
 *
 * Run: node --test test/unit/preview-site.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTab } = require('../cloud-loader.js');

const src = fs.readFileSync(path.join(__dirname, '../../public/utils/preview.js'), 'utf8');
const PreviewSite = new Function(`${src.slice(0, src.indexOf('if (typeof window'))}; return PreviewSite;`)();
const mem = () => { const s = {}; return { getItem: (k) => s[k] ?? null, setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; };
const at = (hostname, search = '') => ({ hostname, search });

test('preview.pastecal.com is a Cloudflare host: always the Worker, never Firebase (even with ?backend=firebase)', () => {
  const { Cloud } = loadTab();
  assert.equal(Cloud.enabled(at('preview.pastecal.com'), mem()), true);
  assert.equal(Cloud.enabled(at('preview.pastecal.com', '?backend=firebase'), mem()), true);
  for (const h of ['pastecal.com', 'www.pastecal.com', 'new.pastecal.com']) assert.equal(Cloud.enabled(at(h), mem()), true, h);
  assert.equal(Cloud.enabled(at('preview.pastecal.com.evil.example'), mem()), false, 'exact host only');
  assert.equal(Cloud.enabled(at('localhost'), mem()), true, 'a local copy defaults to its own backend, never production Firebase');
});

test('PreviewSite.is: the preview host only', () => {
  assert.equal(PreviewSite.is(at('preview.pastecal.com')), true);
  for (const h of ['pastecal.com', 'www.pastecal.com', 'new.pastecal.com', 'localhost', 'xpreview.pastecal.com']) assert.equal(PreviewSite.is(at(h)), false, h);
  assert.equal(PreviewSite.is(null), false);
});

test('the banner: preview only, not in an embed, gone for the session once dismissed, shown if storage throws', () => {
  const s = mem();
  assert.equal(PreviewSite.shouldShowBanner(at('pastecal.com'), s, false), false);
  assert.equal(PreviewSite.shouldShowBanner(at('preview.pastecal.com'), s, true), false, 'embeds stay clean');
  assert.equal(PreviewSite.shouldShowBanner(at('preview.pastecal.com'), s, false), true);
  PreviewSite.dismiss(s);
  assert.equal(PreviewSite.shouldShowBanner(at('preview.pastecal.com'), s, false), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(PreviewSite.shouldShowBanner(at('preview.pastecal.com'), broken, false), true);
  assert.doesNotThrow(() => PreviewSite.dismiss(broken));
});

test('the copy names the test card, date and CVC, and says data may be reset', () => {
  assert.equal(PreviewSite.BANNER_TEXT, 'Beta · The new pastecal design, on your real calendars. Changes you make here are real. Plus is bought on pastecal.com.');
  assert.match(PreviewSite.CHECKOUT_HINT, /4242 4242 4242 4242, any future date, any CVC/);
});

test('editor links use the page origin, so a staging key never points at pastecal.com', () => {
  const pro = fs.readFileSync(path.join(__dirname, '../../public/components/Pro.js'), 'utf8');
  const done = fs.readFileSync(path.join(__dirname, '../../public/pro/done.html'), 'utf8');
  assert.doesNotMatch(pro, /https:\/\/pastecal\.com\/\$\{/);
  assert.doesNotMatch(done, /'https:\/\/pastecal\.com' \+ calPath/);
  assert.match(pro, /\$\{location\.origin\}\/\$\{encodeURIComponent\(this\.calendarId\)\}#k=/);
});

test('the preview host skips production Firebase sign-in and analytics', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  assert.match(html, /if \(!window\.pcNoProdSideEffects\) firebase\.auth\(\)\.signInAnonymously\(\)/);
  assert.match(html, /if \(h === 'preview\.pastecal\.com'\) return true;/, 'the flag covers the preview host');
  assert.equal((html.match(/hostname === 'preview\.pastecal\.com'/g) || []).length, 2, 'GTM and gtag are both off');
  assert.match(html, /<script src="\/utils\/preview\.js/);
});
