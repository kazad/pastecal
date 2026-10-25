// @ts-check
/**
 * A browser can bring back an old saved copy of the page (a restored tab) and fetch today's
 * scripts for it, because the server ignores ?v=. The old copy lacks a script the new app.js needs,
 * and before the guard the calendar never opened ("LockBadge is not defined", seen in production
 * on Oct 24 2026). Driven like that browser:
 *   1. The first load serves the page without Pro.js (the old copy). The page reloads once on its
 *      own, gets the real page, and the calendar opens.
 *   2. If every load is the broken copy, it reloads only once, so a real bug never loops.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787).
 */
const { test, expect } = require('@playwright/test');

async function context(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  await ctx.route(/firebaseio|googletagmanager|google-analytics|clarity|hotjar/, (r) => r.abort());
  await ctx.routeWebSocket((url) => !/localhost|127\.0\.0\.1/.test(String(url)), (ws) => ws.close());
  return ctx;
}

// Serves the homepage with the Pro.js script tag removed, for the first `times` loads.
async function serveOldCopy(ctx, times) {
  let served = 0, requests = 0;
  await ctx.route((url) => url.pathname === '/', async (route) => {
    requests++;
    if (served >= times) return route.continue();
    served++;
    const res = await route.fetch();
    const html = (await res.text()).replace(/<script[^>]*components\/Pro\.js[^>]*><\/script>/, '');
    await route.fulfill({ response: res, body: html });
  });
  return { served: () => served, requests: () => requests };
}

test('an old copy of the page reloads once and the calendar opens', async ({ browser }) => {
  const ctx = await context(browser);
  const counts = await serveOldCopy(ctx, 1);
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  await page.waitForFunction(() => window.__appMounted && window.scheduleObj && document.querySelector('.e-work-cells'), null, { timeout: 20_000 });
  expect(counts.served()).toBe(1);
  expect(counts.requests()).toBe(2);   // the old copy, then one reload
  await expect(page.getByRole('button', { name: /Add event/ }).first()).toBeVisible();
  await ctx.close();
});

test('a page that stays broken reloads only once', async ({ browser }) => {
  const ctx = await context(browser);
  const counts = await serveOldCopy(ctx, 99);
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  await page.waitForTimeout(4000);
  expect(counts.requests()).toBe(2);
  expect(await page.evaluate(() => !!window.__appMounted)).toBe(false);
  await ctx.close();
});
