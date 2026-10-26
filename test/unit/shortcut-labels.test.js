/**
 * GUARD (root 7, Oct 26 2026): a shortcut is written for the keyboard in front of the reader -- ⌘ and ⌥ on a Mac,
 * Ctrl and Alt elsewhere -- by one helper, public/utils/keys.js (pcKeys.mod('D'), pcKeys.alt, pcKeys.del).
 *
 * Why: the shortcuts sheet and the event menu were written on a Mac with ⌘D, ⌘Z and ⌥ typed in, and said so on
 * Windows and Linux too (editor-stress-2 S14; the menu's Delete said ⌫), while "+ Add event" had its own platform check. So: no ⌘ or ⌥ typed
 * into the app outside keys.js (code comments aside; a sentence naming both keyboards, "⌘C or Ctrl+C", is fine).
 * The browser half (editor-stress-2 S14, with a Windows platform) reads the sheet and the menu.
 * Run: node --test test/unit/shortcut-labels.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', '..', 'public');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return ['vendor', 'js-old-components', 'demo', 'dev'].includes(d.name) ? [] : files(p);
    return /\.(js|html)$/.test(d.name) ? [p] : [];
  });
}

test('no ⌘, ⌥ or ⌫ typed into the app outside utils/keys.js', () => {
  const found = [];
  for (const f of files(PUB)) {
    if (f.endsWith(path.join('utils', 'keys.js'))) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/<!--.*?-->/g, '');
      if (!/[⌘⌥⌫]/.test(code)) return;
      if (/[⌘⌥⌫]/.test(code) && /\bCtrl\b/.test(code)) return;   // (a static page naming both keyboards: "⌘C or Ctrl+C")
      found.push(`${path.relative(PUB, f)}:${i + 1}: ${code.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(found, []);
});

for (const [platform, want] of [['Win32', { d: 'Ctrl+D', z: 'Ctrl+Z', alt: 'Alt', del: 'Delete' }], ['Linux x86_64', { d: 'Ctrl+D', z: 'Ctrl+Z', alt: 'Alt', del: 'Delete' }],
  ['MacIntel', { d: '⌘D', z: '⌘Z', alt: '⌥', del: '⌫' }], ['iPad', { d: '⌘D', z: '⌘Z', alt: '⌥', del: '⌫' }]]) {
  test(`pcKeys spells shortcuts for ${platform}`, () => {
    const ctx = { navigator: { platform } };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(PUB, 'utils', 'keys.js'), 'utf8'), ctx);
    const k = ctx.pcKeys;
    assert.deepEqual({ d: k.mod('D'), z: k.mod('Z'), alt: k.alt, del: k.del }, want);
  });
}
