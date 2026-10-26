// The toast (components/ToastNotification.js) is styled: a merge once dropped its .pc-toast rules and every
// toast rendered as plain text in the page flow (Oct 2026 integration).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');

test('every class the toast uses has a rule in style.css or components.css', () => {
  const css = ['public/style.css', 'public/components.css'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const js = fs.readFileSync(path.join(root, 'public/components/ToastNotification.js'), 'utf8');
  const used = [...new Set([...js.matchAll(/\bpc-toast[\w-]*/g)].map((m) => m[0]))].filter((c) => !c.endsWith('-'));
  assert.ok(used.includes('pc-toast'));
  const missing = used.filter((c) => !new RegExp(`\\.${c}(?![\\w-])`).test(css));
  assert.deepEqual(missing, []);
});
