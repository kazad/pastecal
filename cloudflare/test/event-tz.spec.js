// @ts-check
/**
 * An event's own time zone, on a native edit link (nativecal/components/EventCard.js, services/EventZone.js), driven
 * like a person and checked against what the SERVER saved (GET /cal/<id>):
 *   - the card's time zone line is a button; its list starts with "Use mine", searches every zone ("tokyo")
 *   - picking Tokyo keeps the date and clock time shown and means them in Tokyo (as Google Calendar does)
 *   - with Tokyo picked, "2:00 PM" typed means 2 PM in Tokyo: 05:00Z (Japan has no DST)
 *   - reopened, the card shows 2:00 PM Japan Time and the same times in the viewer's zone
 *   - a title edited in classic's editor keeps the zone
 *   - a weekly Tokyo meeting lands on Monday evening in Los Angeles, before and after Nov 1
 *   - all day: the line is gone, no gap
 * Screenshots of the card and its picker (light and dark, desktop 1280x800 and phone 390x844) go to SHOTS_DIR
 * (default cloudflare/test-results/tz-shots).
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';   // Saturday Oct 24 2026, Los Angeles
const SHOTS = process.env.SHOTS_DIR || require('path').join(__dirname, '../test-results/tz-shots');

let n = 0;
async function seed(events) {
  const id = `tz-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Time zones', options: {}, events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const byId = async (id, eid) => (await stored(id)).find((e) => e.id === eid);
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100] });

async function open(browser, id, query, { phone = false, colorScheme = 'light', classic = false } = {}) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'America/Los_Angeles', locale: 'en-US', colorScheme }
    : { viewport: { width: 1280, height: 800 }, timezoneId: 'America/Los_Angeles', locale: 'en-US', colorScheme });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(NOW) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${id}?backend=cf${classic ? '' : '&cal=native'}${query}`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 20_000 });
  if (!classic) await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const card = (page) => page.getByTestId('event-card');
const picker = (page) => page.getByTestId('card-picker');
async function openFull(page, eid) {
  await page.locator(`.nc [data-testid="event-${eid}"]`).first().click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(250);
  await page.getByTestId('card-more').click();
  await expect(page.getByTestId('card-start-date')).toBeVisible();
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

// Tue Oct 27 2026, 10:00-10:30 AM in Los Angeles (17:00Z).
const standup = () => ({ id: 'standup', title: 'Standup', description: '', start: '2026-10-27T17:00:00.000Z', end: '2026-10-27T17:30:00.000Z',
  type: 1, isAllDay: false, repeat: '', recurrencerule: '', recurrenceID: null, recurrenceException: null });

test('pick Tokyo, type 2:00 PM: stored as 05:00Z; reopened it reads 2:00 PM Japan Time and your time; a classic edit keeps the zone', async ({ browser }) => {
  const id = await seed([standup()]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-27');
  await openFull(page, 'standup');

  // The line: your zone, as a button.
  const tzb = page.getByTestId('card-tz-button');
  await expect(tzb).toHaveText('Pacific Time');
  await expect(page.getByTestId('card-tz-yours')).toHaveCount(0);
  await tzb.click();
  await expect(picker(page)).toBeVisible();
  const rows = picker(page).locator('.nk-plist button');
  await expect(rows.first()).toHaveText('Use mine (Pacific Time)');
  await expect(rows.first()).toHaveClass(/cur/);
  await expect(picker(page).locator('[data-tz="Asia/Tokyo"]')).toHaveText('Tokyo — Japan Time');
  await shot(page, 'tz-picker-desktop-light');
  // Search: every zone the browser knows, by place or name.
  await picker(page).getByTestId('picker-input').fill('tokyo');
  await expect(rows.first()).toHaveText('Tokyo — Japan Time');
  await picker(page).getByTestId('picker-input').fill('zzz');
  await expect(picker(page).getByTestId('picker-tz-none')).toBeVisible();
  await picker(page).getByTestId('picker-input').fill('tokyo');
  await rows.first().click();
  await expect(picker(page)).toHaveCount(0);

  // Tue 10:00 AM, now meant in Tokyo (01:00Z). Saved as you go.
  await soon(async () => (await byId(id, 'standup')).tz).toBe('Asia/Tokyo');
  expect((await byId(id, 'standup')).start).toBe('2026-10-27T01:00:00.000Z');
  await expect(tzb).toHaveText('Japan Time');
  await expect(page.getByTestId('card-start-time')).toHaveText(/^10:00 AM$/);
  await expect(page.getByTestId('card-tz-yours')).toHaveText('· Mon 6:00 PM – 6:30 PM your time');

  // 2:00 PM typed with Tokyo picked is 2 PM in Tokyo (standard time: 05:00Z). The length stays 30 minutes.
  await page.getByTestId('card-start-time').click();
  await picker(page).getByTestId('picker-input').fill('2:00 PM');
  await picker(page).getByTestId('picker-input').press('Enter');
  await soon(async () => (await byId(id, 'standup')).start).toBe('2026-10-27T05:00:00.000Z');
  expect((await byId(id, 'standup')).end).toBe('2026-10-27T05:30:00.000Z');
  await expect(page.getByTestId('card-tz-yours')).toHaveText('· Mon 10:00 PM – 10:30 PM your time');
  await shot(page, 'tz-card-desktop-light');
  await page.getByTestId('card-done').click();
  await expect(card(page)).toHaveCount(0);

  // Reopened: 2:00 PM, Japan Time, and Monday 10 PM here. The grid shows it in Los Angeles' time, Monday evening.
  const day = await page.locator('.nc [data-testid="event-standup"]').first().evaluate((el) => new Date(Number(el.closest('.nc-col').dataset.day)).getDay());
  expect(day).toBe(1);
  await openFull(page, 'standup');
  await expect(page.getByTestId('card-start-time')).toHaveText(/^0?2:00 PM$/);
  await expect(page.getByTestId('card-start-date')).toHaveText(/Oct 27/);
  await expect(page.getByTestId('card-tz-button')).toHaveText('Japan Time');
  await expect(page.getByTestId('card-tz-yours')).toHaveText('· Mon 10:00 PM – 10:30 PM your time');
  await page.getByTestId('card-done').click();
  expect(errors).toEqual([]);
  await ctx.close();

  // Classic: rename it in classic's own editor; the zone is still stored.
  const c = await open(browser, id, '&view=week&date=2026-10-27', { classic: true });
  const appt = c.page.locator('.e-appointment', { hasText: 'Standup' }).first();
  await expect(appt).toBeVisible({ timeout: 15_000 });
  await appt.dblclick();
  const dialog = c.page.locator('.e-schedule-dialog.e-popup-open');
  await expect(dialog).toBeVisible();
  await dialog.locator('[name="Subject"]').fill('Standup (Tokyo)');
  await dialog.locator('.e-event-save').click();
  await soon(async () => (await byId(id, 'standup')).title).toBe('Standup (Tokyo)');
  const after = await byId(id, 'standup');
  expect([after.tz, after.start, after.end]).toEqual(['Asia/Tokyo', '2026-10-27T05:00:00.000Z', '2026-10-27T05:30:00.000Z']);
  expect(c.errors).toEqual([]);
  await c.ctx.close();
});

test('"Use mine" takes the zone away: the same clock time, in yours; Undo puts it back', async ({ browser }) => {
  const id = await seed([{ ...standup(), start: '2026-10-28T05:00:00.000Z', end: '2026-10-28T05:30:00.000Z', tz: 'Asia/Tokyo' }]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-27');
  await openFull(page, 'standup');
  await expect(page.getByTestId('card-start-time')).toHaveText(/^0?2:00 PM$/);
  await page.getByTestId('card-tz-button').click();
  await picker(page).locator('[data-tz=""]').click();
  await soon(async () => 'tz' in (await byId(id, 'standup'))).toBe(false);
  expect((await byId(id, 'standup')).start).toBe('2026-10-28T21:00:00.000Z');   // Wed 2 PM in Los Angeles
  await expect(page.getByTestId('card-tz-button')).toHaveText('Pacific Time');
  await expect(page.getByTestId('card-start-time')).toHaveText(/^0?2:00 PM$/);
  await page.keyboard.press('ControlOrMeta+z');
  await soon(async () => (await byId(id, 'standup')).tz).toBe('Asia/Tokyo');
  expect((await byId(id, 'standup')).start).toBe('2026-10-28T05:00:00.000Z');
  await expect(page.getByTestId('card-tz-button')).toHaveText('Japan Time');
  // All day: no time zone line, and no gap where it was.
  await page.getByTestId('card-allday').click();
  await expect(page.getByTestId('card-tz')).toBeHidden();
  expect(await page.getByTestId('card-tz').boundingBox()).toBeNull();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a weekly 2 PM Tokyo meeting lands on Monday evening in Los Angeles, before and after Nov 1', async ({ browser }) => {
  // Tuesdays 2 PM in Tokyo from Oct 27 (05:00Z).
  const id = await seed([{ ...standup(), id: 'weekly', title: 'Tokyo weekly', start: '2026-10-27T05:00:00.000Z', end: '2026-10-27T05:30:00.000Z',
    tz: 'Asia/Tokyo', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;' }]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-11-09');
  // Where the grid draws it: its column's weekday, and the occurrences the calendar on screen expands (local time).
  const where = () => page.locator('.nc [data-testid="event-weekly"]').first().evaluate((el) => new Date(Number(el.closest('.nc-col').dataset.day)).getDay());
  const shown = (from, to) => page.evaluate(([a, b]) => document.querySelector('#app')._vnode.component.proxy.calView.occurrences(new Date(a), new Date(b))
    .filter((o) => o.title === 'Tokyo weekly').map((o) => `${o.start.getDay()} ${o.start.getHours()}:${String(o.start.getMinutes()).padStart(2, '0')} ${o.start.toISOString()}`), [from, to]);
  await expect(page.locator('.nc [data-testid="event-weekly"]')).toHaveCount(1);
  expect(await where()).toBe(1);                                   // Monday Nov 9
  expect(await shown('2026-11-08T08:00:00Z', '2026-11-15T08:00:00Z')).toEqual(['1 21:00 2026-11-10T05:00:00.000Z']);   // 9 PM PST
  await page.goto(`/${id}?backend=cf&cal=native&view=week&date=2026-10-26`);
  await expect(page.locator('.nc [data-testid="event-weekly"]')).toHaveCount(1, { timeout: 15_000 });
  expect(await where()).toBe(1);                                   // Monday Oct 26
  expect(await shown('2026-10-25T07:00:00Z', '2026-11-01T07:00:00Z')).toEqual(['1 22:00 2026-10-27T05:00:00.000Z']);   // 10 PM PDT
  // The card shows it in Tokyo: Tuesday 2:00 PM.
  await openFull(page, 'weekly');
  await expect(page.getByTestId('card-start-time')).toHaveText(/^0?2:00 PM$/);
  await expect(page.getByTestId('card-repeat')).toHaveAttribute('aria-label', /Tuesday/);
  expect(errors).toEqual([]);
  await ctx.close();
});

for (const [phone, scheme] of [[false, 'dark'], [true, 'light'], [true, 'dark']]) {
  test(`the time zone picker (${phone ? 'phone' : 'desktop'}, ${scheme})`, async ({ browser }) => {
    const id = await seed([{ ...standup(), start: '2026-10-28T05:00:00.000Z', end: '2026-10-28T05:30:00.000Z', tz: 'Asia/Tokyo' }]);
    const { ctx, page, errors } = await open(browser, id, phone ? '&view=day&date=2026-10-27' : '&view=week&date=2026-10-27', { phone, colorScheme: scheme });
    await openFull(page, 'standup');
    await expect(page.getByTestId('card-tz-yours')).toBeVisible();
    // The line fits the card: nothing spills past its right edge.
    const [line, box] = await Promise.all([page.getByTestId('card-tz').boundingBox(), card(page).boundingBox()]);
    expect(line.x + line.width).toBeLessThanOrEqual(box.x + box.width + 1);
    await shot(page, `tz-card-${phone ? 'phone' : 'desktop'}-${scheme}`);
    await page.getByTestId('card-tz-button').click();
    await expect(picker(page)).toBeVisible();
    const p = await picker(page).boundingBox();
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual((phone ? 390 : 1280) + 1);
    await shot(page, `tz-picker-${phone ? 'phone' : 'desktop'}-${scheme}`);
    expect(errors).toEqual([]);
    await ctx.close();
  });
}
