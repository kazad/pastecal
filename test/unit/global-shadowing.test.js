/**
 * Root-cause guard for the "new Event('input') throws" bug: public/models/Event.js declares a
 * top-level `class Event`, which shadows the browser's Event for every script on the page,
 * including Vue and wallet extensions. Nothing flagged it for ~11 months.
 *
 * Any top-level name in a page script that is also a DOM global replaces the browser's version.
 * This fails on a NEW collision; the one known collision (Event) is allowlisted only while its
 * constructor still hands DOM-style calls to the real class.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '../../public');
const DOM_GLOBALS = new Set(['Event', 'EventTarget', 'CustomEvent', 'Node', 'Element', 'Document', 'Text', 'Comment',
  'Range', 'Selection', 'History', 'Location', 'Notification', 'Option', 'Image', 'Audio', 'File', 'FileReader', 'Blob',
  'URL', 'Request', 'Response', 'Headers', 'Storage', 'Screen', 'Worker', 'Touch', 'Cache', 'Animation', 'Plugin',
  'Window', 'Navigator', 'Performance', 'Crypto', 'Intl', 'Map', 'Set', 'Date', 'Promise', 'Symbol', 'Error',
  'Window', 'Attr', 'Path2D', 'Permissions', 'Clipboard', 'MutationObserver', 'Observable']);
const ALLOWED = { Event: /typeof options === 'string'\) return Reflect\.construct\(globalThis\.Event/ };

function pageScripts() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  return [...html.matchAll(/<script[^>]*\ssrc="([^"?]+)/g)].map(m => m[1])
    .filter(s => !/^https?:/.test(s) && !s.includes('vendor'))
    .map(s => path.join(PUBLIC, s.replace(/^\//, ''))).filter(f => fs.existsSync(f));
}

test('no page script shadows a DOM/JS global without a guard', () => {
  const scripts = pageScripts();
  assert.ok(scripts.length > 10, 'found the page scripts');
  const bad = [];
  for (const f of scripts) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      if (!DOM_GLOBALS.has(name)) continue;
      if (ALLOWED[name] && ALLOWED[name].test(src)) continue;
      bad.push(`${name} in ${path.relative(PUBLIC, f)}`);
    }
  }
  assert.deepEqual(bad, [], 'rename these (or guard the constructor): ' + bad.join(', '));
});
