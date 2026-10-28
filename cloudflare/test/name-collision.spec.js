// @ts-check
/**
 * Name collisions (Oct 28 2026): 45 calendars' edit links forwarded to /view/<name> because the directory said their
 * name was a view link (a view named like a calendar, July 2025; the Oct 4 cutover gave the view the row).
 *   - a calendar whose directory row says "view" still opens for editing at its name, an edit saves, and the page
 *     reports edit_name_collision; a real view-only name still forwards to /view/ (edit_link_forwarded);
 *   - Share's Rename: this calendar's own name is refused before any request, with the owner's words beside the name
 *     box; another calendar's name is refused by the server ("taken"); a free name works as before.
 * The collision is planted the way production got it: a view row first (backfill), then the calendar (import), whose
 * own registration never re-points a name that leads to another live calendar. The Worker half: name-collision.test.mjs.
 * Run with scripts/test-on-box.sh name-collision.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL, settled } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SECRET = 'dev-secret';   // scripts/test-browser.sh
const SHOTS = path.join(__dirname, '..', 'test-results', 'name-collision');
fs.mkdirSync(SHOTS, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const admin = { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' };
let n = 0;
const rand = () => `${Date.now().toString(36)}${n++}${Math.floor(Math.random() * 1e4)}`;
const ev = (id, title) => ({ id, title, start: '2026-10-22T17:00:00.000Z', end: '2026-10-22T18:00:00.000Z', description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1 });
const calOf = async (id) => (await (await fetch(`${BASE}/cal/${encodeURIComponent(id)}`)).json()).calendar;
const lookup = async (slug) => (await fetch(`${BASE}/api/lookup?slug=${encodeURIComponent(slug)}`)).json();

async function seed(o = {}) {
  const id = o.id || `nc-${rand()}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Name collision', options: {}, events: o.events || [] }) });
  expect(res.status, `seed ${id}`).toBe(201);
  let viewId = null;
  if (o.view) viewId = (await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json()).publicViewId;
  return { id, viewId };
}

/** Calendar `name` with an event, while the directory says `name` is a view link of another calendar. */
async function plantCollision() {
  const other = await seed();
  const name = `nc-${rand()}`;
  const b = await fetch(`${BASE}/api/directory/backfill`, { method: 'POST', headers: admin, body: JSON.stringify([{ actualSlug: name, isReadOnly: true, targetId: other.id }]) });
  expect(b.status).toBe(200);
  const imp = await fetch(`${BASE}/cal/${name}/import`, { method: 'PUT', headers: admin, body: JSON.stringify({ id: name, title: 'Kept editable', options: {}, events: [ev('e1', 'Practice')] }) });
  expect(imp.status).toBe(200);
  await new Promise((r) => setTimeout(r, 300));   // its directory registration (refused: the name leads to a live calendar)
  expect((await lookup(name)).isReadOnly, 'planted: the directory says it is a view').toBe(true);
  return name;
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
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});

test('a calendar whose directory row says "view" stays editable at its name: an added event is saved, edit_name_collision tracked', async ({ browser }) => {
  const name = await plantCollision();
  const { ctx, page, errors, dialogs } = await browserFor(browser);
  await page.goto(`/${name}?backend=cf`);
  await loaded(page);
  await expect.poll(() => tracked(page), { timeout: 10_000 }).toContain('edit_name_collision');
  expect(new URL(page.url()).pathname, 'not forwarded to the view').toBe(`/${name}`);
  expect(await tracked(page)).not.toContain('edit_link_forwarded');
  await settled(page);
  await expect(page.getByTestId('desktop-add-event-button')).toBeVisible();
  await page.getByTestId('desktop-add-event-button').click();
  await page.locator('textarea[aria-label="Event description"]').fill('Snack duty tomorrow 3pm');
  await page.locator('.pc-qa-dialog button[type="submit"]').click();
  await expect.poll(async () => (await calOf(name)).events.map((e) => e.title).sort(), { timeout: 15_000 }).toEqual(['Practice', 'Snack duty']);
  expect(new URL(page.url()).pathname).toBe(`/${name}`);
  await shot(page, 'collision-stays-editable');
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});

test('a real view-only name opened as an edit link still forwards to /view/<name>, edit_link_forwarded tracked', async ({ browser }) => {
  const { viewId } = await seed({ view: true, events: [ev('e1', 'Practice')] });
  expect(viewId).toBeTruthy();
  const { ctx, page, errors } = await browserFor(browser);
  await page.goto(`/${viewId}?backend=cf`);
  await page.waitForURL(`**/view/${viewId}**`, { timeout: 15_000 });
  await loaded(page);
  expect(await tracked(page)).toContain('edit_link_forwarded');
  expect(await tracked(page)).not.toContain('edit_name_collision');
  expect(errors).toEqual([]);
  await ctx.close();
});

// After the repair (scripts/fix-name-collisions.mjs) a view link named after its own calendar has an editable row: the
// same state as a calendar imported with its own name as its view id (the room no longer registers that view id).
for (const cal of ['classic', 'native']) {
  test(`a view link named after its own calendar still opens read-only once its row is editable (${cal})`, async ({ browser }) => {
    const name = `nc-own-${rand()}`;
    const imp = await fetch(`${BASE}/cal/${name}/import`, { method: 'PUT', headers: admin, body: JSON.stringify({ id: name, title: 'Own name view', options: { publicViewId: name }, events: [ev('e1', 'Practice')] }) });
    expect(imp.status).toBe(200);
    await expect.poll(() => lookup(name).then((l) => l.found && l.isReadOnly === false)).toBe(true);
    const { ctx, page, errors, dialogs } = await browserFor(browser);
    await page.goto(`/view/${name}?backend=cf${cal === 'native' ? '&cal=native' : ''}`);
    await loaded(page);
    await expect.poll(() => page.evaluate(() => { const p = document.querySelector('#app')._vnode.component.proxy; return (p.calendar.events || []).map((e) => e.title); })).toEqual(['Practice']);
    const state = await page.evaluate(() => { const p = document.querySelector('#app')._vnode.component.proxy; return { readOnly: p.isReadOnly, problem: p.viewProblem || null, title: p.calendar.title }; });
    expect(state).toEqual({ readOnly: true, problem: null, title: 'Own name view' });
    expect(new URL(page.url()).pathname).toBe(`/view/${name}`);
    await settled(page);
    await shot(page, `own-name-view-${cal}`);
    expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
    await ctx.close();
  });
}

async function openRename(browser, id) {
  const b = await browserFor(browser);
  const sent = [];
  b.page.on('request', (r) => { if (r.url().includes('/api/create-view')) sent.push(r.postData()); });
  await b.page.goto(`/${id}?backend=cf`);
  await loaded(b.page);
  await settled(b.page);
  await b.page.getByTestId('share-pill-more').click();
  await b.page.getByTestId('share-group').getByRole('button', { name: 'Rename' }).click();
  return { ...b, sent, box: b.page.getByLabel('New name for the view-only link') };
}

test('Rename view link to this calendar\'s own name (any case): the in-page message, nothing sent or saved', async ({ browser }) => {
  const { id, viewId } = await seed({ view: true });
  const { ctx, page, errors, dialogs, sent, box } = await openRename(browser, id);
  for (const own of [id, id.toUpperCase()]) {
    await box.fill(own);
    await box.press('Enter');
    await expect(page.getByTestId('view-rename-error')).toHaveText('That’s this calendar’s edit link name. Pick a different one, so the view link can’t be used to edit.');
  }
  await shot(page, 'rename-own-name');
  await page.waitForTimeout(500);
  expect(sent, 'no request was sent').toEqual([]);
  expect((await calOf(id)).options.publicViewId, 'the view link is unchanged').toBe(viewId);
  expect(await lookup(id)).toEqual({ found: true, actualSlug: id, isReadOnly: false, targetId: id });
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});

test('Rename view link to ANOTHER calendar\'s name is refused ("taken"), directory unchanged; a free name works as before', async ({ browser }) => {
  const { id, viewId } = await seed({ view: true });
  const other = await seed();
  const { ctx, page, errors, dialogs, sent, box } = await openRename(browser, id);
  await box.fill(other.id);
  await box.press('Enter');
  await expect(page.getByTestId('view-rename-error')).toHaveText('That name is taken. Try another.');
  await shot(page, 'rename-other-calendar');
  expect(sent.length, 'the server was asked, and refused').toBe(1);
  expect(await lookup(other.id), 'the other calendar keeps its name').toEqual({ found: true, actualSlug: other.id, isReadOnly: false, targetId: other.id });
  expect((await calOf(id)).options.publicViewId).toBe(viewId);
  // A free name: renamed, and the new view link opens the calendar read-only.
  const fresh = `nc-free-${rand()}`;
  await box.fill(fresh);
  await box.press('Enter');
  await expect.poll(async () => (await calOf(id)).options.publicViewId, { timeout: 10_000 }).toBe(fresh);
  await expect(page.getByTestId('view-rename-error')).toHaveCount(0);
  expect((await lookup(fresh)).isReadOnly).toBe(true);
  const v = await fetch(`${BASE}/cal/view/${fresh}`);
  expect(v.status).toBe(200);
  expect((await v.json()).calendar.title).toBe('Name collision');
  expect({ errors, dialogs }).toEqual({ errors: [], dialogs: [] });
  await ctx.close();
});
