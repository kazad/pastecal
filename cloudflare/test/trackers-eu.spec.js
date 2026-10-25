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
    // ?backend=firebase: a local copy acts like the live site only when asked (it defaults to no production side effects).
    const { seen, inEurope } = await trackerRequests(browser, 'America/New_York', path + '?backend=firebase');
    expect(inEurope).toBe(false);
    expect(seen.some((u) => /googletagmanager\.com/.test(u))).toBe(true);
  });
}

// A local copy on the Cloudflare backend must never touch production: no Firebase sign-in, no Firebase
// database, no analytics. (Oct 2026: local runs were creating anonymous users in production Firebase Auth.)
test('local Cloudflare-backend pages make no production requests', async ({ browser }) => {
  const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  const seen = [];
  await page.route(/identitytoolkit|securetoken|firebaseio\.com|firebasedatabase|googletagmanager|google-analytics|clarity\.ms|hotjar/, (r) => { seen.push(new URL(r.request().url()).hostname); return r.abort(); });
  await page.goto('/?backend=cf');
  await page.waitForFunction(() => window.scheduleObj, null, { timeout: 20_000 });
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.pcNoProdSideEffects)).toBe(true);
  expect(seen, 'production hosts contacted').toEqual([]);
  await ctx.close();
});
