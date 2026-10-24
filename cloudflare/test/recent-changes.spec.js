// @ts-check
/**
 * Recent changes on Cloudflare data, driven like a person: rename an event in the editor,
 * then change its notes. The first edit in a tab is followed by a settings-only write (the
 * option defaults the app fills in on load), which the room used to record as an empty
 * history entry -- listed as "0 events added" between the two edits.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787).
 */
const { test, expect } = require('@playwright/test');

const VM = `document.querySelector('#app')?._vnode?.component?.proxy`;

test('two quick edits of one event list as one row, with no "0 events added"', async ({ browser }) => {
  const slug = `test-cf-recent-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(10, 0, 0, 0);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  const page = await ctx.newPage();
  const made = await page.request.post(`/cal/${slug}`, { data: { title: 'Recent changes', options: {}, events: [
    { id: 'ev1', title: 'Team lunch', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), type: 2 }] } });
  expect(made.status()).toBe(201);

  await page.goto('/?backend=cf');
  await page.goto(`/${slug}?backend=cf`);
  await page.waitForFunction(`${VM}?.isExisting === true`, null, { timeout: 20_000 });

  const dialog = page.locator('.e-dialog.e-schedule-dialog');
  await page.locator('.e-appointment:has-text("Team lunch")').first().dblclick();
  await dialog.locator('input.e-subject').fill('Team lunch v2');
  await dialog.locator('button.e-event-save').click();
  await expect(dialog).toBeHidden();
  await page.locator('.e-appointment:has-text("Team lunch v2")').first().dblclick();
  await dialog.locator('textarea.e-description').fill('bring napkins');
  await dialog.locator('button.e-event-save').click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await (await page.request.get(`/cal/${slug}`)).json()).calendar.events[0].description,
    { timeout: 10_000 }).toBe('bring napkins');

  await page.locator('button[aria-label="Settings"]').click();
  await page.locator('button:has-text("Recent changes")').click();
  const modal = page.locator('.pc-modal');
  await expect(modal.locator('h3:has-text("Recent changes")')).toBeVisible();
  await expect(modal.getByText('Edited "Team lunch v2" 2 times')).toBeVisible();
  await expect(modal.getByText(/\b0 events?\b/)).toHaveCount(0);
  await page.screenshot({ path: 'snapshots/cf-recent-changes.png' });
  await ctx.close();
});
