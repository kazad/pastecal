// @ts-check
/**
 * Repeating events: changes that must never lose or duplicate someone's data, checked against what the SERVER
 * saved (GET /cal/<id>). Each test is a bug an adversarial review proved against a local server (Oct 2026):
 *   - renaming a series "All events" and pressing Enter twice wiped its skipped dates and edited occurrences
 *   - dragging a series "all events" and keeping its exceptions left their stamps behind (deleted dates came back,
 *     edited ones showed twice); dragging an edited occurrence measured from its edited time; UNTIL never moved
 *   - two browsers saving "This event" on one occurrence made two rows for one slot
 *   - Undo of an occurrence delete brought back another person's later delete
 *   - a refused save sent the event's title to analytics
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');
const { settled } = require('./settle');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';
const LABELS = ['Practice', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];
const iso = (s) => new Date(s).toISOString();
const timed = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });

let n = 0;
async function seed(events) {
  const id = `sd-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Series data', options: { typeLabels: LABELS }, events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100, 250, 500] });
const vm = (page, fn, arg) => page.evaluate(`(${fn})(document.querySelector('#app')._vnode.component.proxy, ${JSON.stringify(arg ?? null)})`);

async function open(browser, id, query = '', { timezoneId = 'America/Los_Angeles' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId, locale: 'en-US' });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(NOW) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${id}?backend=cf&cal=native${query}`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 20_000 });
  await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 15_000 });
  await settled(page);
  await page.evaluate(() => { window.__tracked = []; Analytics.track = function (name, params) { window.__tracked.push({ name, ...this.baseParams(), ...params }); }; });
  return { ctx, page, errors };
}
/** The event card (EventCard.js) on an event the grid draws; "this event" / "all events" when it asks. */
async function openCard(page, locator) {
  await locator.click();
  await expect(page.getByTestId('event-card')).toBeVisible();
  await page.waitForTimeout(250);   // past the card's entrance
}
async function pickScope(page, scope) {
  const dlg = page.getByTestId('confirm-dialog');
  await dlg.getByTestId(`scope-${scope}`).check();
  await dlg.getByTestId('confirm-ok').click();
  await expect(dlg.getByTestId('scope-this')).toHaveCount(0);   // (a follow-up question may take its place)
}
/** Open a card field's picker, type into it ("9:30a"), Enter. */
async function typeInto(page, field, text) {
  await page.getByTestId(field).click();
  const picker = page.getByTestId('card-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('picker-input').fill(text);
  await picker.getByTestId('picker-input').press('Enter');
  await expect(picker).toHaveCount(0);
}
const closeCard = async (page) => { if (await page.getByTestId('card-done').isVisible()) await page.getByTestId('card-done').click(); await expect(page.getByTestId('event-card')).toHaveCount(0); };

/** The occurrences the native grid draws for these stored events, Oct 1 - Nov 15, as "Mon Oct 26 09:00 Title". */
const expand = (page, events) => page.evaluate((evs) => NativeCalendar.occurrencesBetween(CalendarView.displayEvents(evs), new Date(2026, 9, 1), new Date(2026, 10, 15))
  .map((o) => `${o.start.toDateString().slice(0, 10)} ${o.start.toTimeString().slice(0, 5)} ${o.title}`), events);

// Piano on Mondays at 9:00 from Oct 5; Oct 12 skipped, Oct 19 edited (moved to Wed Oct 21 14:00).
const PIANO = () => [
  timed('s1', 'Piano', '2026-10-05T09:00:00-07:00', '2026-10-05T10:00:00-07:00', { recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;',
    recurrenceException: '20261012T160000Z,20261019T160000Z' }),
  timed('o1', 'Piano (moved)', '2026-10-21T14:00:00-07:00', '2026-10-21T15:00:00-07:00', { recurrenceID: 's1',
    recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', recurrenceException: '20261019T160000Z' }),
];

// =====================================================================================================
test('renaming a series "All events" then Enter, Enter keeps its skipped and edited dates; when asked, keeping is the focused answer', async ({ browser }) => {
  const id = await seed(PIANO());
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-26');
  const occ = () => page.locator('.nc [data-testid="event-s1"]').first();   // Mon Oct 26

  // A rename (in the event card, "all events") touches nothing the exceptions depend on: no question, nothing lost.
  await openCard(page, occ());
  await page.getByTestId('card-title').fill('Piano lesson');
  await page.getByTestId('card-title').press('Enter');
  await pickScope(page, 'all');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await soon(async () => (await stored(id)).find((e) => e.id === 's1').title).toBe('Piano lesson');
  await page.waitForTimeout(800);
  let rows = await stored(id);
  expect(rows.map((e) => [e.id, e.recurrenceException]).sort()).toEqual([['o1', '20261019T160000Z'], ['s1', '20261012T160000Z,20261019T160000Z']]);
  await closeCard(page);

  // A time change asks; "keep" is the primary, focused button, so Enter keeps (and the kept dates move with it:
  // the card's "all events" takes the drag's path).
  await openCard(page, occ());
  await typeInto(page, 'card-q-s', '9:30a');
  await pickScope(page, 'all');
  const dlg = page.getByTestId('confirm-dialog');
  await expect(dlg).toContainText('match it to the whole series again?');
  await expect(dlg.getByTestId('confirm-no')).toHaveClass(/pc-btn--primary/);
  await expect(dlg.getByTestId('confirm-yes')).not.toHaveClass(/pc-btn--primary/);
  await expect(dlg.getByTestId('confirm-no')).toBeFocused();
  await page.keyboard.press('Enter');
  await soon(async () => (await stored(id)).find((e) => e.id === 's1').start).toBe(iso('2026-10-05T09:30:00-07:00'));
  rows = await stored(id);
  expect(rows).toHaveLength(2);
  expect(rows.find((e) => e.id === 's1').recurrenceException).toBe('20261012T163000Z,20261019T163000Z');
  expect(rows.find((e) => e.id === 'o1').recurrenceException).toBe('20261019T163000Z');
  expect(errors).toEqual([]);
  await ctx.close();
});

// =====================================================================================================
/** Drag an occurrence (programmatically, as NativeCalendar emits it), choose "All events", then keep the exceptions. */
async function moveAllKeep(page, rowId, occ, toStart) {
  await vm(page, (v, a) => {
    const ev = v.calendar.events.find((e) => e.id === a.rowId);
    const occurrence = { start: new Date(a.occ[0]), end: new Date(a.occ[1]) };
    v.onNativeDragStart({ event: ev });
    const start = new Date(a.toStart);
    v.onNativeMove({ event: ev, occurrence, start, end: new Date(start.getTime() + (occurrence.end - occurrence.start)) });
  }, { rowId, occ: occ.map(iso), toStart: iso(toStart) });
  const dlg = page.getByTestId('confirm-dialog');
  await dlg.getByTestId('scope-all').check();
  await dlg.getByTestId('confirm-ok').click();
  await dlg.getByTestId('confirm-no').click();
}

test('dragging a series "all events" and keeping its exceptions moves the skipped and edited dates with it', async ({ browser }) => {
  const id = await seed(PIANO());
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-26');
  await moveAllKeep(page, 's1', ['2026-10-26T09:00:00-07:00', '2026-10-26T10:00:00-07:00'], '2026-10-26T10:00:00-07:00');
  await soon(async () => (await stored(id)).find((e) => e.id === 's1').start).toBe(iso('2026-10-05T10:00:00-07:00'));
  const rows = await stored(id);
  expect(rows.find((e) => e.id === 's1').recurrenceException).toBe('20261012T170000Z,20261019T170000Z');
  expect(rows.find((e) => e.id === 'o1').recurrenceException).toBe('20261019T170000Z');
  expect(await expand(page, rows)).toEqual(['Mon Oct 05 10:00 Piano', 'Wed Oct 21 14:00 Piano (moved)', 'Mon Oct 26 10:00 Piano',
    'Mon Nov 02 10:00 Piano', 'Mon Nov 09 10:00 Piano']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('dragging an EDITED occurrence "all events" moves the series from that occurrence\'s own slot', async ({ browser }) => {
  const id = await seed(PIANO());
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-21');
  // The Oct 19 occurrence (shown Wed Oct 21 14:00) dropped on Thu Oct 22 14:00: its slot, Mon Oct 19 9:00, moves there.
  await moveAllKeep(page, 'o1', ['2026-10-21T14:00:00-07:00', '2026-10-21T15:00:00-07:00'], '2026-10-22T14:00:00-07:00');
  await soon(async () => (await stored(id)).find((e) => e.id === 's1').start).toBe(iso('2026-10-08T14:00:00-07:00'));
  const rows = await stored(id);
  const s1 = rows.find((e) => e.id === 's1');
  expect([s1.end, s1.recurrencerule, s1.recurrenceException]).toEqual([iso('2026-10-08T15:00:00-07:00'), 'FREQ=WEEKLY;BYDAY=TH;INTERVAL=1;',
    '20261015T210000Z,20261022T210000Z']);
  expect(rows.find((e) => e.id === 'o1').recurrenceException).toBe('20261022T210000Z');
  const shown = await expand(page, rows);
  expect(shown).toEqual(['Thu Oct 08 14:00 Piano', 'Wed Oct 21 14:00 Piano (moved)', 'Thu Oct 29 14:00 Piano', 'Thu Nov 05 14:00 Piano', 'Thu Nov 12 14:00 Piano']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('dragging a series that ends (UNTIL) "all events" to another day moves its end date too', async ({ browser }) => {
  // Tuesdays Oct 6 - Oct 27 at 10:00, dragged from Tue Oct 20 to Thu Oct 22: Thursdays Oct 8 - Oct 29, still four.
  const id = await seed([timed('u', 'Course', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00',
    { recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;UNTIL=20261027T170000Z;' })]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-21');
  await vm(page, (v) => {
    const ev = v.calendar.events[0];
    v.onNativeDragStart({ event: ev });
    v.onNativeMove({ event: ev, occurrence: { start: new Date('2026-10-20T10:00:00-07:00'), end: new Date('2026-10-20T11:00:00-07:00') },
      start: new Date('2026-10-22T10:00:00-07:00'), end: new Date('2026-10-22T11:00:00-07:00') });
  });
  const dlg = page.getByTestId('confirm-dialog');
  await dlg.getByTestId('scope-all').check();
  await dlg.getByTestId('confirm-ok').click();
  await soon(async () => (await stored(id))[0].recurrencerule).toBe('FREQ=WEEKLY;BYDAY=TH;INTERVAL=1;UNTIL=20261029T170000Z;');
  expect(await expand(page, await stored(id))).toEqual(['Thu Oct 08 10:00 Course', 'Thu Oct 15 10:00 Course', 'Thu Oct 22 10:00 Course', 'Thu Oct 29 10:00 Course']);
  expect(errors).toEqual([]);
  await ctx.close();
});

// =====================================================================================================
test('two browsers saving "This event" on the same occurrence keep one row for that slot', async ({ browser }) => {
  const id = await seed([timed('s1', 'Standup', '2026-10-19T09:00:00-07:00', '2026-10-19T09:30:00-07:00', { recurrencerule: 'FREQ=DAILY;INTERVAL=1;' })]);
  const A = await open(browser, id, '&view=week&date=2026-10-21');
  const B = await open(browser, id, '&view=week&date=2026-10-21');
  const occ = { start: iso('2026-10-21T09:00:00-07:00'), end: iso('2026-10-21T09:30:00-07:00') };
  for (const P of [A, B]) {
    await vm(P.page, (v, o) => v.openNativeCard({ event: v.calendar.events[0], occurrence: { start: new Date(o.start), end: new Date(o.end) } }), occ);
    await expect(P.page.getByTestId('event-card')).toBeVisible();
  }
  await B.page.getByTestId('card-title').fill('Standup (B: room 4)');
  await B.page.getByTestId('card-title').press('Enter');
  await pickScope(B.page, 'this');
  await soon(async () => (await stored(id)).length).toBe(2);
  await soon(() => vm(A.page, (v) => v.calendar.events.length)).toBe(2);
  await A.page.getByTestId('card-title').fill('Standup (A: moved online)');
  await A.page.getByTestId('card-title').press('Enter');
  await pickScope(A.page, 'this');
  await soon(async () => (await stored(id)).map((e) => e.title).sort()).toEqual(['Standup', 'Standup (A: moved online)']);
  const rows = await stored(id);
  expect(rows).toHaveLength(2);
  expect(rows.find((e) => e.id === 's1').recurrenceException).toBe('20261021T160000Z');
  expect(rows.find((e) => e.id !== 's1').recurrenceException).toBe('20261021T160000Z');
  await expect(A.page.locator('.nc-timed', { hasText: /Standup \(/ })).toHaveCount(1);
  expect([...A.errors, ...B.errors]).toEqual([]);
  await A.ctx.close(); await B.ctx.close();
});

// =====================================================================================================
test('Undo of an occurrence delete takes back only its own skipped date, not one another person added since', async ({ browser }) => {
  const id = await seed([timed('s1', 'Standup', '2026-10-19T09:00:00-07:00', '2026-10-19T09:30:00-07:00', { recurrencerule: 'FREQ=DAILY;INTERVAL=1;' })]);
  const A = await open(browser, id, '&view=week&date=2026-10-21');
  const B = await open(browser, id, '&view=week&date=2026-10-21');
  const del = (P, day) => vm(P.page, (v, d) => {
    const s = new Date(`2026-10-${d}T09:00:00-07:00`);
    v.nativeDeleteEvent(v.calendar.events[0], { start: s, end: new Date(s.getTime() + 1800000), recurring: true });
  }, day);
  await del(A, 20);
  await A.page.getByTestId('confirm-dialog').getByTestId('confirm-ok').click();   // "This event" is preselected
  await soon(async () => (await stored(id))[0].recurrenceException).toBe('20261020T160000Z');
  await soon(() => vm(B.page, (v) => v.calendar.events[0].recurrenceException)).toBe('20261020T160000Z');
  await del(B, 22);
  await B.page.getByTestId('confirm-dialog').getByTestId('confirm-ok').click();
  await soon(async () => (await stored(id))[0].recurrenceException).toBe('20261020T160000Z,20261022T160000Z');
  await soon(() => vm(A.page, (v) => v.calendar.events[0].recurrenceException)).toBe('20261020T160000Z,20261022T160000Z');
  await A.page.getByRole('button', { name: 'Undo' }).click();
  await soon(async () => (await stored(id))[0].recurrenceException).toBe('20261022T160000Z');
  await A.page.waitForTimeout(800);
  expect((await stored(id))[0].recurrenceException).toBe('20261022T160000Z');
  expect([...A.errors, ...B.errors]).toEqual([]);
  await A.ctx.close(); await B.ctx.close();
});

// =====================================================================================================
test('an occurrence whose series was deleted meanwhile: the card closes and says so; a save that still arrives saves nothing, analytics gets no event text', async ({ browser }) => {
  const id = await seed([timed('s1', 'Standup', '2026-10-19T09:00:00-07:00', '2026-10-19T09:30:00-07:00', { recurrencerule: 'FREQ=DAILY;INTERVAL=1;' })]);
  const A = await open(browser, id, '&view=week&date=2026-10-21');
  const B = await open(browser, id, '&view=week&date=2026-10-21');
  await vm(A.page, (v) => {
    v.openNativeCard({ event: v.calendar.events[0], occurrence: { start: new Date('2026-10-21T09:00:00-07:00'), end: new Date('2026-10-21T09:30:00-07:00') } });
    window.__rec = v.nativeRecord(v.calendar.events[0]);   // the series' record as the card had it
  });
  await expect(A.page.getByTestId('event-card')).toBeVisible();
  await vm(B.page, (v) => v.store().dispatch({ type: 'remove', key: { id: 's1', recurrenceID: null } }, { label: 'remote delete' }));
  await soon(async () => (await stored(id)).length).toBe(0);
  await soon(() => vm(A.page, (v) => v.calendar.events.length)).toBe(0);
  await expect(A.page.getByTestId('event-card')).toHaveCount(0);
  await expect(A.page.getByText("This event's series was deleted.")).toBeVisible();
  // "This event" saved just as the series went (the write path's own check): refused with a code, nothing saved.
  await vm(A.page, (v) => v.nativeAction('eventChange', { changedRecords: [{ ...window.__rec, Subject: 'Dr. Patel - biopsy results for Maria',
    Id: '__native_occurrence__', RecurrenceID: 's1' }] }, { action: 'EditOccurrence', occurrenceStart: new Date('2026-10-21T09:00:00-07:00') }));
  await A.page.waitForTimeout(800);
  expect(await stored(id)).toEqual([]);
  const sent = JSON.stringify(await A.page.evaluate(() => window.__tracked));
  expect(sent).not.toContain('Patel');
  expect(sent).not.toContain('Standup');
  await A.ctx.close(); await B.ctx.close();
});

// =====================================================================================================
// A timed series' skipped date is matched by the viewer's local DATE, as classic matches it (Syncfusion parses each
// stamp and compares its local day): deleted at 9:00 PST in Los Angeles, the Nov 9 occurrence is 9:00 MST in
// Phoenix (no DST), an hour from the stamp. Native compared to the minute and showed it again there.
// Not fixed, in either renderer: a viewer whose local DAY differs (Tokyo) expands the weekly series on their own
// weekday, so the occurrences (and the skipped one) fall at other instants. This test only holds native to classic.
for (const zone of ['America/Phoenix', 'America/New_York', 'Asia/Tokyo', 'Europe/London']) {
  test(`native skips the same occurrences of a timed series as classic for a viewer in ${zone}`, async ({ browser }) => {
    const id = await seed([timed('s1', 'Standup', '2026-10-05T09:00:00-07:00', '2026-10-05T09:30:00-07:00',
      { recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', recurrenceException: '20261109T170000Z' })]);
    const shown = async (native, check) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: zone, locale: 'en-US' });
      await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
      await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
      const page = await ctx.newPage();
      await page.goto(`/${id}?backend=cf&view=month&date=2026-11-09${native ? '&cal=native' : ''}`);
      await page.waitForFunction(() => document.querySelector('#app')?._vnode?.component?.proxy?.isLoading === false, null, { timeout: 20_000 });
      await expect(page.locator(native ? '.nc' : '.e-schedule')).toBeVisible({ timeout: 20_000 });
      await check(() => vm(page, (v) => v.calView.occurrences(new Date(2026, 10, 1), new Date(2026, 10, 20)).map((o) => o.start.toISOString())));
      await ctx.close();
    };
    let classic;
    await shown(false, (occ) => expect.poll(async () => (classic = await occ()).length, { message: 'classic draws the series' }).toBeGreaterThan(1));
    await shown(true, (occ) => expect.poll(occ).toEqual(classic));
  });
}

// =====================================================================================================
test('a description full of markup and odd links shows as text in the event card on an edit link: no injected elements, only safe hrefs', async ({ browser }) => {
  const nasty = 'http://a.co/"onmouseover="alert(1) www.a.co\'><img src=x onerror=alert(1)> javascript:alert(1) a"b@x.co &lt;script&gt;';
  const id = await seed([{ ...PIANO()[0], description: nasty }]);
  const { ctx, page, errors } = await open(browser, id, '&view=week&date=2026-10-26');
  await page.locator('.nc [data-testid="event-s1"]').first().click();
  const d = page.getByTestId('card-details-preview');
  await expect(d).toBeVisible();
  expect(await d.evaluate((el) => el.querySelectorAll('img,script,iframe,[onmouseover],[onerror]').length)).toBe(0);
  const hrefs = await d.evaluate((el) => [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')));
  for (const h of hrefs) expect(h, h).toMatch(/^(https?:|mailto:)/);
  expect(await d.textContent()).toContain('javascript:alert(1)');
  expect(errors).toEqual([]);
  await ctx.close();
});
