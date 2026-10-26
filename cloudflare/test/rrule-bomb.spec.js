// @ts-check
/**
 * A repeat rule that expands into millions of occurrences (Oct 25 2026 red team). Before the fix:
 * FREQ=SECONDLY took the native calendar 26 s to draw (3.6 million occurrences in a month, then out of
 * memory on the Month view), FREQ=DAILY;COUNT=10000000 never drew the classic one, and INTERVAL=0
 * hung its Agenda. Anyone with an edit link could save one, and the calendar froze for every editor.
 *
 *   1. The server refuses such a rule on create and on save, with the size-limit refusal.
 *   2. One already stored (legacy, written here through /import, which keeps old rows) loads in both
 *      views within 3 s, drawn once, the other events still show, and it can be deleted.
 * Needs `wrangler dev` on BASE_URL with IMPORT_SECRET=dev-secret; seeds its own calendars.
 */
const { test, expect } = require('@playwright/test');

const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const BOMBS = ['FREQ=SECONDLY', 'FREQ=DAILY;COUNT=10000000', 'FREQ=MINUTELY;BYSECOND=0,1,2,3,4,5,6,7,8,9'];

const day = (d, h) => { const x = new Date(); x.setDate(d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
const ev = (id, title, d, h, extra = {}) => ({ id, title, start: day(d, h), end: day(d, h + 1), type: 1, ...extra });
const newId = (p) => `test-rrbomb-${p}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;

async function seedLegacy(request, rule) {
  const id = newId('legacy');
  const events = [
    ev('bomb', 'Bomb', 12, 9, { recurrencerule: rule }),
    ev('d', 'Dentist', 15, 11, { type: 2 }),
    ev('c', 'Choir', 3, 18, { recurrencerule: 'FREQ=WEEKLY;COUNT=4', type: 3 }),
  ];
  const r = await request.put(`/cal/${id}/import`, { headers: { Authorization: `Bearer ${SECRET}` }, data: { id, title: 'Bomb test', options: {}, events } });
  expect(r.status()).toBe(200);
  return id;
}
const stored = async (request, id) => (await (await request.get(`/cal/${id}`)).json()).calendar.events;

// The Worker allows 10 new calendars a minute per address, shared with the rest of the suite: wait out a 429.
async function create(request, events) {
  for (let i = 0; ; i++) {
    const r = await request.post(`/cal/${newId('create')}`, { data: { title: 'x', options: {}, events } });
    if (r.status() !== 429 || i === 2) return r;
    await new Promise((res) => setTimeout(res, 31_000));
  }
}

test('the server refuses a bomb rule on create; a real repeating event is accepted', async ({ request }) => {
  test.setTimeout(240_000);
  for (const rule of ['FREQ=SECONDLY', 'FREQ=DAILY;COUNT=10000000']) {
    const r = await create(request, [ev('b', 'Bomb', 12, 9, { recurrencerule: rule })]);
    expect(r.status(), rule).toBe(413);
    expect((await r.json()).error).toMatch(/second|5000/);
  }
  const ok = await create(request, [ev('w', 'Choir', 3, 18, { recurrencerule: 'FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20991231T000000Z' })]);
  expect(ok.status()).toBe(201);
});

test('the server refuses a bomb rule on save (WebSocket), added or changed; a real repeating event saves', async ({ page, request }) => {
  const id = await seedLegacy(request, 'FREQ=WEEKLY;COUNT=2');
  await page.goto('/?backend=cf');
  const replies = await page.evaluate(async ({ id }) => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/cal/${id}/ws`);
    const got = [];
    ws.onmessage = (m) => got.push(JSON.parse(m.data));
    await new Promise((r) => { ws.onopen = r; });
    const at = (h) => { const x = new Date(); x.setHours(h, 0, 0, 0); return x.toISOString(); };
    ws.send(JSON.stringify({ t: 'save', id: 's1', commands: [{ type: 'add', event: { id: 'evil', title: 'x', start: at(9), end: at(10), recurrencerule: 'FREQ=SECONDLY' } }] }));
    ws.send(JSON.stringify({ t: 'save', id: 's2', commands: [{ type: 'add', event: { id: 'fine', title: 'Lunch', start: at(12), end: at(13), recurrencerule: 'FREQ=DAILY;INTERVAL=1;COUNT=5' } }] }));
    const mine = () => got.filter((m) => ['s1', 's2', 's3'].includes(m.id));
    for (let i = 0; i < 50 && mine().length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    // Turning an existing event into a bomb is refused too.
    ws.send(JSON.stringify({ t: 'save', id: 's3', commands: [{ type: 'update', key: { id: 'fine', recurrenceID: null }, changes: { recurrencerule: 'FREQ=SECONDLY' } }] }));
    for (let i = 0; i < 50 && mine().length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    ws.close();
    return mine();
  }, { id });
  const [s1, s2, s3] = ['s1', 's2', 's3'].map((k) => replies.find((m) => m.id === k));
  expect(s1.t).toBe('error');
  expect(JSON.stringify(s1)).toMatch(/repeats every second/);
  expect(s2.t).toBe('ack');
  expect(s3.t).toBe('error');
  expect(JSON.stringify(s3)).toMatch(/repeats every second/);
  const events = await stored(request, id);
  expect(events.map((e) => e.id)).not.toContain('evil');
  expect(events.find((e) => e.id === 'fine').recurrencerule).toBe('FREQ=DAILY;INTERVAL=1;COUNT=5');
});

for (const rule of BOMBS) {
  test(`classic: a stored ${rule} event loads within 3 s, shows once, and can be deleted`, async ({ browser, request }) => {
    const id = await seedLegacy(request, rule);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const warnings = [];
    page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
    await page.goto('/?backend=cf');
    const t0 = Date.now();
    await page.goto(`/${id}`, { waitUntil: 'commit' });
    await expect(page.locator('.e-month-view .e-appointment', { hasText: 'Dentist' })).toBeVisible({ timeout: 3000 });
    expect(Date.now() - t0).toBeLessThan(3000);
    await expect(page.locator('.e-appointment', { hasText: 'Choir' })).toHaveCount(4);
    await expect(page.locator('.e-appointment', { hasText: 'Bomb' })).toHaveCount(1);
    expect(warnings.join('\n')).toMatch(/event bomb: .*shown once, not repeated/);
    // Agenda used to hang on INTERVAL=0-like rules; every view still answers.
    for (const v of ['Week', 'Agenda', 'Year', 'Month']) {
      const a = Date.now();
      await page.getByRole('button', { name: v, exact: true }).first().click();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
      expect(Date.now() - a, v).toBeLessThan(3000);
    }
    // Delete it the way a person would: its popup, the trash icon (no confirm: Undo instead).
    await page.locator('.e-month-view .e-appointment', { hasText: 'Bomb' }).click();
    await page.locator('.e-quick-popup-wrapper .e-header-icon-wrapper .e-delete').click();
    await expect(page.locator('.e-appointment', { hasText: 'Bomb' })).toHaveCount(0);
    await expect.poll(async () => (await stored(request, id)).map((e) => e.id).sort(), { timeout: 10_000 }).toEqual(['c', 'd']);
    await ctx.close();
  });
}

test('native: a stored FREQ=SECONDLY event loads within 3 s, shows once, and can be deleted', async ({ browser, request }) => {
  const id = await seedLegacy(request, 'FREQ=SECONDLY');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  const t0 = Date.now();
  await page.goto(`/beta/${id}`, { waitUntil: 'commit' });
  await expect(page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Dentist' })).toBeVisible({ timeout: 3000 });
  expect(Date.now() - t0).toBeLessThan(3000);
  await expect(page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Choir' })).toHaveCount(4);
  await expect(page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Bomb' })).toHaveCount(1);
  await page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Bomb' }).click();
  await page.getByTestId('popover-delete').click();
  // Drawn once, so deleted as one event: no "this / following / all" question (v1 asks "are you sure").
  await expect(page.getByTestId('scope-all')).toHaveCount(0);
  const sure = page.getByTestId('confirm-delete');
  if (await sure.isVisible({ timeout: 1000 }).catch(() => false)) await sure.click();
  await expect(page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Bomb' })).toHaveCount(0);
  await expect.poll(async () => (await stored(request, id)).map((e) => e.id).sort(), { timeout: 10_000 }).toEqual(['c', 'd']);
  await ctx.close();
});

test('native edit link: a stored FREQ=SECONDLY event shows once, and the event card deletes it as one event', async ({ browser, request }) => {
  const id = await seedLegacy(request, 'FREQ=SECONDLY');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  const page = await ctx.newPage();
  await page.goto(`/${id}?backend=cf&cal=native&view=month`);
  const bomb = page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Bomb' });
  await expect(bomb).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Choir' })).toHaveCount(4);
  // No "this event / all events": it is drawn once, so a change is a change to the one event. A rename is refused by
  // the server (it checks every row a save touches; a legacy bomb is kept only until it is changed), so it stays.
  await bomb.click();
  await expect(page.getByTestId('event-card')).toBeVisible();
  await page.waitForTimeout(250);
  await page.getByTestId('card-title').fill('Bomb renamed');
  await page.getByTestId('card-title').press('Enter');
  await expect(page.getByTestId('scope-all')).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect((await stored(request, id)).find((e) => e.id === 'bomb')).toMatchObject({ title: 'Bomb', recurrencerule: 'FREQ=SECONDLY' });
  // Deleted as the one event.
  if (await page.getByTestId('event-card').count() === 0) {
    await page.locator('.nc-bar, .nc-timed').filter({ hasText: 'Bomb' }).click();
    await expect(page.getByTestId('event-card')).toBeVisible();
    await page.waitForTimeout(250);
  }
  await page.getByTestId('card-delete').click();
  await expect(page.getByTestId('scope-all')).toHaveCount(0);
  await expect.poll(async () => (await stored(request, id)).map((e) => e.id).sort(), { timeout: 10_000 }).toEqual(['c', 'd']);
  await ctx.close();
});
