// @ts-check
/**
 * One name key (public/services/CalendarName.js): a calendar with a tricky name opens from its real, percent-encoded
 * link, and from another spelling of the same name (case, surrounding spaces, the NFD form some phones send), in the
 * classic and the native calendar; an event added there is saved to THAT calendar, and nothing is made at the other
 * spelling. The Worker half: name-key.test.mjs; the rule itself: test/unit/name-key.test.js.
 * Run with scripts/test-on-box.sh name-key.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL, settled } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SHOTS = path.join(__dirname, '..', 'test-results', 'name-key');
fs.mkdirSync(SHOTS, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
let n = 0;
const rand = () => `${Date.now().toString(36).slice(-5)}${n++}${Math.floor(Math.random() * 1e3)}`;
const enc = encodeURIComponent;
const calOf = async (id) => { const r = await fetch(`${BASE}/cal/${enc(id)}`); return r.status === 200 ? (await r.json()).calendar : null; };
const titles = async (id) => ((await calOf(id)) || { events: [] }).events.map((e) => e.title).sort();
const ev = { id: 'e1', title: 'Practice', start: '2026-10-23T00:00:00.000Z', end: '2026-10-23T01:00:00.000Z', description: '', repeat: '',
  recurrencerule: '', recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1 };

async function seed(id) {
  const r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `Cal ${id}`, options: {}, events: [ev] }) });
  expect(r.status, `seed ${JSON.stringify(id)}`).toBe(201);
  await expect.poll(async () => (await (await fetch(`${BASE}/api/lookup?slug=${enc(id)}`)).json()).actualSlug, { timeout: 5000 }).toBe(id);
}

async function open(browser, link) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await page.goto(link);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  return { ctx, page, errors, dialogs };
}
const shown = (page) => page.evaluate(() => { const p = document.querySelector('#app')._vnode.component.proxy; return { id: p.calendar.id, existing: !!p.isExisting }; });

async function quickAdd(page, text) {
  await expect(page.getByTestId('desktop-add-event-button')).toBeVisible();
  await page.getByTestId('desktop-add-event-button').click();
  await page.locator('textarea[aria-label="Event description"]').fill(text);
  await page.locator('.pc-qa-dialog button[type="submit"]').click();
}

// [the calendar's exact name (a suffix is prepended), another spelling of the same name]
const NAMES = [
  ['royal city ', (s) => s.trim().toUpperCase()],                  // trailing space; opened as "ROYAL CITY"
  [' lead', (s) => `${s.trim()}  `],                               // leading space; opened with trailing spaces instead
  ['TEAM NUÑEZ', (s) => s.toLowerCase().normalize('NFD')],         // accents; opened in NFD, lowercase
  ['50% off', (s) => s.toUpperCase()],                             // %
  ['d&d8 club', (s) => ` ${s.toUpperCase()}`],                     // &
];

for (const cal of ['classic', 'native']) {
  for (const [raw, other] of NAMES) {
    test(`${cal}: ${JSON.stringify(raw)} opens from its encoded link and from another spelling; added events save to it`, async ({ browser }) => {
      const t = rand();
      const name = raw.startsWith(' ') ? ` ${t}${raw}` : `${t} ${raw}`;
      const alt = other(name);
      expect(alt).not.toBe(name);
      await seed(name);
      const q = `?backend=cf${cal === 'native' ? '&cal=native' : ''}`;

      // Its own link, as Share writes it (CalendarPath: encodeURIComponent).
      let { ctx, page, errors, dialogs } = await open(browser, `/${enc(name)}${q}`);
      await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual({ id: name, existing: true });
      await settled(page);
      await quickAdd(page, 'Snack duty tomorrow 3pm');
      await expect.poll(() => titles(name), { timeout: 15_000 }).toEqual(['Practice', 'Snack duty']);
      await page.screenshot({ path: path.join(SHOTS, `${cal}-${raw.trim().replace(/\W+/g, '_')}-exact.png`) }).catch(() => {});
      expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
      await ctx.close();

      // Another spelling of the same name: follows to it; the event is saved to it; nothing is made at that spelling.
      ({ ctx, page, errors, dialogs } = await open(browser, `/${enc(alt)}${q}`));
      await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual({ id: name, existing: true });
      await settled(page);
      await quickAdd(page, 'Bring cones Friday 4pm');
      await expect.poll(() => titles(name), { timeout: 15_000 }).toEqual(['Bring cones', 'Practice', 'Snack duty']);
      await page.screenshot({ path: path.join(SHOTS, `${cal}-${raw.trim().replace(/\W+/g, '_')}-other.png`) }).catch(() => {});
      expect(await calOf(alt), `nothing at ${JSON.stringify(alt)}`).toBe(null);
      expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
      await ctx.close();
    });
  }
}
