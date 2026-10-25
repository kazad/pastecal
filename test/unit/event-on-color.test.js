// Event text color: dark text on light event colors, white on dark ones, chosen by WCAG contrast.
// White on the light palette colors (orange, sky, gray, lime) measured 2-3:1, unreadable.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ScheduleAdapter = require('../../public/services/ScheduleAdapter.js');

// The palette as app.js defines it, so this test can't drift from the colors people see.
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const palette = (name) => {
  const m = src.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
  assert.ok(m, `${name} not found in app.js`);
  return m[1].match(/#[0-9a-f]{6}/gi);
};
const COLORS = [...palette('DEFAULT_COLORS'), ...palette('EXTRA_COLORS')];
const WHITE = '#ffffff', INK = '#14171c';

test('the palette was read: 16 colors', () => {
  assert.strictEqual(COLORS.length, 16);
});

test('every palette color gets text at 4.5:1 or better', () => {
  for (const c of COLORS) {
    const on = ScheduleAdapter.onColor(c);
    const ratio = ScheduleAdapter.contrastRatio(c, on);
    assert.ok(ratio >= 4.5, `${c} with ${on} is ${ratio.toFixed(2)}:1`);
  }
});

test('light colors get dark text, dark colors get white', () => {
  for (const c of ['#ff9800', '#03a9f4', '#c0ca33', '#00bfa5']) assert.strictEqual(ScheduleAdapter.onColor(c), INK, c);
  for (const c of ['#3f51b5', '#27282f', '#880e4f', '#8e24aa', '#455a64', '#d0442f', '#2e7d32', '#757575']) assert.strictEqual(ScheduleAdapter.onColor(c), WHITE, c);
});

test('always the better of the two, even where neither reaches 4.5 (custom colors)', () => {
  for (let i = 0; i < 400; i++) {
    const c = '#' + Math.floor((i * 2654435761) % 0xffffff).toString(16).padStart(6, '0');
    const on = ScheduleAdapter.onColor(c);
    const other = on === WHITE ? INK : WHITE;
    assert.ok(ScheduleAdapter.contrastRatio(c, on) >= ScheduleAdapter.contrastRatio(c, other), c);
  }
});

test('contrast ratio matches WCAG reference values', () => {
  assert.strictEqual(ScheduleAdapter.contrastRatio('#000', '#fff').toFixed(1), '21.0');
  assert.strictEqual(ScheduleAdapter.contrastRatio('#fff', '#fff'), 1);
  assert.strictEqual(ScheduleAdapter.contrastRatio('#777777', '#ffffff').toFixed(2), '4.48');
});

test('an unreadable color falls back to white rather than throwing', () => {
  assert.strictEqual(ScheduleAdapter.onColor('rebeccapurple'), WHITE);
  assert.strictEqual(ScheduleAdapter.onColor(undefined), WHITE);
});
