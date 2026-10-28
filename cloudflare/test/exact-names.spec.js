// @ts-check
/**
 * Exact names first (Oct 28 2026): the directory keeps one row per lowercase name, so the owner of "foo" was taken
 * to "Foo", another calendar (91 calendars). Calendars are planted as production has them: the bigger spelling
 * first (its import takes the row), the other second (its registration is refused: the name leads to a live calendar).
 *   - /xfoo opens xfoo (its one event), an added event is saved to xfoo, XFoo is untouched; /XFoo opens XFoo;
 *     a third spelling with no calendar of its own follows the row, as before
 *   - the page alone: with /api/lookup answering the OLD way (the row's spelling), /xfoo still opens xfoo
 *     (revert the client change and this fails)
 *   - a spaced name opens its own calendar; a name whose only row is a view link in another case opens editable
 *   - a new calendar in another spelling of a taken name: "is taken", from the name check and from the server
 * The Worker half: exact-names.test.mjs; the page's decision in isolation: test/unit/exact-names.test.js.
 * Run with scripts/test-on-box.sh exact-names.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL, settled } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SECRET = 'dev-secret';   // scripts/test-browser.sh
const SHOTS = path.join(__dirname, '..', 'test-results', 'exact-names');
fs.mkdirSync(SHOTS, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const admin = { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' };
let n = 0;
const rand = () => `${Date.now().toString(36)}${n++}${Math.floor(Math.random() * 1e4)}`;
const ev = (id, title, day = 22) => ({ id, title, start: `2026-10-${day}T17:00:00.000Z`, end: `2026-10-${day}T18:00:00.000Z`, description: '', repeat: '',
  recurrencerule: '', recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1 });
const enc = encodeURIComponent;
const calOf = async (id) => (await (await fetch(`${BASE}/cal/${enc(id)}`)).json()).calendar;
const lookup = async (slug) => (await fetch(`${BASE}/api/lookup?slug=${enc(slug)}`)).json();
const imp = async (id, title, events) => {
  const r = await fetch(`${BASE}/cal/${enc(id)}/import`, { method: 'PUT', headers: admin, body: JSON.stringify({ id, title, options: {}, events }) });
  expect(r.status, `import ${id}`).toBe(200);
  await new Promise((res) => setTimeout(res, 300));   // its directory registration (in the background)
};

/** `Big` (3 events) then `small` (1 event): the directory row is Big's. `third` is a spelling with no calendar. */
async function plantVariants(big, small, third) {
  await imp(big, 'Big calendar', [ev('b1', 'Big one', 20), ev('b2', 'Big two', 21), ev('b3', 'Big three', 23)]);
  await imp(small, 'Small calendar', [ev('s1', 'Small only')]);
  expect((await lookup(third)).actualSlug, 'the row is the big one\'s').toBe(big);
}

// Analytics is off in tests (window.__TEST__): record every name the page tracks, in localStorage (it survives a forward).
async function browserFor(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  await ctx.addInitScript(() => {
    window.__TEST__ = true;
    try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ }
    Object.defineProperty(window, 'Analytics', { configurable: true, get() { return window.__A; }, set(v) {
      const track = v.track;
      v.track = function (name, params) {
        try { localStorage.setItem('__tracked', JSON.stringify([...JSON.parse(localStorage.getItem('__tracked') || '[]'), name])); } catch (e) { /* blocked */ }
        return track.call(this, name, params);
      };
      window.__A = v;
    } });
  });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return { ctx, page, errors, dialogs };
}
const loaded = (page) => page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
const tracked = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('__tracked') || '[]'));
const shown = (page) => page.evaluate(() => { const p = document.querySelector('#app')._vnode.component.proxy; return { id: p.calendar.id, title: p.calendar.title, events: (p.calendar.events || []).map((e) => e.title).sort() }; });
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});

async function addEvent(page, text) {
  await expect(page.getByTestId('desktop-add-event-button')).toBeVisible();
  await page.getByTestId('desktop-add-event-button').click();
  await page.locator('textarea[aria-label="Event description"]').fill(text);
  await page.locator('.pc-qa-dialog button[type="submit"]').click();
}

test('two spellings: /xfoo opens xfoo and saves to it (edit_case_variant), /XFoo opens XFoo, a third spelling follows the row', async ({ browser }) => {
  const t = rand();
  const big = `XFoo-${t}`, small = big.toLowerCase(), third = big.toUpperCase();
  await plantVariants(big, small, third);
  const { ctx, page, errors, dialogs } = await browserFor(browser);
  await page.goto(`/${small}?backend=cf`);
  await loaded(page);
  await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual({ id: small, title: 'Small calendar', events: ['Small only'] });
  await expect.poll(() => tracked(page)).toContain('edit_case_variant');
  await settled(page);
  await shot(page, 'small-opens-small');
  await addEvent(page, 'Snack duty tomorrow 3pm');
  await expect.poll(async () => (await calOf(small)).events.map((e) => e.title).sort(), { timeout: 15_000 }).toEqual(['Small only', 'Snack duty']);
  expect((await calOf(big)).events.map((e) => e.title).sort(), 'the other spelling is untouched').toEqual(['Big one', 'Big three', 'Big two']);
  expect(new URL(page.url()).pathname).toBe(`/${small}`);
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });

  await page.goto(`/${big}?backend=cf`);
  await loaded(page);
  await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual({ id: big, title: 'Big calendar', events: ['Big one', 'Big three', 'Big two'] });
  await page.goto(`/${third}?backend=cf`);
  await loaded(page);
  await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual({ id: big, title: 'Big calendar', events: ['Big one', 'Big three', 'Big two'] });
  await shot(page, 'third-follows-row');
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});

test('the page alone: /api/lookup answering the old way (the row\'s spelling), /xfoo still opens xfoo and saves there', async ({ browser }) => {
  const t = rand();
  const big = `XBar-${t}`, small = big.toLowerCase();
  await plantVariants(big, small, big.toUpperCase());
  const { ctx, page, errors, dialogs } = await browserFor(browser);
  let answered = 0;
  await page.route(/\/api\/lookup\?/, (r) => { answered++; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ found: true, actualSlug: big, isReadOnly: false, targetId: big }) }); });
  await page.goto(`/${small}?backend=cf`);
  await loaded(page);
  await expect.poll(() => tracked(page), { timeout: 10_000 }).toContain('edit_case_variant');
  expect(answered, 'the page asked the (old) lookup').toBeGreaterThan(0);
  await settled(page);
  expect(await shown(page)).toEqual({ id: small, title: 'Small calendar', events: ['Small only'] });
  await addEvent(page, 'Bring cones Friday 4pm');
  await expect.poll(async () => (await calOf(small)).events.map((e) => e.title).sort(), { timeout: 15_000 }).toEqual(['Bring cones', 'Small only']);
  expect((await calOf(big)).events).toHaveLength(3);
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});

test('a spaced name opens its own calendar (not the other spelling the row names)', async ({ browser }) => {
  const t = rand();
  const big = `XSp-${t} `, small = big.toLowerCase();
  await plantVariants(big, small, `xSP-${t} `);
  const { ctx, page, errors, dialogs } = await browserFor(browser);
  await page.goto(`/${enc(small)}?backend=cf`);
  await loaded(page);
  await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual({ id: small, title: 'Small calendar', events: ['Small only'] });
  await settled(page);
  await shot(page, 'spaced-opens-own');
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});

test('a calendar whose name\'s only row is a view link in another case opens editable (edit_name_collision); the view name still forwards', async ({ browser }) => {
  const t = rand();
  const other = `xother-${t}`, Name = `VName-${t}`, viewName = Name.toLowerCase();
  await imp(other, 'Other calendar', [ev('o', 'Other event')]);
  const b = await fetch(`${BASE}/api/directory/backfill`, { method: 'POST', headers: admin, body: JSON.stringify([{ actualSlug: viewName, isReadOnly: true, targetId: other }]) });
  expect(b.status).toBe(200);
  await imp(Name, 'Named calendar', [ev('v', 'Named event')]);
  expect((await lookup(viewName)).isReadOnly, 'the row is a view').toBe(true);
  const { ctx, page, errors, dialogs } = await browserFor(browser);
  await page.goto(`/${Name}?backend=cf`);
  await loaded(page);
  await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual({ id: Name, title: 'Named calendar', events: ['Named event'] });
  await expect.poll(() => tracked(page)).toContain('edit_name_collision');
  expect(new URL(page.url()).pathname).toBe(`/${Name}`);
  await settled(page);
  await addEvent(page, 'Rehearsal Monday 6pm');
  await expect.poll(async () => (await calOf(Name)).events.map((e) => e.title).sort(), { timeout: 15_000 }).toEqual(['Named event', 'Rehearsal']);
  await page.goto(`/${viewName}?backend=cf`);
  await page.waitForURL(`**/view/${viewName}**`, { timeout: 15_000 });
  await loaded(page);
  await expect.poll(() => shown(page), { timeout: 15_000 }).toMatchObject({ title: 'Other calendar', events: ['Other event'] });
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});

for (const blind of [false, true]) {
  test(`a new calendar in another spelling of a taken name: "is taken"${blind ? ' (name check blinded: the server refuses the save)' : ''}`, async ({ browser }) => {
    const t = rand();
    const taken = `XNew-${t}`;
    await imp(taken, 'Taken', [ev('x', 'Theirs')]);
    const { ctx, page, errors, dialogs } = await browserFor(browser);
    await page.goto('/?backend=cf');
    await loaded(page);
    await settled(page);
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/cal\/[^/?]+$/.test(r.url())) posts.push(r.url()); });
    if (blind) {
      // The name check sees nothing (as if the variant were unknown to it): only the server's refusal is left.
      await page.route(/\/api\/lookup\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
      await page.route(/\/cal\/[^/?]+$/, (r) => (r.request().method() === 'HEAD' ? r.fulfill({ status: 404 }) : r.continue()));
    }
    await page.locator('#slug').fill(taken.toUpperCase());
    await page.getByTestId('share-new').click();
    await expect(page.getByTestId('slug-taken')).toContainText('is taken');
    await shot(page, `new-variant-taken${blind ? '-server' : ''}`);
    expect(posts.length, blind ? 'the save was sent and refused' : 'nothing was sent').toBe(blind ? 1 : 0);
    expect((await fetch(`${BASE}/cal/${enc(taken.toLowerCase())}`, { method: 'HEAD' })).status, 'no new calendar').toBe(404);
    expect((await calOf(taken)).events.map((e) => e.title)).toEqual(['Theirs']);
    expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
    await ctx.close();
  });
}
