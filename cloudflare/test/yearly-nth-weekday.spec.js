// @ts-check
/**
 * Issue #48 (Oct 25 2026): "Every year on October last Mon" showed in October 2026 and not in October 2027.
 * Syncfusion expands a yearly BYSETPOS rule on the wrong years; the classic grid now draws it as the same rule
 * every 12 months, and the stored rule stays the yearly one the editor wrote.
 * Needs `wrangler dev` on BASE_URL; seeds its own calendars. Runs in America/Los_Angeles (playwright.config).
 */
const { test, expect } = require('@playwright/test');

const RULE = 'FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;';
const newId = () => `test-yearly-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
const stored = async (request, id) => (await (await request.get(`/cal/${id}`)).json()).calendar.events;

async function seed(request) {
  const id = newId();
  for (let i = 0; ; i++) {
    const r = await request.post(`/cal/${id}`, { data: { title: 'Board', options: {}, events: [
      // Monday Oct 26 2026, 10-11 AM in Los Angeles.
      { id: 'board', title: 'Board meeting', start: '2026-10-26T17:00:00.000Z', end: '2026-10-26T18:00:00.000Z', type: 1, recurrencerule: RULE },
    ] } });
    if (r.status() === 201) return id;
    if (r.status() !== 429 || i === 2) throw new Error(`create: ${r.status()}`);
    await new Promise((res) => setTimeout(res, 31_000));
  }
}

for (const [year, day] of [[2027, 25], [2028, 30], [2031, 27]]) {
  test(`classic: the last Monday of October shows in ${year} (Oct ${day}), in both renderers`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const id = await seed(request);
    await page.goto(`/${id}?backend=cf&view=month&date=${year}-10-01`);
    const cell = page.locator(`.e-month-view td.e-work-cells[data-date="${new Date(year, 9, day).getTime()}"]`);
    await expect(cell.locator('.e-appointment', { hasText: 'Board meeting' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Board meeting' })).toHaveCount(1);
    await page.goto(`/${id}?backend=cf&cal=native&view=month&date=${year}-10-01`);
    await expect(page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Board meeting' })).toHaveCount(1, { timeout: 15_000 });
  });
}

test('classic: the editor shows the yearly rule, and editing the series keeps it as stored', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = await seed(request);
  await page.goto(`/${id}?backend=cf&view=month&date=2027-10-01`);
  const appt = page.locator('.e-month-view .e-appointment', { hasText: 'Board meeting' });
  await expect(appt).toBeVisible({ timeout: 15_000 });
  await appt.dblclick();
  // "This event or the entire series?"
  await page.locator('.e-quick-dialog.e-popup-open button', { hasText: /series|all/i }).first().click();
  const dialog = page.locator('.e-schedule-dialog.e-popup-open');
  await expect(dialog).toBeVisible();
  // The repeat editor reads "Yearly", not "Monthly every 12".
  await expect(dialog.locator('.e-recurrenceeditor .e-repeat-element')).toHaveValue(/yearly/i);
  await dialog.locator('[name="Subject"]').fill('Board meeting (annual)');
  await dialog.locator('.e-event-save').click();
  await expect.poll(async () => (await stored(request, id)).find((e) => e.id === 'board')?.title, { timeout: 10_000 }).toBe('Board meeting (annual)');
  const ev = (await stored(request, id)).find((e) => e.id === 'board');
  expect(ev.recurrencerule).toMatch(/^FREQ=YEARLY;/);
  expect(ev.recurrencerule).toMatch(/BYSETPOS=-1/);
  expect(ev.recurrencerule).toMatch(/BYMONTH=10/);
  expect(ev.recurrencerule).not.toMatch(/INTERVAL=12/);
});

test('classic: dragging one occurrence keeps the series rule as stored', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = await seed(request);
  await page.goto(`/${id}?backend=cf&view=week&date=2026-10-26`);
  const appt = page.locator('.e-appointment', { hasText: 'Board meeting' }).first();
  await expect(appt).toBeVisible({ timeout: 15_000 });
  const box = await appt.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 80, { steps: 10 });
  await page.mouse.up();
  // Classic moves just that occurrence: an edited occurrence is saved, and the series keeps its rule.
  await expect.poll(async () => (await stored(request, id)).length, { timeout: 10_000 }).toBe(2);
  const series = (await stored(request, id)).find((e) => e.id === 'board');
  expect(series.recurrencerule).toBe(RULE);
  expect(series.recurrenceException).toBeTruthy();
});

// The reporter's own steps (issue #48, "Still not working", Oct 27 2026): a new event made in the classic editor on
// the last Monday of October 2026, repeat "Every year on October last Mon", saved, then October 2027 in the same
// session (no reload) -- and again after a reload.
test('classic: made in the editor, the last Monday of October shows in October 2027 without a reload, and after one', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = newId();
  expect((await request.post(`/cal/${id}`, { data: { title: 'Board', options: {}, events: [] } })).status()).toBe(201);
  await page.goto(`/${id}?backend=cf&view=month&date=2026-10-01`);
  const cell = page.locator(`.e-month-view td.e-work-cells[data-date="${new Date(2026, 9, 26).getTime()}"]`);
  await expect(cell).toBeVisible({ timeout: 15_000 });
  await cell.dblclick();
  const dialog = page.locator('.e-schedule-dialog.e-popup-open');
  await expect(dialog).toBeVisible();
  await dialog.locator('[name="Subject"]').fill('Board meeting');
  const repeat = dialog.locator('.e-repeat-element');
  await expect(async () => {
    await repeat.locator('..').click();
    await page.waitForTimeout(300);
    await page.locator('.e-popup-open li', { hasText: /^Yearly$/ }).first().click({ timeout: 2000 });
    await page.waitForTimeout(300);
    expect(await repeat.inputValue()).toBe('Yearly');
  }).toPass({ timeout: 10_000 });
  // "On the Last Monday of October", as the reporter picked it.
  await page.evaluate((rule) => {
    const el = document.querySelector('.e-schedule-dialog.e-popup-open .e-recurrenceeditor');
    el.ej2_instances[0].setRecurrenceRule(rule, new Date(2026, 9, 26));
  }, RULE);
  await expect(dialog.locator('.e-recurrenceeditor')).toContainText(/last/i);
  await dialog.locator('.e-event-save').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await stored(request, id)).map((e) => e.recurrencerule), { timeout: 10_000 }).toEqual([expect.stringMatching(/BYSETPOS=-1/)]);
  console.log('STORED', JSON.stringify((await stored(request, id))[0]));
  // Next October, same session.
  await page.locator('.e-next').first().click();
  for (let i = 0; i < 11; i++) await page.locator('.e-next').first().click();
  const next = page.locator(`.e-month-view td.e-work-cells[data-date="${new Date(2027, 9, 25).getTime()}"]`);
  await expect(next.locator('.e-appointment', { hasText: 'Board meeting' }), 'Oct 25 2027, no reload').toBeVisible({ timeout: 10_000 });
  await page.reload();
  await page.goto(`/${id}?backend=cf&view=month&date=2027-10-01`);
  await expect(page.locator(`.e-month-view td.e-work-cells[data-date="${new Date(2027, 9, 25).getTime()}"]`).locator('.e-appointment', { hasText: 'Board meeting' }), 'Oct 25 2027 after a reload').toBeVisible({ timeout: 15_000 });
});
