// @ts-check
/**
 * Make a copy (Settings), Oct 28 2026: a small dialog instead of a trip to the homepage's draft. The copy's name
 * (pastecal.com/[name], suggested from this one), "Include events", and one button, Make copy: the new calendar is made
 * through the normal create path (the server's name rules and directory) and opens in the same tab. The original is
 * never touched. Classic and ?cal=native; checked against what the server stored (GET /cal/<id>).
 * Screenshots (light, dark, desktop, phone): cloudflare/test-results/copy-dialog/. Run with scripts/test-on-box.sh copy-dialog.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'test-results', 'copy-dialog');
fs.mkdirSync(OUT, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const TZ = 'America/Los_Angeles';
const OPTIONS = { typeLabels: ['Practice', 'Game'], colors: ['#3949ab', '#d81b60'], extended: true, defaultView: 'Week', notes: 'Bring water.', tz: TZ };
const iso = (s) => new Date(s).toISOString();
const row = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
const EVENTS = [
  row('s1', 'Practice', '2026-10-05T17:30:00-07:00', '2026-10-05T19:00:00-07:00', { repeat: 'Weekly', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', recurrenceException: '20261013T003000Z', description: 'Field 3' }),
  row('c1', 'Practice (Tuesday)', '2026-10-13T17:30:00-07:00', '2026-10-13T19:00:00-07:00', { type: 2, recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', recurrenceID: 's1', recurrenceException: '20261013T003000Z' }),
  row(7, 'Trip', '2026-11-01T00:00:00-07:00', '2026-11-04T00:00:00-08:00', { type: 2, isAllDay: true }),
];

let n = 0;
async function seed() {
  const id = `copy-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'U10 Soccer', options: OPTIONS, events: EVENTS }) });
  expect(res.status).toBe(201);
  return id;
}
const calOf = async (id) => { const r = await fetch(`${BASE}/cal/${encodeURIComponent(id)}`); return r.status === 200 ? (await r.json()).calendar : null; };

async function open(browser, id, { native = false, colorScheme = 'light', viewport = { width: 1280, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, timezoneId: TZ, locale: 'en-US', hasTouch: viewport.width < 600 });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${encodeURIComponent(id)}?backend=cf${native ? '&cal=native' : ''}`);
  await loaded(page, native);
  return { ctx, page, errors };
}
async function loaded(page, native) {
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  await expect(page.locator(native ? '.nc' : '.e-schedule .e-work-cells').first()).toBeVisible({ timeout: 20_000 });
}
async function openDialog(page) {
  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.openSideTab('settings'));
  await page.getByTestId('settings-copy-btn').click();
  await expect(page.getByTestId('copy-dialog')).toBeVisible();
  await expect(page.getByTestId('copy-name')).toBeFocused();
}
/** The copy's events matched to the original's: the same fields, their own ids, an edited occurrence on its own series. */
function sameEvents(copy, orig) {
  expect(copy).toHaveLength(orig.length);
  const byTitle = (list, t) => list.find((e) => e.title === t);
  for (const o of orig) {
    const c = byTitle(copy, o.title);
    expect(c, o.title).toBeTruthy();
    const { id: _a, recurrenceID: _b, ...cf } = c; const { id: _c, recurrenceID: _d, ...of } = o;
    expect(cf, o.title).toEqual(of);
    expect(String(c.id), `${o.title}: an id of its own`).not.toBe(String(o.id));
  }
  expect(byTitle(copy, 'Practice (Tuesday)').recurrenceID).toBe(byTitle(copy, 'Practice').id);
}

for (const native of [false, true]) {
  const where = native ? 'native' : 'classic';

  test(`${where}: Make copy with events: a new calendar with the same events (their own), title, colors and labels; it opens here; the original untouched`, async ({ browser }) => {
    const id = await seed();
    const before = await calOf(id);
    const { ctx, page, errors } = await open(browser, id, { native });
    await openDialog(page);
    // Suggested from this calendar's name, free; events included.
    await expect(page.getByTestId('copy-name')).toHaveValue(`${id}-2`);
    await expect(page.getByTestId('copy-events')).toBeChecked();
    await expect(page.getByTestId('copy-dialog').locator('.pc-btn--primary')).toHaveCount(1);
    await expect(page.getByTestId('copy-dialog').locator('.pc-field-prefix')).toHaveText('pastecal.com/');
    if (!native) await page.screenshot({ path: path.join(OUT, 'dialog-desktop-light.png') });
    const name = `${id}-fall`;
    await page.getByTestId('copy-name').fill(name);
    await page.getByTestId('copy-make').click();
    await page.waitForURL((u) => decodeURIComponent(u.pathname) === `/${name}`);
    await loaded(page, native);
    const copy = await calOf(name);
    expect(copy.title).toBe('U10 Soccer');
    expect(copy.options).toMatchObject({ typeLabels: OPTIONS.typeLabels, colors: OPTIONS.colors, extended: true, defaultView: 'Week', notes: 'Bring water.' });
    expect(copy.options.publicViewId).toBeUndefined();
    sameEvents(copy.events, before.events);
    // The page is the copy, and its own: an edit there never reaches the original.
    expect(await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.id)).toBe(name);
    await page.evaluate(() => {
      const p = document.querySelector('#app')._vnode.component.proxy;
      const e = p.calendar.events.find((x) => x.title === 'Trip');
      p.store().dispatch({ type: 'update', key: { id: e.id, recurrenceID: null }, changes: { title: 'Trip (copy only)' } }, { label: 'Renamed' });
    });
    await expect.poll(async () => (await calOf(name)).events.map((e) => e.title).sort()).toContain('Trip (copy only)');
    expect(await calOf(id)).toEqual(before);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test(`${where}: Make copy without events: no events, the same title, colors and labels`, async ({ browser }) => {
    const id = await seed();
    const before = await calOf(id);
    const { ctx, page } = await open(browser, id, { native, colorScheme: 'dark' });
    await openDialog(page);
    await page.getByTestId('copy-events').uncheck();
    if (!native) await page.screenshot({ path: path.join(OUT, 'dialog-desktop-dark.png') });
    const name = `${id}-style`;
    await page.getByTestId('copy-name').fill(name);
    await page.getByTestId('copy-name').press('Enter');   // Enter makes it too
    await page.waitForURL((u) => decodeURIComponent(u.pathname) === `/${name}`);
    const copy = await calOf(name);
    expect(copy.events).toEqual([]);
    expect(copy.title).toBe('U10 Soccer');
    expect(copy.options).toMatchObject({ typeLabels: OPTIONS.typeLabels, colors: OPTIONS.colors });
    expect(await calOf(id)).toEqual(before);
    await ctx.close();
  });

  test(`${where}: a taken name is said in the dialog with free ones to pick; capitals and spaces follow the name rules; twice makes two`, async ({ browser }) => {
    const id = await seed();
    const before = await calOf(id);
    const { ctx, page } = await open(browser, id, { native });
    await openDialog(page);
    // This calendar's own name, typed in capitals: the same name, so taken.
    await page.getByTestId('copy-name').fill(` ${id.toUpperCase()} `);
    await page.getByTestId('copy-make').click();
    await expect(page.getByTestId('copy-taken')).toContainText(`pastecal.com/${id} is taken.`);
    await expect(page.getByTestId('copy-taken').getByRole('button')).not.toHaveCount(0);   // free names to pick
    if (!native) await page.getByTestId('copy-dialog').screenshot({ path: path.join(OUT, 'dialog-taken-light.png') });
    expect(page.url()).toContain(`/${id}`);
    // Typing clears it; capitals and spaces: saved lowercased, spaces kept (CalendarName.newName).
    await page.getByTestId('copy-name').fill(`Spring Team ${id}`);
    await expect(page.getByTestId('copy-taken')).toHaveCount(0);
    await page.getByTestId('copy-make').click();
    const first = `spring team ${id}`;
    await page.waitForURL((u) => decodeURIComponent(u.pathname) === `/${first}`);
    await loaded(page, native);
    expect((await calOf(first)).events).toHaveLength(3);

    // Back to the original, a second copy: a second, independent calendar.
    await page.goto(`/${id}?backend=cf${native ? '&cal=native' : ''}`);
    await loaded(page, native);
    await openDialog(page);
    await page.getByTestId('copy-name').fill(first);
    await page.getByTestId('copy-make').click();
    await expect(page.getByTestId('copy-taken')).toContainText('is taken.');
    const pick = page.getByTestId('copy-taken').getByRole('button').first();
    const second = (await pick.textContent()).trim();
    await pick.click();
    await page.waitForURL((u) => decodeURIComponent(u.pathname) === `/${second}`);
    const [a, b] = [await calOf(first), await calOf(second)];
    expect(b.events).toHaveLength(3);
    expect(b.events.map((e) => String(e.id)).filter((x) => a.events.some((y) => String(y.id) === x)), 'no event shared between the two copies').toEqual([]);
    expect(await calOf(id)).toEqual(before);
    await ctx.close();
  });

  test(`${where}: Cancel by Escape, by the X, and by clicking outside: nothing made`, async ({ browser }) => {
    const id = await seed();
    const { ctx, page } = await open(browser, id, { native });
    await openDialog(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('copy-dialog')).toHaveCount(0);
    await openDialog(page);
    await page.getByTestId('copy-dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('copy-dialog')).toHaveCount(0);
    await openDialog(page);
    await page.mouse.click(10, 10);
    await expect(page.getByTestId('copy-dialog')).toHaveCount(0);
    expect(await calOf(`${id}-2`)).toBe(null);
    expect(page.url()).toContain(`/${id}`);
    await ctx.close();
  });
}

test('phone: the dialog fits and works, light and dark', async ({ browser }) => {
  const id = await seed();
  for (const colorScheme of ['light', 'dark']) {
    const { ctx, page } = await open(browser, id, { colorScheme, viewport: { width: 390, height: 844 } });
    await openDialog(page);
    const box = await page.getByTestId('copy-dialog').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(OUT, `dialog-phone-${colorScheme}.png`) });
    await ctx.close();
  }
});
