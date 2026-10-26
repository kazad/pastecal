// @ts-check
/**
 * Switching the theme back and forth before the calendar's stylesheet has arrived (a slow
 * connection, the first switch to a theme) must end on the theme the setting says, with one
 * calendar stylesheet. It used to end on the wrong one, or keep the light grid in dark mode,
 * until a refresh. Needs `wrangler dev` on BASE_URL (default http://localhost:8787).
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')._vnode.component.proxy`;

for (const steps of [['dark', 'light'], ['dark', 'light', 'dark']]) {
  test(`theme ${steps.join(' -> ')}, quickly, on a slow connection`, async ({ page }) => {
    await page.addInitScript(() => { window.__TEST__ = true; });
    let slow = false;
    await page.route(/material(-dark)?\.css/, async (route) => {
      if (slow) await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await page.goto('/?backend=cf');
    await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-work-cells'));
    slow = true;
    for (const mode of steps) {
      await page.evaluate(`${VM}.globalSettings.darkMode = '${mode}'`);
      await page.waitForTimeout(150);
    }
    const want = steps[steps.length - 1];
    const read = () => page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      sheets: [...document.querySelectorAll('link[href*="/vendor/syncfusion-"][href*="material"]')].map((l) => l.href.split('/').pop().split('?')[0]),
      cellBg: getComputedStyle(document.querySelector('.e-work-cells')).backgroundColor,
    }));
    await expect.poll(async () => (await read()).sheets, { timeout: 5000 }).toEqual([want === 'dark' ? 'material-dark.css' : 'material.css']);
    const end = await read();
    expect(end.theme).toBe(want);
    const [r, g, b] = end.cellBg.match(/\d+/g).map(Number);
    if (want === 'dark') expect(r + g + b, 'the grid is dark').toBeLessThan(300);
    else expect(r + g + b, 'the grid is light').toBeGreaterThan(600);
    expect(await page.locator('#syncfusion-theme').count()).toBe(1);
  });
}
