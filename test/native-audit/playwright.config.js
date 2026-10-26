// @ts-check
// Native renderer (/beta) vs Syncfusion (/<name>) audit. LOCAL ONLY: run wrangler dev on 8900 first
// (see README in this folder's header comment in audit.spec.js). Never point this at pastecal.com.
const { defineConfig, devices } = require('@playwright/test');
const OUT = process.env.OUT || require('path').join(__dirname, 'out');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: `${OUT}/results.json` }]],
  outputDir: `${OUT}/test-output`,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  use: { baseURL: 'http://127.0.0.1:8900', launchOptions: { args: require('./fixtures').LAUNCH_ARGS }, actionTimeout: 10_000, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-en', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'America/New_York' } },
    { name: 'desktop-de', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' } },
    { name: 'phone-en', use: { ...devices['iPhone 13'], browserName: 'chromium', locale: 'en-US', timezoneId: 'America/New_York' } },
  ],
});
