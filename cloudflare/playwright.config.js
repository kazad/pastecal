// Browser journeys against `wrangler dev` (cd cloudflare && npx wrangler dev), the app on Cloudflare data.
//   npx playwright test -c cloudflare/playwright.config.js
const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.js/,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: { baseURL: process.env.BASE_URL || 'http://localhost:8787', screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop-en', use: { ...devices['Desktop Chrome'], locale: 'en-US', timezoneId: 'America/Los_Angeles' } }],
});
