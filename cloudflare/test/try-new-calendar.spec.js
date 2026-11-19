// @ts-check
/**
 * The new (native) calendar is the default; Syncfusion's is "classic", one click away. Driven like a visitor on a
 * production-default server (NATIVE_DEFAULT_URL, no CALENDAR_DEFAULT): a fresh browser draws the native calendar on an
 * edit link, a view link, an embed and the home page, with no Syncfusion download. A small pill in the footer says
 * "New calendar · Feedback · Classic editor"; Classic editor stores the choice (localStorage pc_cal plus a pc_cal cookie),
 * reloads into Syncfusion, and leaves "Use the new calendar" in its place. Settings > You > Calendar does the same
 * from anywhere (the home page and Pro calendars have no footer switch). The choice survives a reload and carries to
 * another calendar; a ?cal= address still wins; embeds show neither the link nor the pill. Feedback posts to
 * /api/contact with the message and where it came from, never the calendar's events. The other server in the pool
 * (BASE_URL, CALENDAR_DEFAULT=classic, the Worker's kill switch) sends browsers that have not chosen to classic,
 * while a stored or ?cal= choice still wins there.
 * Needs scripts/test-browser.sh (it starts both servers).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const CLASSIC_BASE = process.env.BASE_URL || 'http://localhost:8787';           // CALENDAR_DEFAULT=classic
const NATIVE_BASE = process.env.NATIVE_DEFAULT_URL || '';                        // the production default
test.skip(!NATIVE_BASE, 'needs the production-default server (scripts/test-browser.sh sets NATIVE_DEFAULT_URL)');

const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const SYNCFUSION = /\/vendor\/syncfusion/;
const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const EVENTS = [
  { id: 'a', title: 'Secret strategy meeting', start: at(10), end: at(11), type: 1, description: 'Do not share' },
  { id: 'b', title: 'Dentist for Sam', start: at(14), end: at(15), type: 2 },
];

let n = 0;
async function seed(base, title = 'Try new calendar') {
  const id = `tnc-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${base}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, options: {}, events: EVENTS }) });
  expect(res.status).toBe(201);
  return id;
}
async function viewOf(base, id) {
  const res = await fetch(`${base}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ sourceCalendarId: id }) });
  const body = await res.json();
  expect(body.ok).toBe(true);
  return body.publicViewId;
}

/** A fresh browser; every Syncfusion request since the last navigation is in `sf`, analytics calls via watchAnalytics. */
async function browserFor(browser, { phone = false } = {}) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'America/Los_Angeles', locale: 'en-US' }
    : { viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  await ctx.addInitScript(() => {
    window.__TEST__ = true;
    try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ }
  });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const sf = [];
  page.on('request', (r) => { if (SYNCFUSION.test(r.url())) sf.push(r.url()); });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) sf.length = 0; });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, sf, errors };
}
const loaded = (page) => page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 20_000 });
async function go(page, url) {
  await page.goto(url);
  await loaded(page);
}
const mode = (page) => page.evaluate(() => document.documentElement.getAttribute('data-cal'));
const stored = (page) => page.evaluate(() => localStorage.getItem('pc_cal'));
const cookie = async (ctx) => ((await ctx.cookies()).find((c) => c.name === 'pc_cal') || {}).value;
// Analytics is off in tests (window.__TEST__), so record what the page asks it to send. Kept in localStorage so a
// call made just before a reload can be read after it.
const watchAnalytics = (page) => page.evaluate(() => {
  localStorage.setItem('__newUi', '[]');
  Analytics.newUi = (action, source) => { localStorage.setItem('__newUi', JSON.stringify([...JSON.parse(localStorage.getItem('__newUi') || '[]'), `${action}:${source}`])); };
});
const newUiCalls = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('__newUi') || '[]'));
/** Settings > You > Calendar, the way a person gets there. */
async function openCalendarSetting(page) {
  await page.getByTestId('settings-button-desktop').click();
  await page.getByTestId('side-tab-you').click();
  const sel = page.getByTestId('set-calendar');
  await expect(sel).toBeVisible();
  return sel;
}

/** Owner, Oct 26 2026: the dialog's close sat top-left on a row of its own. Every .pc-modal-panel's close is at the
 *  panel's top-right corner, and the title starts at the top, beside it (not pushed down under it). */
async function closeAtTopRight(panel) {
  const [p, x, h] = await Promise.all([panel.boundingBox(), panel.getByRole('button', { name: 'Close' }).boundingBox(), panel.getByRole('heading').first().boundingBox()]);
  expect(p.x + p.width - (x.x + x.width), 'close is at the right edge').toBeLessThan(24);
  expect(Math.abs((x.y + x.height / 2) - (h.y + h.height / 2)), 'close sits on the title\'s line').toBeLessThan(10);
  expect(h.y - p.y, 'the title is not pushed below the close button').toBeLessThan(40);
  expect(x.x, 'close is right of the title start').toBeGreaterThan(h.x + 100);
}

test('a fresh visitor gets the new calendar everywhere; Classic editor switches, sticks across reloads and calendars, and Use the new calendar comes back', async ({ browser }) => {
  const id = await seed(NATIVE_BASE), other = await seed(NATIVE_BASE, 'Another calendar');
  const { ctx, page, sf, errors } = await browserFor(browser);
  await go(page, `${NATIVE_BASE}/${id}?backend=cf`);
  expect(await mode(page)).toBe('native');
  await expect(page.locator('.nc [data-testid="event-a"]').first()).toBeVisible();
  expect(sf, 'no Syncfusion file in native mode').toEqual([]);
  expect(await stored(page), 'nothing is stored until the person chooses').toBe(null);
  await expect(page.getByTestId('try-new-cal')).toHaveCount(0);

  // The pill sits in the footer line, not over the calendar.
  const pill = page.getByTestId('new-cal-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('New calendar');
  await expect(pill.getByTestId('new-cal-feedback')).toHaveText('Feedback');
  await expect(pill.getByTestId('back-to-classic')).toHaveText('Classic editor');
  const pb = await pill.boundingBox(), cb = await page.locator('.pc-native-cal').boundingBox();
  expect(pb && cb && pb.y >= cb.y + cb.height - 1, 'the pill is below the calendar').toBe(true);

  // Hidden for the session: gone now and after a reload, back in a new session (tab).
  await page.getByTestId('new-cal-pill-hide').click();
  await expect(page.getByTestId('new-cal-pill')).toHaveCount(0);
  await go(page, `${NATIVE_BASE}/${other}?backend=cf`);
  await expect(page.getByTestId('edit-footer')).toBeVisible();
  await expect(page.getByTestId('new-cal-pill')).toHaveCount(0);
  const tab = await ctx.newPage();
  await go(tab, `${NATIVE_BASE}/${other}?backend=cf`);
  await expect(tab.getByTestId('new-cal-pill')).toBeVisible();
  await tab.close();
  await page.evaluate(() => sessionStorage.clear());
  await go(page, `${NATIVE_BASE}/${other}?backend=cf`);

  // Classic editor: Syncfusion, stored, and it stays classic on reload and on the other calendar.
  await watchAnalytics(page);
  await Promise.all([page.waitForEvent('framenavigated'), page.getByTestId('back-to-classic').click()]);
  await loaded(page);
  expect(await mode(page)).toBe('classic');
  await expect.poll(() => sf.length, { message: 'Syncfusion loads' }).toBeGreaterThan(0);
  expect(await stored(page)).toBe('classic');
  expect(await cookie(ctx)).toBe('classic');
  expect(new URL(page.url()).searchParams.get('backend'), 'other query params survive').toBe('cf');
  expect(await newUiCalls(page)).toEqual(['opt_out:pill']);
  await expect(page.getByTestId('new-cal-pill')).toHaveCount(0);
  await go(page, `${NATIVE_BASE}/${id}?backend=cf`);
  expect(await mode(page)).toBe('classic');

  // The classic footer offers the new calendar; taking it stores native.
  const link = page.getByTestId('edit-footer').getByTestId('try-new-cal');
  await expect(link).toHaveText('Use the new calendar');
  await watchAnalytics(page);
  await Promise.all([page.waitForEvent('framenavigated'), link.click()]);
  await loaded(page);
  expect(await mode(page)).toBe('native');
  expect(await stored(page)).toBe('native');
  expect(await cookie(ctx)).toBe('native');
  expect(await newUiCalls(page)).toEqual(['opt_in:footer']);
  await expect(page.locator('.nc [data-testid="event-a"]').first()).toBeVisible();
  expect(errors, 'no page errors across the switches').toEqual([]);
  await ctx.close();
});

test('Settings > You > Calendar switches both ways from the app itself, with the same analytics source', async ({ browser }) => {
  const id = await seed(NATIVE_BASE);
  const { ctx, page } = await browserFor(browser);
  await go(page, `${NATIVE_BASE}/${id}?backend=cf`);
  expect(await mode(page)).toBe('native');
  let sel = await openCalendarSetting(page);
  await expect(sel).toHaveValue('native');
  await expect(sel.locator('option')).toHaveText(['New', 'Classic']);
  await watchAnalytics(page);
  await Promise.all([page.waitForEvent('framenavigated'), sel.selectOption('classic')]);
  await loaded(page);
  expect(await mode(page)).toBe('classic');
  expect(await stored(page)).toBe('classic');
  expect(await newUiCalls(page)).toEqual(['opt_out:settings']);

  sel = await openCalendarSetting(page);
  await expect(sel).toHaveValue('classic');
  await watchAnalytics(page);
  await Promise.all([page.waitForEvent('framenavigated'), sel.selectOption('native')]);
  await loaded(page);
  expect(await mode(page)).toBe('native');
  expect(await stored(page)).toBe('native');
  expect(await newUiCalls(page)).toEqual(['opt_in:settings']);
  await ctx.close();
});

test('view links and locked calendars get the link, Pro ones never; ?cal=classic wins; the address flag is dropped when switching', async ({ browser }) => {
  const id = await seed(NATIVE_BASE);
  const viewId = await viewOf(NATIVE_BASE, id);
  const { ctx, page, sf } = await browserFor(browser);
  await go(page, `${NATIVE_BASE}/view/${viewId}?backend=cf`);
  expect(await mode(page)).toBe('native');
  expect(sf).toEqual([]);
  await expect(page.locator('[data-testid^="view-footer"]').getByTestId('new-cal-pill')).toBeVisible();

  // An address that asks for classic wins for that page, and its link opts in without the flag fighting back.
  await go(page, `${NATIVE_BASE}/view/${viewId}?backend=cf&cal=classic`);
  expect(await mode(page)).toBe('classic');
  const link = page.locator('[data-testid^="view-footer"]').getByTestId('try-new-cal');
  await expect(link).toBeVisible();
  await Promise.all([page.waitForEvent('framenavigated'), link.click()]);
  await loaded(page);
  expect(new URL(page.url()).searchParams.get('cal')).toBe(null);
  expect(await mode(page)).toBe('native');

  // ...and the pill's Classic editor from a ?cal=native address drops the flag too.
  await go(page, `${NATIVE_BASE}/view/${viewId}?backend=cf&cal=native`);
  await Promise.all([page.waitForEvent('framenavigated'), page.getByTestId('back-to-classic').click()]);
  await loaded(page);
  expect(new URL(page.url()).searchParams.get('cal')).toBe(null);
  expect(await mode(page)).toBe('classic');

  // Pro calendars never show the footer switch: with full branding (the regular footer) or trimmed (Made with pastecal · Report).
  await go(page, `${NATIVE_BASE}/view/${viewId}?backend=cf&cal=classic`);
  const VM = `document.querySelector('#app')._vnode.component.proxy`;
  for (const hideBranding of [false, true]) {
    await page.evaluate(`${VM}.lock = { locked: true, pro: true, canEdit: false, proSettings: { hideBranding: ${hideBranding} } }`);
    await expect(page.getByTestId('try-new-cal')).toHaveCount(0);
    await expect(page.getByTestId('new-cal-pill')).toHaveCount(0);
  }
  await ctx.close();
});

test('Send feedback posts the message and where it came from, never the events; a failure offers to try again', async ({ browser }) => {
  const id = await seed(NATIVE_BASE);
  const { ctx, page } = await browserFor(browser);
  await go(page, `${NATIVE_BASE}/${id}?backend=cf`);
  await expect(page.locator('.nc [data-testid="event-a"]').first()).toBeVisible();
  await watchAnalytics(page);

  const posts = [];
  let fail = true;
  await page.route('**/api/contact', async (route) => {
    posts.push(route.request().postDataJSON());
    if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.getByTestId('new-cal-feedback').click();
  const dialog = page.getByTestId('cal-feedback');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('The new calendar');
  await closeAtTopRight(dialog);
  await expect(dialog.getByLabel('What should we change?')).toBeFocused();
  await expect(dialog.getByLabel('Email (if you\'d like a reply)')).toBeVisible();
  await expect(dialog.getByTestId('cal-feedback-send')).toBeDisabled();
  await dialog.getByLabel('What should we change?').fill('The week view feels cramped on my laptop.');
  await dialog.getByLabel('Email (if you\'d like a reply)').fill('ann@example.com');

  await dialog.getByTestId('cal-feedback-send').click();
  await expect(dialog.getByTestId('cal-feedback-error')).toBeVisible();
  await expect(dialog.getByTestId('cal-feedback-send')).toHaveText('Try again');
  await expect(dialog.getByLabel('What should we change?'), 'the text is kept').toHaveValue('The week view feels cramped on my laptop.');

  fail = false;
  await dialog.getByTestId('cal-feedback-send').click();
  await expect(dialog.getByRole('heading')).toHaveText('Thanks, sent.');
  expect(posts).toHaveLength(2);
  const p = posts[1];
  expect(p.type).toBe('idea');
  expect(p.email).toBe('ann@example.com');
  expect(p.website).toBe('');
  expect(typeof p.elapsed).toBe('number');
  expect(p.message).toContain('The week view feels cramped on my laptop.');
  expect(p.message).toMatch(/^\[New calendar feedback: edit link, \w+ on \w+, 1280px wide\]/);
  const raw = JSON.stringify(p);
  for (const leak of ['Secret strategy meeting', 'Dentist for Sam', 'Do not share', id]) expect(raw, `never sends "${leak}"`).not.toContain(leak);
  expect(p.calendar).toBeUndefined();
  expect(await newUiCalls(page)).toEqual(['feedback_open:pill', 'feedback_sent:pill']);

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  // Cancel closes without sending.
  await page.getByTestId('new-cal-feedback').click();
  await page.getByTestId('cal-feedback').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('cal-feedback')).toHaveCount(0);
  expect(posts).toHaveLength(2);
  await ctx.close();
});

test('embeds show neither the link nor the pill; the home page is the new calendar too, with its own way back in Settings', async ({ browser }) => {
  const id = await seed(NATIVE_BASE);
  const viewId = await viewOf(NATIVE_BASE, id);
  const { ctx, page, sf } = await browserFor(browser);
  for (const path of [`/${id}?backend=cf&embed`, `/view/${viewId}?backend=cf&embed`]) {
    await go(page, `${NATIVE_BASE}${path}`);
    expect(await mode(page), path).toBe('native');
    await page.waitForTimeout(300);
    await expect(page.getByTestId('new-cal-pill'), path).toHaveCount(0);
    await expect(page.getByTestId('try-new-cal'), path).toHaveCount(0);
  }
  expect(sf).toEqual([]);
  // The home page: native for a fresh browser, with no footer switch.
  await go(page, `${NATIVE_BASE}/?backend=cf`);
  expect(await mode(page)).toBe('native');
  expect(sf, 'no Syncfusion on the home page').toEqual([]);
  await expect(page.getByTestId('try-new-cal')).toHaveCount(0);
  await expect(page.getByTestId('new-cal-pill')).toHaveCount(0);
  // ...and the choice is still one click away, in Settings.
  const sel = await openCalendarSetting(page);
  await expect(sel).toHaveValue('native');
  await Promise.all([page.waitForEvent('framenavigated'), sel.selectOption('classic')]);
  await loaded(page);
  expect(await mode(page)).toBe('classic');
  await expect.poll(() => sf.length).toBeGreaterThan(0);
  await ctx.close();
});

test('the Worker kill switch (CALENDAR_DEFAULT=classic) sends browsers that have not chosen back to classic, but a stored or ?cal= choice still wins', async ({ browser }) => {
  const id = await seed(CLASSIC_BASE);
  const viewId = await viewOf(CLASSIC_BASE, id);
  const { ctx, page, sf } = await browserFor(browser);
  for (const path of [`/${id}?backend=cf`, `/view/${viewId}?backend=cf`, '/?backend=cf']) {
    await go(page, `${CLASSIC_BASE}${path}`);
    expect(await mode(page), path).toBe('classic');
    await expect.poll(() => sf.length, { message: path }).toBeGreaterThan(0);
  }
  await go(page, `${CLASSIC_BASE}/${id}?backend=cf&cal=native`);
  expect(await mode(page), '?cal=native wins over the server default').toBe('native');
  await page.evaluate(() => localStorage.setItem('pc_cal', 'native'));
  await go(page, `${CLASSIC_BASE}/${id}?backend=cf`);
  expect(await mode(page), 'a stored choice wins over the server default').toBe('native');
  await ctx.close();
});
