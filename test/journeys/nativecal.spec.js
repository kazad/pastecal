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
  await d.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 20_000 });
  await ctx.close();
  await openNative(page, slug);
  return slug;
}

async function openNative(page, path) {
  await page.goto('/nativecal/' + path);
  // A /view/ link never sets isExisting; it signals by finishing loading.
  const ready = path.startsWith('view/') ? `${VM}.isLoading === false` : `${VM}.isExisting === true`;
  await page.waitForFunction(`${VM} && ${ready}`, null, { timeout: 20_000 });
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
