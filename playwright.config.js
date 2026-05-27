// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright config for pastecal e2e regression tests.
 *
 * Each spec drives the app via the local Firebase Hosting dev server. The web server
 * is auto-started by Playwright if not already running on port 8000.
 */
module.exports = defineConfig({
  testDir: './test/e2e',
  // Run sequentially: tests mutate localStorage and the shared dev server,
  // and Firebase writes from one test can leak into another's view.
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'firebase serve -p 8000',
    url: 'http://localhost:8000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
