// @ts-check
/**
 * Stress test of the native event card (nativecal/components/EventCard.js, cardKit.js, app.js nativeCard*): the things
 * a real person hits that the journeys in native-editing.spec.js do not. Every check is made against what the SERVER
 * stored (GET /cal/<id>) as well as the screen.
 *
 * Two kinds of tests:
 *   - "F<n> ..." tests are FINDINGS. Each asserts what a person expects and is marked test.fail() because the app does
 *     not do it yet; the suite stays green. When a finding is fixed its test starts passing, Playwright reports it as an
 *     unexpected pass, and the test.fail() line comes out so the test then guards the fix.
 *   - The other tests pin behavior the stress test checked and found right.
 * Areas: [repeat] the repeat Custom… section and form fields, [tz] the per-event time zone, [card] everything else.
 * Not repeated here (editor-features.spec.js has them): raw controls in Custom… (its F36), the time zone picker (F13) and
 * the time zone row on all-day events (F10).
 * The pure-helper findings (smart titles, typed dates, rule words) are test/unit/editor-stress.test.js.
 * Screenshots of every finding land in cloudflare/test-results/editor-stress/.
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh); run with scripts/test-on-box.sh editor-stress.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SHOTS = path.join(__dirname, '..', 'test-results', 'editor-stress');
fs.mkdirSync(SHOTS, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';   // Saturday Oct 24 2026, Los Angeles
const HOUR = 48;                            // NativeCalendar's hour height
const iso = (s) => new Date(s).toISOString();
const LABELS = ['Practice', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];
const timed = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
const WEEKLY = 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;';

let n = 0;
async function seed(events, options = {}) {
  const id = `es-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Editor stress', options: { typeLabels: LABELS, ...options }, events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100] });
// A finding: expected to fail until fixed. RAW = true runs the findings as plain tests, to see each fail where it should.
const RAW = false;
const finding = (why) => { if (!RAW) test.fail(true, why); };
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});

/** A browser at a fixed time. o: phone, colorScheme, locale, timezoneId, viewport, settings (pastecal_global_settings). */
async function open(browser, id, query = '', o = {}) {
  const { phone = false, timezoneId = 'America/Los_Angeles', settings = null, colorScheme = 'light', locale = 'en-US', viewport = null } = o;
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId, locale, colorScheme }
    : { viewport: viewport || { width: 1280, height: 800 }, timezoneId, locale, colorScheme });
  await ctx.addInitScript((g) => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); if (g) localStorage.setItem('pastecal_global_settings', JSON.stringify(g)); } catch (e) { /* blocked */ } }, settings);
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(o.now || NOW) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${id}?backend=cf&cal=native${query}`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const card = (page) => page.getByTestId('event-card');
const picker = (page) => page.getByTestId('card-picker');
const toast = (page) => page.locator('.pc-toast');
const ev = (page, id) => page.locator(`.nc [data-testid="event-${id}"]`);
async function openCard(page, locator, full = false) {
  await locator.first().click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(250);   // past the card's 180 ms entrance
  if (full) { await page.getByTestId('card-more').click(); await expect(page.getByTestId('card-start-date')).toBeVisible(); await page.waitForTimeout(300); }
}
async function tapCard(page, locator, full = false) {
  await locator.first().tap();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300);
  if (full) { await page.getByTestId('card-more').tap(); await expect(page.getByTestId('card-start-date')).toBeVisible(); await page.waitForTimeout(300); }
}
async function typeInto(page, field, text) {
  await page.getByTestId(field).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByTestId('picker-input').fill(text);
  await picker(page).getByTestId('picker-input').press('Enter');
}
async function pickScope(page, scope) {
  const dlg = page.getByTestId('confirm-dialog');
  await expect(dlg.getByTestId(`scope-${scope}`)).toBeVisible();
  await dlg.getByTestId(`scope-${scope}`).check();
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg.getByTestId('scope-this')).toHaveCount(0);
}
/** Repeat > Custom…: the repeat's settings open inside the card (each change saved as it is made). */
async function openCustom(page) {
  await page.getByTestId('card-repeat').click();
  await picker(page).getByTestId('picker-custom').click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByTestId('card-custom')).toBeVisible();
}
const custom = (page) => page.getByTestId('card-custom');
/** Local wall-clock "YYYY-MM-DD HH:MM" of a stored instant, in the browser's zone. */
const local = (page, v) => page.evaluate((x) => { const d = new Date(x); const p = (k) => String(k).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }, v);
/** The point at a time of day in a day's column of the week grid (hours shown from 5 AM). */
async function slot(page, ymd, h) {
  const ms = await page.evaluate((s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }, ymd);
  const col = page.locator(`.nc-col[data-day="${ms}"]`);
  await col.scrollIntoViewIfNeeded();
  const b = await col.boundingBox();
  const first = await page.evaluate(() => parseInt(document.querySelector('.nc-hour-label').textContent, 10) || 5);
  return { x: b.x + b.width / 2, y: b.y + (h - first) * HOUR };
}
/** Type a new event's title at a slot and press Enter. */
async function quickAdd(page, ymd, h, title) {
  const at = await slot(page, ymd, h);
  await page.mouse.click(at.x, at.y + 6);
  await expect(page.getByTestId('card-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(card(page)).toHaveCount(0);
}
const box = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; }, sel);
const inside = (b, w, h) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.right <= w + 0.5 && b.bottom <= h + 0.5;

// =====================================================================================================
// Findings, worst first. Each: test.fail() + the finding id; the assertion is what a person expects.
// =====================================================================================================

test('F01 [card] data-loss: someone else renames an event while my card is open; my Done (no edits) keeps their title, and my card shows it', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const A = await open(browser, id, '&view=week&date=2026-10-22');
  const B = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(A.page, ev(A.page, 'p'));
  await expect(A.page.getByTestId('card-title')).toBeFocused();   // the desktop card opens with the title focused
  await openCard(B.page, ev(B.page, 'p'));
  await B.page.getByTestId('card-title').fill('Practice MOVED to gym');
  await B.page.getByTestId('card-title').press('Enter');
  await B.page.getByTestId('card-done').click();
  await soon(async () => (await stored(id))[0].title).toBe('Practice MOVED to gym');
  await expect(A.page.getByTestId('card-title'), "A's open, untouched card follows B's rename").toHaveValue('Practice MOVED to gym');
  await shot(A.page, 'F01-stale-title-in-open-card');
  await A.page.getByTestId('card-done').click();   // A changed nothing
  await A.page.waitForTimeout(1500);
  expect((await stored(id))[0].title, "B's rename survives A closing an untouched card").toBe('Practice MOVED to gym');
  await A.ctx.close(); await B.ctx.close();
});

test('F02 [card] data-loss: an occurrence card left open while another browser moves the series "all events" saves "this event" at the series\' new time', async ({ browser }) => {
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY })]);
  const C = await open(browser, id, '&view=week&date=2026-10-20');
  const D = await open(browser, id, '&view=week&date=2026-10-20');
  await openCard(C.page, C.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
  await openCard(D.page, D.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
  await typeInto(D.page, 'card-q-s', '12p');
  await pickScope(D.page, 'all');
  await soon(async () => local(D.page, (await stored(id)).find((e) => e.id === 'w').start)).toBe('2026-10-06 12:00');
  await expect(C.page.getByTestId('card-q-s'), "C's card follows the series to 12 PM").toHaveText('12 PM');
  await C.page.getByTestId('card-title').fill('Weekly sync (room 4)');
  await C.page.getByTestId('card-title').press('Enter');
  await pickScope(C.page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  await C.page.getByTestId('card-done').click();
  await shot(C.page, 'F02-occurrence-saved-at-old-time');
  const child = (await stored(id)).find((e) => e.recurrenceID === 'w');
  expect(await local(C.page, child.start), 'the renamed Oct 20 occurrence keeps the series\' new 12 PM time').toBe('2026-10-20 12:00');
  expect(await local(C.page, child.end)).toBe('2026-10-20 13:00');
  const series = (await stored(id)).find((e) => e.id === 'w');
  expect(series.recurrenceException, 'the series skips Oct 20 at 12 PM, where the occurrence now is').toBe('20261020T190000Z');
  await C.ctx.close(); await D.ctx.close();
});

test('F02 [card] data-loss: the series moved while "this event / all events" was being asked; "this event" still lands on its slot as it is now', async ({ browser }) => {
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY })]);
  const C = await open(browser, id, '&view=week&date=2026-10-20');
  const D = await open(browser, id, '&view=week&date=2026-10-20');
  await openCard(C.page, C.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
  await C.page.getByTestId('card-title').fill('Weekly sync (room 4)');
  await C.page.getByTestId('card-title').press('Enter');
  await expect(C.page.getByTestId('scope-this')).toBeVisible();   // C is asked; D moves the series meanwhile
  await openCard(D.page, D.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
  await typeInto(D.page, 'card-q-s', '12p');
  await pickScope(D.page, 'all');
  await soon(async () => local(D.page, (await stored(id)).find((e) => e.id === 'w').start)).toBe('2026-10-06 12:00');
  await C.page.waitForTimeout(1000);
  await pickScope(C.page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  await C.page.getByTestId('card-done').click();
  const rows = await stored(id), child = rows.find((e) => e.recurrenceID === 'w'), series = rows.find((e) => e.id === 'w');
  expect([child.title, await local(C.page, child.start), await local(C.page, child.end)]).toEqual(['Weekly sync (room 4)', '2026-10-20 12:00', '2026-10-20 13:00']);
  expect(series.recurrenceException, 'the series skips Oct 20 at 12 PM, where the occurrence now is').toBe('20261020T190000Z');
  expect(rows.length).toBe(2);
  await C.ctx.close(); await D.ctx.close();
});

test('F01 [card] data-loss: details someone else edits while my card has the (untouched) details box focused are kept on my Done, and shown', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'Field 2' })]);
  const A = await open(browser, id, '&view=week&date=2026-10-22');
  const B = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(A.page, ev(A.page, 'p'), true);
  await A.page.getByTestId('card-details').focus();
  await expect(A.page.getByTestId('card-details')).toBeFocused();
  await openCard(B.page, ev(B.page, 'p'), true);
  await B.page.getByTestId('card-details').fill('Field 2 is closed: gym instead');
  await B.page.getByTestId('card-done').click();
  await soon(async () => (await stored(id))[0].description).toBe('Field 2 is closed: gym instead');
  await expect(A.page.getByTestId('card-details'), "A's untouched details follow B's").toHaveValue('Field 2 is closed: gym instead');
  await A.page.getByTestId('card-done').click();
  await A.page.waitForTimeout(1500);
  expect((await stored(id))[0].description).toBe('Field 2 is closed: gym instead');
  await A.ctx.close(); await B.ctx.close();
});

test('F03 [card] data-loss: a new event with details but no title is kept on Done, as "(No title)"', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  const at = await slot(page, '2026-10-27', 9);
  await page.mouse.click(at.x, at.y + 6);
  await expect(card(page)).toBeVisible();
  await page.getByTestId('card-more').click();
  await page.getByTestId('card-details').fill('Room 204, bring the signed forms');
  await page.getByTestId('card-done').click();
  await page.waitForTimeout(1200);
  await shot(page, 'F03-untitled-event-discarded');
  const rows = await stored(id);
  expect(rows.map((e) => [e.title, e.description]), 'Done keeps what was typed (as "(No title)", like quick add)').toEqual([['(No title)', 'Room 204, bring the signed forms']]);
  await ctx.close();
});

test('F03b [card] drag a new event, press Enter without a title: it is added as "(No title)"; a click outside an empty one adds nothing', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  const a = await slot(page, '2026-10-27', 9), b = await slot(page, '2026-10-27', 11);
  await page.mouse.move(a.x, a.y + 6); await page.mouse.down();
  await page.mouse.move(b.x, b.y - 6, { steps: 8 }); await page.mouse.up();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId('card-title')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeHidden();
  await expect(page.locator('.nc').getByText('(No title)')).toBeVisible();
  await page.waitForTimeout(1200);
  expect((await stored(id)).map((e) => e.title), 'Enter adds the dragged event').toEqual(['(No title)']);
  const c = await slot(page, '2026-10-29', 14);
  await page.mouse.click(c.x, c.y + 6);
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300);   // past the card's entrance, as a person would be
  await page.mouse.click(5, 5);
  await expect(card(page)).toBeHidden();
  await page.waitForTimeout(1200);
  expect((await stored(id)).length, 'a click outside an empty new card adds nothing').toBe(1);
  await ctx.close();
});

test('F03c [card] More details opens a centered modal over a scrim (as classic); the quick card has no "Edited" line', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-30T15:00:00-07:00', '2026-10-30T16:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27', { colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
  await openCard(page, ev(page, 'p'));
  await expect(page.getByTestId('card-edited')).toHaveCount(0);
  await expect(card(page)).not.toContainText('Edited');
  await shot(page, 'F03c-quick');
  await page.getByTestId('card-more').click();
  await expect(page.getByTestId('card-start-date')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, 'F03c-full-modal');
  await expect(page.getByTestId('card-scrim')).toBeVisible();
  const b = await card(page).boundingBox();
  expect(Math.abs(b.x + b.width / 2 - 720), 'centered across the window').toBeLessThan(4);
  expect(b.y, 'top on screen').toBeGreaterThanOrEqual(0);
  expect(b.y + b.height, 'bottom on screen').toBeLessThanOrEqual(900);
  expect(b.width, 'a comfortable width').toBeGreaterThanOrEqual(640);
  await ctx.close();
});

test('F03d [card] the next new event starts with the type the last one was added with; an untouched empty one is still dropped', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  let at = await slot(page, '2026-10-27', 9);
  await page.mouse.click(at.x, at.y + 6);
  await expect(card(page)).toBeVisible();
  await page.keyboard.type('Standup');
  await page.getByTestId('card-type').click();
  await picker(page).locator('[data-t="3"]').click();
  await page.getByTestId('card-done').click();
  await expect(card(page)).toBeHidden();
  await page.waitForTimeout(1200);
  const first = (await stored(id))[0];
  expect(Number(first.type), 'picked a type other than the first').not.toBe(1);
  at = await slot(page, '2026-10-28', 9);
  await page.mouse.click(at.x, at.y + 6);
  await expect(card(page)).toBeVisible();
  await page.keyboard.type('Review');
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeHidden();
  at = await slot(page, '2026-10-29', 9);
  await page.mouse.click(at.x, at.y + 6);
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300);   // past the card's entrance, as a person would be (as F03b)
  await page.mouse.click(5, 5);
  await expect(card(page)).toBeHidden();
  await page.waitForTimeout(1200);
  const rows = await stored(id);
  expect(rows.map((e) => [e.title, Number(e.type)]).sort(), 'Review has Standup\'s type; the empty one is not added').toEqual([['Review', Number(first.type)], ['Standup', Number(first.type)]]);
  await ctx.close();
});

test('F03e [grid] back-to-back events read as two (a gap between them) and a strip on the right of the day stays free to add another at the same time', async ({ browser }) => {
  const id = await seed([timed('a', 'First', '2026-10-27T13:30:00-07:00', '2026-10-27T14:30:00-07:00'),
    timed('b', 'Second', '2026-10-27T14:30:00-07:00', '2026-10-27T15:30:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27', { colorScheme: 'dark' });
  await ev(page, 'a').scrollIntoViewIfNeeded();
  const a = await ev(page, 'a').boundingBox(), b = await ev(page, 'b').boundingBox();
  await shot(page, 'F03e-gap-and-gutter');
  expect(b.y - (a.y + a.height), 'a visible gap between back-to-back events').toBeGreaterThanOrEqual(2);
  const col = await page.evaluate(({ x, y }) => { const el = document.elementsFromPoint(x, y).find((e) => e.matches && e.matches('.nc-col, [class*="nc-day-col"], .nc-time-col')); const r = el && el.getBoundingClientRect(); return r ? { x: r.x, width: r.width } : null; }, { x: a.x + 2, y: a.y + 2 });
  const right = col ? col.x + col.width : a.x + a.width + 20;
  expect(right - (a.x + a.width), 'a free strip on the right of the day').toBeGreaterThanOrEqual(10);
  await page.mouse.click(right - 4, a.y + a.height / 2);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute('aria-label', 'New event');
  await ctx.close();
});

test('F04 [repeat] Custom… "Ends On" shows the date it will end on, and stores exactly that date', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'), true);
  await openCustom(page);
  await custom(page).getByTestId('custom-end-until').check();
  await shot(page, 'F04-ends-on-date');
  const shown = (await custom(page).getByTestId('custom-until').innerText()).trim();
  expect(shown, 'choosing "On" shows the date it will end on').toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  // What is stored ends on that very date (UNTIL is the chosen day's local midnight, classic's form).
  const until = async () => { const r = (await stored(id))[0].recurrencerule || ''; const m = /UNTIL=(\d{8}T\d{6}Z)/.exec(r);
    return m && page.evaluate((u) => new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +u.slice(9, 11), +u.slice(11, 13))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), m[1]); };
  await soon(until).toBe(shown);
  await expect(page.getByTestId('card-repeat')).toContainText(`until ${shown.replace(/, \d{4}$/, '')}`);
  await ctx.close();
});

test('F07-F10 [card] titles stay exactly as typed and the event stays where it was made ("Black Friday", "Party 9pm-1am", "John 3:16", "Mass Sat 5:30", ...)', async ({ browser }) => {
  // The card reads no times out of a title (typed times are the quick add's, Cmd/Ctrl+E).
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  const titles = ['Black Friday', 'Cyber Monday', 'Here comes the sun', 'Party 9pm-1am', 'Night shift 10p-6a', 'Bible study John 3:16', 'Room 4a', 'Mass Sat 5:30'];
  const at = titles.map((t, i) => [['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'][i % 4], i < 4 ? 9 : 13]);
  for (const [i, t] of titles.entries()) {
    await quickAdd(page, at[i][0], at[i][1], t);
    await soon(async () => (await stored(id)).length).toBe(i + 1);
  }
  await shot(page, 'F07-titles-as-typed');
  const rows = await stored(id);
  for (const [i, t] of titles.entries()) {
    const e = rows.find((r) => r.title === t);
    expect(e, `"${t}" is stored as typed`).toBeTruthy();
    expect(await local(page, e.start), t).toBe(`${at[i][0]} ${String(at[i][1]).padStart(2, '0')}:00`);
    expect(new Date(e.end) - new Date(e.start), `${t}: the hour it was made with`).toBe(3600e3);
  }
  await ctx.close();
});

test('F11 [card] typing an end time before the start ("1a" for an 11 PM event) means after midnight, the next day', async ({ browser }) => {
  const id = await seed([timed('l', 'Late show', '2026-10-27T23:00:00-07:00', '2026-10-27T23:30:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  await openCard(page, ev(page, 'l'), true);
  await typeInto(page, 'card-end-time', '1a');
  await page.waitForTimeout(400);
  await shot(page, 'F11-end-1am-refused');
  await expect(picker(page), 'the time was taken').toHaveCount(0, { timeout: 1500 });
  await soon(async () => local(page, (await stored(id))[0].end), 3000).toBe('2026-10-28 01:00');
  await ctx.close();
});

test('F12 [card] "jan 5" typed in the start date (in October) moves the event to the coming January', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'), true);
  await typeInto(page, 'card-start-date', 'jan 5');
  await soon(async () => (await stored(id))[0].start).not.toBe(iso('2026-10-22T17:00:00-07:00'));
  await shot(page, 'F12-jan-5-in-the-past');
  expect(await local(page, (await stored(id))[0].start)).toBe('2027-01-05 17:00');
  await ctx.close();
});

test('F13 [card] on the spring-forward day the time list does not offer 2:00-2:45 AM, which do not exist', async ({ browser }) => {
  const id = await seed([timed('m', 'Spring', '2026-03-08T01:00:00-08:00', '2026-03-08T01:30:00-08:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-03-08');
  await page.getByTestId('early-hours').click();
  await openCard(page, ev(page, 'm'));
  await page.getByTestId('card-q-s').click();
  await expect(picker(page)).toBeVisible();
  await shot(page, 'F13-dst-missing-hour-offered');
  const labels = await picker(page).locator('.nk-plist button').allInnerTexts();
  expect(labels.filter((t) => /^2:\d\d AM/.test(t)), 'no 2:xx AM on Mar 8 in Los Angeles').toEqual([]);
  // Typed, it is refused (not quietly stored as 3:30 AM).
  await picker(page).getByTestId('picker-input').fill('2:30a');
  await picker(page).getByTestId('picker-input').press('Enter');
  await expect(picker(page).getByTestId('picker-input')).toHaveClass(/bad/);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  expect(await local(page, (await stored(id))[0].start)).toBe('2026-03-08 01:00');
  await ctx.close();
});

test('F14 [card] ugly: deleting an event with a long title makes a toast ten lines tall over the calendar', async ({ browser }) => {
  const id = await seed([timed('p', 'Long title '.repeat(45).trim(), '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'));
  await page.getByTestId('card-delete').click();
  await expect(toast(page)).toBeVisible();
  await shot(page, 'F14-long-title-toast');
  expect((await toast(page).first().boundingBox()).height, 'a toast stays a line or two').toBeLessThan(80);
  await ctx.close();
});

test('F15 [card] a 2,000-character title cut to 500 says so (as details do when they trim a paste)', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  const at = await slot(page, '2026-10-27', 11);
  await page.mouse.click(at.x, at.y + 6);
  await expect(card(page)).toBeVisible();
  const long = 'x'.repeat(2000);
  await page.getByTestId('card-title').fill(long);
  await shot(page, 'F15-title-cut-silently');
  const kept = (await page.getByTestId('card-title').inputValue()).length;
  const said = await card(page).getByText(/characters/).count();
  expect(kept === 2000 || said > 0, `kept ${kept} characters and said nothing`).toBe(true);
  await ctx.close();
});

test('F17 [card] ugly: on a phone with the keyboard up, the focused details box runs under the footer and the keyboard', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'line\n'.repeat(12).trim() })]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { phone: true });
  await tapCard(page, ev(page, 'p'), true);
  await page.getByTestId('card-details').tap();
  await page.keyboard.press('Control+End');
  await page.evaluate(() => {   // the on-screen keyboard: 336px of the 844px window
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 844 - 336 });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(500);
  await shot(page, 'F17-phone-keyboard-details-under-footer');
  const ta = await box(page, '[data-testid="card-details"]'), foot = await box(page, '.nk-foot');
  expect(ta.bottom, 'the details box ends above the footer').toBeLessThanOrEqual(foot.y + 1);
  await ctx.close();
});

test('F19 [card] nit (a11y): "More details" drops keyboard focus to <body>', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'));
  await page.getByTestId('card-more').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('card-start-date')).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement.closest('.nk-card')), 'focus stays in the card').toBe(true);
  await ctx.close();
});

test('F22 [card] ugly: at 200% zoom (640x400) the full card hides the details box under its footer', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'Bring water' })]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { viewport: { width: 640, height: 400 } });
  await openCard(page, ev(page, 'p'), true);
  await shot(page, 'F22-zoom200-details-hidden');
  const ta = await box(page, '[data-testid="card-details"]'), foot = await box(page, '.nk-foot');
  expect(foot.y - ta.y, 'at least two lines of details show above the footer').toBeGreaterThanOrEqual(40);
  await ctx.close();
});

test('F23 [card] nit: on a phone the date picker\'s hint is cut off ("Type a date: Oct 20, Fri, tom")', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { phone: true });
  await tapCard(page, ev(page, 'p'), true);
  await page.getByTestId('card-start-date').tap();
  await expect(picker(page)).toBeVisible();
  await shot(page, 'F23-date-hint-cut');
  const fits = await picker(page).getByTestId('picker-input').evaluate((i) => { const v = i.value; i.value = i.placeholder; const ok = i.scrollWidth <= i.clientWidth; i.value = v; return ok; });
  expect(fits).toBe(true);
  await ctx.close();
});

// ---- what it looks like: nasty data in every size (findings from the visual sweep) -----------------------------
// 20 events in one hour, 40 all-day events on one day, emoji / CJK / RTL titles, the long-details fixture's board meeting.
function nastyEvents() {
  const names = ['Standup', '会議 チーム 打ち合わせ', 'اجتماع الفريق الأسبوعي', '🎉 Party 🎂', 'Very long overlapping meeting title', 'שיעור עברית', '1:1', 'Sync'];
  const out = [];
  for (let i = 0; i < 20; i++) out.push(timed(`ov${i}`, `${names[i % names.length]} ${i}`, '2026-10-19T10:00:00-07:00', '2026-10-19T11:00:00-07:00', { type: (i % 8) + 1 }));
  for (let i = 0; i < 40; i++) out.push({ ...timed(`ad${i}`, `${['Holiday', '休日', 'عطلة', '🏖️ Beach', 'Conference day with a long name'][i % 5]} ${i}`, '2026-10-21T00:00:00-07:00', '2026-10-22T00:00:00-07:00'), isAllDay: true, type: (i % 8) + 1 });
  out.push(timed('board', 'Board meeting', '2026-10-21T10:00:00-07:00', '2026-10-21T11:30:00-07:00', { description: 'Zoom: https://zoom.us/j/1234567890?pwd=abc123\nAgenda: https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit' }));
  out.push(timed('meet', 'Meeting minutes', '2026-10-20T13:00:00-07:00', '2026-10-20T14:00:00-07:00', { type: 5 }));
  out.push(timed('dent', 'Dentist appointment', '2026-10-22T15:00:00-07:00', '2026-10-22T16:00:00-07:00'));
  out.push(timed('rtl', 'اجتماع الفريق الأسبوعي مع الإدارة', '2026-10-24T16:00:00-07:00', '2026-10-24T17:00:00-07:00', { type: 3 }));
  return out;
}
const contrast = (page, sel) => page.evaluate((s) => {
  const lum = (c) => { const [R, G, B] = c.match(/[\d.]+/g).slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
  const bg = (e) => { for (; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return 'rgb(255, 255, 255)'; };
  return [...document.querySelectorAll(s)].filter((e) => e.textContent.trim()).map((e) => { const a = lum(getComputedStyle(e).color), b = lum(bg(e)); return { text: e.textContent.trim().slice(0, 20), ratio: +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2) }; });
}, sel);

test('F24 [grid] ugly: 20 events in the same hour are drawn as 20 unreadable slivers ("1", "1", …) with no "+N more"', async ({ browser }) => {
  const id = await seed(nastyEvents());
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21');
  await ev(page, 'ov0').first().scrollIntoViewIfNeeded();
  await shot(page, 'F24-twenty-overlapping-slivers');
  const widths = await page.evaluate(() => [...document.querySelectorAll('.nc [data-testid^="event-ov"]')].map((e) => e.getBoundingClientRect().width));
  const more = await page.locator('.nc').getByText(/^\+\d+/).count();
  expect(Math.min(...widths) >= 40 || more > 0, `narrowest of ${widths.length} is ${Math.round(Math.min(...widths))}px, no "+N more"`).toBe(true);
  await ctx.close();
});

test('F25 [grid] ugly: 40 all-day events on one day stretch the week\'s all-day row over the whole screen (month view says "+40 more")', async ({ browser }) => {
  const id = await seed(nastyEvents());
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'F25-all-day-row-fills-screen');
  const span = await page.evaluate(() => { const r = [...document.querySelectorAll('.nc [data-testid^="event-ad"]')].map((e) => e.getBoundingClientRect()); return Math.max(...r.map((b) => b.bottom)) - Math.min(...r.map((b) => b.top)); });
  expect(span, 'the all-day row stays under a third of the window').toBeLessThan(800 / 3);
  await ctx.close();
});

test('F26 [grid] ugly: on a phone, week-view event titles are cut mid-word with no ellipsis ("Meetii", "Dentis")', async ({ browser }) => {
  const id = await seed(nastyEvents());
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21', { phone: true });
  await ev(page, 'meet').first().scrollIntoViewIfNeeded();
  await shot(page, 'F26-phone-week-titles-cut');
  const cut = await page.evaluate(() => [...document.querySelectorAll('.nc-timed *')].filter((e) => e.children.length === 0 && e.textContent.trim() && e.scrollWidth > e.clientWidth + 1
    && getComputedStyle(e).textOverflow !== 'ellipsis').map((e) => e.textContent.trim().slice(0, 16)));
  expect(cut, 'titles that do not fit end with …').toEqual([]);
  await ctx.close();
});

test('F27 [card] ugly: an Arabic title in the card is cut at its START (shows "تماع الفريق…", the first word clipped); the title box is not dir="auto"', async ({ browser }) => {
  const id = await seed(nastyEvents());
  for (const colorScheme of ['light', 'dark']) {
    const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21', { colorScheme });
    await openCard(page, ev(page, 'rtl'), true);
    await shot(page, `F27-rtl-title-clipped-${colorScheme}`);
    const dir = await page.getByTestId('card-title').evaluate((i) => getComputedStyle(i).direction);
    await ctx.close();
    expect(dir, `${colorScheme}: an RTL title is laid out right to left`).toBe('rtl');
  }
});

test('F28 [card] ugly: on a 360x640 phone the length menu and "All day" run to the screen edge, past the card\'s right margin', async ({ browser }) => {
  const id = await seed(nastyEvents());
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21', { phone: true });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.waitForTimeout(300);
  await tapCard(page, ev(page, 'board'), true);
  await shot(page, 'F28-p360-length-at-edge');
  // The details as shown: the links view when they hold links (the text box is hidden then), else the text box.
  const [len, det] = await Promise.all([box(page, '[data-testid="card-length"]'), page.evaluate(() => { const e = [...document.querySelectorAll('[data-testid="card-details-view"], [data-testid="card-details"]')].find((x) => x.getClientRects().length); const r = e && e.getBoundingClientRect(); return r ? { right: r.right } : null; })]);
  expect(det.right, 'the details are on screen').toBeGreaterThan(200);
  expect(len.right, 'the length menu lines up with the details box').toBeLessThanOrEqual(det.right + 1);
  await ctx.close();
});

test('F29 [card] ugly: on a 360x640 phone the end-date picker shows only the first two weeks; the rest of the month is cut off', async ({ browser }) => {
  const id = await seed(nastyEvents());
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21', { phone: true });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.waitForTimeout(300);
  await tapCard(page, ev(page, 'board'), true);
  await page.getByTestId('card-end-date').tap();
  await expect(picker(page)).toBeVisible();
  await page.waitForTimeout(250);
  await shot(page, 'F29-p360-end-date-cut');
  const [last, pk] = await Promise.all([picker(page).locator('[data-d="2026-10-31"]').boundingBox(), box(page, '.nk-pick')]);
  expect(last && last.y + last.height, 'Oct 31 is in view').toBeLessThanOrEqual(pk.bottom + 0.5);
  await ctx.close();
});

test('F30 [card] nit: in light mode the picked item (blue on pale blue, 4.05:1) and "until 11:30 AM" (3.84:1) are under the 4.5:1 contrast for text', async ({ browser }) => {
  const id = await seed(nastyEvents());
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21');
  await openCard(page, ev(page, 'board'), true);
  await page.getByTestId('card-length').click();
  await expect(picker(page)).toBeVisible();
  await shot(page, 'F30-light-contrast-length');
  const low = (await contrast(page, '.nk-pick .cur, .nk-pick small')).filter((c) => c.ratio < 4.5);
  expect(low).toEqual([]);
  await ctx.close();
});

test('F31 [card] broken: the Undo toast from a delete sits on top of the next card\'s Done (desktop) and "More details" (phone)', async ({ browser }) => {
  for (const phone of [false, true]) {
    const id = await seed([timed('c', 'Charlie', '2026-10-22T09:00:00-07:00', '2026-10-22T10:00:00-07:00'), timed('d', 'Delta', '2026-10-22T14:00:00-07:00', '2026-10-22T15:00:00-07:00')]);
    const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { phone });
    if (phone) await tapCard(page, ev(page, 'c')); else await openCard(page, ev(page, 'c'));
    await page.getByTestId('card-delete').click();
    await expect(toast(page)).toBeVisible();
    if (phone) await tapCard(page, ev(page, 'd')); else await openCard(page, ev(page, 'd'));
    await expect(toast(page)).toBeVisible();
    await shot(page, `F31-toast-over-done-${phone ? 'phone' : 'desktop'}`);
    const hit = await page.evaluate(() => { const t = document.querySelector('.pc-toast').getBoundingClientRect();
      return [...document.querySelectorAll('.nk-foot button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width && r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top; }).map((b) => b.textContent.trim() || b.getAttribute('aria-label')); });
    await ctx.close();
    expect(hit, `${phone ? 'phone' : 'desktop'}: nothing in the card's footer is under the toast`).toEqual([]);
  }
});

// =====================================================================================================
// Checked and found right.
// =====================================================================================================

// One test per device, color scheme and locale, so the eight run side by side.
for (const dev of ['desk', 'phone']) for (const scheme of ['light', 'dark']) for (const loc of ['us', 'de']) {
  test(`look sweep: desktop and phone, light and dark, en-US and de-DE (24-hour, Monday first): card and every picker on screen, no sideways scroll, dark follows the system (${dev}, ${scheme}, ${loc})`, async ({ browser }) => {
    const z = loc === 'de' ? '+02:00' : '-07:00';
    const id = await seed([timed('p', 'Practice at Lincoln Field with the whole under-12 squad', `2026-10-22T17:00:00${z}`, `2026-10-22T18:00:00${z}`, { description: 'Bring water https://example.org/a' })]);
    const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22', { phone: dev === 'phone', colorScheme: scheme,
      locale: loc === 'de' ? 'de-DE' : 'en-US', timezoneId: loc === 'de' ? 'Europe/Berlin' : 'America/Los_Angeles', settings: loc === 'de' ? { timeFormat: '24', firstDayOfWeek: '1' } : null });
    const tag = `look-${dev}-${scheme}-${loc}`, [W, H] = dev === 'phone' ? [390, 844] : [1280, 800];
    expect(await page.evaluate(() => document.documentElement.dataset.theme), tag).toBe(scheme);
    if (dev === 'phone') await tapCard(page, ev(page, 'p'), true); else await openCard(page, ev(page, 'p'), true);
    if (loc === 'de') await expect(page.getByTestId('card-start-time'), tag).toHaveText('17:00');
    await shot(page, `${tag}-full`);
    expect(inside(await box(page, '.nk-card'), W, H), `${tag}: card on screen`).toBe(true);
    for (const f of ['card-start-time', 'card-start-date', 'card-end-date', 'card-length', 'card-type', 'card-repeat']) {
      await page.getByTestId(f).click();
      await expect(picker(page)).toBeVisible();
      await page.waitForTimeout(150);
      if (f === 'card-start-date') await shot(page, `${tag}-${f}`);
      expect(inside(await box(page, '.nk-pick'), W, H), `${tag}: ${f} picker on screen`).toBe(true);
      if (f === 'card-start-date' && loc === 'de') await expect(picker(page).locator('.nk-month b').first()).toHaveText('M');
      if (f === 'card-repeat') {
        // Custom… opens the repeat's settings inside the card; Escape closes them (and only them).
        await picker(page).getByTestId('picker-custom').click();
        await expect(custom(page)).toBeVisible();
        await page.waitForTimeout(150);
        await shot(page, `${tag}-custom`);
        expect(inside(await box(page, '.nk-card'), W, H), `${tag}: card with Custom on screen`).toBe(true);
        expect(inside(await box(page, '[data-testid="card-custom"]'), W, H), `${tag}: Custom on screen`).toBe(true);
        if (loc === 'de') expect(await custom(page).locator('.nk-wd button').first().getAttribute('aria-label')).toBe('Monday');
        expect(await page.evaluate(() => [...document.querySelectorAll('.nk-cust select, .nk-cust input')].map((e) => getComputedStyle(e).colorScheme).filter((c) => !c.includes(document.documentElement.dataset.theme))), `${tag}: form controls follow the theme`).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(custom(page)).toHaveCount(0);
        await expect(card(page), `${tag}: Escape closed only the repeat settings`).toBeVisible();
        continue;
      }
      await page.keyboard.press('Escape');
      await expect(picker(page)).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${tag}: no sideways scroll`).toBeLessThanOrEqual(W);
    expect(errors, tag).toEqual([]);
    await ctx.close();
  });
}

test('small windows: 1024x600 and 900x500 keep the card, Done and the pickers on screen; events at the top and bottom of the day', async ({ browser }) => {
  const id = await seed([
    timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'line\n'.repeat(12).trim() }),
    timed('e', 'Edge late', '2026-10-24T22:30:00-07:00', '2026-10-24T23:30:00-07:00'),
    timed('s', 'Edge early', '2026-10-18T00:00:00-07:00', '2026-10-18T01:00:00-07:00'),
  ]);
  for (const [W, H] of [[1024, 600], [900, 500]]) {
    const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22', { viewport: { width: W, height: H } });
    await openCard(page, ev(page, 'p'), true);
    for (const f of ['card-start-date', 'card-repeat']) {
      await page.getByTestId(f).click();
      expect(inside(await box(page, '.nk-pick'), W, H), `${W}x${H} ${f}`).toBe(true);
      await page.keyboard.press('Escape');
    }
    expect(inside(await box(page, '.nk-done'), W, H), `${W}x${H}: Done on screen`).toBe(true);
    await page.getByTestId('card-done').click();
    await page.getByTestId('early-hours').click();
    for (const k of ['e', 's']) {
      await ev(page, k).first().scrollIntoViewIfNeeded();
      await openCard(page, ev(page, k), true);
      await shot(page, `small-${W}x${H}-edge-${k}`);
      expect(inside(await box(page, '.nk-card'), W, H), `${W}x${H} ${k}: card on screen`).toBe(true);
      await page.getByTestId('card-done').click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(W);
    expect(errors).toEqual([]);
    await ctx.close();
  }
});

test('offline: a rename made offline shows on the calendar, and reaches the server on reconnect', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'));
  await ctx.setOffline(true);
  await page.getByTestId('card-title').fill('Offline rename');
  await page.getByTestId('card-title').press('Enter');
  await page.getByTestId('card-done').click();
  await expect(ev(page, 'p')).toContainText('Offline rename');
  expect((await stored(id))[0].title).toBe('Practice');
  await ctx.setOffline(false);
  await soon(async () => (await stored(id))[0].title, 20_000).toBe('Offline rename');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('repeating: Cancel after "all events" + "Yes, match the series" restores the series and its edited occurrence exactly; delete all + Undo too; a series dragged across Nov 1 keeps its clock time', async ({ browser }) => {
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-20');
  const occ = () => page.locator('.nc-timed', { hasText: 'Weekly sync' }).first();
  const snap = async () => (await stored(id)).map((e) => [e.id, e.title, e.start, e.end, e.recurrenceID, e.recurrenceException, e.recurrencerule]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  await openCard(page, occ());
  await page.getByTestId('card-title').fill('Weekly sync (moved room)');
  await page.getByTestId('card-title').press('Enter');
  await pickScope(page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  await page.getByTestId('card-done').click();
  const before = await snap();
  await page.goto(`/${id}?backend=cf&cal=native&view=week&date=2026-10-27`);
  await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(300);
  await openCard(page, occ(), true);
  await typeInto(page, 'card-start-time', '2p');
  await pickScope(page, 'all');
  await page.getByTestId('confirm-yes').click();
  await soon(async () => (await stored(id)).length).toBe(1);
  await page.getByTestId('card-cancel').click();
  await soon(snap).toEqual(before);
  // Delete all, Undo.
  await openCard(page, occ());
  await page.getByTestId('card-delete').click();
  await pickScope(page, 'all');
  await soon(async () => (await stored(id)).length).toBe(0);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await soon(snap).toEqual(before);
  // Drag Tue Oct 27 10 AM to Wed 11 AM, all events, keep the edited one: Nov 4 (after DST ends) is at 11 AM.
  const colW = (await page.locator('.nc-col').first().boundingBox()).width, b = await occ().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(b.x + b.width / 2 + colW * i / 10, b.y + b.height / 2 + HOUR * i / 10); await page.waitForTimeout(15); }
  await page.mouse.up();
  await pickScope(page, 'all');
  await page.getByTestId('confirm-no').click();
  await soon(async () => (await stored(id)).find((e) => e.id === 'w').recurrencerule).toBe('FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;');
  await page.goto(`/${id}?backend=cf&cal=native&view=week&date=2026-11-04`);
  await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.nc-timed', { hasText: 'Weekly sync' })).toContainText('11:00 AM');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('rapid input: ten Ctrl+Z after three changes put back exactly what was there (nothing else touched); fast open/close 15 times saves nothing; double-click opens the full card', async ({ browser }) => {
  const id = await seed([
    timed('a', 'Alpha', '2026-10-20T09:00:00-07:00', '2026-10-20T10:00:00-07:00'),
    timed('b', 'Bravo', '2026-10-22T13:00:00-07:00', '2026-10-22T14:00:00-07:00'),
  ]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const before = JSON.stringify(await stored(id));
  for (let i = 0; i < 15; i++) { await ev(page, i % 2 ? 'a' : 'b').first().click(); await page.keyboard.press('Escape'); }
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(JSON.stringify(await stored(id))).toBe(before);
  await ev(page, 'b').first().dblclick();
  await expect(page.getByTestId('card-start-date')).toBeVisible();
  await page.getByTestId('card-title').fill('Bravo 2'); await page.getByTestId('card-title').press('Enter');
  await soon(async () => (await stored(id)).find((e) => e.id === 'b').title).toBe('Bravo 2');
  await page.getByTestId('card-length').click(); await picker(page).locator('[data-len="120"]').click();
  await page.getByTestId('card-type').click(); await picker(page).locator('[data-t="3"]').click();
  await soon(async () => (await stored(id)).find((e) => e.id === 'b').type).toBe(3);
  await page.getByTestId('card-done').click();
  for (let i = 0; i < 10; i++) await page.keyboard.press('Control+z');
  await soon(async () => JSON.stringify(await stored(id))).toBe(before);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('keyboard: Tab stays in the card through every control (each with a name); Escape closes only the top layer (menu, picker, Custom, the "this event / all events" question)', async ({ browser }) => {
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-20');
  await openCard(page, page.locator('.nc-timed', { hasText: 'Weekly sync' }), true);
  await page.getByTestId('card-title').focus();
  const seen = [];
  for (let i = 0; i < 16; i++) {
    seen.push(await page.evaluate(() => { const a = document.activeElement; return a.closest('.nk-card') ? (a.getAttribute('aria-label') || a.textContent.trim()) : 'OUTSIDE'; }));
    await page.keyboard.press('Tab');
  }
  expect(seen).not.toContain('OUTSIDE');
  expect(seen.filter((s) => !s)).toEqual([]);
  expect(seen.slice(0, 15)).toEqual(['Title', 'Type: Practice', 'Start date: Tue, Oct 20', 'Start time: 10 AM', 'All day', 'End date: same day, Tue, Oct 20', 'End time: 11 AM',
    'Length: 1h', 'Time zone: Pacific Time', 'Repeats: Every Tuesday', 'Details', 'Delete', 'More actions', 'Cancel', 'Done']);
  await page.getByTestId('card-more-actions').click();
  await expect(page.getByTestId('card-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('card-menu')).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await openCustom(page);
  await page.keyboard.press('Escape');
  await expect(custom(page)).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await page.getByTestId('card-title').fill('Weekly sync X');
  await page.getByTestId('card-title').press('Enter');
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId('card-title')).toHaveValue('Weekly sync');
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(600);
  expect((await stored(id)).map((e) => [e.title, e.recurrenceException])).toEqual([['Weekly sync', null]]);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('text round trip: emoji, Arabic, Hebrew and Japanese titles; details with newlines, links and markup are stored exactly and classic shows them', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-27');
  const titles = ['🎉 Party 🎂👨‍👩‍👧', 'اجتماع الفريق الأسبوعي', 'שיעור עברית', '会議 チーム 打ち合わせ'];
  for (const [i, t] of titles.entries()) {
    const at = await slot(page, '2026-10-28', 13 + i);
    await page.mouse.click(at.x, at.y + 6);
    await expect(page.getByTestId('card-title')).toBeFocused();
    await page.keyboard.insertText(t);
    await page.keyboard.press('Enter');
    await expect(card(page)).toHaveCount(0);
  }
  await soon(async () => (await stored(id)).map((e) => e.title).sort()).toEqual(['Practice', ...titles].sort());
  await page.goto(`/${id}?backend=cf&cal=native&view=week&date=2026-10-22`);
  await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 20_000 });
  await openCard(page, ev(page, 'p'), true);
  const det = 'Line one\nhttps://example.org/x?a=1&b=2\n\n  indented  \n<b>not bold</b>';
  await page.getByTestId('card-details').fill(det);
  await page.getByTestId('card-title').click();
  await soon(async () => (await stored(id)).find((e) => e.id === 'p').description).toBe(det);
  await page.getByTestId('card-done').click();
  // Classic reads what native wrote.
  const cctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'America/Los_Angeles' });
  await cctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await cctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const cp = await cctx.newPage();
  const cerr = []; cp.on('pageerror', (e) => cerr.push(e.message));
  await cp.goto(`/${id}?backend=cf&date=2026-10-28`);
  await cp.waitForFunction(() => window.scheduleObj && document.querySelector('.e-appointment'), null, { timeout: 30_000 });
  await expect(cp.locator('.e-appointment', { hasText: 'Party' })).toHaveCount(1);
  expect(cerr).toEqual([]);
  await cctx.close();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('Custom… limits: 0 becomes 1, 5000 becomes 999, an end before the start is refused with a message, Monday-first weekday buttons', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22', { settings: { firstDayOfWeek: '1' } });
  const rule = async () => (await stored(id))[0].recurrencerule;
  await openCard(page, ev(page, 'p'), true);
  await openCustom(page);
  expect(await custom(page).locator('.nk-wd button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')))).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  // (Number fields are saved when they are left.)
  await custom(page).getByTestId('custom-interval').fill('0');
  await custom(page).getByTestId('custom-interval').press('Tab');
  await custom(page).getByTestId('custom-end-count').check();
  await custom(page).getByTestId('custom-count').fill('0');
  await custom(page).getByTestId('custom-count').press('Tab');
  await soon(rule).toBe('FREQ=WEEKLY;BYDAY=TH;INTERVAL=1;COUNT=1;');
  await expect(page.getByTestId('card-repeat')).toHaveText(/Every Thursday, 1 time$/);
  // An end before the start: the date picker refuses it and says why; nothing is stored.
  await custom(page).getByTestId('custom-until').click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByTestId('picker-input').fill('10/1');
  await picker(page).getByTestId('picker-input').press('Enter');
  await expect(custom(page).getByTestId('custom-error')).toHaveText('The repeat ends before the event starts.');
  if (!(await picker(page).locator('[data-d="2026-10-01"]').count())) await picker(page).getByTestId('picker-prev').click();
  await expect(picker(page).locator('[data-d="2026-10-01"]'), 'days before the start cannot be picked').toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  expect(await rule()).toBe('FREQ=WEEKLY;BYDAY=TH;INTERVAL=1;COUNT=1;');
  await custom(page).getByTestId('custom-unit').selectOption('MONTHLY');
  await custom(page).getByTestId('custom-month-day').fill('31');
  await custom(page).getByTestId('custom-month-day').press('Tab');
  await custom(page).getByTestId('custom-interval').fill('5000');
  await custom(page).getByTestId('custom-interval').press('Tab');
  await custom(page).getByTestId('custom-end-never').check();
  await soon(rule).toBe('FREQ=MONTHLY;BYMONTHDAY=31;INTERVAL=999;');
  await expect(custom(page).getByTestId('custom-error')).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('performance: 2,000 events and a daily series since 2024; the card opens in under 50 ms, 50 opens leave no listeners and little memory behind', async ({ browser }) => {
  test.setTimeout(180_000);
  const evs = [];
  for (let i = 0; i < 2000; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + (i % 60), 15 + (i % 8), (i % 4) * 15));
    evs.push(timed(`e${i}`, `Event ${i}`, d, new Date(d.getTime() + 3600e3), { type: (i % 8) + 1 }));
  }
  evs.push(timed('daily', 'Daily standup', '2024-01-01T09:00:00-08:00', '2024-01-01T09:15:00-08:00', { recurrencerule: 'FREQ=DAILY;INTERVAL=1;' }));
  const id = await seed(evs);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const cdp = await ctx.newCDPSession(page);
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
  const listeners = async () => { const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' }); return (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.length; };
  const target = page.locator('.nc-timed', { hasText: 'Daily standup' }).first();
  await target.scrollIntoViewIfNeeded();
  await target.click(); await expect(card(page)).toBeVisible(); await page.keyboard.press('Escape'); await expect(card(page)).toHaveCount(0);
  const [h0, l0] = [await heap(), await listeners()];
  const ms = [];
  for (let i = 0; i < 50; i++) {
    ms.push(await target.evaluate(async (el) => {
      const s = performance.now(); el.click();
      await new Promise((r) => { if (document.querySelector('.nk-card')) return r(); const ob = new MutationObserver(() => { if (document.querySelector('.nk-card')) { ob.disconnect(); r(); } }); ob.observe(document.body, { childList: true, subtree: true }); });
      return performance.now() - s;
    }));
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
  }
  const [h1, l1] = [await heap(), await listeners()];
  ms.sort((a, b) => a - b);
  test.info().annotations.push({ type: 'perf', description: `open median ${ms[25].toFixed(1)} ms, max ${ms[49].toFixed(1)} ms; heap ${(h0 / 1e6).toFixed(1)} -> ${(h1 / 1e6).toFixed(1)} MB; window listeners ${l0} -> ${l1}` });
  expect(ms[25], 'median open').toBeLessThan(50);
  expect(l1, 'window listeners').toBe(l0);
  expect(h1 - h0, 'heap growth after 50 opens').toBeLessThan(8e6);
  expect((await stored(id)).length).toBe(2001);
  expect(errors).toEqual([]);
  await ctx.close();
});
