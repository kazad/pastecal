// @ts-check
/**
 * The side panel, driven like a person: Notes, Share, Activity, Stats and Settings open beside the
 * calendar (never above it), from their header buttons and from the panel's tab row. The
 * calendar keeps its top and narrows; closing gives the width back. A view link with notes
 * opens with them pinned; a phone gets the same panel as a bottom sheet. And what moved
 * must still work: a setting still applies, Share still copies, Activity can still undo.
 * The tabs are the same five in the same order for every editor, draft or saved; on a draft,
 * Share, Activity and Stats say what they will hold. Notes read first and edit on purpose.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787); seeds one calendar and
 * one view link (the Worker allows 10 creates a minute per IP, so the tests share them).
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')?._vnode?.component?.proxy`;
// Nothing leaves this machine but fonts and the pinned script CDNs.
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOTES = 'Home field: Riverside Park, Field 3\nRainouts decided by 7am on game day.';

let shared;
async function seed(request) {
  if (shared) return shared;
  const id = `test-side-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const at = (day, h) => { const d = new Date(); d.setDate(day); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const events = [
    { id: 'e1', title: 'Practice', start: at(7, 17), end: at(7, 18), type: 1 },
    { id: 'e2', title: 'Game vs Hawks', start: at(10, 10), end: at(10, 11), type: 2 },
  ];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Side panel test', options: { notes: NOTES }, events } })).status()).toBe(201);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  expect(view.ok).toBe(true);
  return (shared = { id, viewId: view.publicViewId });
}

async function open(browser, path, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600 });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  await page.goto(path);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  return { ctx, page };
}

const box = async (page) => (await page.locator('#Schedule').boundingBox());
const panel = (page) => page.getByTestId('side-panel');

test('editor: every header button and every tab opens the panel beside the calendar, which narrows and keeps its top', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  const before = await box(page);

  const fromHeader = [
    ['notes', page.locator('.pc-hdr-actions').getByRole('button', { name: 'Toggle notes' })],
    ['changes', page.getByTestId('last-edit-link')],
    ['settings', page.getByTestId('settings-button-desktop')],
    ['share', page.getByTestId('share-pill-more')],
  ];
  for (const [tab, button] of fromHeader) {
    await button.click();
    await expect(panel(page)).toHaveAttribute('data-tab', tab);
    await expect(page.getByTestId(`side-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('side-panel')).toHaveCount(1);   // one panel at a time
    await expect.poll(async () => (await box(page)).width).toBeLessThan(before.width - 250);
    const now = await box(page);
    expect(Math.abs(now.y - before.y), `${tab}: the calendar did not move down`).toBeLessThan(2);
    // Beside it, not above or over it.
    const side = await panel(page).boundingBox();
    expect(side.x).toBeGreaterThanOrEqual(now.x + now.width);
    expect(Math.abs(side.y - now.y)).toBeLessThan(40);
  }

  // The tab row switches without closing.
  for (const tab of ['notes', 'changes', 'settings', 'share']) {
    await page.getByTestId(`side-tab-${tab}`).click();
    await expect(panel(page)).toHaveAttribute('data-tab', tab);
  }
  await expect(panel(page).getByRole('heading', { name: 'Share to view' })).toBeVisible();
  await page.getByTestId('side-tab-notes').click();
  await expect(page.getByTestId('notes-read')).toContainText('Rainouts decided by 7am');   // read first
  await expect(panel(page).getByLabel('Calendar notes')).toHaveCount(0);
  await page.getByTestId('notes-edit').click();
  await expect(panel(page).getByLabel('Calendar notes')).toHaveValue(NOTES);
  await expect(panel(page).getByLabel('Calendar notes')).toBeFocused();

  // Clicking the open tab's header button again closes it; so does the close button.
  await page.getByTestId('settings-button-desktop').click();
  await page.getByTestId('settings-button-desktop').click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByTestId('settings-button-desktop').click();
  await page.getByTestId('side-close').click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => Math.round((await box(page)).width)).toBe(Math.round(before.width));
  // The grid re-laid out at the new width: a chip spans its day again.
  await expect.poll(() => page.evaluate(() => {
    const cell = document.querySelector('.e-month-view .e-work-cells').getBoundingClientRect().width;
    const chip = document.querySelector('.e-month-view .e-appointment').getBoundingClientRect().width;
    return chip >= cell * 0.85;
  })).toBe(true);
  await ctx.close();
});

test('a setting changed in the panel still applies at once', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.getByTestId('settings-button-desktop').click();
  // One page, two sections: "This calendar" then "Only me", and it fits without scrolling.
  await expect(page.getByTestId('settings-calendar')).toContainText('This calendar');
  await expect(page.getByTestId('settings-me')).toContainText('Only me');
  await expect(panel(page).getByLabel('Default view for everyone')).toBeVisible();
  // A calendar that never set one shows Auto, not a blank select.
  expect(await panel(page).getByLabel('Default view for everyone').evaluate((e) => e.options[e.selectedIndex]?.text || '')).toMatch(/^Auto/);
  await expect(panel(page).getByLabel('First day of week')).toBeVisible();
  expect(await page.$eval('.pc-side-body', (b) => b.scrollHeight <= b.clientHeight + 1), 'Settings fits without scrolling').toBe(true);
  await panel(page).getByLabel('First day of week').selectOption('1');   // Monday
  await expect.poll(() => page.evaluate(() => scheduleObj.firstDayOfWeek)).toBe(1);
  await expect(page.locator('.e-month-view .e-header-cells').first()).toContainText('Monday');
  await panel(page).getByLabel('First day of week').selectOption('0');
  await expect.poll(() => page.evaluate(() => scheduleObj.firstDayOfWeek)).toBe(0);
  // A calendar setting still binds to the calendar.
  await panel(page).getByLabel('Default view for everyone').selectOption('Week');
  await expect.poll(() => page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.options.defaultView)).toBe('Week');
  await panel(page).getByLabel('Default view for everyone').selectOption({ index: 0 })   // Auto;
  await expect.poll(() => page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.options.defaultView)).toBe(null);
  await ctx.close();
});

test('Share in the panel still copies its links', async ({ browser, request }) => {
  const { id, viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('share-pill-more').click();
  // Ordered by what people do most: the read-only link first, then calendar apps, then helpers.
  const order = await panel(page).locator('.pc-link-item h4').allTextContents();
  expect(order).toEqual(['Share to view', 'Edit link', 'This view', 'Calendar feed']);
  await expect(page.getByTestId('share-pro-card')).toContainText('Upgrade');
  expect(await page.$eval('.pc-side-body', (b) => b.scrollHeight <= b.clientHeight + 1), 'Share fits without scrolling').toBe(true);
  await expect(page.getByTestId('share-readonly-addr')).toContainText(`pastecal.com/view/${viewId}`);
  await page.getByTestId('share-readonly-addr').click();                    // the field itself copies
  await expect(page.getByTestId('share-readonly-addr')).toHaveClass(/is-copied/);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`/view/${viewId}`);
  // Nothing hidden behind a toggle; the full-access feed is labeled for what it gives.
  await expect(page.getByTestId('share-more-options')).toBeVisible();
  await expect(page.getByTestId('share-editfeed-copy')).toContainText('Edit link .ics');
  await page.getByTestId('share-view-help').click();
  await expect(page.getByTestId('share-view-help-body')).toContainText('view=week');
  await page.getByTestId('share-view-copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`/${id}`);
  await ctx.close();
});

test('view link: notes are pinned beside the calendar, and hiding them sticks', async ({ browser, request }) => {
  const { viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/view/${viewId}?backend=cf`);
  await expect(panel(page)).toHaveAttribute('data-tab', 'notes');
  await expect(page.getByTestId('side-title')).toHaveText('About this calendar');
  await expect(panel(page)).toContainText('Rainouts decided by 7am');
  await expect(panel(page).getByRole('tab')).toHaveCount(0);           // no editing tabs
  await expect(panel(page).getByLabel('Calendar notes')).toHaveCount(0);
  const cal = await box(page); const side = await panel(page).boundingBox();
  expect(side.x).toBeGreaterThanOrEqual(cal.x + cal.width);

  await panel(page).getByRole('button', { name: 'Hide notes' }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  await page.waitForTimeout(800);
  await expect(panel(page)).toHaveCount(0);
  await page.locator('.pc-hdr-actions').getByRole('button', { name: 'Toggle notes' }).click();
  await expect(page.getByTestId('side-title')).toHaveText('About this calendar');
  await ctx.close();
});

test('phone: the panel is a bottom sheet over the calendar, with tabs, closed by its backdrop', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`, { width: 390, height: 844 });
  const before = await box(page);
  await page.getByTestId('share-button-mobile').click();
  await expect(panel(page)).toHaveAttribute('data-tab', 'share');
  // It slides up 24px as it opens; measure once it has come to rest.
  await expect.poll(async () => { const b = await panel(page).boundingBox(); return Math.round(b.y + b.height); }).toBe(844);   // anchored to the bottom
  const sheet = await panel(page).boundingBox();
  expect(sheet.width).toBe(390);
  expect(sheet.height).toBeLessThan(844 * 0.75);                       // the calendar still shows above
  expect(Math.abs((await box(page)).width - before.width)).toBeLessThan(2);   // over it, not beside it
  await page.getByTestId('side-tab-notes').click();
  await page.getByTestId('notes-edit').click();
  await expect(panel(page).getByLabel('Calendar notes')).toBeVisible();
  const row = await page.$eval('.pc-side-tabs', (e) => [e.scrollWidth, e.clientWidth]);
  expect(row[0], 'all five tabs fit a phone').toBeLessThanOrEqual(row[1]);
  await page.getByTestId('side-scrim').click({ position: { x: 195, y: 60 } });
  await expect(panel(page)).toHaveCount(0);
  await ctx.close();
});

const TABS = ['notes', 'share', 'changes', 'stats', 'settings'];
const tabIds = (page) => page.$$eval('[data-testid^="side-tab-"]', (els) => els.map((e) => e.dataset.testid.replace('side-tab-', '')));

test('the same five tabs in the same order, and the row never scrolls', async ({ browser, request }) => {
  const { id } = await seed(request);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }, { width: 1000, height: 800 }]) {
    const { ctx, page } = await open(browser, `/${id}?backend=cf`, viewport);
    await page.getByTestId('settings-button-desktop').click();
    expect(await tabIds(page)).toEqual(TABS);
    await expect(page.getByTestId('side-tab-settings')).toHaveAccessibleName('Settings');   // a gear, named
    const row = await page.$eval('.pc-side-tabs', (e) => [e.scrollWidth, e.clientWidth]);
    expect(row[0], `${viewport.width}px: no hidden tabs`).toBeLessThanOrEqual(row[1]);
    // Stats on a free calendar: two counts side by side (/api/stats), then what Pro adds and one way to get it.
    await page.getByTestId('side-tab-stats').click();
    const views = page.getByTestId('stats-free-views'), followers = page.getByTestId('stats-free-followers');
    await expect(views.locator('.pc-free-num')).toHaveText(/^\d[\d,]*$/);
    await expect(views).toContainText('Views, last 7 days');
    await expect(followers.locator('.pc-free-num')).toHaveText(/^\d[\d,]*$/);
    await expect(followers).toContainText('Calendar-app followers');
    const [v, f] = [await views.boundingBox(), await followers.boundingBox()];
    expect(Math.abs(v.y - f.y), 'tiles side by side').toBeLessThan(2);
    expect(f.x).toBeGreaterThan(v.x + v.width - 1);
    await expect(page.getByTestId('stats-teaser')).toContainText('More with Plus');
    await expect(page.getByTestId('stats-teaser')).toContainText('Beta');
    // Billing on (Stripe configured): Upgrade. Off (a plain local server): Join the beta, and no Upgrade button.
    const { billing } = await (await page.request.get('/api/pro/config')).json();
    if (billing) {
      await expect(page.getByTestId('stats-get-pro')).toHaveText('Upgrade');
      await expect(page.getByTestId('stats-get-pro')).toBeVisible();
    } else {
      await expect(page.getByTestId('stats-teaser').getByTestId('pro-beta-btn')).toHaveText('Join the beta');
      await expect(page.getByTestId('stats-get-pro')).toHaveCount(0);
    }
    await ctx.close();
  }
});

// The Worker answers 503 stats-unavailable when the room isn't counting yet (Insight.js statsPayload;
// e.g. preview reaching production rooms). The tab must not show zeros, nor an error: one muted line.
test('Stats when the calendar is not counted yet: no number tiles, no "0", one muted line', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.route('**/api/stats?*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'stats-unavailable' }) }));
  await page.getByTestId('settings-button-desktop').click();
  await page.getByTestId('side-tab-stats').click();
  const line = page.getByTestId('stats-free-unavailable');
  await expect(line).toHaveText('Stats start counting soon.');
  await expect(line).not.toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('stats-free-views')).toHaveCount(0);
  await expect(page.getByTestId('stats-free-followers')).toHaveCount(0);
  await expect(page.getByTestId('stats-free')).not.toContainText(/\b0\b/);
  await expect(page.getByTestId('stats-teaser')).toContainText('More with Plus');
  await ctx.close();
});

test('draft: Share, Activity and Stats say what they will hold, with one Save & share button', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.goto('/?backend=cf');
  await page.waitForFunction(() => window.scheduleObj, null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  await page.getByTestId('settings-button-desktop').click();
  expect(await tabIds(page)).toEqual(TABS);
  for (const [tab, testid, text] of [['share', 'share-draft', 'once you save it'], ['changes', 'activity-draft', 'once you share it'], ['stats', 'stats-draft', 'Your real numbers start once you share it']]) {
    await page.getByTestId(`side-tab-${tab}`).click();
    await expect(page.getByTestId(testid)).toContainText(text);
    await expect(page.getByTestId(testid).getByRole('button')).toHaveText(['Save & share']);
  }
  await page.getByTestId('side-tab-notes').click();
  await expect(page.getByTestId('notes-empty')).toContainText('No notes yet');
  await page.getByTestId('notes-add').click();
  await expect(panel(page).getByLabel('Calendar notes')).toBeFocused();
  await ctx.close();
});

test('notes: read, Edit, type, Done, and it is saved for everyone', async ({ browser, request }) => {
  const id = `test-notes-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const d = new Date(); d.setDate(12); d.setHours(10, 0, 0, 0);
  const events = [{ id: 'n1', title: 'Meetup', start: d.toISOString(), end: new Date(+d + 3600e3).toISOString(), type: 1 }];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Notes test', options: {}, events } })).status()).toBe(201);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await page.locator('.pc-hdr-actions').getByRole('button', { name: 'Toggle notes' }).click();
  await expect(page.getByTestId('notes-empty')).toContainText('No notes yet. Add where to meet, who to call, what to bring.');
  await page.getByTestId('notes-add').click();
  await panel(page).getByLabel('Calendar notes').fill('Meet at the library. Details: https://example.com/club');
  await page.getByTestId('notes-done').click();
  await expect(page.getByTestId('notes-read').getByRole('link', { name: 'https://example.com/club' })).toBeVisible();
  const notes = async () => (await (await page.request.get(`/cal/${id}`)).json()).calendar.options.notes;
  await expect.poll(notes, { timeout: 10_000 }).toBe('Meet at the library. Details: https://example.com/club');
  await ctx.close();
});

// Last: it changes the shared calendar.
test('Changes in the panel still undoes an edit', async ({ browser, request }) => {
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  const dialog = page.locator('.e-dialog.e-schedule-dialog');
  await page.locator('.e-appointment:has-text("Game vs Hawks")').first().dblclick();
  await dialog.locator('input.e-subject').fill('Game vs Owls');
  await dialog.locator('button.e-event-save').click();
  await expect(dialog).toBeHidden();
  const title = async () => (await (await page.request.get(`/cal/${id}`)).json()).calendar.events.find((e) => e.id === 'e2').title;
  await expect.poll(title, { timeout: 10_000 }).toBe('Game vs Owls');

  await page.getByTestId('last-edit-link').click();
  const changes = page.getByTestId('recent-changes');
  await expect(page.getByTestId('side-tab-changes')).toHaveText('Activity');
  await expect(changes).toBeVisible();
  await changes.getByRole('button', { name: 'Undo this edit' }).first().click();
  await expect.poll(title, { timeout: 10_000 }).toBe('Game vs Hawks');
  await expect(page.locator('.e-appointment:has-text("Game vs Hawks")')).toHaveCount(1);
  await ctx.close();
});

// Every Share field copies when you click its icon, says so in the field, and puts the full link
// on the clipboard. Regression: the field copied but its faint check went unnoticed ("does nothing").
test('Share: each copy field copies, shows Copied, and falls back when the clipboard is refused', async ({ browser, request }) => {
  const { id, viewId } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('share-pill-more').click();
  const fields = [
    ['share-readonly-addr', `/view/${viewId}`],
    ['share-edit-copy', `/${id}`],
    ['share-view-copy', `/${id}?date=`],
    ['share-feed-copy', `/view/${viewId}.ics`],
    ['share-embed-copy', '<iframe'],
  ];
  for (const [testid, expected] of fields) {
    const field = page.getByTestId(testid);
    await field.locator('.pc-link-act').click();                       // the icon, as people click it
    await expect(field).toContainText('Copied to clipboard');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(expected);
    await expect(field).not.toContainText('Copied to clipboard', { timeout: 4000 });   // and goes back
  }
  // Clipboard refused: the older copy path still copies and still says Copied.
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('NotAllowedError')); });
  const field = page.getByTestId('share-readonly-addr');
  await field.click();
  await expect(field).toContainText('Copied to clipboard');
  await ctx.close();
});
