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
async function openCustom(page) {
  await page.getByTestId('card-repeat').click();
  await picker(page).getByTestId('picker-custom').click();
  await expect(picker(page).getByTestId('custom-apply')).toBeVisible();
}
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

test('F01 [card] data-loss: someone else renames an event while my card is open; my Done (no edits) puts the old title back', async ({ browser }) => {
  finding('F01: the focused title never takes the remote rename, and Done/blur commits the stale text over it');
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
  await A.page.waitForTimeout(1500);
  await shot(A.page, 'F01-stale-title-in-open-card');
  await A.page.getByTestId('card-done').click();   // A changed nothing
  await A.page.waitForTimeout(1500);
  expect((await stored(id))[0].title, "B's rename survives A closing an untouched card").toBe('Practice MOVED to gym');
  await A.ctx.close(); await B.ctx.close();
});

test('F02 [card] data-loss: an occurrence card left open while another browser moves the series "all events" saves "this event" at the OLD time', async ({ browser }) => {
  finding('F02: nativeCardRefresh copies only title/type/details/rule into an occurrence card, so its times and occurrenceStart go stale');
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY })]);
  const C = await open(browser, id, '&view=week&date=2026-10-20');
  const D = await open(browser, id, '&view=week&date=2026-10-20');
  await openCard(C.page, C.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
  await openCard(D.page, D.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
  await typeInto(D.page, 'card-q-s', '12p');
  await pickScope(D.page, 'all');
  await soon(async () => local(D.page, (await stored(id)).find((e) => e.id === 'w').start)).toBe('2026-10-06 12:00');
  await C.page.waitForTimeout(1500);
  await C.page.getByTestId('card-title').fill('Weekly sync (room 4)');
  await C.page.getByTestId('card-title').press('Enter');
  await pickScope(C.page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  await C.page.getByTestId('card-done').click();
  await shot(C.page, 'F02-occurrence-saved-at-old-time');
  const child = (await stored(id)).find((e) => e.recurrenceID === 'w');
  expect(await local(C.page, child.start), 'the renamed Oct 20 occurrence keeps the series\' new 12 PM time').toBe('2026-10-20 12:00');
  await C.ctx.close(); await D.ctx.close();
});

test('F03 [card] data-loss: a new event with details but no title is thrown away on Done, without a word', async ({ browser }) => {
  finding('F03: nativeCardDone drops a new event whose title is empty even when details, type or repeat were set');
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
  expect(rows.map((e) => e.description), 'Done keeps what was typed (as "(No title)", like quick add)').toEqual(['Room 204, bring the signed forms']);
  await ctx.close();
});

test('F04 [repeat] broken: Custom… "Ends On" shows an empty mm/dd/yyyy field, and Apply quietly stores a date two weeks out', async ({ browser }) => {
  finding('F04: openCustom fills `until` only when the rule already ends on a date; applyCustom invents start + 14 days');
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'), true);
  await openCustom(page);
  await picker(page).getByTestId('custom-end-until').check();
  await shot(page, 'F04-ends-on-empty-date');
  await expect(picker(page).getByTestId('custom-until'), 'choosing "On" shows the date it will end on').not.toHaveValue('');
  await ctx.close();
});

test('F05 [repeat] ugly: Custom… is built from raw browser controls (system select chevrons, mm/dd/yyyy date box), unlike the card\'s own pickers; "On the [fourth] [Thursday]" wraps', async ({ browser }) => {
  finding('F05: the Custom panel uses native <select>, <input type=date>, number spinners and radios ("dropdown looks weird")');
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  for (const colorScheme of ['light', 'dark']) {
    const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { colorScheme });
    await openCard(page, ev(page, 'p'), true);
    await openCustom(page);
    await picker(page).getByTestId('custom-unit').selectOption('MONTHLY');
    await shot(page, `F05-custom-raw-controls-${colorScheme}`);
    const raw = await page.evaluate(() => [...document.querySelectorAll('.nk-pick select, .nk-pick input[type=date]')]
      .filter((e) => getComputedStyle(e).appearance !== 'none').map((e) => e.dataset.testid));
    const [pos, day] = await Promise.all([picker(page).getByTestId('custom-setpos').boundingBox(), picker(page).getByTestId('custom-posday').boundingBox()]);
    await ctx.close();
    expect(raw, `${colorScheme}: no system-drawn select or date box in the card`).toEqual([]);
    expect(Math.abs(pos.y - day.y), `${colorScheme}: "On the [fourth] [Thursday]" on one line`).toBeLessThan(4);
  }
});

test('F06 [tz] broken: the time zone line is plain text; there is no way to set an event\'s time zone', async ({ browser }) => {
  finding('F06: card-tz is a static <div> ("Times are shown in your time zone"); the prototype has a zone picker and "Use mine"');
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'), true);
  await shot(page, 'F06-time-zone-not-a-control');
  const control = page.getByTestId('card-tz').locator('xpath=self::button | .//button');
  await expect(control.first(), 'the zone is a button').toBeVisible({ timeout: 2000 });
  await control.first().click();
  await expect(picker(page)).toBeVisible();
  await ctx.close();
});

test('F07 [card] broken: a new event titled "Black Friday" is saved as "Black" on next Friday', async ({ browser }) => {
  finding('F07: smartParse takes a trailing day name as a date and done() cuts it from the title');
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  await quickAdd(page, '2026-10-27', 9, 'Black Friday');
  await soon(async () => (await stored(id)).length).toBe(1);
  await shot(page, 'F07-black-friday');
  const [e] = await stored(id);
  expect([e.title, await local(page, e.start)]).toEqual(['Black Friday', '2026-10-27 09:00']);
  await ctx.close();
});

test('F08 [card] broken: "Party 9pm-1am" is saved 9-10 PM; a range past midnight loses its end', async ({ browser }) => {
  finding('F08: smartParse clamps an end before the start to start + 1h (or midnight) instead of the next day');
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  await quickAdd(page, '2026-10-28', 9, 'Party 9pm-1am');
  await soon(async () => (await stored(id)).length).toBe(1);
  await shot(page, 'F08-party-9pm-1am');
  const [e] = await stored(id);
  expect([e.title, await local(page, e.start), await local(page, e.end)]).toEqual(['Party', '2026-10-28 21:00', '2026-10-29 01:00']);
  await ctx.close();
});

test('F11 [card] broken: typing an end time before the start ("1a" for an 11 PM event) is refused instead of meaning after midnight', async ({ browser }) => {
  finding('F11: typedTime marks any same-day end <= start as bad; only the list\'s "12:00 AM (midnight)" or the end-date picker crosses midnight');
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

test('F12 [card] broken: "jan 5" typed in the start date (in October) moves the event nine months into the past', async ({ browser }) => {
  finding('F12: parseDate gives a month and day the shown year even when that date has passed');
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'), true);
  await typeInto(page, 'card-start-date', 'jan 5');
  await soon(async () => (await stored(id))[0].start).not.toBe(iso('2026-10-22T17:00:00-07:00'));
  await shot(page, 'F12-jan-5-in-the-past');
  expect(await local(page, (await stored(id))[0].start)).toBe('2027-01-05 17:00');
  await ctx.close();
});

test('F13 [card] broken: on the spring-forward day the time list offers 2:00-2:45 AM, which do not exist; picking 2:00 AM stores 3:00 AM', async ({ browser }) => {
  finding('F13: timeList steps minutes 0..1440 without skipping the missing hour; at() rolls 2:xx to 3:xx');
  const id = await seed([timed('m', 'Spring', '2026-03-08T01:00:00-08:00', '2026-03-08T01:30:00-08:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-03-08');
  await page.getByTestId('early-hours').click();
  await openCard(page, ev(page, 'm'));
  await page.getByTestId('card-q-s').click();
  await expect(picker(page)).toBeVisible();
  await shot(page, 'F13-dst-missing-hour-offered');
  const labels = await picker(page).locator('.nk-plist button').allInnerTexts();
  expect(labels.filter((t) => /^2:\d\d AM/.test(t)), 'no 2:xx AM on Mar 8 in Los Angeles').toEqual([]);
  await ctx.close();
});

test('F14 [card] ugly: a long title makes the "Added …" toast ten lines tall over the calendar', async ({ browser }) => {
  finding('F14: the toast prints the whole title; nothing clamps it');
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  await quickAdd(page, '2026-10-27', 11, 'Long title '.repeat(45).trim());
  await expect(toast(page)).toBeVisible();
  await shot(page, 'F14-long-title-toast');
  expect((await toast(page).first().boundingBox()).height, 'a toast stays a line or two').toBeLessThan(80);
  await ctx.close();
});

test('F15 [card] nit: a 2,000-character title is cut to 500 without a word (details say when they trim a paste)', async ({ browser }) => {
  finding('F15: the title input has maxlength=500 and no note; the server takes 20,000');
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

test('F16 [tz] ugly: All day hides the time zone line with visibility:hidden, leaving a blank row in the card', async ({ browser }) => {
  finding('F16: card-tz keeps its height when hidden for an all-day event');
  const id = await seed([{ ...timed('t', 'Trip', '2026-10-24T00:00:00-07:00', '2026-10-26T00:00:00-07:00'), isAllDay: true }]);
  const { ctx, page } = await open(browser, id, '&view=month&date=2026-10-22');
  await openCard(page, ev(page, 't'), true);
  await shot(page, 'F16-blank-row-all-day');
  const g = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const when = r('.nk-when'), rep = r('[data-testid="card-repeat"]').top, det = r('[data-testid="card-details"]').top;
    return { whenToRepeat: rep - when.bottom, repeatToDetails: det - rep };
  });
  expect(g.whenToRepeat, 'no more space above Repeat than between Repeat and Details').toBeLessThanOrEqual(g.repeatToDetails + 4);
  await ctx.close();
});

test('F17 [card] ugly: on a phone with the keyboard up, the focused details box runs under the footer and the keyboard', async ({ browser }) => {
  finding('F17: with visualViewport 508px tall, the 12-line details box ends ~100px below the sheet; keepCaret only scrolls the card');
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
  finding('F19: expand() removes the focused "More details" button and focuses nothing');
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
  finding('F22: the sheet is 328px tall; the footer covers the details box, which only shows its top border');
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: 'Bring water' })]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { viewport: { width: 640, height: 400 } });
  await openCard(page, ev(page, 'p'), true);
  await shot(page, 'F22-zoom200-details-hidden');
  const ta = await box(page, '[data-testid="card-details"]'), foot = await box(page, '.nk-foot');
  expect(foot.y - ta.y, 'at least two lines of details show above the footer').toBeGreaterThanOrEqual(40);
  await ctx.close();
});

test('F23 [card] nit: on a phone the date picker\'s hint is cut off ("Type a date: Oct 20, Fri, tom")', async ({ browser }) => {
  finding('F23: the placeholder is wider than the 240px picker');
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

// =====================================================================================================
// Checked and found right.
// =====================================================================================================

test('look sweep: desktop and phone, light and dark, en-US and de-DE (24-hour, Monday first): card and every picker on screen, no sideways scroll, dark follows the system', async ({ browser }) => {
  test.setTimeout(180_000);
  for (const dev of ['desk', 'phone']) for (const scheme of ['light', 'dark']) for (const loc of ['us', 'de']) {
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
        await picker(page).getByTestId('picker-custom').click();
        await page.waitForTimeout(150);
        await shot(page, `${tag}-custom`);
        expect(inside(await box(page, '.nk-pick'), W, H), `${tag}: Custom on screen`).toBe(true);
        if (loc === 'de') expect(await picker(page).locator('.nk-wd button').first().getAttribute('aria-label')).toBe('Monday');
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('.nk-cust select')).colorScheme), `${tag}: form controls follow the theme`).toBe(scheme);
      }
      await page.keyboard.press('Escape');
      await expect(picker(page)).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${tag}: no sideways scroll`).toBeLessThanOrEqual(W);
    expect(errors, tag).toEqual([]);
    await ctx.close();
  }
});

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

test('offline: a rename made offline shows saved, and reaches the server on reconnect', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'));
  await ctx.setOffline(true);
  await page.getByTestId('card-title').fill('Offline rename');
  await page.getByTestId('card-title').press('Enter');
  await page.getByTestId('card-done').click();
  await expect(toast(page)).toContainText('Renamed Offline rename');
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
  expect(seen.slice(0, 14)).toEqual(['Title', 'Type: Practice', 'Start date: Tue, Oct 20', 'Start time: 10 AM', 'All day', 'End date: same day, Tue, Oct 20', 'End time: 11 AM',
    'Length: 1h', 'Repeats: Every Tuesday', 'Details', 'Delete', 'More actions', 'Cancel', 'Done']);
  await page.getByTestId('card-more-actions').click();
  await expect(page.getByTestId('card-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('card-menu')).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await openCustom(page);
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
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
  expect(await picker(page).locator('.nk-wd button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')))).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  await picker(page).getByTestId('custom-interval').fill('0');
  await picker(page).getByTestId('custom-end-count').check();
  await picker(page).getByTestId('custom-count').fill('0');
  await picker(page).getByTestId('custom-apply').click();
  await soon(rule).toBe('FREQ=WEEKLY;BYDAY=TH;INTERVAL=1;COUNT=1;');
  await openCustom(page);
  await picker(page).getByTestId('custom-end-until').check();
  await picker(page).getByTestId('custom-until').fill('2026-10-01');
  await picker(page).getByTestId('custom-apply').click();
  await expect(picker(page).getByTestId('custom-error')).toHaveText('The repeat ends before the event starts.');
  await page.keyboard.press('Escape');
  await openCustom(page);
  await picker(page).getByTestId('custom-unit').selectOption('MONTHLY');
  await picker(page).getByTestId('custom-month-day').fill('31');
  await picker(page).getByTestId('custom-interval').fill('5000');
  await picker(page).getByTestId('custom-end-never').check();
  await picker(page).getByTestId('custom-apply').click();
  await soon(rule).toBe('FREQ=MONTHLY;BYMONTHDAY=31;INTERVAL=999;');
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
