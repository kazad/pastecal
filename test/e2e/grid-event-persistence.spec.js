// @ts-check
const { test, expect } = require('./fixtures');

/**
 * Regression tests for creating/editing/deleting events through the SCHEDULER,
 * and for those changes surviving a reload.
 *
 * The incident these exist for (issues #42/#43, Sept 2026): grid-created events
 * silently vanished for three days. Commit 62d2bd6 changed actionComplete to save
 * `scheduleObj.eventsData || this.syncFusionEvents`, on the belief that eventsData is
 * "what Syncfusion just finished mutating". It is not: updateCalendarView hands the
 * scheduler a *filtered copy* via setProperties, so eventsData stays empty -- and the
 * `||` fallback can never fire, because an empty array is truthy. Every grid create and
 * edit therefore saved an empty event list over the user's real one.
 *
 * Why the existing suite missed it, and what these tests do differently:
 *
 *   1. Every other spec creates events through the Quick Add button, which pushes onto
 *      calendar.events directly. That is the one path that kept working, so a full green
 *      suite coexisted with a totally broken calendar. These tests drive the scheduler's
 *      own dialog -- double-click a cell, type a title, click SAVE -- which is how most
 *      users actually add an event.
 *
 *   2. Nothing in the suite ever reloaded the page. An event that is written to memory
 *      but never persisted looks identical to a working one until you come back. Every
 *      test here reloads and re-asserts, because "saved" is a claim about what is on the
 *      server, not about what is on screen.
 *
 *   3. Each test keeps a second, untouched event on the calendar and asserts it is still
 *      there afterwards. The bug saved an empty array; a test that only checks "my new
 *      event exists" can still pass while every OTHER event is destroyed.
 */

// Reach the Vue component instance. `window.app` is the mounted DOM element, not the
// instance, and app.js keeps its `app` binding script-scoped -- so the component's own
// state is only reachable through the root vnode.
const VM = `document.querySelector('#app')._vnode.component.proxy`;

/** Create a fresh, claimed calendar and return its slug. */
async function freshCalendar(page) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');

  const slug = `test-grid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.locator('input[placeholder="your-name"]').fill(slug);

  // Claim, rather than just navigating to the slug: an unclaimed calendar does not
  // exist server-side, so the app saves to localStorage and never calls sync(). Only a
  // claimed calendar exercises the persistence path these tests are about.
  // Two claim buttons exist for responsive layouts and only one is visible at a
  // given width, so filter on visibility rather than taking the first match.
  await page.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}`), { timeout: 15_000 });
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  return slug;
}

/** Add an event through the scheduler's own dialog: double-click a cell, type, SAVE. */
async function createViaGrid(page, title) {
  await page.locator('.e-work-cells:not(.e-other-month)').nth(16).dblclick();
  const dialog = page.locator('.e-dialog.e-schedule-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input.e-subject').fill(title);
  await dialog.locator('button.e-event-save').click();
  await expect(dialog).toBeHidden();
}

/** Titles currently held in the app's own store. */
function storedTitles(page) {
  return page.evaluate(`${VM}.calendar.events.map(e => e.title)`);
}

/**
 * Titles as they exist ON THE SERVER.
 *
 * The local store updates synchronously but sync() is debounced by 500ms, so reloading
 * straight after an edit races the write: the page can come back showing the pre-edit
 * calendar even when the code is correct. Every assertion about persistence reads the
 * database, and reloads only once the server agrees -- otherwise the test is flaky in
 * exactly the direction that hides the bug it exists to catch.
 */
function serverTitles(page) {
  return page.evaluate(`
    (async () => {
      const id = ${VM}.calendar.id;
      const snap = await firebase.database().ref('/calendars/' + id + '/events').once('value');
      const v = snap.val();
      if (!v) return [];
      return (Array.isArray(v) ? v : Object.values(v)).map(e => e.title);
    })()
  `);
}

test('an event created from the grid survives a reload', async ({ page }) => {
  await freshCalendar(page);
  await createViaGrid(page, 'GRID_CREATED');

  await expect.poll(() => storedTitles(page)).toContain('GRID_CREATED');
  await expect.poll(() => serverTitles(page)).toContain('GRID_CREATED');

  // The assertion that matters: still there after coming back. The bug wrote an
  // empty array, so the event existed on screen and nowhere else.
  await page.reload();
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  await expect.poll(() => storedTitles(page)).toContain('GRID_CREATED');
  await expect(page.locator('.e-appointment:has-text("GRID_CREATED")')).toBeVisible();
});

test('editing an event from the grid persists, and leaves other events alone', async ({ page }) => {
  await freshCalendar(page);
  await createViaGrid(page, 'KEEP_ME');
  await expect.poll(() => storedTitles(page)).toContain('KEEP_ME');

  // A second event on a different day, which this edit must not touch.
  await page.locator('.e-work-cells:not(.e-other-month)').nth(17).dblclick();
  const dialog = page.locator('.e-dialog.e-schedule-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input.e-subject').fill('RENAME_ME');
  await dialog.locator('button.e-event-save').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => storedTitles(page)).toContain('RENAME_ME');

  await page.locator('.e-appointment:has-text("RENAME_ME")').dblclick();
  await expect(dialog).toBeVisible();
  await dialog.locator('input.e-subject').fill('RENAMED');
  await dialog.locator('button.e-event-save').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => serverTitles(page)).toContain('RENAMED');

  await page.reload();
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });

  const titles = await storedTitles(page);
  expect(titles).toContain('RENAMED');
  expect(titles).not.toContain('RENAME_ME');
  // The bug's real damage: everything else on the calendar disappearing.
  expect(titles).toContain('KEEP_ME');
});

test('deleting an event from the grid persists, and leaves other events alone', async ({ page }) => {
  await freshCalendar(page);
  await createViaGrid(page, 'SURVIVOR');
  await expect.poll(() => storedTitles(page)).toContain('SURVIVOR');

  await page.locator('.e-work-cells:not(.e-other-month)').nth(17).dblclick();
  const dialog = page.locator('.e-dialog.e-schedule-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input.e-subject').fill('DELETE_ME');
  await dialog.locator('button.e-event-save').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => storedTitles(page)).toContain('DELETE_ME');

  // Delete through the scheduler's own API rather than its popup. The popup's delete
  // button opens a confirm dialog whose open/close state Syncfusion drives through
  // internal animation flags that do not settle reliably under automation; driving the
  // widget directly keeps this test about what it is meant to cover -- whether a
  // deletion is PERSISTED -- instead of about Syncfusion's popup markup. The create and
  // edit tests above still go through the real dialog, so the user-facing path is
  // covered there.
  await page.evaluate(() => {
    const s = window.scheduleObj;
    const target = s.eventsData.find(e => e.Subject === 'DELETE_ME');
    s.deleteEvent(target);
  });

  // Let the delete reach the SERVER before reloading. Local state clears immediately,
  // so polling it would let the reload race the debounced write.
  await expect.poll(() => serverTitles(page)).not.toContain('DELETE_ME');

  await page.reload();
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });

  const titles = await storedTitles(page);
  expect(titles).not.toContain('DELETE_ME');
  expect(titles).toContain('SURVIVOR');
});
