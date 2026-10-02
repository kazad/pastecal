// @ts-check
// Shared Playwright fixtures.
//
// Every spec should import { test, expect } from './fixtures' rather than from
// '@playwright/test' directly, so automated runs never reach production.
//
// Analytics: index.html already gates GTM behind `window.__TEST__`, but nothing ever set
// it, so a month of UI verification runs landed in GA4 as ~353 real users -- the
// third-highest "user" count on the site. addInitScript runs before any page script on
// every navigation, including redirects and new tabs, which a query param on baseURL
// would miss.
//
// Data: the suite used to write test calendars into the PRODUCTION database (the page's
// config hard-codes it, and `firebase serve` serves only files). Pages now run against
// the emulators (public/utils/emulators.js, switched on by __PASTECAL_EMULATOR__ below),
// and as a second, independent guard every request to production Firebase or analytics
// is aborted here -- so if the switch ever breaks, tests fail instead of writing real data.

const base = require('@playwright/test');

const PRODUCTION = /^(https?|wss?):\/\/[^/]*(firebaseio\.com|firebasedatabase\.app|cloudfunctions\.net|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|googletagmanager\.com|google-analytics\.com)/;

const test = base.test.extend({
  context: async ({ context }, use) => {
    await context.route(PRODUCTION, (route) => route.abort());
    // Realtime Database talks over a WebSocket, which page.route() never sees.
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket(PRODUCTION, (ws) => ws.close());
    }
    await use(context);
  },
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      window.__TEST__ = true;
      window.__PASTECAL_EMULATOR__ = true;
    });
    await use(page);
  },
});

module.exports = { test, expect: base.expect };
