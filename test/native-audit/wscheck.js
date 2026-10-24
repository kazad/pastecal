const { chromium } = require('@playwright/test');
const f = require('./fixtures');
(async () => {
  const browser = await chromium.launch({ args: f.LAUNCH_ARGS });
  for (const p of ['/aud-syn-desktop-en', '/beta/aud-nat-desktop-en']) {
    const { page, blocked, ctx } = await f.newPage(browser, {});
    const ws = [];
    page.on('websocket', (w) => { ws.push(w.url()); w.on('framesent', (fr) => ws.push('  sent ' + String(fr.payload).slice(0, 60))); });
    await page.goto(f.BASE + p); await page.waitForTimeout(5000);
    console.log(p, JSON.stringify(ws), 'blocked:', [...new Set(blocked)]);
    await ctx.close();
  }
  await browser.close();
})();
