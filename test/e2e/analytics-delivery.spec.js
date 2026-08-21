// @ts-check
// Deliberately NOT ./fixtures: that sets window.__TEST__, which correctly
// disables analytics delivery. This file is about delivery actually working, so
// it needs a page where analytics is live.
const { test, expect } = require('@playwright/test');

test.describe('Events actually reach GA4', () => {
  // The bug this guards: analytics.js preferred gtag() but fell back to
  // dataLayer.push when it was undefined -- and GTM loads gtm.js WITHOUT
  // defining window.gtag. A dataLayer push is only an event GTM can listen for;
  // forwarding it to GA4 needs a trigger and tag per event name in the container.
  // So every custom event landed in the dataLayer and stopped there. Verified in
  // production: the only hit reaching /g/collect was page_view.
  //
  // Asserting on the network is the only way to catch this. Every in-page check
  // passed the whole time the events were being silently dropped.
  test('a custom event is sent to the GA4 collect endpoint', async ({ page }) => {
    const sent = [];
    page.on('request', (r) => {
      const url = r.url();
      if (!url.includes('/g/collect')) return;
      const en = url.match(/[?&]en=([^&]*)/);
      if (en) sent.push(decodeURIComponent(en[1]));
    });

    // Deliberately NOT using the ./fixtures page: that sets __TEST__, which
    // correctly disables delivery. This test is about delivery working.
    await page.goto('/');
    await page.waitForSelector('.e-schedule', { timeout: 20_000 });
    await page.waitForTimeout(6000);

    expect(sent).toContain('slug_prompt_shown');
  });

  test('event parameters ride along on the collect hit', async ({ page }) => {
    const params = [];
    page.on('request', (r) => {
      const url = r.url();
      if (!url.includes('/g/collect')) return;
      if (!/[?&]en=slug_prompt_shown/.test(url)) return;
      for (const m of url.matchAll(/[?&]ep\.([^=]+)=([^&]*)/g)) {
        params.push(m[1] + '=' + decodeURIComponent(m[2]));
      }
    });

    await page.goto('/');
    await page.waitForSelector('.e-schedule', { timeout: 20_000 });
    await page.waitForTimeout(6000);

    // Without these the event is countable but not segmentable, which is most
    // of why the schema exists.
    expect(params).toContain('where=homepage_bar');
    expect(params.some((p) => p.startsWith('event_count_bucket='))).toBe(true);
  });

  test('adding gtag.js does not double-count pageviews', async ({ page }) => {
    // GTM already sends page_view, so the gtag config uses send_page_view:false.
    // Getting that wrong doubles every pageview in the property.
    const pageviews = [];
    page.on('request', (r) => {
      const url = r.url();
      if (url.includes('/g/collect') && /[?&]en=page_view/.test(url)) {
        pageviews.push(url);
      }
    });

    await page.goto('/');
    await page.waitForSelector('.e-schedule', { timeout: 20_000 });
    await page.waitForTimeout(6000);

    expect(pageviews).toHaveLength(1);
  });
});
