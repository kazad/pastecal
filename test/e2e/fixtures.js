// @ts-check
// Shared Playwright fixtures.
//
// Every spec should import { test, expect } from './fixtures' rather than from
// '@playwright/test' directly, so automated runs never reach production analytics.
//
// Why this exists: index.html already gates GTM behind `window.__TEST__`, but
// nothing ever set it, so a month of UI verification runs landed in GA4 as ~353
// real users -- the third-highest "user" count on the site. addInitScript runs
// before any page script on every navigation, including redirects and new tabs,
// which a query param on baseURL would miss.

const base = require('@playwright/test');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      window.__TEST__ = true;
    });
    await use(page);
  },
});

module.exports = { test, expect: base.expect };
