// @ts-check
const { test, expect } = require('./fixtures');

// The Quick Add dialog's date and time inputs were fixed widths (w-44 + w-32, both
// shrink-0). With the row label and the dialog's padding that is wider than a 375px
// phone, so the time inputs ran off the right edge. They now stack below the sm
// breakpoint and may shrink.
//
// Geometry, not screenshots, as in mobile-popup.spec.js: the failure is "a control is
// outside the viewport", which is a number. Runs on the homepage, so it needs no
// calendar data from Firebase.

const INPUTS = ['#qa-start-date', '[aria-label="Start time"]', '#qa-end-date', '[aria-label="End time"]', '#qa-description'];

async function openQuickAdd(page, width) {
  await page.setViewportSize({ width, height: 740 });
  await page.goto('/');
  await page.waitForFunction(() => document.getElementById('app')?._vnode?.component?.proxy?.$refs && document.getElementById('app')._vnode.component.proxy.$refs.quickAddDialog,
    null, { timeout: 20_000 });
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.evaluate(() => document.getElementById('app')._vnode.component.proxy.$refs.quickAddDialog.showDialog());
  await page.locator('#qa-description').fill('lunch tomorrow 2pm for 1 hour');
  await expect(page.locator('[aria-label="End time"]')).toHaveValue('15:00');
  return pageWidth;
}

test.describe('Quick Add dialog on phones', () => {
  for (const width of [320, 375, 414]) {
    test(`every field fits on screen at ${width}px`, async ({ page }) => {
      const pageWidth = await openQuickAdd(page, width);
      const boxes = await page.evaluate((sels) => sels.map((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return { s, left: r.left, right: r.right };
      }), INPUTS);
      for (const b of boxes) {
        expect(b.left, `${b.s} left edge`).toBeGreaterThanOrEqual(0);
        expect(b.right, `${b.s} right edge`).toBeLessThanOrEqual(width);
      }
      // Opening the dialog must not widen the page. (Compared with the page before it
      // opened, since the header has its own few-px overflow at 320px.)
      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollW).toBeLessThanOrEqual(Math.max(width, pageWidth));
    });
  }

  test('date and time stay side by side on a desktop width', async ({ page }) => {
    await openQuickAdd(page, 1280);
    const [date, time] = await page.evaluate(() => ['#qa-start-date', '[aria-label="Start time"]']
      .map((s) => document.querySelector(s).getBoundingClientRect().top));
    expect(Math.abs(date - time)).toBeLessThanOrEqual(2);
  });
});
