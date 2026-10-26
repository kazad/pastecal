// @ts-check
/**
 * A phone (390x844, touch), driven like a person:
 *   1. The header has an "Add event" button; it opens the same quick add as desktop's
 *      "+ Add event", and an event made there is saved on the server.
 *   2. Quick add and the event editor fit the screen: nothing scrolls sideways, and the
 *      editor's Start/End show the whole date and time.
 *   3. Week view hour labels read in full ("5a", not "5:00…") and event titles aren't clipped.
 *   4. A view link has no Add button (it can't add events).
 * The side panel as a bottom sheet is covered in side-panel.spec.js.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787); seeds its own calendars.
 */
const { test, expect } = require('@playwright/test');

const PHONE = { width: 390, height: 844 };

async function seed(request, title = 'Phone test') {
  const id = `test-phone-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const at = (dd, h) => { const d = new Date(); d.setDate(d.getDate() + dd); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const events = [
    { id: 'e1', title: 'Standup meeting', start: at(0, 9), end: at(0, 10), type: 1 },
    { id: 'e2', title: 'Team review', start: at(0, 14), end: at(0, 16), type: 2 },
  ];
  expect((await request.post(`/cal/${id}`, { data: { title, options: {}, events } })).status()).toBe(201);
  return id;
}

async function open(browser, path) {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  await page.goto(path);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-appointment'), null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  return { ctx, page };
}

// Every element inside `root` that pokes past the right edge of the screen, and whether root scrolls sideways.
const sideways = (page, root) => page.$eval(root, (el) => {
  const W = window.innerWidth;
  const out = [...el.querySelectorAll('*')].filter((x) => { const b = x.getBoundingClientRect(); return b.width > 0 && b.right > W + 0.5; })
    .map((x) => `${x.tagName}.${String(x.className).slice(0, 40)}`);
  return { out, scrolls: el.scrollWidth > el.clientWidth + 0.5, page: document.documentElement.scrollWidth > W };
});

test('phone: the header "Add event" button opens quick add, which fits the screen and saves', async ({ browser, request }) => {
  const id = await seed(request);
  const { ctx, page } = await open(browser, `/${id}`);
  const add = page.getByTestId('mobile-add-event-button');
  await expect(add).toBeVisible();
  const b = await add.boundingBox();
  expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
  expect(b.width).toBeGreaterThanOrEqual(44);   // a full tap target

  await add.tap();
  const dialog = page.locator('.pc-qa-dialog');
  await expect(dialog).toBeVisible();
  const fit = await sideways(page, '.pc-qa-dialog');
  expect(fit.out, 'nothing in quick add is wider than the screen').toEqual([]);
  expect(fit.scrolls).toBe(false);
  expect(fit.page).toBe(false);
  // The time field shows a whole time, not a clipped one.
  const time = await page.$eval('.pc-qa-dialog input[aria-label="Start time"]', (e) => e.getBoundingClientRect().width);
  expect(time).toBeGreaterThanOrEqual(100);

  await page.locator('textarea[aria-label="Event description"]').fill('Phone lunch tomorrow at 1pm');
  await dialog.getByRole('button', { name: 'Create' }).tap();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(`/cal/${id}`)).json()).calendar.events.map((e) => e.title), { timeout: 10_000 })
    .toContain('Phone lunch');
  await ctx.close();
});

test('phone: the event editor fits and shows whole start and end times', async ({ browser, request }) => {
  const id = await seed(request);
  const { ctx, page } = await open(browser, `/${id}`);
  await page.evaluate(() => { const s = new Date(); s.setHours(10, 0, 0, 0); const e = new Date(s); e.setHours(11); scheduleObj.openEditor({ startTime: s, endTime: e }, 'Add'); });
  const editor = page.locator('.e-schedule-dialog.e-popup-open');
  await expect(editor).toBeVisible();
  const fit = await sideways(page, '.e-schedule-dialog.e-popup-open');
  expect(fit.out).toEqual([]);
  expect(fit.page).toBe(false);
  for (const name of ['StartTime', 'EndTime']) {
    const [sw, cw] = await editor.locator(`input[name="${name}"]`).evaluate((e) => [e.scrollWidth, e.clientWidth]);
    expect(sw, `${name} shows its whole value`).toBeLessThanOrEqual(cw);
  }
  await ctx.close();
});

test('phone: Week view hour labels read in full and event titles are not clipped', async ({ browser, request }) => {
  const id = await seed(request);
  const { ctx, page } = await open(browser, `/${id}`);
  await page.evaluate(() => { scheduleObj.currentView = 'Week'; });
  await page.waitForFunction(() => document.querySelector('.e-week-view .e-time-slots .pc-hour') && document.querySelector('.e-week-view .e-appointment'));
  // Hour cells carry a label; the half-hour cells between them are empty.
  const labels = await page.$$eval('.e-week-view .e-time-cells-wrap .e-time-slots', (els) => els.filter((e) => e.textContent.trim())
    .map((e) => ({ text: e.textContent.trim(), clipped: e.scrollWidth > e.clientWidth + 0.5 || e.querySelector('span').scrollWidth > e.clientWidth })));
  expect(labels.length).toBeGreaterThan(5);
  for (const l of labels) {
    expect(l.text).toMatch(/^(\d{1,2}[ap]|\d{1,2})$/);
    expect(l.clipped, `"${l.text}" fits its cell`).toBe(false);
  }
  const titles = await page.$$eval('.e-week-view .e-appointment .e-subject', (els) => els.map((e) => ({ text: e.textContent.trim(), clipped: e.scrollWidth > e.clientWidth + 0.5 })));
  expect(titles.map((t) => t.text)).toEqual(expect.arrayContaining(['Standup meeting', 'Team review']));
  for (const t of titles) expect(t.clipped, `"${t.text}" isn't cut off sideways`).toBe(false);
  await ctx.close();
});

test('phone: a view link has no Add event button', async ({ browser, request }) => {
  const id = await seed(request);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  expect(view.ok).toBe(true);
  const { ctx, page } = await open(browser, `/${view.publicViewId}`);
  await expect(page.getByTestId('mobile-header')).toBeVisible();
  await expect(page.getByTestId('mobile-add-event-button')).toHaveCount(0);
  await ctx.close();
});

for (const width of [360, 390]) {
  test(`phone ${width}px: the header gives the title room, 44px targets, and Notes from the ⋮ menu`, async ({ browser, request }) => {
    const id = await seed(request, 'Fall soccer schedule');
    const ctx = await browser.newContext({ viewport: { width, height: 760 }, hasTouch: true, isMobile: true });
    await ctx.addInitScript(() => { window.__TEST__ = true; });
    const page = await ctx.newPage();
    await page.goto(`/${id}?backend=cf`);
    await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-appointment'), null, { timeout: 20_000 });
    const header = page.getByTestId('mobile-header');
    const box = (el) => el.boundingBox();
    const add = await box(page.getByTestId('mobile-add-event-button'));
    const share = await box(page.getByTestId('share-button-mobile'));
    const menu = await box(page.getByTestId('mobile-menu-button'));
    for (const b of [add, share, menu]) { expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44); }
    const title = await box(header.locator('.pc-m-title'));
    expect(title.width, 'the name has room').toBeGreaterThan(80);
    expect(title.x + title.width).toBeLessThanOrEqual(add.x + 1);
    const logo = await box(header.locator('img[alt="pastecal"]'));
    expect(logo.x + logo.width).toBeLessThanOrEqual(title.x);
    // Notes moved from the header into the menu
    await expect(header.getByRole('button', { name: 'Toggle notes' })).toBeHidden();
    await page.getByTestId('mobile-menu-button').tap();
    await page.getByTestId('notes-button-mobile').tap();
    await expect(page.getByTestId('side-panel')).toHaveAttribute('data-tab', 'notes');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await ctx.close();
  });
}
