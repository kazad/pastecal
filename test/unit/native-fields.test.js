/**
 * Every field in the native calendar's templates is the shared field (components.css .pc-field).
 *
 * Why this exists: the event card's Repeat > Custom… panel used raw <select>, <input type=number> and
 * <input type=date>, styled ad hoc in native-calendar.css. In dark mode the unit dropdown showed the browser's own
 * arrow jammed against its right edge, unlike every other chevron in the card, and the date field read "mm/dd/yyyy".
 * .pc-field (select.pc-field: our chevron, 34px of room for it) was written for exactly that, but nothing made a new
 * template use it, and the design guards only checked tokens. This test scans public/nativecal/**.js and fails on a
 * <select> or <input> that is not a .pc-field, so the next panel cannot drift the same way.
 *
 * Not fields, each with why (radios and checkboxes are choices, not fields: they take accent-color instead):
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const EXEMPT = {
  'nq-title': "the quick-create popover's title, the same heading treatment",
};
const NOT_FIELDS = /^(radio|checkbox|hidden|color)$/i;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : d.name.endsWith('.js') ? [p] : [];
  });
}

test('every <select> and <input> in the native calendar templates is a .pc-field', () => {
  const bad = [];
  for (const f of files(path.join(root, 'public/nativecal'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<(select|input)\b[^>]*>/g)) {
      const tag = m[0];
      const type = (/\stype="([^"]*)"/.exec(tag) || [])[1] || '';
      if (m[1] === 'input' && NOT_FIELDS.test(type)) continue;
      const cls = (/\sclass="([^"]*)"/.exec(tag) || [])[1] || '';
      const names = cls.split(/\s+/);
      if (names.includes('pc-field') || names.some((c) => c in EXEMPT)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${path.relative(root, f)}:${line}  ${tag.slice(0, 90)}`);
    }
  }
  assert.deepEqual(bad, [], 'Give these class="pc-field" (pc-field--sm when compact), from components.css:\n' + bad.join('\n'));
});

test('radios and checkboxes in the native calendar take the accent color', () => {
  const css = fs.readFileSync(path.join(root, 'public/native-calendar.css'), 'utf8');
  assert.match(css, /\.nk-cust input\[type=radio\][^{]*\{[^}]*accent-color:\s*var\(--pc-primary\)/, 'the card\'s radios: accent-color var(--pc-primary)');
});
