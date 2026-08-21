// @ts-check
const { test, expect } = require('./fixtures');

// Syncfusion's quick popup is a fixed 365px wide and never shrinks. On a phone
// that is almost the whole screen, so anchoring it beside the tapped event --
// correct on desktop -- pushed it hard against one edge. At 320px it ran 11px
// past the right edge, putting the edit, delete and close buttons off-screen
// with no way to reach them.
//
// These assert on geometry rather than screenshots: the failure is "a control is
// outside the viewport", which is a number, and a pixel diff would also fail for
// every unrelated style change.

const POPUP = '.e-quick-popup-wrapper';

async function openPopup(page, width, height = 800) {
  await page.setViewportSize({ width, height });
  await page.goto('/rldispatch');
  await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  await page.locator('.e-appointment').first().click({ force: true });
  await expect(page.locator(POPUP)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(600);
}

const box = (page) => page.evaluate(() => {
  const w = document.querySelector('.e-quick-popup-wrapper');
  const r = w.getBoundingClientRect();
  return {
    left: r.left, right: r.right, width: r.width,
    viewport: window.innerWidth,
    gapLeft: r.left, gapRight: window.innerWidth - r.right,
  };
});

test.describe('Event popup on phones', () => {
  for (const width of [320, 360, 390, 414]) {
    test(`fits on screen at ${width}px`, async ({ page }) => {
      await openPopup(page, width);
      const b = await box(page);

      // 1px of tolerance for subpixel rounding on the centring transform.
      expect(b.left).toBeGreaterThanOrEqual(-1);
      expect(b.right).toBeLessThanOrEqual(b.viewport + 1);
    });
  }

  test('is centred rather than anchored to the tapped event', async ({ page }) => {
    await openPopup(page, 390);
    const b = await box(page);

    // Before the fix this was 16 / 9 -- visibly lopsided, and the asymmetry grew
    // with the position of the event that was tapped.
    expect(Math.abs(b.gapLeft - b.gapRight)).toBeLessThanOrEqual(4);
  });

  test('the close button is reachable at the narrowest supported width', async ({ page }) => {
    // The actual user-facing symptom: controls pushed off the edge.
    await openPopup(page, 320, 720);

    const closeBtn = page.locator(`${POPUP} .e-close`).first();
    await expect(closeBtn).toBeVisible();

    const b = await closeBtn.boundingBox();
    expect(b).not.toBeNull();
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(320);

    // And it still works, not merely renders.
    await closeBtn.click({ force: true });
    await expect(page.locator(POPUP)).toBeHidden({ timeout: 5000 });
  });

  test('a wide-description popup is capped to the screen', async ({ page }) => {
    // .pc-wide widens to 480px for long descriptions, which is wider than any
    // phone; the mobile cap has to win over it.
    await openPopup(page, 390);
    const capped = await page.evaluate(() => {
      const w = document.querySelector('.e-quick-popup-wrapper');
      w.classList.add('pc-wide');
      const r = w.getBoundingClientRect();
      return { width: r.width, viewport: window.innerWidth };
    });
    expect(capped.width).toBeLessThanOrEqual(capped.viewport);
  });

  test('desktop still anchors the popup near the event', async ({ page }) => {
    // The mobile rule is scoped to max-width 480px; a regression that applied it
    // everywhere would drag every desktop popup to the middle of the screen.
    await openPopup(page, 1280, 900);
    const b = await box(page);

    expect(b.width).toBeLessThan(600);
    // Not centred: a centred 1280px viewport would give equal gaps.
    expect(Math.abs(b.gapLeft - b.gapRight)).toBeGreaterThan(10);
  });
});
