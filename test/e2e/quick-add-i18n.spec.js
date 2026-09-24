// @ts-check
const { test, expect } = require('./fixtures');

/**
 * The +Event dialog, driven the way a French user drives it: keyboard and mouse only,
 * in a French browser, checked against what actually reaches the server.
 *
 * Issue #32: "Impossible de changer les couleurs lors d'une création de créneaux. De plus
 * pas moyen d'enregistrer lorsque l'on a écrit dans la description."
 *
 * Every earlier test of this dialog passed while it was broken for this user, because
 * they asserted on mechanism -- "the Create button is enabled" -- and never on outcome.
 * The dialog was enabled for "Réunion demain 14h" and saved it at 07:30 the next day:
 * the English parser read "14h" as "14 hours from now". It was disabled, with no reason
 * on screen, for "Réunion avec Paul". And it had no color control at all.
 *
 * So these assert on the saved title, time and color, and go through the UI a person
 * sees -- the +Event button, typed text, the swatches, the Create button.
 */

test.use({ locale: 'fr-FR', timezoneId: 'Europe/Paris' });

const VM = `document.querySelector('#app')._vnode.component.proxy`;

async function freshCalendar(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const slug = `test-qa-fr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.locator('input[placeholder="your-name"]').fill(slug);
  await page.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}`), { timeout: 15_000 });
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  return slug;
}

/** What the server holds, with each start rendered as Paris wall-clock time. */
const onServer = (page) => page.evaluate(`(async () => {
  const snap = await firebase.database().ref('/calendars/' + ${VM}.calendar.id + '/events').once('value');
  const v = snap.val() || [];
  return (Array.isArray(v) ? v : Object.values(v)).filter(Boolean).map(e => ({
    title: e.title, type: e.type,
    time: new Date(e.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }),
  }));
})()`);

async function openQuickAdd(page) {
  await page.locator('text=+Event').locator('visible=true').first().click();
  await expect(page.getByText('Add Event by Typing')).toBeVisible();
}

const create = (page) => page.locator('button[type=submit]:has-text("Create")');

for (const [typed, title, time] of [
  ['Réunion demain 14h', 'Réunion', '14:00'],
  ['Entraînement jeudi 18h', 'Entraînement', '18:00'],
  ['Réunion le 25 septembre à 18h30', 'Réunion', '18:30'],
  ['lunch tomorrow 2pm for 1 hour', 'lunch', '14:00'],
]) {
  test(`"${typed}" is saved at ${time}, with the color picked`, async ({ page }) => {
    await freshCalendar(page);
    await openQuickAdd(page);
    await page.keyboard.type(typed);
    await page.locator('[data-testid="qa-color-3"]').click();
    await create(page).click();

    await expect.poll(async () => (await onServer(page)).find(e => e.title === title), { timeout: 10_000 })
      .toEqual({ title, type: 3, time });
  });
}

test('a description with no date explains itself instead of silently disabling Create', async ({ page }) => {
  await freshCalendar(page);
  await openQuickAdd(page);
  await page.keyboard.type('Réunion avec Paul');

  await expect(create(page)).toBeDisabled();
  await expect(page.locator('[data-testid="qa-needs-date"]')).toBeVisible();

  // Following the instruction on screen is enough to save.
  await page.locator('#qa-start-date').fill('2026-09-30');
  await expect(page.locator('[data-testid="qa-needs-date"]')).toHaveCount(0);
  await create(page).click();
  await expect.poll(async () => (await onServer(page)).map(e => e.title), { timeout: 10_000 })
    .toContain('Réunion avec Paul');
});

test('the full editor saves a chosen color and a typed description, by real clicks', async ({ page }) => {
  // The other creation path in #32. It worked; this keeps it working. Double-click an
  // empty day, pick a color from the dropdown, type in Description, press Save.
  await freshCalendar(page);
  const cell = await page.locator('.e-work-cells').nth(17).boundingBox();
  await page.mouse.dblclick(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await expect(page.locator('.e-schedule-dialog.e-popup-open')).toBeVisible();

  await page.locator('.e-schedule-dialog input[name="Subject"]').click();
  await page.keyboard.type('Créneau éditeur');
  await page.locator('.e-schedule-dialog .custom-field-row-color .e-dropdown-btn').click();
  await page.locator('.e-dropdown-popup.e-popup-open li').nth(3).click();
  await page.locator('.e-schedule-dialog textarea[name="Description"]').click();
  await page.keyboard.type('Une description');
  await page.locator('.e-schedule-dialog .e-event-save').click();

  await expect(page.locator('.e-schedule-dialog.e-popup-open')).toHaveCount(0);
  await expect.poll(async () => (await onServer(page)).find(e => e.title === 'Créneau éditeur'), { timeout: 10_000 })
    .toMatchObject({ type: 4 });
});
