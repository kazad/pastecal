// @ts-check
/**
 * Second stress pass on the native event card and grid (nativecal/components/EventCard.js, cardKit.js, NativeCalendar.js,
 * app.js nativeCard*), after the first pass's fixes (editor-stress.spec.js). A fresh tester, aimed at what changed:
 * per-event time zones, the inline Custom… repeat, the "+N" chips, Option-drag copy, two browsers, IME typing.
 * Every check is made against what the SERVER stored (GET /cal/<id>) as well as the screen.
 *
 *   - "S<n> ..." tests are FINDINGS: each asserts what a person expects and is marked expected-to-fail (finding()),
 *     so the suite stays green. RAW = true runs them as plain tests, to see each fail at its own assertion.
 *     When one is fixed it passes, Playwright reports an unexpected pass, and its finding() line comes out.
 *   - The other tests pin what this pass checked and found right.
 * Screenshots land in cloudflare/test-results/editor-stress-2/.
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh); run with scripts/test-on-box.sh editor-stress-2.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SHOTS = path.join(__dirname, '..', 'test-results', 'editor-stress-2');
fs.mkdirSync(SHOTS, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';   // Saturday Oct 24 2026, Los Angeles
const HOUR = 48;                            // NativeCalendar's hour height
const iso = (s) => new Date(s).toISOString();
const LABELS = ['Practice', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];
const timed = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
const WEEKLY = 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'long-descriptions.json'), 'utf8'));

let n = 0;
async function seed(events, options = {}) {
  const id = `es2-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Editor stress 2', options: { typeLabels: LABELS, ...options }, events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const byId = async (id, eid) => (await stored(id)).find((e) => e.id === eid);
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100] });
// A finding: expected to fail until fixed. RAW = true runs the findings as plain tests, to see each fail where it should.
const RAW = false;
const finding = (why) => { if (!RAW) test.fail(true, why); };
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});

const DEVICES = {
  desk: { viewport: { width: 1280, height: 800 } },
  small: { viewport: { width: 1024, height: 600 } },
  zoom: { viewport: { width: 640, height: 400 } },
  ipad: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  p360: { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true },
};
/** A browser at a fixed time. o: device (DEVICES key), colorScheme, locale, timezoneId, settings (pastecal_global_settings), classic, platform. */
async function open(browser, id, query = '', o = {}) {
  const { device = 'desk', timezoneId = 'America/Los_Angeles', settings = null, colorScheme = 'light', locale = 'en-US', classic = false } = o;
  const ctx = await browser.newContext({ ...DEVICES[device], timezoneId, locale, colorScheme });
  await ctx.addInitScript((g) => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); if (g) localStorage.setItem('pastecal_global_settings', JSON.stringify(g)); } catch (e) { /* blocked */ } }, settings);
  if (o.platform) await ctx.addInitScript((p) => {   // (a Windows or Mac keyboard: navigator.platform, no userAgentData)
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => p, configurable: true });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true });
  }, o.platform);
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(o.now || NOW) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${id}?backend=cf${classic ? '' : '&cal=native'}${query}`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  if (!classic) await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const card = (page) => page.getByTestId('event-card');
const picker = (page) => page.getByTestId('card-picker');
const toast = (page) => page.locator('.pc-toast');
const ev = (page, id) => page.locator(`.nc [data-testid="event-${id}"]`);
const isTouch = (page) => page.evaluate(() => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
async function openCard(page, locator, full = false) {
  const touch = await isTouch(page);
  if (touch) await locator.first().tap(); else await locator.first().click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300);   // past the card's 180 ms entrance
  if (full) {
    if (touch) await page.getByTestId('card-more').tap(); else await page.getByTestId('card-more').click();
    await expect(page.getByTestId('card-start-date')).toBeVisible();
    await page.waitForTimeout(300);
  }
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
/** Local wall-clock "YYYY-MM-DD HH:MM" of a stored instant, in the browser's zone. */
const local = (page, v) => page.evaluate((x) => { const d = new Date(x); const p = (k) => String(k).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }, v);
/** The point at a time of day in a day's column of the week grid. */
async function slot(page, ymd, h) {
  const ms = await page.evaluate((s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }, ymd);
  const col = page.locator(`.nc-col[data-day="${ms}"]`);
  await col.scrollIntoViewIfNeeded();
  const b = await col.boundingBox();
  const first = await page.evaluate(() => parseInt(document.querySelector('.nc-hour-label').textContent, 10) || 5);
  return { x: b.x + b.width / 2, y: b.y + (h - first) * HOUR };
}
const box = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; }, sel);
const inside = (b, w, h) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.right <= w + 0.5 && b.bottom <= h + 0.5;

// =====================================================================================================
// Findings. Each: finding() + the assertion a person expects.
// =====================================================================================================

test('S01 [tz] data-loss: a Tokyo event at 2:30 AM on the day Los Angeles springs forward reads 3:30 AM (0m long) to an LA viewer, and changing its length moves it an hour', async ({ browser }) => {
  finding('EventZone.toWallDate builds the wall clock as a LOCAL Date: 2:30 AM does not exist on Mar 8 in Los Angeles, so it becomes 3:30');
  // Sun Mar 8 2026, 2:30-3:30 AM in Tokyo = Sat Mar 7 9:30-10:30 AM in Los Angeles (17:30Z-18:30Z).
  const id = await seed([timed('jp', 'Tokyo call', '2026-03-07T17:30:00Z', '2026-03-07T18:30:00Z', { tz: 'Asia/Tokyo' })]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-03-07');
  await openCard(page, ev(page, 'jp'), true);
  await shot(page, 'S01-tokyo-0230-reads-0330');
  const shown = [await page.getByTestId('card-start-time').innerText(), await page.getByTestId('card-end-time').innerText(), await page.getByTestId('card-length').innerText()];
  // Change only the length (1h -> 2h): the start must not move.
  await page.getByTestId('card-length').click();
  await picker(page).locator('[data-len="120"]').click();
  await soon(async () => (await byId(id, 'jp')).end).not.toBe(iso('2026-03-07T18:30:00Z'));
  const row = await byId(id, 'jp');
  expect({ shown, start: row.start, end: row.end }, 'the card shows 2:30-3:30 AM Tokyo (1h); the new length keeps the start').toEqual({
    shown: ['2:30 AM', '3:30 AM', '1h'], start: iso('2026-03-07T17:30:00Z'), end: iso('2026-03-07T19:30:00Z') });
  await ctx.close();
});

test('S02 [tz] broken: viewed from Tokyo, an LA event on LA\'s spring-forward day offers 2:00-2:45 AM, and "2:30a" is quietly stored as 3:30 AM', async ({ browser }) => {
  finding('the DST-gap filter (EventCard timeList / typedTime) checks the viewer\'s zone, not the event\'s');
  // Sun Mar 8 2026, 1:00-1:30 AM in Los Angeles (09:00Z): 6 PM in Tokyo.
  const id = await seed([timed('la', 'LA early', '2026-03-08T09:00:00Z', '2026-03-08T09:30:00Z', { tz: 'America/Los_Angeles' })]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-03-08', { timezoneId: 'Asia/Tokyo' });
  await openCard(page, ev(page, 'la'), true);
  await expect(page.getByTestId('card-start-time')).toHaveText('1:00 AM');
  await page.getByTestId('card-start-time').click();
  await expect(picker(page)).toBeVisible();
  await shot(page, 'S02-tokyo-viewer-la-gap-offered');
  const gap = (await picker(page).locator('.nk-plist button').allInnerTexts()).filter((t) => /^2:\d\d AM/.test(t));
  await picker(page).getByTestId('picker-input').fill('2:30a');
  await picker(page).getByTestId('picker-input').press('Enter');
  await page.waitForTimeout(800);
  const row = await byId(id, 'la');
  expect({ gap, start: row.start }, 'no 2:xx AM on Mar 8 in Los Angeles; typed, it is refused (the event stays at 1 AM)').toEqual({ gap: [], start: iso('2026-03-08T09:00:00Z') });
  await ctx.close();
});

test('S03 [drag] data-loss: an Option-drag copy of a Tokyo-zoned event loses its time zone (Duplicate keeps it)', async ({ browser }) => {
  finding('app.js nativeDropCopy builds the copy without Tz');
  const id = await seed([timed('jp', 'Tokyo standup', '2026-10-27T17:00:00Z', '2026-10-27T18:00:00Z', { tz: 'Asia/Tokyo' })]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  const b = await ev(page, 'jp').first().boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(b.x + b.width / 2, b.y + 8); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2, b.y + 8 + HOUR * 2 * i / 8);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await soon(async () => (await stored(id)).length).toBe(2);
  const copy = (await stored(id)).find((e) => e.id !== 'jp');
  await openCard(page, ev(page, copy.id), true);
  await shot(page, 'S03-copy-lost-zone');
  expect({ start: copy.start, tz: copy.tz || '' }, 'the copy is 2h later, still in Tokyo time').toEqual({ start: iso('2026-10-27T19:00:00Z'), tz: 'Asia/Tokyo' });
  await ctx.close();
});

test('S04 [repeat] data-loss: another browser renames the series while I am asked "this event / all events"; my "this event" keeps their new name', async ({ browser }) => {
  finding('nativeCardWrite("this") writes the card\'s whole stale value (Subject from before the rename), not just what I changed');
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY })]);
  const A = await open(browser, id, '&view=week&date=2026-10-20');
  const B = await open(browser, id, '&view=week&date=2026-10-20');
  await openCard(A.page, A.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
  await typeInto(A.page, 'card-q-s', '12p');
  await expect(A.page.getByTestId('scope-this')).toBeVisible();   // A is asked; B renames the series meanwhile
  await openCard(B.page, B.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
  await B.page.getByTestId('card-title').fill('Team sync');
  await B.page.getByTestId('card-title').press('Enter');
  await pickScope(B.page, 'all');
  await B.page.getByTestId('card-done').click();
  await soon(async () => (await byId(id, 'w')).title).toBe('Team sync');
  await A.page.waitForTimeout(1000);
  await pickScope(A.page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  await A.page.getByTestId('card-done').click();
  await shot(A.page, 'S04-this-event-stale-title');
  const child = (await stored(id)).find((e) => e.recurrenceID === 'w');
  expect([child.title, await local(A.page, child.start)], 'only the time I changed is mine; the title is the series\' new one').toEqual(['Team sync', '2026-10-20 12:00']);
  await A.ctx.close(); await B.ctx.close();
});

test('S05 [card]: on an 11 PM - midnight event, typing the end "11:30p" ends it at 11:30 PM (it made it 24h 30m long)', async ({ browser }) => {
  const id = await seed([timed('l', 'Late show', '2026-10-27T23:00:00-07:00', '2026-10-28T00:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  await openCard(page, ev(page, 'l'));
  await typeInto(page, 'card-q-e', '11:30p');
  await soon(async () => (await byId(id, 'l')).end).not.toBe(iso('2026-10-28T00:00:00-07:00'));
  await shot(page, 'S05-end-1130p-next-day');
  expect(await local(page, (await byId(id, 'l')).end)).toBe('2026-10-27 23:30');
  await ctx.close();
});

test('S06 [card] (CJK): the Enter that confirms an IME conversion and the Escape that cancels one leave a new event open and unsaved (they saved it mid-word, and threw it away)', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27', { locale: 'ja-JP' });
  const at = await slot(page, '2026-10-27', 10);
  await page.mouse.click(at.x, at.y + 6);
  await expect(page.getByTestId('card-title')).toBeFocused();
  // Mid-conversion: the text so far, then the Enter a Japanese keyboard sends to confirm it (Chrome: isComposing, 229).
  await page.keyboard.insertText('かいぎ');
  const ime = (key) => page.getByTestId('card-title').evaluate((el, k) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: 229, which: 229, isComposing: true, bubbles: true, cancelable: true }));
  }, key);
  await ime('Enter');
  await page.waitForTimeout(600);
  const afterEnter = { open: await card(page).count(), saved: (await stored(id)).length };
  if (!afterEnter.open) { await page.mouse.click(at.x, at.y + 6); await expect(page.getByTestId('card-title')).toBeFocused(); await page.keyboard.insertText('かいぎ'); }
  await ime('Escape');
  await page.waitForTimeout(400);
  const afterEsc = { open: await card(page).count(), title: afterEnter.open ? await page.getByTestId('card-title').inputValue().catch(() => null) : null };
  await shot(page, 'S06-ime-enter-escape');
  expect({ afterEnter, afterEscOpen: afterEsc.open }, 'confirming or cancelling a conversion leaves the new event open and unsaved').toEqual({ afterEnter: { open: 1, saved: 0 }, afterEscOpen: 1 });
  await ctx.close();
});

test('S07 [grid]: on a 390px phone a crowded hour is one "+20" across the day, never a 20px sliver beside "+19" (the grid promises events never narrower than 40px)', async ({ browser }) => {
  const evs = [];
  for (let i = 0; i < 20; i++) evs.push(timed(`ov${i}`, `Standup ${i}`, '2026-10-21T10:00:00-07:00', '2026-10-21T11:00:00-07:00', { type: (i % 8) + 1 }));
  const id = await seed(evs);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21', { device: 'phone' });
  await page.getByTestId('more-timed').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, 'S07-phone-sliver-beside-plus19');
  const widths = await page.evaluate(() => [...document.querySelectorAll('.nc .nc-timed[data-testid^="event-ov"]')].filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().width)));
  const more = await page.evaluate(() => [...document.querySelectorAll('.nc [data-testid="more-timed"]')].filter((e) => e.getClientRects().length).map((e) => ({ n: e.textContent.trim(), w: Math.round(e.getBoundingClientRect().width) })));
  expect(Math.min(...widths), `shown: ${widths.join(', ')}px`).toBeGreaterThanOrEqual(40);
  // Every one of the 20 is accounted for: drawn, or counted in a "+N" at least 40px wide.
  expect({ all: widths.length + more.reduce((t, m) => t + Number(m.n.replace('+', '')), 0), narrowMore: more.filter((m) => m.w < 40) }).toEqual({ all: 20, narrowMore: [] });
  // A tap on it opens the day, wide enough to draw them side by side (then "+N" for the rest).
  await page.getByTestId('more-timed').first().tap();
  await expect(page.locator('.nc .nc-timed[data-testid^="event-ov"]:visible').first()).toBeVisible();
  await ctx.close();
});

test('S08 [card] (de-DE): a German date typed in the date picker ("28.10.", "28.10.2026", "5/11") is read day first (it was refused)', async ({ browser }) => {
  const id = await seed([timed('p', 'Training', '2026-10-22T17:00:00+02:00', '2026-10-22T18:00:00+02:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { locale: 'de-DE', timezoneId: 'Europe/Berlin', settings: { timeFormat: '24', firstDayOfWeek: '1' } });
  await openCard(page, ev(page, 'p'), true);
  await typeInto(page, 'card-start-date', '28.10.');
  await page.waitForTimeout(500);
  await shot(page, 'S08-de-date-refused');
  await soon(async () => local(page, (await byId(id, 'p')).start)).toBe('2026-10-28 17:00');
  await typeInto(page, 'card-start-date', '29.10.2026');
  await soon(async () => local(page, (await byId(id, 'p')).start)).toBe('2026-10-29 17:00');
  await typeInto(page, 'card-start-date', '5/11');   // day first in de-DE: Nov 5
  await soon(async () => local(page, (await byId(id, 'p')).start)).toBe('2026-11-05 17:00');
  await ctx.close();
});

test('S09 [tz] broken: classic and native show a Tokyo-zoned weekly series on different days (classic repeats it in the viewer\'s zone)', async ({ browser }) => {
  finding('ScheduleAdapter hands Syncfusion the rule as is: classic expands BYDAY=TU in Los Angeles, native in Tokyo');
  // Every Tuesday 10 AM in Tokyo = Monday 6 PM in Los Angeles.
  const id = await seed([timed('jp', 'Tokyo standup', '2026-10-20T01:00:00Z', '2026-10-20T01:30:00Z', { tz: 'Asia/Tokyo', recurrencerule: WEEKLY })]);
  const N = await open(browser, id, '&view=week&date=2026-10-27');
  const native = await N.page.evaluate(() => [...document.querySelectorAll('.nc .nc-timed')].map((e) => e.closest('.nc-col')?.dataset.day).filter(Boolean).map((d) => new Date(+d).toDateString()));
  await N.ctx.close();
  const C = await open(browser, id, '&view=week&date=2026-10-27', { classic: true });
  await C.page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-appointment'), null, { timeout: 30_000 });
  const classic = await C.page.evaluate(() => window.scheduleObj.getEvents(new Date(2026, 9, 25), new Date(2026, 10, 1), true).map((e) => new Date(e.StartTime).toString().slice(0, 21)));
  await shot(C.page, 'S09-classic-tokyo-series-day');
  expect({ native, classic }, 'both: Monday Oct 26, 6 PM in Los Angeles').toEqual({ native: ['Mon Oct 26 2026'], classic: ['Mon Oct 26 2026 18:00'] });
  await C.ctx.close();
});

test('S10 [card]: on a 360x640 phone, "More details" on an event with long linked details keeps the event\'s own title in the sheet (it scrolled it away)', async ({ browser }) => {
  const links = FIXTURE.events.find((e) => e.id === 'links');
  const id = await seed([timed('p', 'Practice at Lincoln Field', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: links.description })]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { device: 'p360' });
  await openCard(page, ev(page, 'p'), true);
  await shot(page, 'S10-p360-title-scrolled-away');
  const [t, c] = await Promise.all([box(page, '[data-testid="card-title"]'), box(page, '.nk-card')]);
  expect(t.y, 'the title is inside the sheet').toBeGreaterThanOrEqual(c.y - 1);
  await ctx.close();
});

test('S11 [card]: a title of more than three lines (emoji, CJK) shows exactly three, the third fading (it showed a sliver of the fourth)', async ({ browser }) => {
  const id = await seed([timed('p', '🎉 会議 チーム 打ち合わせ — اجتماع الفريق الأسبوعي — a very long planning session title that keeps going and going past three lines of the card 🎉 会議 チーム 打ち合わせ — and more', '2026-10-22T13:00:00-07:00', '2026-10-22T14:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'));
  await page.getByTestId('card-title').evaluate((el) => el.blur());
  await page.locator('.nk-h').screenshot({ path: path.join(SHOTS, 'S11-title-fourth-line-sliver.png') });
  const lines = await page.getByTestId('card-title').evaluate((ta) => { const cs = getComputedStyle(ta); return (ta.clientHeight - parseFloat(cs.paddingTop)) / parseFloat(cs.lineHeight); });
  expect(Math.abs(lines - Math.round(lines)), `${lines.toFixed(2)} lines in view`).toBeLessThan(0.1);
  expect(Math.round(lines), 'three lines').toBe(3);
  // A sign that it goes on: the third line fades (and the whole title scrolls into view once focused).
  expect(await page.getByTestId('card-title').evaluate((ta) => { const cs = getComputedStyle(ta); return (cs.maskImage || cs.webkitMaskImage || 'none') !== 'none'; })).toBe(true);
  await ctx.close();
});

test('S12 [card] (a11y): the time, length and repeat lists say which is the current choice (aria-current; it was by color only), as the type list does', async ({ browser }) => {
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22');
  await openCard(page, ev(page, 'p'), true);
  const said = {};
  for (const f of ['card-start-time', 'card-length', 'card-repeat', 'card-type']) {
    await page.getByTestId(f).click();
    await expect(picker(page)).toBeVisible();
    said[f] = await picker(page).locator('.cur').first().evaluate((b) => b.getAttribute('aria-selected') === 'true' || !!b.getAttribute('aria-current'));
    await page.keyboard.press('Escape');
  }
  expect(said).toEqual({ 'card-start-time': true, 'card-length': true, 'card-repeat': true, 'card-type': true });
  await ctx.close();
});

// S14 (root 7): shortcuts are spelled by utils/keys.js for the keyboard in front of the reader.
for (const [platform, want] of [['Win32', { d: 'Ctrl+D', z: 'Ctrl+Z', alt: 'Alt' }], ['Linux x86_64', { d: 'Ctrl+D', z: 'Ctrl+Z', alt: 'Alt' }], ['MacIntel', { d: '⌘D', z: '⌘Z', alt: '⌥' }]]) {
  test(`S14 [card] on ${platform} the shortcuts sheet and the event menu say ${want.d} and ${want.z} (they said ⌘D and ⌘Z everywhere)`, async ({ browser }) => {
    const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
    const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { platform });
    expect(await page.evaluate(() => navigator.platform)).toBe(platform);
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-close')).toBeVisible();
    await shot(page, `S14-shortcuts-${platform.split(' ')[0]}`);
    const sheet = await page.getByTestId('shortcuts').innerText();
    expect(sheet).toContain('Duplicate');
    await page.keyboard.press('Escape');
    await openCard(page, ev(page, 'p'), true);
    await page.getByTestId('card-more-actions').click();
    const menu = await page.getByTestId('card-menu').innerText();
    const mac = platform === 'MacIntel';
    expect({ sheetD: sheet.includes(want.d), sheetZ: sheet.includes(want.z), sheetAlt: sheet.includes(`${want.alt} drag`), menuD: menu.includes(want.d),
      macSigns: /[⌘⌥]/.test(sheet + menu) }, sheet + '\n' + menu).toEqual({ sheetD: true, sheetZ: true, sheetAlt: true, menuD: true, macSigns: mac });
    await ctx.close();
  });
}

// =====================================================================================================
// Checked and found right.
// =====================================================================================================

test('S15 [sync] data-loss: A edits offline while B renames; when A reconnects, B\'s rename is undone (A\'s offline save carries the old title back)', async ({ browser }) => {
  finding('the reconnect write sends what A last saw for the event, not only the fields A changed');
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00'),
    timed('q', 'Game', '2026-10-23T17:00:00-07:00', '2026-10-23T18:00:00-07:00'), timed('r', 'Party', '2026-10-21T17:00:00-07:00', '2026-10-21T18:00:00-07:00')]);
  const A = await open(browser, id, '&view=week&date=2026-10-22');
  const B = await open(browser, id, '&view=week&date=2026-10-22');
  await A.ctx.setOffline(true);
  // Offline, A changes the type of "Practice" and renames "Game" (and never touches "Party").
  await openCard(A.page, ev(A.page, 'p'));
  await A.page.getByTestId('card-type').click();
  await picker(A.page).locator('[data-t="4"]').click();
  await A.page.getByTestId('card-done').click();
  await openCard(A.page, ev(A.page, 'q'));
  await A.page.getByTestId('card-title').fill('Game (away)');
  await A.page.getByTestId('card-title').press('Enter');
  await A.page.getByTestId('card-done').click();
  // Online, B renames "Practice" and "Party".
  for (const [k, t] of [['p', 'Practice (gym)'], ['r', 'Party (moved)']]) {
    await openCard(B.page, ev(B.page, k));
    await B.page.getByTestId('card-title').fill(t);
    await B.page.getByTestId('card-title').press('Enter');
    await B.page.getByTestId('card-done').click();
  }
  await soon(async () => (await stored(id)).map((e) => e.title).sort()).toEqual(['Game', 'Party (moved)', 'Practice (gym)']);
  await A.ctx.setOffline(false);
  await soon(async () => (await byId(id, 'q')).title, 20_000).toBe('Game (away)');
  await A.page.waitForTimeout(1500);
  await shot(A.page, 'S15-reconnect-undoes-rename');
  const rows = Object.fromEntries((await stored(id)).map((e) => [e.id, [e.title, e.type]]));
  expect(rows, "both people's changes are kept").toEqual({ p: ['Practice (gym)', 4], q: ['Game (away)', 1], r: ['Party (moved)', 1] });
  await A.ctx.close(); await B.ctx.close();
});

test('keyboard only: open an event, More details, the time zone picker by name, type "tokyo", Enter; the clock time is kept in Tokyo, Done', async ({ browser }) => {
  const id = await seed([timed('p', 'Standup', '2026-10-27T10:00:00-07:00', '2026-10-27T10:30:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-27');
  await ev(page, 'p').first().focus();
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeVisible();
  const tabTo = async (testid) => { for (let i = 0; i < 20; i++) { if (await page.evaluate((t) => document.activeElement?.dataset?.testid === t, testid)) return; await page.keyboard.press('Tab'); } throw new Error(`no Tab reaches ${testid}`); };
  await tabTo('card-more'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('card-tz-button')).toHaveAccessibleName('Time zone: Pacific Time');
  await tabTo('card-tz-button'); await page.keyboard.press('Enter');
  await expect(picker(page)).toBeVisible();
  await page.keyboard.type('tokyo');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('card-tz-button')).toHaveAccessibleName('Time zone: Japan Time');
  await soon(async () => (await byId(id, 'p')).tz).toBe('Asia/Tokyo');
  expect((await byId(id, 'p')).start, '10 AM, now in Tokyo').toBe(iso('2026-10-27T10:00:00+09:00'));
  await tabTo('card-done'); await page.keyboard.press('Enter');
  await expect(card(page)).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

/** Light boxes on a dark page: visible elements in `root` whose own background is light (luminance > 0.5). */
const lightBoxes = (page, root) => page.evaluate((sel) => {
  const lum = (c) => { const v = (c.match(/[\d.]+/g) || []).map(Number); if (v.length > 3 && v[3] < 0.3) return 0; const [R, G, B] = v.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
  return [...document.querySelectorAll(sel)].flatMap((r) => [r, ...r.querySelectorAll('*')]).filter((e) => { const b = e.getBoundingClientRect(); return b.width > 4 && b.height > 4 && getComputedStyle(e).visibility !== 'hidden'; })
    .filter((e) => { const c = getComputedStyle(e).backgroundColor; return !/rgba\(0, 0, 0, 0\)|transparent/.test(c) && lum(c) > 0.5; })
    .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 3).join('.')} ${getComputedStyle(e).backgroundColor}`);
}, root);

for (const device of ['phone', 'p360', 'ipad', 'small', 'desk']) for (const how of ['system', 'setting', 'switched']) {
  // (Reported: white date and ⋮ buttons on a 390px phone in dark mode. Not reproduced in Chromium, in any of these ways;
  // WebKit, where iOS Safari would show it, cannot run on the test box.)
  test(`classic dark mode (${how}), ${device}: the toolbar, its date picker and ⋮ menu, pressed, hovered, focused and after a pick, have no light boxes`, async ({ browser }) => {
    const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
    const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-22', { device, colorScheme: how === 'system' ? 'dark' : 'light', classic: true,
      settings: how === 'setting' ? { darkMode: 'dark' } : null });
    await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-schedule .e-toolbar'), null, { timeout: 30_000 });
    if (how === 'switched') await page.evaluate(() => { document.querySelector('#app')._vnode.component.proxy.globalSettings.darkMode = 'dark'; });
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    test.info().annotations.push({ type: 'toolbar', description: await page.evaluate(() => [...document.querySelectorAll('.e-schedule .e-toolbar .e-toolbar-item')].map((e) => `${e.className}|${e.textContent.trim().slice(0, 20)}|${e.getClientRects().length}`).join(' ;; ')) });
    await shot(page, `S13-classic-dark-${how}-${device}-toolbar`);
    // Each toolbar button pressed, hovered and focused (a tap leaves :hover and :focus behind on a phone).
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '.e-schedule .e-toolbar .e-tbar-btn' });
    const states = [];
    for (const st of [['hover'], ['focus'], ['active'], ['hover', 'focus', 'focus-visible']]) {
      for (const id of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: st });
      await page.waitForTimeout(100);
      for (const b of await lightBoxes(page, '.e-schedule .e-toolbar')) states.push(`${st.join('+')}: ${b}`);
      if (st.length > 1) await shot(page, `S13-classic-dark-${how}-${device}-forced-states`);
      for (const id of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] });
    }
    const found = { toolbar: await lightBoxes(page, '.e-schedule .e-toolbar'), states };
    const tap = async (loc) => { if (DEVICES[device].hasTouch) await loc.tap(); else await loc.click(); };
    const dr = page.locator('.e-schedule .e-date-range').first();
    if (await dr.isVisible()) {
      await tap(dr);
      await page.waitForTimeout(500);
      await shot(page, `S13-classic-dark-${how}-${device}-datepicker`);
      found.datePicker = await lightBoxes(page, '.e-schedule-popup, .e-header-popup, .e-popup-open');
      // Pick a month: the popup closes, the button keeps focus (and hover, on a touch screen).
      const cell = page.locator('.e-header-popup .e-cell, .e-popup-open .e-cell').filter({ hasText: /Nov/ }).first();
      if (await cell.isVisible().catch(() => false)) await tap(cell); else await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await shot(page, `S13-classic-dark-${how}-${device}-after-pick`);
      found.afterPick = await lightBoxes(page, '.e-schedule .e-toolbar');
    }
    const more = page.locator('.e-schedule .e-toolbar .e-toolbar-right .e-toolbar-item:visible, .e-schedule .e-toolbar .e-hor-nav:visible').last();
    if (await more.isVisible().catch(() => false)) {
      await tap(more);
      await page.waitForTimeout(500);
      await shot(page, `S13-classic-dark-${how}-${device}-overflow`);
      found.overflow = await lightBoxes(page, '.e-toolbar-pop, .e-popup-open');
      const wk = page.locator('.e-toolbar-pop .e-toolbar-item:visible').filter({ hasText: 'Week' }).first();
      if (await wk.isVisible().catch(() => false)) {
        await tap(wk);
        await page.waitForTimeout(600);
        await shot(page, `S13-classic-dark-${how}-${device}-after-menu`);
        found.afterMenu = await lightBoxes(page, '.e-schedule .e-toolbar');
      }
    }
    expect(found, `${device}: nothing light on the dark page`).toEqual(Object.fromEntries(Object.keys(found).map((k) => [k, []])));
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

test('classic, dark mode reached other ways: the phone turns dark while the page is open; a view link and the home page at 390px dark', async ({ browser }) => {
  // (Probing the report of white date and ⋮ buttons in classic's toolbar on a dark phone.)
  const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-22', { device: 'phone', classic: true });
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-schedule .e-toolbar'), null, { timeout: 30_000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(1500);
  await shot(page, 'classic-turned-dark-phone');
  const sheet = await page.evaluate(() => [document.documentElement.dataset.theme, document.getElementById('syncfusion-theme')?.getAttribute('href')?.split('/').pop().split('?')[0]]);
  const light = await lightBoxes(page, '.e-schedule .e-toolbar');
  // A view link, and the home page.
  const view = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json();
  const out = { sheet, light };
  for (const [name, url] of [['home', '/?backend=cf'], ['view', view.publicViewId ? `/view/${view.publicViewId}?backend=cf` : null]]) {
    if (!url) continue;
    const c2 = await browser.newContext({ ...DEVICES.phone, colorScheme: 'dark', timezoneId: 'America/Los_Angeles' });
    await c2.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
    await c2.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
    const p2 = await c2.newPage();
    await p2.goto(url);
    await p2.waitForFunction(() => window.scheduleObj && document.querySelector('.e-schedule .e-toolbar'), null, { timeout: 30_000 }).catch(() => {});
    await p2.waitForTimeout(800);
    await shot(p2, `classic-dark-phone-${name}`);
    out[name] = await lightBoxes(p2, '.e-schedule .e-toolbar');
    await c2.close();
  }
  expect(out).toEqual({ sheet: ['dark', 'material-dark.css'], light: [], ...(out.home ? { home: [] } : {}), ...(out.view ? { view: [] } : {}) });
  expect(errors).toEqual([]);
  await ctx.close();
});

// =====================================================================================================
// Probes: screenshots across devices for the visual review (and what was checked and found right).
// =====================================================================================================

function nasty() {
  const out = [];
  const links = FIXTURE.events.find((e) => e.id === 'links');
  out.push(timed('board', links.title, `${links.when[0]}:00-07:00`, `${links.when[1]}:00-07:00`, { description: links.description }));
  out.push(timed('long', '🎉 会議 チーム 打ち合わせ — اجتماع الفريق الأسبوعي — a very long planning session title that keeps going and going past three lines of the card '.repeat(2).trim(),
    '2026-10-22T13:00:00-07:00', '2026-10-22T14:30:00-07:00', { description: 'line\n'.repeat(30).trim(), type: 5 }));
  out.push(timed('jp', 'Tokyo standup', '2026-10-20T01:00:00Z', '2026-10-20T01:30:00Z', { tz: 'Asia/Tokyo', recurrencerule: WEEKLY }));
  for (let i = 0; i < 6; i++) out.push({ ...timed(`ad${i}`, `Holiday ${i}`, '2026-10-23T00:00:00-07:00', '2026-10-24T00:00:00-07:00'), isAllDay: true, type: (i % 8) + 1 });
  for (let i = 0; i < 9; i++) out.push(timed(`ov${i}`, `Crowd ${i}`, '2026-10-21T15:00:00-07:00', '2026-10-21T16:00:00-07:00', { type: (i % 8) + 1 }));
  return out;
}

for (const [device, scheme, loc] of [['ipad', 'light', 'us'], ['ipad', 'dark', 'de'], ['zoom', 'dark', 'us'], ['small', 'light', 'de'], ['p360', 'dark', 'us'], ['phone', 'light', 'de']]) {
  test(`probe ${device} ${scheme} ${loc}: grid, full card, Custom…, zone picker on screen; no errors`, async ({ browser }) => {
    const id = await seed(nasty());
    const de = loc === 'de';
    const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-21', { device, colorScheme: scheme, locale: de ? 'de-DE' : 'en-US',
      timezoneId: de ? 'Europe/Berlin' : 'America/Los_Angeles', settings: de ? { timeFormat: '24', firstDayOfWeek: '1' } : null });
    const { width: W, height: H } = DEVICES[device].viewport;
    const tag = `probe-${device}-${scheme}-${loc}`;
    if (await page.getByTestId('early-hours').isVisible().catch(() => false)) await page.getByTestId('early-hours').click();
    // The crowded hour: its first event, or on a phone's week (too narrow for two side by side) its "+9".
    await page.locator('.nc [data-testid="event-ov0"], .nc [data-testid="more-timed"]').first().scrollIntoViewIfNeeded();
    await shot(page, `${tag}-grid`);
    for (const k of ['long', 'board', 'jp']) {
      await ev(page, k).first().scrollIntoViewIfNeeded();
      await openCard(page, ev(page, k), true);
      await shot(page, `${tag}-${k}-full`);
      expect(inside(await box(page, '.nk-card'), W, H), `${tag} ${k}: card on screen`).toBe(true);
      expect(inside(await box(page, '.nk-done'), W, H), `${tag} ${k}: Done on screen`).toBe(true);
      if (k === 'jp') {
        await page.getByTestId('card-tz-button').click();
        await expect(picker(page)).toBeVisible();
        await page.waitForTimeout(150);
        await shot(page, `${tag}-tz-picker`);
        expect(inside(await box(page, '.nk-pick'), W, H), `${tag}: zone picker on screen`).toBe(true);
        await page.keyboard.press('Escape');
        await page.getByTestId('card-repeat').click();
        await picker(page).getByTestId('picker-custom').click();
        await expect(page.getByTestId('card-custom')).toBeVisible();
        await page.waitForTimeout(200);
        await shot(page, `${tag}-custom`);
        expect(inside(await box(page, '.nk-done'), W, H), `${tag}: Done on screen with Custom open`).toBe(true);
        await page.keyboard.press('Escape');
      }
      await page.getByTestId('card-cancel').click();
      await expect(card(page)).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${tag}: no sideways scroll`).toBeLessThanOrEqual(W);
    expect(errors, tag).toEqual([]);
    await ctx.close();
  });
}

test('probe: right-click menu at the window edge, ? shortcuts on a phone, title of three lines', async ({ browser }) => {
  const id = await seed(nasty());
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-21', { viewport: { width: 1024, height: 600 }, device: 'small' });
  const b = await ev(page, 'ad0').first().boundingBox();
  await page.mouse.click(b.x + b.width - 2, b.y + 2, { button: 'right' });
  await page.waitForTimeout(300);
  await shot(page, 'probe-rightclick-allday');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await page.waitForTimeout(300);
  await shot(page, 'probe-shortcuts-1024');
  await ctx.close();
  const P = await open(browser, id, '&view=week&date=2026-10-21', { device: 'p360', colorScheme: 'dark' });
  await P.page.keyboard.press('?');
  await P.page.waitForTimeout(300);
  await shot(P.page, 'probe-shortcuts-p360-dark');
  expect(errors).toEqual([]);
  await P.ctx.close();
});
