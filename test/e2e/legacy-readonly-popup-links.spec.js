// @ts-check
const { test, expect } = require('@playwright/test');

// Regression test for the legacy (Syncfusion) app's read-only "View Only" popup
// (public/app.js, shown at /view/{publicViewId}): URLs in an event's description must
// render as clickable links there too, not just in the nativecal EventPopover.
//
// Root cause: public/utils/utils.js sets up a MutationObserver to linkify
// `.e-description-details` on demand, but the <script> tag that runs it sits in <head>
// with no defer, so `document.body` is null at execution time and the observer's setup
// silently no-ops (guarded by `... && document.body`) -- Utils.linkify() itself was never
// broken, it just never got wired up.
//
// Relies on the "test-popover-verify" calendar already existing with a "Conference Call"
// event whose description contains a URL (seeded while investigating this bug).
test('URL in description renders as a clickable link in the legacy read-only quick-info popup', async ({ page }) => {
  await page.goto('/test-popover-verify');
  await page.waitForTimeout(1500);

  const publicViewId = await page.evaluate(async () => {
    return new Promise((resolve) => {
      firebase.database().ref('/calendars/test-popover-verify').once('value', snap => {
        resolve(snap.val()?.options?.publicViewId || null);
      });
    });
  });
  expect(publicViewId, 'test-popover-verify should have an auto-created public view id').toBeTruthy();

  await page.goto(`/view/${publicViewId}`);
  await page.waitForTimeout(1500);
  const event = page.getByText('Conference Call').first();
  await expect(event).toBeVisible({ timeout: 10000 });
  await event.click({ force: true });

  const link = page.locator('.e-description-details a[href="https://example.com/meeting/abc-123"]');
  await expect(link).toBeVisible({ timeout: 5000 });
});
