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
const RAW = true;
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
/** A browser at a fixed time. o: device (DEVICES key), colorScheme, locale, timezoneId, settings (pastecal_global_settings), classic. */
async function open(browser, id, query = '', o = {}) {
  const { device = 'desk', timezoneId = 'America/Los_Angeles', settings = null, colorScheme = 'light', locale = 'en-US', classic = false } = o;
  const ctx = await browser.newContext({ ...DEVICES[device], timezoneId, locale, colorScheme });
  await ctx.addInitScript((g) => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); if (g) localStorage.setItem('pastecal_global_settings', JSON.stringify(g)); } catch (e) { /* blocked */ } }, settings);
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

test('S05 [card] broken: on an 11 PM - midnight event, typing the end "11:30p" makes it 24h 30m long instead of ending at 11:30 PM', async ({ browser }) => {
  finding('typedTime reads the end on the end\'s date (the next day) when the event ends at midnight');
  const id = await seed([timed('l', 'Late show', '2026-10-27T23:00:00-07:00', '2026-10-28T00:00:00-07:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-27');
  await openCard(page, ev(page, 'l'));
  await typeInto(page, 'card-q-e', '11:30p');
  await soon(async () => (await byId(id, 'l')).end).not.toBe(iso('2026-10-28T00:00:00-07:00'));
  await shot(page, 'S05-end-1130p-next-day');
  expect(await local(page, (await byId(id, 'l')).end)).toBe('2026-10-27 23:30');
  await ctx.close();
});

test('S06 [card] broken (CJK): Enter that confirms an IME conversion saves and closes a new event mid-word; Escape that cancels a conversion throws the event away', async ({ browser }) => {
  finding('EventCard: @keydown.enter and the window Escape handler ignore event.isComposing (keyCode 229)');
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

test('S07 [grid] ugly: on a 390px phone a crowded hour shows one 18px sliver beside "+19" (the grid promises events never narrower than 40px)', async ({ browser }) => {
  finding('layoutDayColumns cap is at least 2 even when a column fits one 40px event');
  const evs = [];
  for (let i = 0; i < 20; i++) evs.push(timed(`ov${i}`, `Standup ${i}`, '2026-10-21T10:00:00-07:00', '2026-10-21T11:00:00-07:00', { type: (i % 8) + 1 }));
  const id = await seed(evs);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-21', { device: 'phone' });
  await ev(page, 'ov0').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, 'S07-phone-sliver-beside-plus19');
  const widths = await page.evaluate(() => [...document.querySelectorAll('.nc .nc-timed[data-testid^="event-ov"]')].filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(Math.min(...widths), `shown: ${widths.join(', ')}px`).toBeGreaterThanOrEqual(40);
  await ctx.close();
});

test('S08 [card] broken (de-DE): a German date typed in the date picker ("28.10.", "28.10.2026") is refused', async ({ browser }) => {
  finding('cardKit.parseDate reads "." as a space and knows no day.month form');
  const id = await seed([timed('p', 'Training', '2026-10-22T17:00:00+02:00', '2026-10-22T18:00:00+02:00')]);
  const { ctx, page } = await open(browser, id, '&view=week&date=2026-10-22', { locale: 'de-DE', timezoneId: 'Europe/Berlin', settings: { timeFormat: '24', firstDayOfWeek: '1' } });
  await openCard(page, ev(page, 'p'), true);
  await typeInto(page, 'card-start-date', '28.10.');
  await page.waitForTimeout(500);
  await shot(page, 'S08-de-date-refused');
  await page.keyboard.press('Escape');
  expect(await local(page, (await byId(id, 'p')).start)).toBe('2026-10-28 17:00');
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
  out.push(timed('jp', 'Tokyo standup', '2026-10-20T17:00:00Z', '2026-10-20T17:30:00Z', { tz: 'Asia/Tokyo', recurrencerule: WEEKLY }));
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
    await ev(page, 'ov0').first().scrollIntoViewIfNeeded();
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
  const b = await ev(page, 'ad5').first().boundingBox();
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
