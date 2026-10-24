// Europe gets no third-party trackers (so no cookie banner): GTM/gtag (and Clarity/Hotjar, which
// load through GTM) must not even be requested when the browser's time zone is in Europe.
const { test, expect } = require('@playwright/test');

const TRACKERS = /googletagmanager\.com|google-analytics\.com|clarity\.ms|hotjar\.com/;

async function trackerRequests(browser, timezoneId, path) {
  const ctx = await browser.newContext({ timezoneId });
  const page = await ctx.newPage();
  const seen = [];
  // Record, then refuse: nothing leaves the machine either way.
  await page.route(TRACKERS, (r) => { seen.push(r.request().url()); return r.abort(); });
  await page.route(/firebaseio\.com/, (r) => r.abort());
  await page.goto(path);
  await page.waitForTimeout(1500);
  const inEurope = await page.evaluate(() => window.pcInEurope);
  await ctx.close();
  return { seen, inEurope };
}

for (const path of ['/', '/pricing']) {
  test(`no trackers in Europe on ${path}`, async ({ browser }) => {
    for (const tz of ['Europe/Berlin', 'Europe/London', 'Atlantic/Canary']) {
      const { seen, inEurope } = await trackerRequests(browser, tz, path);
      expect(inEurope, tz).toBe(true);
      expect(seen, `${tz} requested trackers`).toEqual([]);
    }
  });

  test(`trackers still load outside Europe on ${path}`, async ({ browser }) => {
    const { seen, inEurope } = await trackerRequests(browser, 'America/New_York', path);
    expect(inEurope).toBe(false);
    expect(seen.some((u) => /googletagmanager\.com/.test(u))).toBe(true);
  });
}
