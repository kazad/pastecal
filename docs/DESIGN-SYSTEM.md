# pastecal design system

One source for every visual value (`public/tokens.css`), one small set of building blocks
(`public/components.css`), and tests that fail when someone writes a value by hand
(`test/unit/design-guards.test.js`). The gallery is at `/dev/design`. It is generated from
the live CSS and shows light and dark side by side.

The goal is restraint: one accent, neutrals, color only when it means something, whitespace
instead of boxes, and shadows only on things that float. The pricing page and the Share panel
are the reference for calm.

## Inventory (October 2026, before the system)

These counts come from `public/*.html`, `public/*.css`, `public/components/*.js` and the
`app.js` templates. Each count is the number of **distinct** values or variants.

| What | Before | After |
|---|---|---|
| Font sizes | 45 raw px values (8px to 52px, including 11.5, 12.5, 13.5, 14.5) | 9 tokens + 2 fluid headings |
| Border radii | 25 raw values (3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 999, 9999px, asymmetric blobs) | 6 tokens |
| Box shadows | 15 hand-made shadows, most of them on flat things | 3 elevation tokens (floating only) + a knob |
| Raw colors in CSS and markup | 89 (three blues `#2563eb`/`#0277bd`/`#4aaaff`, a fourth for dark, page palettes on pricing and /pro/done) | 0 outside tokens.css (illustrations and the Syncfusion overrides are marked regions) |
| Dark surface greys | 6 (`#1e1e1e` app, `#26272c` guide, `#2a2a2a` side panel, `#0f1218`/`#171b23` pricing, `#0f131a` done) | 3: bg, surface, soft |
| Distinct `<button>` class lists | 78 | Every button is a `.pc-btn` variant or one of 17 listed components |
| Button-like classes (`*btn*`, `*cta*`) | 29 (`pc-pro-btn`, `pc-side-btn`, `pc-gopro-btn`, `.cta`, `.btn`, ...) | `.pc-btn` + variants |
| Link-styled buttons | 11 classes, each redeclaring the same look | `.pc-link` |
| Quiet icon/close buttons | 8 classes (`pc-upsell-x`, `pc-tpl-x`, `pc-home-hide`, `pc-side-close`, ...) | `.pc-btn--ghost.pc-btn--icon` |
| Pills, badges, tags, chips | 17 classes | `.pc-pill` (7 variants) and `.pc-chip` (pressable) |
| Cards and panels | 6 classes, with nested cards in Share, Help and the homepage | `.pc-card`. Nesting removed where it was decoration. |
| Inputs and fields | 16 classes | `.pc-field` (`--sm`, `--lg`) and `.pc-field-group` |
| Eyebrows, section headings | 17 classes | `.pc-eyebrow`, `.pc-section-title` |
| Tabs | 3 | `.pc-tabs` / `.pc-tab` |
| Toggles | 3 | `.pc-toggle` |
| Dialogs | 10 | `.pc-modal` / `.pc-modal-panel` |
| Toasts | 5 | one toast (style.css "Toast") on `--pc-toast` |
| Empty states | 6 | `.pc-empty` |
| List rows | 19 | `.pc-menu-item` for menus; screen rows keep their layout class |
| Site header/footer widths | 4 (`--site-max` 712, 720, 1052, 1120) | 1 (`--pc-page-max`, 1120) |
| Tailwind sizes/radii/shadows | Tailwind's own px scale (`text-[10px]`, `shadow-sm`) | Mapped to tokens in `tailwind.config.js` |

## Tokens (`public/tokens.css`)

**Neutrals.** `--pc-bg` (page, cards, fields), `--pc-surface` (raised panels: side panel,
homepage guide), `--pc-soft` (wells, chips, code), `--pc-hover`, `--pc-line` (hairlines),
`--pc-field` (field and secondary-button borders), `--pc-text`, `--pc-text-2`,
`--pc-text-muted`. The muted text is AA on all three surfaces. `--pc-canvas` and `--pc-raised`
are for a page of cards (pricing, sign-in): a soft canvas with white cards in light, and raised
cards in dark.

**The one accent.** `--pc-primary` (fill), `--pc-on-primary`, `--pc-primary-hover`,
`--pc-primary-soft` (the selected state), `--pc-link` (text only), `--pc-focus-ring`. The
dark-theme blue takes dark text.

**Meaning.** `--pc-success|warning|danger` with `-soft`, `--pc-toast*`, and the 16
`--pc-event-*` colors. `--pc-brand` colors only the wordmark next to the logo. `--pc-accent`
(pink) belongs to NativeCal only.

**Type.** One family (Figtree). Sizes are `2xs 11 · xs 12 · sm 13 · md 14 · lg 16 · xl 18 ·
2xl 20 · 3xl 28 · 4xl 36`, plus `--pc-fs-section` and `--pc-fs-hero` (fluid). Weights are 400,
600 and 700 on most surfaces.

**Space.** A 4px grid: `--pc-space-1..12`. Control heights are `--pc-h-xs 28 · sm 32 · md 36 ·
lg 44`.

**Radius.** `xs 4` and `sm 6` for small marks, `control 8` for buttons and fields, `card 12`,
`dialog 16`, and `pill` for pills, chips and calls to action.

**Elevation.** `--pc-shadow-md` (menus, toasts), `-lg` (popovers), `-xl` (dialogs). Nothing
else has a blurred shadow.

## Components (`public/components.css`)

| Class | Variants | Use |
|---|---|---|
| `.pc-btn` | `--primary` (the one main action), `--secondary` (default), `--ghost`, `--danger`, `--link`; `--xs/--sm/--lg`; `--icon`; `--pill` | Every button |
| `.pc-link` | | A text link, or a button that reads as one |
| `.pc-field` | `--sm`, `--lg`; `select.pc-field` has its own chevron | Inputs, selects, textareas |
| `.pc-field-group` | | A field with a fixed prefix (`pastecal.com/`) |
| `.pc-chip` | `--soft`, `--lg`, `--dot` | A pill you press: templates, examples, color types |
| `.pc-pill` | neutral, `--info`, `--success`, `--warning`, `--danger`, `--pro`, `--beta` | A label you read |
| `.pc-card` | `--flat`, `--pad` | A bordered surface, never inside another |
| `.pc-eyebrow`, `.pc-section-title`, `.pc-empty` | | Section labels, headings, empty lists |
| `.pc-tabs` / `.pc-tab` | | Tab rows (side panel) |
| `.pc-seg` / `.pc-seg-btn` | | Segmented controls (Stats) |
| `.pc-toggle` | | On/off |
| `.pc-kbd`, `.pc-link-field` | | Key caps; a link that copies itself |
| `.pc-modal` / `.pc-modal-panel`, `.pc-scrim` | `--wide` | Dialogs |
| `.pc-menu` / `.pc-menu-item` | | Floating menus |
| `.pc-swatch` | `.is-selected` | Picking an event color |

Screens (`style.css`) arrange these blocks and add layout: margins, grids, positions. A screen
class that restyles a component's look (color, border, radius, font) is drift.

## The guards (`npm run test:unit:fast`)

`test/unit/design-guards.test.js` fails, and says what to use instead, when:

- A raw color, off-scale font size, off-scale radius or blurred shadow appears outside
  tokens.css. It checks every CSS file, every page's `<style>` and every inline `style=""` in
  the pages and Vue templates. The Syncfusion overrides and the homepage illustrations are
  marked regions (`/* @vendor-overrides */`, `/* @illustrations */`).
- Markup uses a Tailwind palette color (`text-red-600`), an arbitrary value (`text-[10px]`)
  or an unmapped shadow, or `tailwind.config.js` stops mapping sizes, radii and shadows to
  tokens.
- A `<button>` is neither a `.pc-btn` nor a listed component. The list says why each exception
  exists, and a stale entry also fails.
- A page doesn't link `tokens.css` and then `components.css` before its own CSS.
- The main app uses NativeCal's pink, uses the logo indigo as a fill, or uses a gradient.
- Muted text or the accent drops below 4.5:1 on any surface, in either theme.
- `/dev/design` is missing a sample for a component that components.css documents.

`test/unit/design-system.test.js` (token definitions, WCAG on bg, the event palette) and
`test/unit/site-chrome.test.js` (one shared header and footer) still run alongside it.

## Adding something

1. Need a value? Use a token. If none fits, add one to tokens.css in both themes, with a
   comment saying what it is for.
2. Need a control? Use a component and a variant. If it is truly new, add it to
   components.css, to the list at the top of that file, to `SAMPLES` in `/dev/design`, and,
   if it is a button, to `BUTTON_COMPONENTS` with its reason.
3. Run `npm run test:unit:fast`.
