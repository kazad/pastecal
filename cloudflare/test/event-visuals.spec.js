// @ts-check
/**
 * Event text readable on its color, all-day events without a "12:00 AM", and dark-mode
 * Syncfusion popups on the app's own surfaces. Needs `wrangler dev` on BASE_URL.
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')._vnode.component.proxy`;
const INK = 'rgb(20, 23, 28)', WHITE = 'rgb(255, 255, 255)';

async function open(page, theme = 'light') {
  await page.addInitScript(() => { window.__TEST__ = true; });
  await page.goto('/?backend=cf');
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-work-cells'));
  await page.evaluate(`${VM}.globalSettings.darkMode = '${theme}'`);
  await page.evaluate((VM) => {
    const vm = eval(VM);
    const add = (event) => vm.store().dispatch({ type: 'add', event });
    // Separate days of one week, so none is folded into "+N more".
    const at = (day, h) => new Date(2026, 9, day, h);
    add({ title: 'Orange thing', start: at(13, 9), end: at(13, 10), type: 5 });   // #ff9800
    add({ title: 'Indigo thing', start: at(14, 11), end: at(14, 12), type: 1 });  // #3f51b5
    add({ title: 'Holiday', start: at(15, 0), end: at(16, 0), type: 6, isAllDay: true });
  }, VM);
  await page.evaluate(() => { scheduleObj.selectedDate = new Date(2026, 9, 14); scheduleObj.currentView = 'Month'; });
  await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Holiday' })).toBeVisible();
}

const textColors = (loc) => loc.evaluate((el) => ({
  subject: getComputedStyle(el.querySelector('.e-subject')).color,
  time: el.querySelector('.e-time') ? getComputedStyle(el.querySelector('.e-time')).color : null,
  opacity: el.querySelector('.e-time') ? getComputedStyle(el.querySelector('.e-time')).opacity : null,
}));

test('event text is dark on a light color and white on a dark one, in month, week and the popup', async ({ page }) => {
  await open(page);
  const orange = await textColors(page.locator('.e-month-view .e-appointment', { hasText: 'Orange thing' }));
  expect(orange).toEqual({ subject: INK, time: INK, opacity: '1' });
  expect((await textColors(page.locator('.e-month-view .e-appointment', { hasText: 'Indigo thing' }))).subject).toBe(WHITE);

  await page.evaluate(() => { scheduleObj.currentView = 'Week'; });
  const chip = page.locator('.e-vertical-view .e-appointment', { hasText: 'Orange thing' });
  await expect(chip).toBeVisible();
  expect((await textColors(chip)).subject).toBe(INK);

  await chip.click();
  const header = page.locator('.e-quick-popup-wrapper .e-event-popup .e-popup-header');
  await expect(header).toBeVisible();
  expect(await header.locator('.e-subject').evaluate((el) => getComputedStyle(el).color)).toBe(INK);

  // Opened from the agenda, where the chip has no fill, the header still pairs fill and text.
  await page.keyboard.press('Escape');
  await page.evaluate(() => { scheduleObj.selectedDate = new Date(2026, 9, 13); scheduleObj.currentView = 'Agenda'; });
  await page.locator('.e-agenda-view .e-appointment', { hasText: 'Orange thing' }).click();
  await expect(header).toBeVisible();
  expect(await header.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el.querySelector('.e-subject')).color]))
    .toEqual(['rgb(255, 152, 0)', INK]);
});

test('an all-day event shows no time, on its chip or in search', async ({ page }) => {
  await open(page);
  await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Holiday' })).not.toContainText('12:00');
  await page.getByTestId('search-button-desktop').click();
  await page.locator('input[type="search"][aria-label="Search events"]').fill('Holiday');
  const result = page.locator('[class*="max-h-64"] > div', { hasText: 'Holiday' });
  await expect(result).toBeVisible();
  await expect(result).not.toContainText('12:00');
  await expect(result).not.toContainText(':');   // dates only
});

test('dark mode: the quick popup and editor use the app surface and hairline, not #424242', async ({ page }) => {
  await open(page, 'dark');
  const token = (name) => page.evaluate((n) => {
    const probe = document.createElement('div'); probe.style.background = `var(${n})`; document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor; probe.remove(); return c;
  }, name);
  const surface = await token('--pc-surface'), line = await token('--pc-line');

  await page.locator('.e-month-view .e-appointment', { hasText: 'Orange thing' }).click();
  const quick = page.locator('.e-quick-popup-wrapper.e-popup-open');
  await expect(quick).toBeVisible();
  expect(await quick.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopColor])).toEqual([surface, line]);
  await quick.locator('.e-close').click();

  await page.locator('.e-month-view .e-appointment', { hasText: 'Orange thing' }).dblclick();
  const dialog = page.locator('.e-schedule-dialog.e-popup-open');
  await expect(dialog).toBeVisible();
  for (const part of ['.e-dlg-header-content', '.e-dlg-content', '.e-footer-content']) {
    expect(await dialog.locator(part).evaluate((el) => getComputedStyle(el).backgroundColor), part).toBe(surface);
  }
  await dialog.locator('.e-date-icon').first().click();
  const cal = page.locator('.e-datepicker.e-popup-wrapper .e-calendar');
  await expect(cal).toBeVisible();
  expect(await cal.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(surface);
  await dialog.locator('.e-dlg-closeicon-btn').click();
  await expect(dialog).toBeHidden();

  // "This event or the entire series?" is a dialog of its own.
  await page.evaluate((VM) => eval(VM).store().dispatch({ type: 'add', event: { title: 'Weekly', start: new Date(2026, 9, 13, 14), end: new Date(2026, 9, 13, 15), type: 2, recurrencerule: 'FREQ=WEEKLY;COUNT=3' } }), VM);
  await page.locator('.e-month-view .e-appointment', { hasText: 'Weekly' }).first().dblclick();
  const series = page.locator('.e-quick-dialog.e-popup-open');
  await expect(series).toBeVisible();
  expect(await series.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(surface);
});
