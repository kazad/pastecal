// @ts-check
/**
 * User journeys: the release gate.
 *
 * Every test here does something a real person does -- click, tap, type -- and then
 * checks what actually reached the server (or what a subscriber's calendar app gets),
 * never an internal flag. `deploy.sh` refuses to ship hosting unless these pass.
 *
 * Why this file exists: nine of pastecal's ~30 issues are some form of "my event didn't
 * save" (#2 #9 #10 #11 #40 #41 #42 #43 #44), and #32 shipped in a dialog every test
 * called green. Those tests reached into the app and asserted "Create is enabled" or
 * "the function ran". The user saw an event saved at the wrong time, or not at all.
 * Each journey below is named after the issue it guards.
 *
 * Runs in three browsers (playwright.journeys.config.js): English desktop, French
 * desktop, and a French iPhone. Journeys that only make sense with a mouse (drag,
 * week view) skip on the phone rather than pretend.
 *
 * Rules for adding one: drive it through what is on screen, check the server, and run
 * it against the code BEFORE your fix to see it fail. A journey that cannot fail is
 * decoration.
 */
const base = require('@playwright/test');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => { window.__TEST__ = true; });
    await use(page);
  },
});
const { expect } = base;

const VM = `document.querySelector('#app')._vnode.component.proxy`;
const isPhone = (page) => (page.viewportSize()?.width || 1280) < 768;

// ---------------------------------------------------------------------------
// Setup: a new calendar, made the way people make one (the claim box on a laptop).
// The phone journeys then open that link on the phone -- which is how groups
// actually use pastecal: one person creates, everyone else opens the link.
// ---------------------------------------------------------------------------
async function newCalendar(browser, page, name = 'j') {
  const slug = `test-${name}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  const d = await ctx.newPage();
  await d.goto('/');
  await d.locator('input[placeholder="your-name"]').fill(slug);
  await d.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(d).toHaveURL(new RegExp(`/${slug}`, 'i'), { timeout: 20_000 });
  await d.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 20_000 });
  await ctx.close();
  await openCalendar(page, slug);
  return slug;
}

async function openCalendar(page, slug) {
  await page.goto('/' + slug);
  await page.waitForFunction(`${VM} && ${VM}.isExisting === true`, null, { timeout: 20_000 });
  await expect(page.locator('.e-appointment').first()).toBeVisible({ timeout: 15_000 });
}

/** The events as stored on the server -- the only thing that counts. */
const onServer = (page) => page.evaluate(`(async () => {
  const snap = await firebase.database().ref('/calendars/' + ${VM}.calendar.id + '/events').once('value');
  const v = snap.val() || [];
  return (Array.isArray(v) ? v : Object.values(v)).filter(Boolean);
})()`);
const titles = async (page) => (await onServer(page)).map(e => e.title);
const byTitle = async (page, t) => (await onServer(page)).find(e => e.title === t);

// ---------------------------------------------------------------------------
// Primitive gestures. Each goes through what the user sees.
// ---------------------------------------------------------------------------
// People are not instant. Headless Playwright acts within milliseconds of a dialog
// appearing -- faster than Syncfusion's own open/close animations (~200ms), which made
// journeys fail in ways no person could reproduce (a stray popup that closes by itself
// 200ms later "stole" keystrokes typed 50ms after the editor opened). Pausing like a
// person between gestures keeps these journeys about real use, not a race no human
// can enter.
const THINK_MS = 250;
const TYPE_DELAY_MS = 25;

// A real tap (phone) or click (desktop) at the element's center -- the input events a
// person produces. Playwright first waits until the element is visible, not moving and
// not covered, which is what a person does too: nobody taps a popup mid-slide.
async function tap(page, locator) {
  await page.waitForTimeout(THINK_MS);
  if (isPhone(page)) await locator.tap();
  else await locator.click();
}

/** Open the new-event editor on a day: double-click on desktop, tap twice on a phone. */
async function openNewEventEditor(page, cellIndex) {
  const cell = page.locator('.e-work-cells').nth(cellIndex);
  const b = await cell.boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  if (isPhone(page)) {
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(400);
    await page.touchscreen.tap(x, y);
  } else {
    await page.mouse.dblclick(x, y);
  }
  await expect(page.locator('.e-schedule-dialog.e-popup-open')).toBeVisible();
}

const dialog = (page) => page.locator('.e-schedule-dialog.e-popup-open');

async function typeTitle(page, text) {
  await tap(page, dialog(page).locator('input[name="Subject"]'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
}

/** Pick the n-th color (1-based) from the editor's color dropdown. */
async function pickColor(page, n) {
  await tap(page, dialog(page).locator('.custom-field-row-color .e-dropdown-btn'));
  const item = page.locator('.e-dropdown-popup.e-popup-open li').nth(n - 1);
  await expect(item).toBeVisible();
  await tap(page, item);
}

async function typeDescription(page, text) {
  await tap(page, dialog(page).locator('textarea[name="Description"]'));
  await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
}

/** Press the Save the user sees: a footer button on desktop, a header icon on a phone. */
async function saveEditor(page) {
  const footer = dialog(page).locator('.e-event-save').locator('visible=true');
  if (await footer.count()) await tap(page, footer.first());
  else await tap(page, dialog(page).locator('.e-save-icon').locator('visible=true').first());
  await expect(page.locator('.e-schedule-dialog.e-popup-open')).toHaveCount(0);
}

/** Tap an event on the grid to get its quick popup (Edit / Delete). */
async function tapEvent(page, title) {
  const ev = page.locator('.e-appointment', { hasText: title }).first();
  await expect(ev).toBeVisible();
  await tap(page, ev);
  await expect(page.locator('button.e-edit').locator('visible=true').first()).toBeVisible();
}

async function openEditorFor(page, title) {
  await tapEvent(page, title);
  await tap(page, page.locator('button.e-edit').locator('visible=true').first());
  await expect(dialog(page)).toBeVisible();
}

/** Replace just the time part of a Start/End field, in whatever format it displays. */
async function setTime(page, field, hhmm24) {
  const input = dialog(page).locator(`input[name="${field}"]`);
  const current = await input.inputValue();
  const [h, m] = hhmm24.split(':').map(Number);
  const twelve = /[AP]M/i.test(current);
  const time = twelve
    ? `${String(((h + 11) % 12) + 1).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
    : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const next = current.replace(/\d{1,2}:\d{2}(\s?[AP]M)?/i, time);
  await tap(page, input);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(next, { delay: TYPE_DELAY_MS });
  await page.keyboard.press('Tab');
}

async function uncheckAllDay(page) {
  // Read the tick the user SEES. The hidden input[name=IsAllDay] reports the opposite
  // of what is drawn, so trusting it left events all-day at 00:00.
  const frame = dialog(page).locator('.e-all-day-container .e-frame').first();
  const ticked = await frame.evaluate(e => e.classList.contains('e-check'));
  if (ticked) await tap(page, dialog(page).locator('.e-all-day-container label').first());
  await expect.poll(() => frame.evaluate(e => e.classList.contains('e-check'))).toBe(false);
}

// Local wall-clock of a stored instant, in the browser's own timezone.
const localHM = (page, iso) => page.evaluate((v) => {
  const d = new Date(v); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}, iso);
const localDay = (page, iso) => page.evaluate((v) => new Date(v).getDay(), iso);

async function openQuickAdd(page) {
  if (isPhone(page)) {
    await tap(page, page.getByRole('button', { name: 'Open menu' }));
    await tap(page, page.getByText('Quick Add Event').locator('visible=true').first());
  } else {
    await tap(page, page.locator('text=+Event').locator('visible=true').first());
  }
  await expect(page.getByText('Add Event by Typing')).toBeVisible();
}

// ===========================================================================
// SAVING -- #9 #10 #40 #42 #43 #32: "new events don't save", "can't pick a color"
// ===========================================================================
test('create an event with title, color and description, and it is saved', async ({ browser, page }) => {
  await newCalendar(browser, page, 'create');
  await openNewEventEditor(page, 17);
  await typeTitle(page, 'Team dinner');
  await pickColor(page, 4);
  await typeDescription(page, 'Bring the slides');
  await saveEditor(page);

  await expect.poll(() => byTitle(page, 'Team dinner'), { timeout: 10_000 })
    .toMatchObject({ type: 4, description: 'Bring the slides' });
  await expect(page.locator('.e-appointment', { hasText: 'Team dinner' })).toBeVisible();
});

test('+Event: typed text is saved at the time written, with the color picked (#32)', async ({ browser, page }, info) => {
  await newCalendar(browser, page, 'quickadd');
  const french = /fr/.test(info.project.name);
  const [typed, title, time] = french
    ? ['Réunion demain 14h', 'Réunion', '14:00']
    : ['Lunch tomorrow 2pm for 1 hour', 'Lunch', '14:00'];
  await openQuickAdd(page);
  await page.keyboard.type(typed, { delay: TYPE_DELAY_MS });
  await tap(page, page.locator('[data-testid="qa-color-3"]'));
  await tap(page, page.locator('button[type=submit]:has-text("Create")'));

  await expect.poll(() => byTitle(page, title), { timeout: 10_000 }).toMatchObject({ type: 3 });
  expect(await localHM(page, (await byTitle(page, title)).start)).toBe(time);
});

test('+Event: several events added back to back are all kept (#2)', async ({ browser, page }) => {
  test.skip(isPhone(page), 'covered on desktop; the phone path is the same dialog');
  await newCalendar(browser, page, 'many');
  const names = ['Slot one', 'Slot two', 'Slot three', 'Slot four', 'Slot five'];
  for (const [i, n] of names.entries()) {
    await openQuickAdd(page);
    await page.keyboard.type(`${n} tomorrow at ${9 + i}:00`, { delay: TYPE_DELAY_MS });
    await page.keyboard.press('Enter');
    await expect(page.getByText('Add Event by Typing')).toHaveCount(0);
  }
  await expect.poll(() => titles(page), { timeout: 10_000 }).toEqual(expect.arrayContaining(names));
});

// ===========================================================================
// EDITING -- #11 #41: "can't edit events", "editing the time makes it disappear"
// ===========================================================================
test('edit an event: rename, recolor and change its time, and it stays (#41)', async ({ browser, page }) => {
  await newCalendar(browser, page, 'edit');
  await openNewEventEditor(page, 18);
  await typeTitle(page, 'Standup');
  await uncheckAllDay(page);
  await setTime(page, 'StartTime', '09:00');
  await setTime(page, 'EndTime', '09:30');
  await saveEditor(page);
  await expect.poll(() => byTitle(page, 'Standup'), { timeout: 10_000 }).toBeTruthy();

  await openEditorFor(page, 'Standup');
  await typeTitle(page, 'Standup moved');
  await pickColor(page, 2);
  await setTime(page, 'StartTime', '15:00');
  await setTime(page, 'EndTime', '15:30');
  await saveEditor(page);

  await expect.poll(() => byTitle(page, 'Standup moved'), { timeout: 10_000 }).toMatchObject({ type: 2 });
  const ev = await byTitle(page, 'Standup moved');
  expect(await localHM(page, ev.start)).toBe('15:00');
  expect(await titles(page)).not.toContain('Standup');

  // And it survives a reload: nothing vanished (#41 #44).
  await page.reload();
  await expect(page.locator('.e-appointment', { hasText: 'Standup moved' })).toBeVisible({ timeout: 15_000 });
});

test('drag an event to another day: it moves, and no toast nags about it', async ({ browser, page }) => {
  test.skip(isPhone(page), 'drag is a mouse gesture; phones get tap-to-edit (#1)');
  await newCalendar(browser, page, 'drag');
  await openNewEventEditor(page, 15);
  await typeTitle(page, 'Drag me');
  await saveEditor(page);
  await expect.poll(() => byTitle(page, 'Drag me'), { timeout: 10_000 }).toBeTruthy();
  const before = (await byTitle(page, 'Drag me')).start;

  const ev = await page.locator('.e-appointment', { hasText: 'Drag me' }).first().boundingBox();
  const to = await page.locator('.e-work-cells').nth(23).boundingBox();
  await page.mouse.move(ev.x + ev.width / 2, ev.y + ev.height / 2);
  await page.mouse.down();
  await page.mouse.move(ev.x + ev.width / 2 + 20, ev.y + ev.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();

  await expect.poll(async () => (await byTitle(page, 'Drag me'))?.start, { timeout: 10_000 }).not.toBe(before);
  await expect(page.getByText(/^Edited "Drag me"/)).toHaveCount(0);
});

// ===========================================================================
// DELETING -- #44: "calendar contents disappeared"
// ===========================================================================
test('delete an event, then Undo brings it back; other events untouched', async ({ browser, page }) => {
  await newCalendar(browser, page, 'delete');
  await openNewEventEditor(page, 19);
  await typeTitle(page, 'Delete me');
  await saveEditor(page);
  await expect.poll(() => titles(page), { timeout: 10_000 }).toContain('Delete me');

  await tapEvent(page, 'Delete me');
  await tap(page, page.locator('button.e-delete').locator('visible=true').first());
  // "Are you sure you want to delete this event?" -- wait for it, as a person would.
  const confirm = page.locator('button.e-quick-dialog', { hasText: /delete/i }).locator('visible=true').first();
  await expect(confirm).toBeVisible();
  await tap(page, confirm);

  await expect.poll(() => titles(page), { timeout: 10_000 }).not.toContain('Delete me');
  expect(await titles(page)).toContain('Sample event');

  await tap(page, page.locator('button', { hasText: /^Undo$/ }).locator('visible=true').first());
  await expect.poll(() => titles(page), { timeout: 10_000 }).toContain('Delete me');
});

// ===========================================================================
// RECURRENCE -- #8: "unexpected behavior modifying a repeating series"
// ===========================================================================
test('a weekly event repeats on the same weekday it was created on', async ({ browser, page }) => {
  test.skip(isPhone(page), 'repeat editor differs on phones; covered on desktop');
  await newCalendar(browser, page, 'repeat');
  await openNewEventEditor(page, 15);
  await typeTitle(page, 'Choir practice');
  await tap(page, dialog(page).locator('.e-repeat-element').locator('..'));
  await tap(page, page.locator('.e-popup-open li', { hasText: /^Weekly$/ }).first());
  await saveEditor(page);

  await expect.poll(() => byTitle(page, 'Choir practice'), { timeout: 10_000 }).toBeTruthy();
  const ev = await byTitle(page, 'Choir practice');
  expect(ev.recurrencerule).toMatch(/FREQ=WEEKLY/);
  const shown = page.locator('.e-appointment', { hasText: 'Choir practice' });
  await expect.poll(() => shown.count()).toBeGreaterThanOrEqual(3);
  // Every occurrence sits in the same weekday column as the first.
  const xs = await shown.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x / 10)));
  expect(new Set(xs).size).toBe(1);
});

// ===========================================================================
// TEXT -- #5 #38 #39: special characters, long text, links
// ===========================================================================
test('special characters, long text and links in a description survive and display', async ({ browser, page }) => {
  await newCalendar(browser, page, 'text');
  const desc = 'Café & crème — 50% «ok» 日本 https://example.com/a?b=1 ' + 'long line of notes. '.repeat(40);
  await openNewEventEditor(page, 20);
  await typeTitle(page, 'Notes événement');
  await typeDescription(page, desc);
  await saveEditor(page);

  await expect.poll(async () => (await byTitle(page, 'Notes événement'))?.description, { timeout: 10_000 })
    .toBe(desc);

  await tapEvent(page, 'Notes événement');
  const link = page.locator('a[href="https://example.com/a?b=1"]').locator('visible=true');
  await expect(link).toHaveCount(1);                          // #39: hyperlinked
  // #38: the full text is reachable -- either it fits, or its box scrolls.
  const reachable = await page.evaluate(() => {
    const a = document.querySelector('a[href="https://example.com/a?b=1"]');
    let box = a && a.parentElement;
    while (box && box !== document.body) {
      const s = getComputedStyle(box);
      if (box.scrollHeight > box.clientHeight + 2) return /(auto|scroll)/.test(s.overflowY);
      box = box.parentElement;
    }
    return true;
  });
  expect(reachable).toBe(true);
});

// ===========================================================================
// SETTINGS -- #13 #33: start of week, 12/24h "isn't kept"
// ===========================================================================
test('Monday-first and 24-hour settings stick after a reload', async ({ browser, page }) => {
  test.skip(isPhone(page), 'settings panel covered on desktop');
  const slug = await newCalendar(browser, page, 'settings');
  await tap(page, page.locator('button[aria-label="Settings"]'));
  await page.locator('select').filter({ has: page.locator('option[value="1"]', { hasText: 'Monday' }) }).selectOption('1');
  await page.locator('select').filter({ has: page.locator('option', { hasText: '24-hour' }) }).selectOption('24');
  await page.keyboard.press('Escape');

  await openCalendar(page, slug);
  await expect(page.locator('.e-header-cells').first()).toContainText(/Mon|lun/i);
  await expect.poll(() => page.evaluate(`${VM}.globalSettings.timeFormat`)).toBe('24');
});

// ===========================================================================
// SHARING -- #34 #16: the read-only link shows events and cannot edit
// ===========================================================================
test('the read-only link shows the events and does not let a visitor edit', async ({ browser, page }) => {
  test.skip(isPhone(page), 'read-only view covered on desktop');
  await newCalendar(browser, page, 'readonly');
  await openNewEventEditor(page, 18);
  await typeTitle(page, 'Public event');
  await saveEditor(page);
  await expect.poll(() => titles(page), { timeout: 10_000 }).toContain('Public event');

  const viewUrl = await page.evaluate(`${VM}.getReadOnlyURL()`);
  expect(viewUrl).toContain('/view/');
  const visitor = await (await browser.newContext()).newPage();
  await visitor.addInitScript(() => { window.__TEST__ = true; });
  await visitor.goto(new URL(viewUrl).pathname);
  await expect(visitor.locator('.e-appointment', { hasText: 'Public event' })).toBeVisible({ timeout: 20_000 });

  const cell = await visitor.locator('.e-work-cells').nth(22).boundingBox();
  await visitor.mouse.dblclick(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await visitor.waitForTimeout(800);
  await expect(visitor.locator('.e-schedule-dialog.e-popup-open')).toHaveCount(0);
  // #34: nothing on the visitor's page reveals the editable link.
  const slugPath = new URL(page.url()).pathname;
  await expect.poll(() => visitor.evaluate((p) => document.body.innerText.includes('pastecal.com' + p), slugPath)).toBe(false);
});

// ===========================================================================
// CATEGORIES -- #45
// ===========================================================================
test('add a category in settings; it is offered when coloring and survives reload', async ({ browser, page }) => {
  test.skip(isPhone(page), 'settings panel covered on desktop');
  const slug = await newCalendar(browser, page, 'category');
  await tap(page, page.locator('button[aria-label="Settings"]'));
  await tap(page, page.locator('[data-testid="add-category"]'));
  await page.keyboard.type('Rehearsal', { delay: TYPE_DELAY_MS });
  await page.keyboard.press('Escape');

  await openCalendar(page, slug);
  await openNewEventEditor(page, 18);
  await typeTitle(page, 'Uses category nine');
  await pickColor(page, 9);
  await saveEditor(page);
  await expect.poll(() => byTitle(page, 'Uses category nine'), { timeout: 10_000 }).toMatchObject({ type: 9 });
});

// ===========================================================================
// SUBSCRIBERS -- #3 #5 #31 #36 #37: what Google/Apple/Outlook actually receive.
// The feed is a Cloud Function, so this reads the deployed one (the calendar data is
// the same Firebase database the app under test writes to).
// ===========================================================================
test('the ICS feed serves a capitalized slug with correct all-day dates and text', async ({ browser, page }) => {
  test.skip(isPhone(page), 'feed is device-independent');
  const slug = await newCalendar(browser, page, 'ICS');           // capital letters: #37
  await openNewEventEditor(page, 18);                              // month cell -> all-day: #31
  await typeTitle(page, 'Café & crème');                           // #5
  await saveEditor(page);
  await expect.poll(() => byTitle(page, 'Café & crème'), { timeout: 10_000 }).toBeTruthy();
  const ev = await byTitle(page, 'Café & crème');
  const expectDay = await page.evaluate((v) => {
    const d = new Date(v); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }, ev.start);

  let body = '';
  await expect.poll(async () => {
    const r = await page.request.get(`https://pastecal.com/${slug}.ics`);
    body = r.ok() ? await r.text() : `HTTP ${r.status()}`;
    return body.includes('Café & crème') || body.includes('Café \\& crème');
  }, { timeout: 30_000 }).toBe(true);
  expect(body).not.toMatch(/\\u00e9/);                             // no escaped unicode: #5
  expect(body).toContain(`DTSTART;VALUE=DATE:${expectDay}`);       // the day the user picked: #31
});

// ===========================================================================
// RECURRENCE, CONTINUED -- found in production analytics (sync_refused, Sep 14-24):
// /ahvolunteers, /televedaschedule, /touchpointradio, /h0rch1-m3nz1 -- all calendars
// of repeating events with individually edited occurrences. Editing the WHOLE series
// after one occurrence was changed makes Syncfusion drop that occurrence's record; the
// app never declared that removal, so the write gate refused the save, reverted the
// user's edit and showed "Recovered N events that were about to be lost".
// ===========================================================================
for (const answer of ['Yes', 'No']) {
test(`edit one occurrence of a weekly event, then the whole series ("${answer}" to resetting occurrences): it saves`, async ({ browser, page }) => {
  test.skip(isPhone(page), 'repeat editor differs on phones; covered on desktop');
  await newCalendar(browser, page, 'series');
  const refused = [];
  page.on('console', m => { if (/refused to save/.test(m.text())) refused.push(m.text()); });

  // A weekly event.
  await openNewEventEditor(page, 15);
  await typeTitle(page, 'Rota');
  await tap(page, dialog(page).locator('.e-repeat-element').locator('..'));
  await tap(page, page.locator('.e-popup-open li', { hasText: /^Weekly$/ }).first());
  await saveEditor(page);
  await expect.poll(async () => (await byTitle(page, 'Rota'))?.recurrencerule || '', { timeout: 10_000 }).toMatch(/WEEKLY/);

  // Change ONE occurrence (the second one on screen).
  const occurrence = page.locator('.e-appointment', { hasText: 'Rota' }).nth(1);
  await tap(page, occurrence);
  await tap(page, page.locator('button.e-edit').locator('visible=true').first());
  await tap(page, page.locator('.e-popup-open button', { hasText: /^Edit Event$|^This Event$/i }).first());
  await expect(dialog(page)).toBeVisible();
  await typeTitle(page, 'Rota (swapped)');
  await saveEditor(page);
  await expect.poll(() => titles(page), { timeout: 10_000 }).toContain('Rota (swapped)');

  // Now edit the ENTIRE series from another occurrence.
  await tap(page, page.locator('.e-appointment', { hasText: /^Rota$/ }).first());
  await tap(page, page.locator('button.e-edit').locator('visible=true').first());
  await tap(page, page.locator('.e-popup-open button', { hasText: /Entire Series/i }).first());
  await expect(dialog(page)).toBeVisible();
  await typeTitle(page, 'Weekly rota');
  await tap(page, dialog(page).locator('.e-event-save').locator('visible=true').first());
  // "Do you want to cancel the changes made to specific instances of this series and
  // match it to the whole series again?" -- answered as a user would. "Yes" discards
  // the edited occurrence: the removal the app never declared.
  const reset = page.locator('.e-dialog.e-popup-open button', { hasText: new RegExp(`^${answer}$`, 'i') }).locator('visible=true');
  await expect(reset.first()).toBeVisible();
  await tap(page, reset.first());
  await expect(page.locator('.e-schedule-dialog.e-popup-open')).toHaveCount(0);

  await expect.poll(() => titles(page), { timeout: 10_000 }).toContain('Weekly rota');
  expect(refused, 'the write gate refused an ordinary series edit').toEqual([]);
  await expect(page.getByText(/Recovered \d+ events? that were about to be lost/)).toHaveCount(0);
});
}

// ===========================================================================
// SURVIVING A QUIT -- found by the Sep 24 stress run on live pastecal.com: an event
// created and then the browser quit (or a phone killing the app) within ~0.5s was
// LOST, every time. The save is a transaction that needs a server round trip, and
// the page was gone first. Pending writes are now journaled in localStorage and
// replayed when the calendar next opens.
// ===========================================================================
test('an event survives quitting the browser right after creating it', async ({ page, playwright }, info) => {
  test.skip(info.project.name !== 'desktop-en', 'needs a real on-disk browser profile; one browser is enough');
  const fs = require('fs'), os = require('os'), path = require('path');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-journey-'));
  const baseURL = info.project.use.baseURL;
  const launch = async () => {
    const c = await playwright.chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 900 }, baseURL });
    await c.addInitScript(() => { window.__TEST__ = true; });
    return c;
  };
  try {
    let ctx = await launch();
    let p = ctx.pages()[0] || await ctx.newPage();
    await p.goto('/');
    const slug = `test-quit-${Date.now()}`;
    await p.locator('input[placeholder="your-name"]').fill(slug);
    await p.locator('button:has-text("Claim")').locator('visible=true').first().click();
    await p.waitForFunction(`${VM} && ${VM}.isExisting === true`, null, { timeout: 20_000 });
    await p.waitForTimeout(1500);

    await p.locator('text=+Event').locator('visible=true').first().click();
    await p.keyboard.type('Survives the quit tomorrow at 9:00', { delay: TYPE_DELAY_MS });
    await p.keyboard.press('Enter');
    await ctx.close();                                    // quit, immediately

    ctx = await launch();                                 // come back later, same browser
    p = ctx.pages()[0] || await ctx.newPage();
    await p.goto('/' + slug);
    await p.waitForFunction(`${VM} && ${VM}.isExisting === true`, null, { timeout: 20_000 });
    await expect.poll(async () => (await onServer(p)).map(e => e.title), { timeout: 15_000 })
      .toContain('Survives the quit');
    await ctx.close();
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('+Event: a number that belongs to the title stays in the title', async ({ browser, page }) => {
  // "Shift 2 Friday at 3pm" was saved as "Shift at 3pm" at 02:00 -- the parser took
  // the 2 as the time. Found by the Sep 24 stress run.
  test.skip(isPhone(page), 'same dialog on every device; covered on desktop');
  await newCalendar(browser, page, 'numtitle');
  await openQuickAdd(page);
  await page.keyboard.type('Shift 2 tomorrow at 3pm', { delay: TYPE_DELAY_MS });
  await tap(page, page.locator('button[type=submit]:has-text("Create")'));
  await expect.poll(() => byTitle(page, 'Shift 2'), { timeout: 10_000 }).toBeTruthy();
  expect(await localHM(page, (await byTitle(page, 'Shift 2')).start)).toBe('15:00');
});
