// @ts-check
const { test, expect } = require('./fixtures');

/**
 * Editing an event through Syncfusion's OWN editor dialog -- the path a user takes when
 * they click an event and change its time.
 *
 * Why this file exists: every other spec drives events through the app's data layer or the
 * quick popup. Nothing typed into the dialog's Start/End fields and pressed SAVE, so a
 * defect in exactly that flow shipped and was found by hand: the dialog threw
 * "Cannot read properties of undefined (reading 'RecurrenceRule')" inside Syncfusion's
 * processCrudActions, and duplicate events appeared.
 *
 * The cause was identity. Syncfusion's editor does not keep the Id it was handed when it
 * creates an event -- it assigns its own sequential NUMBER from getEventMaxID(). Those ids
 * are per-instance, so they collide after a reload and across calendars, and a later edit
 * could resolve to the wrong record or to none. mergeScheduleRecords now replaces any
 * generated-looking id with a uuid before the record becomes app data.
 */

const VM = `document.querySelector('#app')._vnode.component.proxy`;

async function freshCalendar(page) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  const slug = `test-dialog-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.locator('input[placeholder="your-name"]').fill(slug);
  await page.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}`), { timeout: 15_000 });
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  return slug;
}

const dialog = (page) => page.locator('.e-dialog.e-schedule-dialog');

async function createViaDialog(page, title, nth = 15) {
  await page.locator('.e-work-cells:not(.e-other-month)').nth(nth).dblclick();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('input.e-subject').fill(title);
  await dialog(page).locator('button.e-event-save').click();
  await expect(dialog(page)).toBeHidden();
}

const stored = (page) => page.evaluate(`${VM}.calendar.events.map(e => ({ id: String(e.id), title: e.title, start: e.start }))`);

/** Just the events this test created -- a new calendar also ships with "Sample event". */
const mine = async (page, title) => (await stored(page)).filter(e => e.title === title);

test('an event created through the dialog gets a stable, non-numeric id', async ({ page }) => {
  await freshCalendar(page);
  await createViaDialog(page, 'dialog event');

  await expect.poll(() => mine(page, 'dialog event')).toHaveLength(1);
  const [e] = await mine(page, 'dialog event');
  // A sequential number is Syncfusion's own id, not ours: it collides across calendars
  // and after a reload, which is what broke editing.
  expect(e.id).not.toMatch(/^\d+$/);
  expect(e.id.length).toBeGreaterThan(8);
});

test('changing the time in the dialog saves, without duplicating or crashing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await freshCalendar(page);
  await createViaDialog(page, 'timed event');
  await expect.poll(() => mine(page, 'timed event')).toHaveLength(1);
  const before = (await mine(page, 'timed event'))[0];

  await page.locator('.e-appointment:has-text("timed event")').dblclick();
  await expect(dialog(page)).toBeVisible();
  // A date well away from the cell the event was created on, so "the time changed" is
  // unambiguous rather than coincidentally equal to where it already was.
  await dialog(page).locator('input.e-start').fill('9/23/26 02:00 AM');
  await dialog(page).locator('input.e-end').fill('9/23/26 04:00 AM');
  await dialog(page).locator('button.e-event-save').click();
  await expect(dialog(page)).toBeHidden();

  await page.waitForTimeout(1_500);
  const after = await mine(page, 'timed event');

  expect(errors, `page errors during the edit:\n${errors.join('\n')}`).toEqual([]);
  expect(after, 'the edit must replace the event, not add a second copy').toHaveLength(1);
  expect(after[0].id).toBe(before.id);
  expect(after[0].start).not.toBe(before.start);
});

test('a dialog edit survives a reload', async ({ page }) => {
  await freshCalendar(page);
  await createViaDialog(page, 'persisted event');
  await expect.poll(() => mine(page, 'persisted event')).toHaveLength(1);

  await page.locator('.e-appointment:has-text("persisted event")').dblclick();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('input.e-subject').fill('renamed in dialog');
  await dialog(page).locator('button.e-event-save').click();
  await expect(dialog(page)).toBeHidden();
  await page.waitForTimeout(1_500);

  await page.reload();
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  await expect.poll(() => mine(page, 'renamed in dialog')).toHaveLength(1);
  expect(await mine(page, 'persisted event')).toHaveLength(0);
});

/**
 * The precondition that actually breaks the dialog.
 *
 * A calendar written as a raw Firebase array -- an older client, a hand-repair, an import
 * -- reads back with events keyed by INDEX, so their ids are the numbers 0, 1, 2. Given
 * any numeric id, Syncfusion's editor computes the next one with getEventMaxID() and
 * assigns a NUMBER to the event it creates. That number is per-instance: it collides with
 * an existing row after a reload, and an edit can then resolve to the wrong record or to
 * none, which is the "Cannot read properties of undefined (reading 'RecurrenceRule')"
 * crash seen by hand.
 *
 * Without withStableId() this test stores id 2 and fails.
 */
test('a numeric id from the dialog is replaced before it becomes app data', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await freshCalendar(page);

  // Seed the calendar the way a raw array write leaves it.
  await page.evaluate(`(async () => {
    const vm = ${VM};
    const s = new Date(); s.setDate(s.getDate() + 1); s.setHours(9, 0, 0, 0);
    const e = new Date(s); e.setHours(10);
    await firebase.database().ref('/calendars/' + vm.calendar.id + '/events').set([
      { id: 0, title: 'legacy zero', start: s.toISOString(), end: e.toISOString(), type: 1 },
      { id: 1, title: 'legacy one',  start: s.toISOString(), end: e.toISOString(), type: 1 },
    ]);
  })()`);
  await expect.poll(() => stored(page)).not.toHaveLength(0);

  await createViaDialog(page, 'after legacy');
  await expect.poll(() => mine(page, 'after legacy')).toHaveLength(1);

  const [created] = await mine(page, 'after legacy');
  expect(created.id, 'Syncfusion assigned a sequential number; it must not reach our data')
    .not.toMatch(/^\d+$/);

  // And it survives a reload without colliding with the legacy rows.
  await page.reload();
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  await expect.poll(() => mine(page, 'after legacy')).toHaveLength(1);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});
