// @ts-check
/**
 * Editor instrumentation: every way the editor opens, saves and closes leaves a trace, on the new calendar and on
 * Classic, so "I can't edit" reports can be matched to data (scripts/ux.sh, "Editor funnel").
 *   editor_opened  mode new | edit | series        editor_saved  mode, once per session that changed something
 *   editor_closed  reason saved | cancel | escape | viewed | empty | deleted | replaced | flicker
 *   editor_open_failed  source click | dblclick | pencil   (the person asked for the editor and nothing opened)
 *   js_error carries a trail: the last few events before it.
 * Driven like a person; the analytics calls are recorded by stubbing Analytics.track (as native-editing.spec.js does).
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';
const HOUR = 48;
const iso = (s) => new Date(s).toISOString();
const timed = (id, title, start, end) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1 });

let n = 0;
async function seed(events) {
  const id = `ei-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Instrumented', events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);

async function open(browser, id, cal) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* private mode */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(NOW) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${id}?backend=cf&cal=${cal}&view=week&date=2026-10-21`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 20_000 });
  await expect(cal === 'native' ? page.locator('.nc.nc-editable') : page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__tracked = []; const real = Analytics.track; Analytics.track = function (name, params) { window.__tracked.push({ name, ...params }); return real.apply(this, arguments); }; });
  return { ctx, page, errors };
}
/** The editor's own events, as "name:detail" in the order they fired. */
const seen = (page) => page.evaluate(() => window.__tracked.filter((t) => /^editor_/.test(t.name)).map((t) => `${t.name}:${t.mode ?? t.reason ?? t.source ?? ''}`));
const soon = (fn) => expect.poll(fn, { timeout: 8000, intervals: [100] });

const card = (page) => page.getByTestId('event-card');
async function slot(page, ymd, h) {
  const ms = await page.evaluate((s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }, ymd);
  const col = page.locator(`.nc-col[data-day="${ms}"]`);
  await col.scrollIntoViewIfNeeded();
  const b = await col.boundingBox();
  const first = await page.evaluate(() => parseInt(document.querySelector('.nc-hour-label').textContent, 10) || 5);
  return { x: b.x + b.width / 2, y: b.y + (h - first) * HOUR };
}
const dentist = () => timed('d', 'Dentist', '2026-10-22T11:00:00-07:00', '2026-10-22T12:30:00-07:00');

test('native: opening an event and closing it untouched is opened:edit then closed:viewed, and nothing was saved', async ({ browser }) => {
  const id = await seed([dentist()]);
  const { ctx, page, errors } = await open(browser, id, 'native');
  await page.locator('.nc [data-testid="event-d"]').click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(700);   // a person looking at it: not a flicker
  await page.getByTestId('card-done').click();
  await expect(card(page)).toHaveCount(0);
  expect(await seen(page)).toEqual(['editor_opened:edit', 'editor_closed:viewed']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('native: changing an event is opened:edit, saved:edit, closed:saved, and the server has the change', async ({ browser }) => {
  const id = await seed([dentist()]);
  const { ctx, page } = await open(browser, id, 'native');
  await page.locator('.nc [data-testid="event-d"]').click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByTestId('card-title').fill('Dentist (moved)');
  await page.getByTestId('card-done').click();
  await expect(card(page)).toHaveCount(0);
  await soon(async () => (await stored(id))[0].title).toBe('Dentist (moved)');
  expect(await seen(page)).toEqual(['editor_opened:edit', 'editor_saved:edit', 'editor_closed:saved']);
  await ctx.close();
});

test('native: a new event is opened:new, then saved:new on Done, or closed:escape on Escape, and an empty card clicked away from is closed:empty', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, 'native');
  const at = await slot(page, '2026-10-21', 14);
  await page.mouse.click(at.x, at.y + 6);
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(700);
  await page.keyboard.type('Lunch');
  await page.getByTestId('card-done').click();
  await expect(card(page)).toHaveCount(0);
  await soon(async () => (await stored(id)).map((e) => e.title)).toEqual(['Lunch']);
  expect(await seen(page)).toEqual(['editor_opened:new', 'editor_saved:new', 'editor_closed:saved']);

  await page.evaluate(() => { window.__tracked = []; });
  const at2 = await slot(page, '2026-10-23', 9);
  await page.mouse.click(at2.x, at2.y + 6);
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(700);
  await page.keyboard.type('Never mind');
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  expect(await seen(page)).toEqual(['editor_opened:new', 'editor_abandoned:', 'editor_closed:escape']);

  await page.evaluate(() => { window.__tracked = []; });
  await page.mouse.click(at2.x, at2.y + 6);
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(700);
  const away = await slot(page, '2026-10-19', 16);
  await page.mouse.click(away.x, away.y + 6);   // a click outside with nothing typed drops the draft (Done would save "(No title)")
  await expect(card(page)).toHaveCount(0);
  expect(await seen(page)).toEqual(['editor_opened:new', 'editor_abandoned:', 'editor_closed:empty']);
  await ctx.close();
});

test('native: a card that closes within half a second of opening, unasked, is closed:flicker', async ({ browser }) => {
  const id = await seed([dentist()]);
  const { ctx, page } = await open(browser, id, 'native');
  await page.locator('.nc [data-testid="event-d"]').click();
  await expect(card(page)).toBeVisible();
  // Something else closes it at once (a stray re-render, a scroll handler): no Cancel, no Escape, no Done.
  await page.evaluate(() => { const vm = document.querySelector('#app')._vnode.component.proxy; vm.closeNativeCard(); });
  expect(await seen(page)).toEqual(['editor_opened:edit', 'editor_closed:flicker']);
  await ctx.close();
});

test('native: a click that should open the editor and cannot is editor_open_failed:click', async ({ browser }) => {
  const id = await seed([dentist()]);
  const { ctx, page } = await open(browser, id, 'native');
  await page.evaluate(() => { const vm = document.querySelector('#app')._vnode.component.proxy; vm.nativeStored = () => null; });
  await page.locator('.nc [data-testid="event-d"]').click();
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);
  expect(await seen(page)).toEqual(['editor_open_failed:click']);
  await ctx.close();
});

test('native: ordinary clicks and drags never report a failed open', async ({ browser }) => {
  const id = await seed([dentist()]);
  const { ctx, page } = await open(browser, id, 'native');
  const at = await slot(page, '2026-10-21', 14);
  await page.mouse.click(at.x, at.y + 6);   // an empty slot: a new event, not a failure
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await page.mouse.move(at.x, at.y); await page.mouse.down();   // a drag across empty slots
  for (let i = 1; i <= 8; i++) { await page.mouse.move(at.x, at.y + i * 12); await page.waitForTimeout(15); }
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect((await seen(page)).filter((s) => s.startsWith('editor_open_failed'))).toEqual([]);
  await ctx.close();
});

test('every js_error carries the trail of what came just before it', async ({ browser }) => {
  const id = await seed([dentist()]);
  const { ctx, page } = await open(browser, id, 'native');
  const trail = await page.evaluate(() => {
    Analytics.enabled = true;
    Analytics._trail = [];
    Analytics.remember('editor_opened'); Analytics.remember('editor_saved'); Analytics.remember('page_perf'); Analytics.remember('js_error');
    return Analytics.trail();
  });
  expect(trail).toMatch(/^editor_opened-\ds,editor_saved-\ds$/);   // js_error and page_perf are not part of it
  const six = await page.evaluate(() => { Analytics._trail = []; for (const x of 'abcdefg') Analytics.remember('ev_' + x); return Analytics.trail().split(',').length; });
  expect(six).toBe(5);   // the last five only
  await ctx.close();
});

test('classic: the pencil opens the editor: opened, saved, closed, and no failed-open report', async ({ browser }) => {
  const id = await seed([dentist()]);
  const { ctx, page, errors } = await open(browser, id, 'classic');
  await page.locator('.e-appointment').first().click();
  await page.locator('.e-quick-popup-wrapper .e-edit').click();
  await expect(page.locator('.e-schedule-dialog.e-popup-open')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1200);   // past the open-failed watchdog (900 ms)
  expect((await seen(page)).filter((s) => s.startsWith('editor_open_failed'))).toEqual([]);
  expect(await seen(page)).toEqual(['editor_opened:edit']);
  await page.locator('.e-schedule-dialog .e-event-cancel').click();
  await expect(page.locator('.e-schedule-dialog.e-popup-open')).toHaveCount(0);
  await soon(() => seen(page)).toEqual(['editor_opened:edit', 'editor_abandoned:', 'editor_closed:closed']);
  expect(errors).toEqual([]);
  await ctx.close();
});
