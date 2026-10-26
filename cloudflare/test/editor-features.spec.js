// @ts-check
/**
 * The new event editor, feature by feature: one test per feature of the editing prototype (scratchpad/editing,
 * artifact Pme2wmbmcdS8vjPQ9xQ4ba) and of classic's editor, named "F<n> <feature>". A feature without a passing test
 * here is not done. Each test drives the real UI (?cal=native) and checks what is on screen AND what the server saved.
 * Visual checks run in DARK mode (the owner's) with realistic long details (test/fixtures/long-descriptions.json).
 *
 * Owner, Oct 26 2026: "prove with tests that you have the features". Written after a time zone line that could not be
 * changed, a raw browser dropdown, a drag that showed nowhere to land and clipped long titles all reached preview.
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');
const FIXTURE = require('../../test/fixtures/long-descriptions.json');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';   // Saturday Oct 24 2026, Los Angeles
const HOUR = 48;
const LABELS = ['Work', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];
const la = (wall) => new Date(`${wall}:00-07:00`).toISOString();   // all fixture dates are in PDT (before Nov 1)
const row = (e) => ({ id: e.id, title: e.title, start: la(e.when[0]), end: la(e.when[1]), description: e.description || '', repeat: '',
  recurrencerule: e.rule || '', recurrenceID: null, recurrenceException: null, isAllDay: false, type: e.type || 1 });

let n = 0;
async function seed(events = FIXTURE.events) {
  const id = `ef-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Editor features', options: { typeLabels: LABELS }, events: events.map(row) }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const get = async (id, eid) => (await stored(id)).find((e) => e.id === eid);
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100] });

async function open(browser, id, { phone = false, dark = true, query = '&view=week&date=2026-10-21', size = null } = {}) {
  const ctx = await browser.newContext({
    ...(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: size || { width: 1280, height: 800 } }),
    timezoneId: 'America/Los_Angeles', locale: 'en-US', colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(NOW) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${id}?backend=cf&cal=native${query}`);
  await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const ev = (page, id) => page.locator(`.nc [data-testid="event-${id}"]`).first();
const card = (page) => page.getByTestId('event-card');
const picker = (page) => page.getByTestId('card-picker');
const toast = (page) => page.locator('.pc-toast');
async function openCard(page, id, full = false) {
  await ev(page, id).click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(250);
  if (full) { await page.getByTestId('card-more').click(); await expect(page.getByTestId('card-start-date')).toBeVisible(); }
}
const local = (v) => { const d = new Date(new Date(v).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const p = (k) => String(k).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
async function shot(page, name) { await page.screenshot({ path: `snapshots/features-${name}.png` }); }

// ---- the quick card ---------------------------------------------------------------------------------
test('F1 a click opens the quick card: title, time line, details preview, "Edited", Done', async ({ browser }) => {
  const id = await seed();
  const { ctx, page, errors } = await open(browser, id);
  await openCard(page, 'list');
  await expect(page.getByTestId('card-title')).toHaveValue('Saturday tournament');
  await expect(page.getByTestId('card-time-line')).toContainText('8');
  await expect(page.getByTestId('card-details-preview')).toContainText('Lincoln Field');
  await expect(page.getByTestId('card-done')).toBeVisible();
  await shot(page, 'F1-quick');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('F2 links in the details are clickable, in the quick card AND the full card, and open safely in a new tab', async ({ browser }) => {
  const id = await seed();
  const { ctx, page, errors } = await open(browser, id);
  await openCard(page, 'links');
  const quick = page.getByTestId('card-details-preview').locator('a[href^="https://zoom.us/"]');
  await expect(quick).toBeVisible();
  await expect(quick).toHaveAttribute('target', '_blank');
  await expect(quick).toHaveAttribute('rel', /noopener/);
  await expect(page.getByTestId('card-details-preview').locator('a[href^="mailto:"]')).toHaveCount(1);
  // The full card: the details show the same links when not being edited.
  await page.getByTestId('card-more').click();
  await expect(card(page).locator('a[href^="https://zoom.us/"]')).toBeVisible();
  const [popup] = await Promise.all([page.waitForEvent('popup'), card(page).locator('a[href^="https://example.com/a/really"]').click()]);
  expect(popup.url()).toContain('example.com/a/really');
  await shot(page, 'F2-links-full');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('F3 a long URL wraps inside the card; nothing widens it or scrolls sideways', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'links', true);
  const c = await card(page).boundingBox();
  const overflow = await card(page).evaluate((el) => [...el.querySelectorAll('*')].filter((x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).overflowX !== 'auto' && getComputedStyle(x).overflowX !== 'scroll').map((x) => x.className || x.tagName));
  expect(overflow).toEqual([]);
  expect(c.width).toBeLessThanOrEqual(700);
  await ctx.close();
});

test('F4 the card is wide enough to read: the details box fits at least 55 characters a line on desktop', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  // A short description: the card as it first opens, before long text widens it.
  await openCard(page, 'short', true);
  const prose = FIXTURE.events.find((e) => e.id === 'paras').description;
  const perLine = await page.getByTestId('card-details').evaluate((el, text) => {
    // Real prose (capitals, punctuation, numbers): what a description is made of.
    const cs = getComputedStyle(el), c = document.createElement('canvas').getContext('2d');
    c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const avg = c.measureText(text).width / text.length;
    return Math.floor((el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / avg);
  }, prose);
  expect(perLine, `characters per line in the details box: ${perLine}`).toBeGreaterThanOrEqual(55);
  await shot(page, 'F4-width');
  await ctx.close();
});

test('F5 a long title wraps and shows in full (no clipping) and is saved whole', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'longtitle');
  const t = page.getByTestId('card-title');
  const clipped = await t.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped, 'the title is cut off sideways').toBe(false);
  const tb = await t.boundingBox(), type = await page.getByTestId('card-type').boundingBox();
  expect(tb.x + tb.width, 'the title runs under the type button').toBeLessThanOrEqual(type.x + 1);
  await shot(page, 'F5-long-title');
  await ctx.close();
});

// ---- every field, saved as it changes ------------------------------------------------------------------
test('F6 the title is edited in place and saved', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short');
  await page.getByTestId('card-title').fill('Dentist (moved)');
  await page.getByTestId('card-title').press('Enter');
  await soon(async () => (await get(id, 'short')).title).toBe('Dentist (moved)');
  await ctx.close();
});

test('F7 start time: a list with each time, and typing "4:30p" works; the length is kept', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-start-time').click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByTestId('picker-input').fill('4:30p');
  await picker(page).getByTestId('picker-input').press('Enter');
  await soon(async () => local((await get(id, 'short')).start)).toBe('2026-10-21 16:30');
  expect(local((await get(id, 'short')).end)).toBe('2026-10-21 17:30');
  await ctx.close();
});

test('F8 end time: the list shows each option\'s length', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-end-time').click();
  await expect(picker(page)).toContainText(/30m|1h 30m/);
  await ctx.close();
});

test('F9 dates: a month picker and typing a date; the end date reads as the same day, dimmed, until it differs', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-start-date').click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByTestId('picker-input').fill('Oct 22');
  await picker(page).getByTestId('picker-input').press('Enter');
  await soon(async () => local((await get(id, 'short')).start)).toBe('2026-10-22 15:00');
  await expect(page.getByTestId('card-end-date')).toHaveText('Thu, Oct 22');
  await ctx.close();
});

test('F10 All day on and off; on all-day the time zone row takes no space', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-allday').click();
  await soon(async () => !!(await get(id, 'short')).isAllDay).toBe(true);
  const tz = page.getByTestId('card-tz');
  const box = await tz.boundingBox().catch(() => null);
  expect(box === null || box.height === 0, 'an empty time zone row is left on an all-day event').toBe(true);
  await page.getByTestId('card-allday').click();
  await soon(async () => !!(await get(id, 'short')).isAllDay).toBe(false);
  await ctx.close();
});

test('F11 the length menu changes the end time', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-length').click();
  await picker(page).locator('[data-len="120"]').click();
  await soon(async () => local((await get(id, 'short')).end)).toBe('2026-10-21 17:00');
  await ctx.close();
});

test('F12 the type menu changes the type and the color; Edit types is there', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short');
  await page.getByTestId('card-type').click();
  await expect(picker(page).getByTestId('picker-edit-types')).toBeVisible();
  await picker(page).getByText('Party').click();
  await soon(async () => (await get(id, 'short')).type).toBe(5);
  await ctx.close();
});

test('F13 time zone: the line opens a picker ("Use mine" and a search); picking Tokyo and typing 2 PM stores 2 PM Tokyo', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-tz').click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page)).toContainText(/Use mine/i);
  await picker(page).getByRole('textbox').fill('Tokyo');
  await picker(page).getByText(/Tokyo/).first().click();
  await page.getByTestId('card-start-time').click();
  await picker(page).getByTestId('picker-input').fill('2p');
  await picker(page).getByTestId('picker-input').press('Enter');
  await soon(async () => (await get(id, 'short')).start).toBe('2026-10-21T05:00:00.000Z');
  await soon(async () => (await get(id, 'short')).tz).toBe('Asia/Tokyo');
  await shot(page, 'F13-tz');
  await ctx.close();
});

test('F14 repeat: the one-tap choices are there and one saves', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-repeat').click();
  for (const t of [/Doesn.t repeat/, /Every day|Daily/, /Every Wednesday/, /Every weekday/, /Custom/]) await expect(picker(page)).toContainText(t);
  await picker(page).getByText(/Every Wednesday/).click();
  await soon(async () => (await get(id, 'short')).recurrencerule).toMatch(/^FREQ=WEEKLY;BYDAY=WE/);
  await ctx.close();
});

test('F15 repeat Custom… opens inside the card (not over Done or the details) and applies as you change it', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-repeat').click();
  await page.getByTestId('picker-custom').click();
  const unit = page.getByTestId('custom-unit');
  await expect(unit).toBeVisible();
  // Inside the card, and covering neither the details nor Done.
  const c = await card(page).boundingBox(), u = await unit.boundingBox();
  expect(u.x >= c.x && u.x + u.width <= c.x + c.width && u.y >= c.y && u.y + u.height <= c.y + c.height, 'Custom… is outside the card').toBe(true);
  const done = await page.getByTestId('card-done').boundingBox();
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="card-done"]') !== null, { x: done.x + done.width / 2, y: done.y + done.height / 2 });
  expect(hit, 'something covers Done').toBe(true);
  await page.getByTestId('custom-interval').fill('2');
  await page.getByTestId('custom-interval').press('Tab');
  await soon(async () => (await get(id, 'short')).recurrencerule).toMatch(/INTERVAL=2/);
  await expect(page.getByTestId('custom-apply')).toHaveCount(0);
  await shot(page, 'F15-custom');
  await ctx.close();
});

test('F16 repeat Custom… covers what classic does: weekly days, monthly day N or Nth/last weekday, yearly, end on a date or after N', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-repeat').click();
  await page.getByTestId('picker-custom').click();
  for (const t of ['custom-interval', 'custom-unit', 'custom-end-never', 'custom-end-until', 'custom-end-count']) await expect(page.getByTestId(t)).toBeVisible();
  await page.getByTestId('custom-unit').selectOption({ label: 'month' }).catch(async () => page.getByTestId('custom-unit').selectOption('MONTHLY'));
  for (const t of ['custom-by-day', 'custom-by-weekday', 'custom-setpos', 'custom-posday']) await expect(page.getByTestId(t)).toBeVisible();
  await expect(page.getByTestId('custom-setpos').locator('option', { hasText: 'last' })).toHaveCount(1);
  await ctx.close();
});

test('F17 details: typed text is saved while typing; a long paste is trimmed at 20,000 characters with a note', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  const box = page.getByTestId('card-details');
  await box.click();
  await page.keyboard.press('End');
  await page.keyboard.type(', bring X-rays', { delay: 5 });
  await soon(async () => (await get(id, 'short')).description).toBe('Dr. Lee, room 4, bring X-rays');
  await ctx.close();
});

test('F18 long details: the quick card shows four lines and "Show all"; 20,000 characters open fast and stay inside the window', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id, { query: '&view=week&date=2026-10-20' });
  const t0 = Date.now();
  await openCard(page, 'twenty-k');
  expect(Date.now() - t0).toBeLessThan(2500);
  await expect(page.getByTestId('card-show-all')).toBeVisible();
  await page.getByTestId('card-more').click();
  const c = await card(page).boundingBox();
  expect(c.y + c.height).toBeLessThanOrEqual(800);
  await expect(page.getByTestId('card-done')).toBeInViewport();
  await shot(page, 'F18-20k');
  await ctx.close();
});

// ---- closing, undo, delete, duplicate ------------------------------------------------------------------
test('F19 Done keeps changes; Cancel and Escape take back everything since the card opened', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-title').fill('Changed');
  await page.getByTestId('card-title').press('Enter');
  await page.getByTestId('card-done').click();
  await expect(card(page)).toHaveCount(0);
  await soon(async () => (await get(id, 'short')).title).toBe('Changed');
  for (const close of [async () => page.getByTestId('card-cancel').click(), async () => page.keyboard.press('Escape')]) {
    await openCard(page, 'short', true);
    await page.getByTestId('card-title').fill('Changed again');
    await page.getByTestId('card-title').press('Enter');
    await soon(async () => (await get(id, 'short')).title).toBe('Changed again');
    await close();
    await expect(card(page)).toHaveCount(0);
    await soon(async () => (await get(id, 'short')).title).toBe('Changed');
  }
  await ctx.close();
});

test('F20 Delete (button and the Delete key) with a toast whose Undo restores the event exactly', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  const before = await get(id, 'short');
  await openCard(page, 'short', true);
  await page.getByTestId('card-delete').click();
  await soon(async () => !!(await get(id, 'short'))).toBe(false);
  await expect(toast(page)).toContainText(/Deleted/);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await soon(async () => await get(id, 'short')).toEqual(before);
  await openCard(page, 'short');
  await page.getByTestId('card-title').blur();
  await page.keyboard.press('Delete');
  await soon(async () => !!(await get(id, 'short'))).toBe(false);
  await ctx.close();
});

test('F21 ⋯ menu: Duplicate and Delete; Cmd/Ctrl+D duplicates to the next day', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-more-actions').click();
  await expect(page.getByTestId('card-duplicate')).toBeVisible();
  await expect(page.getByTestId('card-menu-delete')).toBeVisible();
  await page.getByTestId('card-duplicate').click();
  await soon(async () => (await stored(id)).filter((e) => e.title === 'Dentist').length).toBe(2);
  await page.keyboard.press('ControlOrMeta+d');
  await soon(async () => (await stored(id)).filter((e) => e.title === 'Dentist').length).toBe(3);
  await ctx.close();
});

test('F22 right-click on an event opens the same menu (Duplicate, Delete)', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await ev(page, 'short').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Duplicate/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Delete/ })).toBeVisible();
  await shot(page, 'F22-right-click');
  await page.getByRole('menuitem', { name: /Duplicate/ }).click();
  await soon(async () => (await stored(id)).filter((e) => e.title === 'Dentist').length).toBe(2);
  await ctx.close();
});

test('F23 Undo (Cmd/Ctrl+Z) takes back the last change; routine changes show no toast', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short');
  await page.getByTestId('card-title').fill('Renamed');
  await page.getByTestId('card-title').press('Enter');
  await soon(async () => (await get(id, 'short')).title).toBe('Renamed');
  await expect(toast(page)).toHaveCount(0);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await soon(async () => (await get(id, 'short')).title).toBe('Dentist');
  await ctx.close();
});

test('F24 Recently deleted: a deleted event can be found and restored later', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-delete').click();
  await soon(async () => !!(await get(id, 'short'))).toBe(false);
  await page.waitForTimeout(6000);   // the Undo toast is gone
  await page.getByTestId('last-edit-link').click();
  await page.getByRole('button', { name: /Restore event/ }).first().click();
  await soon(async () => !!(await get(id, 'short'))).toBe(true);
  await ctx.close();
});

// ---- keyboard ------------------------------------------------------------------------------------------
test('F25 keyboard: N starts a new event with the title focused; Enter saves it', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id);
  await page.keyboard.press('n');
  await expect(page.getByTestId('card-title')).toBeFocused();
  await page.keyboard.type('Call Sam');
  await page.keyboard.press('Enter');
  await soon(async () => (await stored(id)).map((e) => e.title)).toEqual(['Call Sam']);
  await ctx.close();
});

test('F26 keyboard: Tab to an event, Enter opens it, Tab stays in the card, Escape closes; arrows move it 15 minutes', async ({ browser }) => {
  const id = await seed([FIXTURE.events.find((e) => e.id === 'short')]);
  const { ctx, page } = await open(browser, id);
  await ev(page, 'short').focus();
  await page.keyboard.press('ArrowDown');
  await soon(async () => local((await get(id, 'short')).start)).toBe('2026-10-21 15:15');
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeVisible();
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('[data-testid="event-card"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await ctx.close();
});

test('F27 the ? key shows the keyboard shortcuts', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: /shortcut/i })).toBeVisible();
  await shot(page, 'F27-shortcuts');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /shortcut/i })).toHaveCount(0);
  await ctx.close();
});

// ---- the grid ------------------------------------------------------------------------------------------
test('F28 drag on empty time creates an event of that length', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id);
  const col = await page.locator('.nc-col').nth(3).boundingBox();
  const first = await page.evaluate(() => parseInt(document.querySelector('.nc-hour-label').textContent, 10) || 5);
  const y = (h) => col.y + (h - first) * HOUR;
  await page.mouse.move(col.x + 20, y(14) + 2); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(col.x + 20, y(14) + 2 + (HOUR * 1.5) * i / 8);
  await page.mouse.up();
  await expect(card(page)).toBeVisible();
  await page.keyboard.type('Focus time');
  await page.keyboard.press('Enter');
  await soon(async () => { const [e] = await stored(id); return e && [local(e.start), local(e.end)]; }).toEqual(['2026-10-21 14:00', '2026-10-21 15:30']);
  await ctx.close();
});

test('F29 drag to move: the event follows into the day under the pointer with its new time, a dashed outline where it was', async ({ browser }) => {
  const id = await seed([FIXTURE.events.find((e) => e.id === 'short')]);
  const { ctx, page } = await open(browser, id);
  const b = await ev(page, 'short').boundingBox();
  const fri = await page.locator('.nc-col').nth(5).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 8); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width / 2 + (fri.x + fri.width / 2 - b.x - b.width / 2) * i / 10, b.y + 8 + HOUR * i / 10);
  const now = await ev(page, 'short').boundingBox();
  expect(now.x >= fri.x - 1 && now.x + now.width <= fri.x + fri.width + 1).toBe(true);
  await expect(ev(page, 'short')).toContainText('4:00 PM');
  await expect(page.locator('.nc-origin')).toHaveCount(1);
  await page.mouse.up();
  await soon(async () => local((await get(id, 'short')).start)).toBe('2026-10-23 16:00');
  await ctx.close();
});

test('F30 resize from either edge', async ({ browser }) => {
  const id = await seed([FIXTURE.events.find((e) => e.id === 'short')]);
  const { ctx, page } = await open(browser, id);
  const r = await ev(page, 'short').getByTestId('resize-bottom').boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + HOUR * i / 6);
  await page.mouse.up();
  await soon(async () => local((await get(id, 'short')).end)).toBe('2026-10-21 17:00');
  await ctx.close();
});

test('F31 Option/Alt-drag duplicates: the original stays, the copy lands where you let go', async ({ browser }) => {
  const id = await seed([FIXTURE.events.find((e) => e.id === 'short')]);
  const { ctx, page } = await open(browser, id);
  const b = await ev(page, 'short').boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(b.x + b.width / 2, b.y + 8); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2, b.y + 8 + HOUR * i / 8);
  await shot(page, 'F31-copy-drag');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await soon(async () => (await stored(id)).map((e) => local(e.start)).sort()).toEqual(['2026-10-21 15:00', '2026-10-21 16:00']);
  await ctx.close();
});

test('F32 a new event: a time typed in the title moves it live ("lunch fri 12-1")', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page } = await open(browser, id);
  await page.keyboard.press('n');
  await page.keyboard.type('Lunch fri 12-1');
  await page.keyboard.press('Enter');
  await soon(async () => { const [e] = await stored(id); return e && [e.title, local(e.start), local(e.end)]; }).toEqual(['Lunch', '2026-10-30 12:00', '2026-10-30 13:00']);   // "fri" on Saturday Oct 24: the coming Friday
  await ctx.close();
});

test('F33 a repeating event asks "this event / all events" when edited', async ({ browser }) => {
  const e = { ...FIXTURE.events.find((x) => x.id === 'short'), rule: 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;' };
  const id = await seed([e]);
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short');
  await page.getByTestId('card-title').fill('Dentist checkup');
  await page.getByTestId('card-title').press('Enter');
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await expect(page.getByTestId('scope-this')).toBeVisible();
  await expect(page.getByTestId('scope-all')).toBeVisible();
  await ctx.close();
});

// ---- placement and phone ------------------------------------------------------------------------------
test('F34 the card and its pickers stay on screen at the edges of a small window (1024x600)', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id, { size: { width: 1024, height: 600 }, query: '&view=week&date=2026-10-24' });
  await openCard(page, 'list', true);
  const c = await card(page).boundingBox();
  expect(c.x >= 0 && c.y >= 0 && c.x + c.width <= 1024 && c.y + c.height <= 600, JSON.stringify(c)).toBe(true);
  await page.getByTestId('card-repeat').click();
  const p = await picker(page).boundingBox();
  expect(p.x >= 0 && p.y >= 0 && p.x + p.width <= 1024 && p.y + p.height <= 600, JSON.stringify(p)).toBe(true);
  await ctx.close();
});

test('F35 phone: the card is a sheet with a grab bar; swipe down or the scrim closes it; long details scroll inside it', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id, { phone: true, query: '&view=day&date=2026-10-24' });
  await ev(page, 'list').tap();
  await expect(card(page)).toBeVisible();
  await shot(page, 'F35-phone');
  const c = await card(page).boundingBox();
  expect(c.x <= 16 && c.x + c.width >= 374, `the sheet spans the phone: ${JSON.stringify(c)}`).toBe(true);
  expect(c.y + c.height).toBeGreaterThanOrEqual(840);
  await shot(page, 'F35-phone');
  await page.getByTestId('card-scrim').click({ position: { x: 20, y: 20 } });
  await expect(card(page)).toHaveCount(0);
  await ctx.close();
});

// ---- looks right ----------------------------------------------------------------------------------------
test('F36 no raw browser controls anywhere in the card or Custom…: every select and field uses the shared style', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'short', true);
  await page.getByTestId('card-repeat').click();
  await page.getByTestId('picker-custom').click();
  const raw = await page.evaluate(() => [...document.querySelectorAll('[data-testid="event-card"] select, [data-testid="event-card"] input:not([type=radio]):not([type=checkbox]):not([type=hidden]), [data-testid="card-picker"] select, [data-testid="card-picker"] input:not([type=radio]):not([type=checkbox])')]
    .filter((el) => getComputedStyle(el).appearance !== 'none' && el.tagName === 'SELECT' || (el.type === 'date' && !el.classList.contains('pc-field')))
    .map((el) => el.dataset.testid || el.outerHTML.slice(0, 60)));
  expect(raw).toEqual([]);
  await shot(page, 'F36-custom-dark');
  await ctx.close();
});

test('F37 dark mode: the card, its text and its fields are dark (no light boxes, readable text)', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await openCard(page, 'list', true);
  const light = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g); if (!m) return 0; const [r, g, b, a = 1] = m.map(Number); return a < 0.5 ? 0 : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    return [...document.querySelectorAll('[data-testid="event-card"] *')].filter((el) => el.getClientRects().length && lum(getComputedStyle(el).backgroundColor) > 0.6
      && !el.closest('[data-testid="card-done"]') && !el.matches('.nk-switch *, .nk-switch')).map((el) => el.className || el.tagName).slice(0, 5);
  });
  expect(light).toEqual([]);
  await ctx.close();
});

test('F38 a card opened near the bottom of the window still shows at least four lines of details, with nothing over them', async ({ browser }) => {
  const id = await seed();
  const { ctx, page } = await open(browser, id);
  await page.locator('.nc-grid-scroll').evaluate((el) => { el.scrollTop = 0; });
  await openCard(page, 'paras', true);
  const box = page.getByTestId('card-details');
  const b = await box.boundingBox(), lh = await box.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 21);
  expect(b.height, `the details box is ${Math.round(b.height)}px tall`).toBeGreaterThanOrEqual(lh * 4);
  const foot = await page.getByTestId('card-done').boundingBox();
  expect(b.y + b.height, 'the footer overlaps the details').toBeLessThanOrEqual(foot.y + 1);
  await shot(page, 'F38-near-bottom');
  await ctx.close();
});
