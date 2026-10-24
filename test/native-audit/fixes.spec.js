// @ts-check
/**
 * Regression tests for the native renderer audit fixes (native-fixes branch). Same harness and
 * rules as parity.spec.js: LOCAL ONLY (wrangler dev on 127.0.0.1:8900), every external host blocked.
 */
const { test, expect, f, sf, nat, isPhone, tap, shot, serverEvents, byTitle, soon } = require('./harness');

const only = (info, project = 'desktop-en') => test.skip(info.project.name !== project, `${project} only`);
async function fresh(info, tag, events = f.baseEvents(), options = {}) { const id = `fix-${tag}-${info.project.name}`.toLowerCase(); await f.reset(id, events, 'Audit calendar', options); return id; }

/** Delete the whole "Team standup" series from a second (Syncfusion) tab and wait for the server. */
async function deleteSeriesElsewhere(context, id) {
  const other = await context.newPage();
  await other.clock.install({ time: new Date('2026-10-24T12:00:00-04:00') });
  await sf.open(other, id);
  await sf.openPopover(other, 'Team standup');
  await sf.deleteFromPopover(other, 'all');
  await soon(async () => !!(await serverEvents(id)).find((e) => e.id === 'fx-standup')).toBe(false);
  await other.close();
}

// ---------------------------------------------------------------- fix 1: no silent data loss
for (const scope of ['this', 'following', 'all']) {
  test(`fix1: edit "${scope}" occurrence after the series was deleted elsewhere is kept and reported`, async ({ page, context }, info) => {
    only(info);
    const id = await fresh(info, `race-${scope}`);
    await nat.open(page, id);
    await nat.openPopover(page, 'Team standup');
    await nat.editFromPopover(page, scope);
    await nat.setTitle(page, 'My important edit');
    await deleteSeriesElsewhere(context, id);
    await page.bringToFront();
    // the live update has reached this tab: the series is gone from its model
    await expect.poll(() => page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.events.some((e) => e.id === 'fx-standup'))).toBe(false);
    await nat.save(page);
    await soon(async () => !!(await byTitle(id, 'My important edit'))).toBe(true);
    const row = await byTitle(id, 'My important edit');
    expect(row.recurrenceID || null).toBe(null);
    if (scope === 'this') expect(row.recurrencerule || '').toBe('');
    else expect(row.recurrencerule || '').toMatch(/FREQ=WEEKLY/);
    expect(row.id).not.toBe('fx-standup');
    await expect(page.locator('body')).toContainText('deleted elsewhere');
    await shot(page, `fix1-${scope}`, info);
  });
}

// ---------------------------------------------------------------- fix 2: error + usage analytics
/** Record every Analytics.track call (as the sinks would see it, base params included). */
async function recordAnalytics(page) {
  await page.evaluate(() => {
    window.__tracked = [];
    Analytics.track = function (name, params) { window.__tracked.push({ name, ...this.baseParams(), ...params }); };
  });
}
const tracked = (page) => page.evaluate(() => window.__tracked);

test('fix2: uncaught errors and rejections are reported as js_error, tagged renderer=native', async ({ page }, info) => {
  only(info);
  const id = await fresh(info, 'analytics');
  await nat.open(page, id);
  await recordAnalytics(page);
  await page.evaluate(() => { const s = document.createElement('script'); s.textContent = "throw new Error('native-boom')"; document.head.appendChild(s); Promise.reject(new Error('native-reject')); });
  await expect.poll(async () => (await tracked(page)).filter((t) => t.name === 'js_error').map((t) => `${t.kind}:${t.message}:${t.renderer}`).sort())
    .toEqual(['error:native-boom:native', 'unhandledrejection:native-reject:native']);
});

test('fix2: event_added (grid, quick_add) and editor_abandoned fire from native, tagged renderer=native', async ({ page }, info) => {
  only(info);
  const id = await fresh(info, 'analytics2');
  await nat.open(page, id);
  await recordAnalytics(page);
  await nat.quickCreate(page, '2026-10-13', 'Picnic');
  await soon(async () => !!(await byTitle(id, 'Picnic'))).toBe(true);
  await nat.openNewEditor(page, '2026-10-14');
  await tap(page, page.locator('[data-testid="editor-cancel"]'));
  await expect(nat.dialog(page)).toHaveCount(0);
  await nat.openNewEditor(page, '2026-10-15');
  await nat.setTitle(page, 'Saved one');
  await nat.save(page);
  await nat.openQuickAdd(page);
  await page.keyboard.type('Brunch tomorrow 2pm for 1 hour', { delay: 20 });
  await tap(page, page.locator('button[type=submit]:has-text("Create")'));
  await soon(async () => !!(await byTitle(id, 'Brunch'))).toBe(true);
  const t = await tracked(page);
  const names = t.filter((x) => ['event_added', 'editor_abandoned'].includes(x.name)).map((x) => `${x.name}${x.source ? ':' + x.source : ''}`);
  expect(names).toEqual(['event_added:grid', 'editor_abandoned', 'event_added:grid', 'event_added:quick_add']);
  expect(t.every((x) => x.renderer === 'native')).toBe(true);
});

test('fix2: feature_used event_type fires when a color is changed, not on every save of a colored event', async ({ page }, info) => {
  only(info);
  const id = await fresh(info, 'analytics3');
  await nat.open(page, id);
  await recordAnalytics(page);
  await nat.openPopover(page, 'Dentist'); // type 1
  await nat.editFromPopover(page);
  await nat.setTitle(page, 'Dentist visit');
  await nat.save(page);
  await nat.openPopover(page, 'Quarterly planning'); // type 7 already
  await nat.editFromPopover(page);
  await nat.setTitle(page, 'Quarterly planning 2');
  await nat.save(page);
  expect((await tracked(page)).filter((t) => t.feature === 'event_type')).toHaveLength(0);
  await nat.openPopover(page, 'Dentist visit');
  await nat.editFromPopover(page);
  await tap(page, page.locator('[data-testid="editor-color"]').locator('visible=true').first());
  await tap(page, page.locator('[data-testid="editor-color-3"]').locator('visible=true').first());
  await nat.save(page);
  expect((await tracked(page)).filter((t) => t.feature === 'event_type')).toHaveLength(1);
});

// ---------------------------------------------------------------- fix 3: production hygiene
test('fix3: no Play CDN or unpinned unpkg Vue; Vue self-hosted; scripts versioned by a constant; Tailwind styles apply', async ({ page }, info) => {
  test.skip(isPhone(page), 'desktop');
  const id = await fresh(info, 'hygiene');
  const urls = async () => { const seen = []; const h = (r) => seen.push(r.url()); page.on('request', h); await nat.open(page, id); page.off('request', h); return seen; };
  const first = await urls();
  expect(first.filter((u) => /unpkg\.com|cdn\.tailwindcss\.com/.test(u))).toEqual([]);
  expect(first.some((u) => /\/vendor\/vue-3\.5\.44\/vue\.global\.prod\.js/.test(u))).toBe(true);
  const scripts = (list) => list.filter((u) => /\/nativecal\/(components\/|app\.js)/.test(u)).sort();
  expect(scripts(first).length).toBe(7);
  const second = await urls();
  expect(scripts(second)).toEqual(scripts(first)); // same URLs on reload: cacheable, not ?v=Date.now()
  // A Tailwind utility from the prebuilt sheet: the search button's icon wrapper and the
  // "hidden" utility both resolve without a runtime compiler.
  const hiddenWorks = await page.evaluate(() => { const d = document.createElement('div'); d.className = 'hidden'; document.body.appendChild(d); const v = getComputedStyle(d).display; d.remove(); return v; });
  expect(hiddenWorks).toBe('none');
});

// ---------------------------------------------------------------- fix 4: DST
// A 10:00 event on the clock-change day must sit exactly where a 10:00 event sits the day before
// (same week): positions are wall-clock hours, not elapsed time since midnight.
for (const [project, dstDay, before, utcOn, utcBefore] of [
  ['desktop-de', '2026-10-25', '2026-10-24', '2026-10-25T09:00:00.000Z', '2026-10-24T08:00:00.000Z'], // Berlin: CEST -> CET
  ['desktop-en', '2026-11-01', '2026-10-31', '2026-11-01T15:00:00.000Z', '2026-10-31T14:00:00.000Z'], // New York: EDT -> EST
]) {
  test(`fix4: ${project} -- a 10:00 event on the DST day (${dstDay}) lines up with 10:00 the day before, and with the 10 AM row`, async ({ page }, info) => {
    only(info, project);
    const ev = (id, title, start) => ({ id, title, start, end: new Date(new Date(start).getTime() + 3600000).toISOString(), type: 1, isAllDay: false, description: '', repeat: '', recurrencerule: '', recurrenceID: null, recurrenceException: null });
    const id = await fresh(info, 'dst', [ev('dst-on', 'Ten on DST day', utcOn), ev('dst-before', 'Ten day before', utcBefore)]);
    await nat.open(page, id);
    await nat.view(page, 'Week');
    // style.top of an event block in the time grid, or null when its day is not on screen
    const gridTop = (title) => page.evaluate((tt) => { const el = [...document.querySelectorAll('.nc-timed')].find((e) => e.textContent.includes(tt)); return el ? parseFloat(el.style.top) : null; }, title);
    // Nov 1 2026 is a Sunday, so the two days can be in different weeks: read each where it is.
    let onTop = null, prevTop = null;
    for (let i = 0; i < 3 && (onTop === null || prevTop === null); i++) {
      onTop = onTop ?? await gridTop('Ten on DST day'); prevTop = prevTop ?? await gridTop('Ten day before');
      if (onTop === null || prevTop === null) { await nat.next(page); await page.waitForTimeout(300); }
    }
    if (onTop === null) { onTop = await gridTop('Ten on DST day'); }
    // first label of the gutter ("5 AM" / "05:00") is the grid's first hour
    const firstHour = parseInt(await page.locator('.nc-hour-label').first().innerText(), 10) || 0;
    info.annotations.push({ type: 'tops', description: JSON.stringify({ onTop, prevTop, firstHour }) });
    expect(prevTop).toBe((10 - firstHour) * 48);
    expect(onTop).toBe((10 - firstHour) * 48);
    await nat.event(page, 'Ten on DST day').first().scrollIntoViewIfNeeded();
    await shot(page, `fix4-dst-${project}`, info);
  });
}

// ---------------------------------------------------------------- fix 5: links, default view, custom views
const title = async (page) => (await page.locator('[data-testid="current-date-range"]').innerText()).trim();
const onView = (page) => page.locator('.nc-views [aria-selected="true"]').innerText();

test('fix5: ?view=week&date= and ?view=day&date= open that week / day', async ({ page }, info) => {
  only(info);
  const id = await fresh(info, 'url');
  await nat.open(page, id, '?view=week&date=2026-10-29');
  await expect.poll(() => title(page)).toBe('October 25 - 31, 2026');
  await expect(nat.event(page, 'Busy 1').first()).toBeVisible();
  await nat.open(page, id, '?view=day&date=2026-11-03');
  await expect.poll(() => title(page)).toBe('November 3, 2026');
});

test("fix5: the calendar's default view opens for everyone; Auto falls back to the personal default", async ({ page }, info) => {
  only(info);
  const id = await fresh(info, 'defview', f.baseEvents(), { defaultView: 'Week' });
  await nat.open(page, id);
  await expect.poll(() => onView(page)).toMatch(/^week$/i);
  const id2 = await fresh(info, 'defview2', f.baseEvents(), {});
  await page.addInitScript(() => { try { localStorage.setItem('pastecal_global_settings', JSON.stringify({ defaultView: 'Agenda' })); } catch (e) {} });
  await nat.open(page, id2);
  await expect.poll(() => onView(page)).toMatch(/^agenda$/i);
});

test('fix5: custom N-weeks / N-months views from the calendar settings (label, span, next)', async ({ page }, info) => {
  only(info);
  const id = await fresh(info, 'custom', f.baseEvents(), { defaultView: 'Custom', customViewDuration: 2, customViewUnit: 'Weeks' });
  await nat.open(page, id);
  await expect.poll(() => onView(page)).toMatch(/^2 weeks$/i);
  await expect.poll(() => title(page)).toBe('October 18 - October 31, 2026');
  expect(await page.locator('.nc-week-row').count()).toBe(2);
  await nat.next(page);
  await expect.poll(() => title(page)).toBe('November 1 - November 14, 2026');
  const id2 = await fresh(info, 'custom2', f.baseEvents(), { defaultView: 'Custom', customViewDuration: 2, customViewUnit: 'Months' });
  await nat.open(page, id2);
  await expect.poll(() => onView(page)).toMatch(/^2 months$/i);
  await expect.poll(() => title(page)).toBe('October - November 2026');
  await nat.next(page);
  await expect.poll(() => title(page)).toBe('December 2026 - January 2027');
});

module.exports = { only, fresh };
