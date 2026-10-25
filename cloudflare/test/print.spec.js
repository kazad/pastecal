// @ts-check
/**
 * Printing a calendar, as a person does (Ctrl+P): one landscape page with the calendar's name and month, the month
 * drawn for paper (every event of a normal day shown, a busy day ends in "+N more", repeats included), and a QR code
 * that opens the view link's add page. Nothing you click is printed, and the edit link never is.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787).
 */
const { test, expect } = require('@playwright/test');

test('print: one page, name and month, events, +N more, QR to the add page, no edit link', async ({ browser, request }) => {
  const id = `test-print-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const now = new Date(); const at = (day, h) => new Date(now.getFullYear(), now.getMonth(), day, h).toISOString();
  const events = [
    { id: 'w', title: 'Weekly practice', start: at(2, 17), end: at(2, 18), type: 1, repeat: 'weekly', recurrencerule: 'FREQ=WEEKLY;INTERVAL=1' },
    { id: 'g', title: 'Game vs Hawks', start: at(10, 10), end: at(10, 11), type: 2 },
    ...[9, 10, 11, 12, 13, 14, 15].map((h, i) => ({ id: 'b' + i, title: `Busy ${i + 1}`, start: at(20, h), end: at(20, h + 1), type: 3 })),
  ];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Print test', options: {}, events } })).status()).toBe(201);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  await ctx.route(/googletagmanager|google-analytics|clarity|hotjar/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`/${id}?backend=cf`);
  await page.waitForFunction(() => window.__appMounted && window.scheduleObj && (scheduleObj.eventsData || []).length > 5, null, { timeout: 20_000 });
  await page.waitForFunction(() => typeof window.qrcode === 'function', null, { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });

  const cal = page.locator('.pc-print-cal');
  await expect(cal).toBeVisible();
  await expect(page.locator('#Schedule')).toBeHidden();
  await expect(page.locator('.pc-print-title')).toHaveText('Print test');
  await expect(page.locator('.pc-print-range')).toHaveText(now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
  await expect(cal).toContainText('Game vs Hawks');
  expect(await cal.locator('.pc-pm-ev', { hasText: 'Weekly practice' }).count()).toBeGreaterThanOrEqual(4);   // the repeat, every week
  await expect(cal.locator('.pc-pm-more')).toHaveCount(1);                                                         // the busy day
  const shownBusy = await cal.locator('.pc-pm-ev', { hasText: 'Busy' }).count();
  await expect(cal.locator('.pc-pm-more')).toHaveText(`+${7 - shownBusy} more`);
  // No day's events spill past its box.
  expect(await page.evaluate(() => [...document.querySelectorAll('.pc-pm-day')].every((d) => d.scrollHeight <= d.clientHeight + 1))).toBe(true);
  // The QR opens the add page of the view link; the printed text is the view link. Never the edit link.
  await expect(page.locator('.pc-print-qr svg')).toHaveCount(1);
  const foot = await page.locator('.pc-print-foot').innerText();
  expect(foot).toContain(`/view/${view.publicViewId}`);
  expect(foot).not.toContain(id);
  expect(await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.subscribePageURL())).toMatch(new RegExp(`/view/${view.publicViewId}/add$`));
  // Nothing you click: no header, toolbar or side panel.
  for (const sel of ['topbar', '.e-schedule-toolbar-container', 'aside']) expect(await page.locator(sel).evaluateAll((els) => els.filter((e) => e.offsetParent !== null).length)).toBe(0);

  const pdf = await page.pdf({ landscape: true, format: 'A4', printBackground: true });
  expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length).toBe(1);
  await ctx.close();
});
