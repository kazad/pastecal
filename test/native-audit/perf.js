// Load-time measurement: cold vs warm, CDP-throttled (4x CPU, Slow-4G-ish), median of N runs.
// Run with NO_ROUTE=1: page.route() disables the HTTP cache, which made 'warm' meaningless. The
// DNS block in LAUNCH_ARGS still keeps every non-CDN host unreachable.
const { chromium } = require('@playwright/test');
const f = require('./fixtures');
const N = +(process.env.N || 5);
const targets = [['syncfusion', '/audit-big', '.e-appointment'], ['beta', '/beta/audit-big', 'text=/Load event/'], ['nativecal-v1', '/nativecal/audit-big', 'text=/Load event/']];
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
(async () => {
  const browser = await chromium.launch({ args: f.LAUNCH_ARGS });
  const throttle = process.env.THROTTLE !== '0';
  const out = {};
  for (const [name, path, sel] of targets) {
    for (const mode of ['cold', 'warm']) {
      const times = [], bytes = [], reqs = [];
      for (let i = 0; i < N; i++) {
        const { ctx, page } = await f.newPage(browser, {});
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Network.enable');
        if (throttle) {
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
        }
        let b = 0, r = 0;
        cdp.on('Network.loadingFinished', (e) => { b += e.encodedDataLength; r++; });
        if (mode === 'warm') { await page.goto(f.BASE + path); await page.locator(sel).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(500); b = 0; r = 0; }
        const t0 = Date.now();
        await page.goto(f.BASE + path);
        await page.locator(sel).first().waitFor({ timeout: 60000 });
        times.push(Date.now() - t0); bytes.push(b); reqs.push(r);
        await ctx.close();
      }
      out[`${name} ${mode}`] = { medianMs: med(times), runs: times, medianKB: Math.round(med(bytes) / 1024), medianRequests: med(reqs) };
      console.log(name, mode, JSON.stringify(out[`${name} ${mode}`]));
    }
  }
  require('fs').writeFileSync(`${process.env.OUT}/perf-load${throttle ? '-throttled' : ''}.json`, JSON.stringify(out, null, 2));
  await browser.close();
})();
