// @ts-check
/**
 * Owner, Oct 26 2026: "do we have metrics on feature uses, side panel opens, what tabs are used". Two fixes:
 *  - panel_opened: a side panel tab a person opened and how (feature_used 'panel_<tab>:<via>'), never an open nobody
 *    clicked (a pinned panel, a restored tab).
 *  - settings: counted only when a person changes a field ('settings:<field>'); the first visit's automatic import of
 *    the browser's locale used to count nearly every new visitor (3,356 of ~6,500 people in 30 days).
 * Records every Analytics.track() call from page start (analytics is off on a local server).
 * Needs `wrangler dev` on BASE_URL (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);

async function seed(request, options = {}) {
  const id = `test-panels-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  expect((await request.post(`/cal/${id}`, { data: { title: 'Panels', options, events: [] } })).status()).toBe(201);
  return id;
}

async function open(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/London' });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  // Analytics is off on a local server (pcNoProdSideEffects), so record every track() call from the moment the
  // tracker exists: analytics.js assigns window.Analytics, and the recorder wraps that same object's track().
  await ctx.addInitScript(() => {
    window.__tracked = [];
    let A;
    Object.defineProperty(window, 'Analytics', { configurable: true, get() { return A; },
      set(v) { A = v; if (v && !v.__wrapped) { v.__wrapped = true; v.track = function (name, params) { window.__tracked.push({ name, params: params || {} }); }; } } });
  });
  const page = await ctx.newPage();
  await page.goto(path);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 20_000 });
  await page.waitForTimeout(500);
  /** feature_used values sent or queued so far. */
  const features = async () => (await page.evaluate(() => window.__tracked)).filter((e) => e.name === 'feature_used').map((e) => e.params.feature);
  return { ctx, page, features };
}

test('a first visit (the locale is read into Settings) is not counted as using Settings', async ({ browser, request }) => {
  const id = await seed(request);
  const { ctx, features } = await open(browser, `/${id}?backend=cf`);
  expect((await features()).filter((f) => String(f).startsWith('settings'))).toEqual([]);
  await ctx.close();
});

test('changing a setting counts once, with the field: settings:time_format', async ({ browser, request }) => {
  const id = await seed(request);
  const { ctx, page, features } = await open(browser, `/${id}?backend=cf`);
  await page.getByTestId('settings-button-desktop').click();
  await page.locator('#set-time-format').selectOption('24');
  await expect.poll(async () => (await features()).filter((f) => String(f).startsWith('settings'))).toEqual(['settings:time_format']);
  await ctx.close();
});

test('opening side panel tabs counts each open once, with the tab and where it was opened; closing and re-picking the open tab do not', async ({ browser, request }) => {
  const id = await seed(request);
  const { ctx, page, features } = await open(browser, `/${id}?backend=cf`);
  const panels = async () => (await features()).filter((f) => String(f).startsWith('panel_'));
  expect(await panels(), 'nothing opened yet').toEqual([]);
  await page.getByRole('button', { name: 'Toggle notes' }).locator('visible=true').first().click();
  await expect.poll(panels).toEqual(['panel_notes:header']);
  await page.getByTestId('side-tab-share').click();
  await expect.poll(panels).toEqual(['panel_notes:header', 'panel_share:tabs']);
  await page.getByTestId('side-tab-share').click();   // already open: not a new open
  await page.getByTestId('side-close').click();
  await page.getByTestId('settings-button-desktop').click();
  await expect.poll(panels).toEqual(['panel_notes:header', 'panel_share:tabs', 'panel_settings:header']);
  await ctx.close();
});

test('a panel nobody clicked open (a view link with notes, pinned beside the calendar) is not counted', async ({ browser, request }) => {
  const id = await seed(request, { notes: 'Bring water.' });
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  const { ctx, page, features } = await open(browser, `/view/${view.publicViewId}?backend=cf`);
  await expect(page.getByTestId('side-panel')).toBeVisible();
  await page.waitForTimeout(500);
  expect((await features()).filter((f) => String(f).startsWith('panel_'))).toEqual([]);
  await ctx.close();
});
