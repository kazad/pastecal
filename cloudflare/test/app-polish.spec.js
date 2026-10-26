// @ts-check
/**
 * Small app polish, driven like a person:
 *   1. The header's "+ Add event" shows its keyboard shortcut ("⌘E" on a Mac, "Ctrl E" elsewhere);
 *      not on a phone, which has no keyboard shortcut to show.
 *   2. Quick add's Color row shows a calendar's named colors ("Practice") as labeled chips, so you
 *      pick a type, not a hue; unnamed colors stay swatches. The event saves with that type.
 *   3. Quick add's All day is a switch: the parser turns it on for "vacation dec 11 - dec 15", it can
 *      be flipped by hand, and flipping it never changes the dialog's height.
 *   4. The logo menu on the homepage draft has "Start over": a fresh blank draft (events, title,
 *      notes, color names, colors), and one Cmd+Z brings it all back. Saved calendars keep
 *      "New calendar" instead.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787). Seeds one calendar.
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')?._vnode?.component?.proxy`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

async function open(browser, { viewport = DESKTOP, path = '/?backend=cf', platform } = {}) {
  const phone = viewport.width < 600;
  const ctx = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  if (platform) {
    await ctx.addInitScript((p) => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => p, configurable: true });
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true });
    }, platform);
  }
  await ctx.route(/firebaseio|googletagmanager|google-analytics|clarity|hotjar/, (r) => r.abort());
  await ctx.routeWebSocket((url) => !/localhost|127\.0\.0\.1/.test(String(url)), (ws) => ws.close());
  const page = await ctx.newPage();
  if (path !== '/?backend=cf') await page.goto('/?backend=cf');
  await page.goto(path);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-work-cells'), null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  return { ctx, page };
}

const qa = (page) => page.locator('.pc-qa-dialog');
async function openQuickAdd(page) {
  await page.getByTestId('desktop-add-event-button').click();
  await expect(page.locator('textarea[aria-label="Event description"]')).toBeVisible();
}

// ---- 1. The shortcut lives in the tooltip; the button stays plain ----

for (const [platform, want] of [['MacIntel', '⌘E'], ['Win32', 'Ctrl E']]) {
  test(`"+ Add event" names ${want} in its tooltip on ${platform}`, async ({ browser }) => {
    const { ctx, page } = await open(browser, { platform });
    const btn = page.getByTestId('desktop-add-event-button');
    await expect(btn).toHaveAttribute('title', `Add event (${want})`);
    await expect(btn).toHaveText(/^\s*\+\s*Add event\s*$/);
    await page.keyboard.press(platform === 'MacIntel' ? 'Meta+e' : 'Control+e');
    await expect(page.locator('textarea[aria-label="Event description"]')).toBeVisible();
    await ctx.close();
  });
}

// ---- 2. Named colors in quick add ----

for (const viewport of [DESKTOP, PHONE]) {
  test(`quick add offers named colors as labeled chips (${viewport.width}px)`, async ({ browser }) => {
    const { ctx, page } = await open(browser, { viewport });
    await page.evaluate(`${VM}.updateTypeLabel(1, 'Practice'); ${VM}.updateTypeLabel(2, 'Game')`);
    if (viewport.width < 600) await page.getByRole('button', { name: 'Add event' }).first().click();
    else await openQuickAdd(page);
    const group = qa(page).getByRole('radiogroup');
    await expect(group).toHaveAttribute('aria-label', 'Event type');
    await expect(qa(page).getByText('Type', { exact: true })).toBeVisible();
    const practice = qa(page).getByTestId('qa-color-1');
    await expect(practice).toHaveText('Practice');
    await expect(practice).toHaveClass(/pc-qa-type/);
    await expect(qa(page).getByTestId('qa-color-2')).toHaveText('Game');
    // an unnamed color stays a plain swatch, still named for screen readers by its color
    const plain = qa(page).getByTestId('qa-color-3');
    await expect(plain).toHaveText('');
    await expect(plain).not.toHaveClass(/pc-qa-type/);
    expect(await plain.getAttribute('aria-label')).toBeTruthy();
    // nothing pokes past the dialog sideways
    expect(await qa(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    // pick "Game" and the event saves as type 2
    await page.locator('textarea[aria-label="Event description"]').fill('Away match tomorrow 3pm');
    await qa(page).getByTestId('qa-color-2').click();
    await expect(qa(page).getByTestId('qa-color-2')).toHaveAttribute('aria-checked', 'true');
    await expect(practice).toHaveAttribute('aria-checked', 'false');
    await qa(page).locator('button[type="submit"]').click();
    await expect.poll(() => page.evaluate(`(${VM}.calendar.events.find(e => e.title === 'Away match') || {}).type`)).toBe(2);
    await ctx.close();
  });
}

test('quick add with no named colors keeps the plain Color swatches', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  await openQuickAdd(page);
  await expect(qa(page).getByRole('radiogroup')).toHaveAttribute('aria-label', 'Event color');
  await expect(qa(page).locator('.pc-qa-type')).toHaveCount(0);
  await expect(qa(page).getByText('Color', { exact: true })).toBeVisible();
  await ctx.close();
});

test('the full event editor\'s type dropdown shows the names, and "Type N" for unnamed ones', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  await page.evaluate(`${VM}.updateTypeLabel(1, 'Practice')`);
  const types = await page.evaluate(`${VM}.getTypes().map(t => t.text)`);
  expect(types[0]).toBe('Practice');
  expect(types[1]).toBe('Type 2');    // unnamed: "Type 2", not a color name like "Sky" (owner's call, Oct 25 2026)
  await ctx.close();
});

// Red team, Oct 24 2026: category labels are set by anyone with the edit link and the editor's color
// dropdown renders item text as HTML, so a label must show as text and never run.
test('a category label with HTML in it shows as text in the editor\'s color dropdown and never runs', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  const evil = '<img src=x onerror="window.__xss=1">';
  await page.evaluate((l) => document.querySelector('#app')._vnode.component.proxy.updateTypeLabel(1, l), evil);
  await page.evaluate(() => scheduleObj.openEditor({ StartTime: new Date(), EndTime: new Date(Date.now() + 3600e3) }, 'Add'));
  const btn = page.locator('.e-schedule-dialog .e-dropdown-btn').first();
  await expect(btn).toBeVisible();
  await btn.click();
  const item = page.locator('.e-dropdown-popup .e-item').first();
  await expect(item).toContainText('<img');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('.e-dropdown-popup img').count()).toBe(0);
  await ctx.close();
});

// ---- 3. All day ----

for (const viewport of [DESKTOP, PHONE]) {
  test(`quick add: All day is a switch that keeps the dialog's height (${viewport.width}px)`, async ({ browser }) => {
    const { ctx, page } = await open(browser, { viewport });
    if (viewport.width < 600) await page.getByRole('button', { name: 'Add event' }).first().click();
    else await openQuickAdd(page);
    const sw = qa(page).getByTestId('qa-all-day');
    const startTime = qa(page).locator('[aria-label="Start time"]');
    const endTime = qa(page).locator('[aria-label="End time"]');
    await expect(sw).not.toBeChecked();

    // a timed sentence: switch off, times filled
    await page.locator('textarea[aria-label="Event description"]').fill('lunch tomorrow 2pm for 1 hour');
    await expect(startTime).toHaveValue('14:00');
    await expect(sw).not.toBeChecked();
    const timedHeight = (await qa(page).boundingBox()).height;

    // the multi-day example turns it on by itself, End shows the last day
    await page.locator('textarea[aria-label="Event description"]').fill('vacation dec 11 - dec 15');
    await expect(sw).toBeChecked();
    await expect(qa(page).locator('#qa-start-date')).toHaveValue(/-12-11$/);
    await expect(qa(page).locator('#qa-end-date')).toHaveValue(/-12-15$/);
    await expect(startTime).toBeDisabled();
    await expect(startTime).toBeVisible();          // still there, holding its space
    await expect(endTime).toHaveValue('');
    expect((await qa(page).boundingBox()).height).toBe(timedHeight);
    await expect(qa(page).getByText('All day', { exact: true })).toHaveCount(1);   // the switch's own label only

    // off by hand: times come back (9 to 10, there were none), height unchanged
    await qa(page).locator('.pc-qa-switch').click();
    await expect(sw).not.toBeChecked();
    await expect(startTime).toBeEnabled();
    await expect(startTime).toHaveValue('09:00');
    await expect(endTime).toHaveValue('10:00');
    expect((await qa(page).boundingBox()).height).toBe(timedHeight);
    // typing more doesn't override the hand-set switch
    await page.locator('textarea[aria-label="Event description"]').fill('vacation dec 11 - dec 16');
    await expect(sw).not.toBeChecked();
    await expect(qa(page).locator('#qa-end-date')).toHaveValue(/-12-16$/);
    await expect(startTime).toHaveValue('09:00');

    // and back on: saves as an all-day event spanning the days shown
    await qa(page).locator('.pc-qa-switch').click();
    await expect(sw).toBeChecked();
    await qa(page).locator('button[type="submit"]').click();
    const ev = await page.evaluate(`(() => { const e = ${VM}.calendar.events.find(e => e.title === 'vacation'); return e && { allDay: !!e.isAllDay, start: new Date(e.start).getDate(), end: new Date(e.end).getDate() }; })()`);
    expect(ev).toEqual({ allDay: true, start: 11, end: 17 });     // end exclusive: through the 16th
    await ctx.close();
  });
}

test('quick add: turning All day on and off puts typed times back', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  await openQuickAdd(page);
  await page.locator('textarea[aria-label="Event description"]').fill('dentist tomorrow 3pm to 4pm');
  const sw = qa(page).locator('.pc-qa-switch');
  await sw.click();
  await expect(qa(page).locator('[aria-label="Start time"]')).toHaveValue('');
  await sw.click();
  await expect(qa(page).locator('[aria-label="Start time"]')).toHaveValue('15:00');
  await expect(qa(page).locator('[aria-label="End time"]')).toHaveValue('16:00');
  await qa(page).locator('button[type="submit"]').click();
  const ev = await page.evaluate(`(() => { const e = ${VM}.calendar.events.find(e => e.title === 'dentist'); return e && { allDay: !!e.isAllDay, h: new Date(e.start).getHours() }; })()`);
  expect(ev).toEqual({ allDay: false, h: 15 });
  await ctx.close();
});

test('quick add: blanking both times by hand still makes it all day', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  await openQuickAdd(page);
  await page.locator('textarea[aria-label="Event description"]').fill('field trip tomorrow 9am to 3pm');
  await qa(page).locator('[aria-label="Start time"]').fill('');
  await expect(qa(page).getByTestId('qa-all-day')).not.toBeChecked();
  await qa(page).locator('[aria-label="End time"]').fill('');
  await expect(qa(page).getByTestId('qa-all-day')).toBeChecked();
  await qa(page).locator('button[type="submit"]').click();
  await expect.poll(() => page.evaluate(`!!(${VM}.calendar.events.find(e => e.title === 'field trip') || {}).isAllDay`)).toBe(true);
  await ctx.close();
});

// ---- 4. Start over ----

async function openMenu(page, phone) {
  if (phone) await page.locator('[data-testid="mobile-header"] img[alt="pastecal"]').click();
  else await page.locator('button[title="Recent calendars"]').click();
}

for (const viewport of [DESKTOP, PHONE]) {
  test(`draft: Start over clears everything, Undo brings it back (${viewport.width}px)`, async ({ browser }) => {
    const phone = viewport.width < 600;
    const { ctx, page } = await open(browser, { viewport });
    // make the draft the visitor's own: an event, a title, notes, a color name, a custom color
    await page.evaluate(`(() => {
      const vm = ${VM};
      vm.store().dispatch({ type: 'add', event: { id: 'mine1', title: 'My own thing', start: new Date(Date.now() + 864e5).toISOString(), end: new Date(Date.now() + 864e5 + 36e5).toISOString(), type: 2 } });
      vm.calendar.title = 'Book club';
      vm.calendar.options.notes = 'Bring snacks';
      vm.updateTypeLabel(1, 'Practice');
      vm.localSettings.colors[0] = '#123456'; vm.COLORS[0] = '#123456'; vm.storeColorsInCalendarOptions();
      vm.addCategory();
    })()`);
    const state = () => page.evaluate(`(() => { const vm = ${VM}; return {
      titles: vm.calendar.events.map(e => e.title).sort(), title: vm.calendar.title, notes: vm.calendar.options.notes || '',
      label: vm.calendar.options.typeLabels[0], color: vm.calendar.options.colors[0], count: vm.COLORS.length }; })()`);
    const mine = await state();
    expect(mine).toMatchObject({ title: 'Book club', notes: 'Bring snacks', label: 'Practice', color: '#123456', count: 9 });
    expect(mine.titles).toContain('My own thing');

    await openMenu(page, phone);
    const menu = page.locator('.pc-nav').locator('visible=true');
    await expect(menu.getByTestId('nav-new')).toHaveCount(0);
    await expect(menu.getByTestId('nav-start-over')).toBeVisible();
    await expect(menu.getByText('Calendars you open or save show up here')).toBeVisible();
    await menu.getByTestId('nav-start-over').click();

    // a fresh blank draft, the example event and all, in memory and in the saved draft
    await expect.poll(state).toMatchObject({ titles: ['Your event here'], title: 'New Calendar', notes: '', label: 'Type 1', count: 8 });
    expect((await state()).color).not.toBe('#123456');
    await expect(page.locator('.e-appointment', { hasText: 'My own thing' })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const c = JSON.parse(localStorage.getItem('calendar') || '{}');
      return { title: c.title, notes: (c.options || {}).notes || '', events: (c.events || []).map(e => e.title) };
    })).toEqual({ title: 'New Calendar', notes: '', events: ['Your event here'] });
    await expect(page.getByText('Started over with a blank calendar')).toBeVisible();

    // one Cmd+Z: all of it back
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(state).toEqual(mine);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('calendar') || '{}').title)).toBe('Book club');
    await ctx.close();
  });
}

test('saved calendar: the logo menu keeps "New calendar", no Start over', async ({ browser, request }) => {
  const id = `test-polish-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  expect((await request.post(`/cal/${id}`, { data: { title: 'Saved one', options: {}, events: [] } })).status()).toBe(201);
  const { ctx, page } = await open(browser, { path: `/${id}` });
  await openMenu(page, false);
  const menu = page.locator('.pc-nav').locator('visible=true');
  await expect(menu.getByTestId('nav-new')).toBeVisible();
  await expect(menu.getByTestId('nav-start-over')).toHaveCount(0);
  await ctx.close();
});

test('unsaved draft at a typed address: the logo menu offers "New calendar", which goes to the homepage', async ({ browser }) => {
  const id = `test-draft-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const { ctx, page } = await open(browser, { path: `/${id}` });
  await openMenu(page, false);
  const menu = page.locator('.pc-nav').locator('visible=true');
  await expect(menu.getByTestId('nav-start-over')).toHaveCount(0);
  await menu.getByTestId('nav-new').click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await ctx.close();
});

test('homepage panel: a returning visitor sees Your calendars, and Getting started is one tab away', async ({ browser, request }) => {
  const id = `test-hometab-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  expect((await request.post(`/cal/${id}`, { data: { title: 'Tab check', options: {}, events: [] } })).status()).toBe(201);
  const { ctx, page } = await open(browser, { path: `/${id}` });
  await page.goto('/?backend=cf');
  const aside = page.getByTestId('home-aside');
  await expect(aside.getByTestId('home-recents')).toContainText('Tab check');
  await aside.getByTestId('home-tab-guide').click();
  await expect(aside).toContainText('Click a day and type an event.');
  await expect(aside.getByTestId('home-recents')).toHaveCount(0);
  await aside.getByTestId('home-tab-recents').click();
  await expect(aside.getByTestId('home-recents')).toContainText('Tab check');
  await ctx.close();
});

// ---- 5. The header never overlaps itself between 768 and 1000px ----
// At ~800px "+ Add event" ran under the centered calendar title (the left column could shrink to 0).
// Now the left and right columns keep their content width and the title truncates in between.
for (const width of [768, 800, 860, 900, 1000]) {
  test(`header at ${width}px: Add event, the title and the address pill don't overlap`, async ({ browser }) => {
    const { ctx, page } = await open(browser, { viewport: { width, height: 800 } });
    const add = await page.getByTestId('desktop-add-event-button').boundingBox();
    const title = await page.getByTestId('desktop-title-area').boundingBox();
    const right = await page.locator('topbar > section:last-child').boundingBox();
    const sep = (a, b) => a.x + a.width <= b.x + 1;
    expect(sep(add, title), `add ${JSON.stringify(add)} vs title ${JSON.stringify(title)}`).toBe(true);
    expect(sep(title, right), `title ${JSON.stringify(title)} vs right ${JSON.stringify(right)}`).toBe(true);
    expect(title.width).toBeGreaterThan(40);   // the name still shows, truncated if it must
    await expect(page.getByTestId('desktop-add-event-button')).toHaveAccessibleName(/Add event/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await ctx.close();
  });
}

test('homepage panel: a first-time visitor opens on Welcome; Your calendars says it is empty and New calendar starts one', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  const aside = page.getByTestId('home-aside');
  await expect(aside.getByTestId('home-tab-guide')).toHaveAttribute('aria-selected', 'true');
  await expect(aside).toContainText('Click a day and type an event.');
  await aside.getByTestId('home-tab-recents').click();
  await expect(aside.getByTestId('home-recents-empty')).toContainText('No calendars yet.');
  await aside.getByTestId('home-new').click();
  await expect(page.locator('textarea[aria-label="Event description"]')).toBeVisible();
  await ctx.close();
});

// ---- The random name reads as editable: the pencil selects it, and typing replaces it ----
for (const viewport of [DESKTOP, PHONE]) {
  test(`the pencil beside the name selects it, so typing replaces it (${viewport.width}px)`, async ({ browser }) => {
    const { ctx, page } = await open(browser, { viewport });
    const phone = viewport.width < 600;
    const input = page.locator(phone ? '#slug-m' : '#slug');
    const random = await input.inputValue();
    expect(random).toMatch(/^[a-z0-9]{6,}$/);
    await page.getByTestId(phone ? 'slug-pencil-mobile' : 'slug-pencil').click();
    await expect(input).toBeFocused();
    await page.keyboard.type('soccer-fall');
    await expect(input).toHaveValue('soccer-fall');
    // Clicking the name itself does the same (the mouse up must not undo the selection).
    await page.locator('body').click({ position: { x: 5, y: 600 } });
    await input.click();
    await page.keyboard.type('soccer-spring');
    await expect(input).toHaveValue('soccer-spring');
    if (!phone) {   // the box ends where the name does, so the pencil sits right after it
      const box = await input.boundingBox(), pen = await page.getByTestId('slug-pencil').boundingBox();
      expect(pen.x - (box.x + box.width)).toBeLessThan(8);
    }
    await ctx.close();
  });
}

// ---- Search: the box first; the filter lists only colors in use, with counts; Show all undoes it ----
test('search lists only the colors events use, and a hidden one is plainly off', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  await page.evaluate(() => {
    const vm = document.querySelector('#app')._vnode.component.proxy;
    vm.calendar.options.typeLabels = ['Work', 'Fun'];
    const d = new Date();
    const mk = (i, t) => { const s = new Date(d.getFullYear(), d.getMonth(), 3 + i, 10); return { id: 'e' + i, title: 'Event ' + i, start: s.toISOString(), end: new Date(+s + 3600e3).toISOString(), type: t }; };
    vm.calendar.events = [mk(1, 1), mk(2, 1), mk(3, 2), mk(4, 5)];
  });
  await page.getByTestId('search-button-desktop').click();
  const box = page.getByRole('searchbox', { name: 'Search events' });
  const filter = page.getByTestId('color-filter');
  expect((await box.boundingBox()).y).toBeLessThan((await filter.boundingBox()).y);
  const chips = filter.getByRole('switch');
  await expect(chips).toHaveText([/Work\s*2/, /Fun\s*1/, /\s*1$/]);   // three colors used; the unused ones are not listed
  await expect(page.getByTestId('color-filter-reset')).toHaveCount(0);
  // A tap shows only that type, and with no words typed lists every event of it.
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveAttribute('aria-checked', 'true');
  await expect(chips.nth(0)).toHaveAttribute('aria-checked', 'false');
  await expect(chips.nth(0)).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.getByTestId('search-results').getByRole('button')).toHaveCount(1);
  await chips.nth(1).click();   // the same chip again: everything shows
  await expect(chips.nth(0)).toHaveAttribute('aria-checked', 'true');
  await chips.nth(0).click();
  await page.getByTestId('color-filter-reset').click();
  await expect(chips.nth(0)).toHaveAttribute('aria-checked', 'true');
  // A result opens in place with its notes; Edit opens the event's editor.
  await page.evaluate(() => { document.querySelector('#app')._vnode.component.proxy.calendar.events[0].description = 'Bring water.'; });
  await box.fill('Event 1');
  const result = page.getByTestId('search-results').getByRole('button', { name: /Event 1/ });
  await result.click();
  await expect(result).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Bring water.')).toBeVisible();
  await page.getByTestId('search-result-edit').click();
  await expect(page.getByRole('dialog', { name: 'Edit event' })).toBeVisible();
  await ctx.close();
});

// ---- Search lists upcoming events first (soonest at the top), then Past ----
test('search results: upcoming soonest first, then Past, most recent first', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  await page.evaluate(() => {
    const vm = document.querySelector('#app')._vnode.component.proxy;
    const d = new Date();
    const mk = (i, dd) => { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dd, 17); return { id: 'p' + i, title: 'Practice ' + dd, start: s.toISOString(), end: new Date(+s + 3600e3).toISOString(), type: 1 }; };
    vm.calendar.events = [mk(1, -7), mk(2, 9), mk(3, -14), mk(4, 2)];
  });
  await page.getByTestId('search-button-desktop').click();
  await page.getByRole('searchbox', { name: 'Search events' }).fill('practice');
  const titles = page.getByTestId('search-results').locator('.pc-search-result-head > span:first-child');
  await expect(titles).toHaveText(['Practice 2', 'Practice 9', 'Practice -7', 'Practice -14']);
  await expect(page.getByTestId('search-past')).toHaveText(/past/i);
  await ctx.close();
});

// ---- "Your calendars": a calendar you only opened can be removed; one you made cannot ----
test('your calendars: remove one you opened, never one you made', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  await page.evaluate(() => {
    localStorage.setItem('myCalendars', JSON.stringify([{ id: 'made-here', title: 'Made here', lastVisited: new Date().toISOString() }]));
    localStorage.setItem('recentCalendars', JSON.stringify([{ id: 'demo', title: 'Opened once', view: true, lastVisited: new Date().toISOString() }]));
  });
  await page.reload();
  await page.waitForFunction(() => window.__appMounted && document.querySelector('.e-work-cells'), null, { timeout: 20_000 });
  await page.getByTestId('home-tab-recents').click();
  const rows = page.getByTestId('home-recents').locator('li');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('home-recent-remove')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove Opened once from this list' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Made here');
  await ctx.close();
});

// ---- Invited people: "Make one like this" under a calendar you didn't make; "Make a copy" in Settings ----
async function seedWithView(request) {
  const id = `test-own-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const d = new Date(); const at = (day, h) => new Date(d.getFullYear(), d.getMonth(), day, h).toISOString();
  const events = [{ id: 'e1', title: 'Practice', start: at(10, 17), end: at(10, 18), type: 1 }, { id: 'e2', title: 'Game', start: at(14, 9), end: at(14, 10), type: 2 }];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Tigers', options: { typeLabels: ['Practice', 'Game'] }, events } })).status()).toBe(201);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  return { id, viewId: view.publicViewId };
}

test('make one like this: from a view link, a new draft with the same type names and no events', async ({ browser, request }) => {
  const { viewId } = await seedWithView(request);
  const { ctx, page } = await open(browser, { path: `/view/${viewId}?backend=cf` });
  const cta = page.getByTestId('view-footer-cta');
  await expect(cta).toHaveText(/Make one like this/);
  await cta.click();
  await page.waitForURL((u) => u.pathname === '/');
  await page.waitForFunction(() => window.__appMounted && window.scheduleObj, null, { timeout: 20_000 });
  const draft = await page.evaluate(() => { const vm = document.querySelector('#app')._vnode.component.proxy; return { labels: vm.displayTypeLabels.slice(0, 2), titles: vm.calendar.events.map((e) => e.title) }; });
  expect(draft.labels).toEqual(['Practice', 'Game']);
  expect(draft.titles).not.toContain('Practice');
  expect(draft.titles).not.toContain('Game');
  await ctx.close();
});

test('the line shows on an edit link you were sent, not on a calendar you made', async ({ browser, request }) => {
  const { id } = await seedWithView(request);
  const sent = await open(browser, { path: `/${id}?backend=cf` });
  await expect(sent.page.getByTestId('view-footer-cta')).toBeVisible();
  await sent.ctx.close();
  const mine = await open(browser, { path: `/${id}?backend=cf` });
  await mine.page.evaluate((cid) => localStorage.setItem('myCalendars', JSON.stringify([{ id: cid, title: 'Tigers', lastVisited: new Date().toISOString() }])), id);
  await mine.page.reload();
  await mine.page.waitForFunction(() => window.__appMounted && window.scheduleObj, null, { timeout: 20_000 });
  await mine.page.waitForTimeout(800);
  await expect(mine.page.getByTestId('view-footer-cta')).toHaveCount(0);
  await mine.ctx.close();
});

test('make a copy (Settings): a new draft with the same events, named "Copy of …"', async ({ browser, request }) => {
  const { id } = await seedWithView(request);
  const { ctx, page } = await open(browser, { path: `/${id}?backend=cf` });
  await page.getByTestId('settings-button-desktop').click();
  await page.getByTestId('settings-copy-btn').click();
  await page.waitForURL((u) => u.pathname === '/');
  await page.waitForFunction(() => window.__appMounted && window.scheduleObj, null, { timeout: 20_000 });
  const draft = await page.evaluate(() => { const vm = document.querySelector('#app')._vnode.component.proxy; return { title: vm.calendar.title, titles: vm.calendar.events.map((e) => e.title).sort() }; });
  expect(draft.title).toBe('Copy of Tigers');
  expect(draft.titles).toEqual(['Game', 'Practice']);
  await ctx.close();
});
