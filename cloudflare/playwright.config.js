// Browser journeys against `wrangler dev` (cd cloudflare && npx wrangler dev), the app on Cloudflare data.
//   npx playwright test -c cloudflare/playwright.config.js
const { defineConfig, devices } = require('@playwright/test');
const baseURL = require('./test/worker-server');   // this worker's server when test-browser.sh runs several
module.exports = defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.js/,
  // Each test makes its own calendars, so files run side by side (start wrangler dev with --var LOCAL_NO_LIMITS:1).
  workers: Number(process.env.PW_WORKERS || 6),
  // ...and so do the tests inside a file: none depends on another's order (a test that changes a calendar
  // other tests read makes its own).
  fullyParallel: true,
  // One retry: a test that passes on its second try is reported as flaky, not hidden.
  retries: Number(process.env.PW_RETRIES ?? 1),
  reporter: 'list',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: { baseURL, screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop-en', use: { ...devices['Desktop Chrome'], locale: 'en-US', timezoneId: 'America/Los_Angeles' } }],
});
