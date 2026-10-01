// @ts-check
const { test, expect } = require('./fixtures');

// localStorage is untrusted input: written by every build this browser ever ran, by
// extensions, by hand. A corrupt recents list used to throw from RecentCalendars in the
// app's created() hook and blank the app on every load until site data was cleared.
// Each value below did that. Homepage only, so no Firebase data is needed.

async function bootWith(page, key, value) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, v); }, [key, value]);
  await page.goto('/');
  return errors;
}

for (const [key, value] of [
  ['myCalendars', '{bad'],
  ['myCalendars', '"x"'],
  ['recentCalendars', '{"a":1}'],
  ['recentCalendars', '[null]'],
]) {
  test(`app boots with ${key}=${value}`, async ({ page }) => {
    const errors = await bootWith(page, key, value);
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
    expect(errors.filter((e) => /RecentCalendars|JSON|mine|filter/.test(e))).toEqual([]);
    // Repaired, so the next load doesn't have to tolerate it again.
    expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe('[]');
  });
}

test('an old " (View Only)" recents entry links to /view/<slug>', async ({ page }) => {
  await bootWith(page, 'recentCalendars', JSON.stringify([
    { id: 'team-ro', title: 'Team (View Only)', mine: false, lastVisited: new Date().toISOString() },
  ]));
  await page.waitForFunction(() => document.getElementById('app')?._vnode?.component?.proxy?.recentCalendars, null, { timeout: 20_000 });
  const entry = await page.evaluate(() => document.getElementById('app')._vnode.component.proxy.recentCalendars.find((c) => c.id === 'team-ro'));
  expect(entry.kind).toBe('view');
  expect(entry.title).toBe('Team');
});

test('Ctrl/Cmd+E does nothing on a read-only calendar', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.getElementById('app')?._vnode?.component?.proxy?.$refs && document.getElementById('app')._vnode.component.proxy.$refs.quickAddDialog,
    null, { timeout: 20_000 });
  // The /view/ route needs a Firebase lookup to reach this state; set it directly.
  await page.evaluate(() => { document.getElementById('app')._vnode.component.proxy.isReadOnly = true; });
  const before = await page.evaluate(() => document.getElementById('app')._vnode.component.proxy.calendar.events.length);
  await page.locator('body').click();
  await page.keyboard.press('Control+e');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.getElementById('app')._vnode.component.proxy.$refs.quickAddDialog.dialogVisible)).toBe(false);
  // Even if something did emit, the write is refused.
  await page.evaluate(() => document.getElementById('app')._vnode.component.proxy.handleQuickAddEvent({
    subject: 'phantom', startDateTime: new Date().toISOString(),
    endDateTime: new Date(Date.now() + 3600000).toISOString(), isAllDay: false,
  }));
  expect(await page.evaluate(() => document.getElementById('app')._vnode.component.proxy.calendar.events.length)).toBe(before);
});
