// @ts-check
/**
 * The You tab (Oct 28 2026), driven like a person, in the classic calendar and in ?cal=native.
 *
 * Settings used to mix "This calendar" (everyone with the link) and "Only me" (this device). Now the gear is this
 * calendar only, and a small circle just before it, You, holds your name and this device's preferences:
 *   1. every preference moved to You still does what it did, and is kept across a reload;
 *   2. Settings shows only the calendar's controls, Backup last;
 *   3. a name set in You goes with your saves: Activity says "Edited by <name>", here and in another browser;
 *   4. a view link: the gear opens You with the preferences and no name field (viewers don't save);
 *   5. a phone (390 and 360 wide): the You tab is on screen and opens.
 * Screenshots: cloudflare/test-results/you-panel/. Needs `wrangler dev` (scripts/test-browser.sh); run with
 * scripts/test-on-box.sh you-panel.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'test-results', 'you-panel');
fs.mkdirSync(OUT, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);

let n = 0;
async function seed(events = []) {
  const id = `you-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'You test', options: { typeLabels: ['Practice', 'Game'] }, events }) });
  expect(res.status).toBe(201);
  return id;
}
async function viewOf(id) {
  return (await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json()).publicViewId;
}

async function open(browser, url, { native = false, viewport = { width: 1440, height: 900 }, colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, hasTouch: viewport.width < 600, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}backend=cf${native ? '&cal=native' : ''}`);
  await loaded(page, native);
  return { ctx, page, errors };
}
async function loaded(page, native) {
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  await expect(page.locator(native ? '.nc' : '.e-schedule .e-work-cells').first()).toBeVisible({ timeout: 20_000 });
}
const vm = (page, expr) => page.evaluate((e) => { const p = document.querySelector('#app')._vnode.component.proxy; return Function('p', `return (${e})`)(p); }, expr);
const panel = (page) => page.getByTestId('side-panel');
const stored = async (page) => JSON.parse(await page.evaluate(() => localStorage.getItem('pastecal_global_settings') || '{}'));

for (const native of [false, true]) {
  const where = native ? 'native' : 'classic';

  test(`${where}: every preference moved to You still works, and is kept after a reload`, async ({ browser }) => {
    const id = await seed();
    const { ctx, page, errors } = await open(browser, `/${id}?view=month&date=2026-10-01`, { native });
    await page.getByTestId('settings-button-desktop').click();
    await page.getByTestId('side-tab-you').click();
    await expect(panel(page)).toHaveAttribute('data-tab', 'you');
    await expect(page.getByTestId('side-tab-you')).toHaveAttribute('aria-selected', 'true');
    const you = page.getByTestId('you');

    // First day of week: the month's first column.
    await you.getByLabel('First day of week').selectOption('1');
    const firstHead = native ? page.locator('.nc-weekday, .nc-dayhead').first() : page.locator('.e-month-view .e-header-cells').first();
    await expect(firstHead).toContainText(/Mon/);
    // Time format: the start hours read in it.
    await you.getByLabel('Time format').selectOption('24');
    await expect.poll(() => you.getByLabel('Start hour').locator('option').allInnerTexts()).toEqual(['00:00', '05:00', '06:00', '07:00', '08:00', '09:00']);
    await you.getByLabel('Date format').selectOption('iso');
    await you.getByLabel('Start hour').selectOption('07:00');
    await you.getByLabel('My default view').selectOption('Week');
    // Theme: the page itself.
    await you.getByLabel('Theme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // Custom: its length shows only while it is the default view.
    await expect(you.getByLabel('Custom view length')).toHaveCount(0);
    await you.getByLabel('My default view').selectOption('Custom');
    await you.getByLabel('Custom view length').fill('3');
    await you.getByLabel('Custom view length').blur();
    await you.getByLabel('Custom view unit').selectOption('Months');
    await you.getByLabel('My default view').selectOption('Week');
    expect(await stored(page)).toMatchObject({ firstDayOfWeek: '1', timeFormat: '24', dateFormat: 'iso', startHour: '07:00', defaultView: 'Week', darkMode: 'dark', customViewDuration: 3, customViewUnit: 'Months' });
    await page.screenshot({ path: path.join(OUT, `${where}-you-desktop-dark.png`) });

    // Kept after a reload: in the controls, and in what they do.
    await page.reload();
    await loaded(page, native);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(firstHead).toContainText(/Mon/);
    await vm(page, "p.openSideTab('you')");
    await expect(you.getByLabel('First day of week')).toHaveValue('1');
    await expect(you.getByLabel('Time format')).toHaveValue('24');
    await expect(you.getByLabel('Date format')).toHaveValue('iso');
    await expect(you.getByLabel('Start hour')).toHaveValue('07:00');
    await expect(you.getByLabel('My default view')).toHaveValue('Week');
    await expect(you.getByLabel('Theme')).toHaveValue('dark');
    expect(await vm(page, 'p.globalSettings.timeFormat')).toBe('24');
    await you.getByLabel('Theme').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test(`${where}: Settings holds only this calendar's controls, Backup last; You has the name and preferences`, async ({ browser }) => {
    const id = await seed();
    const { ctx, page } = await open(browser, `/${id}`, { native });
    await page.getByTestId('settings-button-desktop').click();
    const settings = page.getByTestId('settings');
    // The inventory of Settings before the change, calendar half: every control still here.
    await expect(settings.getByText('Colors and labels')).toBeVisible();
    await expect(settings.getByLabel('Color picker for Practice')).toHaveCount(1);
    await expect(settings.getByLabel('Label for type 1')).toHaveValue('Practice');
    await expect(page.getByTestId('add-category')).toBeVisible();
    await expect(settings.getByLabel('Default view for everyone')).toBeVisible();
    await expect(settings.getByText('Show 12–4 AM')).toBeVisible();
    await expect(page.getByTestId('settings-copy-btn')).toHaveText('Make a copy');
    await expect(page.getByTestId('ics-download')).toHaveText('Download .ics');
    await expect(page.getByTestId('ics-import')).toHaveText('Import .ics');
    // ...and none of yours.
    for (const label of ['First day of week', 'Time format', 'Date format', 'Start hour', 'My default view', 'Theme', 'Your name (optional)']) {
      await expect(settings.getByLabel(label, { exact: true }), label).toHaveCount(0);
    }
    // Backup is the last thing in the panel.
    const last = await settings.evaluate((s) => { const pane = s.querySelector('[data-testid="settings-calendar"]'); return pane.lastElementChild.getAttribute('data-testid'); });
    expect(last).toBe('settings-backup');
    await expect(page.getByTestId('settings-backup')).toContainText('Backup:');
    if (!native) await panel(page).screenshot({ path: path.join(OUT, 'settings-desktop-light.png') });

    await page.getByTestId('side-tab-you').click();
    const you = page.getByTestId('you');
    await expect(you.getByLabel('Your name (optional)')).toBeVisible();
    await expect(you).toContainText('Shown to people who can edit this calendar.');
    for (const label of ['First day of week', 'Time format', 'Date format', 'Start hour', 'My default view', 'Theme']) {
      await expect(you.getByLabel(label, { exact: true }), label).toBeVisible();
    }
    await expect(you.getByLabel('Default view for everyone')).toHaveCount(0);
    if (!native) await panel(page).screenshot({ path: path.join(OUT, 'you-desktop-light.png') });
    await ctx.close();
  });

  test(`${where}: a name in You goes with your saves: Activity says "Edited by <name>", here and in another browser`, async ({ browser }) => {
    const id = await seed();
    const A = await open(browser, `/${id}`, { native });
    // Before a name: the circle is a person outline, and a save says nothing about who.
    await expect(A.page.getByTestId('side-tab-you')).toHaveCount(0);   // (no panel open yet)
    await quickAdd(A.page, 'Snack duty tomorrow 3pm');
    await expect.poll(async () => (await calOf(id)).events.length).toBe(1);
    await A.page.getByTestId('settings-button-desktop').click();
    await expect(A.page.getByTestId('side-tab-you').locator('svg')).toHaveCount(1);
    await A.page.getByTestId('side-tab-changes').click();
    await expect(A.page.getByTestId('recent-changes')).toContainText('Snack duty');
    await expect(A.page.getByTestId('activity-by')).toHaveCount(0);

    await A.page.getByTestId('side-tab-you').click();
    const field = A.page.getByLabel('Your name (optional)');
    await field.fill('  Sam   Lee  ');
    await field.press('Enter');
    await expect(field).toHaveValue('Sam Lee');   // as it is kept
    await expect(A.page.getByTestId('side-tab-you')).toHaveText('SL');
    await expect(A.page.getByTestId('side-tab-you')).toHaveAccessibleName('You');
    expect(await A.page.evaluate(() => localStorage.getItem('pastecal_my_name'))).toBe('Sam Lee');
    await A.page.getByTestId('side-close').click();
    await quickAdd(A.page, 'Pizza night friday 6pm');
    await expect.poll(async () => (await calOf(id)).events.length).toBe(2);
    const hist = await (await fetch(`${BASE}/cal/${id}/history`)).json();
    expect(hist[0].name).toBe('Sam Lee');
    await A.page.getByTestId('settings-button-desktop').click();
    await A.page.getByTestId('side-tab-changes').click();
    const row = A.page.locator('.pc-act-row', { hasText: 'Pizza' });
    await expect(row.getByTestId('activity-by')).toHaveText('· Edited by Sam Lee');
    await expect(A.page.locator('.pc-act-row', { hasText: 'Snack duty' }).getByTestId('activity-by')).toHaveCount(0);
    if (!native) await panel(A.page).screenshot({ path: path.join(OUT, 'activity-edited-by-light.png') });

    // Another browser on the same calendar, with no name of its own, sees who.
    const B = await open(browser, `/${id}`, { native, colorScheme: 'dark' });
    await B.page.getByTestId('settings-button-desktop').click();
    await B.page.getByTestId('side-tab-changes').click();
    await expect(B.page.locator('.pc-act-row', { hasText: 'Pizza' }).getByTestId('activity-by')).toHaveText('· Edited by Sam Lee');
    if (!native) await panel(B.page).screenshot({ path: path.join(OUT, 'activity-edited-by-dark.png') });
    // Clearing the name: later saves say nothing about who.
    await A.page.getByTestId('side-tab-you').click();
    await A.page.getByLabel('Your name (optional)').fill('');
    await A.page.getByLabel('Your name (optional)').press('Enter');
    expect(await A.page.evaluate(() => localStorage.getItem('pastecal_my_name'))).toBe(null);
    await expect(A.page.getByTestId('side-tab-you').locator('svg')).toHaveCount(1);
    expect(A.errors).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test(`${where}: a view link's gear opens You: the preferences, no name field`, async ({ browser }) => {
    const id = await seed();
    const viewId = await viewOf(id);
    const { ctx, page, errors } = await open(browser, `/view/${viewId}`, { native });
    await page.getByTestId('settings-button-desktop').click();
    await expect(panel(page)).toHaveAttribute('data-tab', 'you');
    await expect(page.getByTestId('side-title')).toHaveText('Settings');
    await expect(panel(page).getByRole('tab')).toHaveCount(0);
    await expect(page.getByLabel('Your name (optional)')).toHaveCount(0);
    await expect(page.getByTestId('settings-calendar')).toHaveCount(0);
    await page.getByTestId('you').getByLabel('First day of week').selectOption('1');
    expect(await stored(page)).toMatchObject({ firstDayOfWeek: '1' });
    const firstHead = native ? page.locator('.nc-weekday, .nc-dayhead').first() : page.locator('.e-month-view .e-header-cells').first();
    await expect(firstHead).toContainText(/Mon/);
    if (!native) await panel(page).screenshot({ path: path.join(OUT, 'view-link-you-light.png') });
    await page.reload();
    await loaded(page, native);
    await expect(firstHead).toContainText(/Mon/);
    // The gear again closes it.
    await page.getByTestId('settings-button-desktop').click();
    await expect(panel(page)).toHaveAttribute('data-tab', 'you');
    await page.getByTestId('settings-button-desktop').click();
    await expect(panel(page)).toHaveCount(0);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  for (const width of [390, 360]) {
    test(`${where}: phone ${width}: the You tab is on screen and opens`, async ({ browser }) => {
      const id = await seed();
      const { ctx, page } = await open(browser, `/${id}`, { native, viewport: { width, height: 800 } });
      await vm(page, "p.openSideTab('share')");
      const tab = page.getByTestId('side-tab-you');
      await expect(tab).toBeVisible();
      const b = await tab.boundingBox();
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, 'inside the screen').toBeLessThanOrEqual(width);
      await tab.click();
      await expect(panel(page)).toHaveAttribute('data-tab', 'you');
      await expect(page.getByLabel('Your name (optional)')).toBeVisible();
      if (!native && width === 390) await page.screenshot({ path: path.join(OUT, 'you-phone-light.png') });
      await ctx.close();
    });
  }
}

async function quickAdd(page, text) {
  await page.getByTestId('desktop-add-event-button').click();
  await page.locator('textarea[aria-label="Event description"]').fill(text);
  await page.locator('.pc-qa-dialog button[type="submit"]').click();
  await expect(page.locator('.pc-qa-dialog')).toHaveCount(0);
}
async function calOf(id) { return (await (await fetch(`${BASE}/cal/${id}`)).json()).calendar; }
