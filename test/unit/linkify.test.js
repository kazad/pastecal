/**
 * Unit tests for Utils.linkify() (public/utils/utils.js).
 *
 * Companion to the e2e regression in test/e2e/legacy-readonly-popup-links.spec.js, which
 * covers the DOMContentLoaded wiring bug (the MutationObserver that calls linkify() never
 * started because its <script> ran before document.body existed). These tests cover the
 * linkify() string transform itself in isolation.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// utils.js is a browser script that touches window/document/crypto at load time (nanoid,
// the MutationObserver bootstrap, RecentCalendars). Stub just enough of that global surface
// to load the file and pull out Utils.linkify.
function loadUtils() {
  const src = fs.readFileSync(path.join(__dirname, '../../public/utils/utils.js'), 'utf8');

  const listeners = {};
  const fakeDocument = {
    body: null, // mirrors the real <head> script timing bug being regression-tested
    addEventListener: (evt, cb) => { listeners[evt] = cb; },
    querySelector: () => null,
    createElement: () => ({}),
  };
  const fakeWindow = {};
  const fakeCrypto = { getRandomValues: (arr) => arr };
  const fakeLocalStorage = {
    getItem: () => null,
    setItem: () => {},
  };

  const factory = new Function(
    'window', 'document', 'crypto', 'localStorage', 'MutationObserver',
    `${src}; return window.Utils;`
  );
  const FakeMutationObserver = class { observe() {} };
  return factory(fakeWindow, fakeDocument, fakeCrypto, fakeLocalStorage, FakeMutationObserver);
}

const Utils = loadUtils();

test('linkify: wraps a bare https URL in an anchor with the right href', () => {
  const out = Utils.linkify('Join here: https://example.com/meeting/abc-123');
  assert.match(out, /<a href="https:\/\/example\.com\/meeting\/abc-123"/);
  assert.match(out, /target="_blank"/);
});

test('linkify: sets rel="noopener noreferrer nofollow ugc" on target=_blank links (reverse-tabnabbing guard, user content)', () => {
  const out = Utils.linkify('See https://example.com/x');
  assert.match(out, /rel="noopener noreferrer nofollow ugc"/);
});

test('linkify: applies visible link styling so it does not blend into plain text', () => {
  const out = Utils.linkify('See https://example.com/x');
  assert.match(out, /style="[^"]*text-decoration:underline/);
  assert.match(out, /style="[^"]*color:#2563eb/);
});

test('linkify: leaves plain text without a URL unchanged', () => {
  const out = Utils.linkify('No links in this description at all.');
  assert.equal(out, 'No links in this description at all.');
});

test('linkify: handles multiple URLs in one description independently', () => {
  const out = Utils.linkify('First: https://example.com/a Second: https://example.com/b');
  const matches = out.match(/<a href="[^"]+"/g);
  assert.equal(matches.length, 2);
  assert.ok(out.includes('href="https://example.com/a"'));
  assert.ok(out.includes('href="https://example.com/b"'));
});

test('linkify: wraps a www. URL with an inferred http:// scheme', () => {
  const out = Utils.linkify('Visit www.example.com for details');
  assert.match(out, /<a href="http:\/\/www\.example\.com"/);
});

test('linkify: wraps an email address as a mailto link', () => {
  const out = Utils.linkify('Contact me at person@example.com');
  assert.match(out, /<a href="mailto:person@example\.com"/);
});

// ---- input is plain text: escaped first, links found in one pass -------------------------

// The only tags in the output are the <a> tags linkify wrote; returns their attribute strings.
const anchors = (html) => [...html.matchAll(/<a ([^>]*)>/g)].map((m) => m[1]);
const tagsAreOnlyAnchors = (html) => {
  const tags = html.match(/<\/?[a-z][^>]*>/gi) || [];
  for (const t of tags) assert.match(t, /^<a href="[^"<>]*" target="_blank" rel="noopener noreferrer nofollow ugc"( style="[^"]*")?>$|^<\/a>$/, `unexpected tag ${t}`);
};

test('linkify: HTML in the text is escaped, never markup', () => {
  const out = Utils.linkify('<img src=x onerror=alert(1)> & "quotes" \'single\'');
  assert.equal(out, '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot; &#039;single&#039;');
});

test('linkify: javascript: and data: URLs never become links', () => {
  for (const t of ['javascript:alert(1)', 'JaVaScRiPt:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>', 'ftp://example.com/file']) {
    const out = Utils.linkify(t);
    assert.ok(!/<a /.test(out), `${t} became a link: ${out}`);
  }
});

test('linkify: a URL containing www. or an @ is ONE link (no nested anchors inside an href)', () => {
  for (const t of ['https://user@host.example.com/x', 'https://a.example.com/?next=www.evil.example/onmouseover=alert(1)//', 'https://x.example.com/"onmouseover="alert(1)']) {
    const out = Utils.linkify(t);
    tagsAreOnlyAnchors(out);
    assert.equal(anchors(out).length, 1, out);
    assert.ok(!/onmouseover=/.test(anchors(out)[0].replace(/href="[^"]*"/, '')), `attribute injected: ${out}`);
  }
});

test('linkify: quotes and angle brackets end a URL and are escaped', () => {
  const out = Utils.linkify('see https://example.com/a"b<c>d');
  tagsAreOnlyAnchors(out);
  assert.ok(out.includes('href="https://example.com/a"'));
  assert.ok(out.includes('&quot;b&lt;c&gt;d'));
});

test('linkify: & in a URL is escaped in both the href and the text', () => {
  const out = Utils.linkify('https://example.com/?a=1&b=2');
  assert.ok(out.includes('href="https://example.com/?a=1&amp;b=2"'));
});

test('linkify: trailing punctuation stays outside the link', () => {
  const out = Utils.linkify('Go to https://example.com/x. Or (https://example.com/y), ok?');
  assert.ok(out.includes('href="https://example.com/x"'));
  assert.ok(out.includes('href="https://example.com/y"'));
  assert.ok(out.includes('</a>. Or'));
});

test('linkify: style can be turned off (read-only notes and the native popover use their own CSS)', () => {
  const out = Utils.linkify('https://example.com', { style: false });
  assert.equal(out, '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow ugc">https://example.com</a>');
});

test('read-only notes and the native popover go through Utils.linkify (no hand-rolled HTML)', () => {
  for (const [file, re] of [
    ['public/app.js', /getReadOnlyNotes\(\) \{[\s\S]*?Utils\.linkify\(/],
    ['public/nativecal/app.js', /getReadOnlyNotes\(\) \{[\s\S]*?Utils\.linkify\(/],
    ['public/nativecal/components/EventPopover.js', /linkified\(\) \{[\s\S]*?Utils\.linkify\(/],
  ]) {
    const src = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    assert.match(src, re, file);
  }
});

test('the popup observer linkifies text nodes, not innerHTML', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/utils/utils.js'), 'utf8');
  assert.ok(!/innerHTML = linkify\(/.test(src), 'innerHTML must not be fed back through linkify');
});
