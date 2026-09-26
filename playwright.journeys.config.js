// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * The release gate: user journeys (test/journeys), run in the browsers our users
 * actually have. deploy.sh runs this before shipping hosting.
 *
 *   npx playwright test -c playwright.journeys.config.js
 *
 * English desktop is the baseline. French desktop, a French iPhone and French Firefox are there
 * because #32 was invisible in English, and a phone because the editor, Save and
 * +Event all look and behave differently there.
 */
module.exports = defineConfig({
  testDir: './test/journeys',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  // One retry: these hit the real Firebase database over the network. A journey
  // that passes only on retry is reported as flaky, not silently green.
  retries: 1,
  use: {
    // BASE_URL points the journeys at another checkout's server (e.g. a worktree on :8020).
    baseURL: process.env.BASE_URL || 'http://localhost:8000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-en', use: { ...devices['Desktop Chrome'], locale: 'en-US', timezoneId: 'America/Los_Angeles' } },
    { name: 'desktop-fr', use: { ...devices['Desktop Chrome'], locale: 'fr-FR', timezoneId: 'Europe/Paris' } },
    { name: 'iphone-fr', use: { ...devices['iPhone 13'], locale: 'fr-FR', timezoneId: 'Europe/Paris' } },
    // Firefox: some of the busiest French calendars are edited in Firefox on Windows, and
    // until #32 (Sep 25) no journey ever ran in it. The core create/edit journeys only,
    // to keep the gate quick.
    { name: 'firefox-fr', testMatch: /journeys\.spec\.js/,
      grep: /create an event with title|edit an event: rename|mixing old number ids|delete an event|\+Event: typed text/,
      use: { ...devices['Desktop Firefox'], locale: 'fr-FR', timezoneId: 'Europe/Paris' } },
  ],
  webServer: process.env.BASE_URL ? undefined : {
    command: 'firebase serve -p 8000',
    url: 'http://localhost:8000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
