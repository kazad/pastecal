// @ts-check
/**
 * Cross-renderer data safety: the same calendar edited by the classic (Syncfusion) calendar and the
 * native one, checked against what the SERVER saved (GET /cal/<id>), not just the screen.
 *
 *   a. repeat exceptions: delete one occurrence and edit another ("this event") in one renderer, read
 *      back in the other; the exact stamp format classic writes (ScheduleAdapter.stamp), both ways
 *   b. all-day events (single and multi-day, across the US and EU DST weeks) made in one renderer and
 *      shown in the other under Los Angeles, Tokyo and London; a no-op editor open/close changes nothing
 *   c. two browsers (one classic, one native) edit different fields of one event at the same time:
 *      both changes survive (the merge measured from where each editor started, ScheduleAdapter.noteStart)
 *   d. drag an event in native: classic shows the new time; stored start/end are ISO, duration kept
 *
 * The renderer is a parameter: RENDERERS.native.open(page, id, query) opens a calendar in it. "native" is the
 * main app's edit link with ?cal=native (/<id>, milestone 2), which saves through classic's own write path;
 * NATIVE_URL=main says so explicitly, and NATIVE_URL=beta points it at /beta/<id> instead (the old fork, with
 * its own copy of the save path). A journey that fails is a finding: it is marked test.fail() with a comment
 * naming the gap (docs/native-gaps.md), so the suite stays green and the gap stays recorded. When the gap is
 * fixed the test "unexpectedly passes" -- remove the mark.
 *
 * LOCAL ONLY (a wrangler dev with its own data folder):
 *   cd cloudflare && node node_modules/.bin/wrangler dev --port 8882 --persist-to $(mktemp -d) \
 *     --var IMPORT_SECRET:dev-secret --var COPY_BACK: --var FIREBASE_DB_URL:
 *   BASE_URL=http://localhost:8882 npx playwright test -c cloudflare/playwright.config.js native-data-parity
 * Calendars are reset through the admin import route (Bearer IMPORT_SECRET, default dev-secret), so
 * reruns don't spend the 10-per-minute create limit.
 */
const { test, expect } = require('@playwright/test');
const { sf, nat, localHM, localYMD } = require('../../test/native-audit/harness');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
// Which native: the main app (default) or the /beta fork (NATIVE_URL=beta).
const BETA = process.env.NATIVE_URL === 'beta';
if (process.env.NATIVE_URL && !['main', 'beta'].includes(process.env.NATIVE_URL)) throw new Error('NATIVE_URL is main or beta: ' + process.env.NATIVE_URL);
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) throw new Error('native-data-parity only runs against a local server: ' + BASE);
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'unpkg.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';   // the fixtures are October 2026
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const STAMP = /^\d{8}T\d{6}Z$/;

/** Classic's exception stamp, verbatim from ScheduleAdapter.stamp. */
const stamp = (when) => new Date(when).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const withBackend = (q) => { const p = new URLSearchParams(q.replace(/^\?/, '')); p.set('backend', 'cf'); return '?' + p.toString(); };

// ------------------------------------------------------------------------------------- the native card
/**
 * The main app's native edit link edits in the event card (nativecal/components/EventCard.js): a click opens it, each
 * change to an existing event is saved as it is made, and a repeating event asks "this event / all events" on its first
 * change. These steps drive it like a person, with the same names as the audit harness's steps (nat), so every journey
 * reads the same in either renderer. /beta (NATIVE_URL=beta) keeps its own editor and the harness's steps.
 */
const card = {
  ...nat,
  _scope: null,
  dialog: (page) => page.locator('[data-testid="event-card"]'),
  async answerScope(page) {
    const dlg = page.locator('[data-testid="confirm-dialog"]');
    if (!(await dlg.isVisible().catch(() => false)) && !(await dlg.waitFor({ state: 'visible', timeout: 600 }).then(() => true, () => false))) return;
    if (await dlg.locator('[data-testid="scope-this"]').count()) await nat.pickScope(page, card._scope || 'this');
  },
  async full(page) { const more = page.locator('[data-testid="card-more"]'); if (await more.count()) await more.click(); await expect(page.locator('[data-testid="card-start-date"]')).toBeVisible(); },
  async quickCreate(page, ymd, title) {
    const c = await nat.cellByDate(page, ymd);
    await c.click({ position: { x: 40, y: 60 } });
    await expect(card.dialog(page)).toBeVisible();
    await page.locator('[data-testid="card-title"]').pressSequentially(title, { delay: 20 });
    await page.locator('[data-testid="card-done"]').click();
    await expect(card.dialog(page)).toHaveCount(0);
  },
  async openNewEditor(page, ymd) {
    const c = await nat.cellByDate(page, ymd);
    await c.click({ position: { x: 40, y: 60 } });
    await expect(card.dialog(page)).toBeVisible();
    await card.full(page);
    card._scope = null;
  },
  async openPopover(page, title) { await nat.event(page, title).first().click(); await expect(card.dialog(page)).toBeVisible(); await page.waitForTimeout(250); },
  async editFromPopover(page, scope) { card._scope = scope || null; await card.full(page); },
  async deleteFromPopover(page, scope) {
    await page.locator('[data-testid="card-delete"]').click();
    if (scope) await nat.pickScope(page, scope);
    await expect(card.dialog(page)).toHaveCount(0);
  },
  async setTitle(page, text) { const i = page.locator('[data-testid="card-title"]'); await i.fill(''); await i.pressSequentially(text, { delay: 20 }); },
  async setAllDay(page, on) {
    await card.full(page);
    const sw = page.locator('[data-testid="card-allday"]');
    if (((await sw.getAttribute('aria-checked')) === 'true') !== on) { await sw.click(); await card.answerScope(page); }
  },
  async setTime(page, which, hhmm) {
    await card.full(page);
    await page.locator(`[data-testid="card-${which}-time"]`).click();
    const input = page.locator('[data-testid="card-picker"] [data-testid="picker-input"]');
    await input.fill(hhmm); await input.press('Enter');
    await expect(page.locator('[data-testid="card-picker"]')).toHaveCount(0);
    await card.answerScope(page);
  },
  async setDate(page, which, ymd) {
    await card.full(page);
    await page.locator(`[data-testid="card-${which}-date"]`).click();
    const input = page.locator('[data-testid="card-picker"] [data-testid="picker-input"]');
    await input.fill(ymd); await input.press('Enter');
    await card.answerScope(page);
  },
  async setRepeatWeekly(page) {
    await card.full(page);
    await page.locator('[data-testid="card-repeat"]').click();
    await page.locator('[data-testid="card-picker"] [data-r="week"]').click();
  },
  async save(page) {
    await page.locator('[data-testid="card-done"]').click();
    await card.answerScope(page);
    await expect(card.dialog(page)).toHaveCount(0);
  },
  async cancelEditor(page) {
    await page.locator('[data-testid="card-cancel"]').click();
    await expect(card.dialog(page)).toHaveCount(0);
  },
};

// ------------------------------------------------------------------------------------- renderers
/** How to open a calendar in each renderer. The UI steps (popover, editor, save) come from the audit harness. */
const RENDERERS = {
  classic: {
    name: 'classic', ui: sf,
    async open(page, id, query = '') {
      await page.goto(`/${id}${withBackend(query)}`);
      await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
      await page.waitForFunction(() => document.querySelector('#app')?._vnode?.component?.proxy?.isLoading === false, null, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(600);
    },
    /** Month-view cells with their day (local midnight ms) */
    cellSel: '.e-work-cells[data-date]', cellAttr: 'data-date',
    async events(page) { return page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.events.map((e) => ({ ...e }))); },
    async setRepeatWeekly(page) {
      // as test/journeys/journeys.spec.js does it
      const repeat = sf.dialog(page).locator('.e-repeat-element');
      await expect(async () => {
        await repeat.locator('..').click();
        await page.waitForTimeout(300);
        await page.locator('.e-popup-open li', { hasText: /^Weekly$/ }).first().click({ timeout: 2000 });
        await page.waitForTimeout(300);
        expect(await repeat.inputValue()).toBe('Weekly');
      }).toPass({ timeout: 10_000 });
    },
    async setDate(page, which, ymd) {
      const input = sf.dialog(page).locator(`input[name="${which === 'start' ? 'StartTime' : 'EndTime'}"]`);
      const cur = await input.inputValue();
      const [y, m, dd] = ymd.split('-').map(Number);
      const long = /^\d{1,2}\/\d{1,2}\/\d{4}/.test(cur);
      await input.click(); await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type(cur.replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}/, `${m}/${dd}/${long ? y : String(y).slice(2)}`), { delay: 15 });
      await page.keyboard.press('Tab');
    },
    async cancelEditor(page) {
      const c = sf.dialog(page).locator('.e-event-cancel').locator('visible=true');
      if (await c.count()) await c.first().click(); else await page.keyboard.press('Escape');
      await expect(sf.dialog(page)).toHaveCount(0);
    },
    timeText: (page, title) => sf.event(page, title).first().innerText(),
  },
  native: {
    name: 'native', ui: BETA ? nat : card,
    async open(page, id, query = '') {
      const main = !BETA;
      await page.goto(main ? `/${id}${withBackend(query)}&cal=native` : `/beta/${id}${withBackend(query)}`);
      await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 20_000 });
      await expect(page.locator('.nc')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
    },
    cellSel: '.nc-cell[data-day]', cellAttr: 'data-day',
    async events(page) { return page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.events.map((e) => ({ ...e }))); },
    async setRepeatWeekly(page) { if (!BETA) return card.setRepeatWeekly(page); await page.locator('[data-testid="editor-repeat"]').selectOption('WEEKLY'); },
    async setDate(page, which, ymd) { if (!BETA) return card.setDate(page, which, ymd); await page.locator(`[data-testid="editor-${which}-date"]`).fill(ymd); },
    async cancelEditor(page) {
      if (!BETA) return card.cancelEditor(page);
      await page.locator('[data-testid="editor-cancel"]').click();
      await expect(nat.dialog(page)).toHaveCount(0);
    },
    timeText: (page, title) => nat.event(page, title).first().innerText(),
  },
};
const { classic, native } = RENDERERS;
const other = (r) => (r === classic ? native : classic);

// ------------------------------------------------------------------------------------- server + browsers
async function reset(id, events, title = 'Data parity') {
  const head = await fetch(`${BASE}/cal/${id}`, { method: 'HEAD' });
  if (head.status === 429) { await new Promise((r) => setTimeout(r, 15_000)); return reset(id, events, title); }
  const res = head.status === 404
    ? await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, events }) })
    : await fetch(`${BASE}/cal/${id}/import`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ id, title, events }) });
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 15_000)); return reset(id, events, title); }   // 10 creates a minute
  if (!res.ok) throw new Error(`reset ${id}: ${res.status} ${await res.text()}`);
}
/** The events as the server holds them. */
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const soon = (fn, timeout = 15_000) => expect.poll(fn, { timeout, intervals: [250, 500, 1000] });

/** A browser in a time zone: only local hosts and fonts/CDNs, the Cloudflare backend, a fixed clock. */
async function openBrowser(browser, timezoneId = 'America/Los_Angeles') {
  const ctx = await browser.newContext({ timezoneId, locale: 'en-US', viewport: { width: 1280, height: 800 }, baseURL: BASE });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  await ctx.routeWebSocket((u) => !/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (ws) => ws.close());
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(NOW) });
  return { ctx, page };
}

const timed = (id, title, startIso, endIso, extra = {}) => ({ id, title, start: new Date(startIso).toISOString(), end: new Date(endIso).toISOString(),
  description: '', repeat: '', recurrencerule: '', recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });

/** Days (YYYY-MM-DD, local) that `title`'s bars cover in the month grid now on screen. */
async function daysCovered(r, page, title) {
  return page.evaluate(({ cellSel, attr, sel, title }) => {
    const ymd = (ms) => { const d = new Date(Number(ms)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const cells = [...document.querySelectorAll(cellSel)].map((c) => ({ day: ymd(c.getAttribute(attr)), b: c.getBoundingClientRect() }));
    const bars = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null && e.textContent.includes(title)).map((e) => e.getBoundingClientRect());
    const out = new Set();
    for (const b of bars) {
      const cy = b.top + b.height / 2;
      for (const c of cells) {
        if (cy < c.b.top || cy > c.b.bottom) continue;
        const overlap = Math.min(b.right, c.b.right) - Math.max(b.left, c.b.left);
        if (overlap > c.b.width * 0.5) out.add(c.day);
      }
    }
    return { days: [...out].sort(), shown: cells.map((c) => c.day) };
  }, { cellSel: r.cellSel, attr: r.cellAttr, sel: r === classic ? '.e-appointment' : '.nc-bar', title });
}

// =====================================================================================================
// a. Repeat exceptions, both directions
// =====================================================================================================
for (const [maker, editor] of [[classic, native], [native, classic]]) {
  test(`a. weekly series made in ${maker.name}; ${editor.name} deletes one occurrence and edits another; ${maker.name} reads it back`, async ({ browser }) => {
    const id = `dp-a-${maker.name}-${editor.name}`;
    await reset(id, []);
    const { ctx, page } = await openBrowser(browser);

    // Made in `maker`: Tuesdays 10:00-11:00 Los Angeles, from Oct 6, no end.
    await maker.open(page, id, '?view=month&date=2026-10-06');
    await maker.ui.openNewEditor(page, '2026-10-06');
    await maker.ui.setTitle(page, 'Weekly sync');
    await maker.ui.setAllDay(page, false);
    await maker.ui.setTime(page, 'start', '10:00');
    await maker.ui.setTime(page, 'end', '11:00');
    await maker.setRepeatWeekly(page);
    await maker.ui.save(page);
    await soon(async () => ((await stored(id)).find((e) => e.title === 'Weekly sync') || {}).recurrencerule || '').toMatch(/FREQ=WEEKLY/);
    const before = (await stored(id)).find((e) => e.title === 'Weekly sync');
    expect(before.start).toMatch(ISO);
    expect(await localHM(page, before.start)).toBe('10:00');

    // In `editor`: delete Oct 13 ("this event"), then edit Oct 20 ("this event") to a new title.
    await editor.open(page, id, '?view=day&date=2026-10-13');
    await editor.ui.openPopover(page, 'Weekly sync');
    await editor.ui.deleteFromPopover(page, 'this');
    await soon(async () => ((await stored(id)).find((e) => e.id === before.id) || {}).recurrenceException || '').toBe(stamp('2026-10-13T10:00:00-07:00'));
    await editor.open(page, id, '?view=day&date=2026-10-20');
    await editor.ui.openPopover(page, 'Weekly sync');
    await editor.ui.editFromPopover(page, 'this');
    await editor.ui.setTitle(page, 'Weekly sync (moved)');
    await editor.ui.save(page);
    await soon(async () => (await stored(id)).length).toBe(2);

    // The saved data: the exact stamps classic writes, the edited occurrence as its own row, nothing else touched.
    const rows = await stored(id);
    const master = rows.find((e) => e.id === before.id);
    const child = rows.find((e) => e.id !== before.id);
    const s13 = stamp('2026-10-13T10:00:00-07:00'), s20 = stamp('2026-10-20T10:00:00-07:00');
    expect(s13).toBe('20261013T170000Z');
    expect(master.recurrenceException).toBe(`${s13},${s20}`);
    for (const s of master.recurrenceException.split(',')) expect(s).toMatch(STAMP);
    for (const k of ['title', 'start', 'end', 'recurrencerule', 'isAllDay', 'type', 'description', 'recurrenceID']) expect(master[k], `series ${k}`).toEqual(before[k]);
    expect(child.title).toBe('Weekly sync (moved)');
    expect(child.recurrenceID).toBe(before.id);
    expect(child.recurrenceException).toBe(s20);
    expect(child.recurrencerule).toBe(before.recurrencerule);
    expect(child.start).toBe(new Date('2026-10-20T10:00:00-07:00').toISOString());
    expect(child.end).toBe(new Date('2026-10-20T11:00:00-07:00').toISOString());

    // `maker` reloads and draws the same thing.
    await maker.open(page, id, '?view=day&date=2026-10-13');
    await expect(maker.ui.event(page, 'Weekly sync')).toHaveCount(0);
    await maker.open(page, id, '?view=day&date=2026-10-20');
    await expect(maker.ui.event(page, 'Weekly sync (moved)').first()).toBeVisible();
    expect(await maker.ui.event(page, 'Weekly sync').count()).toBe(await maker.ui.event(page, 'Weekly sync (moved)').count());
    await maker.open(page, id, '?view=day&date=2026-10-27');
    await expect(maker.ui.event(page, 'Weekly sync').first()).toBeVisible();
    await ctx.close();
  });
}

// =====================================================================================================
// b. All-day events across time zones and DST weeks
// =====================================================================================================
const ZONES = ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/London'];
// EU clocks change Sun Oct 25 2026, US clocks Sun Nov 1 2026. End dates are inclusive (as typed).
const ALLDAY = [
  { title: 'EU one day', from: '2026-10-25', to: '2026-10-25' },
  { title: 'EU three days', from: '2026-10-24', to: '2026-10-26' },
  { title: 'US one day', from: '2026-11-01', to: '2026-11-01' },
  { title: 'US three days', from: '2026-10-31', to: '2026-11-02' },
];
const daysOf = (from, to) => { const out = []; for (let d = new Date(from + 'T12:00:00Z'); d <= new Date(to + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };
const keyFields = (e) => ({ start: e.start, end: e.end, isAllDay: !!e.isAllDay });

/** For every all-day fixture, the days `r` draws it on (October and November grids together). */
async function allDayShown(r, page, id) {
  const seen = Object.fromEntries(ALLDAY.map((a) => [a.title, new Set()]));
  const visible = new Set();
  for (const month of ['2026-10-15', '2026-11-15']) {
    await r.open(page, id, `?view=month&date=${month}`);
    for (const a of ALLDAY) {
      const { days, shown } = await daysCovered(r, page, a.title);
      days.forEach((d) => seen[a.title].add(d)); shown.forEach((d) => visible.add(d));
    }
  }
  return { seen: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v].sort()])), visible };
}

// What both renderers store for the all-day events typed in `zone`: the author's local midnight, end exclusive
// (as b2 seeds it). The "made" test checks the maker stores exactly these rows (all but the id); the viewer and
// editor-open tests start from them, so each zone is its own test and they run side by side.
const zoneOffset = (ms, zone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
};
const zoneMidnight = (ymd, zone) => { const wall = Date.parse(ymd + 'T00:00:00Z'); let t = wall; for (let i = 0; i < 3; i++) t = wall - zoneOffset(t, zone); return new Date(t).toISOString(); };
const nextDay = (ymd) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const allDayRows = (zone) => ALLDAY.map((a, i) => ({ ...timed(`ad-${i}`, a.title, zoneMidnight(a.from, zone), zoneMidnight(nextDay(a.to), zone)), isAllDay: true }));
const allDayExpected = Object.fromEntries(ALLDAY.map((a) => [a.title, daysOf(a.from, a.to)]));
const seedAllDay = (id, zone) => reset(id, allDayRows(zone));
const withoutId = ({ id, ...rest }) => rest;

for (const zone of ZONES) {
  for (const maker of [classic, native]) {
    const viewer = other(maker);
    const tag = `${maker.name}-${zone.split('/')[1].toLowerCase()}`;
    test(`b. all-day events made in ${maker.name} (${zone}): stored as that zone's midnights, drawn by ${maker.name} on the dates typed`, async ({ browser }) => {
      const id = `dp-b-${tag}`;
      await reset(id, []);
      const { ctx, page } = await openBrowser(browser, zone);
      for (const a of ALLDAY) {
        await maker.open(page, id, `?view=month&date=${a.from}`);
        if (a.from === a.to) {
          await maker.ui.quickCreate(page, a.from, a.title);
        } else {
          await maker.ui.openNewEditor(page, a.from);
          await maker.ui.setTitle(page, a.title);
          await maker.ui.setAllDay(page, true);
          await maker.setDate(page, 'end', a.to);
          await maker.ui.save(page);
        }
        await soon(async () => !!(await stored(id)).find((e) => e.title === a.title)).toBe(true);
      }
      const made = await stored(id);
      for (const a of ALLDAY) expect(made.find((e) => e.title === a.title).isAllDay, a.title).toBe(true);
      // exactly what the viewer and editor tests below start from
      for (const e of allDayRows(zone)) expect(withoutId(made.find((x) => x.title === e.title)), `${e.title} as stored`).toEqual(withoutId(e));

      // Where the maker itself draws them.
      const own = await allDayShown(maker, page, id);
      expect(own.seen, `${maker.name} in ${zone}`).toEqual(allDayExpected);
      await ctx.close();
    });

    // The other renderer, in every zone: the same dates.
    for (const z of ZONES) {
      test(`b. all-day events made in ${maker.name} (${zone}) show on the same dates in ${viewer.name} in ${z}`, async ({ browser }) => {
        const id = `dp-b-${tag}-in-${z.split('/')[1].toLowerCase()}`;
        await seedAllDay(id, zone);
        const b = await openBrowser(browser, z);
        const got = await allDayShown(viewer, b.page, id);
        expect(got.seen, `${viewer.name} in ${z}`).toEqual(allDayExpected);
        await b.ctx.close();
      });
    }

    // A no-op open and close of the viewer's editor (in a zone other than the maker's) stores nothing.
    const z2 = ZONES[(ZONES.indexOf(zone) + 1) % ZONES.length];
    test(`b. all-day events made in ${maker.name} (${zone}): opening and closing ${viewer.name}'s editor in ${z2} changes nothing`, async ({ browser }) => {
      const id = `dp-b-${tag}-noop`;
      await seedAllDay(id, zone);
      const made = await stored(id);
      const b = await openBrowser(browser, z2);
      for (const a of ALLDAY) {
        await viewer.open(b.page, id, `?view=month&date=${a.from}`);
        await viewer.ui.openPopover(b.page, a.title);
        await viewer.ui.editFromPopover(b.page);
        await viewer.cancelEditor(b.page);
      }
      await b.page.waitForTimeout(1500);
      const after = await stored(id);
      for (const a of ALLDAY) {
        expect(keyFields(after.find((e) => e.title === a.title)), `${a.title} after ${viewer.name} editor open/close in ${z2}`)
          .toEqual(keyFields(made.find((e) => e.title === a.title)));
      }
      await b.ctx.close();
    });
  }
}

// A no-op Save (open the editor, change nothing, Save) in another zone keeps the dates.
for (const r of [classic, native]) {
  test(`b2. ${r.name}: Save with no changes, on all-day events made in Tokyo, viewed in Los Angeles, keeps their dates`, async ({ browser }) => {
    const id = `dp-b2-${r.name}`;
    // As both renderers store all-day events: the author's local midnight (Tokyo, UTC+9), end exclusive.
    await reset(id, [
      { ...timed('ad-1', 'Tokyo one day', '2026-10-31T15:00:00Z', '2026-11-01T15:00:00Z'), isAllDay: true },
      { ...timed('ad-3', 'Tokyo three days', '2026-10-30T15:00:00Z', '2026-11-02T15:00:00Z'), isAllDay: true },
    ]);
    const { ctx, page } = await openBrowser(browser, 'America/Los_Angeles');
    const before = await stored(id);
    for (const title of ['Tokyo one day', 'Tokyo three days']) {
      await r.open(page, id, '?view=month&date=2026-11-01');
      await r.ui.openPopover(page, title);
      await r.ui.editFromPopover(page);
      await r.ui.save(page);
    }
    await page.waitForTimeout(2000);
    const after = await stored(id);
    for (const e of before) expect(keyFields(after.find((x) => x.id === e.id)), e.title).toEqual(keyFields(e));
    // and the days drawn are the dates the Tokyo author meant
    await r.open(page, id, '?view=month&date=2026-11-01');
    const one = await daysCovered(r, page, 'Tokyo one day'), three = await daysCovered(r, page, 'Tokyo three days');
    expect(one.days).toEqual(['2026-11-01']);
    expect(three.days).toEqual(['2026-10-31', '2026-11-01', '2026-11-02'].filter((d) => three.shown.includes(d)));
    await ctx.close();
  });
}

// An all-day weekly series made in Tokyo with one date skipped, as classic stores it there: the author's
// local midnight (UTC+9) for the dates, the skipped date's stamp at Tokyo midnight (Event.allDayStampFromLocal).
const tokyoWeekly = () => [{ ...timed('tw-1', 'Tokyo weekly', '2026-10-05T15:00:00Z', '2026-10-06T15:00:00Z'), isAllDay: true,
  recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=4', recurrenceException: '20261012T150000Z' }];   // Tue Oct 6, (13), 20, 27
// Finding D2 (docs/native-gaps.md), fixed: native drew a skipped date of an all-day repeating event again when
// the viewer's zone differed from the zone it was skipped in, because it compared the stored stamps raw.
// NativeCalendar now reads each stamp as the date it names (allDayStampKey), as classic does
// (ScheduleAdapter.toView -> Event.allDayExceptionsToLocal), in the main app and in /beta.
for (const r of [classic, native]) {
  test(`b3. ${r.name}: an all-day weekly series from Tokyo with a skipped date skips it in every zone`, async ({ browser }) => {
    const id = `dp-b3-show-${r.name}`;
    await reset(id, tokyoWeekly());
    for (const z of ZONES) {
      const b = await openBrowser(browser, z);
      await r.open(b.page, id, '?view=month&date=2026-10-15');
      expect.soft((await daysCovered(r, b.page, 'Tokyo weekly')).days, `${r.name} in ${z}`).toEqual(['2026-10-06', '2026-10-20', '2026-10-27']);
      await b.ctx.close();
    }
  });
}
for (const deleter of [classic, native]) {
  const reader = other(deleter);
  test(`b3. ${deleter.name} in Los Angeles skips another date of the Tokyo series: stamps stored as classic writes them; ${reader.name} in Tokyo agrees`, async ({ browser }) => {
    const id = `dp-b3-${deleter.name}`;
    await reset(id, tokyoWeekly());
    const la = await openBrowser(browser, 'America/Los_Angeles');
    await deleter.open(la.page, id, '?view=day&date=2026-10-20');
    await deleter.ui.openPopover(la.page, 'Tokyo weekly');
    await deleter.ui.deleteFromPopover(la.page, 'this');
    await soon(async () => ((await stored(id))[0].recurrenceException || '').split(',').length).toBe(2);
    const [row] = await stored(id);
    expect(row.recurrenceException.split(',')[0]).toBe('20261012T150000Z');   // the existing stamp kept verbatim
    for (const s of row.recurrenceException.split(',')) expect(s).toMatch(STAMP);
    expect(keyFields(row)).toEqual(keyFields(tokyoWeekly()[0]));
    expect(row.recurrencerule).toBe(tokyoWeekly()[0].recurrencerule);
    await la.ctx.close();
    const tk = await openBrowser(browser, 'Asia/Tokyo');
    await reader.open(tk.page, id, '?view=month&date=2026-10-15');
    expect((await daysCovered(reader, tk.page, 'Tokyo weekly')).days, `${reader.name} in Tokyo`).toEqual(['2026-10-06', '2026-10-27']);
    await tk.ctx.close();
  });
}

// =====================================================================================================
// c. Two browsers, one classic and one native, edit different fields of one event at the same time
// =====================================================================================================
for (const [titler, timer] of [[classic, native], [native, classic]]) {
  test(`c. ${titler.name} renames while ${timer.name} moves the time, both editors open at once: both changes survive`, async ({ browser }) => {
    // FINDING D1 (docs/native-gaps.md), /beta only: its editor Save writes its whole form over the row
    // ({ ...events[i], ...data } in public/nativecal/app.js handleSaveEvent), not the fields the user
    // changed since the editor opened -- so a title changed elsewhere while the editor was open is
    // silently put back. Classic keeps both (ScheduleAdapter.noteStart / changesFrom), and so does the main
    // app's native calendar, which saves through classic's path.
    test.fail(BETA && timer === native, 'D1: /beta editor save overwrites fields changed elsewhere while it was open');
    const id = `dp-c-${titler.name}-${timer.name}`;
    await reset(id, [timed('shared-1', 'Planning', '2026-10-22T09:00:00-07:00', '2026-10-22T10:00:00-07:00', { description: 'Room 4' })]);
    const A = await openBrowser(browser), B = await openBrowser(browser);
    await titler.open(A.page, id, '?view=week&date=2026-10-22');
    await timer.open(B.page, id, '?view=week&date=2026-10-22');
    // Both editors open on the same starting point.
    await titler.ui.openPopover(A.page, 'Planning'); await titler.ui.editFromPopover(A.page);
    await timer.ui.openPopover(B.page, 'Planning'); await timer.ui.editFromPopover(B.page);
    await titler.ui.setTitle(A.page, 'Planning (renamed)');
    await timer.ui.setTime(B.page, 'start', '11:00');
    await timer.ui.setTime(B.page, 'end', '12:00');
    // A saves; B's page receives it live while its editor is still open; then B saves.
    await titler.ui.save(A.page);
    await soon(async () => (await stored(id))[0].title).toBe('Planning (renamed)');
    await soon(async () => (await timer.events(B.page)).some((e) => e.title === 'Planning (renamed)')).toBe(true);
    await timer.ui.save(B.page);
    await soon(async () => (await stored(id))[0].start).toBe(new Date('2026-10-22T11:00:00-07:00').toISOString());
    await B.page.waitForTimeout(1500);
    const rows = await stored(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title, `${timer.name}'s save kept ${titler.name}'s new title`).toBe('Planning (renamed)');
    expect(rows[0].start).toBe(new Date('2026-10-22T11:00:00-07:00').toISOString());
    expect(rows[0].end).toBe(new Date('2026-10-22T12:00:00-07:00').toISOString());
    expect(rows[0].description).toBe('Room 4');
    // and both browsers converge on it
    await soon(async () => (await titler.events(A.page)).map((e) => `${e.title}|${new Date(e.start).toISOString()}`)).toEqual([`Planning (renamed)|${rows[0].start}`]);
    await A.ctx.close(); await B.ctx.close();
  });
}

// =====================================================================================================
// d. Drag an event in native; classic shows the new time
// =====================================================================================================
test('d. drag an event one hour later in native week view: stored ISO, duration kept, classic shows 12:00', async ({ browser }) => {
  const id = 'dp-d-drag';
  await reset(id, [timed('drag-1', 'Dentist', '2026-10-22T11:00:00-07:00', '2026-10-22T12:30:00-07:00', { description: 'Bring forms', type: 3 })]);
  const { ctx, page } = await openBrowser(browser);
  await native.open(page, id, '?view=week&date=2026-10-22');
  const ev = nat.event(page, 'Dentist').first();
  await ev.scrollIntoViewIfNeeded();
  const b = await ev.boundingBox();
  const hourPx = await page.evaluate(() => { const l = [...document.querySelectorAll('.nc-hour-label')]; return l.length > 1 ? l[1].getBoundingClientRect().top - l[0].getBoundingClientRect().top : 48; });
  const x = b.x + b.width / 2, y0 = b.y + b.height / 2;   // the middle: the edges resize
  await page.mouse.move(x, y0); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(x, y0 + (hourPx * i) / 10); await page.waitForTimeout(20); }
  await page.mouse.up();
  await soon(async () => localHM(page, (await stored(id))[0].start)).toBe('12:00');
  const [e] = await stored(id);
  expect(e.start).toMatch(ISO);
  expect(e.end).toMatch(ISO);
  expect(new Date(e.end).getTime() - new Date(e.start).getTime()).toBe(90 * 60000);
  expect(await localYMD(page, e.start)).toBe('2026-10-22');
  expect([e.id, e.title, e.description, e.type, !!e.isAllDay, e.recurrencerule || '']).toEqual(['drag-1', 'Dentist', 'Bring forms', 3, false, '']);
  // Classic, in another browser, draws it at 12:00
  const c = await openBrowser(browser);
  await classic.open(c.page, id, '?view=day&date=2026-10-22');
  await expect(sf.event(c.page, 'Dentist').first()).toBeVisible();
  expect(await classic.timeText(c.page, 'Dentist')).toMatch(/12:00\s*PM/);
  await c.ctx.close(); await ctx.close();
});
