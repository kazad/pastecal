/**
 * Guardrails for the design language of the UI we build ourselves
 * (public/style.css `.pc-*` classes + the theme variables above them).
 *
 * Syncfusion styles the calendar grid; everything around it is ours. Two failure
 * modes have already shipped here, so both are locked down:
 *
 *   1. HARDCODED GRAYS. `text-gray-900` on the claim dialog's heading rendered
 *      near-black on a dark panel — the title of the most important modal in the
 *      product was effectively invisible in dark mode. Tailwind gray/slate/zinc
 *      utilities don't read the theme variables, so they must carry an explicit
 *      `dark:` counterpart or use a theme token instead.
 *
 *   2. CLASSES THAT SILENTLY DO NOTHING. `.bg-disabled` is a plain CSS class in
 *      style.css, not a Tailwind utility, so `disabled:bg-disabled` never applied
 *      (verified in-browser: the button stayed green). Variant-prefixed usages
 *      must reference a real Tailwind color — hence the `theme.*` colors wired
 *      into tailwind.config in index.html.
 *
 * These are static checks on the markup: cheap, and they fail loudly the next
 * time someone reaches for a raw gray in a themed surface.
 *
 * Run: npm run test:unit:fast   (node 20/22 — see test/README.md)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const INDEX = read('public/index.html');
const STYLE = read('public/style.css');

// Files whose markup we own. Syncfusion's own DOM is excluded by construction.
const OUR_MARKUP = [
  'public/index.html',
  'public/components/NavigationDropdown.js',
  'public/components/QuickAddButton.js',
  'public/components/QuickAddDialog.js',
  'public/components/CalendarTitle.js',
  'public/components/ToastNotification.js',
  'public/components/Tooltip.js',
];

const CLASS_ATTR = /class="([^"]*)"/g;
const RAW_GRAY = /(?:^|:)(?:text|bg|border)-(?:gray|slate|zinc|neutral)-\d{3}$/;

/** Every class token that appears in a class="..." attribute of the given source. */
function classTokens(src) {
  const out = [];
  for (const m of src.matchAll(CLASS_ATTR)) {
    for (const tok of m[1].split(/\s+/).filter(Boolean)) out.push(tok);
  }
  return out;
}

// --- 1. No un-themed grays in surfaces we style ------------------------------------------

test('no hardcoded gray utility lacks a dark: counterpart', () => {
  const offenders = [];

  for (const file of OUR_MARKUP) {
    const src = read(file);
    for (const m of src.matchAll(CLASS_ATTR)) {
      const tokens = m[1].split(/\s+/).filter(Boolean);
      const bare = tokens.filter((t) => !t.startsWith('dark:') && RAW_GRAY.test(t));
      if (!bare.length) continue;

      // A bare gray is acceptable only if the same class list also declares a
      // dark: variant for that property (e.g. bg-gray-100 dark:bg-gray-700).
      for (const tok of bare) {
        const prop = tok.replace(/^(?:.*:)?((?:text|bg|border))-.*$/, '$1');
        const hasDark = tokens.some((t) => t.startsWith('dark:') && t.includes(`${prop}-`));
        if (!hasDark) offenders.push(`${file}: ${tok}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'themed surfaces must use theme tokens (bg-1/bg-2/text-color-1/text-color-2/pc-*) ' +
    'or pair the gray with a dark: variant');
});

test('no bare bg-white in themed surfaces', () => {
  const offenders = [];
  for (const file of OUR_MARKUP) {
    for (const tok of classTokens(read(file))) {
      if (tok === 'bg-white') offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'bg-white ignores the theme; use bg-1 or .pc-modal-panel');
});

// --- 2. Variant-prefixed classes must be real Tailwind utilities ---------------------------

test('style.css-only classes are never used with a Tailwind variant prefix', () => {
  // These exist only as plain CSS rules in style.css, so `disabled:`/`hover:`/`focus:`
  // prefixed forms compile to nothing at all.
  const cssOnly = ['bg-1', 'bg-2', 'bg-disabled', 'text-color-1', 'text-color-2', 'border-color-default'];
  const offenders = [];

  for (const file of OUR_MARKUP) {
    for (const tok of classTokens(read(file))) {
      const [variant, base] = tok.includes(':')
        ? [tok.slice(0, tok.lastIndexOf(':')), tok.slice(tok.lastIndexOf(':') + 1)]
        : [null, tok];
      if (variant && cssOnly.includes(base)) offenders.push(`${file}: ${tok}`);
    }
  }

  assert.deepEqual(offenders, [],
    'these are plain CSS classes, not Tailwind utilities — a variant prefix silently ' +
    'does nothing. Use the theme-* Tailwind colors from tailwind.config instead.');
});

test('tailwind is configured to read data-theme, or no dark: utilities are used', () => {
  const usesDarkVariant = classTokens(INDEX).some((t) => t.startsWith('dark:'));
  if (!usesDarkVariant) return;

  assert.match(INDEX, /darkMode:\s*\[\s*['"]selector['"]\s*,\s*['"]\[data-theme="dark"\]['"]\s*\]/,
    'dark: utilities only apply if Tailwind is told dark mode is data-theme="dark"; ' +
    'the default is prefers-color-scheme, which this app does not use');
});

test('theme colors exposed to Tailwind map to the CSS variables in style.css', () => {
  const configured = [...INDEX.matchAll(/'(?:theme-)?(\w[\w-]*)':\s*'var\((--[\w-]+)\)'/g)]
    .map((m) => m[2]);

  assert.ok(configured.length >= 4, 'expected the theme token block in tailwind.config');
  for (const cssVar of configured) {
    assert.ok(STYLE.includes(`${cssVar}:`),
      `tailwind.config references ${cssVar}, which style.css does not define`);
  }
});

// --- 3. The shared component classes exist and are theme-driven ---------------------------

test('style.css defines the shared control classes', () => {
  for (const cls of [
    '.pc-btn', '.pc-btn-primary', '.pc-btn-secondary', '.pc-btn-danger',
    '.pc-modal', '.pc-modal-panel', '.pc-input', '.pc-input-group',
  ]) {
    assert.ok(STYLE.includes(cls), `missing ${cls} in style.css`);
  }
});

test('shared surface classes derive their colors from theme variables', () => {
  // Pull each rule body and assert the themed ones use var(--…) rather than fixed
  // grays, so light/dark keeps working as the system grows.
  const ruleOf = (selector) => {
    const i = STYLE.indexOf(`${selector} {`);
    assert.notEqual(i, -1, `missing rule ${selector}`);
    return STYLE.slice(i, STYLE.indexOf('}', i));
  };

  for (const selector of ['.pc-modal-panel', '.pc-input', '.pc-btn-secondary']) {
    assert.match(ruleOf(selector), /var\(--/,
      `${selector} should be built from theme variables`);
  }
});

test('the claim dialog uses the shared modal, input and button classes', () => {
  const start = INDEX.indexOf('<!-- Claim Intervention Modal -->');
  assert.notEqual(start, -1, 'claim dialog not found');
  const dialog = INDEX.slice(start, start + 2500);

  assert.match(dialog, /class="pc-modal"/, 'overlay should use .pc-modal');
  assert.match(dialog, /class="pc-modal-panel"/, 'panel should use .pc-modal-panel');
  assert.match(dialog, /class="pc-input-group"/, 'slug field should use .pc-input-group');
  assert.match(dialog, /pc-btn pc-btn-primary/, 'submit should use .pc-btn .pc-btn-primary');
});
