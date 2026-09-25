// @ts-check
/**
 * User journeys for NativeCal (/nativecal/<slug>), our own calendar component that is
 * meant to replace Syncfusion. Same rules as journeys.spec.js: drive what is on screen,
 * check what reached the server.
 *
 * NativeCal edits the SAME calendars as the Syncfusion app, so the data it writes must
 * be exactly what Syncfusion writes -- all-day at local midnight with an exclusive end,
 * repeat rules in Syncfusion's "FREQ=...;INTERVAL=1;" form, an edited occurrence as a
 * row with recurrenceID plus a stamp on the series. The compatibility journey opens
 * NativeCal's writes in the Syncfusion app and checks they draw the same.
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
// For waits that can run while a page is navigating, when #app is briefly missing: a
// wait must keep polling then, not throw.
const VM_SAFE = `document.querySelector('#app')?._vnode?.component?.proxy`;
const isPhone = (page) => (page.viewportSize()?.width || 1280) < 768;
const THINK_MS = 250;
const TYPE_DELAY_MS = 25;

async function newCalendar(browser, page, name = 'n') {
  const slug = `test-nc-${name}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  const d = await ctx.newPage();
  await d.goto('/');
  await d.locator('input[placeholder="your-name"]').fill(slug);
  await d.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(d).toHaveURL(new RegExp(`/${slug}`, 'i'), { timeout: 20_000 });
  await d.waitForFunction(`${VM_SAFE}?.isExisting === true`, null, { timeout: 20_000 });
  await ctx.close();
  await openNative(page, slug);
  return slug;
}

async function openNative(page, path) {
  await page.goto('/nativecal/' + path);
  // A /view/ link never sets isExisting; it signals by finishing loading.
  const ready = path.startsWith('view/') ? `${VM}.isLoading === false` : `${VM}.isExisting === true`;
  await page.waitForFunction(`${VM_SAFE} && ${ready}`, null, { timeout: 20_000 });
  await expect(page.locator('[data-testid="month-view-grid"]')).toBeVisible({ timeout: 15_000 });
}

// Minus the "Sample event" every new calendar starts with.
const onServer = (page) => page.evaluate(`(async () => {
  const snap = await firebase.database().ref('/calendars/' + ${VM}.calendar.id + '/events').once('value');
  const v = snap.val() || [];
  return (Array.isArray(v) ? v : Object.values(v)).filter(e => e && e.title !== 'Sample event');
})()`);
const byTitle = async (page, t) => (await onServer(page)).find(e => e.title === t);
/** Wait until the server agrees (writes are async). */
const serverSoon = (page, fn) => expect.poll(async () => fn(await onServer(page)), { timeout: 10_000 }).toBe(true);

const t = (page, id) => page.locator(`[data-testid="${id}"]`);
const bar = (page, title) => page.locator('.nc-bar', { hasText: title }).first();

async function tap(page, locator) {
  await page.waitForTimeout(THINK_MS);
  if (isPhone(page)) await locator.tap();
  else await locator.click();
}

/** The month cell for day `d` of the month on screen, found by the date it stands for. */
async function cell(page, d) {
  const ms = await page.evaluate((day) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), day).getTime(); }, d);
  return page.locator(`.nc-cell[data-day="${ms}"]`);
}
/** Local midnight of day `d` this month, in the BROWSER's timezone (fr runs in Paris). */
const localDay = (page, d, h = 0, m = 0) => page.evaluate(([day, hh, mm]) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), day, hh, mm).getTime(); }, [d, h, m]);

async function quickCreate(page, d, title) {
  const c = await cell(page, d);
  await page.waitForTimeout(THINK_MS);
  if (isPhone(page)) await c.tap({ position: { x: 20, y: 40 } }); else await c.click({ position: { x: 40, y: 60 } });
  await expect(t(page, 'quick-create')).toBeVisible();
  await t(page, 'quick-create-title').pressSequentially(title, { delay: TYPE_DELAY_MS });
  await tap(page, t(page, 'quick-create-save'));
  await expect(t(page, 'quick-create')).toHaveCount(0);
}

async function openNewEditor(page, d) {
  const c = await cell(page, d);
  await page.waitForTimeout(THINK_MS);
  if (isPhone(page)) {
    await c.tap({ position: { x: 20, y: 40 } });
    await tap(page, t(page, 'quick-create-more'));
  } else {
    await c.dblclick({ position: { x: 40, y: 60 } });
  }
  await expect(t(page, 'event-editor')).toBeVisible();
}

async function typeInto(page, id, text) {
  const f = t(page, id);
  await tap(page, f);
  await f.fill('');
  await f.pressSequentially(text, { delay: TYPE_DELAY_MS });
}

async function save(page) {
  await tap(page, t(page, 'editor-save'));
  await expect(t(page, 'event-editor')).toHaveCount(0);
}

async function openPopup(page, title, n = 0) {
  const b = page.locator('.nc-bar', { hasText: title }).nth(n);
  await expect(b).toBeVisible();
  await tap(page, b);
  await expect(t(page, 'event-popover')).toBeVisible();
}

// ---------------------------------------------------------------------------

test('NativeCal: click a day, type a title, save -- an all-day event stored the way Syncfusion stores it', async ({ browser, page }) => {
  await newCalendar(browser, page, 'quick');
  await quickCreate(page, 12, 'Picnic');
  await expect(bar(page, 'Picnic')).toBeVisible();
  await serverSoon(page, (r) => r.some(e => e.title === 'Picnic'));
  const e = await byTitle(page, 'Picnic');
  expect(e.isAllDay).toBe(true);
  expect(new Date(e.start).getTime()).toBe(await localDay(page, 12));
  expect(new Date(e.end).getTime()).toBe(await localDay(page, 13));
});

test('NativeCal: full editor -- title, color, time, description are saved; the popup shows the color', async ({ browser, page }) => {
  await newCalendar(browser, page, 'editor');
  await openNewEditor(page, 14);
  await typeInto(page, 'editor-title', 'Budget review');
  await tap(page, t(page, 'editor-allday'));
  await t(page, 'editor-start-time').fill('14:30');
  await t(page, 'editor-end-time').fill('15:45');
  await tap(page, t(page, 'editor-color'));
  await tap(page, t(page, 'editor-color-3'));
  await typeInto(page, 'editor-description', 'Room 4 & bring Q3 numbers https://example.com/q3');
  await save(page);

  await serverSoon(page, (r) => r.some(e => e.title === 'Budget review'));
  const e = await byTitle(page, 'Budget review');
  expect(Number(e.type)).toBe(3);
  expect(!!e.isAllDay).toBe(false);
  expect(new Date(e.start).getTime()).toBe(await localDay(page, 14, 14, 30));
  expect(new Date(e.end).getTime()).toBe(await localDay(page, 14, 15, 45));
  expect(e.description).toBe('Room 4 & bring Q3 numbers https://example.com/q3');

  await openPopup(page, 'Budget review');
  const header = await t(page, 'popover-header').evaluate(el => getComputedStyle(el).backgroundColor);
  const barColor = await bar(page, 'Budget review').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(header).toBe(barColor);
  await expect(t(page, 'popover-description').locator('a[href="https://example.com/q3"]')).toBeVisible();
});

test('NativeCal: edit an event -- rename, recolor, retime -- and it stays after a reload', async ({ browser, page }) => {
  const slug = await newCalendar(browser, page, 'edit');
  await quickCreate(page, 10, 'Standup');
  await serverSoon(page, (r) => r.some(e => e.title === 'Standup'));
  await openPopup(page, 'Standup');
  await tap(page, t(page, 'popover-edit'));
  await expect(t(page, 'event-editor')).toBeVisible();
  await typeInto(page, 'editor-title', 'Standup (moved)');
  await tap(page, t(page, 'editor-allday'));
  await t(page, 'editor-start-time').fill('09:15');
  await t(page, 'editor-end-time').fill('09:45');
  await tap(page, t(page, 'editor-color'));
  await tap(page, t(page, 'editor-color-4'));
  await save(page);

  await serverSoon(page, (r) => r.some(e => e.title === 'Standup (moved)' && Number(e.type) === 4));
  await openNative(page, slug);
  await expect(bar(page, 'Standup (moved)')).toBeVisible();
  const e = await byTitle(page, 'Standup (moved)');
  expect(new Date(e.start).getTime()).toBe(await localDay(page, 10, 9, 15));
  expect((await onServer(page)).length).toBe(1);
});

test('NativeCal: drag an event to another day and it moves on the server', async ({ browser, page }) => {
  test.skip(isPhone(page), 'drag is a mouse gesture');
  await newCalendar(browser, page, 'drag');
  await quickCreate(page, 8, 'Dragme');
  await serverSoon(page, (r) => r.some(e => e.title === 'Dragme'));
  const from = await bar(page, 'Dragme').boundingBox();
  const to = await (await cell(page, 17)).boundingBox();
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  const want = await localDay(page, 17);
  await serverSoon(page, (r) => r.some(e => e.title === 'Dragme' && new Date(e.start).getTime() === want));
});

test('NativeCal: delete asks first; confirming removes it from the server and nothing else', async ({ browser, page }) => {
  await newCalendar(browser, page, 'delete');
  await quickCreate(page, 9, 'Keep me');
  await quickCreate(page, 11, 'Delete me');
  await serverSoon(page, (r) => r.length === 2);

  await openPopup(page, 'Delete me');
  await tap(page, t(page, 'popover-delete'));
  await expect(t(page, 'confirm-dialog')).toBeVisible();
  await tap(page, t(page, 'confirm-cancel'));
  await page.waitForTimeout(800);
  expect((await onServer(page)).length).toBe(2);

  await openPopup(page, 'Delete me');
  await tap(page, t(page, 'popover-delete'));
  await tap(page, t(page, 'confirm-delete'));
  await serverSoon(page, (r) => r.length === 1 && r[0].title === 'Keep me');
  await expect(bar(page, 'Delete me')).toHaveCount(0);
});

test('NativeCal: a repeating event -- edit one, delete one, then the series -- in Syncfusion\'s format, and Syncfusion draws it the same', async ({ browser, page }) => {
  test.skip(isPhone(page), 'repeat flows covered on desktop');
  const slug = await newCalendar(browser, page, 'repeat');
  // Day 1 of a month is always on the first grid row, so the next three weeks are on screen.
  await openNewEditor(page, 1);
  await typeInto(page, 'editor-title', 'Weekly sync');
  await tap(page, t(page, 'editor-allday'));
  await t(page, 'editor-start-time').fill('09:00');
  await t(page, 'editor-end-time').fill('09:30');
  await t(page, 'editor-repeat').selectOption('WEEKLY');
  await save(page);
  await serverSoon(page, (r) => r.some(e => e.title === 'Weekly sync'));
  const series = await byTitle(page, 'Weekly sync');
  expect(series.recurrencerule).toMatch(/^FREQ=WEEKLY;BYDAY=(SU|MO|TU|WE|TH|FR|SA);INTERVAL=1;$/);
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const second = stamp(await localDay(page, 8, 9)), third = stamp(await localDay(page, 15, 9));

  // Edit only the second occurrence.
  await openPopup(page, 'Weekly sync', 1);
  await tap(page, t(page, 'popover-edit'));
  await tap(page, t(page, 'confirm-edit-occurrence'));
  await expect(t(page, 'editor-repeat')).toHaveCount(0);
  await typeInto(page, 'editor-title', 'Sync (moved)');
  await save(page);
  await serverSoon(page, (r) => r.length === 2);
  let rows = await onServer(page);
  const master = rows.find(e => e.id === series.id), ex = rows.find(e => e.recurrenceID === series.id);
  expect(master.recurrenceException).toBe(second);
  expect(ex.title).toBe('Sync (moved)');
  expect(ex.recurrenceException).toBe(second);
  expect(ex.recurrencerule).toBe(series.recurrencerule);

  // Delete only the third.
  await openPopup(page, 'Weekly sync', 1);
  await tap(page, t(page, 'popover-delete'));
  await tap(page, t(page, 'confirm-delete-occurrence'));
  await serverSoon(page, (r) => (r.find(e => e.id === series.id)?.recurrenceException || '') === `${second},${third}`);

  // Syncfusion draws the same: the moved one once, and the third gone.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  const sf = await ctx.newPage();
  await sf.goto('/' + slug);
  await sf.waitForFunction(`${VM}.isExisting === true`);
  await expect(sf.locator('.e-appointment', { hasText: 'Sync (moved)' })).toHaveCount(1, { timeout: 15_000 });
  const count = async (p, sel) => p.locator(sel, { hasText: 'Weekly sync' }).count();
  expect(await count(sf, '.e-appointment')).toBe(await count(page, '.nc-bar'));
  await ctx.close();

  // Delete the whole series: the edited copy goes with it.
  await openPopup(page, 'Weekly sync', 0);
  await tap(page, t(page, 'popover-delete'));
  await tap(page, t(page, 'confirm-delete-series'));
  await serverSoon(page, (r) => r.length === 0);
});

test('NativeCal: the read-only link shows events and offers no way to change them', async ({ browser, page }) => {
  test.skip(isPhone(page), 'read-only covered on desktop');
  await newCalendar(browser, page, 'ro');
  await quickCreate(page, 12, 'Visible');
  await serverSoon(page, (r) => r.length === 1);
  const ro = await page.evaluate(`${VM}.getReadOnlyURL()`);
  await openNative(page, new URL(ro).pathname.replace(/^\//, ''));
  await openPopup(page, 'Visible');
  await expect(t(page, 'popover-edit')).toHaveCount(0);
  await expect(t(page, 'popover-delete')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await (await cell(page, 20)).dblclick({ position: { x: 40, y: 60 } });
  await page.waitForTimeout(500);
  await expect(t(page, 'event-editor')).toHaveCount(0);
  await expect(t(page, 'quick-create')).toHaveCount(0);
});

test('NativeCal: popups close by clicking away or Escape, and cancelling the editor saves nothing', async ({ browser, page }) => {
  test.skip(isPhone(page), 'Escape and click-away are desktop gestures');
  await newCalendar(browser, page, 'dismiss');
  await quickCreate(page, 12, 'Anchor');
  await serverSoon(page, (r) => r.length === 1);

  await openPopup(page, 'Anchor');
  await page.mouse.click(5, 850);
  await expect(t(page, 'event-popover')).toHaveCount(0);

  await (await cell(page, 20)).click({ position: { x: 40, y: 60 } });
  await expect(t(page, 'quick-create')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(t(page, 'quick-create')).toHaveCount(0);

  await openNewEditor(page, 21);
  await typeInto(page, 'editor-title', 'Never saved');
  await tap(page, t(page, 'editor-cancel'));
  await expect(t(page, 'event-editor')).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect((await onServer(page)).map(e => e.title)).toEqual(['Anchor']);
});

// ---------------------------------------------------------------------------
// v2 (?ux=2): the redesign's new behavior. Same calendars, same data format.
// ---------------------------------------------------------------------------
async function newCalendarV2(browser, page, name) {
  const slug = await newCalendar(browser, page, name);
  await openNative(page, slug + '?ux=2');
  return slug;
}

test('NativeCal v2: drag across the week grid to create an event with that start and end', async ({ browser, page }) => {
  test.skip(isPhone(page), 'drag is a mouse gesture');
  await newCalendarV2(browser, page, 'v2drag');
  await tap(page, t(page, 'view-Week'));
  const col = page.locator('.nc-col').nth(3);
  const bx = await col.boundingBox();
  await page.mouse.move(bx.x + 30, bx.y + 48 * 4 + 2);          // an hour row, four hours down
  await page.mouse.down();
  await page.mouse.move(bx.x + 30, bx.y + 48 * 5.5 + 2, { steps: 10 });   // 90 minutes later
  await expect(t(page, 'create-preview')).toBeVisible();
  await page.mouse.up();
  await expect(t(page, 'quick-create')).toBeVisible();
  await t(page, 'quick-create-title').pressSequentially('Planning', { delay: TYPE_DELAY_MS });
  await tap(page, t(page, 'quick-create-save'));
  await serverSoon(page, (r) => r.some(e => e.title === 'Planning'));
  const e = await byTitle(page, 'Planning');
  const s = new Date(e.start), en = new Date(e.end);
  expect(en - s).toBe(90 * 60000);
  expect(s.getMinutes() % 15).toBe(0);
  expect(!!e.isAllDay).toBe(false);
});

test('NativeCal v2: moving the start moves the end, keeping the length', async ({ browser, page }) => {
  await newCalendarV2(browser, page, 'v2end');
  await openNewEditor(page, 14);
  await tap(page, t(page, 'editor-allday'));
  await t(page, 'editor-start-time').fill('09:00');
  await t(page, 'editor-end-time').fill('10:30');
  await t(page, 'editor-start-time').fill('14:00');
  await expect(t(page, 'editor-end-time')).toHaveValue('15:30');
  await typeInto(page, 'editor-title', 'Moved start');
  await save(page);
  await serverSoon(page, (r) => r.some(e => e.title === 'Moved start'));
  const e = await byTitle(page, 'Moved start');
  expect(new Date(e.start).getTime()).toBe(await localDay(page, 14, 14));
  expect(new Date(e.end).getTime()).toBe(await localDay(page, 14, 15, 30));
});

test('NativeCal v2: delete happens at once and Undo brings the same event back', async ({ browser, page }) => {
  await newCalendarV2(browser, page, 'v2undo');
  await quickCreate(page, 9, 'Keep me');
  await quickCreate(page, 11, 'Oops');
  await serverSoon(page, (r) => r.length === 2);
  const before = await byTitle(page, 'Oops');

  await openPopup(page, 'Oops');
  await tap(page, t(page, 'popover-delete'));
  await expect(t(page, 'confirm-dialog')).toHaveCount(0);
  await expect(t(page, 'undo-snackbar')).toContainText('Oops');
  await serverSoon(page, (r) => r.length === 1 && r[0].title === 'Keep me');

  await tap(page, t(page, 'undo-button'));
  await serverSoon(page, (r) => r.length === 2);
  const back = await byTitle(page, 'Oops');
  expect(back.id).toBe(before.id);
  expect(back.start).toBe(before.start);
  await expect(bar(page, 'Oops')).toBeVisible();
});

test('NativeCal v2: a dragged event can be put back with Undo', async ({ browser, page }) => {
  test.skip(isPhone(page), 'drag is a mouse gesture');
  await newCalendarV2(browser, page, 'v2move');
  await quickCreate(page, 8, 'Dragme');
  await serverSoon(page, (r) => r.some(e => e.title === 'Dragme'));
  const was = (await byTitle(page, 'Dragme')).start;
  const from = await bar(page, 'Dragme').boundingBox();
  const to = await (await cell(page, 17)).boundingBox();
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  const moved = await localDay(page, 17);
  await serverSoon(page, (r) => r.some(e => e.title === 'Dragme' && new Date(e.start).getTime() === moved));
  await tap(page, t(page, 'undo-button'));
  await serverSoon(page, (r) => r.some(e => e.title === 'Dragme' && e.start === was));
});

test('NativeCal v2: "this and following" splits the series the way Syncfusion reads it; deleting following can be undone', async ({ browser, page }) => {
  test.skip(isPhone(page), 'repeat flows covered on desktop');
  const slug = await newCalendarV2(browser, page, 'v2follow');
  await openNewEditor(page, 1);
  await typeInto(page, 'editor-title', 'Weekly sync');
  await tap(page, t(page, 'editor-allday'));
  await t(page, 'editor-start-time').fill('09:00');
  await t(page, 'editor-end-time').fill('09:30');
  await t(page, 'editor-repeat').selectOption('WEEKLY');
  await save(page);
  await serverSoon(page, (r) => r.some(e => e.title === 'Weekly sync'));
  const series = await byTitle(page, 'Weekly sync');

  // Edit the third occurrence "and following".
  await openPopup(page, 'Weekly sync', 2);
  await tap(page, t(page, 'popover-edit'));
  await tap(page, t(page, 'scope-following'));
  await tap(page, t(page, 'confirm-ok'));
  await expect(t(page, 'editor-repeat')).toHaveCount(1);
  await typeInto(page, 'editor-title', 'Sync v2');
  await save(page);
  await serverSoon(page, (r) => r.length === 2 && r.some(e => e.title === 'Sync v2'));
  const rows = await onServer(page);
  const old = rows.find(e => e.id === series.id), next = rows.find(e => e.title === 'Sync v2');
  expect(old.recurrencerule).toMatch(/UNTIL=\d{8}T\d{6}Z/);
  expect(next.recurrencerule).toMatch(/^FREQ=WEEKLY;/);
  expect(new Date(next.start).getTime()).toBe(await localDay(page, 15, 9));
  const nOld = await page.locator('.nc-bar', { hasText: 'Weekly sync' }).count();
  const nNew = await page.locator('.nc-bar', { hasText: 'Sync v2' }).count();
  expect(nOld).toBe(2);

  // Syncfusion draws the same split.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  const sf = await ctx.newPage();
  await sf.goto('/' + slug);
  await sf.waitForFunction(`${VM_SAFE}?.isExisting === true`);
  await expect(sf.locator('.e-appointment', { hasText: 'Weekly sync' })).toHaveCount(nOld, { timeout: 15_000 });
  await expect(sf.locator('.e-appointment', { hasText: 'Sync v2' })).toHaveCount(nNew);
  await ctx.close();

  // Delete the new series from its second occurrence on, then Undo.
  const v2rule = next.recurrencerule;
  await openPopup(page, 'Sync v2', 1);
  await tap(page, t(page, 'popover-delete'));
  await tap(page, t(page, 'scope-following'));
  await tap(page, t(page, 'confirm-ok'));
  await serverSoon(page, (r) => /UNTIL=/.test(r.find(e => e.title === 'Sync v2')?.recurrencerule || ''));
  await tap(page, t(page, 'undo-button'));
  await serverSoon(page, (r) => r.find(e => e.title === 'Sync v2')?.recurrencerule === v2rule);
});
