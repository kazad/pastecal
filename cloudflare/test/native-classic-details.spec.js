// @ts-check
/**
 * Three small things the classic calendar did that the new one now does too (docs/native-gaps.md): a multi-day bar
 * cut by the edge of its week or row shows « (it began before) and » (it goes on); the hours outside 9 to 6 are
 * tinted in the week grid; and one edited occurrence of a repeat carries a crossed-out repeat icon (a plain repeat
 * icon is for the series, and the month grid draws none of those).
 * Needs `wrangler dev` on BASE_URL (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

async function seed(request) {
  const id = `details-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const y = new Date().getFullYear(), m = new Date().getMonth();
  const at = (d, h) => new Date(y, m, d, h).toISOString();
  const second = new Date(y, m, 9, 10);   // the series' 2nd occurrence: the one that was edited
  const events = [
    { id: 'camp', title: 'Long camp', start: new Date(y, m, 3).toISOString(), end: new Date(y, m, 26).toISOString(), isAllDay: true, type: 1 },
    { id: 'wk', title: 'Weekly', start: at(2, 10), end: at(2, 11), type: 2, repeat: 'weekly', recurrencerule: 'FREQ=WEEKLY;INTERVAL=1',
      recurrenceException: stampOf(second) },
    { id: 'wk-edit', title: 'Weekly moved', start: at(9, 14), end: at(9, 15), type: 2, recurrenceID: 'wk' },
  ];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Details', events } })).status()).toBe(201);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  return { viewId: view.publicViewId, week: ymd(new Date(y, m, 12)), edited: ymd(new Date(y, m, 9)), plain: ymd(new Date(y, m, 16)) };
}

async function open(browser, s, view, date = s.week) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.goto(`/view/${s.viewId}?backend=cf&cal=native&view=${view}&date=${date}`);
  await page.waitForFunction(() => document.querySelector('.nc [data-testid^="event-"]'), null, { timeout: 20_000 });
  return { ctx, page };
}

test('a bar cut by the week edge shows « and » in the month and the week', async ({ browser, request }) => {
  const s = await seed(request);
  for (const view of ['month', 'week']) {
    const { ctx, page } = await open(browser, s, view);
    // The camp runs the 3rd to the 25th: in either view it is cut at both ends somewhere on screen.
    await expect(page.getByTestId('bar-continues-right').first()).toBeVisible();
    await expect(page.getByTestId('bar-continues-left').first()).toBeVisible();
    if (view === 'week') {   // the week of the 12th sits inside the camp: cut on both sides of the one bar
      await expect(page.getByTestId('bar-continues-left')).toHaveCount(1);
      await expect(page.getByTestId('bar-continues-right')).toHaveCount(1);
    }
    await ctx.close();
  }
});

for (const view of ['week', 'day']) test(`the ${view} grid tints the hours outside 9 to 6`, async ({ browser, request }) => {
  const s = await seed(request);
  const { ctx, page } = await open(browser, s, view);
  const labels = await page.locator('.nc-hour-label').count();   // the grid may start after midnight
  const first = 24 - labels;
  const off = await page.locator('.nc-col').first().locator('.nc-slot').evaluateAll((els) => els.map((e) => e.classList.contains('off')));
  expect(off.length).toBe(labels);
  off.forEach((v, i) => expect(v, `hour ${first + i}`).toBe(first + i < 9 || first + i >= 18));
  await ctx.close();
});

test('the day view shows « and » on a bar that began before and goes on', async ({ browser, request }) => {
  const s = await seed(request);
  const { ctx, page } = await open(browser, s, 'day');
  await expect(page.getByTestId('bar-continues-left')).toHaveCount(1);
  await expect(page.getByTestId('bar-continues-right')).toHaveCount(1);
  await ctx.close();
});

test('an edited occurrence of a repeat has the crossed repeat icon; the series has the plain one in the week and none in the month', async ({ browser, request }) => {
  const s = await seed(request);
  const edited = await open(browser, s, 'week', s.edited);   // the week of the edited 2nd occurrence: only it
  await expect(edited.page.locator('.nc-recur.nc-edited')).toHaveCount(1);
  await expect(edited.page.locator('.nc-recur:not(.nc-edited)')).toHaveCount(0);
  await edited.ctx.close();
  const plain = await open(browser, s, 'week', s.plain);   // a week with a plain occurrence of the series
  expect(await plain.page.locator('.nc-recur:not(.nc-edited)').count()).toBeGreaterThan(0);
  await expect(plain.page.locator('.nc-recur.nc-edited')).toHaveCount(0);
  await plain.ctx.close();
  const month = await open(browser, s, 'month');
  await expect(month.page.locator('.nc-month .nc-recur.nc-edited')).toHaveCount(1);
  await expect(month.page.locator('.nc-month .nc-recur.nc-edited')).toBeVisible();
  for (const el of await month.page.locator('.nc-month .nc-recur:not(.nc-edited)').all()) await expect(el).toBeHidden();
  await month.ctx.close();
});
