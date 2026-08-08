// @ts-check
const { test, expect } = require('./fixtures');

/**
 * Guards the fix for a real incident: a month of Playwright UI verification runs
 * landed in GA4 as ~353 "users" -- the third-highest user count on the site --
 * because index.html checked `window.__TEST__` but nothing ever set it.
 *
 * If this test fails, automated runs are polluting production analytics again.
 */
test.describe('Analytics test-mode guard', () => {
  test('automated runs never load GTM or fire events', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    const state = await page.evaluate(() => ({
      isTest: !!window.__TEST__,
      gtmLoaded: !!window.google_tag_manager,
      dataLayerEvents: Array.isArray(window.dataLayer) ? window.dataLayer.length : 0,
      analyticsEnabled: window.Analytics ? window.Analytics.enabled : 'missing',
    }));

    expect(state.isTest).toBe(true);
    expect(state.analyticsEnabled).toBe(false);
    expect(state.gtmLoaded).toBe(false);
    expect(state.dataLayerEvents).toBe(0);
  });

  test('track() is a no-op in test mode but still callable', async ({ page }) => {
    await page.goto('/');
    // Call sites must never need to guard their own calls.
    const threw = await page.evaluate(() => {
      try {
        window.Analytics.track('smoke_test', { a: 1 });
        window.Analytics.slugAutoAssigned({ events: [1, 2, 3] });
        return false;
      } catch (e) {
        return String(e);
      }
    });
    expect(threw).toBe(false);
  });

  test('a throwing sink cannot break a calendar operation', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    const result = await page.evaluate(() => {
      const A = window.Analytics;
      A.enabled = true;                       // force delivery on
      A.SINKS.exploder = () => { throw new Error('sink is down'); };
      A.active = ['exploder'];
      try {
        A.track('boom', { x: 1 });
        A.slugAutoAssigned({ events: [1, 2] });
        A.eventAdded('quick_add');
        return 'survived';
      } catch (e) {
        return 'threw: ' + e.message;
      } finally {
        A.active = ['ga4', 'console'];
        A.enabled = false;
      }
    });
    expect(result).toBe('survived');

    // And the app is still fully operational afterwards.
    await page.locator('[aria-label="Quick add event"]').click();
    await page.locator('textarea[aria-label="Event description"]').fill('lunch tomorrow 2pm');
    await expect(page.locator('#qa-subject')).toHaveValue('lunch');
  });

  test('malformed calendar data cannot break a tracking helper', async ({ page }) => {
    await page.goto('/');
    // Events come back from Firebase as objects, not always arrays; nulls happen.
    const result = await page.evaluate(() => {
      const A = window.Analytics;
      A.enabled = true;
      try {
        A.slugAutoAssigned(null);
        A.slugAutoAssigned({});
        A.slugAutoAssigned({ events: { a: 1, b: 2 } });
        A.calendarReturned(undefined, NaN);
        A.slugClaimed(null, null);
        return 'survived';
      } catch (e) {
        return 'threw: ' + e.message;
      } finally {
        A.enabled = false;
      }
    });
    expect(result).toBe('survived');
  });

  test('the queue is capped so a long-lived tab cannot leak memory', async ({ page }) => {
    await page.goto('/');
    const len = await page.evaluate(() => {
      const A = window.Analytics;
      A._queue.length = 0;
      const savedUrl = A.COLLECTOR_URL;
      A.COLLECTOR_URL = null;              // prevent flush from draining it
      for (let i = 0; i < 500; i++) A.queue('spam', { i });
      const n = A._queue.length;
      A._queue.length = 0;
      A.COLLECTOR_URL = savedUrl;
      return n;
    });
    expect(len).toBeLessThanOrEqual(200);
  });

  test('event params bucket raw counts instead of passing them through', async ({ page }) => {
    await page.goto('/');
    // Raw counts explode dimension cardinality in GA4/Cloudflare alike.
    const buckets = await page.evaluate(() => ({
      zero: window.Analytics.bucketEvents(0),
      two: window.Analytics.bucketEvents(2),
      twelve: window.Analytics.bucketEvents(12),
      huge: window.Analytics.bucketEvents(900),
      visits: window.Analytics.bucketVisits(7),
    }));
    expect(buckets).toEqual({
      zero: '0', two: '1-2', twelve: '5-19', huge: '50+', visits: '6-10',
    });
  });
});
