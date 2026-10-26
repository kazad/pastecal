/**
 * Drift guards for the design system (docs/DESIGN-SYSTEM.md).
 *
 * The owner's complaint that started this: "every page has a different footer", buttons in six
 * radii, three blues, nineteen font sizes on one page. Each came from someone writing a value
 * by hand instead of using the shared one. These tests make that fail, fast, with a message
 * that says what to use instead:
 *
 *   1. Colors, font sizes, radii and shadows come from tokens.css (var(--pc-*)), everywhere we
 *      write CSS: components.css, style.css, site.css, legal.css, every page's <style> block and
 *      every inline style="" in the pages and the Vue templates.
 *   2. Tailwind in the markup can only produce scale values: its sizes, radii and shadows are
 *      mapped to tokens in tailwind.config.js, and palette colors (text-red-600) and arbitrary
 *      values (text-[10px]) are not allowed.
 *   3. Every <button> is a .pc-btn, or one of the few component classes listed below with the
 *      reason it is not.
 *   4. Every page links tokens.css, then components.css, before its own CSS.
 *
 * Exceptions are explicit and each carries its reason: the Syncfusion grid's tuned overrides and
 * the homepage's miniature illustrations live in marked regions of style.css
 * (@vendor-overrides, @illustrations), and SVG data URIs carry their own colors.
 *
 * Run: npm run test:unit:fast
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Every page a visitor can reach, and what each must link.
// Every .html under public/ (top level, pro/, dev/) is a page, so a new page is checked by default.
// Not checked, with why:
const EXCLUDED = {
  'public/design-ideas.html': 'a prototype scratch page, not linked from anywhere',
  'public/poll.html': 'an old standalone prototype with its own Tailwind accent, not linked from anywhere',
  // public/nativecal/** is not listed: the NativeCal beta (/beta) is a separate renderer with its own native.css.
};
const PAGES = ['', 'pro', 'dev'].flatMap((d) => fs.readdirSync(path.join(root, 'public', d)).filter((f) => f.endsWith('.html')).map((f) => path.posix.join('public', d, f)))
  .filter((p) => !(p in EXCLUDED));
// Scanned for values: every page but dev/pro.html, the old standalone /pro email-capture landing
// (a dev-only page kept for reference; nothing links it).
const SCANNED_PAGES = PAGES.filter((p) => p !== 'public/dev/pro.html');
const TEMPLATE_JS = ['public/app.js', ...fs.readdirSync(path.join(root, 'public/components')).filter((f) => f.endsWith('.js')).map((f) => `public/components/${f}`)];
const CSS_FILES = ['public/components.css', 'public/style.css', 'public/site.css', 'public/legal.css', 'public/features.css'];

const styleBlocks = (html) => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
// Inline style="" (and Vue's :style="{...}" is JS, so only literal style= is read). Each becomes a rule.
const inlineStyles = (src) => [...src.matchAll(/(?<![:\w-])style="([^"]*)"/g)].map((m) => `x{${m[1]}}`).join('\n');

/** [label, css] for everything we write by hand. */
function sources() {
  const out = CSS_FILES.map((f) => [f, read(f)]);
  for (const p of SCANNED_PAGES) { const h = read(p); out.push([`${p} <style>`, styleBlocks(h)], [`${p} style=""`, inlineStyles(h)]); }
  for (const j of TEMPLATE_JS) out.push([`${j} style=""`, inlineStyles(read(j))]);
  return out;
}

/** The CSS a guard should judge: allowed regions, comments and data URIs removed. */
function scannable(css) {
  return css
    .replace(/\/\*\s*@vendor-overrides\s*\*\/[\s\S]*?\/\*\s*@end-vendor-overrides\s*\*\//g, '')
    .replace(/\/\*\s*@illustrations\s*\*\/[\s\S]*?\/\*\s*@end-illustrations\s*\*\//g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\((["']?)data:[\s\S]*?\1\)/g, 'url()');
}
function declarations(css) {
  return [...scannable(css).matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)].map((m) => ({ prop: m[1], value: m[2].trim().replace(/\s*!important$/, '') }));
}
// Values outside var(...) — a var() fallback can't hide a raw value from these checks, it is read too.
const outsideVars = (v) => v.replace(/var\(--pc-[\w-]+\)/g, 'TOKEN');

// --- the four checks, as functions (so the self-test below can plant violations) ------------

const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
// Custom properties count too: a page's own `--blue: #2563eb` is a second palette (pricing and
// /pro/done had one each). Name the token instead: `--blue: var(--pc-primary)`.
function rawColors(css) {
  return declarations(css).filter((d) => RAW_COLOR.test(outsideVars(d.value))).map((d) => `${d.prop}: ${d.value}`);
}
// Font sizes: a token, inherit, or a relative size (em, %) that follows its parent's token.
function badFontSizes(css) {
  const ok = (v) => /^(TOKEN|inherit|0|[\d.]+em|[\d.]+%|smaller|larger)$/.test(v.trim());
  const out = [];
  for (const d of declarations(css)) {
    const v = outsideVars(d.value);
    if (d.prop === 'font-size' && !ok(v)) out.push(`font-size: ${d.value}`);
    if (d.prop === 'font' && /(^|\s)[\d.]+(px|rem)\b/.test(v.replace(/\/\s*[\d.]+(px|rem)?/g, ''))) out.push(`font: ${d.value}`);   // a /line-height is not a size
  }
  return out;
}
// Radii: a token, 0, 50% (a circle), inherit, or calc() on a token.
function badRadii(css) {
  return declarations(css).filter((d) => /^border(-[a-z]+)*-radius$/.test(d.prop))
    .filter((d) => outsideVars(d.value).replace(/calc\(TOKEN\s*-\s*\d+px\)/g, 'TOKEN').split(/\s+|\//).some((p) => p && !/^(TOKEN|0|50%|inherit)$/.test(p)))
    .map((d) => `${d.prop}: ${d.value}`);
}
// Shadows: a token, none, or a flat ring/hairline (no blur) in token colors. A blurred shadow is
// elevation, and elevation is only for floating things: use --pc-shadow-md/-lg/-xl.
function badShadows(css) {
  return declarations(css).filter((d) => d.prop === 'box-shadow').filter((d) => {
    const v = d.value.replace(/color-mix\([^()]*(\([^()]*\)[^()]*)*\)/g, 'TOKEN');
    if (/^(none|TOKEN|var\(--pc-(shadow-[\w-]+|focus-ring)\))$/.test(v)) return false;
    return v.split(/,(?![^(]*\))/).some((one) => {
      const s = outsideVars(one.trim());
      if (/^(none|TOKEN)$/.test(s)) return false;
      if (RAW_COLOR.test(s)) return true;
      const lengths = s.replace(/^inset\s+/, '').split(/\s+/).filter((t) => /^-?[\d.]+(px)?$/.test(t));
      return lengths.length >= 3 && parseFloat(lengths[2]) !== 0;   // offset-x offset-y BLUR
    });
  }).map((d) => `box-shadow: ${d.value}`);
}

const FIX = {
  color: 'use a color token: var(--pc-text|-text-2|-text-muted), --pc-bg|-surface|-soft, --pc-line|-field, --pc-primary (the one accent), --pc-success|-warning|-danger (+ -soft). No token fits? Add one to tokens.css, in both themes.',
  size: 'use the type scale: var(--pc-fs-2xs) 11, -xs 12, -sm 13, -md 14, -lg 16, -xl 18, -2xl 20, -3xl 28, -4xl 36; headings var(--pc-fs-section) / var(--pc-fs-hero).',
  radius: 'use var(--pc-radius-control) 8 for buttons and fields, -card 12, -dialog 16, -pill for pills and CTAs (-xs 4, -sm 6 for small marks), or 50% for a circle.',
  shadow: 'flat by default (a 1px var(--pc-line) border or a no-blur ring). Floating things only: var(--pc-shadow-md) menus/toasts, -lg popovers, -xl dialogs.',
};

for (const [what, check, fix] of [['raw colors', rawColors, FIX.color], ['font sizes off the scale', badFontSizes, FIX.size],
  ['radii off the scale', badRadii, FIX.radius], ['hand-made shadows', badShadows, FIX.shadow]]) {
  test(`no ${what} outside tokens.css`, () => {
    const offenders = [];
    for (const [label, css] of sources()) for (const d of check(css)) offenders.push(`${label}:  ${d}`);
    assert.deepEqual(offenders, [], `${offenders.length} found. Fix: ${fix}`);
  });
}

// --- Tailwind in the markup -----------------------------------------------------------------

const MARKUP = [...PAGES.filter((p) => !p.includes('/dev/')), ...TEMPLATE_JS];
// class="..." and string literals inside :class="..." bindings and classList calls.
function classTokens(src) {
  const out = [];
  for (const m of src.matchAll(/(?<![\w-])class="([^"]*)"/g)) out.push(...m[1].split(/\s+/));
  for (const m of src.matchAll(/:class="([^"]*)"/g)) for (const s of m[1].matchAll(/'([^']*)'/g)) out.push(...s[1].split(/\s+/));
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) out.push(m[1]);
  return out.filter(Boolean);
}
const PALETTE = /^(?:text|bg|border|ring|ring-offset|from|via|to|fill|stroke|divide|outline|placeholder|accent|caret|decoration|shadow)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\d+)?$/;
const ARBITRARY_VALUE = /^(?:text|rounded(?:-\w+)?|shadow|bg|border|ring|from|via|to|fill|stroke|leading|tracking)-\[/;
function badUtilities(tokens) {
  return tokens.map((t) => t.split(':').pop()).filter((t) => PALETTE.test(t) || ARBITRARY_VALUE.test(t) || /^shadow(-sm|-2xl|-inner)?$/.test(t));
}

test('Tailwind in the markup uses theme colors and the token scales only', () => {
  const offenders = [];
  for (const f of MARKUP) for (const t of badUtilities(classTokens(read(f)))) offenders.push(`${f}: ${t}`);
  assert.deepEqual(offenders, [],
    'palette colors (text-red-600), arbitrary values (text-[10px]) and unmapped shadows ignore the design system. ' +
    'Use the theme-* colors (text-theme-danger, bg-theme-hover, text-theme-primary...), text-xs/sm/base/lg, rounded-lg/full, shadow-md/lg/xl, ' +
    'or a .pc-* class from components.css.');
});

test('tailwind.config maps its font sizes, radii and shadows to tokens', () => {
  const cfg = read('tailwind.config.js');
  for (const block of ['fontSize', 'borderRadius', 'boxShadow']) {
    const m = cfg.match(new RegExp(`\\b${block}:\\s*\\{([\\s\\S]*?)\\n    \\}`));
    assert.ok(m, `tailwind.config.js must set theme.${block} (not extend it), so only token values exist`);
    const values = [...m[1].matchAll(/^\s*'?[\w-]+'?:\s*\[?\s*'([^']+)'/gm)].map((x) => x[1]);   // the size, not its line-height
    const raw = values.filter((v) => !/^var\(--pc-[\w-]+\)$|^0$|^none$/.test(v));
    assert.deepEqual(raw, [], `theme.${block} values must be var(--pc-*) tokens`);
  }
});

// --- Buttons ----------------------------------------------------------------------------------

// The components that are buttons but not .pc-btn, and why. Anything else gets .pc-btn + a variant.
const BUTTON_COMPONENTS = {
  'pc-hdr-btn': 'the desktop header toolbar: a segmented group of icon+label buttons (style.css "Header")',
  'pc-tab': 'a tab in a .pc-tabs row (components.css)',
  'pc-chip': 'a chip you press: templates, examples, color types (components.css)',
  'pc-link': 'a button that reads as a text link (components.css)',
  'pc-link-field': 'a link shown as a field that copies itself (components.css)',
  'pc-seg-btn': 'a segment of a .pc-seg control (components.css)',
  'pc-card': 'a selectable card: the Stats metric cards (components.css)',
  'pc-menu-item': 'a row in a .pc-menu (components.css)',
  'pc-nav-row': 'a row in the logo menu: icon + two lines (style.css "Logo menu")',
  'pc-swatch': 'an event color to pick: its fill is the event color (components.css)',
  'pc-filter-dot': 'a legend dot that filters events by color: its fill is the event color',
  'pc-search-result-head': 'a search result row that opens in place to show its notes (style.css "Search panel")',
  'pc-toast-act': 'the action on a toast, on the toast\'s inverted surface (style.css "Toast")',
  'pc-toast-x': 'the close on a toast, on the toast\'s inverted surface',
  'pc-addcal-nudge-text': 'the hint under "Add to my calendar", on an inverted tooltip surface',
  'pc-addcal-nudge-x': 'the close on that hint',
  'pc-paused-owner': 'the one warning-colored button: "Pro ended · Choose what happens"',
  'cta': 'pricing.html plan buttons (its own <style>, on tokens; Pro beta work is in flight there)',
};
function buttonsWithout(src) {
  const out = [];
  for (const m of src.matchAll(/<button\b([^>]*)>/g)) {
    const cls = (m[1].match(/(?<![:\w-])class="([^"]*)"/) || [, ''])[1].split(/\s+/);
    if (cls.includes('pc-btn') || cls.some((c) => c in BUTTON_COMPONENTS)) continue;
    out.push(`line ${src.slice(0, m.index).split('\n').length}: <button${m[1].replace(/\s+/g, ' ').slice(0, 90)}>`);
  }
  return out;
}

test('every <button> is a .pc-btn or a listed component', () => {
  const offenders = [];
  for (const f of MARKUP) for (const b of buttonsWithout(read(f))) offenders.push(`${f} ${b}`);
  assert.deepEqual(offenders, [],
    'give it class="pc-btn" plus a variant: pc-btn--primary (the main action), --secondary, --ghost, --danger, --link; ' +
    'size --xs/--sm/--lg; --icon for icon-only (with --ghost for a quiet one); --pill for a call to action. ' +
    'If it truly is a new component, add it to components.css and to BUTTON_COMPONENTS here with its reason.');
});

test('every EXCLUDED page still exists (no stale exceptions)', () => {
  const gone = Object.keys(EXCLUDED).filter((p) => !fs.existsSync(path.join(root, p)));
  assert.deepEqual(gone, [], 'remove these from EXCLUDED');
});

test('every BUTTON_COMPONENTS entry is still used (no stale exceptions)', () => {
  const all = MARKUP.map(read).join('\n');
  const stale = Object.keys(BUTTON_COMPONENTS).filter((c) => !new RegExp(`<button\\b[^>]*(?<![:\\w-])class="[^"]*\\b${c}\\b`).test(all));
  assert.deepEqual(stale, [], 'remove these from BUTTON_COMPONENTS: no <button> uses them any more');
});

// --- Pages link the system --------------------------------------------------------------------

test('every page links tokens.css, then components.css, before its own CSS', () => {
  for (const p of PAGES) {
    const h = read(p);
    const at = (href) => { const m = h.match(new RegExp(`href="${href.replace('.', '\\.')}(\\?[^"]*)?"`)); return m ? m.index : -1; };
    const t = at('/tokens.css'), c = at('/components.css');
    assert.ok(t !== -1, `${p} does not link /tokens.css. Add <link rel="stylesheet" href="/tokens.css"> first in <head>.`);
    assert.ok(c > t, `${p} must link /components.css right after /tokens.css.`);
    for (const own of ['/style.css', '/site.css', '/legal.css']) {
      const o = at(own);
      if (o !== -1) assert.ok(o > c, `${p}: ${own} must come after /components.css (components first, then the page's own styles).`);
    }
    const style = h.indexOf('<style');
    if (style !== -1 && h.indexOf('</head>') > style) assert.ok(style > c || !styleBlocks(h).trim(), `${p}: its <style> block must come after /components.css`);
  }
});

// --- Restraint ---------------------------------------------------------------------------------

test('one accent: the main app and the pages never use NativeCal\'s pink or the logo indigo as a fill', () => {
  const offenders = [];
  for (const [label, css] of sources()) {
    for (const d of declarations(css)) {
      if (/--pc-accent/.test(d.value)) offenders.push(`${label}: ${d.prop}: ${d.value}`);
      if (/--pc-brand/.test(d.value) && d.prop !== 'color') offenders.push(`${label}: ${d.prop}: ${d.value}`);
    }
  }
  assert.deepEqual(offenders, [], 'use var(--pc-primary). --pc-accent is NativeCal\'s; --pc-brand colors only the wordmark next to the logo.');
});

test('no decorative gradients outside the illustrations', () => {
  const offenders = [];
  // A mask's gradient draws nothing: it only fades the edge of a sideways-scrolling row (the template chips) to say "more this way".
  for (const [label, css] of sources()) for (const d of declarations(css)) if (/gradient\(/.test(d.value) && !/^(-webkit-)?mask-image$/.test(d.prop)) offenders.push(`${label}: ${d.prop}`);
  assert.deepEqual(offenders, [], 'flat colors only (restraint). A drawing belongs in style.css /* @illustrations */.');
});

// --- Readable on every surface ---------------------------------------------------------------------

test('muted text and links stay AA (4.5:1) on every surface, in both themes', () => {
  const tokens = read('public/tokens.css');
  const block = (sel) => {
    const i = tokens.indexOf(sel + ' {'); const body = tokens.slice(i, tokens.indexOf('\n}', i)).replace(/\/\*[\s\S]*?\*\//g, '');
    return Object.fromEntries([...body.matchAll(/(--pc-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const light = block(':root'), dark = { ...light, ...block('[data-theme="dark"]') };
  const bad = [];
  for (const [name, t] of [['light', light], ['dark', dark]]) for (const fg of ['--pc-text-muted', '--pc-primary']) for (const bg of ['--pc-bg', '--pc-surface', '--pc-soft']) {
    const r = ratio(t[fg], t[bg]);
    if (r < 4.5) bad.push(`${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
  }
  assert.deepEqual(bad, [], 'darken (light) or lighten (dark) the text token in tokens.css until it clears 4.5:1');
});

// --- /dev/design shows everything ---------------------------------------------------------------

test('/dev/design has a sample for every component components.css documents', () => {
  const documented = [...read('public/components.css').slice(0, 3000).matchAll(/^\s{5}\.(pc-[a-z-]+)/gm)].map((m) => m[1]);
  assert.ok(documented.length >= 10, 'the component list at the top of components.css went missing');
  const page = read('public/dev/design.html');
  const missing = documented.filter((c) => !page.includes(`'${c}': function`));
  assert.deepEqual(missing, [], 'add a sample for each to SAMPLES in public/dev/design.html (the gallery draws every variant from it)');
  assert.match(page, /getElementById\('out'\)\.innerHTML = html/, 'the gallery must still write what it builds into #out');
});

// --- The guards catch what they guard -----------------------------------------------------------

test('self-test: each guard flags a planted violation and passes the right way to write it', () => {
  assert.deepEqual(rawColors('.x { color: #ff0000; background: rgba(0,0,0,.1) }'), ['color: #ff0000', 'background: rgba(0,0,0,.1)']);
  assert.deepEqual(rawColors(':root { --blue: #2563eb } .x { color: var(--blue) }'), ['--blue: #2563eb'], 'a page palette in custom properties is caught');
  assert.deepEqual(rawColors('.x { color: var(--pc-text) } /* #fff */ .y { background: url("data:image/svg+xml,%23fff") } /* @illustrations */ .z { color: #123456 } /* @end-illustrations */'), []);
  assert.deepEqual(badFontSizes('.x { font-size: 12.5px } .y { font: 600 13px/1 var(--pc-font) }'), ['font-size: 12.5px', 'font: 600 13px/1 var(--pc-font)']);
  assert.deepEqual(badFontSizes('.x { font-size: var(--pc-fs-sm); font: var(--pc-fw-bold) var(--pc-fs-md)/18px var(--pc-font) } .y { font-size: .9em }'), []);
  assert.deepEqual(badRadii('.x { border-radius: 10px } .y { border-top-left-radius: 7px }'), ['border-radius: 10px', 'border-top-left-radius: 7px']);
  assert.deepEqual(badRadii('.x { border-radius: var(--pc-radius-card) var(--pc-radius-card) 0 0 } .y { border-radius: 50% } .z { border-radius: calc(var(--pc-radius-card) - 3px) }'), []);
  assert.deepEqual(badShadows('.x { box-shadow: 0 4px 12px rgba(0,0,0,.2) } .y { box-shadow: 0 2px 8px var(--pc-line) }'), ['box-shadow: 0 4px 12px rgba(0,0,0,.2)', 'box-shadow: 0 2px 8px var(--pc-line)']);
  assert.deepEqual(badShadows('.x { box-shadow: var(--pc-shadow-md) } .y { box-shadow: 0 0 0 2px var(--pc-bg), 0 0 0 4px var(--pc-primary) } .z { box-shadow: inset 0 -2px 0 var(--pc-primary) }'), []);
  assert.deepEqual(badUtilities(['text-red-600', 'hover:bg-gray-100', 'text-[10px]', 'shadow-sm', 'text-theme-danger', 'text-sm', 'rounded-lg', 'shadow-xl']), ['text-red-600', 'bg-gray-100', 'text-[10px]', 'shadow-sm']);
  assert.equal(buttonsWithout('<button class="pc-btn pc-btn--primary">a</button><button class="pc-chip">b</button>').length, 0);
  assert.equal(buttonsWithout('<button class="px-3 py-1 rounded text-xs">c</button><button :class="{ on: x }">d</button>').length, 2);
});
