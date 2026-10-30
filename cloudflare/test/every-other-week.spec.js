// @ts-check
/**
 * "Every other week" in the classic editor's Repeat menu: it saves Weekly, every 2 weeks, on the event's
 * weekday, and the event shows on alternate weeks only. Needs `wrangler dev` on BASE_URL; seeds its own
 * calendars. Runs in America/Los_Angeles (playwright.config).
 */
const { test, expect } = require('@playwright/test');

const newId = () => `test-biweekly-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
const stored = async (request, id) => (await (await request.get(`/cal/${id}`)).json()).calendar.events;
const cellOn = (page, d) => page.locator(`.e-month-view td.e-work-cells[data-date="${d.getTime()}"]`);

test('classic: Every other week saves a weekly rule every 2 weeks, shown on alternate weeks', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = newId();
  expect((await request.post(`/cal/${id}`, { data: { title: 'Rota', options: {}, events: [] } })).status()).toBe(201);
  await page.goto(`/${id}?backend=cf&view=month&date=2026-10-01`);
  // Tuesday Oct 6 2026.
  const cell = cellOn(page, new Date(2026, 9, 6));
  await expect(cell).toBeVisible({ timeout: 15_000 });
  await cell.dblclick();
  const dialog = page.locator('.e-schedule-dialog.e-popup-open');
  await expect(dialog).toBeVisible();
  await dialog.locator('[name="Subject"]').fill('Bin day');
  const repeat = dialog.locator('.e-repeat-element');
  await expect(async () => {
    await repeat.locator('..').click();
    await page.waitForTimeout(300);
    // The menu has the entry once, last (Syncfusion picks Never..Yearly by position).
    await expect(page.locator('.e-popup-open li')).toHaveText(['Never', 'Daily', 'Weekly', 'Monthly', 'Yearly', 'Every other week']);
    await page.locator('.e-popup-open li', { hasText: /^Every other week$/ }).click({ timeout: 2000 });
    await page.waitForTimeout(300);
    expect(await repeat.inputValue()).toBe('Every other week');
  }).toPass({ timeout: 10_000 });
  // The editor shows what it set up: every 2 weeks, on Tuesday.
  await expect(dialog.locator('.e-repeat-interval')).toHaveValue(/^2/);
  await dialog.locator('.e-event-save').click();
  await expect(dialog).toHaveCount(0);

  await expect.poll(async () => (await stored(request, id)).map((e) => e.recurrencerule), { timeout: 10_000 })
    .toEqual([expect.stringMatching(/^(?=.*FREQ=WEEKLY)(?=.*INTERVAL=2)(?=.*BYDAY=TU)/)]);

  const chip = (d) => cellOn(page, d).locator('.e-appointment', { hasText: 'Bin day' });
  for (const d of [6, 20]) await expect(chip(new Date(2026, 9, d)), `Oct ${d}`).toHaveCount(1);
  for (const d of [13, 27]) await expect(chip(new Date(2026, 9, d)), `Oct ${d}`).toHaveCount(0);

  // Opening the editor again doesn't add the entry twice.
  await chip(new Date(2026, 9, 20)).dblclick();
  const series = page.locator('.e-quick-dialog.e-popup-open button', { hasText: 'Entire series' });
  await expect(dialog.or(series)).toBeVisible();
  if (await series.isVisible()) await series.click();
  await expect(dialog).toBeVisible();
  await dialog.locator('.e-repeat-element').locator('..').click();
  await expect(page.locator('.e-popup-open li', { hasText: /^Every other week$/ })).toHaveCount(1);
});
