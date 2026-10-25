// @ts-check
/**
 * pastecal.com/features ("How pastecal works", public/features.html): a real page (not a calendar named "features"),
 * indexable, in the sitemap and the site header, every picture loads, "Make a calendar" goes home, and nothing
 * scrolls sideways on a phone. Its animations rest on the finished scene, so reduced motion shows everything.
 * Needs `wrangler dev` on BASE_URL.
 */
const { test, expect } = require('@playwright/test');

test('the page is served, indexable and in the sitemap', async ({ request }) => {
  const r = await request.get('/features');
  expect(r.status()).toBe(200);
  expect(await r.text()).toContain('<h1>How pastecal works</h1>');
  expect(r.headers()['x-robots-tag'] || '').not.toContain('noindex');
  expect(await (await request.get('/sitemap.xml')).text()).toContain('https://pastecal.com/features<');
});

test('a calendar cannot be named features', async ({ request }) => {
  expect((await request.post('/cal/features', { data: { title: 'x', options: {}, events: [] } })).status()).not.toBe(201);
});

for (const width of [1280, 390]) {
  test(`at ${width}px: every picture loads, the header links Features, Make a calendar goes home, no sideways scroll`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await ctx.route(/googletagmanager|google-analytics|clarity|hotjar|\/api\/collect/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto('/features');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('How pastecal works');
    await expect(page.locator('.ft-row h2')).toHaveCount(6);
    await expect(page.locator('.site-header a[href="/features"]')).toHaveCount(1);
    const imgs = page.locator('main img');
    await expect(imgs).toHaveCount(6);
    for (let i = 0; i < 6; i++) {
      const img = imgs.nth(i);
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
      expect(await img.getAttribute('alt')).toBeTruthy();
    }
    // Reduced motion: no animation runs, and the finished scene is showing (the new event is on the grid).
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await expect(page.locator('.ft-make .ft-chip')).toHaveCSS('opacity', '1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const start = page.getByTestId('features-start');
    await expect(start).toHaveText('Make a calendar');
    await expect(start).toHaveAttribute('href', '/');
    await expect(page.getByRole('link', { name: 'See pricing' })).toHaveAttribute('href', '/pricing');
    await start.click();
    await expect(page).toHaveURL(/\/$/);
    await ctx.close();
  });
}

test('the animations play while on screen', async ({ page }) => {
  await page.goto('/features');
  const art = page.locator('.ft-make');
  await art.scrollIntoViewIfNeeded();
  await expect(art).toHaveClass(/is-playing/);
  expect(await page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0);
});
