// @ts-check
/**
 * Root-cause guards for the editor's data (the browser half; the unit halves are test/unit/offline-queue.test.js,
 * event-fields.test.js and wall-clock.test.js).
 *
 * ROOT 1 -- a write carries only the fields the person changed, measured from where they started; never a whole stale
 * copy of the event. For EVERY write path (the card's title and type, "this event", "all events", a drag, a resize,
 * Duplicate, classic's editor), browser A changes one field while browser B changes another field of the same event
 * -- live, and with A offline until B is done (the offline queue and its replay) -- and both changes must be in what
 * the SERVER stored (GET /cal/<id>). Past instances: F01, F02, S04 ("this event" wrote the card's stale title), S15 (an
 * offline type change undid someone's rename).
 *
 * ROOT 3 -- one list of event fields. A copy (Duplicate, an Option-drag) of a fully populated event keeps every field
 * but the ones a copy resets (a copy is one event, with its own id). Past instance: S03 (the drag copy lost its zone).
 *
 * ROOT 2 (classic) -- a series in its own zone is drawn by classic on the same days and times as native, and "this event"
 * from classic's grid lands on the series' own slot. Past instance: S09.
 *
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh); run with scripts/test-on-box.sh root-data.
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';   // Saturday Oct 24 2026, Los Angeles
const HOUR = 48;                            // NativeCalendar's hour height
const iso = (s) => new Date(s).toISOString();
const LABELS = ['Practice', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];
const timed = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
const WEEKLY = 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;';

let n = 0;
async function seed(events) {
  const id = `rd-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Root data', options: { typeLabels: LABELS }, events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const byId = async (id, eid) => (await stored(id)).find((e) => e.id === eid && !e.recurrenceID);
const soon = (fn, timeout = 15_000) => expect.poll(fn, { timeout, intervals: [150] });

async function open(browser, id, query = '', { classic = false, timezoneId = 'America/Los_Angeles' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId, locale: 'en-US' });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(NOW) });
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
const ev = (page, id) => page.locator(`.nc [data-testid="event-${id}"]`);
async function openCard(page, locator, full = false) {
  await locator.first().click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300);
  if (full) { await page.getByTestId('card-more').click(); await expect(page.getByTestId('card-start-date')).toBeVisible(); await page.waitForTimeout(300); }
}
async function pickScope(page, scope) {
  const dlg = page.getByTestId('confirm-dialog');
  await expect(dlg.getByTestId(`scope-${scope}`)).toBeVisible();
  await dlg.getByTestId(`scope-${scope}`).check();
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg.getByTestId('scope-this')).toHaveCount(0);
}
async function done(page) { if (await card(page).count()) await page.getByTestId('card-done').click(); await expect(card(page)).toHaveCount(0); }
async function setType(page, t) {
  await page.getByTestId('card-type').click();
  await picker(page).locator(`[data-t="${t}"]`).click();
}
async function setTitle(page, title) {
  await page.getByTestId('card-title').fill(title);
  await page.getByTestId('card-title').press('Enter');
}
/** Browser B renames an event in its card (a series: all events). */
async function bRename(B, locator, title, series = false) {
  await openCard(B.page, locator);
  await setTitle(B.page, title);
  if (series) await pickScope(B.page, 'all');
  await done(B.page);
}
/** A mouse drag from point (x, y) by dy pixels, with `between` run while the button is down. */
async function drag(page, { x, y }, dy, between = async () => {}) {
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y + dy * i / 6);
  await between();
  await page.mouse.up();
}
/** A's change, made live after B's (online) or offline while B makes it (A reconnects once B's is stored). */
async function race(mode, A, aChange, bChange, bStored) {
  if (mode === 'offline') {
    await A.ctx.setOffline(true);
    await aChange();
    await bChange();
    await soon(bStored).toBe(true);
    await A.ctx.setOffline(false);
  } else {
    await aChange(bChange);
  }
}

// =====================================================================================================
// ROOT 1: two people, two fields, every write path, live and offline.
// =====================================================================================================
for (const mode of ['online', 'offline']) {
  test(`ROOT1 ${mode}: card title (A) and type (B) of one event both stand`, async ({ browser }) => {
    const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
    const A = await open(browser, id, '&view=week&date=2026-10-22'), B = await open(browser, id, '&view=week&date=2026-10-22');
    await race(mode, A, async (between = async () => {}) => {
      await openCard(A.page, ev(A.page, 'p'));
      await between();                                   // B's change lands while A's card is open
      await setTitle(A.page, 'Practice (gym)');
      await done(A.page);
    }, async () => { await openCard(B.page, ev(B.page, 'p')); await setType(B.page, 4); await done(B.page); },
    async () => (await byId(id, 'p')).type === 4);
    await soon(async () => { const e = await byId(id, 'p'); return [e.title, e.type]; }, 25_000).toEqual(['Practice (gym)', 4]);
    expect(A.errors.concat(B.errors)).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test(`ROOT1 ${mode}: card type (A) and title (B) of one event both stand (S15)`, async ({ browser }) => {
    const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
    const A = await open(browser, id, '&view=week&date=2026-10-22'), B = await open(browser, id, '&view=week&date=2026-10-22');
    await race(mode, A, async (between = async () => {}) => {
      await openCard(A.page, ev(A.page, 'p'));
      await between();
      await setType(A.page, 4);
      await done(A.page);
    }, () => bRename(B, ev(B.page, 'p'), 'Practice (gym)'), async () => (await byId(id, 'p')).title === 'Practice (gym)');
    await soon(async () => { const e = await byId(id, 'p'); return [e.title, e.type]; }, 25_000).toEqual(['Practice (gym)', 4]);
    expect(A.errors.concat(B.errors)).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test(`ROOT1 ${mode}: "this event" (A moves one occurrence) and a series rename (B) both stand (S04)`, async ({ browser }) => {
    const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY })]);
    const A = await open(browser, id, '&view=week&date=2026-10-20'), B = await open(browser, id, '&view=week&date=2026-10-20');
    await race(mode, A, async (between = async () => {}) => {
      await openCard(A.page, A.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
      await A.page.getByTestId('card-q-s').click();
      await picker(A.page).getByTestId('picker-input').fill('12p');
      await picker(A.page).getByTestId('picker-input').press('Enter');
      await expect(A.page.getByTestId('scope-this')).toBeVisible();
      await between();                                   // asked "this event / all events" while B renames the series
      await A.page.waitForTimeout(800);
      await pickScope(A.page, 'this');
      await done(A.page);
    }, () => bRename(B, B.page.locator('.nc-timed', { hasText: 'Weekly sync' }), 'Team sync', true), async () => (await byId(id, 'w')).title === 'Team sync');
    await soon(async () => (await stored(id)).length, 25_000).toBe(2);
    const series = await byId(id, 'w'), child = (await stored(id)).find((e) => e.recurrenceID === 'w');
    expect(series.title).toBe('Team sync');
    expect(iso(child.start)).toBe(iso('2026-10-20T12:00:00-07:00'));
    // Live, A's new row is the series as it is now plus only A's change: B's name. (Offline, A made it from what it had.)
    if (mode === 'online') expect(child.title).toBe('Team sync');
    expect(A.errors.concat(B.errors)).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test(`ROOT1 ${mode}: "all events" (A's type) and a series rename (B) both stand`, async ({ browser }) => {
    const id = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY })]);
    const A = await open(browser, id, '&view=week&date=2026-10-20'), B = await open(browser, id, '&view=week&date=2026-10-20');
    await race(mode, A, async (between = async () => {}) => {
      await openCard(A.page, A.page.locator('.nc-timed', { hasText: 'Weekly sync' }));
      await between();
      await setType(A.page, 5);
      await pickScope(A.page, 'all');
      await done(A.page);
    }, () => bRename(B, B.page.locator('.nc-timed', { hasText: 'Weekly sync' }), 'Team sync', true), async () => (await byId(id, 'w')).title === 'Team sync');
    await soon(async () => { const e = await byId(id, 'w'); return [e.title, e.type, e.recurrencerule]; }, 25_000).toEqual(['Team sync', 5, WEEKLY]);
    expect(A.errors.concat(B.errors)).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  for (const how of ['drag', 'resize']) {
    test(`ROOT1 ${mode}: a ${how} (A) and a rename (B) of one event both stand`, async ({ browser }) => {
      const id = await seed([timed('p', 'Practice', '2026-10-22T15:00:00-07:00', '2026-10-22T16:00:00-07:00', { description: 'Bring water' })]);
      const A = await open(browser, id, '&view=week&date=2026-10-22'), B = await open(browser, id, '&view=week&date=2026-10-22');
      await race(mode, A, async (between = async () => {}) => {
        const box = how === 'drag' ? await ev(A.page, 'p').first().boundingBox() : await ev(A.page, 'p').getByTestId('resize-bottom').first().boundingBox();
        await drag(A.page, { x: box.x + box.width / 2, y: how === 'drag' ? box.y + 8 : box.y + box.height / 2 }, HOUR, between);   // B renames mid-drag
        await expect(A.page.getByTestId('confirm-dialog')).toHaveCount(0);
      }, () => bRename(B, ev(B.page, 'p'), 'Practice (gym)'), async () => (await byId(id, 'p')).title === 'Practice (gym)');
      const want = how === 'drag' ? [iso('2026-10-22T16:00:00-07:00'), iso('2026-10-22T17:00:00-07:00')] : [iso('2026-10-22T15:00:00-07:00'), iso('2026-10-22T17:00:00-07:00')];
      await soon(async () => { const e = await byId(id, 'p'); return [e.title, e.description, iso(e.start), iso(e.end)]; }, 25_000).toEqual(['Practice (gym)', 'Bring water', ...want]);
      expect(A.errors.concat(B.errors)).toEqual([]);
      await A.ctx.close(); await B.ctx.close();
    });
  }

  test(`ROOT1 ${mode}: Duplicate (A) and a rename of the original (B) both stand`, async ({ browser }) => {
    const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { type: 3 })]);
    const A = await open(browser, id, '&view=week&date=2026-10-22'), B = await open(browser, id, '&view=week&date=2026-10-22');
    await race(mode, A, async (between = async () => {}) => {
      await openCard(A.page, ev(A.page, 'p'), true);
      await between();
      await A.page.getByTestId('card-more-actions').click();
      await A.page.getByTestId('card-duplicate').click();
      await expect.poll(async () => A.page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.events.length)).toBe(2);
      await done(A.page);
    }, () => bRename(B, ev(B.page, 'p'), 'Practice (gym)'), async () => (await byId(id, 'p')).title === 'Practice (gym)');
    await soon(async () => (await stored(id)).length, 25_000).toBe(2);
    await soon(async () => (await byId(id, 'p')).title).toBe('Practice (gym)');
    const copy = (await stored(id)).find((e) => e.id !== 'p');
    expect([iso(copy.start), copy.type]).toEqual([iso('2026-10-23T17:00:00-07:00'), 3]);
    expect(A.errors.concat(B.errors)).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test(`ROOT1 ${mode}: classic's editor (A's details) and a rename (B) of one event both stand`, async ({ browser }) => {
    const id = await seed([timed('p', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
    const A = await open(browser, id, '&view=week&date=2026-10-22', { classic: true }), B = await open(browser, id, '&view=week&date=2026-10-22');
    await race(mode, A, async (between = async () => {}) => {
      const appt = A.page.locator('.e-appointment', { hasText: 'Practice' }).first();
      await expect(appt).toBeVisible({ timeout: 15_000 });
      await appt.dblclick();
      const dialog = A.page.locator('.e-schedule-dialog.e-popup-open');
      await expect(dialog).toBeVisible();
      await between();                                   // B renames while A's editor is open
      await dialog.locator('[name="Description"]').fill('Bring water');
      await dialog.locator('.e-event-save').click();
      await expect(dialog).toHaveCount(0);
    }, () => bRename(B, ev(B.page, 'p'), 'Practice (gym)'), async () => (await byId(id, 'p')).title === 'Practice (gym)');
    await soon(async () => { const e = await byId(id, 'p'); return [e.title, e.description]; }, 25_000).toEqual(['Practice (gym)', 'Bring water']);
    expect(A.errors.concat(B.errors)).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });
}

// =====================================================================================================
// ROOT 3: a copy keeps every field.
// =====================================================================================================
// Every Tuesday 10 AM in Tokyo (Monday 6 PM in Los Angeles), one date skipped.
const FULL = () => timed('jp', 'Tokyo standup', '2026-10-27T01:00:00Z', '2026-10-27T02:00:00Z',
  { tz: 'Asia/Tokyo', type: 6, description: 'Agenda: <b>notes</b> & "links" https://example.com', repeat: 'Weekly', recurrencerule: WEEKLY, recurrenceException: '20261110T010000Z' });
/** Every field of the copy is the original's, except the ones a copy resets (a copy is one event) and its times. */
function expectCopy(copy, original, start) {
  const resets = { recurrencerule: '', recurrenceID: null, recurrenceException: null, repeat: '' };
  const blank = (v) => (v === undefined || v === null || v === '' ? null : v);
  for (const f of ['title', 'description', 'type', 'isAllDay', 'tz', 'recurrencerule', 'recurrenceID', 'recurrenceException', 'repeat']) {
    expect(blank(copy[f]), f).toEqual(blank(f in resets ? resets[f] : original[f]));
  }
  expect(iso(copy.start)).toBe(iso(start));
  expect(new Date(copy.end) - new Date(copy.start)).toBe(new Date(original.end) - new Date(original.start));
}

test('ROOT3: Duplicate and an Option-drag copy of a fully populated event keep every field (S03)', async ({ browser }) => {
  const id = await seed([FULL()]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-27');
  // Option-drag the occurrence (Monday 6 PM here) 2h later.
  await ev(page, 'jp').first().scrollIntoViewIfNeeded();
  const b = await ev(page, 'jp').first().boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(b.x + b.width / 2, b.y + 8); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2, b.y + 8 + HOUR * 2 * i / 8);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await soon(async () => (await stored(id)).length).toBe(2);
  const dragged = (await stored(id)).find((e) => e.id !== 'jp');
  expectCopy(dragged, FULL(), '2026-10-27T03:00:00Z');
  // Duplicate the copy (Cmd/Ctrl+D): the next day, every field again.
  await openCard(page, ev(page, dragged.id), true);
  await page.getByTestId('card-more-actions').click();
  await page.getByTestId('card-duplicate').click();
  await soon(async () => (await stored(id)).length).toBe(3);
  const dup = (await stored(id)).find((e) => e.id !== 'jp' && e.id !== dragged.id);
  expectCopy(dup, { ...FULL(), recurrencerule: '', recurrenceException: null, repeat: '' }, '2026-10-28T03:00:00Z');
  expect(errors).toEqual([]);
  await ctx.close();
});

// =====================================================================================================
// ROOT 2 in classic: a zoned series, drawn and edited where native has it.
// =====================================================================================================
test('ROOT2 classic: a Tokyo weekly series is on Tokyo\'s days for an LA viewer, and deleting "this event" there skips that slot in native too', async ({ browser }) => {
  // Every Tuesday 10 AM in Tokyo = Monday 6 PM in Los Angeles (PDT), 5 PM after Nov 1 (PST): classic must follow Tokyo.
  const id = await seed([timed('jp', 'Tokyo standup', '2026-10-20T01:00:00Z', '2026-10-20T01:30:00Z', { tz: 'Asia/Tokyo', recurrencerule: WEEKLY })]);
  const C = await open(browser, id, '&view=week&date=2026-11-02', { classic: true });
  await C.page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-appointment'), null, { timeout: 30_000 });
  const shown = await C.page.evaluate(() => window.scheduleObj.getEvents(new Date(2026, 9, 25), new Date(2026, 10, 15), true).map((e) => new Date(e.StartTime).toISOString()));
  expect(shown).toEqual(['2026-10-27T01:00:00.000Z', '2026-11-03T01:00:00.000Z', '2026-11-10T01:00:00.000Z']);
  // Delete the Nov 2 (LA) occurrence from classic's quick popup.
  await C.page.locator('.e-appointment', { hasText: 'Tokyo standup' }).first().click();
  await C.page.locator('button.e-delete').locator('visible=true').first().click();
  const yes = C.page.locator('.e-quick-dialog.e-popup-open .e-quick-dialog-delete');
  await yes.click({ timeout: 3000 }).catch(() => {});   // (a confirm, when classic asks one)
  await soon(async () => (await byId(id, 'jp')).recurrenceException || '').toBe('20261103T010000Z');
  expect((await stored(id)).length).toBe(1);
  expect(C.errors).toEqual([]);
  await C.ctx.close();
  // Native, in Los Angeles: that Monday has none; the next has it.
  const N = await open(browser, id, '&view=week&date=2026-11-09');
  await expect(N.page.locator('.nc-timed', { hasText: 'Tokyo standup' })).toHaveCount(1);
  await N.ctx.close();
  const N2 = await open(browser, id, '&view=week&date=2026-11-02');
  await expect(N2.page.locator('.nc-timed', { hasText: 'Tokyo standup' })).toHaveCount(0);
  await N2.ctx.close();
});
