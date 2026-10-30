// @ts-check
/**
 * Month view: long titles wrap where their day has room (ScheduleAdapter.fitMonthTitles), a busy
 * day keeps one line per event, nothing overlaps, and today's cell is tinted. Needs `wrangler dev`.
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')._vnode.component.proxy`;
const LONG = 'Volunteer orientation at the community center';

async function open(page) {
  await page.addInitScript(() => { window.__TEST__ = true; });
  await page.goto('/?backend=cf');
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-work-cells'));
  await page.evaluate((VM) => {
    const vm = eval(VM);
    const add = (event) => vm.store().dispatch({ type: 'add', event });
    const at = (d, h = 0) => new Date(2026, 9, d, h);
    const allDay = (d, title, n = 1) => add({ title, start: at(d), end: at(d + n), isAllDay: true, type: 1 });
    allDay(6, 'Volunteer orientation at the community center');
    add({ title: 'Food bank pickup and drop-off at the church', start: at(7, 9), end: at(7, 10), type: 4 });
    allDay(12, 'Fall break', 3);
    allDay(13, 'Dentist');
    add({ title: 'Parent-teacher conference with the science teacher', start: at(13, 14), end: at(13, 15), type: 3 });
    for (const [h, t] of [[8, 'Breakfast with the whole volunteer team'], [10, 'Standup with the design team'], [12, 'Lunch'], [15, 'Soccer practice at the park'], [18, 'Dinner']]) {
      add({ title: t, start: at(20, h), end: at(20, h + 1), type: 2 });
    }
  }, VM);
  await page.evaluate(() => { scheduleObj.selectedDate = new Date(2026, 9, 14); scheduleObj.currentView = 'Month'; });
  await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Fall break' })).toBeVisible();
  await page.waitForFunction(() => document.querySelector('.e-month-view .e-appointment.pc-wrap'));
}

const chip = (page, text) => page.locator('.e-month-view .e-appointment', { hasText: text });

// Every pair of chips that share a day column: their boxes don't overlap.
const overlaps = (page) => page.evaluate(() => {
  const out = [];
  for (const tr of document.querySelectorAll('.e-month-view .e-content-table tbody tr')) {
    const cols = [...tr.children].map((td) => td.getBoundingClientRect());
    const boxes = [...tr.querySelectorAll('.e-appointment')].map((el) => ({ t: el.innerText, r: el.getBoundingClientRect() }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r;
      const sameCol = cols.some((c) => a.left < c.right - 1 && a.right > c.left + 1 && b.left < c.right - 1 && b.right > c.left + 1);
      if (sameCol && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${boxes[i].t} / ${boxes[j].t}`);
    }
  }
  return out;
});

for (const phone of [false, true]) {
  test.describe(phone ? 'phone' : 'desktop', () => {
    if (phone) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('a long title on a free day wraps; nothing overlaps', async ({ page }) => {
      await open(page);
      const long = chip(page, LONG);
      await expect(long).toHaveClass(/pc-wrap/);
      const line = await chip(page, 'Fall break').evaluate((el) => el.offsetHeight);
      expect(await long.evaluate((el) => el.offsetHeight)).toBeGreaterThan(line * 1.5);
      if (!phone) {
        // The whole title shows: no line is clipped.
        expect(await long.locator('.e-appointment-details').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      }
      expect(await overlaps(page)).toEqual([]);
    });

    test('a busy day keeps one line per event, and a multi-day event stays one line', async ({ page }) => {
      await open(page);
      await expect(page.locator('.e-month-view .e-more-indicator').first()).toBeVisible();
      for (const t of ['Breakfast', 'Standup']) await expect(chip(page, t)).not.toHaveClass(/pc-wrap/);
      await expect(chip(page, 'Fall break')).not.toHaveClass(/pc-wrap/);
      expect(await overlaps(page)).toEqual([]);
    });

    test('still no overlaps after moving to another month and back', async ({ page }) => {
      await open(page);
      await page.evaluate(() => { scheduleObj.selectedDate = new Date(2026, 10, 14); });
      await page.evaluate(() => { scheduleObj.selectedDate = new Date(2026, 9, 14); });
      await expect(chip(page, LONG)).toHaveClass(/pc-wrap/);
      expect(await overlaps(page)).toEqual([]);
    });
  });
}

test('titles stay wrapped after switching to dark mode (a redraw with no dataBound)', async ({ page }) => {
  await open(page);
  await page.evaluate(`${VM}.globalSettings.darkMode = 'dark'`);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForTimeout(500);
  await expect(chip(page, LONG)).toHaveClass(/pc-wrap/);
  expect(await overlaps(page)).toEqual([]);
});

test("today's whole cell is tinted", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { scheduleObj.selectedDate = new Date(); });
  const today = page.locator('.e-month-view td.e-work-cells.e-current-date');
  await expect(today).toHaveCount(1);
  const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  const other = page.locator('.e-month-view td.e-work-cells.e-work-days:not(.e-current-date):not(.e-other-month)').first();
  expect(await bg(today)).not.toBe(await bg(other));
});
