// @ts-check
/**
 * Third stress pass, aimed AWAY from the event card (editor-stress*.spec.js covered it): view links and embeds, Share
 * (every link, Rename, embed code, odd calendar names: issue #51), Notes, Recent changes, the calendar feed (.ics, read
 * back with a real parser), the classic calendar, the beta switch, Settings, the homepage's new-calendar flow, print,
 * and slow or failing networks.
 *
 *   - "A<n> ..." tests are FINDINGS: each asserts what a person expects and is marked expected-to-fail (finding()),
 *     so the suite stays green. RAW = true runs them as plain tests, to see each fail at its own assertion.
 *     When one is fixed it passes, Playwright reports an unexpected pass, and its finding() line comes out.
 *   - The other tests pin what this pass checked and found right.
 * Screenshots land in cloudflare/test-results/app-stress-3/.
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh); run with scripts/test-on-box.sh app-stress-3.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL, settled } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SHOTS = path.join(__dirname, '..', 'test-results', 'app-stress-3');
fs.mkdirSync(SHOTS, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const ICALJS = 'https://cdn.jsdelivr.net/npm/ical.js@1.5.0/build/ical.min.js';
const NOW = '2026-10-24T12:00:00-07:00';   // Saturday Oct 24 2026, Los Angeles
const iso = (s) => new Date(s).toISOString();
const timed = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
const WEEKLY = 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;';

let n = 0;
const rand = () => `${Date.now().toString(36)}${n++}${Math.floor(Math.random() * 1e4)}`;
/** A calendar on the local server, named `id` (any name a calendar may have), with a view link unless noView. */
async function seed(events, o = {}) {
  const id = o.id || `as3-${rand()}`;
  const res = await fetch(`${BASE}/cal/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: o.title ?? 'Stress three', options: { notes: '', ...(o.options || {}) }, events }) });
  expect(res.status, `seed ${id}`).toBe(201);
  let viewId = null;
  if (!o.noView) {
    const v = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json();
    expect(v.ok, JSON.stringify(v)).toBe(true);
    viewId = v.publicViewId;
  }
  return { id, viewId };
}
const calOf = async (id) => (await (await fetch(`${BASE}/cal/${encodeURIComponent(id)}`)).json()).calendar;
const exists = async (id) => (await fetch(`${BASE}/cal/${encodeURIComponent(id)}`)).status === 200 && !!(await calOf(id))?.id;
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100] });
// A finding: expected to fail until fixed. RAW = true runs the findings as plain tests, to see each fail where it should.
const RAW = false;
const finding = (why) => { if (!RAW) test.fail(true, why); };
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
const VM = () => document.querySelector('#app')?._vnode?.component?.proxy;

const DEVICES = {
  desk: { viewport: { width: 1280, height: 800 } },
  small: { viewport: { width: 1024, height: 600 } },
  ipad: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  p360: { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true },
};
/** A fresh browser context. o: device, colorScheme, locale, timezoneId, settings, now (clock), cal ('native' stores the beta choice). */
async function browserFor(browser, o = {}) {
  const { device = 'desk', timezoneId = 'America/Los_Angeles', settings = null, colorScheme = 'light', locale = 'en-US' } = o;
  const ctx = await browser.newContext({ ...DEVICES[device], timezoneId, locale, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(([g, cal]) => {
    window.__TEST__ = true;
    try { localStorage.setItem('pastecal_backend', 'cf'); if (g) localStorage.setItem('pastecal_global_settings', JSON.stringify(g)); if (cal) localStorage.setItem('pc_cal', cal); } catch (e) { /* blocked */ }
  }, [settings, o.cal || null]);
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  if (o.now) await page.clock.install({ time: new Date(o.now) });
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(`${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}); });
  return { ctx, page, errors, dialogs };
}
const loaded = (page, timeout = 30_000) => page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout });
/** Open `p` (a path) in a new browser and wait for the app. */
async function open(browser, p, o = {}) {
  const b = await browserFor(browser, o);
  await b.page.goto(p);
  await loaded(b.page);
  await settled(b.page);
  return b;
}
const vm = (page, expr) => page.evaluate(`(() => { const p = document.querySelector('#app')._vnode.component.proxy; return ${expr}; })()`);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// =====================================================================================================
// Findings. Each: finding() + the assertion a person expects.
// =====================================================================================================

/** Open Notes in the side panel and start editing them (Edit, or Add notes when there are none). */
async function editNotes(page) {
  await page.locator('.pc-hdr-actions').getByRole('button', { name: 'Toggle notes' }).click();
  const edit = page.getByTestId('notes-edit').or(page.getByTestId('notes-add'));
  await edit.first().click();
  const ta = page.getByLabel('Calendar notes');
  await expect(ta).toBeVisible();
  return ta;
}
/** Add an event through quick add, as a person does. */
async function quickAdd(page, text) {
  await page.getByTestId('desktop-add-event-button').click();
  await page.locator('textarea[aria-label="Event description"]').fill(text);
  await page.locator('.pc-qa-dialog button[type="submit"]').click();
}

test('A01 [notes] data-loss: notes typed while someone else adds an event lose what was typed before the event arrived', async ({ browser }) => {
  finding('applyRemoteCalendar merges events but calendar.import() replaces options wholesale: the incoming snapshot puts back the server\'s notes over keystrokes still inside the 500 ms save debounce');
  const { id } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')], { options: { notes: 'Old notes' } });
  const A = await open(browser, `/${id}?backend=cf`);
  const B = await open(browser, `/${id}?backend=cf`);
  const ta = await editNotes(A.page);
  await ta.click();
  await A.page.keyboard.press('ControlOrMeta+End');
  const typed = ' and a new line typed by A while B adds an event';
  const typing = A.page.keyboard.type(typed, { delay: 60 });   // a steady typist: the save waits for a 500 ms pause
  await A.page.waitForTimeout(800);
  await quickAdd(B.page, 'Snack duty tomorrow 3pm');
  await typing;
  await soon(async () => (await calOf(id)).events.length).toBe(2);
  await A.page.waitForTimeout(2000);
  await shot(A.page, 'A01-notes-lost-keystrokes');
  expect({ box: await ta.inputValue(), stored: (await calOf(id)).options.notes }, 'every keystroke is kept, on screen and on the server')
    .toEqual({ box: `Old notes${typed}`, stored: `Old notes${typed}` });
  await A.ctx.close(); await B.ctx.close();
});

test('A02 [feed] broken: a weekly Tuesday 5 PM practice (no per-event zone) reaches calendar apps on Mondays, and at 4 PM after Nov 1', async ({ browser }) => {
  finding('ICSService writes an event without event.tz in UTC (DTSTART:20261007T000000Z + RRULE:BYDAY=TU): the rule repeats on UTC Tuesdays (Monday evening in LA) at a fixed UTC hour; the calendar\'s own zone (options.tz) is ignored');
  const { id, viewId } = await seed([timed('w', 'Weekly practice', '2026-10-06T17:00:00-07:00', '2026-10-06T18:00:00-07:00', { recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=8;' })],
    { options: { tz: 'America/Los_Angeles' } });
  const ics = await (await fetch(`${BASE}/view/${viewId}.ics`)).text();
  // What the calendar itself shows (classic, Syncfusion): Tuesdays at 5 PM, Nov 3 included.
  const C = await open(browser, `/${id}?backend=cf&view=week&date=2026-11-03`);
  const shown = await C.page.evaluate(() => window.scheduleObj.getEvents(new Date(2026, 9, 1), new Date(2026, 11, 1), true).map((e) => new Date(e.StartTime).toString().slice(0, 21)));
  await C.ctx.close();
  // What a subscriber's calendar app shows: the feed read by ical.js, in Los Angeles.
  const { ctx, page } = await browserFor(browser);
  await page.goto(`${BASE}/about.html`);
  await page.addScriptTag({ url: ICALJS });
  const feed = await page.evaluate((t) => {
    const ev = new ICAL.Event(new ICAL.Component(ICAL.parse(t)).getFirstSubcomponent('vevent'));
    const out = [], it = ev.iterator();
    let next;
    while ((next = it.next()) && out.length < 12) out.push(next.toJSDate().toString().slice(0, 21));
    return out;
  }, ics);
  await ctx.close();
  const want = ['Tue Oct 06 2026 17:00', 'Tue Oct 13 2026 17:00', 'Tue Oct 20 2026 17:00', 'Tue Oct 27 2026 17:00', 'Tue Nov 03 2026 17:00', 'Tue Nov 10 2026 17:00', 'Tue Nov 17 2026 17:00', 'Tue Nov 24 2026 17:00'];
  expect(shown, 'the calendar itself').toEqual(want);
  expect(feed, `the feed, as a calendar app reads it:\n${ics.split('\r\n').filter((l) => /^(DTSTART|RRULE)/.test(l)).join('\n')}`).toEqual(want);
});

test('A03 [share] broken (#51): Share\'s links for a calendar named "50% off" or "a?b" open another, empty calendar; names with spaces are copied with raw spaces', async ({ browser }) => {
  finding('getEditableURL / getEditableICSURL / getViewerBasePath build "/" + calendar.id without encodeURIComponent');
  const out = {}, want = {};
  for (const name of ['50% off', 'a?b', 'TEAM NUÑEZ']) {
    const real = `${name} ${rand().slice(-4)}`;
    await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')], { id: real, title: `Cal ${name}` });
    const { ctx, page } = await open(browser, `/${encodeURIComponent(real)}?backend=cf`);
    await page.getByTestId('share-pill-more').click();
    const edit = ((await page.getByTestId('share-edit-copy').getAttribute('title')) || '').replace(/^Copy /, '');
    const here = ((await page.getByTestId('share-view-copy').getAttribute('title')) || '').replace(/^Copy /, '');
    const feed = await vm(page, 'p.getEditableICSURL()');
    if (name === '50% off') await shot(page, 'A03-share-links-50pct');
    // A person pastes the copied link into a browser.
    const p2 = await ctx.newPage();
    await p2.goto(edit);
    await loaded(p2);
    const p3 = await ctx.newPage();
    await p3.goto(here);
    await loaded(p3);
    if (name === 'a?b') await shot(p2, 'A03-edit-link-opens-another-calendar');
    out[name] = { spaces: /\s/.test(edit + here + feed), edit: [await vm(p2, 'p.calendar.id'), await vm(p2, 'p.isExisting')], here: [await vm(p3, 'p.calendar.id'), await vm(p3, 'p.isExisting')],
      feed: /X-WR-CALNAME:Cal /.test(await (await fetch(feed.replace(/^https?:\/\/[^/]+/, BASE))).text()) };
    want[name] = { spaces: false, edit: [real, true], here: [real, true], feed: true };
    await ctx.close();
  }
  expect(out, 'each copied link has no raw spaces and opens this calendar; the edit feed answers').toEqual(want);
});

test('A04 [homepage] data-loss: claiming "a?b" or "50% fun" saves the calendar, then lands on a blank draft under another name', async ({ browser }) => {
  finding('create() redirects with location.href = "/" + slug, unencoded: "?" starts a query, "%" starts an escape');
  const out = {}, want = {};
  for (const name of ['a?b', '50% fun']) {
    const typed = `${name}${rand().slice(-4)}`;
    const { ctx, page } = await open(browser, '/?backend=cf');
    await page.locator('#slug').fill(typed);
    await page.getByTestId('share-new').click();
    await soon(() => exists(typed.toLowerCase())).toBe(true);
    await page.waitForLoadState('load');
    await loaded(page);
    await page.waitForTimeout(800);
    if (name === 'a?b') await shot(page, 'A04-claim-lands-on-blank-draft');
    out[name] = [await vm(page, 'p.calendar.id'), await vm(page, 'p.isExisting')];
    want[name] = [typed.toLowerCase(), true];
    await ctx.close();
  }
  expect(out, 'after Save & share the page is the calendar just made').toEqual(want);
});

test('A05 [homepage] broken: Save & share that fails (a name with "#", or a server error) shows "Loading…" forever and says nothing', async ({ browser }) => {
  finding('create(): createWithId has no failure path; isLoading stays true and nothing is shown');
  const out = {};
  for (const why of ['name', '500']) {
    const { ctx, page, dialogs } = await open(browser, '/?backend=cf');
    if (why === '500') await page.route(/\/cal\/[^/?]+$/, (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 500, body: 'boom' }) : r.continue()));
    await page.locator('#slug').fill(why === 'name' ? `team#1-${rand().slice(-4)}` : `err-${rand()}`);
    await page.getByTestId('share-new').click();
    await page.waitForTimeout(5000);
    await shot(page, `A05-save-fails-${why}`);
    const said = await page.locator('[role=alert]:visible, .pc-toast:visible, [data-testid=slug-taken]:visible').allInnerTexts();
    out[why] = { loading: await vm(page, 'p.isLoading'), said: said.length > 0 || dialogs.length > 0 };
    await ctx.close();
  }
  expect(out, 'the failure is said in the page, and the page is usable again').toEqual({ name: { loading: false, said: true }, 500: { loading: false, said: true } });
});

test('A06 [share] broken: in Tokyo (or anywhere east of UTC), "This view" on Saturday Oct 24 links to Friday Oct 23', async ({ browser }) => {
  finding('updateCurrentViewURL: selectedDate().toISOString().slice(0, 10) is the UTC date of local midnight');
  const { id } = await seed([timed('e1', 'Practice', '2026-10-24T17:00:00-07:00', '2026-10-24T18:00:00-07:00')]);
  const { ctx, page } = await open(browser, `/${id}?backend=cf&view=day&date=2026-10-24`, { timezoneId: 'Asia/Tokyo' });
  await page.getByTestId('share-pill-more').click();
  await shot(page, 'A06-this-view-oct23');
  const link = ((await page.getByTestId('share-view-copy').getAttribute('title')) || '').replace(/^Copy /, '');
  expect({ date: new URL(link).searchParams.get('date'), tag: await page.getByTestId('share-view').locator('.pc-pill').innerText() }, 'the day on screen')
    .toEqual({ date: '2026-10-24', tag: 'Day, Oct 24' });
  await ctx.close();
});

test('A07 [share] ugly: renaming the view link to a taken name (or its own) is a browser alert about a "Slug", plus an uncaught error', async ({ browser }) => {
  finding('SlugManager.createReadOnlyLink alert()s and rethrows; customizeExistingLink has no catch');
  const other = await seed([]);
  const { id, viewId } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const out = {};
  for (const [k, name] of [['taken', other.viewId], ['own', viewId], ['odd', 'my team!']]) {
    const { ctx, page, errors, dialogs } = await open(browser, `/${id}?backend=cf`);
    await page.getByTestId('share-pill-more').click();
    await page.getByTestId('share-group').getByRole('button', { name: 'Rename' }).click();
    await page.getByLabel('New name for the view-only link').fill(name);
    await page.getByLabel('New name for the view-only link').press('Enter');
    await page.waitForTimeout(1500);
    await shot(page, `A07-rename-${k}`);
    out[k] = { dialogs, errors, said: (await page.getByTestId('share-group').locator('[role=alert]').count()) > 0 };
    await ctx.close();
  }
  expect((await calOf(id)).options.publicViewId, 'nothing changed').toBe(viewId);
  const ok = { dialogs: [], errors: [], said: true };
  expect(out, 'each is said beside the name box, in words, with no browser alert and no uncaught error').toEqual({ taken: ok, own: ok, odd: ok });
});

test('A08 [view] ugly: a view link that does not exist is a browser alert, then an empty calendar called "New calendar" with "Add to my calendar"', async ({ browser }) => {
  finding('the /view/ lookup alert()s "Calendar not found" and leaves the empty draft calendar rendered as a view');
  const { ctx, page, dialogs } = await browserFor(browser);
  await page.goto(`/view/nothing-here-${rand()}?backend=cf`);
  await page.waitForTimeout(4000);
  await shot(page, 'A08-missing-view-link');
  expect({ dialogs, addToCal: await page.locator('[data-testid=view-add-to-cal]:visible').count(), says: /not found|doesn.t exist|no calendar|isn.t a calendar/i.test(await page.locator('body').innerText()) },
    'the page itself says the link is not a calendar; no alert, nothing to subscribe to').toEqual({ dialogs: [], addToCal: 0, says: true });
  await ctx.close();
});

test('A09 [activity] broken: when the changes cannot be loaded, Activity says "Nothing has changed in the last 30 days"', async ({ browser }) => {
  finding('CloudCalendarService.loadUndoEntries returns [] on any failure (HTTP error, offline): the panel cannot tell "none" from "could not load"');
  const { id } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')]);
  const A = await open(browser, `/${id}?backend=cf`);
  await quickAdd(A.page, 'Snack duty tomorrow 3pm');
  await soon(async () => (await calOf(id)).events.length).toBe(2);
  await A.ctx.close();
  // Control: it is listed.
  const C = await open(browser, `/${id}?backend=cf`);
  await C.page.getByTestId('last-edit-link').click();
  await expect(C.page.getByTestId('recent-changes')).toContainText('Snack duty');
  await C.ctx.close();
  // The same, with the history request failing.
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.route(/\/history$/, (r) => r.fulfill({ status: 503, body: 'unavailable' }));
  await page.getByTestId('last-edit-link').click();
  await page.waitForTimeout(1500);
  await shot(page, 'A09-activity-load-failed');
  const text = await page.getByTestId('recent-changes').innerText();
  expect({ claimsNothing: /Nothing has changed/.test(text), saysCouldNot: /couldn.t|could not|try again|offline/i.test(text) }, 'it says it could not load the changes').toEqual({ claimsNothing: false, saysCouldNot: true });
  await ctx.close();
});

test('A10 [embed] ugly: embedded 300px wide, the page scrolls sideways: the credit and Saturday are cut off, and the Notes panel runs past the edge', async ({ browser }) => {
  finding('the embed bar and the month grid assume at least ~324px (their min widths), wider than a 300px sidebar widget');
  const evs = [timed('e1', 'Game', '2026-10-03T10:00:00-07:00', '2026-10-03T11:00:00-07:00')];
  const { viewId } = await seed(evs, { title: 'Riverside Rockets U10 Fall', options: { notes: 'Home field: Riverside Park https://maps.example.com/riverside-park-field-3\nBring water.' } });
  const { ctx, page } = await browserFor(browser, { now: NOW });
  await page.setViewportSize({ width: 360, height: 520 });
  await page.goto(`${BASE}/about.html`);
  await page.setContent(`<body style="margin:20px"><iframe id="f" src="${BASE}/view/${viewId}?backend=cf" title="cal" width="300" height="460" style="border:0"></iframe></body>`);
  await expect(page.frameLocator('#f').getByTestId('embed-bar')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.frameLocator('#f').getByTestId('embed-notes-btn').click();
  await page.waitForTimeout(400);
  await shot(page, 'A10-embed-300');
  const f = page.frame({ url: /\/view\// });
  const m = await f.evaluate(() => {
    const right = (sel) => Math.round(Math.max(...[...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect().right)));
    return { scrollWidth: document.documentElement.scrollWidth, bar: right('[data-testid=embed-bar] > *'), notes: right('[data-testid=embed-notes]') };
  });
  expect({ sideways: m.scrollWidth > 300, barPastEdge: m.bar > 300, notesPastEdge: m.notes > 300 }, `everything inside the 300px frame: ${JSON.stringify(m)}`)
    .toEqual({ sideways: false, barPastEdge: false, notesPastEdge: false });
  await ctx.close();
});

test('A11 [feed] nit: after a rename, a calendar app asking "changed?" (If-None-Match) is told 304 Not Modified, so it keeps the old name', async ({ browser }) => {
  finding('serveFeed\'s ETag hashes the view link and the events only, not the title the feed carries (X-WR-CALNAME, NAME)');
  const { id, viewId } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:30:00-07:00')], { title: 'Old name' });
  const etag = (await fetch(`${BASE}/view/${viewId}.ics`)).headers.get('etag');
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.getByTestId('desktop-title-area').getByText('Old name').click();
  await page.locator('input[aria-label="Calendar title"]:visible').fill('New name');
  await page.locator('input[aria-label="Calendar title"]:visible').press('Enter');
  await soon(async () => (await calOf(id)).title).toBe('New name');
  await ctx.close();
  const again = await fetch(`${BASE}/view/${viewId}.ics`, { headers: { 'if-none-match': etag } });
  expect(again.status, 'the feed changed, so it is sent again').toBe(200);
});

test('A12 [sync] ugly: offline, an added event looks saved: nothing says it has not reached anyone', async ({ browser }) => {
  finding('no part of the app shows the connection state; edits wait in the local journal silently');
  const { id } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:30:00-07:00')]);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`, { now: NOW });
  await ctx.setOffline(true);
  await page.waitForTimeout(1500);
  await quickAdd(page, 'Snack duty oct 25 3pm');
  await page.waitForTimeout(3000);
  await shot(page, 'A12-offline-no-sign');
  expect((await calOf(id)).events.length, 'not on the server yet').toBe(1);
  const says = /offline|not saved|no connection|reconnect|waiting to save|unsaved/i.test(await page.locator('body').innerText());
  await ctx.setOffline(false);
  await soon(async () => (await calOf(id)).events.length, 20_000).toBe(2);   // and it does arrive later (checked: kept)
  expect(says, 'the page says the change is not saved yet').toBe(true);
  await ctx.close();
});

test('A13 [print] nit: Ctrl+P in the first seconds prints "Scan to add it to your phone calendar." with no code to scan', async ({ browser }) => {
  finding('the QR library loads 4 s after the page; preparePrint leaves printQr empty but the footer keeps its "Scan" line');
  const { id } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:30:00-07:00')]);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(400);
  await shot(page, 'A13-print-scan-no-qr');
  const scanLine = await page.getByText('Scan to add it to your phone calendar.').isVisible().catch(() => false);
  expect({ scanLine, qr: await page.locator('.pc-print-qr svg').count() }, 'a "Scan" line only with a code').not.toEqual({ scanLine: true, qr: 0 });
  await ctx.close();
});

test('A14 [settings] nit: with 24-hour time chosen, Settings still offers "Start hour: 5:00 AM"', async ({ browser }) => {
  finding('index.html hard-codes the start hour options as 12-hour text');
  const { id } = await seed([]);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`, { settings: { timeFormat: '24' }, locale: 'de-DE' });
  await page.locator('[data-testid=settings-button-desktop]').click();
  await expect(page.locator('#set-time-format')).toHaveValue('24');
  await shot(page, 'A14-start-hour-12h');
  expect(await page.locator('#set-start-hour option').allInnerTexts()).toEqual(['00:00', '05:00', '06:00', '07:00', '08:00', '09:00']);
  await ctx.close();
});

test('A15 [grid] nit (new calendar): the current-time label sits on top of the same hour\'s label ("12:00 PM" twice, 12px apart)', async ({ browser }) => {
  finding('NativeCalendar draws .nc-now-label without hiding the hour label it lands on (classic hides it)');
  const { id } = await seed([]);
  const { ctx, page } = await open(browser, `/${id}?backend=cf&view=week&date=2026-10-24`, { now: NOW, cal: 'native' });
  await expect(page.locator('.nc-now-label')).toBeVisible();
  await shot(page, 'A15-now-label-twice');
  const near = await page.evaluate(() => {
    const now = document.querySelector('.nc-now-label').getBoundingClientRect();
    return [...document.querySelectorAll('.nc-hour-label')].filter((h) => h.getClientRects().length && getComputedStyle(h).visibility !== 'hidden' && Math.abs(h.getBoundingClientRect().top - now.top) < 16).map((h) => h.innerText);
  });
  expect(near, 'no hour label right beside "now"').toEqual([]);
  await ctx.close();
});

test('A16 [activity] ugly: deleting one occurrence of a series, or changing only an event\'s time zone, is listed as a nameless "1 event edited"', async ({ browser }) => {
  finding('describeEventDiff\'s hand-kept field list has no recurrenceException and no tz, so these edits have no words and no event name (sameEvent has both)');
  const { id } = await seed([timed('w', 'Weekly sync', '2026-10-06T10:00:00-07:00', '2026-10-06T11:00:00-07:00', { recurrencerule: WEEKLY }),
    timed('z', 'Zoned call', '2026-10-22T10:00:00-07:00', '2026-10-22T11:00:00-07:00', { tz: 'America/Los_Angeles' })]);
  const { ctx, page } = await open(browser, `/${id}?backend=cf&view=week&date=2026-10-20`, { now: NOW, cal: 'native' });
  await expect(page.locator('.nc.nc-editable')).toBeVisible({ timeout: 20_000 });
  await page.locator('.nc-timed', { hasText: 'Weekly sync' }).first().click();
  await expect(page.getByTestId('event-card')).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByTestId('card-delete').click();
  const dlg = page.getByTestId('confirm-dialog');
  await dlg.getByTestId('scope-this').check();
  await dlg.getByTestId('confirm-ok').click();
  await soon(async () => ((await calOf(id)).events.find((e) => e.id === 'w').recurrenceException || '')).not.toBe('');
  await page.waitForTimeout(1500);
  await page.locator('.nc-timed', { hasText: 'Zoned call' }).first().click();
  await expect(page.getByTestId('event-card')).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByTestId('card-more').click();
  await page.getByTestId('card-tz-button').click();
  await page.getByTestId('card-picker').getByTestId('picker-input').fill('Vancouver');
  await page.getByTestId('card-picker').getByTestId('picker-input').press('Enter');
  await page.getByTestId('card-done').click();
  await soon(async () => (await calOf(id)).events.find((e) => e.id === 'z').tz).toBe('America/Vancouver');
  expect((await calOf(id)).events.find((e) => e.id === 'z').start, 'same instant: only the zone changed').toBe(iso('2026-10-22T10:00:00-07:00'));
  await page.waitForTimeout(1500);
  await page.getByTestId('last-edit-link').click();
  await expect(page.getByTestId('recent-changes')).toContainText('Added');
  await shot(page, 'A16-activity-nameless-rows');
  const rows = await page.locator('.pc-act-what').allInnerTexts();
  expect(rows, 'each row names its event').toEqual([expect.stringContaining('Zoned call'), expect.stringContaining('Weekly sync'), expect.stringContaining('Added')]);
  await ctx.close();
});

test('A17 [search] ugly: a weekly practice that started Sep 1 is found as "Tue, Sep 1, 5:00 PM", not its next date, and nothing says it repeats', async ({ browser }) => {
  finding('searchEvents lists the stored series row (its first start) instead of the series\' next occurrence');
  const { id } = await seed([timed('w', 'Weekly practice', '2026-09-01T17:00:00-07:00', '2026-09-01T18:00:00-07:00', { recurrencerule: WEEKLY })]);
  for (const cal of [null, 'native']) {
    const { ctx, page } = await open(browser, `/${id}?backend=cf`, { now: NOW, cal });
    await page.getByTestId('search-button-desktop').click();
    await page.locator('input[type=search]:visible').first().fill('practice');
    await expect(page.getByTestId('search-results')).toContainText('Weekly practice');
    await shot(page, `A17-search-series-${cal || 'classic'}`);
    const text = await page.getByTestId('search-results').innerText();
    expect({ firstDate: /Sep 1/.test(text), next: /Oct 27/.test(text) }, `${cal || 'classic'}: the next practice (Tue Oct 27), not the first one: ${text}`).toEqual({ firstDate: false, next: true });
    await ctx.close();
  }
});

test('A18 [search] nit: "cafe" does not find "Café meetup" (accents must be typed exactly)', async ({ browser }) => {
  finding('searchEvents compares lowercase strings only, without folding accents');
  const { id } = await seed([timed('c', 'Café meetup', '2026-11-02T09:00:00-08:00', '2026-11-02T10:00:00-08:00')]);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`, { now: NOW });
  await page.getByTestId('search-button-desktop').click();
  await page.locator('input[type=search]:visible').first().fill('cafe');
  await page.waitForTimeout(500);
  await shot(page, 'A18-search-cafe');
  await expect(page.getByTestId('search-results')).toContainText('Café meetup', { timeout: 2000 });
  await ctx.close();
});

test('A19 [open] data-loss: a calendar whose name ends in a space ("royal city ") opens as a blank new calendar', async ({ browser }) => {
  finding('findAndSubscribe trusts /api/lookup\'s actualSlug, and the directory trims names (SlugService.normalizeSlug + the row it registered): "royal city" != "royal city ", so the app re-subscribes to a calendar that does not exist');
  const real = `${rand().slice(-4)} royal city `;
  await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')], { id: real, title: 'Royal City' });
  expect((await calOf(real)).id, 'the server has it, under its real name').toBe(real);
  const { ctx, page } = await open(browser, `/${encodeURIComponent(real)}?backend=cf`, { now: NOW });
  await page.waitForTimeout(1000);
  await shot(page, 'A19-trailing-space-blank');
  expect({ existing: await vm(page, 'p.isExisting'), title: await vm(page, 'p.calendar.title'), practice: await page.locator('.e-appointment:visible', { hasText: 'Practice' }).count() },
    'the calendar, its title and its event').toEqual({ existing: true, title: 'Royal City', practice: 1 });
  await ctx.close();
});

test('A20 [view] ugly: on a phone, a view link\'s notes are hidden in the ⋮ menu: nothing on screen says the calendar has notes (desktop pins them open)', async ({ browser }) => {
  finding('the phone header moves Notes into the ⋮ menu for everyone; a view link with notes shows no sign of them');
  const { viewId } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')], { options: { notes: 'Rainouts decided by 7am on game day.' } });
  const { ctx, page } = await open(browser, `/view/${viewId}?backend=cf`, { now: NOW, device: 'phone' });
  await shot(page, 'A20-phone-view-notes-hidden');
  const shown = await page.getByText('Rainouts decided by 7am').isVisible().catch(() => false);
  const control = await page.locator('button:visible, a:visible').filter({ hasText: /^\s*Notes\s*$/ }).count();
  expect(shown || control > 0, 'the notes, or a Notes button, on screen without opening a menu').toBe(true);
  await ctx.close();
});

// =====================================================================================================
// Checked and found right (pins).
// =====================================================================================================

test('pin: #51 a calendar named with "!" and spaces gets its view link from Share (Create link), and the view link and its embed open it', async ({ browser }) => {
  const name = `board-events-sign-up1231509sp!x ${rand().slice(-4)}`;
  await seed([timed('e1', 'Board meeting', '2026-10-22T17:00:00-07:00', '2026-10-22T18:30:00-07:00')], { id: name, title: 'Board events', noView: true });
  const { ctx, page, dialogs, errors } = await open(browser, `/${encodeURIComponent(name)}?backend=cf`, { now: NOW });
  await page.getByTestId('share-pill-more').click();
  await page.getByTestId('create-readonly').click();
  await expect(page.getByTestId('share-readonly-addr')).toBeVisible();
  const link = ((await page.getByTestId('share-readonly-addr').getAttribute('title')) || '').replace(/^Copy /, '');
  await soon(async () => (await calOf(name)).options.publicViewId).toBeTruthy();
  const v = await ctx.newPage();
  await v.goto(link);
  await loaded(v);
  await expect(v.getByTestId('view-only-badge')).toBeVisible();
  await expect(v.locator('.e-appointment', { hasText: 'Board meeting' })).toBeVisible();
  const embed = await vm(page, 'p.embedCode()');
  const src = /src="([^"]+)"/.exec(embed)[1];
  const res = await fetch(src.replace(/^https?:\/\/[^/]+/, BASE));
  expect(res.headers.get('content-security-policy') || '').toContain('frame-ancestors *');
  expect({ dialogs, errors }).toEqual({ dialogs: [], errors: [] });
  await ctx.close();
});

test('pin: the feed read by ical.js: a Tokyo-zoned series keeps its zone, EXDATE and moved occurrence; all-day spans; escaped text round-trips', async ({ browser }) => {
  const { viewId } = await seed([
    timed('jp', 'Tokyo standup', '2026-10-06T10:00:00+09:00', '2026-10-06T10:30:00+09:00', { tz: 'Asia/Tokyo', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=4;', recurrenceException: '20261013T010000Z,20261020T010000Z' }),
    timed('jp-x', 'Tokyo standup (moved)', '2026-10-20T11:00:00+09:00', '2026-10-20T11:30:00+09:00', { tz: 'Asia/Tokyo', recurrenceID: 'jp' }),
    { ...timed('ad', 'Camp; day, two \\ "quoted"', '2026-10-28T00:00:00Z', '2026-10-30T00:00:00Z'), isAllDay: true, description: 'Line 1\nLine 2, with; marks' },
  ], { title: 'Feed, test; name' });
  const ics = await (await fetch(`${BASE}/view/${viewId}.ics`)).text();
  const { ctx, page } = await browserFor(browser, { timezoneId: 'Asia/Tokyo' });
  await page.goto(`${BASE}/about.html`);
  await page.addScriptTag({ url: ICALJS });
  const got = await page.evaluate((t) => {
    const comp = new ICAL.Component(ICAL.parse(t));
    const all = comp.getAllSubcomponents('vevent');
    // Everything a subscriber sees in the Tokyo series' weeks: the series (with its exceptions) and any separate event.
    const series = new ICAL.Event(all.find((v) => v.getFirstPropertyValue('uid') === 'jp'));
    for (const x of all.filter((v) => v.getFirstProperty('recurrence-id') && v.getFirstPropertyValue('uid') === 'jp')) series.relateException(x);
    const occ = [], it = series.iterator();
    let next;
    while ((next = it.next()) && occ.length < 6) { const d = series.getOccurrenceDetails(next); occ.push(`${d.startDate.toString()} ${d.item.summary}`); }
    for (const v of all.filter((x) => !x.getFirstProperty('recurrence-id') && !x.getFirstProperty('rrule') && /Tokyo/.test(x.getFirstPropertyValue('summary')))) { const e = new ICAL.Event(v); occ.push(`${e.startDate.toString()} ${e.summary}`); }
    occ.sort();
    const ad = new ICAL.Event(all.find((v) => v.getFirstPropertyValue('uid') === 'ad'));
    return { occ, ad: [ad.startDate.toString(), ad.endDate.toString(), ad.summary, ad.description.split('\n\n')[0]], tzid: series.startDate.timezone };
  }, ics);
  expect(got, ics).toEqual({
    occ: ['2026-10-06T10:00:00 Tokyo standup', '2026-10-20T11:00:00 Tokyo standup (moved)', '2026-10-27T10:00:00 Tokyo standup'],
    ad: ['2026-10-28', '2026-10-30', 'Camp; day, two \\ "quoted"', 'Line 1\nLine 2, with; marks'], tzid: 'Asia/Tokyo' });
  await ctx.close();
});

test('pin: the beta switch: three round trips leave storage, cookie and the page agreeing; ?cal=classic wins once and is not stored', async ({ browser }) => {
  const { id, viewId } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:30:00-07:00')]);
  const { ctx, page, errors } = await browserFor(browser, { now: NOW });
  const state = async () => [await page.evaluate(() => document.documentElement.getAttribute('data-cal')), await page.evaluate(() => localStorage.getItem('pc_cal')),
    ((await ctx.cookies()).find((c) => c.name === 'pc_cal') || {}).value || null, (await page.locator('.nc').count()) > 0, await page.evaluate(() => !!window.scheduleObj)];
  await page.goto(`/${id}?backend=cf`); await loaded(page);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('try-new-cal').first().click();
    await page.waitForLoadState('load'); await loaded(page);
    expect(await state()).toEqual(['native', 'native', 'native', true, false]);
    await page.getByTestId('back-to-classic').first().click();
    await page.waitForLoadState('load'); await loaded(page);
    expect(await state()).toEqual(['classic', 'classic', 'classic', false, true]);
  }
  await page.getByTestId('try-new-cal').first().click();
  await page.waitForLoadState('load'); await loaded(page);
  await page.goto(`/view/${viewId}?backend=cf`); await loaded(page);
  expect(await state()).toEqual(['native', 'native', 'native', true, false]);
  await page.goto(`/${id}?backend=cf&cal=classic`); await loaded(page);
  expect(await state()).toEqual(['classic', 'native', 'native', false, true]);
  await page.goto(`/${id}?backend=cf`); await loaded(page);
  expect(await state()).toEqual(['native', 'native', 'native', true, false]);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('pin: odd names that do work: "TEAM NUÑEZ", "d&d8", "royal city", "강아지봉사", "sp!x board" open from an encoded link, with a view link, feed and embed', async ({ browser }) => {
  for (const name of ['TEAM NUÑEZ', 'd&d8', 'royal city', '강아지봉사', 'sp!x board']) {
    const real = `${rand().slice(-4)} ${name}`;
    const { viewId } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00')], { id: real, title: `Cal ${name}` });
    const { ctx, page, errors } = await open(browser, `/${encodeURIComponent(real)}?backend=cf`);
    expect([await vm(page, 'p.calendar.id'), await vm(page, 'p.isExisting')]).toEqual([real, true]);
    expect((await fetch(`${BASE}/view/${viewId}.ics`)).status).toBe(200);
    expect((await fetch(`${BASE}/${encodeURIComponent(real)}.ics`)).status).toBe(200);
    expect(await vm(page, 'p.embedCode()')).toContain(`/view/${viewId}"`);
    expect(errors).toEqual([]);
    await ctx.close();
  }
});

test('pin: classic on 390/360 phones and iPad, light and dark, en-US and de-DE: no sideways scroll, no errors; embeds 360-1200 fit; ?theme wins', async ({ browser }) => {
  const { id, viewId } = await seed([timed('e1', 'Practice at Riverside Park field 3', '2026-10-22T17:00:00-07:00', '2026-10-22T18:30:00-07:00'),
    { ...timed('e3', 'Camp', '2026-10-27T00:00:00Z', '2026-10-30T00:00:00Z'), isAllDay: true, type: 3 }], { options: { notes: 'Bring water https://example.com/x' } });
  for (const device of ['phone', 'p360', 'ipad']) {
    for (const [scheme, locale] of [['light', 'en-US'], ['dark', 'de-DE']]) {
      for (const p of [`/${id}?backend=cf`, `/view/${viewId}?backend=cf`]) {
        const { ctx, page, errors } = await open(browser, p, { device, colorScheme: scheme, locale, now: NOW });
        expect([await noSideways(page), errors], `${device} ${scheme} ${p}`).toEqual([true, []]);
        await ctx.close();
      }
    }
  }
  for (const w of [360, 600, 1200]) {
    for (const theme of ['', '&theme=dark', '&theme=light']) {
      const { ctx, page } = await browserFor(browser, { colorScheme: theme ? (theme.includes('dark') ? 'light' : 'dark') : 'dark' });
      await page.setViewportSize({ width: w + 40, height: 700 });
      await page.goto(`${BASE}/about.html`);
      await page.setContent(`<body style="margin:20px;background:#111"><iframe id="f" src="${BASE}/view/${viewId}?backend=cf${theme}" title="cal" width="${w}" height="600" style="border:0"></iframe></body>`);
      await expect(page.frameLocator('#f').getByTestId('embed-bar')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      const f = page.frame({ url: /\/view\// });
      const r = await f.evaluate(() => ({ sw: document.documentElement.scrollWidth, theme: document.documentElement.getAttribute('data-theme') }));
      expect(r, `${w} ${theme}`).toEqual({ sw: w, theme: theme ? theme.slice(7) : 'dark' });
      await ctx.close();
    }
  }
});

test('pin: notes with markup and links read as typed (no HTML runs), links open in a new tab, in the panel, the view link and the embed; a taken name offers free ones', async ({ browser }) => {
  const notes = 'Field: https://maps.example.com/riverside-park-field-3\n<script>alert(1)</script> <b>bold?</b> <img src=x onerror=alert(2)> & more';
  const { id, viewId } = await seed([timed('e1', 'Practice', '2026-10-22T17:00:00-07:00', '2026-10-22T18:30:00-07:00')], { options: { notes } });
  for (const [k, p] of [['edit', `/${id}?backend=cf`], ['view', `/view/${viewId}?backend=cf`], ['embed', `/view/${viewId}?backend=cf&embed`]]) {
    const { ctx, page, dialogs, errors } = await open(browser, p, { now: NOW, colorScheme: 'dark' });
    if (k === 'edit') await page.locator('.pc-hdr-actions').getByRole('button', { name: 'Toggle notes' }).click();
    if (k === 'embed') await page.getByTestId('embed-notes-btn').click();
    const box = k === 'embed' ? page.getByTestId('embed-notes') : page.locator('.pc-side-notes-read:visible').first();
    await expect(box).toContainText('<script>alert(1)</script> <b>bold?</b>');
    expect(await box.locator('script, b, img').count(), k).toBe(0);
    const a = box.locator('a').first();
    expect([await a.getAttribute('href'), await a.getAttribute('target'), (await a.getAttribute('rel') || '').includes('noopener')], k).toEqual(['https://maps.example.com/riverside-park-field-3', '_blank', true]);
    expect([dialogs, errors], k).toEqual([[], []]);
    await ctx.close();
  }
  const H = await open(browser, '/?backend=cf', { now: NOW });
  await H.page.locator('#slug').fill(id);
  await H.page.getByTestId('share-new').click();
  await expect(H.page.getByTestId('slug-taken')).toContainText('is taken');
  await expect(H.page.getByTestId('slug-taken').locator('.pc-slug-taken-option')).toHaveCount(3);
  expect(H.dialogs).toEqual([]);
  await H.ctx.close();
});
