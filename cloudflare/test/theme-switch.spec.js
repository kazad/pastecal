// @ts-check
/**
 * Switching the theme back and forth before the calendar's stylesheet has arrived (a slow
 * connection, the first switch to a theme) must end on the theme the setting says, with one
 * calendar stylesheet. It used to end on the wrong one, or keep the light grid in dark mode,
 * until a refresh. Needs `wrangler dev` on BASE_URL (default http://localhost:8787).
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const SHOTS = path.join(__dirname, '..', 'test-results', 'theme-switch');

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

// Owner, Oct 26 2026: in classic's toolbar the view buttons ("3 Months", "Year", "Agenda") and the date/⋮ buttons
// showed as WHITE pills on a dark page (an embed at 720px, the system turned dark after the page loaded, a header
// button clicked). The page flipped to dark at once while Syncfusion's light stylesheet stayed until the dark one
// (2.2 MB) arrived. Both now change together, so at every moment the toolbar's boxes match the page's theme.
// The stylesheets are slowed (800 ms) to hold that window open; it was ~100 ms on the box and seconds on a phone.
/** Boxes in the toolbar whose own background is the wrong side for the page's theme: light (lum > 0.5) on a dark
 *  page, dark (lum < 0.1) on a light one. */
const wrongBoxes = (page) => page.evaluate(() => {
  const lum = (c) => { const v = (c.match(/[\d.]+/g) || []).map(Number); if (v.length > 3 && v[3] < 0.3) return null; const [R, G, B] = v.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
  const theme = document.documentElement.dataset.theme;
  const bad = [...document.querySelectorAll('.e-schedule .e-toolbar, .e-schedule .e-toolbar *')]
    .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 4 && b.height > 4 && getComputedStyle(e).visibility !== 'hidden'; })
    .filter((e) => { const L = lum(getComputedStyle(e).backgroundColor); return L !== null && (theme === 'dark' ? L > 0.5 : L < 0.1); })
    .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')} ${getComputedStyle(e).backgroundColor}`);
  return { theme, bad };
});
for (const [from, to] of [['light', 'dark'], ['dark', 'light']]) for (const where of ['embed', 'edit']) {
  test(`classic ${where} at 720px: the system turns ${to} after load; the toolbar never shows ${from} boxes on the ${to} page, a header button clicked`, async ({ browser, request }) => {
    const id = `theme-swap-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
    expect((await request.post(`/cal/${id}`, { data: { title: 'Theme swap', options: { notes: 'Bring water.' }, events: [{ id: 'e1', title: 'Practice', start: at(17), end: at(18), type: 1 }] } })).status()).toBe(201);
    const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
    const ctx = await browser.newContext({ viewport: { width: 720, height: 640 }, colorScheme: from });
    await ctx.addInitScript(() => { window.__TEST__ = true; });
    const page = await ctx.newPage();
    let slow = false;
    await page.route(/material(-dark)?\.css/, async (route) => { if (slow) await new Promise((r) => setTimeout(r, 800)); await route.continue(); });
    await page.goto(where === 'embed' ? `/view/${view.publicViewId}?backend=cf&embed` : `/${id}?backend=cf`);
    await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-schedule .e-toolbar .e-tbar-btn'), null, { timeout: 20_000 });
    expect((await wrongBoxes(page)).theme).toBe(from);
    slow = true;
    await page.emulateMedia({ colorScheme: to });
    const seen = [];
    const look = async (when) => { const w = await wrongBoxes(page); seen.push(`${when} ${w.theme}`); return w.bad.map((b) => `${when} (${w.theme}): ${b}`); };
    const bad = [...await look('at once')];
    await page.screenshot({ path: path.join(SHOTS, `${where}-${to}-at-once.png`) });
    await page.locator('.e-schedule .e-toolbar .e-tbar-btn:visible').first().click();
    bad.push(...await look('header button clicked'));
    await page.screenshot({ path: path.join(SHOTS, `${where}-${to}-clicked.png`) });
    for (let t = 0; t < 12; t++) { await page.waitForTimeout(100); bad.push(...await look(`${(t + 1) * 100}ms`)); }
    await expect.poll(async () => (await wrongBoxes(page)).theme, { timeout: 5000 }).toBe(to);
    await page.waitForTimeout(300);
    bad.push(...await look('settled'));
    await page.screenshot({ path: path.join(SHOTS, `${where}-${to}-settled.png`) });
    expect(bad, `samples: ${seen.join(', ')}`).toEqual([]);
    expect(await page.locator('#syncfusion-theme').count()).toBe(1);
    await ctx.close();
  });
}
