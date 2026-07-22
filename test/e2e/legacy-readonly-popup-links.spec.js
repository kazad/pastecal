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

// Regression test for the legacy app's own event popup (Syncfusion's default
// e-quick-popup-wrapper): a long description must not push the popup off the bottom of
// the viewport with no way to reach the rest of it. Syncfusion's default styling has no
// height cap or scroll handling here, unlike nativecal's EventPopover (already fixed).
//
// Relies on the "test-popover-verify" calendar's "Long Description Test" event (35 lines,
// seeded while investigating the original nativecal-only fix for this same class of bug).
test('long description in the legacy popup stays within the viewport and scrolls', async ({ page }) => {
  await page.goto('/test-popover-verify');
  await page.waitForTimeout(1500);

  const event = page.getByText('Long Description Test').first();
  await expect(event).toBeVisible({ timeout: 10000 });
  await event.click({ force: true });
  await page.waitForTimeout(500);

  const popup = page.locator('.e-quick-popup-wrapper');
  await expect(popup).toBeVisible({ timeout: 5000 });

  const viewportHeight = page.viewportSize().height;
  const box = await popup.boundingBox();
  expect(box.height).toBeLessThanOrEqual(viewportHeight);
  // Capping height alone isn't enough: Syncfusion positions the popup (often trying to
  // vertically center it near the click target) based on its natural, pre-clamp height,
  // so a shrunk popup can still end up with a negative `top` -- its header and first
  // lines pushed above the viewport with no way to scroll back up to them.
  expect(box.y, 'popup top must not be pushed above the viewport').toBeGreaterThanOrEqual(0);

  const firstLine = page.getByText('Line 1: This is a long event description');
  await expect(firstLine).toBeInViewport();

  const lastLine = page.getByText('Line 35: This is a long event description');
  await lastLine.scrollIntoViewIfNeeded();
  await expect(lastLine).toBeInViewport();
});

test('long description in the legacy popup does not clip its top on a short viewport', async ({ page }) => {
  // A shorter viewport is more likely to trigger Syncfusion's vertical-centering math
  // producing a large negative `top` for a tall popup.
  await page.setViewportSize({ width: 1000, height: 620 });
  await page.goto('/test-popover-verify');
  await page.waitForTimeout(1500);

  const event = page.getByText('Long Description Test').first();
  await expect(event).toBeVisible({ timeout: 10000 });
  await event.click({ force: true });
  await page.waitForTimeout(500);

  const popup = page.locator('.e-quick-popup-wrapper');
  await expect(popup).toBeVisible({ timeout: 5000 });
  const box = await popup.boundingBox();
  expect(box.y, 'popup top must not be pushed above the viewport').toBeGreaterThanOrEqual(0);

  await expect(page.getByText('Line 1: This is a long event description')).toBeInViewport();
});

// Regression test for a fix that overcorrected: the top-clipping fix above force-centers
// EVERY popup vertically via .pc-clamp-top, regardless of whether it actually overflows.
// A short popup (e.g. "Dentist Appointment", a one-line description) fits fine near its
// event and should stay anchored close to it, not get dragged to the vertical center of
// the viewport -- which reads as "the popup appears far away from the event" to a user.
// Reproduces on a tall viewport, where the event (near the top of the month grid) and the
// viewport's vertical center are far apart.
test('short description popup stays anchored near its event, not force-centered', async ({ page }) => {
  // A tall viewport makes the gap between an event near the top of the month grid and
  // viewport-vertical-center large, which is what makes the force-centering bug visible.
  await page.setViewportSize({ width: 2000, height: 1250 });
  await page.goto('/test-popover-verify');
  await page.waitForTimeout(1500);

  const event = page.getByText('Dentist Appointment').first();
  await expect(event).toBeVisible({ timeout: 10000 });
  const eventBox = await event.boundingBox();

  await event.click({ force: true });
  await page.waitForTimeout(500);

  const popup = page.locator('.e-quick-popup-wrapper');
  await expect(popup).toBeVisible({ timeout: 5000 });
  const popupBox = await popup.boundingBox();

  // A popup that fits comfortably near its event shouldn't move far from it -- this event
  // sits near row 2 of the month grid, so a popup dragged toward viewport-center would land
  // multiple rows away, which is exactly what a user sees as "the popup is far from the event".
  expect(Math.abs(popupBox.y - eventBox.y)).toBeLessThan(150);
});
