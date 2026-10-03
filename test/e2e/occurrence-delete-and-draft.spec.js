// @ts-check
// Two blockers a tester hit, end to end against the emulators:
//
//  - nativecal: the trash on ONE occurrence of a weekly event deleted the whole series,
//    with no question, no toast and no undo (the click handed over the series, not the
//    occurrence). It now asks which events, deletes only the one, and offers Undo.
//  - an unclaimed /slug: events added there vanished on reload (only the homepage kept a
//    local draft). They now come back, and the header says they are unsaved.
const { test, expect } = require('./fixtures');

test('nativecal: deleting one occurrence keeps the series, and Undo brings it back', async ({ page }) => {
  await page.goto(`/nativecal/occ-${Date.now()}`);
  await expect(page.getByTestId('month-view-grid')).toBeVisible({ timeout: 10000 });

  // A weekly event from the first in-month cell.
  await page.locator('.calendar-cell:not(.opacity-50)').nth(1).click();
  await page.getByTestId('quick-create-more-details').click();
  await page.getByTestId('editor-title').fill('Weekly sync');
  await page.getByTestId('editor-repeat').selectOption('WEEKLY');
  await page.getByTestId('editor-save').click();

  const occurrences = page.locator('[data-testid^="event-"]', { hasText: 'Weekly sync' });
  await expect(occurrences.first()).toBeVisible();
  const before = await occurrences.count();
  expect(before).toBeGreaterThan(2);

  // The popover shows the clicked occurrence's own date, not the series' first one.
  const second = occurrences.nth(1);
  const cellDate = await second.locator('xpath=ancestor::div[@data-date][1]').getAttribute('data-date');
  await second.click();
  const shown = new Date(cellDate || '').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  await expect(page.getByTestId('popover-date')).toHaveText(shown);

  await page.getByTestId('popover-delete').click();
  await page.getByTestId('popover-delete-this').click();

  await expect(page.getByText(/Deleted "Weekly sync" on/)).toBeVisible();
  await expect(occurrences).toHaveCount(before - 1);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(occurrences).toHaveCount(before);
});

test('an unclaimed /slug keeps its events across a reload and says they are unsaved', async ({ page }) => {
  const slug = `draft-${Date.now()}`;
  await page.goto(`/${slug}`);
  await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 15000 });

  await page.getByText('+Event').click();
  await page.locator('#qa-description').fill('Dentist today 3pm');
  await page.keyboard.press('Enter');
  await expect(page.locator('.e-appointment', { hasText: 'Dentist' })).toBeVisible();
  await expect(page.getByTestId('unsaved-badge')).toBeVisible();

  page.on('dialog', (d) => d.accept()); // the beforeunload prompt
  await page.reload();
  await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Restored 1 unsaved event/)).toBeVisible();
  await expect(page.getByTestId('unsaved-badge')).toBeVisible();
});
