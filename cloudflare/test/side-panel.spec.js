// @ts-check
/**
 * The side panel, driven like a person: Notes, Share, Changes and Settings open beside the
 * calendar (never above it), from their header buttons and from the panel's tab row. The
 * calendar keeps its top and narrows; closing gives the width back. A view link with notes
 * opens with them pinned; a phone gets the same panel as a bottom sheet. And what moved
 * must still work: a setting still applies, Share still copies, Changes can still undo.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787); seeds one calendar and
 * one view link (the Worker allows 10 creates a minute per IP, so the tests share them).
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')?._vnode?.component?.proxy`;
// Nothing leaves this machine but fonts and the pinned script CDNs.
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOTES = 'Home field: Riverside Park, Field 3\nRainouts decided by 7am on game day.';

let shared;
async function seed(request) {
  if (shared) return shared;
  const id = `test-side-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const at = (day, h) => { const d = new Date(); d.setDate(day); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const events = [
    { id: 'e1', title: 'Practice', start: at(7, 17), end: at(7, 18), type: 1 },
    { id: 'e2', title: 'Game vs Hawks', start: at(10, 10), end: at(10, 11), type: 2 },
  ];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Side panel test', options: { notes: NOTES }, events } })).status()).toBe(201);
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

const box = async (page) => (await page.locator('#Schedule').boundingBox());
const panel = (page) => page.getByTestId('side-panel');

test('editor: every header button and every tab opens the panel beside the calendar, which narrows and keeps its top', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  const before = await box(page);

  const fromHeader = [
    ['notes', page.getByTestId('desktop-title-area').getByRole('button', { name: 'Toggle notes' })],
    ['changes', page.getByTestId('last-edit-link')],
    ['settings', page.getByTestId('settings-button-desktop')],
    ['share', page.getByTestId('share-pill-more')],
  ];
  for (const [tab, button] of fromHeader) {
    await button.click();
    await expect(panel(page)).toHaveAttribute('data-tab', tab);
    await expect(page.getByTestId(`side-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('side-panel')).toHaveCount(1);   // one panel at a time
    await expect.poll(async () => (await box(page)).width).toBeLessThan(before.width - 250);
    const now = await box(page);
    expect(Math.abs(now.y - before.y), `${tab}: the calendar did not move down`).toBeLessThan(2);
    // Beside it, not above or over it.
    const side = await panel(page).boundingBox();
    expect(side.x).toBeGreaterThanOrEqual(now.x + now.width);
    expect(Math.abs(side.y - now.y)).toBeLessThan(40);
  }

  // The tab row switches without closing.
  for (const tab of ['notes', 'changes', 'settings', 'share']) {
    await page.getByTestId(`side-tab-${tab}`).click();
    await expect(panel(page)).toHaveAttribute('data-tab', tab);
  }
  await expect(panel(page).getByRole('heading', { name: 'Read-only link' })).toBeVisible();
  await page.getByTestId('side-tab-notes').click();
  await expect(panel(page).getByLabel('Calendar notes')).toHaveValue(NOTES);

  // Clicking the open tab's header button again closes it; so does the close button.
  await page.getByTestId('settings-button-desktop').click();
  await page.getByTestId('settings-button-desktop').click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByTestId('settings-button-desktop').click();
  await page.getByTestId('side-close').click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => Math.round((await box(page)).width)).toBe(Math.round(before.width));
  // The grid re-laid out at the new width: a chip spans its day again.
  await expect.poll(() => page.evaluate(() => {
    const cell = document.querySelector('.e-month-view .e-work-cells').getBoundingClientRect().width;
    const chip = document.querySelector('.e-month-view .e-appointment').getBoundingClientRect().width;
    return chip >= cell * 0.85;
  })).toBe(true);
  await ctx.close();
});

test('a setting changed in the panel still applies at once', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.getByTestId('settings-button-desktop').click();
  await panel(page).locator('select').first().selectOption('1');   // First day of week: Monday
  await expect.poll(() => page.evaluate(() => scheduleObj.firstDayOfWeek)).toBe(1);
  await expect(page.locator('.e-month-view .e-header-cells').first()).toContainText('Monday');
  await panel(page).locator('select').first().selectOption('0');
  await expect.poll(() => page.evaluate(() => scheduleObj.firstDayOfWeek)).toBe(0);
  await ctx.close();
});

test('Share in the panel still copies its links', async ({ browser, request }) => {
  const { id, viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('share-pill-more').click();
  const viewCard = panel(page).locator('div.bg-1', { has: page.getByText('View Only', { exact: true }) });
  await viewCard.getByRole('button', { name: 'Copy' }).first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`/view/${viewId}`);
  await ctx.close();
});

test('view link: notes are pinned beside the calendar, and hiding them sticks', async ({ browser, request }) => {
  const { viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/view/${viewId}?backend=cf`);
  await expect(panel(page)).toHaveAttribute('data-tab', 'notes');
  await expect(page.getByTestId('side-title')).toHaveText('About this calendar');
  await expect(panel(page)).toContainText('Rainouts decided by 7am');
  await expect(panel(page).getByRole('tab')).toHaveCount(0);           // no editing tabs
  await expect(panel(page).getByLabel('Calendar notes')).toHaveCount(0);
  const cal = await box(page); const side = await panel(page).boundingBox();
  expect(side.x).toBeGreaterThanOrEqual(cal.x + cal.width);

  await panel(page).getByRole('button', { name: 'Hide notes' }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  await page.waitForTimeout(800);
  await expect(panel(page)).toHaveCount(0);
  await page.getByTestId('desktop-title-area').getByRole('button', { name: 'Toggle notes' }).click();
  await expect(page.getByTestId('side-title')).toHaveText('About this calendar');
  await ctx.close();
});

test('phone: the panel is a bottom sheet over the calendar, with tabs, closed by its backdrop', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`, { width: 390, height: 844 });
  const before = await box(page);
  await page.getByTestId('share-button-mobile').click();
  await expect(panel(page)).toHaveAttribute('data-tab', 'share');
  // It slides up 24px as it opens; measure once it has come to rest.
  await expect.poll(async () => { const b = await panel(page).boundingBox(); return Math.round(b.y + b.height); }).toBe(844);   // anchored to the bottom
  const sheet = await panel(page).boundingBox();
  expect(sheet.width).toBe(390);
  expect(sheet.height).toBeLessThan(844 * 0.75);                       // the calendar still shows above
  expect(Math.abs((await box(page)).width - before.width)).toBeLessThan(2);   // over it, not beside it
  await page.getByTestId('side-tab-notes').click();
  await expect(panel(page).getByLabel('Calendar notes')).toBeVisible();
  await page.getByTestId('side-scrim').click({ position: { x: 195, y: 60 } });
  await expect(panel(page)).toHaveCount(0);
  await ctx.close();
});

// Last: it changes the shared calendar.
test('Changes in the panel still undoes an edit', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  const dialog = page.locator('.e-dialog.e-schedule-dialog');
  await page.locator('.e-appointment:has-text("Game vs Hawks")').first().dblclick();
  await dialog.locator('input.e-subject').fill('Game vs Owls');
  await dialog.locator('button.e-event-save').click();
  await expect(dialog).toBeHidden();
  const title = async () => (await (await page.request.get(`/cal/${id}`)).json()).calendar.events.find((e) => e.id === 'e2').title;
  await expect.poll(title, { timeout: 10_000 }).toBe('Game vs Owls');

  await page.getByTestId('last-edit-link').click();
  const changes = page.getByTestId('recent-changes');
  await expect(changes.getByRole('heading', { name: 'Recent changes' })).toBeVisible();
  await changes.getByRole('button', { name: 'Undo this edit' }).first().click();
  await expect.poll(title, { timeout: 10_000 }).toBe('Game vs Hawks');
  await expect(page.locator('.e-appointment:has-text("Game vs Hawks")')).toHaveCount(1);
  await ctx.close();
});
