// @ts-check
const { test, expect } = require('./fixtures');

/**
 * Deployment safety: analytics is observational, so the app must work fully even
 * when the analytics layer is entirely absent or broken. These tests simulate the
 * failure modes a deploy can actually produce -- the script 404s, the CDN serves
 * a corrupt file, or a sink throws at runtime.
 */
test.describe('App survives a broken analytics layer', () => {
  test('calendar works when analytics.js fails to load (404)', async ({ page }) => {
    // Simulate the file being missing from the deploy entirely.
    await page.route('**/utils/analytics.js*', route => route.abort());

    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));

    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    // The global is genuinely gone...
    expect(await page.evaluate(() => typeof window.Analytics)).toBe('undefined');

    // ...and the core flow still works end to end.
    await page.locator('[aria-label="Quick add event"]').click();
    await page.locator('textarea[aria-label="Event description"]').fill('lunch tomorrow 2pm');
    await expect(page.locator('#qa-subject')).toHaveValue('lunch');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#qa-subject')).toBeHidden();

    expect(pageErrors.filter(e => e.includes('Analytics'))).toEqual([]);
  });

  test('calendar works when analytics.js is corrupt', async ({ page }) => {
    // A truncated/garbled asset is a realistic CDN failure; it throws at parse time.
    await page.route('**/utils/analytics.js*', route =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: 'this is not valid js {{{' })
    );

    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    await page.locator('[aria-label="Quick add event"]').click();
    await page.locator('textarea[aria-label="Event description"]').fill('dinner tomorrow 7pm');
    await expect(page.locator('#qa-subject')).toHaveValue('dinner');
  });

  test('event creation still saves when every sink throws', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      window.Analytics.enabled = true;
      window.Analytics.SINKS.exploder = () => { throw new Error('down'); };
      window.Analytics.active = ['exploder'];
    });

    await page.locator('[aria-label="Quick add event"]').click();
    await page.locator('textarea[aria-label="Event description"]').fill('standup tomorrow 9am');
    await page.locator('button[type="submit"]').click();

    // Dialog closed and the event reached the calendar despite the failing sink.
    await expect(page.locator('#qa-subject')).toBeHidden();
    await expect(page.locator('[aria-label*="standup"]').first()).toBeVisible({ timeout: 10_000 });
  });
});
