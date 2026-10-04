// @ts-check
/**
 * The main app on Cloudflare data (?backend=cf), driven like a person: claim a name, add events
 * with +Event, open the link in a second tab, and leave a tab alone. Everything is checked
 * against the Worker (GET /cal/<id>), the only thing that counts, never an app flag.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787).
 */
const { test, expect } = require('@playwright/test');

const VM_SAFE = `document.querySelector('#app')?._vnode?.component?.proxy`;
const onServer = async (page, slug) => (await (await page.request.get(`/cal/${slug}`)).json()).calendar;

async function withFlag(ctx) { await ctx.addInitScript(() => { window.__TEST__ = true; }); }

test('create on Cloudflare, add events, see them in a second tab, and an idle tab sends nothing', async ({ browser }, info) => {
  const slug = `test-cf-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await withFlag(ctx);
  const page = await ctx.newPage();
  const sockets = [];                                     // frames this tab sent on the calendar socket
  page.on('websocket', (ws) => { if (ws.url().includes('/cal/')) ws.on('framesent', (f) => sockets.push(String(f.payload))); });
  const firebaseWrites = [];
  page.on('websocket', (ws) => { if (ws.url().includes('firebaseio')) ws.on('framesent', (f) => { try { const m = JSON.parse(String(f.payload)); if (m.d && (m.d.a === 'p' || m.d.a === 'm')) firebaseWrites.push(m); } catch (e) { /* */ } }); });

  // 1. claim a name the way people do; ?backend=cf switches the backend and is remembered
  await page.goto('/?backend=cf');
  await page.locator('input[placeholder="your-name"]').fill(slug);
  await page.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}`, 'i'), { timeout: 20_000 });
  await page.waitForFunction(`${VM_SAFE}?.isExisting === true`, null, { timeout: 20_000 });
  expect((await onServer(page, slug)).id).toBe(slug);
  expect(await page.evaluate(() => CalendarDataService.name)).toBe('CloudCalendarService');
  await info.attach('backend', { body: 'CloudCalendarService' });

  // 2. +Event, typed, three times
  const names = ['Cloud one', 'Cloud two', 'Cloud three'];
  for (const [i, n] of names.entries()) {
    await page.locator('text=+Event').locator('visible=true').first().click();
    await expect(page.getByText('Add Event by Typing')).toBeVisible();
    await page.keyboard.type(`${n} tomorrow at ${9 + i}:00`, { delay: 25 });
    await page.keyboard.press('Enter');
    await expect(page.getByText('Add Event by Typing')).toHaveCount(0);
    await page.waitForTimeout(300);
  }
  await expect.poll(async () => (await onServer(page, slug)).events.map((e) => e.title).sort(), { timeout: 10_000 }).toEqual([...names, 'Sample event'].sort());   // a new calendar starts with a sample event
  await page.screenshot({ path: 'snapshots/cf-main-app.png' });

  // 3. a second person opens the link: sees them, then adds one; the first tab shows it without a reload
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await withFlag(ctx2);
  const two = await ctx2.newPage();
  await two.goto(`/${slug}?backend=cf`);
  await two.waitForFunction(`${VM_SAFE}?.isExisting === true`, null, { timeout: 20_000 });
  await expect(two.locator('.e-appointment', { hasText: 'Cloud two' }).first()).toBeVisible({ timeout: 15_000 });
  await two.locator('text=+Event').locator('visible=true').first().click();
  await two.keyboard.type('From tab two tomorrow at 15:00', { delay: 25 });
  await two.keyboard.press('Enter');
  // (the month cell folds a 4th event into "+2 more", so read the app's own list, not the grid)
  await expect.poll(() => page.evaluate(`${VM_SAFE}?.calendar.events.map(e => e.title)`), { timeout: 10_000 }).toContain('From tab two');
  await expect.poll(async () => (await onServer(page, slug)).events.length).toBe(5);

  // 4. idle: nothing is sent by either tab for 12 s
  await page.waitForTimeout(3000);
  const n1 = sockets.length;
  await page.waitForTimeout(12000);
  expect(sockets.length - n1, 'frames sent while idle').toBe(0);
  expect(firebaseWrites.length, 'this tab never wrote to Firebase').toBe(0);

  // 5. reload: the data comes back from Cloudflare
  await page.reload();
  await page.waitForFunction(`${VM_SAFE}?.isExisting === true`, null, { timeout: 20_000 });
  await expect(page.locator('.e-appointment', { hasText: 'Cloud one' }).first()).toBeVisible({ timeout: 15_000 });
  await ctx.close(); await ctx2.close();
});

test('the beta (/nativecal) loads a Cloudflare calendar and an idle tab sends nothing', async ({ browser, page }) => {
  const slug = `test-cfbeta-${Date.now()}`;
  const ev = (id, title, h) => ({ id, title, start: new Date(Date.now() + h * 3600e3).toISOString(), end: new Date(Date.now() + (h + 1) * 3600e3).toISOString(), type: 2 });
  const made = await page.request.post(`/cal/${slug}`, { data: { title: 'Beta on CF', options: {}, events: [ev('b1', 'Beta one', 1), ev('b2', 'Beta two', 26)] } });
  expect(made.status()).toBe(201);
  const frames = [];
  page.on('websocket', (ws) => { if (ws.url().includes('/cal/')) ws.on('framesent', (f) => frames.push(String(f.payload))); });
  await page.goto(`/nativecal/${slug}?backend=cf`);
  await expect(page.getByText('Beta one').first()).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => CalendarDataService.name)).toBe('CloudCalendarService');
  await page.screenshot({ path: 'snapshots/cf-beta.png' });
  await page.waitForTimeout(3000);
  const n = frames.length;
  await page.waitForTimeout(8000);
  expect(frames.length - n, 'frames sent while idle').toBe(0);
  expect((await onServer(page, slug)).events.length).toBe(2);
});
