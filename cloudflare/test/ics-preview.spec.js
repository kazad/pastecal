// @ts-check
/**
 * The import preview (Oct 28 2026). The owner: "Can we have a preview for the import -- some way to see what is coming
 * in? A good preview dialog?" One dialog for all three ways in (Settings' Import .ics, quick add's link, a dropped file):
 * Import "<file>", then New (date | time | title, as the Agenda, with "weekly" by the repeat mark), Changes (field by field
 * in words), Already in this calendar (folded: Show), Not imported (folded, with why), and Import N events / Cancel; with
 * nothing new, one line that says so and one Done. Checked in classic and ?cal=native against what the SERVER stored
 * (GET /cal/<id>), not the screen:
 *   P1  a file with all four kinds lists exactly them, and Import stores exactly the listed adds and changes
 *   P2  Cancel and Escape save nothing; focus starts on Import and Tab stays in the dialog
 *   P3  Settings, quick add and a drop open the same dialog with the same lists
 *   P4  1,000 events: the first 200 and "and 800 more", the list scrolls inside, Import stays in view, it stays quick
 *   P5  phone widths (390, 360) without sideways scrolling, light and dark; screenshots (desktop and phone, light and dark)
 *   P6  nothing new (the same file again): "Nothing new: all 4 events in this file are already in this calendar.", Show
 *       them, one Done and no Cancel, nothing saved
 * The parser, the plan's reasons and the change words in detail: test/unit/ics-import.test.js. Duplicates: ics-entry.spec.js.
 * Screenshots: cloudflare/test-results/ics-preview/. Run with scripts/test-on-box.sh ics-preview.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'test-results', 'ics-preview');
fs.mkdirSync(OUT, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const LABELS = ['Practice', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];
const TZ = 'America/Los_Angeles';
// The dates below are in 2026; "now" is fixed there so no row names its year.
const NOW = new Date('2026-10-28T12:00:00-07:00');

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (uid, summary, start, end, extra = []) => ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
  `DTSTART;TZID=${TZ}:${start}`, `DTEND;TZID=${TZ}:${end}`, ...extra, 'END:VEVENT'];
const write = (name, text) => { const f = path.join(OUT, name); fs.writeFileSync(f, text); return f; };

// What is here first: four events.
const TEAM = write('team.ics', ics(
  vevent('p@x', 'Practice', '20261006T170000', '20261006T183000'),
  vevent('g@x', 'Game', '20261010T100000', '20261010T113000'),
  vevent('d@x', 'Dentist', '20261015T090000', '20261015T100000'),
  vevent('pa@x', 'Team party', '20261024T160000', '20261024T190000', ['DESCRIPTION:Bring snacks'])));
// Then the season's file: all four kinds. Practice moved half an hour, Game renamed, the party's notes changed (Changes);
// Dentist as it is (Already here); Swim every Monday and a three-day trip (New); one with no date, one canceled (Not imported).
const FALL = write('tigers-fall.ics', ics(
  vevent('p@x', 'Practice', '20261006T173000', '20261006T190000'),
  vevent('g@x', 'Game vs Hawks', '20261010T100000', '20261010T113000'),
  vevent('d@x', 'Dentist', '20261015T090000', '20261015T100000'),
  vevent('pa@x', 'Team party', '20261024T160000', '20261024T190000', ['DESCRIPTION:Bring snacks and cups']),
  vevent('s@x', 'Swim', '20261005T160000', '20261005T170000', ['RRULE:FREQ=WEEKLY;BYDAY=MO']),
  ['BEGIN:VEVENT', 'UID:t@x', 'SUMMARY:Trip to the coast', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261104', 'END:VEVENT'],
  ['BEGIN:VEVENT', 'UID:n@x', 'SUMMARY:Sometime', 'END:VEVENT'],
  vevent('c@x', 'Rained out', '20261012T170000', '20261012T180000', ['STATUS:CANCELLED'])));
// Each row as its cells: date | time | title | repeat or what changed or why.
const LISTS = {
  add: ['Mon, Oct 5 | 4:00 PM | Swim | weekly', 'Sun, Nov 1 – Tue, Nov 3 | All day | Trip to the coast'],
  change: ['Tue, Oct 6 | 5:00 PM | Practice | time 5:00 → 5:30 PM', 'Sat, Oct 10 | 10:00 AM | Game | title “Game” → “Game vs Hawks”',
    'Sat, Oct 24 | 4:00 PM | Team party | notes changed'],
  here: ['Thu, Oct 15 | 9:00 AM | Dentist'],
  skipped: ['Sometime | no date', 'Rained out | canceled'],
};

let n = 0;
async function seed(events = [], title = 'Preview test') {
  const id = `icsp-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, options: { typeLabels: LABELS, tz: TZ }, events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const byKey = (events) => [...events].sort((a, b) => `${a.id}|${a.recurrenceID}`.localeCompare(`${b.id}|${b.recurrenceID}`));
const FIELDS = ['id', 'title', 'description', 'start', 'end', 'isAllDay', 'type', 'recurrencerule', 'recurrenceID', 'recurrenceException', 'tz'];
const pick = (e) => Object.fromEntries(FIELDS.map((f) => [f, e[f] ?? null]));
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100] });

async function open(browser, id, { native = false, colorScheme = 'light', size = { width: 1280, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport: size, timezoneId: TZ, locale: 'en-US', colorScheme, hasTouch: size.width < 600 });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${id}?backend=cf${native ? '&cal=native' : ''}&view=month&date=2026-10-01`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  await expect(page.locator(native ? '.nc.nc-editable' : '.e-schedule .e-work-cells').first()).toBeVisible({ timeout: 20_000 });
  return { ctx, page, errors, native };
}
const calendarEl = (native) => (native ? '.nc.nc-editable' : '#Schedule');

/** The three ways in. */
async function drop(page, native, file) {
  const content = fs.readFileSync(file, 'utf8');
  await page.evaluate(({ content, name, sel }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type: 'text/calendar' }));
    const el = document.querySelector(sel);
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { content, name: path.basename(file), sel: calendarEl(native) });
}
async function viaQuickAdd(page, file) {
  await page.getByTestId('desktop-add-event-button').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('qa-import').click()]);
  await chooser.setFiles(file);
}
async function viaSettings(page, file) {
  if (!(await page.getByTestId('settings-backup').isVisible().catch(() => false))) await page.getByTestId('settings-button-desktop').click();
  await expect(page.getByTestId('settings-backup')).toBeVisible();
  await page.getByTestId('ics-file').setInputFiles(file);
}
async function preview(t, how, file) {
  if (how === 'settings') await viaSettings(t.page, file);
  else if (how === 'quickadd') await viaQuickAdd(t.page, file);
  else if (how === 'picker') await t.page.getByTestId('ics-file-any').setInputFiles(file);   // quick add's own file input
  else await drop(t.page, t.native, file);
  const dialog = t.page.getByTestId('ics-dialog');
  // (15 s, as ics-entry: a classic calendar on a fully loaded test box has taken over 5 s to show the plan.)
  await expect(dialog.locator('[data-testid="ics-confirm"], [data-testid="ics-plan"]').first()).toBeVisible({ timeout: 15_000 });
  return dialog;
}
const rows = (dialog, section) => dialog.getByTestId(section).getByTestId('ics-row');
/** A section's rows as the person reads them: their cells, ' | ' between. */
const cells = (dialog, section) => rows(dialog, section).evaluateAll((lis) => lis.map((li) =>
  ['.pc-imp-date', '.pc-imp-time', '.pc-imp-text', '.pc-imp-rep', '.pc-imp-what'].map((c) => li.querySelector(c)?.textContent.trim() || '').filter(Boolean).join(' | ')));
const head = (dialog, section) => dialog.getByTestId(section).locator('.pc-imp-head');

/** What the store would hold after the plan's own commands (EventStore.apply), from the rows here now. */
const planned = (page) => page.evaluate(() => {
  const p = document.querySelector('#app')._vnode.component.proxy;
  const now = JSON.parse(JSON.stringify(p.calendar.events));
  return EventStore.apply(now, { type: 'batch', commands: p.icsPlan.commands }).events;
});

async function importTeam(t, how = 'drop') {
  const id = t.id;
  const dialog = await preview(t, how, TEAM);
  await expect(dialog.getByTestId('ics-confirm')).toHaveText('Import 4 events');
  await dialog.getByTestId('ics-confirm').click();
  await dialog.getByTestId('ics-done').click();
  await soon(async () => (await stored(id)).length).toBe(4);
}

for (const native of [false, true]) {
  const where = native ? 'native' : 'classic';

  test(`P1 ${where}: a file with all four kinds: the preview lists exactly them, and Import stores exactly the listed adds and changes`, async ({ browser }) => {
    const id = await seed();
    const t = { ...(await open(browser, id, { native })), id };
    await importTeam(t);
    const before = byKey(await stored(id));

    const dialog = await preview(t, 'drop', FALL);
    await expect(dialog.locator('#ics-dialog-title')).toHaveText('Import “tigers-fall.ics”');
    await expect(dialog.getByTestId('ics-plan'), 'the lists and the button say it: no summary line').toHaveCount(0);
    await expect(head(dialog, 'ics-new')).toHaveText('New · 2');
    expect(await cells(dialog, 'ics-new')).toEqual(LISTS.add);
    // The repeat mark: on Swim, nowhere else.
    await expect(dialog.getByTestId('ics-new').getByTestId('ics-repeat')).toHaveCount(1);
    await expect(rows(dialog, 'ics-new').first().getByTestId('ics-repeat').locator('svg')).toHaveCount(1);
    await expect(head(dialog, 'ics-changes')).toHaveText('Changes · 3');
    expect(await cells(dialog, 'ics-changes')).toEqual(LISTS.change);
    // Already in this calendar, and Not imported: one folded line each, opened with Show.
    await expect(head(dialog, 'ics-here')).toHaveText('Already in this calendar · 1 Show');
    await expect(rows(dialog, 'ics-here')).toHaveCount(0);
    await dialog.getByTestId('ics-here-toggle').click();
    await expect(dialog.getByTestId('ics-here-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.getByTestId('ics-here-toggle')).toHaveText('Hide');
    expect(await cells(dialog, 'ics-here')).toEqual(LISTS.here);
    await expect(head(dialog, 'ics-skipped')).toHaveText('Not imported · 2 Show');
    await expect(rows(dialog, 'ics-skipped')).toHaveCount(0);
    await dialog.getByTestId('ics-skipped-toggle').click();
    expect(await cells(dialog, 'ics-skipped')).toEqual(LISTS.skipped);
    await expect(dialog.getByTestId('ics-confirm')).toHaveText('Import 2, update 3');
    await expect(dialog).not.toContainText(/\bhere\b/);
    expect(byKey(await stored(id)).map(pick), 'nothing saved before Import').toEqual(before.map(pick));
    if (!native) await dialog.screenshot({ path: path.join(OUT, 'p1-dialog-light.png') });

    // Import: the server holds exactly what the plan's commands make of what was here, and that is what was listed.
    const want = byKey(await planned(t.page)).map(pick);
    await dialog.getByTestId('ics-confirm').click();
    await expect(dialog.getByTestId('ics-note')).toHaveText(/^Added 2 events, updated 3\./);
    await soon(async () => byKey(await stored(id)).map(pick)).toEqual(want);
    const after = await stored(id);
    const find = (title) => after.find((e) => e.title === title);
    expect(after.map((e) => e.title).sort()).toEqual(['Dentist', 'Game vs Hawks', 'Practice', 'Swim', 'Team party', 'Trip to the coast']);
    expect(find('Practice')).toMatchObject({ start: '2026-10-07T00:30:00.000Z', end: '2026-10-07T02:00:00.000Z' });
    expect(find('Team party').description).toBe('Bring snacks and cups');
    expect(find('Swim').recurrencerule).toMatch(/FREQ=WEEKLY/);
    expect(find('Trip to the coast')).toMatchObject({ isAllDay: true });
    const dentist = before.find((e) => e.title === 'Dentist');
    expect(pick(find('Dentist')), 'already here: untouched').toEqual(pick(dentist));
    expect(t.errors).toEqual([]);
    await t.ctx.close();
  });

  test(`P2 ${where}: Cancel and Escape save nothing; focus starts on Import and Tab stays in the dialog`, async ({ browser }) => {
    const id = await seed();
    const t = { ...(await open(browser, id, { native })), id };
    await importTeam(t);
    const before = byKey(await stored(id)).map(pick);

    let dialog = await preview(t, 'drop', FALL);
    await expect(dialog.getByTestId('ics-confirm')).toBeFocused();
    // Tab and Shift+Tab go round the dialog's own buttons, never to the page behind.
    for (let i = 0; i < 6; i++) {
      await t.page.keyboard.press('Tab');
      expect(await t.page.evaluate(() => !!document.activeElement?.closest('[data-testid="ics-dialog"]')), `Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await t.page.keyboard.press('Shift+Tab');
      expect(await t.page.evaluate(() => !!document.activeElement?.closest('[data-testid="ics-dialog"]')), `Shift+Tab ${i + 1}`).toBe(true);
    }
    await dialog.getByTestId('ics-cancel').click();
    await expect(dialog).toHaveCount(0);
    await t.page.waitForTimeout(800);
    expect(byKey(await stored(id)).map(pick)).toEqual(before);

    dialog = await preview(t, 'drop', FALL);
    await t.page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await t.page.waitForTimeout(800);
    expect(byKey(await stored(id)).map(pick)).toEqual(before);
    // Enter on the focused Import imports (the primary button is the keyboard's first stop).
    dialog = await preview(t, 'drop', FALL);
    await t.page.keyboard.press('Enter');
    await expect(dialog.getByTestId('ics-note')).toHaveText(/^Added 2 events/);
    await soon(async () => (await stored(id)).length).toBe(6);
    expect(t.errors).toEqual([]);
    await t.ctx.close();
  });

  test(`P3 ${where}: Settings, quick add and a drop open the same dialog with the same lists`, async ({ browser }) => {
    const id = await seed();
    const t = { ...(await open(browser, id, { native })), id };
    await importTeam(t);
    const seen = {};
    for (const how of ['settings', 'quickadd', 'drop']) {
      const dialog = await preview(t, how, FALL);
      await dialog.getByTestId('ics-here-toggle').click();
      await dialog.getByTestId('ics-skipped-toggle').click();
      expect(await cells(dialog, 'ics-here')).toEqual(LISTS.here);
      seen[how] = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
      await dialog.getByTestId('ics-cancel').click();
      await expect(dialog).toHaveCount(0);
      if (how === 'settings') await t.page.getByTestId('side-close').click();
    }
    expect(seen.settings).toContain('Import “tigers-fall.ics”');
    expect(seen.settings).toContain('time 5:00 → 5:30 PM');
    expect(seen.quickadd).toBe(seen.settings);
    expect(seen.drop).toBe(seen.settings);
    expect((await stored(id)).length).toBe(4);
    await t.ctx.close();
  });
}

test('P4 1,000 events: the first 200 and "and 800 more", the list scrolls inside, Import stays in view, it stays quick', async ({ browser }) => {
  test.setTimeout(120_000);
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    const d = String(1 + (i % 28)).padStart(2, '0'), h = String(8 + (i % 10)).padStart(2, '0');
    lines.push(...vevent(`shift-${i}@x`, `Shift ${i}`, `202611${d}T${h}0000`, `202611${d}T${h}3000`));
  }
  const file = write('thousand.ics', ics(lines));
  const id = await seed();
  const t = { ...(await open(browser, id)), id };
  const t0 = Date.now();
  const dialog = await preview(t, 'drop', file);
  const shown = Date.now() - t0;
  await expect(head(dialog, 'ics-new')).toHaveText('New · 1000');
  await expect(rows(dialog, 'ics-new')).toHaveCount(200);
  expect((await cells(dialog, 'ics-new'))[0]).toBe('Sun, Nov 1 | 8:00 AM | Shift 0');
  await expect(dialog.locator('.pc-imp-more')).toHaveText('and 800 more');
  await expect(dialog.getByTestId('ics-confirm')).toHaveText('Import 1000 events');
  const inView = async () => {
    const box = await dialog.getByTestId('ics-confirm').boundingBox();
    return !!box && box.y >= 0 && box.y + box.height <= 860;
  };
  expect(await inView(), 'Import is in view with 1,000 rows').toBe(true);
  // The list scrolls inside the dialog (the page behind does not), and Import stays put.
  const list = dialog.getByTestId('ics-lists');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
  await list.hover();
  await t.page.mouse.wheel(0, 4000);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  expect(await t.page.evaluate(() => window.scrollY)).toBe(0);
  expect(await inView()).toBe(true);
  // Responsive: a click is answered at once (the lists are made once, not on every render).
  const c0 = Date.now();
  await dialog.getByTestId('ics-cancel').click();
  await expect(dialog).toHaveCount(0);
  const closed = Date.now() - c0;
  console.log(`ICS-PREVIEW 1000 rows: shown in ${shown} ms, closed in ${closed} ms`);
  expect(closed).toBeLessThan(2000);
  expect((await stored(id)).length).toBe(0);
  expect(t.errors).toEqual([]);
  await t.ctx.close();
});

test('P5 phone widths (390, 360) without sideways scrolling, light and dark; desktop light and dark', async ({ browser }) => {
  const id = await seed();
  for (const [name, size, colorScheme] of [['desktop-light', { width: 1280, height: 860 }, 'light'], ['desktop-dark', { width: 1280, height: 860 }, 'dark'],
    ['phone-390-light', { width: 390, height: 844 }, 'light'], ['phone-390-dark', { width: 390, height: 844 }, 'dark'],
    ['phone-360-light', { width: 360, height: 740 }, 'light'], ['phone-360-dark', { width: 360, height: 740 }, 'dark']]) {
    const t = { ...(await open(browser, id, { colorScheme, size })), id };
    if (!(await stored(id)).length) await importTeam(t, 'picker');
    const dialog = await preview(t, 'picker', FALL);
    await dialog.getByTestId('ics-here-toggle').click();
    await dialog.getByTestId('ics-skipped-toggle').click();
    expect(await cells(dialog, 'ics-here')).toEqual(LISTS.here);
    expect(await cells(dialog, 'ics-changes')).toEqual(LISTS.change);
    const m = await t.page.evaluate(() => {
      const d = document.querySelector('[data-testid="ics-dialog"]'), l = d.querySelector('[data-testid="ics-lists"]');
      return { page: document.documentElement.scrollWidth - innerWidth, dialog: d.scrollWidth - d.clientWidth, list: l.scrollWidth - l.clientWidth,
        right: d.getBoundingClientRect().right - innerWidth, left: d.getBoundingClientRect().left };
    });
    expect(m, `${name}: nothing wider than the screen`).toEqual({ page: 0, dialog: 0, list: 0, right: expect.any(Number), left: expect.any(Number) });
    expect(m.right, name).toBeLessThanOrEqual(0);
    expect(m.left, name).toBeGreaterThanOrEqual(0);
    const box = await dialog.getByTestId('ics-confirm').boundingBox();
    expect(box && box.y + box.height <= size.height, `${name}: Import in view`).toBe(true);
    await t.page.screenshot({ path: path.join(OUT, `${name}.png`) });
    expect(t.errors).toEqual([]);
    await t.ctx.close();
  }
  expect((await stored(id)).length).toBe(4);   // looked at six times, imported never
});

for (const colorScheme of ['light', 'dark']) {
  test(`P6 nothing new (${colorScheme}): the same file again says so in one line, Show them lists them, one Done and no Cancel, nothing saved`, async ({ browser }) => {
    const id = await seed();
    for (const [name, size] of [['desktop', { width: 1280, height: 860 }], ['phone-390', { width: 390, height: 844 }]]) {
      const t = { ...(await open(browser, id, { colorScheme, size })), id };
      if (!(await stored(id)).length) await importTeam(t, 'picker');
      const before = byKey(await stored(id)).map(pick);
      const dialog = await preview(t, 'picker', TEAM);
      await expect(dialog.locator('#ics-dialog-title')).toHaveText('Import “team.ics”');
      await expect(dialog.getByTestId('ics-plan')).toHaveText('Nothing new: all 4 events in this file are already in this calendar.');
      // One button: Done (focused, so Enter or Escape closes it). No Cancel: there is nothing to cancel.
      await expect(dialog.getByTestId('ics-cancel')).toHaveCount(0);
      await expect(dialog.getByTestId('ics-confirm')).toHaveCount(0);
      await expect(dialog.locator('.pc-small-dialog-actions button')).toHaveText(['Done']);
      await expect(dialog.getByTestId('ics-done')).toBeFocused();
      await expect(dialog.getByTestId('ics-here-toggle')).toHaveText('Show them');
      await expect(rows(dialog, 'ics-here')).toHaveCount(0);
      await t.page.screenshot({ path: path.join(OUT, `nothing-new-${name}-${colorScheme}.png`) });
      await dialog.getByTestId('ics-here-toggle').click();
      await expect(dialog.getByTestId('ics-here-toggle')).toHaveText('Hide them');
      expect(await cells(dialog, 'ics-here')).toEqual(['Tue, Oct 6 | 5:00 PM | Practice', 'Sat, Oct 10 | 10:00 AM | Game',
        'Thu, Oct 15 | 9:00 AM | Dentist', 'Sat, Oct 24 | 4:00 PM | Team party']);
      await expect(dialog).not.toContainText(/\bhere\b/);
      if (name === 'desktop') await t.page.screenshot({ path: path.join(OUT, `nothing-new-shown-${colorScheme}.png`) });
      await dialog.getByTestId('ics-done').click();
      await expect(dialog).toHaveCount(0);
      await t.page.waitForTimeout(800);
      expect(byKey(await stored(id)).map(pick)).toEqual(before);
      expect(t.errors).toEqual([]);
      await t.ctx.close();
    }
  });
}
