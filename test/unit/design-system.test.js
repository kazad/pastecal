/**
 * Guardrails for the design language of the UI we build ourselves: tokens.css (the values),
 * components.css (the building blocks: .pc-btn, .pc-field, .pc-chip, ...) and style.css (screens).
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
 *      into tailwind.config.js (Tailwind is prebuilt by scripts/build-css.sh).
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
const TAILWIND_CONFIG = fs.readFileSync(path.join(__dirname, '../../tailwind.config.js'), 'utf8');
const TAILWIND_BUILT = fs.readFileSync(path.join(__dirname, '../../public/tailwind.css'), 'utf8');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const INDEX = read('public/index.html');
const STYLE = read('public/style.css');
const COMPONENTS = read('public/components.css');

// Files whose markup we own. Syncfusion's own DOM is excluded by construction.
const OUR_MARKUP = [
  'public/index.html',
  'public/components/NavigationDropdown.js',
  'public/components/QuickAddButton.js',
  'public/components/QuickAddDialog.js',
  'public/components/CalendarTitle.js',
  'public/components/ToastNotification.js',
  'public/components/Tooltip.js',
  'public/components/WelcomeDock.js',
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

  assert.match(TAILWIND_CONFIG, /darkMode:\s*\[\s*['"]selector['"]\s*,\s*['"]\[data-theme="dark"\]['"]\s*\]/,
    'dark: utilities only apply if Tailwind is told dark mode is data-theme="dark"; ' +
    'the default is prefers-color-scheme, which this app does not use');
});

test('theme colors exposed to Tailwind map to the CSS variables in style.css or tokens.css', () => {
  const configured = [...TAILWIND_CONFIG.matchAll(/['"]?(\w[\w-]*)['"]?:\s*'var\((--[\w-]+)\)'/g)]
    .map((m) => m[2]);
  const tokens = read('public/tokens.css');

  assert.ok(configured.length >= 4, 'expected the theme token block in tailwind.config');
  for (const cssVar of configured) {
    assert.ok(STYLE.includes(`${cssVar}:`) || tokens.includes(`${cssVar}:`),
      `tailwind.config references ${cssVar}, which neither style.css nor tokens.css defines`);
  }
});

// --- 3. The shared component classes exist and are theme-driven ---------------------------

test('components.css defines the shared building blocks', () => {
  for (const cls of [
    '.pc-btn', '.pc-btn--primary', '.pc-btn--ghost', '.pc-btn--danger', '.pc-btn--sm', '.pc-btn--xs', '.pc-btn--lg',
    '.pc-field', '.pc-field--sm', 'select.pc-field', '.pc-field-group', '.pc-chip', '.pc-tag', '.pc-card',
    '.pc-tabs', '.pc-tab', '.pc-seg', '.pc-switch', '.pc-kbd', '.pc-link-field', '.pc-modal', '.pc-modal-panel',
  ]) {
    assert.ok(COMPONENTS.includes(cls + ' ') || COMPONENTS.includes(cls + ','), `missing ${cls} in components.css`);
  }
});

test('shared surface classes derive their colors from theme variables', () => {
  // Pull each rule body and assert the themed ones use var(--…) rather than fixed
  // grays, so light/dark keeps working as the system grows.
  const ruleOf = (selector) => {
    const i = COMPONENTS.indexOf(`${selector} {`);
    assert.notEqual(i, -1, `missing rule ${selector}`);
    return COMPONENTS.slice(i, COMPONENTS.indexOf('}', i));
  };

  for (const selector of ['.pc-modal-panel', '.pc-field', '.pc-btn', '.pc-btn--primary', '.pc-chip', '.pc-tag', '.pc-card', '.pc-link-field']) {
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
  assert.match(dialog, /class="pc-field-group"/, 'slug field should use .pc-field-group');
  assert.match(dialog, /pc-btn pc-btn--primary/, 'submit should use .pc-btn .pc-btn--primary');
});

test('the prebuilt tailwind.css contains the theme and dark-mode rules the markup uses', () => {
  // Tailwind used to compile in the browser, so a class could never be "missing".
  // Prebuilt, a stale public/tailwind.css would silently leave new classes unstyled;
  // deploy.sh rebuilds it, and this catches a build that lost the dark variant or the
  // theme tokens.
  assert.match(TAILWIND_BUILT, /\[data-theme="?dark"?\]/, 'dark: rules missing from public/tailwind.css');
  for (const cls of ['bg-theme-panel', 'text-theme-strong', 'border-theme-border']) {
    // Built as .cls, or as a variant (.hover\:cls:hover) when the markup only uses it that way.
    if (INDEX.includes(cls)) assert.ok(TAILWIND_BUILT.includes('.' + cls) || TAILWIND_BUILT.includes('\\:' + cls), `${cls} is used but not in public/tailwind.css`);
  }
});

// --- Design tokens (public/tokens.css, shown live at /dev/design) --------------------------
// One source for color, type, space, shape and motion. These checks keep it the source:
// every token used is defined, the palette agrees with the app, and text stays readable.

const TOKENS = read('public/tokens.css');
const NATIVE_CSS = read('public/nativecal/native.css');
const DESIGN_PAGE = read('public/dev/design.html');
const APP_JS = read('public/app.js');
const NC_APP_JS = read('public/nativecal/app.js');
// The static pages (site.css chrome) and the CSS in their <style> blocks.
const STATIC_PAGES = ['pricing', 'help', 'contact', 'about', 'privacy', 'terms', 'report', 'signin'].map((n) => `public/${n}.html`);
const inlineStyles = (page) => [...read(page).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

/** name -> value for the declarations in one block of tokens.css (":root" or the dark one). */
function tokenBlock(selector) {
  const i = TOKENS.indexOf(selector + ' {');
  assert.notEqual(i, -1, `${selector} block missing from tokens.css`);
  const body = TOKENS.slice(i, TOKENS.indexOf('\n}', i)).replace(/\/\*[\s\S]*?\*\//g, '');   // comments mention token names
  const out = {};
  for (const m of body.matchAll(/(--pc-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
/** Follows var(--x) references (--pc-link: var(--pc-primary)) to the value they name. */
function resolve(theme) {
  const out = {};
  for (const [k, v] of Object.entries(theme)) {
    let val = v, hops = 0;
    while (/^var\((--pc-[\w-]+)\)$/.test(val) && hops++ < 10) val = theme[val.match(/^var\((--pc-[\w-]+)\)$/)[1]];
    out[k] = val;
  }
  return out;
}
const LIGHT = resolve(tokenBlock(':root'));
const DARK = resolve({ ...tokenBlock(':root'), ...tokenBlock('[data-theme="dark"]') });

function luminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('every var(--pc-*) used by the app, NativeCal, /dev/design and the static pages is defined in tokens.css', () => {
  const used = new Set();
  const sources = [read('public/style.css'), COMPONENTS, read('public/site.css'), read('public/legal.css'), NATIVE_CSS, DESIGN_PAGE, ...STATIC_PAGES.map(inlineStyles)];
  for (const src of sources) for (const m of src.matchAll(/var\((--pc-[\w-]*\w)[,)]/g)) used.add(m[1]);   // [,)]: skip names built in JS ('--pc-space-' + n)
  const missing = [...used].filter((t) => !(t in LIGHT));
  assert.deepEqual(missing, [], `used but not defined: ${missing.join(', ')}`);
});

test('text tokens meet WCAG AA (4.5:1) on the page background, in both themes', () => {
  for (const [name, theme] of [['light', LIGHT], ['dark', DARK]]) {
    for (const t of ['--pc-text', '--pc-text-2', '--pc-text-muted', '--pc-link', '--pc-primary', '--pc-danger', '--pc-success', '--pc-warning']) {
      const r = contrast(theme[t], theme['--pc-bg']);
      assert.ok(r >= 4.5, `${t} on --pc-bg in ${name}: ${r.toFixed(2)}:1`);
    }
    const onAccent = contrast(theme['--pc-accent'], theme['--pc-on-accent']);
    assert.ok(onAccent >= 4.5, `--pc-on-accent on --pc-accent in ${name}: ${onAccent.toFixed(2)}:1`);
    // The one blue: a filled button's label, and its hover.
    for (const fill of ['--pc-primary', '--pc-primary-hover']) {
      const r = contrast(theme[fill], theme['--pc-on-primary']);
      assert.ok(r >= 4.5, `--pc-on-primary on ${fill} in ${name}: ${r.toFixed(2)}:1`);
    }
    // Tags: a semantic color on its own soft background (the Draft tag, "can edit", "Save 33%").
    for (const c of ['success', 'warning', 'danger']) {
      const r = contrast(theme[`--pc-${c}`], theme[`--pc-${c}-soft`]);
      assert.ok(r >= 4.5, `--pc-${c} on --pc-${c}-soft in ${name}: ${r.toFixed(2)}:1`);
    }
  }
});

test('the event palette in tokens.css is the one the apps use', () => {
  const tokens = Array.from({ length: 16 }, (_, i) => LIGHT[`--pc-event-${i + 1}`].toLowerCase());
  const list = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
    assert.ok(m, `${name} not found`);
    return [...m[1].matchAll(/#[0-9a-fA-F]{6}/g)].map((x) => x[0].toLowerCase());
  };
  assert.deepEqual(tokens.slice(0, 8), list(NC_APP_JS, 'DEFAULT_COLORS'), 'categories 1-8 differ from nativecal DEFAULT_COLORS');
  assert.deepEqual(tokens.slice(8), list(APP_JS, 'EXTRA_COLORS'), 'categories 9-16 differ from app.js EXTRA_COLORS');
});

test('NativeCal v2 solid events have white text, as in the main app', () => {
  // Sep 26: black text chosen per color for contrast made coral events look unlike the main
  // app's; a category must look the same in both, so solid events are white text, always.
  const nc = read('public/nativecal/components/NativeCalendar.js');
  const paint = nc.slice(nc.indexOf('paint(type, tint)'), nc.indexOf('paint(type, tint)') + 400);
  assert.ok(!/textOn/.test(paint), 'paint() must not pick text color per event color');
  assert.match(paint, /'--on': '#fff'/);
  assert.match(paint, /color: '#fff'/);
});

test('pages that load style.css load tokens.css, then components.css, then style.css', () => {
  for (const page of ['public/index.html', 'public/nativecal/index.html', 'public/dev/pro.html', 'public/dev/design.html']) {
    const src = read(page);
    const t = src.indexOf('/tokens.css'), c = src.indexOf('/components.css'), s = src.indexOf('/style.css');
    assert.ok(t !== -1 && t < c && c < s, `${page}: link tokens.css, components.css, style.css in that order`);
  }
});

test('NativeCal v2 takes its colors from tokens, not hard-coded white', () => {
  const v2 = NATIVE_CSS.slice(NATIVE_CSS.indexOf('v2 (?ux=2)'));
  const bad = [...v2.matchAll(/[^-]color:\s*#fff\b/g)];
  assert.equal(bad.length, 0, 'use var(--pc-on-accent) for text on the accent: white is 2.9:1 on the dark-theme accent');
});

test('/dev/design is served', () => {
  const fb = JSON.parse(read('firebase.json'));
  const r = fb.hosting.rewrites.find((x) => x.source === '/dev/design');
  assert.ok(r && r.destination === '/dev/design.html', 'firebase.json needs a /dev/design rewrite before the catch-all');
  assert.ok(fb.hosting.rewrites.indexOf(r) < fb.hosting.rewrites.findIndex((x) => x.source === '**'), '/dev/design must come before **');
});

test('/beta serves NativeCal (the public beta), before the catch-all', () => {
  const fb = JSON.parse(read('firebase.json'));
  const all = fb.hosting.rewrites.findIndex((x) => x.source === '**');
  for (const src of ['/beta', '/beta/**']) {
    const i = fb.hosting.rewrites.findIndex((x) => x.source === src);
    assert.ok(i !== -1 && i < all && fb.hosting.rewrites[i].destination === '/nativecal/index.html', `${src} must rewrite to /nativecal/index.html before **`);
  }
  // Nobody can claim a calendar whose address the site routes elsewhere.
  assert.match(read('public/services/CalendarDataService.js'), /\['beta', 'nativecal', 'view', 'dev', [^\]]*\]\.includes/);
});


// --- One central design system: values live in tokens.css, nowhere else -------------------
// A raw hex color or a px font size outside tokens.css is a value the system can't change in
// one place (and a dark mode it can't follow). The two exceptions are marked regions:
//   style.css  /* @vendor-overrides */ ... /* @end-vendor-overrides */   the Syncfusion grid's tuned sizes
//   style.css  /* @illustrations */ ... /* @end-illustrations */         the homepage's miniature scenes
// Data URIs (SVG chevrons, masks) carry their own colors and are skipped; so are comments and
// px inside clamp() (fluid marketing headings). pricing-next.html is a draft and not scanned.

const CSS_SOURCES = [
  ['public/components.css', COMPONENTS],
  ['public/style.css', STYLE],
  ['public/site.css', read('public/site.css')],
  ['public/legal.css', read('public/legal.css')],
  ...STATIC_PAGES.map((p) => [`${p} <style>`, inlineStyles(p)]),
];

/** The CSS a guard should judge: comments, allowed regions and data URIs removed. */
function scannable(css) {
  return css
    .replace(/\/\*\s*@vendor-overrides\s*\*\/[\s\S]*?\/\*\s*@end-vendor-overrides\s*\*\//g, '')
    .replace(/\/\*\s*@illustrations\s*\*\/[\s\S]*?\/\*\s*@end-illustrations\s*\*\//g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\((["']?)data:[^)]*\1\)/g, 'url()');
}
/** Each "property: value" declaration, with the line it starts on. */
function declarations(css) {
  const out = [];
  for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) out.push({ prop: m[1], value: m[2].trim() });
  return out;
}
function rawHexColors(css) {
  return declarations(scannable(css)).filter((d) => /#[0-9a-fA-F]{3,8}\b/.test(d.value)).map((d) => `${d.prop}: ${d.value}`);
}
function pxFontSizes(css) {
  return declarations(scannable(css))
    .filter((d) => d.prop === 'font-size' || d.prop === 'font')
    .filter((d) => {
      const v = d.value.replace(/clamp\([^)]*\)/g, '').replace(/\/\s*[\d.]+px/g, '');   // fluid headings; a line-height is not a size
      return /(^|[\s(])[\d.]+px\b/.test(v);
    })
    .map((d) => `${d.prop}: ${d.value}`);
}

test('no raw hex colors outside tokens.css (components, screens, site and static pages)', () => {
  const offenders = [];
  for (const [file, css] of CSS_SOURCES) for (const d of rawHexColors(css)) offenders.push(`${file}: ${d}`);
  assert.deepEqual(offenders, [], 'use a token from tokens.css (add one there if no token fits)');
});

test('no px font sizes outside tokens.css: every size is on the type scale', () => {
  const offenders = [];
  for (const [file, css] of CSS_SOURCES) for (const d of pxFontSizes(css)) offenders.push(`${file}: ${d}`);
  assert.deepEqual(offenders, [], 'use var(--pc-fs-*) (2xs 11, xs 12, sm 13, md 14, lg 16, xl 18, 2xl 20, 3xl 28, 4xl 36, 5xl 40)');
});

test('the guards catch what they guard (a planted hex and px size fail)', () => {
  assert.deepEqual(rawHexColors('.x { color: #ff0000 }'), ['color: #ff0000']);
  assert.deepEqual(rawHexColors('#app .x { color: var(--pc-text) } /* #fff */ .y { background-image: url("data:image/svg+xml,%23fff") }'), []);
  assert.deepEqual(pxFontSizes('.x { font: 600 13px/1 var(--pc-font) }'), ['font: 600 13px/1 var(--pc-font)']);
  assert.deepEqual(pxFontSizes('.x { font-size: 12.5px }'), ['font-size: 12.5px']);
  assert.deepEqual(pxFontSizes('.x { font: var(--pc-fw-bold) var(--pc-fs-sm)/18px var(--pc-font); font-size: clamp(26px, 3vw, 38px) }'), []);
  assert.deepEqual(pxFontSizes('/* @illustrations */ .x { font-size: 9px } /* @end-illustrations */'), []);
});

test('the type scale and control heights are tokens, in order', () => {
  const px = (t) => parseFloat(LIGHT[t]);
  const scale = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'].map((n) => px(`--pc-fs-${n}`));
  assert.ok(scale.every((v, i) => i === 0 || v > scale[i - 1]), `font scale must increase: ${scale}`);
  assert.deepEqual(['xs', 'sm', 'md', 'lg'].map((n) => px(`--pc-h-${n}`)), [28, 32, 36, 44]);
  assert.deepEqual(['control', 'card', 'dialog'].map((n) => px(`--pc-radius-${n}`)), [8, 12, 16]);
  assert.equal(LIGHT['--pc-link'], LIGHT['--pc-primary'], 'one blue: links and the primary action are the same color');
  assert.equal(DARK['--pc-link'], DARK['--pc-primary'], 'one blue in dark mode too');
});
