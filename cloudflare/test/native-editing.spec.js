// @ts-check
/**
 * Edit links on pastecal's own calendar (docs/native-switch.md, milestone 2 and the editing prototype), driven like a
 * person and checked against what the SERVER saved (GET /cal/<id>), plus what is on screen. An edit link opened with
 * ?cal=native draws NativeCalendar, edits in the event card (nativecal/components/EventCard.js) and downloads nothing
 * of Syncfusion's. Covered: a new event from a click, a drag (a duration, a run of days) or N, its live "New event"
 * block, a time typed into its title; every field of the card saved as it changes, with Undo, and Cancel / Escape
 * taking back the session; repeat choices and Custom… in classic's rule form; a repeating event's "this event / all
 * events" from the card and from a drag (stored exactly as classic stores them); move, resize, Escape mid-drag, arrow
 * keys; delete and duplicate with Undo; placement at every corner; long details; a phone (the sheet, its pickers,
 * swipe and scrim, hold to drag, hold to create); and a locked calendar and a view link offering no editing.
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const VM = `document.querySelector('#app')._vnode.component.proxy`;
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';   // Saturday Oct 24 2026, Los Angeles
const HOUR = 48;                            // NativeCalendar's hour height
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const iso = (s) => new Date(s).toISOString();
const LABELS = ['Practice', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];

const timed = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });

let n = 0;
async function seed(events, options = {}) {
  const id = `ne-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Native editing', options: { typeLabels: LABELS, ...options }, events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const byTitle = async (id, title) => (await stored(id)).find((e) => e.title === title);
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100] });

/** A browser in Los Angeles at a fixed time; every page error and Syncfusion request is recorded. */
async function open(browser, id, query = '', { phone = false, timezoneId = 'America/Los_Angeles', settings = null } = {}) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId, locale: 'en-US' }
    : { viewport: { width: 1280, height: 900 }, timezoneId, locale: 'en-US' });
  await ctx.addInitScript((g) => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); if (g) localStorage.setItem('pastecal_global_settings', JSON.stringify(g)); } catch (e) { /* blocked */ } }, settings);
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(NOW) });
  const errors = [], syncfusion = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (/\/vendor\/syncfusion/.test(r.url())) syncfusion.push(r.url()); });
  await page.goto(`/${id}?backend=cf&cal=native${query}`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 20_000 });
  await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  // Analytics calls, as the audit records them (test/native-audit/fixes.spec.js).
  await page.evaluate(() => { window.__tracked = []; Analytics.track = function (name, params) { window.__tracked.push({ name, ...this.baseParams(), ...params }); }; });
  return { ctx, page, errors, syncfusion };
}
const tracked = (page) => page.evaluate(() => window.__tracked.filter((t) => ['event_added', 'editor_abandoned', 'feature_used'].includes(t.name))
  .map((t) => `${t.name}${t.add_via ? ':' + t.add_via : ''}${t.feature ? ':' + t.feature : ''}`));

/** Local wall-clock "YYYY-MM-DD HH:MM" of a stored instant, in the browser's zone. */
const local = (page, v) => page.evaluate((x) => { const d = new Date(x); const p = (k) => String(k).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }, v);
const localMidnight = (page, ymd) => page.evaluate((s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toISOString(); }, ymd);
/** The point (page coordinates) at a time of day in a day's column of the time grid. */
async function slot(page, ymd, h) {
  const ms = await page.evaluate((s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }, ymd);
  const col = page.locator(`.nc-col[data-day="${ms}"]`);
  await col.scrollIntoViewIfNeeded();
  const b = await col.boundingBox();
  const first = await page.evaluate(() => parseInt(document.querySelector('.nc-hour-label').textContent, 10) || 5);   // "5:00 AM"
  return { x: b.x + b.width / 2, y: b.y + (h - first) * HOUR };
}
const cell = async (page, ymd) => page.locator(`.nc-cell[data-day="${new Date(await localMidnight(page, ymd)).getTime()}"]`);
async function drag(page, from, to, steps = 10) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await page.waitForTimeout(15); }
}
const ev = (page, id) => page.locator(`.nc [data-testid="event-${id}"]`);
/** The days (YYYY-MM-DD) a bar covers on the month grid. */
const daysOf = (page, testid) => page.evaluate((tid) => {
  const cells = [...document.querySelectorAll('.nc-cell[data-day]')].map((c) => ({ r: c.getBoundingClientRect(), day: Number(c.dataset.day) }));
  const out = new Set();
  for (const bar of document.querySelectorAll(`.nc-month [data-testid="${tid}"]`)) {
    const b = bar.getBoundingClientRect(), cy = b.top + b.height / 2;
    for (const c of cells) if (c.r.top <= cy && cy <= c.r.bottom && c.r.left < b.right - 4 && c.r.right > b.left + 4) {
      const d = new Date(c.day); out.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
  }
  return [...out].sort();
}, testid);
async function pickScope(page, scope) {
  const dlg = page.getByTestId('confirm-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('scope-this')).toBeVisible();
  await expect(dlg.getByTestId('scope-all')).toBeVisible();
  await dlg.getByTestId(`scope-${scope}`).check();
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg.getByTestId('scope-this')).toHaveCount(0);   // (a follow-up question may take its place)
}


// ---- the event card (nativecal/components/EventCard.js) ---------------------------------------------
const card = (page) => page.getByTestId('event-card');
const picker = (page) => page.getByTestId('card-picker');
const toast = (page) => page.locator('.pc-toast');
/** Open a field's picker and type into it ("5p", "fri"), then Enter. */
async function typeInto(page, field, text) {
  await page.getByTestId(field).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByTestId('picker-input').fill(text);
  await picker(page).getByTestId('picker-input').press('Enter');
  await expect(picker(page)).toHaveCount(0);
}
/** Open a field's picker and click one of its options (a CSS selector inside the picker). */
async function choose(page, field, option) {
  await page.getByTestId(field).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).locator(option).first().click();
  await expect(picker(page)).toHaveCount(0);
}
async function openCard(page, locator, full = false) {
  await locator.click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(250);   // past the card's 180 ms entrance
  if (full) { await page.getByTestId('card-more').click(); await expect(page.getByTestId('card-start-date')).toBeVisible(); }
}
const within = (b, w, h, m = 12) => b && b.x >= m - 0.5 && b.y >= m - 0.5 && b.x + b.width <= w - m + 0.5 && b.y + b.height <= h - m + 0.5;

// =====================================================================================================
test('quick add in week view: the card opens on the slot, the live "New event" block follows the title; Enter saves, Escape discards; no Syncfusion', async ({ browser }) => {
  const id = await seed([timed('d', 'Dentist', '2026-10-22T11:00:00-07:00', '2026-10-22T12:30:00-07:00')]);
  const { ctx, page, errors, syncfusion } = await open(browser, id, '&view=week&date=2026-10-21');
  expect(syncfusion, 'no Syncfusion file on a native edit link').toEqual([]);
  expect(await page.evaluate(() => typeof window.ej === 'undefined' && !window.scheduleObj && document.documentElement.dataset.cal === 'native')).toBe(true);

  const at = await slot(page, '2026-10-21', 14);
  await page.mouse.click(at.x, at.y + 6);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveClass(/quick/);
  await expect(page.getByTestId('card-time-line')).toHaveText(/Wed, Oct 21\s*·\s*2 PM\s*–\s*3 PM/);
  await expect(page.getByTestId('card-title')).toBeFocused();
  const block = page.getByTestId('draft-block');
  await expect(block).toHaveText(/New event/);
  const bb = await block.boundingBox();
  expect(Math.abs(bb.y - at.y), 'the block sits on the slot clicked').toBeLessThan(4);
  // The card opens beside the block, never over it.
  const cb = await card(page).boundingBox();
  expect(cb.x >= bb.x + bb.width || cb.x + cb.width <= bb.x, 'beside the event').toBe(true);
  await page.keyboard.type('Lunch with Sam');
  await expect(block).toContainText('Lunch with Sam');
  await page.keyboard.press('Enter');
  await expect(card(page)).toHaveCount(0);
  await expect(block).toHaveCount(0);
  await soon(async () => !!(await byTitle(id, 'Lunch with Sam'))).toBe(true);
  const e = await byTitle(id, 'Lunch with Sam');
  expect([await local(page, e.start), await local(page, e.end), !!e.isAllDay, e.type]).toEqual(['2026-10-21 14:00', '2026-10-21 15:00', false, 1]);
  expect(e.start).toMatch(ISO);
  await expect(toast(page)).toContainText('Added Lunch with Sam');
  await expect(page.locator('.nc-timed', { hasText: 'Lunch with Sam' })).toBeVisible();

  // Escape is Cancel: the new event is dropped, nothing stored.
  const at2 = await slot(page, '2026-10-23', 9);
  await page.mouse.click(at2.x, at2.y + 6);
  await expect(card(page)).toBeVisible();
  await page.keyboard.type('Never mind');
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(block).toHaveCount(0);
  // And a click outside with no title drops it too; the first click outside only closes the card.
  await page.mouse.click(at2.x, at2.y + 6);
  await expect(card(page)).toBeVisible();
  const away = await slot(page, '2026-10-19', 16);
  await page.mouse.click(away.x, away.y + 6);
  await expect(card(page)).toHaveCount(0);
  await expect(block).toHaveCount(0);
  await page.waitForTimeout(800);
  expect((await stored(id)).map((x) => x.title).sort()).toEqual(['Dentist', 'Lunch with Sam']);
  // Analytics as classic sends them: one add, and a new event closed without adding is "abandoned" (twice here).
  expect(await tracked(page)).toEqual(['event_added:grid', 'editor_abandoned', 'editor_abandoned']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a time typed in a new title moves the event live; the words go on save; Undo puts back the title and time; "Room 5" is a title', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-27');
  const at = await slot(page, '2026-10-27', 9);
  await page.mouse.click(at.x, at.y + 6);
  await expect(page.getByTestId('card-title')).toBeFocused();
  const line = page.getByTestId('card-time-line');
  await page.keyboard.type('Practice Thu 5-6');
  await expect(line).toHaveText(/Thu, Oct 29\s*·\s*5 PM\s*–\s*6 PM/);
  await expect(line).toHaveClass(/hit/);
  await expect(page.locator('#nk-said')).toHaveText(/Time set: Thu, Oct 29 · 5 PM – 6 PM/);
  const thu = await page.evaluate(() => new Date(2026, 9, 29).getTime());
  await expect(page.locator(`.nc-col[data-day="${thu}"] [data-testid="draft-block"]`)).toBeVisible();
  // Deleting the words puts the time back.
  for (let i = 0; i < ' Thu 5-6'.length; i++) await page.keyboard.press('Backspace');
  await expect(line).toHaveText(/Tue, Oct 27\s*·\s*9 AM\s*–\s*10 AM/);
  await expect(line).not.toHaveClass(/hit/);
  await page.keyboard.type(' Thu 5-6');
  await page.getByTestId('card-done').click();
  await soon(async () => (await stored(id)).length).toBe(1);
  let [e] = await stored(id);
  expect([e.title, await local(page, e.start), await local(page, e.end)]).toEqual(['Practice', '2026-10-29 17:00', '2026-10-29 18:00']);
  await expect(toast(page)).toContainText('Added Practice · Thu 5 – 6 PM');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await soon(async () => (await stored(id))[0].title).toBe('Practice Thu 5-6');
  [e] = await stored(id);
  expect([await local(page, e.start), await local(page, e.end)]).toEqual(['2026-10-27 09:00', '2026-10-27 10:00']);
  await expect(toast(page)).toContainText('Undone');

  // Titles that only look like times stay titles.
  for (const t of ['Room 5', 'Grades 3-5', 'Monica']) {
    const noon = await slot(page, "2026-10-27", 12);
    await page.mouse.click(noon.x, noon.y + 6);
    await expect(page.getByTestId('card-title')).toBeFocused();
    await page.keyboard.type(t);
    await expect(line, t).toHaveText(/Tue, Oct 27\s*·\s*12 PM\s*–\s*1 PM/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('card-title')).toHaveCount(0);   // closed before the next click (under load a click on the closing card opened nothing)
  }
  expect(errors).toEqual([]);
  await ctx.close();
});

test('month view: a click adds an all-day event; dragging across days adds a multi-day one (stored as classic stores them)', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-15');
  const c13 = await cell(page, '2026-10-13');
  await c13.click({ position: { x: 60, y: 70 } });
  await expect(page.getByTestId('card-time-line')).toHaveText(/Tue, Oct 13\s*·\s*All day/);
  expect(await daysOf(page, 'draft-block')).toEqual(['2026-10-13']);
  await page.keyboard.type('Picture day');
  await page.getByTestId('card-done').click();
  await soon(async () => !!(await byTitle(id, 'Picture day'))).toBe(true);
  const one = await byTitle(id, 'Picture day');
  expect([one.isAllDay, one.start, one.end]).toEqual([true, await localMidnight(page, '2026-10-13'), await localMidnight(page, '2026-10-14')]);

  const a = await (await cell(page, '2026-10-14')).boundingBox(), b = await (await cell(page, '2026-10-16')).boundingBox();
  await drag(page, { x: a.x + a.width / 2, y: a.y + a.height - 12 }, { x: b.x + b.width / 2, y: b.y + b.height - 12 });
  await expect(page.locator('.nc-cell.creating')).toHaveCount(3);
  await page.mouse.up();
  await expect(page.getByTestId('card-time-line')).toHaveText(/Wed, Oct 14\s*–\s*Fri, Oct 16\s*·\s*All day/);
  expect(await daysOf(page, 'draft-block')).toEqual(['2026-10-14', '2026-10-15', '2026-10-16']);
  await page.keyboard.type('Book fair');
  await page.keyboard.press('Enter');
  await soon(async () => !!(await byTitle(id, 'Book fair'))).toBe(true);
  const fair = await byTitle(id, 'Book fair');
  expect([fair.isAllDay, fair.start, fair.end]).toEqual([true, await localMidnight(page, '2026-10-14'), await localMidnight(page, '2026-10-17')]);
  expect(await daysOf(page, 'event-' + fair.id)).toEqual(['2026-10-14', '2026-10-15', '2026-10-16']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('week view: drag on empty time to create an event with that duration; N opens a new event', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const from = await slot(page, '2026-10-22', 9), to = await slot(page, '2026-10-22', 11.5);
  await drag(page, { x: from.x, y: from.y + 2 }, to);
  await expect(page.getByTestId('create-preview')).toHaveText('9:00 AM - 11:30 AM');
  await page.mouse.up();
  await expect(page.getByTestId('card-time-line')).toHaveText(/9 AM\s*–\s*11:30 AM/);
  const block = await page.getByTestId('draft-block').boundingBox();
  expect(Math.round(block.height / HOUR * 2) / 2).toBe(2.5);
  await page.keyboard.type('Workshop');
  await page.keyboard.press('Enter');
  await soon(async () => !!(await byTitle(id, 'Workshop'))).toBe(true);
  const e = await byTitle(id, 'Workshop');
  expect([await local(page, e.start), await local(page, e.end)]).toEqual(['2026-10-22 09:00', '2026-10-22 11:30']);

  // N: a new event at the next hour today, the title ready to type.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('n');
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId('card-title')).toBeFocused();
  await expect(page.getByTestId('card-time-line')).toHaveText(/Sat, Oct 24\s*·\s*1 PM\s*–\s*2 PM/);
  await page.keyboard.type('Pizza');
  await page.keyboard.press('Enter');
  await soon(async () => !!(await byTitle(id, 'Pizza'))).toBe(true);
  expect(await local(page, (await byTitle(id, 'Pizza')).start)).toBe('2026-10-24 13:00');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('the card edits as you go: title, time (clicked and typed), type, details, length, all day, multi-day; each saved with Undo; Cancel takes it all back', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'Lincoln Field' })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const row = async () => (await stored(id))[0];
  await openCard(page, ev(page, 'p'));
  await expect(page.getByTestId('card-details-preview')).toHaveText('Lincoln Field');

  // Title: saved when it loses focus (Enter), with a toast and Undo.
  await page.getByTestId('card-title').fill('Practice (home)');
  await page.getByTestId('card-title').press('Enter');
  await soon(async () => (await row()).title).toBe('Practice (home)');
  await expect(toast(page)).toContainText('Renamed Practice (home)');
  // Start time from the quick line, typed: "5:30p" keeps the length.
  await typeInto(page, 'card-q-s', '5:30p');
  await soon(async () => local(page, (await row()).start)).toBe('2026-10-22 17:30');
  expect(await local(page, (await row()).end)).toBe('2026-10-22 18:30');
  await expect(toast(page)).toContainText('Starts 5:30 PM');
  // End time clicked in the list.
  await choose(page, 'card-q-e', '[data-m="1140"]');
  await soon(async () => local(page, (await row()).end)).toBe('2026-10-22 19:00');
  // Undo: the end goes back (on the server), the card follows.
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await soon(async () => local(page, (await row()).end)).toBe('2026-10-22 18:30');
  await expect(page.getByTestId('card-q-e')).toHaveText('6:30 PM');
  await expect(toast(page)).toHaveText(/Undone/);
  await expect(toast(page).getByRole('button', { name: 'Undo' })).toHaveCount(0);

  // The full card: type, length, details.
  await page.getByTestId('card-more').click();
  await expect(page.getByTestId('card-start-date')).toHaveText('Thu, Oct 22');
  await expect(page.getByTestId('card-end-date')).toHaveClass(/same/);
  await expect(page.getByTestId('card-repeat')).toHaveAttribute('aria-label', "Repeats: Doesn't repeat");
  await expect(page.getByTestId('card-allday')).toHaveAttribute('role', 'switch');
  await choose(page, 'card-type', '[data-t="2"]');
  await soon(async () => (await row()).type).toBe(2);
  await expect(page.getByTestId('card-type')).toHaveAttribute('aria-label', 'Type: Game');
  await choose(page, 'card-length', '[data-len="90"]');
  await soon(async () => local(page, (await row()).end)).toBe('2026-10-22 19:00');
  await expect(page.getByTestId('card-length')).toHaveAttribute('aria-label', 'Length: 1h 30m');
  await page.getByTestId('card-details').fill('Lincoln Field, bring water');
  await page.getByTestId('card-title').click();
  await soon(async () => (await row()).description).toBe('Lincoln Field, bring water');

  // Monday 9 AM to Friday 5 PM: the start date "mon" (moves the event), the end date "fri", the end time.
  await typeInto(page, 'card-start-date', '10/19');
  await soon(async () => local(page, (await row()).start)).toBe('2026-10-19 17:30');
  await typeInto(page, 'card-start-time', '9a');
  await choose(page, 'card-end-date', '[data-d="2026-10-23"]');
  await typeInto(page, 'card-end-time', '5p');
  await soon(async () => [await local(page, (await row()).start), await local(page, (await row()).end)]).toEqual(['2026-10-19 09:00', '2026-10-23 17:00']);
  await expect(page.getByTestId('card-length')).toHaveText(/4 days 8h/);
  expect((await row()).isAllDay).toBe(false);

  // All day on: the dates, stored as classic stores them; off again: the times come back.
  await page.getByTestId('card-allday').click();
  await soon(async () => (await row()).isAllDay).toBe(true);
  expect([(await row()).start, (await row()).end]).toEqual([await localMidnight(page, '2026-10-19'), await localMidnight(page, '2026-10-24')]);
  await page.getByTestId('card-allday').click();
  await soon(async () => (await row()).isAllDay).toBe(false);
  expect([await local(page, (await row()).start), await local(page, (await row()).end)]).toEqual(['2026-10-19 09:00', '2026-10-23 17:00']);

  // Cancel: everything since the card opened is taken back, on the server; no Undo is offered for it.
  await page.getByTestId('card-cancel').click();
  await expect(card(page)).toHaveCount(0);
  await soon(async () => { const r = await row(); return [r.title, r.type, r.description, !!r.isAllDay, await local(page, r.start), await local(page, r.end)]; })
    .toEqual(['Practice', 1, 'Lincoln Field', false, '2026-10-22 17:00', '2026-10-22 18:00']);
  await expect(toast(page)).toContainText('Changes undone');
  await expect(toast(page).getByRole('button', { name: 'Undo' })).toHaveCount(0);
  expect(await tracked(page), 'a type change is reported; editing an existing event is never "abandoned"').toEqual(['feature_used:event_type']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('repeat: the one-tap choices and Custom… store classic\'s rule form; a single occurrence offers no repeat', async ({ browser }) => {
  const id = await seed([timed('b', 'Board meeting', '2026-10-13T18:30:00-07:00', '2026-10-13T20:00:00-07:00', { type: 3 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-15');
  const rule = async () => (await stored(id)).find((e) => e.id === 'b').recurrencerule || '';
  const bar = () => page.locator('.nc-bar', { hasText: 'Board meeting' }).first();
  await openCard(page, bar(), true);
  await choose(page, 'card-repeat', '[data-r="week"]');
  await soon(rule).toBe('FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;');
  await expect(page.getByTestId('card-repeat')).toHaveText(/Every Tuesday/);
  await choose(page, 'card-repeat', '[data-r="month"]');
  await soon(rule).toBe('FREQ=MONTHLY;BYMONTHDAY=13;INTERVAL=1;');
  await expect(page.getByTestId('card-repeat')).toHaveText(/Monthly on the 13th/);
  // Custom: the 2nd Tuesday of each month until Mar 31 2027.
  await page.getByTestId('card-repeat').click();
  await picker(page).getByTestId('picker-custom').click();
  await picker(page).getByTestId('custom-unit').selectOption('MONTHLY');
  await picker(page).getByTestId('custom-by-weekday').check();
  await expect(picker(page).getByTestId('custom-setpos')).toHaveValue('2');
  await picker(page).getByTestId('custom-end-until').check();
  await picker(page).getByTestId('custom-until').fill('2027-03-31');
  await picker(page).getByTestId('custom-apply').click();
  const until = await page.evaluate(() => new Date(2027, 2, 31).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));   // classic's form: the date's local midnight
  await soon(rule).toBe(`FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;INTERVAL=1;UNTIL=${until};`);
  await expect(page.getByTestId('card-repeat')).toHaveText(/Monthly on the second Tuesday, until Mar 31/);
  // A daily repeat with a count, then none. Each change asks nothing (the card is the whole series).
  await page.getByTestId('card-repeat').click();
  await picker(page).getByTestId('picker-custom').click();
  await picker(page).getByTestId('custom-unit').selectOption('DAILY');
  await picker(page).getByTestId('custom-interval').fill('2');
  await picker(page).getByTestId('custom-end-count').check();
  await picker(page).getByTestId('custom-count').fill('5');
  await picker(page).getByTestId('custom-apply').click();
  await soon(rule).toBe('FREQ=DAILY;INTERVAL=2;COUNT=5;');
  await page.getByTestId('card-done').click();
  // One occurrence (Oct 15), its own row after "this event": no repeat control.
  await openCard(page, page.locator('.nc-bar', { hasText: 'Board meeting' }).nth(1), true);
  await expect(page.getByTestId('card-repeat')).toBeVisible();
  await page.getByTestId('card-details').fill('Room 2');
  await page.getByTestId('card-title').click();
  await pickScope(page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  await expect(page.getByTestId('card-repeat')).toHaveCount(0);
  // Back on the series (Oct 13): no repeat at all. It has an edited occurrence now, so classic's question comes first.
  await page.getByTestId('card-done').click();
  await openCard(page, page.locator('.nc-bar', { hasText: 'Board meeting' }).first(), true);
  await choose(page, 'card-repeat', '[data-r="none"]');
  await expect(page.getByTestId('confirm-dialog')).toContainText('match it to the whole series again?');
  await page.getByTestId('confirm-yes').click();
  await soon(rule).toBe('');
  expect((await stored(id)).length, '"Yes" clears the edited occurrence, as classic does').toBe(1);
  expect(errors).toEqual([]);
  await ctx.close();
});

// Everything classic's repeat editor (Syncfusion 23.2.6) offers, from the card's Custom…, stored in the characters classic
// writes (read from classic itself: test/unit/native-card-kit.test.js); and rules classic wrote open in the card, read
// right, and stay exactly as they were when nothing about the repeat changes. rrule.js (what the native calendar draws
// with) says when they happen.
test('repeat parity with classic: yearly on the last Monday of October, weekly on chosen days in the week\'s order until a date, monthly on a day N times, yearly on a date; classic\'s rules open and keep their characters', async ({ browser }) => {
  const id = await seed([
    timed('p', 'Fall party', '2026-10-15T17:00:00-07:00', '2026-10-15T18:00:00-07:00'),
    timed('h', 'Harvest', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { recurrencerule: 'FREQ=WEEKLY;BYDAY=MO,WE,TH,FR,SU;INTERVAL=2;UNTIL=20261231T080000Z;' }),
    timed('k', 'Pumpkins', '2026-10-26T12:00:00-07:00', '2026-10-26T13:00:00-07:00', { recurrencerule: 'FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;' }),
  ]);
  const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-15', { settings: { firstDayOfWeek: '1' } });   // weeks start on Monday
  const rule = async (eid) => (await stored(id)).find((e) => e.id === eid).recurrencerule || '';
  const custom = async () => { await page.getByTestId('card-repeat').click(); await picker(page).getByTestId('picker-custom').click(); await expect(picker(page).getByTestId('custom-apply')).toBeVisible(); };
  const P = () => picker(page);
  await openCard(page, page.locator('.nc-bar', { hasText: 'Fall party' }).first(), true);
  // Yearly on the last Monday of October.
  await custom();
  await P().getByTestId('custom-unit').selectOption('YEARLY');
  await P().getByTestId('custom-by-weekday').check();
  await P().getByTestId('custom-setpos').selectOption('-1');
  await P().getByTestId('custom-posday').selectOption('1');
  await P().getByTestId('custom-month').selectOption('10');
  await P().getByTestId('custom-apply').click();
  await soon(() => rule('p')).toBe('FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;');
  await expect(page.getByTestId('card-repeat')).toHaveText(/Yearly on the last Monday of October/);
  const next = await page.evaluate((r) => rrule.rrulestr(r, { dtstart: new Date(Date.UTC(2026, 9, 15, 17)) }).all((d, i) => i < 3).map((d) => d.toISOString().slice(0, 10)), (await rule('p')).replace(/;$/, ''));
  expect(next, 'rrule.js: the last Monday of each October').toEqual(['2026-10-26', '2027-10-25', '2028-10-30']);
  // Weekly every 2 weeks on Mon, Wed, Thu, Sun until Dec 31: the day buttons start on Monday and BYDAY follows them.
  await custom();
  await P().getByTestId('custom-unit').selectOption('WEEKLY');
  expect(await P().locator('.nk-wd button').allInnerTexts()).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  await P().getByTestId('custom-interval').fill('2');
  for (const d of [1, 3, 0]) await P().getByTestId(`custom-day-${d}`).click();   // Thursday (the event's day) is on already
  await P().getByTestId('custom-end-until').check();
  await P().getByTestId('custom-until').fill('2026-12-24');
  await P().getByTestId('custom-apply').click();
  const dec24 = await page.evaluate(() => new Date(2026, 11, 24).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));
  expect(dec24).toBe('20261224T080000Z');
  await soon(() => rule('p')).toBe(`FREQ=WEEKLY;BYDAY=MO,WE,TH,SU;INTERVAL=2;UNTIL=${dec24};`);
  await expect(page.getByTestId('card-repeat')).toHaveText(/Every 2 weeks on Sun, Mon, Wed, Thu, until Dec 24/);
  // UNTIL is classic's local midnight, and the series still runs through that day: the 5 PM Thursday on Dec 24 is drawn
  // (both calendars read UNTIL through the end of its day; rrule.js alone, by instant, would stop at midnight).
  const dec = await ctx.newPage();
  await dec.clock.install({ time: new Date(NOW) });
  await dec.goto(`/${id}?backend=cf&cal=native&view=month&date=2026-12-15`);
  await expect(dec.locator('.nc-bar', { hasText: 'Fall party' }).first()).toBeVisible({ timeout: 15_000 });
  const thursdays = (await daysOf(dec, 'event-p')).filter((d) => new Date(`${d}T12:00`).getDay() === 4);
  expect(thursdays, 'every other Thursday through Dec 24, the UNTIL date itself included').toEqual(['2026-12-10', '2026-12-24']);
  await dec.close();
  // Monthly on day 15, 3 times; then yearly on October 15.
  await custom();
  await P().getByTestId('custom-unit').selectOption('MONTHLY');
  await P().getByTestId('custom-interval').fill('1');
  await P().getByTestId('custom-by-day').check();
  await P().getByTestId('custom-month-day').fill('15');
  await P().getByTestId('custom-end-count').check();
  await P().getByTestId('custom-count').fill('3');
  await P().getByTestId('custom-apply').click();
  await soon(() => rule('p')).toBe('FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=1;COUNT=3;');
  await expect(page.getByTestId('card-repeat')).toHaveText(/Monthly on the 15th, 3 times/);
  await custom();
  await P().getByTestId('custom-unit').selectOption('YEARLY');
  await P().getByTestId('custom-month').selectOption('10');
  await P().getByTestId('custom-by-day').check();
  await P().getByTestId('custom-end-never').check();
  await P().getByTestId('custom-apply').click();
  await soon(() => rule('p')).toBe('FREQ=YEARLY;BYMONTHDAY=15;BYMONTH=10;INTERVAL=1;');
  await expect(page.getByTestId('card-repeat')).toHaveText(/Yearly on October 15/);
  await page.getByTestId('card-done').click();
  await expect(card(page)).toHaveCount(0);

  // Classic's rules: read right, shown in the panel, and Apply with nothing changed (or Done) stores nothing new.
  await openCard(page, page.locator('.nc-bar', { hasText: 'Harvest' }).first(), true);
  await expect(page.getByTestId('card-repeat')).toHaveText(/Every 2 weeks on Sun, Mon, Wed, Thu, Fri, until Dec 31/);
  await custom();
  await expect(P().getByTestId('custom-unit')).toHaveValue('WEEKLY');
  await expect(P().getByTestId('custom-interval')).toHaveValue('2');
  for (const [d, on] of [[0, true], [1, true], [2, false], [3, true], [4, true], [5, true], [6, false]]) await expect(P().getByTestId(`custom-day-${d}`)).toHaveAttribute('aria-pressed', String(on));
  await expect(P().getByTestId('custom-end-until')).toBeChecked();
  await expect(P().getByTestId('custom-until')).toHaveValue('2026-12-31');
  await P().getByTestId('custom-apply').click();
  await expect(P()).toHaveCount(0);
  await page.getByTestId('card-done').click();
  await expect(card(page)).toHaveCount(0);
  await openCard(page, page.locator('.nc-bar', { hasText: 'Pumpkins' }).first(), true);
  await expect(page.getByTestId('card-repeat')).toHaveText(/Yearly on the last Monday of October/);
  await custom();
  await expect(P().getByTestId('custom-unit')).toHaveValue('YEARLY');
  await expect(P().getByTestId('custom-by-weekday')).toBeChecked();
  await expect(P().getByTestId('custom-setpos')).toHaveValue('-1');
  await expect(P().getByTestId('custom-posday')).toHaveValue('1');
  await expect(P().getByTestId('custom-month')).toHaveValue('10');
  await P().getByTestId('custom-apply').click();
  await page.getByTestId('card-done').click();
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(await rule('h'), 'classic\'s weekly rule, untouched').toBe('FREQ=WEEKLY;BYDAY=MO,WE,TH,FR,SU;INTERVAL=2;UNTIL=20261231T080000Z;');
  expect(await rule('k'), 'classic\'s yearly rule, untouched').toBe('FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10;INTERVAL=1;');
  await expect(page.locator('.nc-bar', { hasText: 'Pumpkins' })).toHaveCount(1);   // Oct 26 only, in October
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a repeating event in the card: "this event" stores classic\'s exception and later changes edit that row; "all events" keeps the series start; delete one with Undo', async ({ browser }) => {
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', description: 'Room 4' })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-13');
  const occ = () => page.locator('.nc-timed', { hasText: /Weekly sync|Team sync/ }).first();

  // This event (Oct 13): the first change asks; the answer is remembered for the card.
  await openCard(page, occ());
  await expect(page.getByTestId('card-time-line')).toHaveText(/Tue, Oct 13/);
  await page.getByTestId('card-title').fill('Weekly sync (room 2)');
  await page.getByTestId('card-title').press('Enter');
  await pickScope(page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  let rows = await stored(id);
  let master = rows.find((e) => e.id === 'w'), child = rows.find((e) => e.id !== 'w');
  expect(master.recurrenceException).toBe('20261013T170000Z');
  expect([child.recurrenceID, child.recurrenceException, child.recurrencerule, child.title, child.start, child.description])
    .toEqual(['w', '20261013T170000Z', 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', 'Weekly sync (room 2)', iso('2026-10-13T10:00:00-07:00'), 'Room 4']);
  await typeInto(page, 'card-q-e', '11:30a');
  await soon(async () => (await stored(id)).find((e) => e.id === child.id).end).toBe(iso('2026-10-13T11:30:00-07:00'));
  expect(await page.getByTestId('confirm-dialog').count()).toBe(0);
  expect((await stored(id)).length, 'the second change edits the same row').toBe(2);
  expect((await stored(id)).find((e) => e.id === 'w').recurrenceException).toBe('20261013T170000Z');
  // Cancel takes both back: the row goes, the series skips nothing.
  await page.keyboard.press('Escape');
  await soon(async () => (await stored(id)).length).toBe(1);
  expect((await stored(id))[0].recurrenceException || null).toBe(null);

  // All events, from Oct 20's occurrence: an hour later. The series moves its time, not its start date.
  await page.getByTestId('nav-next').click();
  await openCard(page, occ());
  await typeInto(page, 'card-q-s', '11a');
  await pickScope(page, 'all');
  await soon(async () => (await stored(id))[0].start).toBe(iso('2026-10-06T11:00:00-07:00'));
  [master] = await stored(id);
  expect([master.end, master.recurrencerule, master.title, master.description]).toEqual([iso('2026-10-06T12:00:00-07:00'), 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', 'Weekly sync', 'Room 4']);
  // A second change asks nothing more.
  await page.getByTestId('card-title').fill('Team sync');
  await page.getByTestId('card-title').press('Enter');
  await soon(async () => (await stored(id))[0].title).toBe('Team sync');
  expect([(await stored(id))[0].start, (await stored(id)).length]).toEqual([iso('2026-10-06T11:00:00-07:00'), 1]);
  await page.getByTestId('card-done').click();

  // Delete this occurrence (Oct 20) from the card: asks, no "Are you sure?", Undo takes the stamp back off.
  await openCard(page, occ());
  await page.getByTestId('card-delete').click();
  await pickScope(page, 'this');
  await soon(async () => (await stored(id))[0].recurrenceException).toBe('20261020T180000Z');
  await expect(page.locator('.nc-timed', { hasText: 'Team sync' })).toHaveCount(0);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await soon(async () => (await stored(id))[0].recurrenceException || null).toBe(null);
  await expect(page.locator('.nc-timed', { hasText: 'Team sync' })).toHaveCount(1);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('delete and duplicate: no "Are you sure?", Undo restores the saved row; Duplicate puts a copy on the next day and the card follows it', async ({ browser }) => {
  const id = await seed([timed('a', 'Game', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { type: 2, description: 'Field 3' }),
    timed('b', 'Snack duty', '2026-10-21T10:00:00-07:00', '2026-10-21T11:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const before = (await stored(id)).find((e) => e.id === 'a');
  await openCard(page, ev(page, 'a'));
  await page.getByTestId('card-delete').click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await soon(async () => (await stored(id)).map((e) => e.id)).toEqual(['b']);
  await expect(page.getByText('Deleted "Game"')).toBeVisible();
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await soon(async () => (await stored(id)).map((e) => e.id).sort()).toEqual(['a', 'b']);
  expect((await stored(id)).find((e) => e.id === 'a')).toEqual(before);
  await expect(ev(page, 'a')).toHaveClass(/nc-glow/);

  // Duplicate from the ⋯ menu: Fri Oct 23, same time and fields; the card is now the copy's.
  await openCard(page, ev(page, 'a'), true);
  await page.getByTestId('card-more-actions').click();
  await page.getByTestId('card-duplicate').click();
  await soon(async () => (await stored(id)).length).toBe(3);
  const copy = (await stored(id)).find((e) => !['a', 'b'].includes(e.id));
  expect([copy.title, copy.type, copy.description, await local(page, copy.start), await local(page, copy.end)]).toEqual(['Game', 2, 'Field 3', '2026-10-23 10:00', '2026-10-23 11:00']);
  await expect(toast(page)).toContainText('Duplicated to Fri 10 AM');
  await expect(page.getByTestId('card-start-date')).toHaveText('Fri, Oct 23');
  // Cmd/Ctrl+D: another copy, the next day again (from the card's event).
  await page.locator('.nk-card .nk-h').click({ position: { x: 300, y: 4 } }).catch(() => {});
  await page.getByTestId('card-done').focus();
  await page.keyboard.press('ControlOrMeta+d');
  await soon(async () => (await stored(id)).length).toBe(4);
  // Delete from the keyboard (not typing): the copy goes.
  await page.keyboard.press('Delete');
  await soon(async () => (await stored(id)).length).toBe(3);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('keyboard: Tab to an event, Enter opens the card with focus in the title, Tab stays inside, Escape returns focus; arrows move it with Undo; Cmd/Ctrl+Z', async ({ browser }) => {
  const id = await seed([timed('d', 'Dentist', '2026-10-22T11:00:00-07:00', '2026-10-22T12:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await ev(page, 'd').focus();
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId('card-title')).toBeFocused();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('.nk-card')), 'Tab stays in the card').toBe(true);
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(ev(page, 'd')).toBeFocused();

  // Arrows: Down moves 15 minutes, Right a day, Shift+Down makes it 15 minutes longer; each saved with a toast.
  await page.keyboard.press('ArrowDown');
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-22 11:15');
  await expect(toast(page)).toContainText('Moved to Thu 11:15 AM');
  await page.keyboard.press('ArrowRight');
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-23 11:15');
  await expect(ev(page, 'd')).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await soon(async () => local(page, (await stored(id))[0].end)).toBe('2026-10-23 12:30');
  await page.keyboard.press('ControlOrMeta+z');
  await soon(async () => local(page, (await stored(id))[0].end)).toBe('2026-10-23 12:15');

  // Drag with the mouse, then Undo in the toast.
  const b = await ev(page, 'd').boundingBox();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 + HOUR });
  await page.mouse.up();
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-23 12:15');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-23 11:15');

  // Cmd/Ctrl+E: quick add by typing (the app's own box).
  await page.keyboard.press('ControlOrMeta+e');
  await expect(page.getByText('Add Event by Typing')).toBeVisible();
  await page.keyboard.press('Escape');
  // A double-click opens the full card.
  await ev(page, 'd').dblclick();
  await expect(page.getByTestId('card-start-date')).toBeVisible();
  await expect(page.getByTestId('event-popover')).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('the app around it: 24-hour time and Monday first in the card and pickers, a type\'s name, Edit types…, a search result\'s Edit, Share', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T13:00:00-07:00', '2026-10-22T14:00:00-07:00', { type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await page.getByTestId('settings-button-desktop').click();
  await page.locator('#set-time-format').selectOption('24');
  await page.locator('#set-first-day').selectOption('1');
  await page.locator('[data-category-label="1"]').fill('Matches');
  await page.keyboard.press('Escape');
  await expect(page.locator('.nc-dayhead').first()).toContainText('Mon');
  await openCard(page, ev(page, 'g'), true);
  await expect(page.getByTestId('card-start-time')).toHaveText('13:00');
  await expect(page.getByTestId('card-type')).toHaveText(/Matches/);
  await page.getByTestId('card-start-date').click();
  await expect(picker(page).locator('.nk-month b').first()).toHaveText('M');
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await typeInto(page, 'card-start-time', '15:30');
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-22 15:30');
  // Edit types…: names for everyone (the calendar's labels).
  await page.getByTestId('card-type').click();
  await expect(picker(page).locator('[data-t="3"]')).toHaveText('Away game');
  await picker(page).getByTestId('picker-edit-types').click();
  await picker(page).getByTestId('picker-type-name-3').fill('Tournament day');
  await picker(page).getByTestId('picker-types-done').click();
  await soon(async () => (await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.options.typeLabels[2]).toBe('Tournament day');
  await page.getByTestId('card-done').click();

  // Search: a result's Edit opens the card (CalendarView.openEditor).
  await page.getByTestId('search-button-desktop').click();
  await page.getByRole('searchbox', { name: 'Search events' }).fill('Game');
  await page.getByTestId('search-results').getByText('Game').first().click();
  await page.getByTestId('search-result-edit').first().click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId('card-title')).toHaveValue('Game');
  await page.getByTestId('card-title').fill('Game (final)');
  await page.getByTestId('card-done').click();
  await soon(async () => (await stored(id))[0].title).toBe('Game (final)');
  expect([await local(page, (await stored(id))[0].start), (await stored(id))[0].type]).toEqual(['2026-10-22 15:30', 2]);
  await page.keyboard.press('Escape');
  await page.getByTestId('share-pill-more').click();
  await expect(page.locator('.pc-share')).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('placement: at every corner the card and its pickers stay 12px inside the window; expanding moves it only near the bottom', async ({ browser }) => {
  const id = await seed([
    timed('tl', 'Top left', '2026-10-18T06:00:00-07:00', '2026-10-18T07:00:00-07:00'),
    timed('tr', 'Top right', '2026-10-24T06:00:00-07:00', '2026-10-24T07:00:00-07:00'),
    timed('bl', 'Bottom left', '2026-10-18T21:00:00-07:00', '2026-10-18T22:00:00-07:00'),
    timed('br', 'Bottom right', '2026-10-24T21:00:00-07:00', '2026-10-24T22:00:00-07:00'),
  ]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const W = 1280, H = 900;
  for (const k of ['tl', 'tr', 'bl', 'br']) {
    await ev(page, k).scrollIntoViewIfNeeded();
    if (k[0] === 'b') await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await openCard(page, ev(page, k));
    const e = await ev(page, k).boundingBox(), c0 = await card(page).boundingBox();
    expect(within(c0, W, H), `${k}: quick card inside`).toBe(true);
    expect(c0.x >= e.x + e.width - 1 || c0.x + c0.width <= e.x + 1, `${k}: beside the event`).toBe(true);
    await page.getByTestId('card-more').click();
    await page.waitForTimeout(300);
    const c1 = await card(page).boundingBox();
    expect(within(c1, W, H), `${k}: full card inside`).toBe(true);
    if (k[0] === 't') expect(Math.abs(c1.y - c0.y), `${k}: expanding does not move it`).toBeLessThan(1);
    for (const f of ['card-start-date', 'card-end-time', 'card-repeat', 'card-type']) {
      await page.getByTestId(f).click();
      await expect(picker(page)).toBeVisible();
      expect(within(await picker(page).boundingBox(), W, H), `${k}: ${f} picker inside`).toBe(true);
      await page.keyboard.press('Escape');
    }
    await page.getByTestId('card-done').click();
    await expect(card(page)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await ctx.close();
});

test('long details: the quick card shows four lines and Show all, links open safely; the box stops at 20,000 characters and a paste over it is trimmed', async ({ browser }) => {
  const links = Array.from({ length: 15 }, (_, i) => `https://example.org/field-guide/section-${i + 1}/a-very-long-path-that-should-wrap-and-never-widen-the-card-${'x'.repeat(40)}`);
  let long = 'Season notes. ';
  for (let i = 0; long.length < 5600; i++) long += `Week ${i + 1}: drills, water, snacks, carpool from the north lot. ${i < links.length ? links[i] + ' ' : ''}`;
  long = long.slice(0, 5600);
  for (const phone of [false, true]) {
    const id = await seed([timed('n', 'Season', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { description: long })]);
    const { ctx, page, errors } = await open(browser, id, phone ? '&view=day&date=2026-10-22' : '&view=week&date=2026-10-22', { phone });
    await ev(page, 'n').first().click();
    await expect(card(page)).toBeVisible();
    await page.waitForTimeout(250);
    const prev = page.getByTestId('card-details-preview');
    await expect(prev).toHaveClass(/fade/);
    const w0 = (await card(page).boundingBox()).width;
    expect(await prev.locator('a').count()).toBeGreaterThan(0);
    expect(await prev.locator('a').first().getAttribute('target')).toBe('_blank');
    expect(await prev.locator('a').first().getAttribute('rel')).toMatch(/noopener/);
    await page.getByTestId('card-show-all').click();
    await expect(prev).toHaveClass(/all/);
    expect((await card(page).boundingBox()).width, 'long links never widen the card').toBeLessThanOrEqual(w0 + 0.5);
    expect(within(await card(page).boundingBox(), phone ? 390 : 1280, phone ? 844 : 900, phone ? 0 : 12)).toBe(true);
    await page.getByTestId('card-more').click();
    const ta = page.getByTestId('card-details');
    const tb = await ta.boundingBox();
    expect(tb.height).toBeLessThanOrEqual((phone ? 844 : 900) * (phone ? 0.4 : 0.6) + 2);   // 60% once the card is wide
    {
      // Up to the limit: the counter shows past 90%; a paste over the limit is trimmed with a note.
      await ta.evaluate((el, n) => { el.focus(); el.value = 'y'.repeat(n); el.dispatchEvent(new Event('input', { bubbles: true })); }, 18900);
      await expect(page.getByTestId('card-details-count')).toHaveText('18,900 / 20,000');
      await ta.evaluate((el) => { el.selectionStart = el.selectionEnd = el.value.length; const dt = new DataTransfer(); dt.setData('text/plain', 'z'.repeat(3000)); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
      await expect(page.getByTestId('card-details-count')).toContainText('the end of the paste was left out');
      await expect(page.getByTestId('card-details-count')).toContainText('20,000 / 20,000');
      await page.getByTestId('card-title').click();
      await soon(async () => (await stored(id))[0].description.length).toBe(20000);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }
});


// ---- details: never lose typing, one Undo per session, two people at once, long text, paste, read views ------
test('details save while typing (800 ms after the last key) and once more when left; one Undo for the session; nothing lost on leaving the page', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'Lincoln Field' })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const desc = async () => (await stored(id))[0].description;
  await openCard(page, ev(page, 'p'), true);
  const ta = page.getByTestId('card-details');
  await ta.click();
  await page.keyboard.press('End');
  await page.keyboard.type(', bring water', { delay: 10 });
  // No blur: the pause alone saves it.
  await soon(desc, 4000).toBe('Lincoln Field, bring water');
  await expect(toast(page)).toHaveCount(0);
  await page.keyboard.type('. Cleats.', { delay: 10 });
  await soon(desc, 4000).toBe('Lincoln Field, bring water. Cleats.');
  // Leaving the box: one "Details saved", and its Undo takes the whole session back.
  await page.getByTestId('card-title').click();
  await expect(toast(page)).toContainText('Details saved');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await soon(desc).toBe('Lincoln Field');
  await expect(ta).toHaveValue('Lincoln Field');
  // Typing, then leaving the page a second later: kept.
  await ta.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (north gate)', { delay: 10 });
  await page.waitForTimeout(1000);
  await page.goto('about:blank');
  await soon(desc, 6000).toBe('Lincoln Field (north gate)');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('two people: details typed here are not overwritten by a change from another browser; other fields update live; the save says theirs was replaced, with Undo', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'Lincoln Field' })]);
  const A = await open(browser, id, '&view=week&date=2026-10-22');
  const B = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(A.page, ev(A.page, 'p'), true);
  const ta = A.page.getByTestId('card-details');
  await ta.click();
  await ta.fill('Bring snacks for 12');
  await soon(async () => (await stored(id))[0].description).toBe('Bring snacks for 12');   // saved while typing
  // B, meanwhile: new details and a new title, saved.
  await openCard(B.page, ev(B.page, 'p'), true);
  await B.page.getByTestId('card-details').fill('Field moved to Oak Park');
  await B.page.getByTestId('card-title').fill('Practice (Oak Park)');
  await B.page.getByTestId('card-done').click();
  await soon(async () => (await stored(id))[0].title).toBe('Practice (Oak Park)');
  // A's card: the title follows, the box keeps what A is typing.
  await expect(A.page.getByTestId('card-title')).toHaveValue('Practice (Oak Park)');
  await expect(ta).toHaveValue('Bring snacks for 12');
  await expect(ta).toBeFocused();
  await ta.press('End'); await ta.pressSequentially(' and juice', { delay: 10 });   // and keeps typing
  // A leaves the box: A's details win, and A is told.
  await A.page.getByTestId('card-done').click();
  await soon(async () => (await stored(id))[0].description).toBe('Bring snacks for 12 and juice');
  expect((await stored(id))[0].title).toBe('Practice (Oak Park)');
  await expect(toast(A.page)).toContainText('Someone else edited these details too');
  await toast(A.page).getByRole('button', { name: 'Undo' }).click();
  await soon(async () => (await stored(id))[0].description).toBe('Field moved to Oak Park');
  expect(A.errors).toEqual([]); expect(B.errors).toEqual([]);
  await A.ctx.close(); await B.ctx.close();
});

test('long details: the card widens to 600px past five lines (never narrows while open, back to 416 when reopened), stays on screen, Done stays visible; a 1 MB paste is trimmed fast', async ({ browser }) => {
  const id = await seed([timed('r', 'Right edge', '2026-10-23T10:00:00-07:00', '2026-10-23T11:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'r'), true);
  expect(Math.round((await card(page).boundingBox()).width)).toBe(416);
  const ta = page.getByTestId('card-details');
  await ta.click();
  for (let i = 0; i < 7; i++) await page.keyboard.type(`Line ${i + 1}: who brings what, where we meet, and when.\n`);
  await page.waitForTimeout(300);
  let b = await card(page).boundingBox();
  expect(Math.round(b.width)).toBe(600);
  expect(within(b, 1280, 900)).toBe(true);
  await expect(page.getByTestId('card-done')).toBeInViewport();
  // Deleting most of it does not narrow it again.
  await ta.fill('Short.');
  await ta.dispatchEvent('input');
  await page.waitForTimeout(250);
  expect(Math.round((await card(page).boundingBox()).width)).toBe(600);
  // A 1 MB paste: trimmed to the limit in well under 100 ms, with the note.
  const ms = await ta.evaluate((el) => {
    el.focus(); el.selectionStart = el.selectionEnd = el.value.length;
    const dt = new DataTransfer(); dt.setData('text/plain', 'p'.repeat(1024 * 1024));
    const t0 = performance.now();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return performance.now() - t0;
  });
  expect(ms).toBeLessThan(100);
  expect((await ta.inputValue()).length).toBe(20000);
  await expect(page.getByTestId('card-details-count')).toContainText('the end of the paste was left out');
  await page.getByTestId('card-done').click();
  await soon(async () => (await stored(id))[0].description.length).toBe(20000);
  // Reopened: the normal width again.
  await openCard(page, ev(page, 'r'));
  expect(Math.round((await card(page).boundingBox()).width)).toBe(416);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('read views: a view link\'s popup clamps long details with Show all and stays on screen with 20,000 characters; links are safe', async ({ browser }) => {
  const long = 'Directions: https://example.org/' + 'a'.repeat(200) + '\nLine two.\n' + 'Carpool notes and more. '.repeat(900);
  const id = await seed([timed('n', 'Season', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { description: long.slice(0, 20000) })]);
  const view = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json();
  for (const phone of [false, true]) {
    const v = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'America/Los_Angeles' } : { viewport: { width: 1280, height: 800 }, timezoneId: 'America/Los_Angeles' });
    await v.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
    const vp = await v.newPage();
    await vp.clock.install({ time: new Date(NOW) });
    await vp.goto(`${BASE}/view/${view.publicViewId}?backend=cf&cal=native&view=day&date=2026-10-22`);
    await expect(vp.locator('.nc')).toBeVisible({ timeout: 15_000 });
    await vp.locator('.nc [data-testid="event-n"]').first().click();
    const pop = vp.getByTestId('event-popover');
    await expect(pop).toBeVisible();
    const W = phone ? 390 : 1280, H = phone ? 844 : 800;
    await expect(vp.getByTestId('popover-description')).toHaveClass(/fade/);
    const a = vp.getByTestId('popover-description').locator('a').first();
    expect([await a.getAttribute('target'), /noopener/.test(await a.getAttribute('rel'))]).toEqual(['_blank', true]);
    await vp.getByTestId('popover-show-all').click();
    await vp.waitForTimeout(200);
    expect(within(await pop.boundingBox(), W, H, 0), `${phone ? 'phone' : 'desktop'}: the popup stays on screen`).toBe(true);
    expect(await vp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(W);
    await v.close();
  }
});

// -------------------------------------------------------------------------------------------------- phone
/** Real touch input (CDP), so the page scrolls and long-presses as on a phone. */
async function touch(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
  return {
    async longDrag(from, to, holdMs = 700, steps = 10) {
      await send('touchStart', [from]); await page.waitForTimeout(holdMs);
      for (let i = 1; i <= steps; i++) { await send('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]); await page.waitForTimeout(20); }
      await send('touchEnd', []);
    },
    async swipe(from, to, steps = 8) {
      await send('touchStart', [from]);
      for (let i = 1; i <= steps; i++) { await send('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]); await page.waitForTimeout(16); }
      await send('touchEnd', []);
    },
  };
}

test('phone (390px): tap a day to add (a sheet, title focused), tap an event for the same card as a sheet, pickers on screen, swipe down or the scrim closes it', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-15', { phone: true });
  const c = await cell(page, '2026-10-14');
  const cb = await c.boundingBox();
  await page.touchscreen.tap(cb.x + cb.width / 2, cb.y + cb.height - 6);
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(250);
  const q = await card(page).boundingBox();
  expect([Math.round(q.x), Math.round(q.width), Math.round(q.y + q.height)]).toEqual([0, 390, 844]);   // a sheet along the bottom
  await expect(page.getByTestId('card-title')).toBeFocused();
  await expect(page.getByTestId('card-scrim')).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.pc-native-cal').hasAttribute('inert'))).toBe(true);
  await page.keyboard.type('Bake sale');
  await page.getByTestId('card-done').tap();
  await soon(async () => !!(await byTitle(id, 'Bake sale'))).toBe(true);
  expect((await byTitle(id, 'Bake sale')).isAllDay).toBe(true);
  expect(await page.evaluate(() => document.querySelector('.pc-native-cal').hasAttribute('inert'))).toBe(false);

  await ev(page, 'g').first().tap();
  await expect(card(page)).toBeVisible();
  await page.getByTestId('card-more').tap();
  const s = await card(page).boundingBox();
  expect([Math.round(s.x), Math.round(s.width)]).toEqual([0, 390]);
  expect(s.y + s.height).toBeLessThanOrEqual(845);
  expect(s.y).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByTestId('card-end-time').tap();
  await expect(picker(page)).toBeVisible();
  expect(within(await picker(page).boundingBox(), 390, 844)).toBe(true);
  await picker(page).locator('[data-m="720"]').tap();
  await soon(async () => local(page, (await stored(id)).find((e) => e.id === 'g').end)).toBe('2026-10-22 12:00');
  // Swipe the sheet down from its top: it closes (keeping what was saved).
  const t = await touch(page);
  const top = await card(page).boundingBox();
  await t.swipe([top.x + 200, top.y + 10], [top.x + 200, top.y + 200]);
  await expect(card(page)).toHaveCount(0);
  // The scrim: a tap closes the sheet.
  await ev(page, 'g').first().tap();
  await expect(card(page)).toBeVisible();
  await page.touchscreen.tap(195, 60);
  await expect(card(page)).toHaveCount(0);
  expect((await stored(id)).find((e) => e.id === 'g').title).toBe('Game');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('phone: hold to pick up and drag an event (a buzz, then another on drop); a swipe over it scrolls and moves nothing; hold on empty time drags out a new event', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=day&date=2026-10-22', { phone: true });
  await page.evaluate(() => { window.__buzz = []; navigator.vibrate = (ms) => { window.__buzz.push(ms); return true; }; });
  const t = await touch(page);
  const box = async () => ev(page, 'g').boundingBox();
  let b = await box();
  const scroll0 = await page.evaluate(() => document.querySelector('.nc-grid-scroll').scrollTop + window.scrollY);
  await t.swipe([b.x + b.width / 2, b.y + b.height / 2], [b.x + b.width / 2, b.y + b.height / 2 - 150]);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => document.querySelector('.nc-grid-scroll').scrollTop + window.scrollY)).toBeGreaterThan(scroll0);
  expect(await local(page, (await stored(id))[0].start)).toBe('2026-10-22 10:00');
  b = await box();
  await t.longDrag([b.x + b.width / 2, b.y + b.height / 2], [b.x + b.width / 2, b.y + b.height / 2 + HOUR]);
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-22 11:00');
  expect(await local(page, (await stored(id))[0].end)).toBe('2026-10-22 12:00');
  expect(await page.evaluate(() => window.__buzz)).toEqual([10, 6]);
  await expect(card(page)).toHaveCount(0);
  // Hold on an empty hour, drag down: a new event of that length, its card open.
  const at = await slot(page, '2026-10-22', 14);
  await t.longDrag([at.x, at.y + 4], [at.x, at.y + 4 + 2 * HOUR]);
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId('card-time-line')).toHaveText(/2 PM\s*–\s*4 PM/);
  expect(errors).toEqual([]);
  await ctx.close();
});

// -------------------------------------------------------------------------------------------------- locked
test('a locked calendar (Plus lock, no editor key) and a view link offer no editing at all', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await page.evaluate((cid) => document.querySelector('#app')._vnode.component.proxy.applyLockState({ id: cid, locked: true, pro: true, canEdit: false }), id);
  await expect(page.locator('.nc.nc-readonly')).toBeVisible();
  await expect(page.locator('.nc.nc-editable')).toHaveCount(0);
  await expect(page.locator('.nc-resize:visible')).toHaveCount(0);
  const before = JSON.stringify(await stored(id));
  const at = await slot(page, '2026-10-21', 14);
  await page.mouse.click(at.x, at.y + 6);
  await drag(page, at, { x: at.x, y: at.y + 2 * HOUR }); await page.mouse.up();
  await page.keyboard.press('n');
  await expect(card(page)).toHaveCount(0);
  const b = await ev(page, 'g').boundingBox();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 + HOUR }); await page.mouse.up();
  await ev(page, 'g').click();
  await expect(page.getByTestId('event-popover')).toBeVisible();
  await expect(page.getByTestId('popover-edit')).toHaveCount(0);
  await expect(page.getByTestId('popover-delete')).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(JSON.stringify(await stored(id))).toBe(before);
  expect(errors).toEqual([]);
  await ctx.close();

  // The view link: the read-only popup only; the card's code is never loaded.
  const v = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles' });
  await v.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  const vp = await v.newPage();
  await vp.clock.install({ time: new Date(NOW) });
  const files = [];
  vp.on('request', (r) => files.push(r.url()));
  const view = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json();
  expect(view.ok).toBe(true);
  await vp.goto(`${BASE}/view/${view.publicViewId}?backend=cf&cal=native&view=week&date=2026-10-22`);
  await expect(vp.locator('.nc')).toBeVisible({ timeout: 15_000 });
  await vp.locator('.nc [data-testid^="event-"]').first().click();
  await expect(vp.getByTestId('event-popover')).toBeVisible();
  await expect(vp.getByTestId('event-card')).toHaveCount(0);
  await vp.keyboard.press('n');
  await expect(vp.getByTestId('event-card')).toHaveCount(0);
  expect(files.filter((u) => /EventCard|cardKit/.test(u))).toEqual([]);
  await v.close();
});

// ---- drags (the card is not involved: a drop saves at once, with a toast and Undo) ----
test('drag to move, drag either edge to resize, Escape cancels a drag (stored ISO, other fields untouched)', async ({ browser }) => {
  const id = await seed([timed('d', 'Dentist', '2026-10-22T11:00:00-07:00', '2026-10-22T12:30:00-07:00', { description: 'Bring forms', type: 3 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const box = async () => ev(page, 'd').boundingBox();

  // Move: one day right, one hour down.
  let b = await box();
  const colW = (await page.locator('.nc-col').first().boundingBox()).width;
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + colW, y: b.y + b.height / 2 + HOUR });
  await page.mouse.up();
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-23 12:00');
  let [e] = await stored(id);
  expect([await local(page, e.end), e.title, e.description, e.type, e.start]).toEqual(['2026-10-23 13:30', 'Dentist', 'Bring forms', 3, e.start]);
  expect(e.start).toMatch(ISO);

  // Bottom edge down half an hour: ends 14:00. Top edge up half an hour: starts 11:30.
  b = await box();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height - 2 }, { x: b.x + b.width / 2, y: b.y + b.height - 2 + HOUR / 2 });
  await page.mouse.up();
  await soon(async () => local(page, (await stored(id))[0].end)).toBe('2026-10-23 14:00');
  b = await box();
  await drag(page, { x: b.x + b.width / 2, y: b.y + 2 }, { x: b.x + b.width / 2, y: b.y + 2 - HOUR / 2 });
  await page.mouse.up();
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-23 11:30');
  [e] = await stored(id);
  expect(await local(page, e.end)).toBe('2026-10-23 14:00');

  // Escape mid-drag: the event goes back, nothing is saved, and the release opens nothing.
  const before = JSON.stringify(await stored(id));
  b = await box();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 + 2 * HOUR });
  await expect(page.locator('.nc-timed.lifted')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.nc-timed.lifted')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(800);
  expect(JSON.stringify(await stored(id))).toBe(before);
  await expect(page.getByTestId('event-card')).toHaveCount(0);
  await expect(page.getByTestId('event-popover')).toHaveCount(0);
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  // And a drag to create, escaped, creates nothing.
  const s = await slot(page, '2026-10-21', 8);
  await drag(page, s, { x: s.x, y: s.y + 2 * HOUR });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('event-card')).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a repeating event: dragging one occurrence asks; "this event" stores classic\'s exception, "all events" moves the series', async ({ browser }) => {
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-20');
  const occ = () => page.locator('.nc-timed', { hasText: 'Weekly sync' }).first();
  const colW = (await page.locator('.nc-col').first().boundingBox()).width;

  // Cancel: nothing changes.
  let b = await occ().boundingBox();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + colW, y: b.y + b.height / 2 + HOUR });
  await page.mouse.up();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await page.waitForTimeout(500);
  expect((await stored(id))[0].recurrenceException || null).toBe(null);

  // This event: Tue Oct 20 10:00 to Wed Oct 21 11:00, exactly as classic's drag stores it (its own row, the series skips Oct 20).
  b = await occ().boundingBox();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + colW, y: b.y + b.height / 2 + HOUR });
  await page.mouse.up();
  await pickScope(page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  let rows = await stored(id);
  let master = rows.find((e) => e.id === 'w'), child = rows.find((e) => e.id !== 'w');
  expect(master.recurrenceException).toBe('20261020T170000Z');
  expect([master.start, master.end, master.recurrencerule, master.title]).toEqual([iso('2026-10-06T10:00:00-07:00'), iso('2026-10-06T11:00:00-07:00'), 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', 'Weekly sync']);
  expect([child.recurrenceID, child.recurrenceException, child.recurrencerule, child.title, child.type]).toEqual(['w', '20261020T170000Z', 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', 'Weekly sync', 2]);
  expect([child.start, child.end]).toEqual([iso('2026-10-21T11:00:00-07:00'), iso('2026-10-21T12:00:00-07:00')]);

  // All events, from next week's Tuesday to its Thursday at 9:00: the series moves two days and an hour earlier and
  // repeats on Thursdays. It has an edited occurrence, so classic's question comes first; "No" keeps it.
  await page.getByTestId('nav-next').click();
  b = await occ().boundingBox();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + 2 * colW, y: b.y + b.height / 2 - HOUR });
  await page.mouse.up();
  await pickScope(page, 'all');
  await expect(page.getByTestId('confirm-dialog')).toContainText('cancel the changes made to specific instances');
  await page.getByTestId('confirm-no').click();
  await soon(async () => (await stored(id)).find((e) => e.id === 'w').start).toBe(iso('2026-10-08T09:00:00-07:00'));
  rows = await stored(id);
  master = rows.find((e) => e.id === 'w');
  // The edited occurrence's slot moves with the series (Tue Oct 20 10:00 -> Thu Oct 22 9:00), in both rows.
  expect([master.end, master.recurrencerule, master.recurrenceException]).toEqual([iso('2026-10-08T10:00:00-07:00'), 'FREQ=WEEKLY;BYDAY=TH;INTERVAL=1;', '20261022T160000Z']);
  expect(rows).toHaveLength(2);
  expect(rows.find((e) => e.id !== 'w').recurrenceException).toBe('20261022T160000Z');
  await expect(page.locator('.nc-timed', { hasText: 'Weekly sync' })).toHaveCount(1);   // Thursday Oct 29 only
  expect(errors).toEqual([]);
  await ctx.close();
});

// All-day drags in month view, in Los Angeles and Tokyo, from data written in each. The expected rows are what
// classic stores for the same gestures on the same seed (run against classic as the oracle, Oct 25 2026): the
// new local midnights, the length kept, and the skipped date stamped at the viewer's midnight beside the
// existing Tokyo stamp, kept verbatim.
const ALLDAY_DRAGS = {
  'America/Los_Angeles': { camp: ['2026-10-15T07:00:00.000Z', '2026-10-18T07:00:00.000Z'], exc: '20261012T150000Z,20261020T070000Z',
    row: ['2026-10-22T07:00:00.000Z', '2026-10-23T07:00:00.000Z', '20261020T070000Z'] },
  'Asia/Tokyo': { camp: ['2026-10-14T15:00:00.000Z', '2026-10-17T15:00:00.000Z'], exc: '20261012T150000Z,20261019T150000Z',
    row: ['2026-10-21T15:00:00.000Z', '2026-10-22T15:00:00.000Z', '20261019T150000Z'] },
};
for (const [zone, want] of Object.entries(ALLDAY_DRAGS)) {
  test(`all-day drags in month view store exactly what classic stores (${zone})`, async ({ browser }) => {
    const id = await seed([
      { ...timed('camp', 'Camp', '2026-10-13T07:00:00.000Z', '2026-10-16T07:00:00.000Z'), isAllDay: true, type: 4 },   // Oct 13-15, written in LA
      { ...timed('tw', 'Tokyo weekly', '2026-10-05T15:00:00.000Z', '2026-10-06T15:00:00.000Z'), isAllDay: true, type: 6,   // Tuesdays, written in Tokyo
        recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=4', recurrenceException: '20261012T150000Z' },
    ]);
    const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-15', { timezoneId: zone });
    const dragDays = async (title, from, to) => {
      const a = await (await cell(page, from)).boundingBox(), b = await (await cell(page, to)).boundingBox();
      const bar = page.locator('.nc-bar', { hasText: title });
      let box = null;
      for (const el of await bar.all()) { const r = await el.boundingBox(); if (r && r.y > a.y && r.y < a.y + a.height && r.x < a.x + a.width && r.x + r.width > a.x) { box = r; break; } }
      expect(box, `${title} on ${from}`).not.toBe(null);
      const x = Math.max(box.x + 20, Math.min(a.x + a.width / 2, box.x + box.width - 20)), y = box.y + box.height / 2;
      await drag(page, { x, y }, { x: x + (b.x - a.x), y: y + (b.y - a.y) }, 12);
      await page.mouse.up();
    };
    await dragDays('Camp', '2026-10-13', '2026-10-15');
    await soon(async () => (await stored(id)).find((e) => e.id === 'camp').start).toBe(want.camp[0]);
    expect((await stored(id)).find((e) => e.id === 'camp').end).toBe(want.camp[1]);
    expect(await daysOf(page, 'event-camp')).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);
    await dragDays('Tokyo weekly', '2026-10-20', '2026-10-22');
    await pickScope(page, 'this');
    await soon(async () => (await stored(id)).length).toBe(3);
    const rows = await stored(id);
    const series = rows.find((e) => e.id === 'tw'), row = rows.find((e) => !['camp', 'tw'].includes(e.id));
    expect([series.start, series.end, series.recurrencerule, series.recurrenceException])
      .toEqual(['2026-10-05T15:00:00.000Z', '2026-10-06T15:00:00.000Z', 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=4', want.exc]);
    expect([row.start, row.end, row.recurrenceException, row.recurrenceID, row.isAllDay, row.recurrencerule])
      .toEqual([...want.row, 'tw', true, 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=4']);
    expect(await daysOf(page, 'event-tw')).toEqual(['2026-10-06', '2026-10-27']);
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

test('search finds words in an event\'s details as well as its title, ignoring case', async ({ browser }) => {
  const id = await seed([timed('a', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'Bring cleats. Field 3' }),
    timed('b', 'Game', '2026-10-23T10:00:00-07:00', '2026-10-23T11:00:00-07:00', { description: 'Away at Lincoln' }),
    timed('c', 'Lincoln picnic', '2026-10-25T12:00:00-07:00', '2026-10-25T13:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await page.getByTestId('search-button-desktop').click();
  const box = page.getByRole('searchbox', { name: 'Search events' });
  const titles = page.getByTestId('search-results').locator('.pc-search-result-head > span:first-child');
  await box.fill('FIELD 3');
  await expect(titles).toHaveText(['Practice']);
  await box.fill('lincoln');
  await expect(titles).toHaveText(['Lincoln picnic', 'Game']);   // upcoming first (Oct 25), then past (Oct 23)
  expect(errors).toEqual([]);
  await ctx.close();
});

/** The page's scroll, the time grid's scroll, and where the card and an event are on screen. */
const scrolls = (page, eventId) => page.evaluate((id) => {
  const g = document.querySelector('.nc-grid-scroll'), c = document.querySelector('.nk-card'), e = document.querySelector(`.nc [data-testid="event-${id}"]`);
  const box = (x) => { if (!x) return null; const r = x.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return { page: Math.round(window.scrollY), grid: g ? Math.round(g.scrollTop) : null, card: box(c), event: box(e), w: window.innerWidth, h: window.innerHeight };
}, eventId);

test('scrolling with the card open: a wheel over the card moves nothing behind it; the grid scrolled behind it carries the card along, 12px inside the window; opening scrolls nothing', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T13:00:00-07:00', '2026-10-22T14:00:00-07:00', { type: 2, description: 'Field 3' })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const before = await scrolls(page, 'g');
  await openCard(page, ev(page, 'g'));
  const opened = await scrolls(page, 'g');
  expect([opened.page, opened.grid], 'opening the card scrolls neither the page nor the grid').toEqual([before.page, before.grid]);

  // A wheel over the card (it has nothing to scroll): the page, the grid and the card stay where they are.
  await page.mouse.move(opened.card.x + opened.card.w / 2, opened.card.y + 20);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  let now = await scrolls(page, 'g');
  expect([now.page, now.grid, now.card]).toEqual([opened.page, opened.grid, opened.card]);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  now = await scrolls(page, 'g');
  expect([now.page, now.grid, now.card]).toEqual([opened.page, opened.grid, opened.card]);

  // A wheel over the grid behind it: the grid scrolls, the card moves with its event (same gap), inside the window.
  const g = await page.locator('.nc-grid-scroll').boundingBox();
  await page.mouse.move(g.x + 80, g.y + g.height / 2);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(300);
  now = await scrolls(page, 'g');
  expect(now.grid, 'the grid scrolled').toBeGreaterThan(opened.grid);
  expect(now.page).toBe(opened.page);
  expect(now.card.y - now.event.y, 'the card keeps its place beside the event').toBe(opened.card.y - opened.event.y);
  expect(now.card.x).toBe(opened.card.x);
  // Scrolled until the event is far off the top: the card stops 12px inside the window, never off it.
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(300);
  now = await scrolls(page, 'g');
  expect(now.card.y).toBeGreaterThanOrEqual(12);
  expect(now.card.y + now.card.h).toBeLessThanOrEqual(now.h - 12);
  await expect(card(page)).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('phone (390px): scrolling over the sheet never scrolls the calendar or the page behind it', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T13:00:00-07:00', '2026-10-22T14:00:00-07:00', { type: 2, description: 'Field 3\n'.repeat(40) })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22', { phone: true });
  const before = await scrolls(page, 'g');
  await ev(page, 'g').first().tap();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300);
  const opened = await scrolls(page, 'g');
  expect([opened.page, opened.grid], 'opening the sheet scrolls nothing').toEqual([before.page, before.grid]);
  for (const dy of [600, -600, 600]) {
    await page.mouse.move(195, opened.card.y + 30);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(250);
    const now = await scrolls(page, 'g');
    expect([now.page, now.grid, now.card.y]).toEqual([opened.page, opened.grid, opened.card.y]);
  }
  // A wheel above the sheet (the scrim over the grid): the calendar behind is out of reach while the sheet is open.
  await page.mouse.move(195, 120);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(250);
  const above = await scrolls(page, 'g');
  expect([above.page, above.grid, above.card.y]).toEqual([opened.page, opened.grid, opened.card.y]);
  // Swiping on the sheet (it may scroll its own long details): the grid and the page behind stay put.
  const s = await card(page).boundingBox();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: Math.round(s.y + s.height - 60), yDistance: -300, speed: 1200, gestureSourceType: 'touch' });
  await page.waitForTimeout(300);
  const after = await scrolls(page, 'g');
  expect([after.page, after.grid]).toEqual([opened.page, opened.grid]);
  expect(errors).toEqual([]);
  await ctx.close();
});
