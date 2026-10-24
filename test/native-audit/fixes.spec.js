// @ts-check
/**
 * Regression tests for the native renderer audit fixes (native-fixes branch). Same harness and
 * rules as parity.spec.js: LOCAL ONLY (wrangler dev on 127.0.0.1:8900), every external host blocked.
 */
const { test, expect, f, sf, nat, isPhone, tap, shot, serverEvents, byTitle, soon } = require('./harness');

const only = (info, project = 'desktop-en') => test.skip(info.project.name !== project, `${project} only`);
async function fresh(info, tag, events = f.baseEvents()) { const id = `fix-${tag}-${info.project.name}`.toLowerCase(); await f.reset(id, events); return id; }

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
for (const scope of ['this', 'following']) {
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

module.exports = { only, fresh };
