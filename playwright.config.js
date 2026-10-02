// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const firebaseJson = require('./firebase.json');

/**
 * Playwright config for pastecal e2e regression tests.
 *
 * The app is served by the Firebase HOSTING EMULATOR and talks to the database, functions
 * and auth emulators, under the demo-pastecal project -- never production. (It used to run
 * against `firebase serve`, which serves files only, so every test wrote real calendars
 * into the production database.) See public/utils/emulators.js and test/e2e/fixtures.js.
 *
 *   npm run test:e2e   wraps this in `firebase emulators:exec` (test/run-e2e.sh)
 *   npx playwright test  starts the emulators itself via webServer below
 */
const HOSTING = firebaseJson.emulators.hosting.port;
const BASE_URL = `http://127.0.0.1:${HOSTING}`;
// Set by `firebase emulators:exec` for the script it wraps: the emulators are already up.
const insideEmulatorsExec = !!process.env.FIREBASE_EMULATOR_HUB;

module.exports = defineConfig({
  testDir: './test/e2e',
  // Run sequentially: tests mutate localStorage and the shared emulator database,
  // and writes from one test can leak into another's view.
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: insideEmulatorsExec ? undefined : {
    command: 'firebase emulators:start --project demo-pastecal --only hosting,database,functions,auth',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
