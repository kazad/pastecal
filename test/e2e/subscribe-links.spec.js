// @ts-check
const { test, expect } = require('./fixtures');

// The ICS feed always worked; it was just offered as one of four identical
// "Copy" boxes labeled "ICS link for other apps", which describes the file
// format rather than what a person gets out of it. These tests lock in the
// behavior that makes subscribing a single tap, and the safety rule that it
// never hands out edit access.

// The pill itself now copies the link (that was the whole point of making
// sharing one click), so the panel opens from the chevron beside it.
const PANEL = '[data-testid="share-pill-more"]';

async function openShare(page, slug) {
  await page.goto(`/${slug}`);
  await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.locator(PANEL).click();
  await expect(page.locator('[data-testid="subscribe-webcal"]')).toBeVisible();
}

test.describe('Subscribe links', () => {
  test('the primary action is a webcal link, not a copy button', async ({ page }) => {
    await openShare(page, 'rldispatch');

    const href = await page.locator('[data-testid="subscribe-webcal"]').getAttribute('href');
    expect(href).toMatch(/^webcal:\/\//);
    expect(href).toMatch(/\.ics$/);
  });

  test('subscribing uses the read-only feed, never the editable one', async ({ page }) => {
    // The safety rule: someone adding a roster to their phone wants to read it.
    // Defaulting to the editable feed would spread write access silently.
    await openShare(page, 'rldispatch');

    for (const id of ['subscribe-webcal', 'subscribe-apple']) {
      const href = await page.locator(`[data-testid="${id}"]`).getAttribute('href');
      expect(href).toContain('/view/');
    }

    const google = await page.locator('[data-testid="subscribe-google"]').getAttribute('href');
    expect(decodeURIComponent(google)).toContain('/view/');

    const outlook = await page.locator('[data-testid="subscribe-outlook"]').getAttribute('href');
    expect(decodeURIComponent(outlook)).toContain('/view/');
  });

  test('Google gets an encoded webcal url', async ({ page }) => {
    await openShare(page, 'rldispatch');

    const href = await page.locator('[data-testid="subscribe-google"]').getAttribute('href');
    expect(href).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/r\?cid=/);
    // Must be encoded, or the scheme colon terminates the query parameter.
    expect(href).toContain('webcal%3A%2F%2F');
  });

  test('Outlook gets the https url and the calendar name', async ({ page }) => {
    await openShare(page, 'rldispatch');

    const href = await page.locator('[data-testid="subscribe-outlook"]').getAttribute('href');
    expect(href).toMatch(/^https:\/\/outlook\.live\.com\/calendar\/0\/addfromweb\?url=/);
    // Outlook's endpoint takes https, NOT webcal -- passing webcal here fails.
    expect(href).not.toContain('webcal');
    expect(href).toContain('name=');
  });

  test('the feed URL stays visible with its own copy button', async ({ page }) => {
    // The one-tap path does not replace the raw URL: webcal can fail silently
    // when no app is registered for the scheme, and some people just want the URL.
    await openShare(page, 'rldispatch');

    await expect(page.getByText('Feed URL (view only):')).toBeVisible();

    const values = await page.locator('input[readonly]').evaluateAll(
      (els) => els.map((e) => e.value));

    expect(values.some((v) => v.includes('/view/') && v.endsWith('.ics'))).toBe(true);
    expect(values.some((v) => v.endsWith('rldispatch.ics'))).toBe(true);
  });

  test('copying a feed url is still attributed as ics', async ({ page }) => {
    await page.addInitScript(() => {
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

    await openShare(page, 'rldispatch');

    // .first() would match the Edit Access card's copy button, which is tagged
    // 'copy'. Scope to the feed row so this asserts on the ICS attribution.
    await page.locator('div:has(> .text-xs:text-is("Feed URL (view only):")) button:has-text("Copy")')
      .first().click({ force: true })
      .catch(async () => {
        // Fallback: the last Copy button in the panel is the full-access feed.
        await page.locator('button:has-text("Copy")').last().click({ force: true });
      });
    await page.waitForTimeout(400);

    const shares = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'calendar_shared').map((e) => e.params.method));
    expect(shares).toContain('ics');
  });

  test('clicking subscribe is recorded separately from copying', async ({ page }) => {
    // Subscribing and copying a URL are different intents with very different
    // follow-through, so they must not share a bucket.
    await page.addInitScript(() => {
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

    await openShare(page, 'rldispatch');

    // Don't actually navigate to webcal:// -- the browser has no handler for it.
    await page.locator('[data-testid="subscribe-webcal"]').evaluate((el) => {
      el.removeAttribute('href');
      el.click();
    });
    await page.waitForTimeout(400);

    const shares = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'calendar_shared').map((e) => e.params.method));
    expect(shares).toContain('subscribe');
  });
});
