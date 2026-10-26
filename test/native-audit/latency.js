// Interaction latency on a 600-event calendar (audit-big): in-page timing from the click to the
// next painted frame where the result is on screen. Median of 5 per action, 4x CPU throttle.
const { chromium } = require('@playwright/test');
const f = require('./fixtures');
const R = {
  syncfusion: { path: '/audit-big', ev: '.e-appointment', pop: '.e-quick-popup-wrapper.e-popup-open', next: '.e-toolbar-item.e-next button', title: '.e-toolbar-item.e-date-range', week: '.e-toolbar-item.e-views.e-week', weekReady: '.e-work-cells', edit: 'button.e-edit', editor: '.e-schedule-dialog.e-popup-open' },
  native: { path: '/beta/audit-big', ev: '.nc-bar', pop: '[data-testid="event-popover"]', next: '[data-testid="nav-next"]', title: '[data-testid="current-date-range"]', week: '.nc-views [data-testid="view-Week"]', weekReady: '[data-testid="time-grid"]', edit: '[data-testid="popover-edit"]', editor: '[data-testid="event-editor"]' },
};
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
// click `sel`, resolve when `done()` is true on a later animation frame
const timed = (page, sel, doneSrc) => page.evaluate(async ([sel, doneSrc]) => {
  const done = new Function(doneSrc);
  const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
  if (!el) return -1;
  const t0 = performance.now();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.click();
  return await new Promise((res) => { const tick = () => (done() ? requestAnimationFrame(() => res(performance.now() - t0)) : (performance.now() - t0 > 10000 ? res(99999) : requestAnimationFrame(tick))); tick(); });
}, [sel, doneSrc]);
(async () => {
  const browser = await chromium.launch({ args: f.LAUNCH_ARGS });
  const out = {};
  for (const [name, c] of Object.entries(R)) {
    const res = { popover: [], nextMonth: [], weekView: [], editorOpen: [] };
    for (let i = 0; i < 5; i++) {
      const { ctx, page } = await f.newPage(browser, {});
      await page.clock.install({ time: new Date('2026-10-24T12:00:00-04:00') });
      const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto(f.BASE + c.path); await page.locator(c.ev).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(1500);
      res.popover.push(await timed(page, c.ev, `return !!document.querySelector('${c.pop}')`));
      res.editorOpen.push(await timed(page, c.edit, `return !!document.querySelector('${c.editor}')`));
      await page.keyboard.press('Escape'); await page.waitForTimeout(500); await page.keyboard.press('Escape'); await page.waitForTimeout(500);
      const t0 = await page.locator(c.title).first().innerText();
      res.nextMonth.push(await timed(page, c.next, `return document.querySelector('${c.title}').innerText !== ${JSON.stringify(t0)} && document.querySelectorAll('${c.ev}').length > 0`));
      res.weekView.push(await timed(page, c.week, `return !!document.querySelector('${c.weekReady}') && !document.querySelector('[data-testid="month-view-grid"]') && !document.querySelector('.e-month-view')`));
      await ctx.close();
    }
    out[name] = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { medianMs: Math.round(med(v)), runs: v.map(Math.round) }]));
    console.log(name, JSON.stringify(out[name]));
  }
  require('fs').writeFileSync(`${process.env.OUT}/perf-latency.json`, JSON.stringify(out, null, 2));
  await browser.close();
})();
