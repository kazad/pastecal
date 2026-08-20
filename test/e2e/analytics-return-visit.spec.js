// @ts-check
const { test, expect } = require('./fixtures');

// Return depth is the metric the analytics module singles out as the best
// predictor of a calendar that matters, and it is the one signal GA4 could never
// show: 60 days of data had 11,081 returning sessions and no way to tell how
// deep any single calendar's return was.
//
// visitCount lives in RecentCalendars, so this also guards that counter.

async function captureEvents(page) {
  await page.addInitScript(() => {
    window.__fired = [];
    let held;
    Object.defineProperty(window, 'Analytics', {
      configurable: true,
      get() { return held; },
      set(value) {
        held = value;
        const original = value.track.bind(value);
        value.track = function (name, params) {
          window.__fired.push({ name, params });
          return original(name, params);
        };
      },
    });
  });
}

test.describe('Return-visit tracking', () => {
  test.beforeEach(async ({ page }) => {
    await captureEvents(page);
  });

  test('the first visit to a calendar is not counted as a return', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    await page.goto('/rldispatch');
    await page.waitForTimeout(3000);

    // Every first load would otherwise report visit 1 and drown the signal.
    const returns = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'calendar_returned'));
    expect(returns).toHaveLength(0);
  });

  test('a second visit reports calendar_returned with a visit bucket', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    await page.goto('/rldispatch');
    await page.waitForTimeout(3000);
    await page.goto('/rldispatch');
    await page.waitForTimeout(3000);

    const returns = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'calendar_returned'));

    expect(returns.length).toBeGreaterThan(0);
    // Buckets rather than raw counts, so the dimension stays low-cardinality.
    expect(returns[0].params.visit_bucket).toBe('2');
    expect(returns[0].params.event_count_bucket).toBeTruthy();
  });

  test('visitCount increments per visit and survives a reload', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    for (let i = 0; i < 3; i++) {
      await page.goto('/rldispatch');
      await page.waitForTimeout(2500);
    }

    const count = await page.evaluate(() => {
      const visited = JSON.parse(localStorage.getItem('recentCalendars') || '[]');
      const mine = JSON.parse(localStorage.getItem('myCalendars') || '[]');
      const entry = [...mine, ...visited].find((item) => item.id === 'rldispatch');
      return entry && entry.visitCount;
    });

    expect(count).toBe(3);
  });

  test('an entry written before visitCount existed is treated as a first visit', async ({ page }) => {
    await page.goto('/');

    // Simulate a browser that used pastecal before the counter shipped.
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('recentCalendars', JSON.stringify([
        { id: 'rldispatch', title: 'Legacy', pinned: false, mine: false,
          lastVisited: new Date().toISOString() },
      ]));
    });

    await page.goto('/rldispatch');
    await page.waitForTimeout(3000);

    // The legacy entry counts as visit 1, so this load is visit 2 -- not NaN,
    // and not a reset back to 1.
    const count = await page.evaluate(() => {
      const visited = JSON.parse(localStorage.getItem('recentCalendars') || '[]');
      const entry = visited.find((item) => item.id === 'rldispatch');
      return entry && entry.visitCount;
    });

    expect(count).toBe(2);
  });
});
