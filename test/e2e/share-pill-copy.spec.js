// @ts-check
const { test, expect } = require('./fixtures');

// Sharing was the weakest number in the funnel: 22 share events from 16 people
// in 30 days, against ~3,900 visitors. The cause was not a missing control but
// a costly one -- the header pill opened a four-quadrant "Sharing & Security"
// console with five copy buttons and five URLs, led by an Edit-vs-View
// permissions choice. Someone sending a link to a friend had to make a security
// decision first.
//
// The pill now copies on click. Everything else moved one click away, behind the
// chevron. These tests lock in the two properties that make that safe: it copies
// the READ-ONLY link, and the console is still reachable.

const PILL = '[data-testid="share-pill-existing"]';
const MORE = '[data-testid="share-pill-more"]';
const COPIED = '[data-testid="share-pill-copied"]';

async function open(page, slug = 'rldispatch') {
  await page.goto(`/${slug}`);
  await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
}

function captureAnalytics(page) {
  return page.addInitScript(() => {
    window.__fired = [];
    let held;
    Object.defineProperty(window, 'Analytics', {
      configurable: true,
      get() { return held; },
      set(v) {
        held = v;
        const o = v.track.bind(v);
        v.track = function (n, p) { window.__fired.push({ name: n, params: p }); return o(n, p); };
      },
    });
  });
}

test.describe('Header share pill', () => {
  test('clicking the pill copies rather than opening the console', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);

    await page.locator(PILL).click();
    await expect(page.locator(COPIED)).toBeVisible();

    // The console must NOT have opened -- that was the old behavior and the
    // whole cost this change removes.
    await expect(page.locator('text=Sharing & Security')).toHaveCount(0);
  });

  test('copies the read-only link, never the editable one', async ({ page, context }) => {
    // The one mistake here that cannot be undone is handing out edit rights by
    // accident, so the safe URL has to be the default.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);

    await page.locator(PILL).click();
    await expect(page.locator(COPIED)).toBeVisible();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('/view/');
    expect(copied).not.toMatch(/pastecal\.com\/rldispatch$/);
  });

  test('the copied state reverts on its own', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);

    await page.locator(PILL).click();
    await expect(page.locator(COPIED)).toBeVisible();
    // Back to showing the URL, so the header does not get stuck in a state that
    // hides which calendar you are on.
    await expect(page.locator(COPIED)).toHaveCount(0, { timeout: 4000 });
    await expect(page.locator(PILL)).toContainText('rldispatch');
  });

  test('the chevron still opens the full sharing console', async ({ page }) => {
    // Moving the console behind a chevron is only acceptable if it stays
    // discoverable -- subscribe, feed URLs and the edit link all live there.
    await open(page);

    await page.locator(MORE).click();
    await expect(page.locator('[data-testid="subscribe-webcal"]')).toBeVisible();
  });

  test('the chevron does not also copy', async ({ page, context }) => {
    // @click.stop on the chevron -- without it, opening the console would
    // silently fire a share event and corrupt the metric this change exists to move.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await captureAnalytics(page);
    await open(page);

    await page.locator(MORE).click();
    await page.waitForTimeout(400);

    await expect(page.locator(COPIED)).toHaveCount(0);
    const shares = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'calendar_shared'));
    expect(shares).toHaveLength(0);
  });

  test('copying from the pill is attributed distinctly from the panel', async ({ page, context }) => {
    // 'pill' vs 'copy'/'ics' is the whole measurement: if this path is not
    // separable from the panel's own copy buttons, we cannot tell whether the
    // change worked.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await captureAnalytics(page);
    await open(page);

    await page.locator(PILL).click();
    await page.waitForTimeout(400);

    const methods = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'calendar_shared').map((e) => e.params.method));
    expect(methods).toEqual(['pill']);
  });

  test('phones keep the share button, which still opens the console', async ({ page }) => {
    // On a phone the URL text is hidden, so a copy glyph alone would be
    // ambiguous. The mobile header keeps its share button and its old behavior.
    await page.setViewportSize({ width: 390, height: 780 });
    await open(page);

    await expect(page.locator('[data-testid="share-button-mobile"]')).toBeVisible();
    await expect(page.locator(PILL)).toBeHidden();

    await page.locator('[data-testid="share-button-mobile"]').click();
    await expect(page.locator('[data-testid="subscribe-webcal"]')).toBeVisible();
  });
});
