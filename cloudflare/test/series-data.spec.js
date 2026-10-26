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
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [200, 400, 800] });
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
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__tracked = []; Analytics.track = function (name, params) { window.__tracked.push({ name, ...this.baseParams(), ...params }); }; });
  return { ctx, page, errors };
}
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
  const editAll = async () => {
    await page.locator('.nc [data-testid="event-s1"]').first().click();
    await page.getByTestId('popover-edit').click();
    const dlg = page.getByTestId('confirm-dialog');
    await dlg.getByTestId('scope-all').check();
    await dlg.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('event-editor')).toBeVisible();
  };

  // A rename touches nothing the exceptions depend on: no question, nothing lost.
  await editAll();
  await page.getByTestId('editor-title').fill('Piano lesson');
  await page.getByTestId('editor-title').press('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await soon(async () => (await stored(id)).find((e) => e.id === 's1').title).toBe('Piano lesson');
  await page.waitForTimeout(800);
  let rows = await stored(id);
  expect(rows.map((e) => [e.id, e.recurrenceException]).sort()).toEqual([['o1', '20261019T160000Z'], ['s1', '20261012T160000Z,20261019T160000Z']]);

  // A time change asks; "keep" is the primary, focused button, so Enter keeps.
  await editAll();
  await page.getByTestId('editor-start-time').fill('09:30');
  await page.getByTestId('editor-title').press('Enter');
  const dlg = page.getByTestId('confirm-dialog');
  await expect(dlg).toContainText('match it to the whole series again?');
  await expect(dlg.getByTestId('confirm-no')).toHaveClass(/pc-btn--primary/);
  await expect(dlg.getByTestId('confirm-yes')).not.toHaveClass(/pc-btn--primary/);
  await expect(dlg.getByTestId('confirm-no')).toBeFocused();
  await page.keyboard.press('Enter');
  await soon(async () => (await stored(id)).find((e) => e.id === 's1').start).toBe(iso('2026-10-05T09:30:00-07:00'));
  rows = await stored(id);
  expect(rows).toHaveLength(2);
  expect(rows.find((e) => e.id === 's1').recurrenceException).toBeTruthy();
  expect(errors).toEqual([]);
  await ctx.close();
});
