// @ts-check
/**
 * The view link's own chrome, driven like a visitor: the title says "View only", "Add to my
 * calendar" opens the same subscribe options Share hands out (Google, Apple, Outlook, Other),
 * "Make your own" goes home, and one quiet line under the calendar says who made it. Pro trims
 * that line to "Made with pastecal"; inside an embed it is a tiny corner credit. An edit link
 * gets only small links under the calendar, never the pitch.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787); seeds one calendar and view.
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')._vnode.component.proxy`;
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);

let shared;
async function seed(request) {
  if (shared) return shared;
  const id = `test-viewer-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const at = (day, h) => { const d = new Date(); d.setDate(day); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const events = [{ id: 'e1', title: 'Practice', start: at(7, 17), end: at(7, 18), type: 1 }];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Viewer chrome test', options: { notes: 'Bring water.' }, events } })).status()).toBe(201);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  expect(view.ok).toBe(true);
  return (shared = { id, viewId: view.publicViewId });
}

async function open(browser, path, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600 });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  await page.goto(path);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  return { ctx, page };
}

const visible = (page, testid) => page.locator(`[data-testid="${testid}"]:visible`);

test('view link: View only badge, Add to my calendar with the Share subscribe URLs, Make your own, footer', async ({ browser, request }) => {
  const { viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/view/${viewId}?backend=cf`);

  await expect(page.getByTestId('view-only-badge')).toBeVisible();
  await expect(page.getByTestId('view-only-badge')).toHaveText('View only');
  // Editor controls are gone from the viewer's header.
  await expect(page.getByTestId('share-pill-readonly')).toHaveCount(0);
  await expect(page.getByTestId('last-edit-link')).toHaveCount(0);
  await expect(page.getByLabel('Quick add event')).toHaveCount(0);

  await visible(page, 'view-add-to-cal').click();
  const menu = page.getByTestId('view-add-to-cal-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Google Calendar', 'Apple Calendar', 'Outlook', 'Other calendar app']);
  const feed = `/view/${viewId}.ics`;
  const webcal = await page.getByTestId('view-subscribe-apple').getAttribute('href');
  expect(webcal).toMatch(new RegExp(`^webcal://.*${feed.replace(/\./g, '\\.')}$`));
  expect(await page.getByTestId('view-subscribe-webcal').getAttribute('href')).toBe(webcal);
  expect(decodeURIComponent(await page.getByTestId('view-subscribe-google').getAttribute('href') || '')).toBe(`https://calendar.google.com/calendar/r?cid=${webcal}`);
  expect(decodeURIComponent(await page.getByTestId('view-subscribe-outlook').getAttribute('href') || '')).toContain(`addfromweb?url=http://localhost`);
  expect(decodeURIComponent(await page.getByTestId('view-subscribe-outlook').getAttribute('href') || '')).toContain(feed);
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 500);
  await expect(menu).toHaveCount(0);

  const own = visible(page, 'make-own');
  await expect(own).toHaveAttribute('href', '/');
  await expect(own).toHaveAttribute('data-from', 'view-header');

  const footer = page.getByTestId('view-footer');
  await expect(footer).toBeVisible();
  await expect(footer).toContainText('Made with pastecal: free shared calendars, no login required.');
  const cta = page.getByTestId('view-footer-cta');
  await expect(cta).toHaveText('Make your own →');
  await expect(cta).toHaveAttribute('href', '/?from=view-footer');
  await expect(cta).toHaveAttribute('data-from', 'view-footer');
  await expect(page.getByTestId('edit-footer')).toHaveCount(0);

  // Notes stay pinned beside the calendar.
  await expect(page.getByTestId('side-panel')).toHaveAttribute('data-tab', 'notes');

  // Pro, branding trimmed (the default): the footer shrinks to "Made with pastecal · Report",
  // and the header's Make your own goes. Turning hideBranding off brings the pitch back.
  await page.evaluate(`${VM}.lock = { locked: true, pro: true, canEdit: false, proSettings: { hideBranding: true } }`);
  await expect(page.getByTestId('view-footer')).toHaveCount(0);
  await expect(page.getByTestId('hosted-note')).toHaveText('Made with pastecal · Report');
  await expect(page.getByTestId('make-own')).toHaveCount(0);
  await page.evaluate(`${VM}.lock = { locked: true, pro: true, canEdit: false, proSettings: { hideBranding: false } }`);
  await expect(page.getByTestId('view-footer')).toBeVisible();
  await expect(page.getByTestId('hosted-note')).toHaveCount(0);
  await ctx.close();
});

test('phone: the view link shows the badge and Add to my calendar in its header, footer underneath', async ({ browser, request }) => {
  const { viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/view/${viewId}?backend=cf`, { width: 390, height: 844 });
  await expect(page.getByTestId('view-only-badge-mobile')).toBeVisible();
  await visible(page, 'view-add-to-cal').click();
  await expect(page.getByTestId('view-subscribe-google')).toBeVisible();
  const m = await page.getByTestId('view-add-to-cal-menu').boundingBox();
  expect(m && m.x >= 0 && m.x + m.width <= 390, 'the menu fits the screen').toBe(true);
  await expect(visible(page, 'make-own-mobile')).toHaveAttribute('data-from', 'view-header');
  await expect(page.getByTestId('view-footer-cta')).toHaveAttribute('href', '/?from=view-footer');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true);
  await ctx.close();
});

test('embed: a tiny corner credit instead of the footer line', async ({ browser, request }) => {
  const { viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/view/${viewId}?backend=cf&embed`);
  await expect(page.getByTestId('embed-credit')).toHaveText('pastecal');
  await expect(page.getByTestId('view-footer')).toHaveCount(0);
  await ctx.close();
});

test('edit link: the footer is quiet links only, with no Make your own', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  const footer = page.getByTestId('edit-footer');
  await expect(footer).toBeVisible();
  await expect(footer.getByRole('link')).toHaveText(['pastecal · Simple shared calendars', 'Pricing', 'Help', 'Privacy', 'Terms']);
  await expect(page.getByText('Make your own')).toHaveCount(0);
  await expect(page.getByTestId('view-footer')).toHaveCount(0);
  await expect(page.getByTestId('view-only-badge')).toHaveCount(0);
  await ctx.close();
});

// A returning viewer gets one hint to subscribe; it never comes back once used or dismissed.
test('view link: second visit shows the subscribe hint once; opening it ends it', async ({ browser, request }) => {
  const { viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/view/${viewId}?backend=cf`);
  await expect(visible(page, 'subscribe-nudge')).toHaveCount(0);            // first visit: nothing
  await page.reload(); await page.waitForFunction(() => window.scheduleObj);
  await expect(visible(page, 'subscribe-nudge')).toContainText('phone calendar');
  await visible(page, 'subscribe-nudge').locator('.pc-addcal-nudge-text').click();
  await expect(visible(page, 'view-add-to-cal-menu')).toBeVisible();        // it opens the real menu
  await page.reload(); await page.waitForFunction(() => window.scheduleObj);
  await expect(visible(page, 'subscribe-nudge')).toHaveCount(0);            // and never shows again
  await ctx.close();
});
