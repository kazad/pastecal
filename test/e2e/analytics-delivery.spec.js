// @ts-check
// Deliberately NOT ./fixtures: that sets window.__TEST__, which correctly
// disables analytics delivery. This file is about delivery actually working, so
// it needs a page where analytics is live.
const { test, expect } = require('@playwright/test');


/**
 * Every event name in a /g/collect hit.
 *
 * gtag sends ONE event as `?en=<name>` on the URL, but batches MULTIPLE events
 * into the POST body as `en=<name>` lines. Reading only the URL therefore finds
 * page_view and silently misses everything else the moment a second event fires
 * -- which is exactly what happened when a new event was added, and it looked
 * like a delivery regression rather than a test that only handled one shape.
 */
function eventNames(request) {
  const names = [];
  const fromUrl = request.url().match(/[?&]en=([^&]*)/);
  if (fromUrl) names.push(decodeURIComponent(fromUrl[1]));
  for (const m of (request.postData() || '').matchAll(/(?:^|[&\n\r])en=([^&\n\r]*)/g)) {
    names.push(decodeURIComponent(m[1]));
  }
  return names;
}

/** Event params from a hit, for the single-event (URL) form and the batched form. */
function eventParams(request, eventName) {
  const out = [];
  const url = request.url();
  if (new RegExp(`[?&]en=${eventName}(?:&|$)`).test(url)) {
    for (const m of url.matchAll(/[?&]ep\.([^=&]+)=([^&]*)/g)) {
      out.push(m[1] + '=' + decodeURIComponent(m[2]));
    }
  }
  for (const line of (request.postData() || '').split(/[\r\n]+/)) {
    if (!line.includes(`en=${eventName}`)) continue;
    for (const m of line.matchAll(/(?:^|&)ep\.([^=&]+)=([^&]*)/g)) {
      out.push(m[1] + '=' + decodeURIComponent(m[2]));
    }
  }
  return out;
}

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
      if (r.url().includes('/g/collect')) sent.push(...eventNames(r));
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
      if (r.url().includes('/g/collect')) params.push(...eventParams(r, 'slug_prompt_shown'));
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
      if (!r.url().includes('/g/collect')) return;
      pageviews.push(...eventNames(r).filter((n) => n === 'page_view'));
    });

    await page.goto('/');
    await page.waitForSelector('.e-schedule', { timeout: 20_000 });
    await page.waitForTimeout(6000);

    expect(pageviews).toHaveLength(1);
  });
});
