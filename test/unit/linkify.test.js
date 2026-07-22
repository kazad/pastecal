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

test('linkify: sets rel="noopener noreferrer" on target=_blank links (reverse-tabnabbing guard)', () => {
  const out = Utils.linkify('See https://example.com/x');
  assert.match(out, /rel="noopener noreferrer"/);
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
