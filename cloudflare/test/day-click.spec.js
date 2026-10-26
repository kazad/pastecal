// @ts-check
/**
 * Two clicks that used to do nothing (Clarity dead clicks, Oct 2026), driven like a person:
 *   1. On a view link, clicking a day opens that day (it did only on the date number).
 *   2. In an event's popup, clicking the date line opens the editor (as the pencil does),
 *      and only where editing is allowed.
 * Plus what must not change: on an edit link a day click still offers a new event, events
 * and "+N more" keep their own popups.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787); seeds its own calendar.
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')?._vnode?.component?.proxy`;

// Events in the month on screen: five on the 10th (folds into "+N more"), one on the 15th.
async function seed(request) {
  const id = `test-dayclick-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const at = (day, h) => { const d = new Date(); d.setDate(day); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const ev = (i, title, day, h) => ({ id: `e${i}`, title, start: at(day, h), end: at(day, h + 1), type: 1 + (i % 5) });
  const weekly = { ...ev(7, 'Choir', 3, 18), recurrencerule: 'FREQ=WEEKLY;COUNT=4' };
  const events = [weekly, ev(1, 'Standup', 10, 9), ev(2, 'Lunch', 10, 12), ev(3, 'Review', 10, 14), ev(4, 'Gym', 10, 17), ev(5, 'Dinner', 10, 19), ev(6, 'Dentist', 15, 11)];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Day click test', options: {}, events } })).status()).toBe(201);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  expect(view.ok).toBe(true);
  return { id, viewId: view.publicViewId };
}

// The Worker allows 10 new calendars a minute per IP, so the view-link tests share one calendar
// (they only read it) and the edit-link test makes its own (it renames an event).
let shared;
const viewOnce = async (request) => (shared = shared || await seed(request));

async function open(browser, path, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600 });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  await page.goto(path);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  await page.waitForTimeout(800);
  return { ctx, page };
}

const state = (page) => page.evaluate(() => ({
  view: scheduleObj.currentView,
  day: scheduleObj.selectedDate.getDate(),
  quick: !!document.querySelector('.e-quick-popup-wrapper.e-popup-open'),
  more: !!document.querySelector('.e-more-popup-wrapper.e-popup-open'),
  editor: !!document.querySelector('.e-schedule-dialog.e-popup-open'),
}));

// A day's cell, and a point in it clear of the date number (top) and the events (stacked from the top).
async function emptySpotIn(page, day) {
  const cell = page.locator(`.e-month-view .e-work-cells[data-date="${await page.evaluate((d) => { const x = new Date(); x.setDate(d); x.setHours(0, 0, 0, 0); return x.getTime(); }, day)}"]`);
  const box = await cell.boundingBox();
  return { cell, x: box.x + box.width - 6, y: box.y + box.height - 6 };
}

test('view link: clicking a day opens that day; events and "+N more" keep their popups; the date line is plain text', async ({ browser, request }) => {
  const { viewId } = await viewOnce(request);
  const { ctx, page } = await open(browser, `/view/${viewId}`);
  expect(await page.evaluate(() => scheduleObj.readonly)).toBe(true);

  // the day says it can be clicked
  const spot = await emptySpotIn(page, 15);
  expect(await spot.cell.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');

  // an event: its popup, and its date line does not open an editor (no editing on a view link)
  await page.locator('.e-appointment', { hasText: 'Dentist' }).click({ force: true });
  await expect(page.locator('.e-quick-popup-wrapper.e-popup-open .e-date-time')).toBeVisible();
  expect(await page.locator('.e-quick-popup-wrapper.e-popup-open .e-date-time').evaluate((el) => getComputedStyle(el).cursor)).not.toBe('pointer');
  await page.locator('.e-quick-popup-wrapper.e-popup-open .e-date-time').click();
  await page.waitForTimeout(500);
  expect((await state(page)).editor).toBe(false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // "+N more": the list of that day's events, not Day view
  await page.locator('.e-more-indicator').first().click();
  await page.waitForTimeout(600);
  expect(await state(page)).toMatchObject({ view: 'Month', more: true });
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(400);

  // the fix: an empty part of the 15th opens the 15th
  const s = await emptySpotIn(page, 15);
  await page.mouse.click(s.x, s.y);
  await expect.poll(() => state(page)).toMatchObject({ view: 'Day', day: 15, quick: false, editor: false });
  await expect(page.locator('.e-appointment', { hasText: 'Dentist' })).toBeVisible();
  await page.screenshot({ path: 'snapshots/dayclick-view-desktop.png' });
  await ctx.close();
});

test('view link: a click that closes an open popup or "+N more" list only closes it', async ({ browser, request }) => {
  const { viewId } = await viewOnce(request);
  const { ctx, page } = await open(browser, `/view/${viewId}`);
  for (const openIt of [
    () => page.locator('.e-appointment', { hasText: 'Dentist' }).click({ force: true }),
    () => page.locator('.e-more-indicator').first().click(),
  ]) {
    await openIt();
    await page.waitForTimeout(600);
    const s = await emptySpotIn(page, 22);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(800);
    expect(await state(page)).toMatchObject({ view: 'Month', more: false });
    // and the next click on a day, with nothing open, opens it
    await page.locator('body').press('Escape');
    if ((await state(page)).quick) await page.locator('.e-quick-popup-wrapper.e-popup-open .e-close').click();
    await page.waitForTimeout(400);
  }
  const s = await emptySpotIn(page, 22);
  await page.mouse.click(s.x, s.y);
  await expect.poll(() => state(page)).toMatchObject({ view: 'Day', day: 22, more: false, quick: false });
  await ctx.close();
});

test('view link on a phone: tapping a day opens that day', async ({ browser, request }) => {
  const { viewId } = await viewOnce(request);
  const { ctx, page } = await open(browser, `/view/${viewId}`, { width: 390, height: 844 });
  const s = await emptySpotIn(page, 15);
  await page.touchscreen.tap(s.x, s.y);
  await expect.poll(() => state(page)).toMatchObject({ view: 'Day', day: 15 });
  await page.waitForTimeout(800);
  await expect(page.locator('.e-day-view, .e-vertical-view').first()).toBeVisible();
  await page.screenshot({ path: 'snapshots/dayclick-view-phone.png' });
  await ctx.close();
});

test('edit link: a day click still offers a new event; the popup date line opens the editor, and nothing is saved by it', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.waitForFunction(`${VM}?.isExisting === true`, null, { timeout: 20_000 });
  expect(await page.evaluate(() => scheduleObj.readonly)).toBe(false);

  // unchanged: an empty day offers a new event and stays in Month
  const s = await emptySpotIn(page, 15);
  await page.mouse.click(s.x, s.y);
  await expect.poll(() => state(page)).toMatchObject({ view: 'Month', quick: true });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // the fix: event popup -> click the date line -> the editor, on that event
  await page.locator('.e-appointment', { hasText: 'Dentist' }).click();
  const when = page.locator('.e-quick-popup-wrapper.e-popup-open .e-date-time');
  await expect(when).toBeVisible();
  expect(await when.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  await expect(when).toHaveAttribute('title', 'Change date or time');
  await page.screenshot({ path: 'snapshots/dayclick-popup-dateline.png' });
  await when.click();
  const editor = page.locator('.e-schedule-dialog.e-popup-open');
  await expect(editor).toBeVisible();
  await expect(editor.locator('input[name="Subject"]')).toHaveValue('Dentist');
  expect((await state(page)).quick, 'the popup closed behind the editor').toBe(false);
  await page.screenshot({ path: 'snapshots/dayclick-editor.png' });

  // closing without saving (Cancel) changes nothing on the server
  await editor.locator('button.e-event-cancel').click();
  await expect(editor).toHaveCount(0);
  const server = (await (await page.request.get(`/cal/${id}`)).json()).calendar;
  const dentist = server.events.find((e) => e.title === 'Dentist');
  expect(new Date(dentist.start).getDate()).toBe(15);
  expect(server.events.length).toBe(7);

  // and a change made in that editor saves like any other
  await page.locator('.e-appointment', { hasText: 'Dentist' }).click();
  await page.locator('.e-quick-popup-wrapper.e-popup-open .e-date-time').click();
  await editor.locator('input[name="Subject"]').fill('Dentist (moved)');
  await editor.locator('button.e-event-save').click();
  await expect.poll(async () => (await (await page.request.get(`/cal/${id}`)).json()).calendar.events.map((e) => e.title)).toContain('Dentist (moved)');
  await ctx.close();
});

test('view link: Week view is unchanged (a click on a time does nothing)', async ({ browser, request }) => {
  const { viewId } = await viewOnce(request);
  const { ctx, page } = await open(browser, `/view/${viewId}`);
  await page.evaluate(() => { const d = new Date(); d.setDate(15); scheduleObj.selectedDate = d; scheduleObj.currentView = 'Week'; });
  await page.waitForTimeout(1000);
  const cell = page.locator('.e-vertical-view .e-work-cells').nth(40);
  await cell.click();
  await page.waitForTimeout(700);
  expect(await state(page)).toMatchObject({ view: 'Week', quick: false, editor: false });
  await ctx.close();
});

test('edit link: on a repeating event the date line does what the pencil does', async ({ browser, request }) => {
  const outcome = async (page, target) => {
    await page.locator('.e-appointment', { hasText: 'Choir' }).locator('visible=true').last().click();
    await page.locator(`.e-quick-popup-wrapper.e-popup-open ${target}`).click();
    await page.waitForTimeout(800);
    const seen = await page.evaluate(() => ({
      ask: [...document.querySelectorAll('.e-quick-dialog.e-popup-open button')].map((b) => b.textContent.trim()).filter(Boolean),
      editor: !!document.querySelector('.e-schedule-dialog.e-popup-open'),
    }));
    // leave it as found, saving nothing: a fresh page
    await page.reload();
    await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
    await page.waitForTimeout(800);
    return seen;
  };
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.waitForFunction(`${VM}?.isExisting === true`, null, { timeout: 20_000 });
  const pencil = await outcome(page, '.e-edit');
  const dateLine = await outcome(page, '.e-date-time');
  expect(pencil.ask.length + (pencil.editor ? 1 : 0), 'the pencil did something').toBeGreaterThan(0);
  expect(dateLine).toEqual(pencil);
  const server = (await (await page.request.get(`/cal/${id}`)).json()).calendar;
  expect(server.events.find((e) => e.title === 'Choir').recurrencerule).toBe('FREQ=WEEKLY;COUNT=4');
  await ctx.close();
});
