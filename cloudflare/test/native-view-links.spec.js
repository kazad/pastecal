// @ts-check
/**
 * View links on pastecal's own calendar (docs/native-switch.md, milestone 1), driven like a visitor: a view link
 * opened with ?cal=native draws NativeCalendar inside the main app and downloads nothing of Syncfusion's. Its
 * events land on the right days (a weekly repeat with one skipped date, an all-day event over three days), the
 * views and next / previous work, an event opens its popup, the color filter hides events, an edit made on the
 * edit link shows up live, Ctrl+P prints the paper month with the repeat, ?embed works, and a phone gets no
 * sideways scroll. The same calendar drawn by both renderers lists the same occurrences, in Los Angeles and in
 * Tokyo. Without the flag the view link is classic (Syncfusion), and so is the edit link (its editing on the
 * native calendar is native-editing.spec.js). Also measures the bytes of both.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const VM = `document.querySelector('#app')._vnode.component.proxy`;
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// This month (in the test's zone, Los Angeles): a weekly practice on Tuesdays at 5:30 PM with its 2nd Tuesday
// skipped, a game on the 10th, a three-day all-day camp (16th-18th), and an orange event on the 21st.
function plan() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1, 17, 30);
  while (first.getDay() !== 2) first.setDate(first.getDate() + 1);
  const skipped = new Date(first); skipped.setDate(first.getDate() + 7);
  const tuesdays = [];
  for (let d = new Date(first); d.getMonth() === m; d.setDate(d.getDate() + 7)) tuesdays.push(ymd(d));
  const at = (day, h) => new Date(y, m, day, h).toISOString();
  const tokyoMidnight = (day) => new Date(Date.UTC(y, m, day) - 9 * 3600000);
  const firstMon = [1, 2, 3, 4, 5, 6, 7].find((d) => new Date(Date.UTC(y, m, d)).getUTCDay() === 1);
  const events = [
    { id: 'w', title: 'Weekly practice', start: first.toISOString(), end: new Date(first.getTime() + 3600000).toISOString(), type: 1,
      repeat: 'weekly', recurrencerule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceException: stampOf(skipped) },
    { id: 'g', title: 'Game vs Hawks', start: at(10, 10), end: at(10, 11), type: 2, description: 'Bring water.' },
    { id: 'c', title: 'Camp', start: new Date(y, m, 16).toISOString(), end: new Date(y, m, 19).toISOString(), type: 4, isAllDay: true },
    { id: 'o', title: 'Orange thing', start: at(21, 9), end: at(21, 10), type: 5 },
    // Written in Tokyo: an all-day series on Mondays, its dates and its skipped 3rd Monday at Tokyo's midnight,
    // as stored (the stamp-format / local-midnight data path both renderers must read alike).
    { id: 'a', title: 'All-day Mondays', start: tokyoMidnight(firstMon).toISOString(), end: tokyoMidnight(firstMon + 1).toISOString(), type: 6, isAllDay: true,
      repeat: 'weekly', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1', recurrenceException: stampOf(tokyoMidnight(firstMon + 14)) },
  ];
  return { y, m, events, tuesdays, skipped: ymd(skipped), campDays: [16, 17, 18].map((d) => ymd(new Date(y, m, d))) };
}

// One calendar per worker for the tests that only read it (creating calendars is rate limited: 10 a minute);
// a test that writes asks for its own (fresh), since tests of a file run in any order across workers.
let shared;
async function seed(request, events, title = 'Native view test', fresh = false) {
  if (shared && !fresh) return shared;
  const id = `test-native-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  expect((await request.post(`/cal/${id}`, { data: { title, options: {}, events } })).status()).toBe(201);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  expect(view.ok).toBe(true);
  const made = { id, viewId: view.publicViewId };
  if (!fresh) shared = made;
  return made;
}

async function context(browser, { viewport = { width: 1280, height: 900 }, timezoneId = 'America/Los_Angeles', colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600, timezoneId, locale: 'en-US', colorScheme });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  return ctx;
}

// A native view link, with every request it made.
async function openNative(ctx, viewId, extra = '') {
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`/view/${viewId}?backend=cf&cal=native${extra}`);
  await page.waitForFunction(() => document.querySelector('.nc [data-testid^="event-"]'), null, { timeout: 20_000 });
  return { page, requests };
}

// The dates (YYYY-MM-DD) each shown bar of an event covers on the month grid.
const daysOf = (page, testid) => page.evaluate((tid) => {
  const cells = [...document.querySelectorAll('.nc-cell[data-day]')].map((c) => ({ r: c.getBoundingClientRect(), day: Number(c.dataset.day) }));
  const out = [];
  for (const bar of document.querySelectorAll(`.nc-month [data-testid="${tid}"]`)) {
    const b = bar.getBoundingClientRect(), cy = b.top + b.height / 2;
    for (const c of cells) if (c.r.top <= cy && cy <= c.r.bottom && c.r.left < b.right - 4 && c.r.right > b.left + 4) {
      const d = new Date(c.day); out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
  }
  return out.sort();
}, testid);

test('native view link: no Syncfusion, events on the right days, views, navigation, popup, filter', async ({ browser, request }) => {
  const p = plan();
  const { viewId } = await seed(request, p.events);
  const ctx = await context(browser);
  const { page, requests } = await openNative(ctx, viewId);

  expect(requests.filter((u) => /\/vendor\/syncfusion/.test(u)), 'no Syncfusion file is requested').toEqual([]);
  expect(await page.evaluate(() => typeof window.ej === 'undefined' && !window.scheduleObj)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.dataset.cal)).toBe('native');
  await expect(page.getByTestId('view-only-badge')).toHaveText('View only');
  await expect(page.locator('[data-testid="view-add-to-cal"]:visible')).toHaveAttribute('href', new RegExp(`/view/${viewId}/add$`));

  // The weekly repeat on every Tuesday but the skipped one; the camp across its three days; the game on the 10th.
  expect(await daysOf(page, 'event-w')).toEqual(p.tuesdays.filter((d) => d !== p.skipped));
  expect(await daysOf(page, 'event-c')).toEqual(p.campDays);
  expect(await daysOf(page, 'event-g')).toEqual([ymd(new Date(p.y, p.m, 10))]);
  await expect(page.locator('.nc-month [data-testid="event-w"]').first()).toContainText('5:30 PM');

  // The popup: title, time, details.
  await page.locator('.nc-month [data-testid="event-g"]').click();
  const pop = page.getByTestId('event-popover');
  await expect(pop).toBeVisible();
  await expect(page.getByTestId('popover-title')).toHaveText('Game vs Hawks');
  await expect(pop).toContainText('10:00 AM - 11:00 AM');
  await expect(page.getByTestId('popover-description')).toHaveText('Bring water.');
  await expect(page.getByTestId('popover-edit')).toHaveCount(0);   // view only
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  // A repeat's popup names the occurrence clicked and says it repeats.
  await page.locator('.nc-month [data-testid="event-w"]').nth(1).click();
  await expect(page.getByTestId('popover-repeats')).toHaveText('Repeats every week');
  await page.mouse.click(5, 300);
  await expect(pop).toHaveCount(0);

  // Next / previous, and the views. A click on a day opens that day (as on the classic view link).
  const title = page.getByTestId('current-date-range');
  const month = await title.textContent();
  await page.getByTestId('nav-next').click();
  await expect(title).not.toHaveText(month || '');
  await page.getByTestId('nav-prev').click();
  await expect(title).toHaveText(month || '');
  await page.locator('.nc-views').getByText('Week', { exact: true }).click();
  await expect(page.getByTestId('time-grid')).toBeVisible();
  await page.locator('.nc-views').getByText('Agenda', { exact: true }).click();
  await expect(page.getByTestId('agenda-view')).toBeVisible();
  await page.locator('.nc-views').getByText('Year', { exact: true }).click();
  await expect(page.getByTestId('year-view')).toBeVisible();
  await page.locator('.nc-views').getByText('3 Months', { exact: true }).click();
  await expect(page.locator('.nc-week-row').nth(12)).toBeVisible();
  await page.locator('.nc-views').getByText('Month', { exact: true }).click();
  await page.locator(`.nc-cell[data-day="${new Date(p.y, p.m, 10).getTime()}"]`).click({ position: { x: 60, y: 60 } });
  await expect(page.getByTestId('time-grid')).toBeVisible();
  await expect(page.locator('.nc-timed[data-testid="event-g"]')).toBeVisible();
  await expect(title).toContainText(`${new Date(p.y, p.m, 10).toLocaleDateString('en-US', { month: 'long' })} 10,`);

  // The color filter (search panel): only Type 2 shown; the practice goes, the game stays; the banner says so.
  await page.locator('.nc-views').getByText('Month', { exact: true }).click();
  await page.getByTestId('search-button-desktop').click();
  await page.getByTestId('color-filter').getByRole('switch', { name: /^Type 2/ }).click();
  await expect(page.locator('.nc-month [data-testid="event-w"]')).toHaveCount(0);
  await expect(page.locator('.nc-month [data-testid="event-g"]')).toHaveCount(1);
  await expect(page.getByTestId('hidden-events-banner')).toBeVisible();
  // Search results: "Show on calendar" opens the event's week.
  await page.getByTestId('search-results').getByText('Game vs Hawks').click();
  await page.getByText('Show on calendar').click();
  await expect(page.getByTestId('time-grid')).toBeVisible();
  await expect(page.locator('.nc-timed[data-testid="event-g"]')).toBeVisible();
  await page.getByTestId('color-filter-reset').click();
  await ctx.close();
});

test('native view link: an edit on the edit link shows up without a reload', async ({ browser, request }) => {
  const p = plan();
  const { id, viewId } = await seed(request, p.events, undefined, true);
  const ctx = await context(browser);
  const { page } = await openNative(ctx, viewId);
  const editor = await ctx.newPage();
  await editor.goto(`/${id}?backend=cf`);
  await editor.waitForFunction(() => window.__appMounted && window.scheduleObj && (scheduleObj.eventsData || []).length >= 4, null, { timeout: 20_000 });
  const day = new Date(p.y, p.m, 12, 14);
  await editor.evaluate(({ start, end }) => {
    const vm = document.querySelector('#app')._vnode.component.proxy;
    vm.store().dispatch({ type: 'add', event: { id: null, title: 'Added live', start, end, type: 3 } }, { label: 'Added event' });
  }, { start: day.toISOString(), end: new Date(day.getTime() + 3600000).toISOString() });
  const t0 = Date.now();
  await expect(page.locator('.nc-month .nc-bar', { hasText: 'Added live' })).toBeVisible({ timeout: 4000 });
  const ms = Date.now() - t0;
  console.log(`[native] edit -> view link: ${ms} ms`);
  expect(ms, 'within about two seconds').toBeLessThan(2500);
  await ctx.close();
});

test('native view link: Ctrl+P prints the paper month with the repeat', async ({ browser, request }) => {
  const p = plan();
  const { viewId } = await seed(request, p.events);
  const ctx = await context(browser);
  const { page } = await openNative(ctx, viewId);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  const cal = page.locator('.pc-print-cal');
  await expect(cal).toBeVisible();
  await expect(page.locator('.pc-native-cal')).toBeHidden();
  await expect(page.locator('.pc-print-title')).toHaveText('Native view test');
  await expect(page.locator('.pc-print-range')).toHaveText(new Date(p.y, p.m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
  // Every Tuesday this month but the skipped one (the paper month also shows the next month's first days).
  expect(await cal.locator('.pc-pm-day:not(.is-out) .pc-pm-ev', { hasText: 'Weekly practice' }).count()).toBe(p.tuesdays.length - 1);
  expect(await cal.locator('.pc-pm-day:not(.is-out) .pc-pm-ev', { hasText: 'Camp' }).count()).toBe(3);
  await expect(cal).toContainText('Game vs Hawks');
  await ctx.close();
});

test('native view link: embeds, and a phone without sideways scroll', async ({ browser, request }) => {
  const p = plan();
  const { viewId } = await seed(request, p.events);
  let ctx = await context(browser);
  let { page, requests } = await openNative(ctx, viewId, '&embed');
  await expect(page.getByTestId('embed-credit')).toHaveText('pastecal');
  await expect(page.locator('.nc-month [data-testid="event-g"]')).toBeVisible();
  expect(requests.filter((u) => /\/vendor\/syncfusion/.test(u))).toEqual([]);
  await ctx.close();

  ctx = await context(browser, { viewport: { width: 390, height: 844 } });
  ({ page } = await openNative(ctx, viewId));
  await expect(page.getByTestId('view-only-badge-mobile')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true);
  expect(await daysOf(page, 'event-w')).toEqual(p.tuesdays.filter((d) => d !== p.skipped));
  // The views live behind a menu on a phone.
  await page.getByTestId('view-menu').click();
  await page.locator('.nc-view-menu').getByText('Agenda').click();
  await expect(page.getByTestId('agenda-view')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll in Agenda').toBe(true);
  await page.locator('.nc-agenda [data-testid^="event-"]').first().click();
  await expect(page.getByTestId('event-popover')).toBeVisible();
  const box = await page.getByTestId('event-popover').boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390, 'the popup fits the screen').toBe(true);
  await ctx.close();
});

test('flag off: the view link stays classic (Syncfusion), and ?cal=classic beats a stored choice', async ({ browser, request }) => {
  const p = plan();
  const { id, viewId } = await seed(request, p.events);
  const ctx = await context(browser);
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`/view/${viewId}?backend=cf`);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  expect(requests.some((u) => /\/vendor\/syncfusion-[\d.]+\/ej2-calendar\.min\.js/.test(u))).toBe(true);
  expect(requests.some((u) => /\/vendor\/syncfusion-[\d.]+\/material(-dark)?\.css/.test(u))).toBe(true);
  expect(requests.some((u) => /NativeCalendar\.js|native-calendar\.css/.test(u)), 'classic loads none of the native files').toBe(false);
  await expect(page.locator('.nc')).toHaveCount(0);
  // This browser's choice (localStorage pc_cal) turns native on; ?cal=classic turns it back off for one visit.
  await page.evaluate(() => localStorage.setItem('pc_cal', 'native'));
  await page.goto(`/view/${viewId}?backend=cf`);
  await page.waitForFunction(() => document.querySelector('.nc [data-testid^="event-"]'), null, { timeout: 20_000 });
  await page.goto(`/view/${viewId}?backend=cf&cal=classic`);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  // Edit links follow the same flag since milestone 2 (?cal=native, or this browser's choice), but never the
  // server's view-link default: with neither, the edit link is classic.
  await page.goto(`/${id}?backend=cf`);
  await page.waitForFunction(() => document.querySelector('.nc.nc-editable [data-testid^="event-"]'), null, { timeout: 20_000 });
  await page.evaluate(() => localStorage.removeItem('pc_cal'));
  await page.goto(`/${id}?backend=cf`);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  await expect(page.locator('.nc')).toHaveCount(0);
  await page.goto(`/${id}?backend=cf&cal=native`);
  await page.waitForFunction(() => document.querySelector('.nc.nc-editable [data-testid^="event-"]'), null, { timeout: 20_000 });
  expect(await page.evaluate(() => typeof window.ej === 'undefined')).toBe(true);
  await ctx.close();
});

// A view link's ?view= / ?date= (Share's "This view", printed links) opens the same view on the same dates in both.
test('native view link: ?view= and ?date= open the same view and dates as classic', async ({ browser, request }) => {
  const p = plan();
  const { viewId } = await seed(request, p.events);
  const ctx = await context(browser);
  const tenth = `${p.y}-${String(p.m + 1).padStart(2, '0')}-10`;
  const state = (page) => page.evaluate((vm) => {
    const v = eval(vm).calView, d = v.selectedDate(), r = v.visibleRange();
    return { view: v.currentView(), date: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, start: r && new Date(r.start).toDateString(), end: r && new Date(r.end).toDateString() };
  }, VM);
  for (const q of [`view=week&date=${tenth}`, `v=d&d=${tenth}`, `view=agenda&date=${tenth}`, `view=year`]) {
    const classic = await ctx.newPage();
    await classic.goto(`/view/${viewId}?backend=cf&${q}`);
    await classic.waitForFunction(() => window.scheduleObj && (scheduleObj.eventsData || []).length >= 4, null, { timeout: 20_000 });
    await classic.waitForTimeout(300);
    const native = await ctx.newPage();
    await native.goto(`/view/${viewId}?backend=cf&cal=native&${q}`);
    await native.waitForFunction((vm) => document.querySelector('.nc') && eval(vm).calendar.events.length >= 4, VM, { timeout: 20_000 });
    expect(await state(native), q).toEqual(await state(classic));
    await classic.close(); await native.close();
  }
  // The N-weeks / N-months links (q, 12w, custom + dur/unit). Classic opens these as Day (on branch pro too: its
  // custom view is replaced when the calendar loads); native opens the view the link names.
  for (const [q, view, start] of [[`view=q&date=${tenth}`, '3 Months', new Date(p.y, p.m, 1)], [`view=12w&date=${tenth}`, '12 Weeks', new Date(p.y, p.m, 10)],
    [`view=custom&dur=2&unit=weeks&date=${tenth}`, '2 Weeks', new Date(p.y, p.m, 10)]]) {
    const native = await ctx.newPage();
    await native.goto(`/view/${viewId}?backend=cf&cal=native&${q}`);
    await native.waitForFunction((vm) => document.querySelector('.nc') && eval(vm).calendar.events.length >= 4, VM, { timeout: 20_000 });
    const s = await state(native);
    expect(s.view, q).toBe(view);
    const first = new Date(start); first.setDate(first.getDate() - first.getDay());   // the week holding it
    expect(s.start, q).toBe(first.toDateString());
    await native.close();
  }
  // And it draws that view: the week of the 10th, with the game in it.
  const { page } = await openNative(ctx, viewId, `&view=week&date=${tenth}`);
  await expect(page.getByTestId('time-grid')).toBeVisible();
  await expect(page.locator('.nc-timed[data-testid="event-g"]')).toBeVisible();
  await ctx.close();
});

// Same calendar, both renderers: the occurrences listed for this month agree, read in Los Angeles and in Tokyo.
// The all-day series was written in Tokyo (its dates and skipped date at Tokyo's midnight, as stored), the timed
// one in Los Angeles; this is the stamp-format / local-midnight data path both renderers must read alike.
for (const timezoneId of ['America/Los_Angeles', 'Asia/Tokyo']) {
  test(`both renderers list the same occurrences (${timezoneId})`, async ({ browser, request }) => {
    const p = plan();
    const { viewId } = await seed(request, p.events);
    const ctx = await context(browser, { timezoneId });
    const range = { start: new Date(p.y, p.m, 1).getTime(), end: new Date(p.y, p.m + 1, 1).getTime() };
    const list = (page) => page.evaluate(({ vm, range }) => {
      const app = eval(vm);
      const day = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      // In the viewer's zone: rebuild the month from the page's own clock.
      const now = new Date(); const s = new Date(now.getFullYear(), now.getMonth(), 1), e = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return app.calView.occurrences(s, e).map((o) => `${o.title}|${day(o.start)}|${day(o.end)}|${o.allDay ? 'all' : o.start.getHours() + ':' + o.start.getMinutes()}|${o.event && o.event.id}`).sort();
    }, { vm: VM, range });
    const classic = await ctx.newPage();
    await classic.goto(`/view/${viewId}?backend=cf`);
    await classic.waitForFunction(() => window.scheduleObj && (scheduleObj.eventsData || []).length >= 5, null, { timeout: 20_000 });
    const { page: native } = await openNative(ctx, viewId);
    await native.waitForFunction((vm) => eval(vm).calendar.events.length >= 5, VM);
    const a = await list(classic), b = await list(native);
    expect(b).toEqual(a);
    expect(a.filter((x) => x.startsWith('All-day Mondays')).length).toBeGreaterThanOrEqual(3);   // the skipped Monday is gone in both
    await ctx.close();
  });
}

// Bytes over the wire for one first visit to a view link (cold cache, same third parties allowed), classic vs
// native, from the browser's own count (CDP encodedDataLength). wrangler dev gzips as production does.
test('bytes: a view link, classic vs native', async ({ browser, request }) => {
  const p = plan();
  const { viewId } = await seed(request, p.events);
  const measure = async (extra, ready) => {
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const urls = new Map(), out = { total: 0, syncfusion: 0, calendar: 0, files: 0 };
    cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
    cdp.on('Network.loadingFinished', (e) => {
      const url = urls.get(e.requestId) || '', n = e.encodedDataLength || 0;
      out.total += n; out.files++;
      if (/\/vendor\/syncfusion/.test(url)) out.syncfusion += n;
      if (/\/nativecal\/components\/|native-calendar\.css|rrule/.test(url)) out.calendar += n;
    });
    await page.goto(`/view/${viewId}?backend=cf${extra}`);
    await page.waitForFunction(ready, null, { timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await ctx.close();
    return out;
  };
  const classic = await measure('', () => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'));
  const native = await measure('&cal=native', () => document.querySelector('.nc [data-testid^="event-"]'));
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  console.log(`[bytes] classic: ${kb(classic.total)} transferred, ${classic.files} files; Syncfusion ${kb(classic.syncfusion)}`);
  console.log(`[bytes] native:  ${kb(native.total)} transferred, ${native.files} files; Syncfusion ${kb(native.syncfusion)}, native calendar + rrule ${kb(native.calendar)}`);
  expect(native.syncfusion).toBe(0);
  expect(native.total).toBeLessThan(classic.total - 500 * 1024);
});
