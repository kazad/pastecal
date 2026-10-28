// @ts-check
/**
 * Guards for app-stress-3's UX roots (the unit halves: test/unit/failure-paths.test.js, test/unit/app-ux-guards.test.js).
 *
 *   ROOT B, failure paths: every network call a person's action or page depends on is made to fail (a 500, and no
 *     connection): Save & share (POST /cal/<id>), its name check (HEAD /cal/<id>), Share's Rename and Create link
 *     (POST /api/create-view), a view link's lookup (GET /api/lookup), Activity (GET /history), and saving an edit
 *     (the calendar's socket, offline). Each must leave a message in the page where the action was, no browser
 *     dialog, no uncaught error, and nothing that reads as success. (The stats collector is excluded: it is never
 *     seen.) Past instances: A05, A07, A08, A09, A12.
 * (ROOT 4's guard, pages that fit embeds at 300-400px and phones at 360/390, is in layout-guard.spec.js "page fit".)
 * Screenshots (light/dark, desktop/phone) land in cloudflare/test-results/root-app-ux/.
 * Run with scripts/test-on-box.sh root-app-ux.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL, settled } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SHOTS = path.join(__dirname, '..', 'test-results', 'root-app-ux');
fs.mkdirSync(SHOTS, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';
const iso = (s) => new Date(s).toISOString();
const timed = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
let n = 0;
const rand = () => `${Date.now().toString(36)}${n++}${Math.floor(Math.random() * 1e4)}`;

async function seed(events, o = {}) {
  const id = o.id || `rux-${rand()}`;
  const res = await fetch(`${BASE}/cal/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: o.title ?? 'Root UX', options: { notes: '', ...(o.options || {}) }, events }) });
  expect(res.status, `seed ${id}`).toBe(201);
  let viewId = null;
  if (!o.noView) viewId = (await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json()).publicViewId;
  return { id, viewId };
}
const calOf = async (id) => (await (await fetch(`${BASE}/cal/${encodeURIComponent(id)}`)).json()).calendar;

const DEVICES = {
  desk: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  p360: { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true },
};
async function browserFor(browser, o = {}) {
  const { device = 'desk', colorScheme = 'light', settings = null } = o;
  const ctx = await browser.newContext({ ...DEVICES[device], timezoneId: 'America/Los_Angeles', locale: 'en-US', colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(([cal, g]) => {
    window.__TEST__ = true;
    try { localStorage.setItem('pastecal_backend', 'cf'); if (cal) localStorage.setItem('pc_cal', cal); if (g) localStorage.setItem('pastecal_global_settings', JSON.stringify(g)); } catch (e) { /* blocked */ }
  }, [o.cal || null, settings]);
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  if (o.now) await page.clock.install({ time: new Date(o.now) });
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(`${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}); });
  return { ctx, page, errors, dialogs };
}
const loaded = (page) => page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
async function open(browser, p, o = {}) {
  const b = await browserFor(browser, o);
  await b.page.goto(p);
  await loaded(b.page);
  await settled(b.page);
  return b;
}
const vm = (page, expr) => page.evaluate(`(() => { const p = document.querySelector('#app')._vnode.component.proxy; return ${expr}; })()`);
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
/** A route handler that fails the way `how` says: '500' answers 500, 'offline' drops the connection. */
const failing = (how) => (r) => (how === '500' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"internal"}' }) : r.abort('internetdisconnected'));

// =====================================================================================================
// ROOT B: each call, made to fail.
// =====================================================================================================

for (const how of ['500', 'offline']) {
  test(`B save: Save & share (POST /cal/<id>) answering ${how}: "Not saved" under the name, the page usable again, no dialog or error`, async ({ browser }) => {
    const { page, ctx, errors, dialogs } = await open(browser, '/?backend=cf');
    await page.route(/\/cal\/[^/?]+$/, (r) => (r.request().method() === 'POST' ? failing(how)(r) : r.continue()));
    await page.locator('#slug').fill(`rux-save-${rand()}`);
    await page.getByTestId('share-new').click();
    await expect(page.getByTestId('slug-taken')).toContainText(how === 'offline' ? /offline/ : /Not saved/);
    expect(await vm(page, 'p.isLoading')).toBe(false);
    expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
    await ctx.close();
  });

  test(`B check: the name check (HEAD /cal/<id>) answering ${how}: "Couldn't reach" (never "is taken"), no dialog or error`, async ({ browser }) => {
    const { page, ctx, errors, dialogs } = await open(browser, '/?backend=cf');
    await page.route(/\/cal\/[^/?]+$/, (r) => (r.request().method() === 'HEAD' ? (how === '500' ? r.fulfill({ status: 503 }) : r.abort('internetdisconnected')) : r.continue()));
    await page.locator('#slug').fill(`rux-check-${rand()}`);
    await page.getByTestId('share-new').click();
    await expect(page.getByTestId('slug-taken')).toContainText(/Couldn.t reach/);
    await expect(page.getByTestId('slug-taken')).not.toContainText('is taken');
    expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
    await ctx.close();
  });

  test(`B create-view: Share's Rename and Create link with /api/create-view answering ${how}: said beside the name / in a toast, no dialog or error`, async ({ browser }) => {
    const { id, viewId } = await seed([]);
    const { page, ctx, errors, dialogs } = await open(browser, `/${id}?backend=cf`);
    await page.route(/\/api\/create-view/, failing(how));
    await page.getByTestId('share-pill-more').click();
    await page.getByTestId('share-group').getByRole('button', { name: 'Rename' }).click();
    await page.getByLabel('New name for the view-only link').fill(`rux-${rand().slice(-6)}`);
    await page.getByLabel('New name for the view-only link').press('Enter');
    await expect(page.getByTestId('view-rename-error')).toContainText(/connection/);
    expect((await calOf(id)).options.publicViewId).toBe(viewId);
    // Create link, on a calendar that has none.
    const bare = await seed([], { noView: true });
    const B = await open(browser, `/${bare.id}?backend=cf`);
    await B.page.route(/\/api\/create-view/, failing(how));
    await B.page.getByTestId('share-pill-more').click();
    await B.page.getByTestId('create-readonly').click();
    await expect(B.page.locator('.pc-toast')).toContainText(/Couldn.t create the link/);
    await expect(B.page.getByTestId('create-readonly')).toBeEnabled();
    expect({ errors, dialogs, e2: B.errors, d2: B.dialogs }).toEqual({ errors: [], dialogs: [], e2: [], d2: [] });
    await ctx.close(); await B.ctx.close();
  });

  test(`B lookup: a view link whose lookup (/api/lookup) answers ${how}: "Couldn't load this calendar", never "not found", nothing to subscribe to`, async ({ browser }) => {
    const { viewId } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
    const { page, ctx, errors, dialogs } = await browserFor(browser);
    await page.route(/\/api\/lookup/, failing(how));
    await page.goto(`/view/${viewId}?backend=cf`);
    await expect(page.getByTestId('view-problem')).toContainText('Couldn’t load this calendar');
    await expect(page.getByTestId('view-problem')).not.toContainText(/No calendar/);
    expect(await page.locator('[data-testid=view-add-to-cal]:visible').count()).toBe(0);
    expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
    await ctx.close();
  });

  test(`B history: Activity with /history answering ${how}: "Couldn't load the changes" (never "Nothing has changed"); Try again loads them`, async ({ browser }) => {
    const { id } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
    const A = await open(browser, `/${id}?backend=cf`);
    await A.page.getByTestId('desktop-add-event-button').click();
    await A.page.locator('textarea[aria-label="Event description"]').fill('Snack duty tomorrow 3pm');
    await A.page.locator('.pc-qa-dialog button[type="submit"]').click();
    await expect.poll(async () => (await calOf(id)).events.length).toBe(2);
    await A.ctx.close();
    const { page, ctx, errors, dialogs } = await open(browser, `/${id}?backend=cf`);
    await page.route(/\/history$/, failing(how));
    // Cmd+Z with the history unreadable (nothing undoable in this tab): says so, not "Nothing to undo".
    await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.undoLastChange());
    await expect(page.locator('.pc-toast')).toContainText('Couldn’t load the changes');
    await page.getByTestId('last-edit-link').click();
    await expect(page.getByTestId('activity-failed')).toBeVisible();
    await expect(page.getByTestId('recent-changes')).not.toContainText('Nothing has changed');
    await page.unroute(/\/history$/);
    await page.getByTestId('activity-failed').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('recent-changes')).toContainText('Snack duty');
    await expect(page.getByTestId('activity-failed')).toHaveCount(0);
    expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
    await ctx.close();
  });
}

test('B missing view link: says there is no calendar at this link, in the page; no alert, no "New calendar", nothing to subscribe to', async ({ browser }) => {
  const { page, ctx, errors, dialogs } = await browserFor(browser);
  await page.goto(`/view/nothing-here-${rand()}?backend=cf`);
  await expect(page.getByTestId('view-problem')).toContainText('No calendar at this link');
  expect(await page.locator('body').innerText(), 'what is on screen').not.toMatch(/New calendar|View only/);
  expect(await page.locator('[data-testid=view-add-to-cal]:visible').count()).toBe(0);
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});

test('B socket: offline, a new event says "Offline — changes will save when you reconnect"; back online it is sent and the line goes away', async ({ browser }) => {
  const { id } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:30:00-07:00')]);
  const { ctx, page, errors, dialogs } = await open(browser, `/${id}?backend=cf`);
  await expect(page.getByTestId('offline-notice')).toHaveCount(0);
  await ctx.setOffline(true);
  await page.getByTestId('desktop-add-event-button').click();
  await page.locator('textarea[aria-label="Event description"]').fill('Snack duty oct 25 3pm');
  await page.locator('.pc-qa-dialog button[type="submit"]').click();
  await expect(page.getByTestId('offline-notice')).toContainText('Offline — changes will save when you reconnect');
  await expect.poll(() => page.locator('#pc-live').textContent()).toMatch(/Offline/);
  expect((await calOf(id)).events.length).toBe(1);
  await ctx.setOffline(false);
  await expect.poll(async () => (await calOf(id)).events.length, { timeout: 20_000 }).toBe(2);
  await expect(page.getByTestId('offline-notice')).toHaveCount(0, { timeout: 10_000 });
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});

test('B socket: a dropped connection that comes right back does not flash the offline line', async ({ browser }) => {
  const { id } = await seed([]);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  let seen = false;
  await page.exposeFunction('pcSawOffline', () => { seen = true; });
  await page.evaluate(() => new MutationObserver(() => { if (document.querySelector('[data-testid=offline-notice]')) window.pcSawOffline(); }).observe(document.body, { subtree: true, childList: true }));
  await page.evaluate(() => { for (const r of Object.values(CalendarDataService._rooms)) { r.ws.close(); } });   // the server hung up; the tab reconnects
  await page.waitForTimeout(3000);
  expect(seen).toBe(false);
  await ctx.close();
});

// =====================================================================================================
// Screenshots of each change, light and dark, desktop and phone (read them).
// =====================================================================================================

// One test per device and color scheme, so the four run side by side.
for (const device of ['desk', 'phone']) {
  for (const colorScheme of ['light', 'dark']) {
    test(`shots: the messages and markers this pass added (${device}, ${colorScheme})`, async ({ browser }) => {
      const { id, viewId } = await seed([timed('w', 'Weekly practice', '2026-09-01T17:00:00-07:00', '2026-09-01T18:00:00-07:00', { recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;' })],
        { title: 'Riverside Rockets', options: { notes: 'Rainouts decided by 7am on game day.' } });
      const tag = `${device}-${colorScheme}`;
      // Save & share fails.
      let b = await open(browser, '/?backend=cf', { device, colorScheme });
      await b.page.route(/\/cal\/[^/?]+$/, (r) => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.continue()));
      await b.page.locator(device === 'desk' ? '#slug' : '#slug-m').fill('team#1');
      await b.page.getByTestId(device === 'desk' ? 'share-new' : 'share-new-mobile').click();
      await b.page.waitForTimeout(600);
      await shot(b.page, `save-fails-${tag}`);
      await b.ctx.close();
      // A missing view link.
      b = await open(browser, `/view/nothing-${rand()}?backend=cf`, { device, colorScheme }).catch(async () => null);
      if (!b) { b = await browserFor(browser, { device, colorScheme }); await b.page.goto(`/view/nothing-${rand()}?backend=cf`); }
      await b.page.waitForTimeout(1500);
      await shot(b.page, `view-missing-${tag}`);
      await b.ctx.close();
      // Offline.
      b = await open(browser, `/${id}?backend=cf`, { device, colorScheme, now: NOW });
      await b.ctx.setOffline(true);
      await b.page.waitForTimeout(2600);
      await shot(b.page, `offline-${tag}`);
      await b.ctx.setOffline(false);
      await b.ctx.close();
      // Phone view link with notes / desktop view link.
      b = await open(browser, `/view/${viewId}?backend=cf`, { device, colorScheme, now: NOW });
      await shot(b.page, `view-notes-${tag}`);
      if (device === 'phone') {
        await b.page.getByTestId('notes-button-viewer').click();
        await expect(b.page.getByText('Rainouts decided by 7am').first()).toBeVisible();
        await shot(b.page, `view-notes-open-${tag}`);
      }
      await b.ctx.close();
      // Share: Rename to its own name; Activity that failed to load; search for a series; 24-hour settings.
      const app = (m) => b.page.evaluate(`document.querySelector('#app')._vnode.component.proxy.${m}`);
      b = await open(browser, `/${id}?backend=cf`, { device, colorScheme, now: NOW, settings: { timeFormat: '24' } });
      await app("openSideTab('share')");
      await b.page.getByTestId('share-group').getByRole('button', { name: 'Rename' }).click();
      await b.page.getByLabel('New name for the view-only link').fill(viewId);
      await b.page.getByLabel('New name for the view-only link').press('Enter');
      await b.page.waitForTimeout(300);
      await shot(b.page, `rename-own-${tag}`);
      await b.page.route(/\/history$/, (r) => r.fulfill({ status: 503, body: 'x' }));
      await app('openRecentChanges()');
      await b.page.waitForTimeout(500);
      await shot(b.page, `activity-failed-${tag}`);
      await app('toggleSearch()');
      await b.page.locator('input[type=search]:visible').first().fill('practice');
      await b.page.waitForTimeout(400);
      await shot(b.page, `search-series-${tag}`);
      await app("openSideTab('settings')");
      await b.page.locator('#set-start-hour').scrollIntoViewIfNeeded();
      await b.page.waitForTimeout(300);
      await shot(b.page, `settings-24h-${tag}`);
      await b.ctx.close();
      b = await open(browser, `/${id}?backend=cf&view=week&date=2026-10-24`, { device, colorScheme, now: NOW, cal: 'native' });
      await shot(b.page, `now-label-${tag}`);
      await b.ctx.close();
      if (device === 'desk') {
        // The embed at 300px, notes open.
        b = await browserFor(browser, { colorScheme, now: NOW });
        await b.page.setViewportSize({ width: 360, height: 540 });
        await b.page.goto(`${BASE}/about.html`);
        await b.page.setContent(`<body style="margin:20px;background:${colorScheme === 'dark' ? '#111' : '#fff'}"><iframe id="f" src="${BASE}/view/${viewId}?backend=cf" title="cal" width="300" height="480" style="border:0"></iframe></body>`);
        await expect(b.page.frameLocator('#f').getByTestId('embed-bar')).toBeVisible({ timeout: 20_000 });
        await b.page.waitForTimeout(800);
        await b.page.frameLocator('#f').getByTestId('embed-notes-btn').click();
        await b.page.waitForTimeout(300);
        await shot(b.page, `embed-300-${colorScheme}`);
        await b.ctx.close();
      }
    });
  }
}
