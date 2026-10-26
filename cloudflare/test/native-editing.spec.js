// @ts-check
/**
 * Edit links on pastecal's own calendar (docs/native-switch.md, milestone 2), driven like a person and checked
 * against what the SERVER saved (GET /cal/<id>), plus what is on screen. An edit link opened with ?cal=native draws
 * NativeCalendar and downloads nothing of Syncfusion's. Covered: the quick box and its live "New event" block, drag
 * to create (a duration in week view, a run of days in month view), move, resize from either edge, Escape cancelling
 * a drag, a repeating event's "this event / all events" for move, edit and delete (stored exactly as classic stores
 * them), every editor field round-tripping, delete with Undo, a phone (tap to add, the popup, the editor as a sheet,
 * long-press to drag, a scroll that moves nothing), keyboard shortcuts, and a locked calendar offering no editing.
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');

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
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [200, 400, 800] });

/** A browser in Los Angeles at a fixed time; every page error and Syncfusion request is recorded. */
async function open(browser, id, query = '', { phone = false, timezoneId = 'America/Los_Angeles' } = {}) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId, locale: 'en-US' }
    : { viewport: { width: 1280, height: 900 }, timezoneId, locale: 'en-US' });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
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

// =====================================================================================================
test('quick add in week view: the live "New event" block follows the title; Enter saves, Escape cancels; no Syncfusion', async ({ browser }) => {
  const id = await seed([timed('d', 'Dentist', '2026-10-22T11:00:00-07:00', '2026-10-22T12:30:00-07:00')]);
  const { ctx, page, errors, syncfusion } = await open(browser, id, '&view=week&date=2026-10-21');
  expect(syncfusion, 'no Syncfusion file on a native edit link').toEqual([]);
  expect(await page.evaluate(() => typeof window.ej === 'undefined' && !window.scheduleObj && document.documentElement.dataset.cal === 'native')).toBe(true);

  const at = await slot(page, '2026-10-21', 14);
  await page.mouse.click(at.x, at.y + 6);
  const quick = page.getByTestId('quick-create');
  await expect(quick).toBeVisible();
  await expect(quick).toContainText('October 21, 2026 (2:00 PM - 3:00 PM)');
  const block = page.getByTestId('draft-block');
  await expect(block).toHaveText(/New event/);
  const bb = await block.boundingBox();
  expect(Math.abs(bb.y - at.y), 'the block sits on the slot clicked').toBeLessThan(4);
  expect(Math.round(bb.height)).toBeGreaterThanOrEqual(HOUR - 2);
  await page.keyboard.type('Lunch with Sam');
  await expect(block).toContainText('Lunch with Sam');
  await page.keyboard.press('Enter');
  await expect(quick).toHaveCount(0);
  await expect(block).toHaveCount(0);
  await soon(async () => !!(await byTitle(id, 'Lunch with Sam'))).toBe(true);
  const e = await byTitle(id, 'Lunch with Sam');
  expect([await local(page, e.start), await local(page, e.end), !!e.isAllDay, e.type]).toEqual(['2026-10-21 14:00', '2026-10-21 15:00', false, 1]);
  expect(e.start).toMatch(ISO);
  await expect(page.locator('.nc-timed', { hasText: 'Lunch with Sam' })).toBeVisible();

  // Escape closes the box and its block; nothing is stored.
  const at2 = await slot(page, '2026-10-23', 9);
  await page.mouse.click(at2.x, at2.y + 6);
  await expect(quick).toBeVisible();
  await page.keyboard.type('Never mind');
  await page.keyboard.press('Escape');
  await expect(quick).toHaveCount(0);
  await expect(block).toHaveCount(0);
  await page.waitForTimeout(800);
  expect((await stored(id)).map((x) => x.title).sort()).toEqual(['Dentist', 'Lunch with Sam']);
  expect(await tracked(page)).toEqual(['event_added:grid']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('month view: a click adds an all-day event; dragging across days adds a multi-day one (stored as classic stores them)', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-15');
  const c13 = await cell(page, '2026-10-13');
  await c13.click({ position: { x: 60, y: 70 } });
  await expect(page.getByTestId('quick-create')).toContainText('October 13, 2026 (All day)');
  expect(await daysOf(page, 'draft-block')).toEqual(['2026-10-13']);
  await page.keyboard.type('Picture day');
  await page.getByTestId('quick-create-save').click();
  await soon(async () => !!(await byTitle(id, 'Picture day'))).toBe(true);
  const one = await byTitle(id, 'Picture day');
  expect([one.isAllDay, one.start, one.end]).toEqual([true, await localMidnight(page, '2026-10-13'), await localMidnight(page, '2026-10-14')]);

  // Drag from the 14th to the 16th: one event over three days.
  const a = await (await cell(page, '2026-10-14')).boundingBox(), b = await (await cell(page, '2026-10-16')).boundingBox();
  await drag(page, { x: a.x + a.width / 2, y: a.y + a.height - 12 }, { x: b.x + b.width / 2, y: b.y + b.height - 12 });
  await expect(page.locator('.nc-cell.creating')).toHaveCount(3);
  await page.mouse.up();
  await expect(page.getByTestId('quick-create')).toContainText('October 14, 2026 - October 16, 2026 (All day)');
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

test('week view: drag on empty time to create an event with that duration', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  const from = await slot(page, '2026-10-22', 9), to = await slot(page, '2026-10-22', 11.5);
  await drag(page, { x: from.x, y: from.y + 2 }, to);
  await expect(page.getByTestId('create-preview')).toHaveText('9:00 AM - 11:30 AM');
  await page.mouse.up();
  await expect(page.getByTestId('quick-create')).toContainText('(9:00 AM - 11:30 AM)');
  const block = await page.getByTestId('draft-block').boundingBox();
  expect(Math.round(block.height / HOUR * 2) / 2).toBe(2.5);
  await page.keyboard.type('Workshop');
  await page.keyboard.press('Enter');
  await soon(async () => !!(await byTitle(id, 'Workshop'))).toBe(true);
  const e = await byTitle(id, 'Workshop');
  expect([await local(page, e.start), await local(page, e.end)]).toEqual(['2026-10-22 09:00', '2026-10-22 11:30']);
  expect(errors).toEqual([]);
  await ctx.close();
});

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
  await expect(page.getByTestId('quick-create')).toHaveCount(0);
  await expect(page.getByTestId('event-popover')).toHaveCount(0);
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  // And a drag to create, escaped, creates nothing.
  const s = await slot(page, '2026-10-21', 8);
  await drag(page, s, { x: s.x, y: s.y + 2 * HOUR });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('quick-create')).toHaveCount(0);
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
  expect([master.end, master.recurrencerule, master.recurrenceException]).toEqual([iso('2026-10-08T10:00:00-07:00'), 'FREQ=WEEKLY;BYDAY=TH;INTERVAL=1;', '20261020T170000Z']);
  expect(rows).toHaveLength(2);
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

test('a repeating event from its popup: edit and delete "this event" / "all events", Undo, and classic\'s "match the series again?"', async ({ browser }) => {
  const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', description: 'Room 4' })]);
  const { ctx, page, errors } = await open(browser, id, '&view=day&date=2026-10-13');
  const popup = async (title) => { await page.locator('.nc-timed', { hasText: title }).first().click(); await expect(page.getByTestId('event-popover')).toBeVisible(); };

  // Edit this event (Oct 13): the editor shows that date and no repeat controls.
  await popup('Weekly sync');
  await page.getByTestId('popover-edit').click();
  await pickScope(page, 'this');
  await expect(page.getByTestId('event-editor')).toBeVisible();
  await expect(page.getByTestId('editor-start-date')).toHaveValue('2026-10-13');
  await expect(page.getByTestId('editor-repeat')).toHaveCount(0);
  await page.getByTestId('editor-title').fill('Weekly sync (moved room)');
  await page.getByTestId('editor-save').click();
  await soon(async () => (await stored(id)).length).toBe(2);
  let master = (await stored(id)).find((e) => e.id === 'w');
  expect(master.recurrenceException).toBe('20261013T170000Z');

  // Delete this event (Oct 20): no "Are you sure?", an Undo toast; Undo takes the stamp back off.
  await page.getByTestId('view-Week').click();
  await page.getByTestId('nav-next').click();   // the week of Oct 18
  await popup('Weekly sync');
  await page.getByTestId('popover-delete').click();
  await pickScope(page, 'this');
  await soon(async () => (await stored(id)).find((e) => e.id === 'w').recurrenceException).toBe('20261013T170000Z,20261020T170000Z');
  await expect(page.locator('.nc-timed', { hasText: 'Weekly sync' })).toHaveCount(0);
  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  await undo.click();
  await soon(async () => (await stored(id)).find((e) => e.id === 'w').recurrenceException).toBe('20261013T170000Z');

  // Edit all events (from Oct 20): the series' own start and rule in the form; classic asks whether its edited
  // occurrence matches the series again. "No": renamed, the skipped date and the edited copy stay.
  await popup('Weekly sync');
  await page.getByTestId('popover-edit').click();
  await pickScope(page, 'all');
  await expect(page.getByTestId('editor-start-date')).toHaveValue('2026-10-06');
  await expect(page.getByTestId('editor-repeat')).toHaveValue('WEEKLY');
  await page.getByTestId('editor-title').fill('Team sync');
  await page.getByTestId('editor-save').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('match it to the whole series again?');
  await page.getByTestId('confirm-no').click();
  await expect(page.getByTestId('event-editor')).toHaveCount(0);
  await soon(async () => (await stored(id)).find((e) => e.id === 'w').title).toBe('Team sync');
  let rows = await stored(id);
  master = rows.find((e) => e.id === 'w');
  expect([master.recurrenceException, master.description, master.start, master.recurrencerule, rows.length])
    .toEqual(['20261013T170000Z', 'Room 4', iso('2026-10-06T10:00:00-07:00'), 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', 2]);

  // Delete all events: the series and its edited occurrence go; Undo brings both back.
  await popup('Team sync');
  await page.getByTestId('popover-delete').click();
  await pickScope(page, 'all');
  await soon(async () => (await stored(id)).length).toBe(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await soon(async () => (await stored(id)).length).toBe(2);

  // "Yes" to matching the series again: the skipped date and the edited copy are cleared (classic's own rule).
  await popup('Team sync');
  await page.getByTestId('popover-edit').click();
  await pickScope(page, 'all');
  await page.getByTestId('editor-description').fill('Room 5');
  await page.getByTestId('editor-save').click();
  await page.getByTestId('confirm-yes').click();
  await soon(async () => (await stored(id)).length).toBe(1);
  [master] = await stored(id);
  expect([master.recurrenceException ?? null, master.description, master.title]).toEqual([null, 'Room 5', 'Team sync']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('the editor: every field round-trips (title, dates and times, all day, every repeat choice, color by name, details)', async ({ browser }) => {
  const id = await seed([]);
  const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-15');
  const editor = page.getByTestId('event-editor');
  const reopen = async (title) => {
    await page.locator('.nc-bar', { hasText: title }).first().click();
    await page.getByTestId('popover-edit').click();
    await page.waitForTimeout(200);
    const scope = page.getByTestId('confirm-dialog');
    if (await scope.count()) await pickScope(page, 'all');
    await expect(editor).toBeVisible();
  };

  // A new event from a double-click: every field set.
  await (await cell(page, '2026-10-13')).dblclick({ position: { x: 60, y: 70 } });
  await expect(editor).toBeVisible();
  await expect(editor.locator('h2')).toHaveText('New event');
  await page.getByTestId('editor-title').fill('Board meeting');
  await page.getByTestId('editor-allday').uncheck();
  await page.getByTestId('editor-start-date').fill('2026-10-13');
  await page.getByTestId('editor-start-time').fill('18:30');
  await page.getByTestId('editor-end-date').fill('2026-10-13');
  await page.getByTestId('editor-end-time').fill('20:00');
  await page.getByTestId('editor-color').click();
  await expect(page.getByTestId('editor-color-3')).toContainText('Away game');
  await page.getByTestId('editor-color-3').click();
  await expect(page.getByTestId('editor-color-label')).toHaveText('Away game');
  await page.getByTestId('editor-repeat').selectOption('MONTHLY');
  await page.getByTestId('editor-month-by-weekday').check();
  await expect(page.getByTestId('editor-setpos')).toHaveValue('2');   // Oct 13 is the 2nd Tuesday
  await expect(page.getByTestId('editor-posday')).toHaveValue('2');
  await page.getByTestId('editor-end-mode').selectOption('until');
  await page.getByTestId('editor-until').fill('2027-03-31');
  await page.getByTestId('editor-description').fill('Agenda: budget.\nBring the laptop.');
  await page.getByTestId('editor-save').click();
  await expect(editor).toHaveCount(0);
  await soon(async () => !!(await byTitle(id, 'Board meeting'))).toBe(true);
  let e = await byTitle(id, 'Board meeting');
  const until = await page.evaluate(() => new Date(2027, 2, 31, 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));
  expect([await local(page, e.start), await local(page, e.end), e.isAllDay, e.type, e.description, e.recurrencerule])
    .toEqual(['2026-10-13 18:30', '2026-10-13 20:00', false, 3, 'Agenda: budget.\nBring the laptop.', `FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;INTERVAL=1;UNTIL=${until};`]);
  // Drawn on the 2nd Tuesday of each month (Nov 10 next month).
  await page.getByTestId('nav-next').click();
  expect(await daysOf(page, 'event-' + e.id)).toEqual(['2026-11-10']);
  await page.getByTestId('nav-prev').click();

  // Reopened: the form shows what was saved; Save with nothing changed stores nothing new (the rule verbatim).
  await reopen('Board meeting');
  await expect(page.getByTestId('editor-title')).toHaveValue('Board meeting');
  await expect(page.getByTestId('editor-start-time')).toHaveValue('18:30');
  await expect(page.getByTestId('editor-end-time')).toHaveValue('20:00');
  await expect(page.getByTestId('editor-allday')).not.toBeChecked();
  await expect(page.getByTestId('editor-color-label')).toHaveText('Away game');
  await expect(page.getByTestId('editor-repeat')).toHaveValue('MONTHLY');
  await expect(page.getByTestId('editor-month-by-weekday')).toBeChecked();
  await expect(page.getByTestId('editor-setpos')).toHaveValue('2');
  await expect(page.getByTestId('editor-until')).toHaveValue('2027-03-31');
  await expect(page.getByTestId('editor-description')).toHaveValue('Agenda: budget.\nBring the laptop.');
  const before = JSON.stringify(await stored(id));
  await page.getByTestId('editor-save').click();
  await page.waitForTimeout(1000);
  expect(JSON.stringify(await stored(id))).toBe(before);

  // The other repeat choices, each stored in classic's (Syncfusion's) rule form.
  const cases = [
    [async () => { await page.getByTestId('editor-repeat').selectOption('DAILY'); await page.getByTestId('editor-interval').fill('2'); await page.getByTestId('editor-end-mode').selectOption('count'); await page.getByTestId('editor-count').fill('5'); },
      'FREQ=DAILY;INTERVAL=2;COUNT=5;'],
    [async () => { await page.getByTestId('editor-repeat').selectOption('WEEKLY'); await page.getByTestId('editor-interval').fill('1'); await page.getByTestId('editor-day-4').click(); await page.getByTestId('editor-end-mode').selectOption('never'); },
      'FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=1;'],
    [async () => { await page.getByTestId('editor-repeat').selectOption('MONTHLY'); await page.getByTestId('editor-month-by-day').check(); await page.getByTestId('editor-month-day').fill('15'); },
      'FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=1;'],
    [async () => { await page.getByTestId('editor-repeat').selectOption('YEARLY'); await page.getByTestId('editor-month').selectOption('12'); await page.getByTestId('editor-month-by-weekday').check();
      await page.getByTestId('editor-setpos').selectOption('-1'); await page.getByTestId('editor-posday').selectOption('5'); }, 'FREQ=YEARLY;BYDAY=FR;BYSETPOS=-1;BYMONTH=12;INTERVAL=1;'],
    [async () => { await page.getByTestId('editor-repeat').selectOption(''); }, '', 2],   // its only date is now Dec 25: two months on
  ];
  for (const [set, rule, ahead = 0] of cases) {
    for (let i = 0; i < ahead; i++) await page.getByTestId('nav-next').click();
    await reopen('Board meeting');
    await set();
    await page.getByTestId('editor-save').click();
    await expect(editor).toHaveCount(0);
    await soon(async () => (await byTitle(id, 'Board meeting')).recurrencerule || '').toBe(rule);
    for (let i = 0; i < ahead; i++) await page.getByTestId('nav-prev').click();
  }

  // All day on: the dates it covers, end date inclusive in the form, exclusive midnight when stored.
  await reopen('Board meeting');
  await page.getByTestId('editor-allday').check();
  await page.getByTestId('editor-end-date').fill('2026-10-15');
  await page.getByTestId('editor-save').click();
  await soon(async () => (await byTitle(id, 'Board meeting')).isAllDay).toBe(true);
  e = await byTitle(id, 'Board meeting');
  expect([e.start, e.end]).toEqual([await localMidnight(page, '2026-10-13'), await localMidnight(page, '2026-10-16')]);
  expect(await daysOf(page, 'event-' + e.id)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15']);
  await reopen('Board meeting');
  await expect(page.getByTestId('editor-end-date')).toHaveValue('2026-10-15');
  // Closing without saving is "abandoned", as classic reports it.
  await page.getByTestId('editor-cancel').click();
  const t = await tracked(page);
  expect(t.filter((x) => x === 'editor_abandoned')).toHaveLength(1);
  expect(t).toContain('feature_used:event_type');
  expect(t.filter((x) => x === 'event_added:grid')).toHaveLength(1);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('delete with an Undo toast and no "Are you sure?", from the popup and from the editor', async ({ browser }) => {
  const id = await seed([timed('a', 'Game', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { type: 2, description: 'Field 3' }),
    timed('b', 'Snack duty', '2026-10-23T10:00:00-07:00', '2026-10-23T11:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await ev(page, 'a').click();
  await page.getByTestId('popover-delete').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await soon(async () => (await stored(id)).map((e) => e.id)).toEqual(['b']);
  await expect(ev(page, 'a')).toHaveCount(0);
  await expect(page.getByText('Deleted "Game"')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await soon(async () => (await stored(id)).map((e) => e.id).sort()).toEqual(['a', 'b']);
  expect((await stored(id)).find((e) => e.id === 'a').description).toBe('Field 3');
  await ev(page, 'b').click();
  await page.getByTestId('popover-edit').click();
  await page.getByTestId('editor-delete').click();
  await expect(page.getByTestId('event-editor')).toHaveCount(0);
  await soon(async () => (await stored(id)).map((e) => e.id)).toEqual(['a']);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  expect(await tracked(page)).toEqual([]);   // a delete from the editor is not an abandoned editor
  // Recent changes (the server's history) lists what was done here, as it does for classic's edits.
  await page.locator('button[aria-label="Settings"]').click();
  await page.getByTestId('side-tab-changes').click();
  await expect(page.getByTestId('recent-changes')).toContainText('Snack duty');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('keyboard: Tab to an event and Enter opens it, Escape closes; Cmd/Ctrl+E quick add; Cmd/Ctrl+Z undoes a move', async ({ browser }) => {
  const id = await seed([timed('d', 'Dentist', '2026-10-22T11:00:00-07:00', '2026-10-22T12:00:00-07:00')]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await ev(page, 'd').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('event-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('event-popover')).toHaveCount(0);

  // Move it with the mouse, then Cmd/Ctrl+Z puts it back (on the server too).
  const b = await ev(page, 'd').boundingBox();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 + HOUR });
  await page.mouse.up();
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-22 12:00');
  await page.keyboard.press('ControlOrMeta+z');
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-22 11:00');

  // Cmd/Ctrl+E: quick add by typing.
  await page.keyboard.press('ControlOrMeta+e');
  await expect(page.getByText('Add Event by Typing')).toBeVisible();
  await page.keyboard.press('Escape');

  // The editor (a double-click on the event opens it, as on classic): Escape closes it (abandoned), Enter in the title saves.
  await ev(page, 'd').dblclick();
  await expect(page.getByTestId('event-editor')).toBeVisible();
  await expect(page.getByTestId('event-popover')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('event-editor')).toHaveCount(0);
  await ev(page, 'd').click();
  await page.getByTestId('popover-edit').click();
  await page.getByTestId('editor-title').fill('Dentist (Dr. Lee)');
  await page.getByTestId('editor-title').press('Enter');
  await soon(async () => (await stored(id))[0].title).toBe('Dentist (Dr. Lee)');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('the app around it: settings (24-hour, Monday first, a color and its name), a search result\'s Edit, Share', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T13:00:00-07:00', '2026-10-22T14:00:00-07:00', { type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  await page.getByTestId('settings-button-desktop').click();
  await page.locator('#set-time-format').selectOption('24');
  await page.locator('#set-first-day').selectOption('1');
  await page.locator('[data-category-label="1"]').fill('Matches');
  await page.locator('#color-picker-1').evaluate((el) => { el.value = '#00897b'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.keyboard.press('Escape');
  await expect(page.locator('.nc-dayhead').first()).toContainText('Mon');
  await expect(ev(page, 'g')).toContainText('13:00 - 14:00');
  expect(await ev(page, 'g').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 137, 123)');
  await ev(page, 'g').dblclick();
  await expect(page.getByTestId('editor-color-label')).toHaveText('Matches');
  await page.getByTestId('editor-cancel').click();

  // Search: a result's Edit opens the editor (CalendarView.openEditor).
  await page.getByTestId('search-button-desktop').click();
  await page.getByRole('searchbox', { name: 'Search events' }).fill('Game');
  await page.getByTestId('search-results').getByText('Game').first().click();
  await page.getByTestId('search-result-edit').first().click();
  await expect(page.getByTestId('event-editor')).toBeVisible();
  await expect(page.getByTestId('editor-title')).toHaveValue('Game');
  await page.getByTestId('editor-title').fill('Game (final)');
  await page.getByTestId('editor-save').click();
  await soon(async () => (await stored(id))[0].title).toBe('Game (final)');
  expect([await local(page, (await stored(id))[0].start), (await stored(id))[0].type]).toEqual(['2026-10-22 13:00', 2]);

  // Share opens on a native edit link too.
  await page.keyboard.press('Escape');
  await page.getByTestId('share-pill-more').click();
  await expect(page.locator('.pc-share')).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

// -------------------------------------------------------------------------------------------------- phone
/** Real touch input (CDP), so the page scrolls and long-presses as on a phone. */
async function touch(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
  return {
    async longDrag(from, to, holdMs = 650, steps = 10) {
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

test('phone: tap a day to add (a sheet), tap an event for its popup, the editor fits as a sheet', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=month&date=2026-10-15', { phone: true });
  const c = await cell(page, '2026-10-14');
  const cb = await c.boundingBox();
  await page.touchscreen.tap(cb.x + cb.width / 2, cb.y + cb.height - 6);
  const quick = page.getByTestId('quick-create');
  await expect(quick).toBeVisible();
  const q = await quick.boundingBox();
  expect([Math.round(q.x), Math.round(q.width), Math.round(q.y + q.height)]).toEqual([0, 390, 844]);   // a sheet along the bottom
  await page.getByTestId('quick-create-title').fill('Bake sale');
  await page.getByTestId('quick-create-save').tap();
  await soon(async () => !!(await byTitle(id, 'Bake sale'))).toBe(true);
  expect((await byTitle(id, 'Bake sale')).isAllDay).toBe(true);

  await ev(page, 'g').first().tap();
  await expect(page.getByTestId('event-popover')).toBeVisible();
  await page.getByTestId('popover-edit').tap();
  const sheet = page.locator('.ne-dialog');
  await expect(sheet).toBeVisible();
  const s = await sheet.boundingBox();
  expect(s.x).toBeGreaterThanOrEqual(0);
  expect(s.width).toBeLessThanOrEqual(390);
  expect(s.y + s.height).toBeLessThanOrEqual(845);
  expect(s.y).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByTestId('editor-save')).toBeInViewport();
  await page.getByTestId('editor-title').fill('Game (home)');
  await page.getByTestId('editor-save').tap();
  await soon(async () => (await stored(id)).find((e) => e.id === 'g').title).toBe('Game (home)');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('phone: long-press drags an event; a swipe over it scrolls and moves nothing', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=day&date=2026-10-22', { phone: true });
  const t = await touch(page);
  const box = async () => ev(page, 'g').boundingBox();

  // A quick swipe that starts on the event: the grid scrolls, the event stays where it was.
  let b = await box();
  const scroll0 = await page.evaluate(() => document.querySelector('.nc-grid-scroll').scrollTop + window.scrollY);
  await t.swipe([b.x + b.width / 2, b.y + b.height / 2], [b.x + b.width / 2, b.y + b.height / 2 - 150]);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => document.querySelector('.nc-grid-scroll').scrollTop + window.scrollY)).toBeGreaterThan(scroll0);
  expect(await local(page, (await stored(id))[0].start)).toBe('2026-10-22 10:00');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  // Press and hold, then drag down an hour: it moves.
  b = await box();
  await t.longDrag([b.x + b.width / 2, b.y + b.height / 2], [b.x + b.width / 2, b.y + b.height / 2 + HOUR]);
  await soon(async () => local(page, (await stored(id))[0].start)).toBe('2026-10-22 11:00');
  expect(await local(page, (await stored(id))[0].end)).toBe('2026-10-22 12:00');
  await expect(page.getByTestId('event-popover')).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

// -------------------------------------------------------------------------------------------------- locked
test('a locked calendar (Plus lock, no editor key) offers no editing, as classic', async ({ browser }) => {
  const id = await seed([timed('g', 'Game', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { type: 2 })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-22');
  // The lock state the live snapshot delivers (CloudCalendarService.onLockState -> applyLockState).
  await page.evaluate((cid) => document.querySelector('#app')._vnode.component.proxy.applyLockState({ id: cid, locked: true, pro: true, canEdit: false }), id);
  await expect(page.locator('.nc.nc-readonly')).toBeVisible();
  await expect(page.locator('.nc.nc-editable')).toHaveCount(0);
  await expect(page.locator('.nc-resize:visible')).toHaveCount(0);
  const before = JSON.stringify(await stored(id));
  // A click on an empty slot opens nothing; a drag on the grid creates nothing; a drag of the event moves nothing.
  const at = await slot(page, '2026-10-21', 14);
  await page.mouse.click(at.x, at.y + 6);
  await drag(page, at, { x: at.x, y: at.y + 2 * HOUR }); await page.mouse.up();
  await expect(page.getByTestId('quick-create')).toHaveCount(0);
  const b = await ev(page, 'g').boundingBox();
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 + HOUR }); await page.mouse.up();
  // The popup shows the event without edit or delete.
  await ev(page, 'g').click();
  await expect(page.getByTestId('event-popover')).toBeVisible();
  await expect(page.getByTestId('popover-edit')).toHaveCount(0);
  await expect(page.getByTestId('popover-delete')).toHaveCount(0);
  await page.getByTestId('popover-when').click();
  await expect(page.getByTestId('event-editor')).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(JSON.stringify(await stored(id))).toBe(before);
  expect(errors).toEqual([]);
  await ctx.close();
});
