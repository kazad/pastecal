// @ts-check
/**
 * "Start from" templates on the homepage draft (utils/templates.js, app.js applyTemplate), driven like
 * a person: pick one and see its month, switch and only the template's events change, add an event of
 * your own and switching asks first (and keeps it), Save & share under a name of your own, and the
 * Worker has the events, title and notes. Start blank clears; Cmd+Z right after a pick undoes it.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787). Makes one calendar (10/min per IP).
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')?._vnode?.component?.proxy`;

async function open(browser, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600 });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  await ctx.route(/firebaseio|googletagmanager|google-analytics|clarity|hotjar/, (r) => r.abort());
  await ctx.routeWebSocket((url) => !/localhost|127\.0\.0\.1/.test(String(url)), (ws) => ws.close());
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-work-cells'), null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  return { ctx, page };
}

const titles = (page) => page.evaluate(`${VM}.calendar.events.map(e => e.title)`);
const draft = (page) => page.evaluate(`({ title: ${VM}.calendar.title, notes: ${VM}.calendar.options.notes || '', labels: [...(${VM}.calendar.options.typeLabels || [])] })`);
const appt = (page, text) => page.locator('.e-appointment', { hasText: text });

test('pick a template, switch, keep your own event, then Save & share saves it all', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  const row = page.getByTestId('templates');
  await expect(row).toContainText('Start from:');
  await expect(row).toContainText('Blank');

  // 1. a pick fills the month, names the colors, titles the calendar and writes notes
  await page.getByTestId('tpl-team').click();
  await expect(appt(page, 'Practice').first()).toBeVisible();
  await expect(page.getByTestId('tpl-team')).toHaveAttribute('aria-pressed', 'true');
  expect(await titles(page)).not.toContain('Your event here');
  let d = await draft(page);
  expect(d.title).toBe('Tigers U10 Soccer');
  expect(d.notes).toContain('Home field');
  expect(d.labels.slice(0, 2)).toEqual(['Practice', 'Game']);
  await expect(page.getByTestId('tpl-nudge')).toContainText('for a link anyone can open. No login required.');
  await expect(page.getByTestId('grid-tip')).toHaveCount(0);

  // 2. another chip replaces the template's events (nothing of yours yet, so no question)
  await page.getByTestId('tpl-family').click();
  await expect(page.getByTestId('tpl-undo')).toHaveCount(0);            // nothing changed by you: nothing to undo
  await expect(page.locator('.pc-toast')).toHaveCount(0);
  await expect(appt(page, 'Piano: Maya').first()).toBeVisible();
  await expect(appt(page, 'Practice')).toHaveCount(0);
  d = await draft(page);
  expect(d.title).toBe('Our family');
  expect(d.notes).not.toContain('Home field');
  expect(d.labels[0]).toBe('Kids');

  // 3. an event of your own, the way people add one
  await page.getByRole('button', { name: /Add event/ }).locator('visible=true').first().click();
  await page.locator('textarea[aria-label="Event description"]').fill('Bake sale tomorrow at 2pm');
  await page.locator('button[type="submit"]').locator('visible=true').first().click();
  await expect.poll(() => titles(page)).toContain('Bake sale');

  // 3b. edit one of the template's events (the bug: an edited template event used to survive a switch)
  await page.evaluate(() => {
    const vm = document.querySelector('#app')._vnode.component.proxy;
    const ev = vm.calendar.events.find((e) => /^Piano: Maya/.test(e.title || e.Subject));
    vm.store().dispatch({ type: 'update', key: EventStore.keyOf(ev), changes: { title: 'Piano: Maya (moved)' } });
  });
  await expect.poll(() => titles(page)).toContain('Piano: Maya (moved)');

  // 4. switching never asks: it swaps the template's events at once, yours stay, and the toast's Undo
  //    puts the last template back exactly
  await page.getByTestId('tpl-team').click();
  await expect(appt(page, 'Practice').first()).toBeVisible();
  let now = await titles(page);
  expect(now).toContain('Bake sale');
  expect(now).not.toContain('Piano: Maya');
  expect(now).not.toContain('Piano: Maya (moved)');               // edited template events go too
  expect((await draft(page)).title).toBe('Tigers U10 Soccer');
  await page.getByTestId('tpl-undo').click();                          // edits were replaced, so Undo is offered
  await expect(appt(page, 'Piano: Maya (moved)').first()).toBeVisible();   // Undo brings back the edit
  now = await titles(page);
  expect(now).toContain('Bake sale');
  expect(now.filter((t) => t === 'Practice')).toEqual([]);
  // ...and again, so the rest of the test continues from Sports team
  await page.getByTestId('tpl-team').click();
  await expect(appt(page, 'Practice').first()).toBeVisible();

  // 5. Save & share from the nudge: the name is the visitor's, never one made from the template
  await page.getByTestId('share-new').click();
  const input = page.getByLabel('Claim custom URL');
  await expect(input).toBeVisible();
  expect(await input.inputValue()).not.toMatch(/tigers|practice/i);
  const slug = `test-tpl-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  await input.fill(slug);
  await page.locator('.pc-modal .pc-btn--primary').click();
  await expect(page).toHaveURL(new RegExp(`/${slug}`, 'i'), { timeout: 20_000 });
  const saved = (await (await page.request.get(`/cal/${slug}`)).json()).calendar;
  const savedTitles = saved.events.map((e) => e.title);
  expect(savedTitles).toContain('Bake sale');
  expect(savedTitles.filter((t) => t === 'Practice').length).toBeGreaterThan(5);
  expect(savedTitles.some((t) => /^Game (vs|at) /.test(t))).toBe(true);
  expect(savedTitles).not.toContain('Piano: Maya');
  expect(savedTitles).not.toContain('Your event here');
  expect(saved.events.filter((e) => /^tpl-/.test(String(e.id)))).toEqual([]);   // ids of their own, so iCal UIDs never collide
  expect(saved.title).toBe('Tigers U10 Soccer');
  expect(saved.options.notes).toContain('Rainouts decided by 7am');
  expect(saved.options.typeLabels[0]).toBe('Practice');
  // the saved calendar has no template row; the next draft starts fresh
  await page.waitForFunction(`${VM}?.isExisting === true`, null, { timeout: 20_000 });
  await expect(page.getByTestId('templates')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pastecal_template'))).toBeNull();
  await ctx.close();
});

test('Start blank clears the template; Cmd+Z undoes a pick and a switch', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  const isTpl = (t) => /^(Meeting|Start:|Read |Author|Shift|Open shift|Practice|Game|Swim|Piano)/.test(t);

  // Start blank: back to a fresh draft, example event and all
  await page.getByTestId('tpl-club').click();
  await expect(appt(page, 'Meeting').first()).toBeVisible();
  await page.getByTestId('tpl-blank').click();
  await expect.poll(async () => (await titles(page)).filter(isTpl)).toEqual([]);
  expect(await titles(page)).toEqual(['Your event here']);
  expect(await draft(page)).toMatchObject({ title: 'New Calendar', notes: '' });
  await expect(page.getByTestId('tpl-nudge')).toHaveCount(0);
  await expect(page.getByTestId('templates')).toContainText('Blank');

  // Cmd+Z right after a pick undoes it, title and notes included
  await page.getByTestId('tpl-shifts').click();
  await expect(appt(page, 'Open shift').first()).toBeVisible();
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await titles(page)).filter(isTpl)).toEqual([]);
  expect(await titles(page)).toEqual(['Your event here']);
  expect(await draft(page)).toMatchObject({ title: 'New Calendar', notes: '' });
  await expect(page.getByTestId('tpl-shifts')).toHaveAttribute('aria-pressed', 'false');

  // and after a switch, puts the template before it back
  await page.getByTestId('tpl-team').click();
  await page.getByTestId('tpl-family').click();
  await expect(appt(page, 'Piano: Maya').first()).toBeVisible();
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect(appt(page, 'Practice').first()).toBeVisible();
  expect(await titles(page)).not.toContain('Piano: Maya');
  expect((await draft(page)).title).toBe('Tigers U10 Soccer');
  await expect(page.getByTestId('tpl-team')).toHaveAttribute('aria-pressed', 'true');

  // a reload keeps the draft and knows its events are still the template's
  await page.reload();
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-work-cells'), null, { timeout: 20_000 });
  await expect(page.getByTestId('tpl-team')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tpl-out').click();
  await expect(appt(page, 'Sam: WFH').first()).toBeVisible();
  await ctx.close();
});

test('phone: the chips scroll sideways in one row under the header', async ({ browser }) => {
  const { ctx, page } = await open(browser, { width: 390, height: 844 });
  const row = page.locator('.pc-tpl-row');
  const box = await row.boundingBox();
  expect(box.height).toBeLessThan(44);                                   // one row, no wrapping
  expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);   // no page scroll sideways
  const header = await page.getByTestId('share-new-mobile').boundingBox();
  expect(box.y).toBeGreaterThan(header.y + header.height);
  await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.getByTestId('tpl-club').click();
  await expect.poll(() => titles(page)).toContain('Meeting: ch. 1-12');
  await expect(page.getByTestId('tpl-nudge')).toBeVisible();
  await ctx.close();
});
