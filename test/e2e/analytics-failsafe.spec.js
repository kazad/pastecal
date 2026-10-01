// @ts-check
const { test, expect } = require('./fixtures');

/**
 * Deployment safety: analytics is observational, so the app must work fully even
 * when the analytics layer is entirely absent or broken. These tests simulate the
 * failure modes a deploy can actually produce -- the script 404s, the CDN serves
 * a corrupt file, or a sink throws at runtime.
 *
 * Each test proves its failure actually happened (the sink was called, the
 * global is gone) and that nothing else broke (no uncaught page errors).
 * Without that, a test whose sabotage never fired passes for the wrong reason:
 * the "every sink throws" test once did, because nothing checked the sink ran.
 */

/** Uncaught page errors, minus the ones a test deliberately caused. */
function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return errors;
}

/** Quick-add an event in the legacy app and wait for it to reach the grid. */
async function quickAdd(page, text, subject) {
  await page.locator('[aria-label="Quick add event"]').click();
  await page.locator('textarea[aria-label="Event description"]').fill(text);
  await expect(page.locator('#qa-subject')).toHaveValue(subject);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('#qa-subject')).toBeHidden();
  await expect(page.locator(`[aria-label*="${subject}"]`).first()).toBeVisible({ timeout: 10_000 });
}

/** Turn analytics on with a single sink that records each call, then throws. */
async function installExplodingSink(page) {
  await page.evaluate(() => {
    window.__sinkCalls = [];
    window.Analytics.enabled = true;
    window.Analytics.SINKS.exploder = (name) => {
      window.__sinkCalls.push(name);
      throw new Error('sink down');
    };
    // Only the exploder: the test must never reach a real analytics endpoint.
    window.Analytics.active = ['exploder'];
  });
}

test.describe('App survives a broken analytics layer', () => {
  test('calendar works when analytics.js fails to load (404)', async ({ page }) => {
    // Simulate the file being missing from the deploy entirely.
    await page.route('**/utils/analytics.js*', route => route.abort());
    const pageErrors = collectPageErrors(page);

    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    // The global is genuinely gone...
    expect(await page.evaluate(() => typeof window.Analytics)).toBe('undefined');

    // ...and the core flow still works end to end.
    await quickAdd(page, 'lunch tomorrow 2pm', 'lunch');

    expect(pageErrors).toEqual([]);
  });

  test('calendar works when analytics.js is corrupt', async ({ page }) => {
    // A truncated/garbled asset is a realistic CDN failure; it throws at parse time.
    await page.route('**/utils/analytics.js*', route =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: 'this is not valid js {{{' })
    );
    const pageErrors = collectPageErrors(page);

    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });
    expect(await page.evaluate(() => typeof window.Analytics)).toBe('undefined');

    // Submit, not just type: the save path is where analytics calls live.
    await quickAdd(page, 'dinner tomorrow 7pm', 'dinner');

    // The parse error from the corrupt file itself is expected; nothing else is.
    expect(pageErrors.filter(e => !/SyntaxError/.test(e))).toEqual([]);
    expect(pageErrors.length).toBeLessThanOrEqual(1);
  });

  test('event creation still saves when every sink throws', async ({ page }) => {
    const pageErrors = collectPageErrors(page);
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    await installExplodingSink(page);
    await quickAdd(page, 'standup tomorrow 9am', 'standup');

    // The sabotage must actually have fired, or this test proves nothing.
    // Delivery is deferred (requestIdleCallback), hence the poll.
    await expect.poll(() => page.evaluate(() => window.__sinkCalls.length),
      { timeout: 5_000 }).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test('/nativecal/ keeps working when every sink throws', async ({ page }) => {
    const pageErrors = collectPageErrors(page);
    await page.goto(`/nativecal/failsafe-${Date.now()}`);
    await expect(page.getByTestId('month-view-grid')).toBeVisible({ timeout: 10_000 });

    await installExplodingSink(page);
    // nativecal loads analytics.js; drive a track() through it directly so the
    // throwing sink is exercised on this page whether or not the UI emits events.
    await page.evaluate(() => window.Analytics.track('failsafe_probe', { x: 1 }));

    await page.locator('.calendar-cell:not(.opacity-50)').nth(10).click();
    await page.getByTestId('quick-create-title').fill('Failsafe Event');
    await page.getByTestId('quick-create-save').click();
    await expect(page.getByText('Failsafe Event')).toBeVisible();

    await expect.poll(() => page.evaluate(() => window.__sinkCalls.length),
      { timeout: 5_000 }).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });
});
