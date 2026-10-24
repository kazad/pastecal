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

module.exports = { only, fresh };
