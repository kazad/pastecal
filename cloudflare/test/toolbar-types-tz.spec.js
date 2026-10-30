// @ts-check
/**
 * The type filter in the classic toolbar's empty middle, and the time zone note in the footer line. Neither may
 * move or cover anything: the chips sit in the gap between the date and the view buttons (or give way to one
 * "Types" button), and the note joins the footer's own line. Needs `wrangler dev` on BASE_URL.
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')._vnode.component.proxy`;

async function openDraft(page, { labels = null } = {}) {
  await page.addInitScript(() => { window.__TEST__ = true; });
  await page.goto('/?backend=cf');
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-work-cells'));
  await page.evaluate(({ VM, labels }) => {
    const vm = eval(VM);
    const add = (event) => vm.store().dispatch({ type: 'add', event });
    const at = (d) => new Date(2026, 9, d);
    [[5, 'Morning shift', 1], [6, 'Evening shift', 1], [7, 'Training', 2], [8, 'Board meeting', 3]]
      .forEach(([d, title, type]) => add({ title, start: at(d), end: at(d + 1), isAllDay: true, type }));
    if (labels) vm.calendar.options.typeLabels = labels;
  }, { VM, labels });
  await page.evaluate(() => { scheduleObj.selectedDate = new Date(2026, 9, 14); scheduleObj.currentView = 'Month'; });
  await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Board meeting' })).toBeVisible();
}

const LABELS = ['Shifts', 'Training', 'Meetings', '', '', '', '', ''];
const chips = (page) => page.locator('[data-testid=toolbar-type-filter] .pc-tb-chip');

// The toolbar's three parts don't overlap: the filter (chips or button) lies between the date and the view buttons.
async function noOverlap(page) {
  const r = await page.evaluate(() => {
    const box = (el) => el && el.getBoundingClientRect();
    const items = document.querySelector('#Schedule .e-schedule-toolbar .e-toolbar-items');
    const left = box(items.querySelector('.e-toolbar-left')), right = box(items.querySelector('.e-toolbar-right'));
    const shown = [...items.querySelectorAll('.pc-tb-types .pc-tb-chip')].filter((el) => getComputedStyle(el.closest('.pc-tb-types-row') || el).visibility !== 'hidden' && el.offsetParent);
    return shown.map((el) => box(el)).map((b) => ({ ok: b.left >= left.right && b.right <= right.left }));
  });
  expect(r.length).toBeGreaterThan(0);
  expect(r.every((x) => x.ok)).toBe(true);
}

test('no filter in the toolbar while the types have no names', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDraft(page);
  await expect(page.locator('[data-testid=toolbar-type-filter]')).toHaveCount(0);
  await expect(page.locator('[data-testid=toolbar-type-button]')).toHaveCount(0);
});

test('wide: named types show as chips between the date and the views; one tap shows only that type', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDraft(page, { labels: LABELS });
  await expect(chips(page)).toHaveText(['Shifts', 'Training', 'Meetings']);
  await expect(chips(page).first()).toBeVisible();
  await noOverlap(page);
  await chips(page).filter({ hasText: 'Shifts' }).click();
  await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Board meeting' })).toHaveCount(0);
  await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Morning shift' })).toBeVisible();
  await expect(chips(page).first()).toBeVisible();   // still chips (no extra link pushed them out)
  await chips(page).filter({ hasText: 'Shifts' }).click();   // again: everything
  await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Board meeting' })).toBeVisible();
});

test('narrower: one "Types" button stands in, opening the filter in Search', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openDraft(page, { labels: LABELS });
  const button = page.locator('[data-testid=toolbar-type-button]');
  await expect(button).toBeVisible();
  await expect(chips(page).first()).toBeHidden();
  await noOverlap(page);
  await button.click();
  await expect(page.locator('[data-testid=color-filter]')).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('no toolbar filter on a phone (Search has it)', async ({ page }) => {
    await openDraft(page, { labels: LABELS });
    await expect(page.locator('[data-testid=toolbar-type-button]')).toBeHidden();
    await expect(chips(page).first()).toBeHidden();
  });
});

const newId = () => `test-tznote-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
async function zoned(request) {
  const id = newId();
  const r = await request.post(`/cal/${id}`, { data: { title: 'Team', options: { tz: 'America/Los_Angeles' }, events: [
    { id: 'a', title: 'Standup', start: '2026-10-14T16:00:00.000Z', end: '2026-10-14T16:30:00.000Z', type: 1 },
  ] } });
  expect(r.status()).toBe(201);
  return id;
}

test.describe('time zone note, a visitor in New York', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('says whose time is shown, on the footer line, without moving the calendar', async ({ page, request }) => {
    const id = await zoned(request);
    await page.goto(`/${id}?backend=cf&view=month&date=2026-10-14`);
    const note = page.locator('[data-testid=tz-note]');
    await expect(note).toHaveText('Shown in New York time. This calendar is in Los Angeles, 3 hours behind.');
    // On the same line as the rest of the footer.
    const [a, b] = await Promise.all([note.boundingBox(), page.locator('.pc-edit-footer-brand, .pc-view-footer img').first().boundingBox()]);
    expect(Math.abs((a?.y ?? 0) + (a?.height ?? 0) / 2 - ((b?.y ?? 0) + (b?.height ?? 0) / 2))).toBeLessThan(6);
  });
});

test.describe('time zone note, a visitor in the calendar\'s zone', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('shows no note', async ({ page, request }) => {
    const id = await zoned(request);
    await page.goto(`/${id}?backend=cf&view=month&date=2026-10-14`);
    await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Standup' })).toBeVisible();
    await expect(page.locator('[data-testid=tz-note]')).toHaveCount(0);
  });
});
