// @ts-check
const { test, expect } = require('./fixtures');

// The welcome dock is the only thing that ever appears over the calendar
// uninvited, so the suppression rules matter more than the rendering. Each test
// below is one row of that decision table.

const DOCK = '[data-testid=welcome-dock]';

/**
 * Loads a page once so localStorage for the origin is reachable, applies the
 * given state, then loads again so the app boots against it.
 */
async function bootWith(page, setup) {
  await page.goto('/');
  await page.evaluate(setup ? setup : () => localStorage.clear());
  await page.goto('/');
}

test.describe('First-run welcome dock', () => {
  test('shows on a clean first visit to the homepage', async ({ page }) => {
    await bootWith(page, () => localStorage.clear());

    await expect(page.locator(DOCK)).toBeVisible();
    await expect(page.locator(DOCK)).toContainText('Shared calendars that just work');
  });

  test('stays dismissed after clicking Got it', async ({ page }) => {
    await bootWith(page, () => localStorage.clear());

    await page.locator('[data-testid=welcome-dock-dismiss]').click();
    await expect(page.locator(DOCK)).toHaveCount(0);

    // The flag is what makes this stick across visits.
    const seen = await page.evaluate(() => localStorage.getItem('pastecal_welcome_seen'));
    expect(seen).toBe('1');

    await page.goto('/');
    await expect(page.locator(DOCK)).toHaveCount(0);
  });

  test('never shows to someone who has used pastecal before', async ({ page }) => {
    await bootWith(page, () => {
      localStorage.clear();
      localStorage.setItem('recentCalendars', JSON.stringify([
        { id: 'abc', title: 'Trip', mine: false, lastVisited: new Date().toISOString() },
      ]));
    });

    await expect(page.locator(DOCK)).toHaveCount(0);
  });

  test('never shows to someone who created a calendar before', async ({ page }) => {
    await bootWith(page, () => {
      localStorage.clear();
      localStorage.setItem('myCalendars', JSON.stringify([
        { id: 'mine', title: 'Mine', mine: true, lastVisited: new Date().toISOString() },
      ]));
    });

    await expect(page.locator(DOCK)).toHaveCount(0);
  });

  test('never shows when arriving at a shared calendar link', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    // They came to read someone's calendar, not to be pitched the product.
    await page.goto('/some-shared-calendar');
    await expect(page.locator(DOCK)).toHaveCount(0);
  });

  test('never shows on a read-only view link', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    await page.goto('/view/some-readonly-id');
    await expect(page.locator(DOCK)).toHaveCount(0);
  });

  test('gets out of the way once the visitor starts using the calendar', async ({ page }) => {
    await bootWith(page, () => localStorage.clear());
    await expect(page.locator(DOCK)).toBeVisible();

    // Clicking into the grid answers the question the dock was asking.
    await page.locator('.e-work-cells').first().click({ force: true });
    await expect(page.locator(DOCK)).toHaveCount(0);
  });

  test('opens the existing help panel rather than repeating its content', async ({ page }) => {
    await bootWith(page, () => localStorage.clear());

    await page.locator('[data-testid=welcome-dock-help]').click();
    await expect(page.locator(DOCK)).toHaveCount(0);

    // The help panel owns the long-form copy; the dock is just a door to it.
    await expect(page.getByText('How do I share a calendar?')).toBeVisible();
  });
});
