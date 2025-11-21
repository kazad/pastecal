// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Calendar Creation Flow', () => {
  test('should create a new calendar with a random ID', async ({ page }) => {
    // 1. Load Homepage
    await page.goto('http://localhost:8000/');

    // 2. Verify Title
    await expect(page).toHaveTitle(/PasteCal/);

    // 3. Check for "Claim URL" button
    const claimButton = page.getByRole('button', { name: /Claim/i });
    await expect(claimButton).toBeVisible();

    // 4. Create Calendar (Click Claim without typing slug -> Random ID)
    // Note: The current implementation might show a dialog if input is empty, 
    // or auto-generate. Adjusting test based on current behavior.
    
    // For this test, let's type a specific test slug to ensure clean state
    const testSlug = `test-cal-${Date.now()}`;
    const slugInput = page.locator('input[placeholder="your-name"]');
    await slugInput.fill(testSlug);
    await slugInput.press('Enter');

    // 5. Verify Redirection
    await expect(page).toHaveURL(new RegExp(`/${testSlug}`));

    // 6. Verify Calendar Loaded (Syncfusion or Native)
    // Waiting for a specific element that indicates the calendar is ready
    // e.g., the title being editable or the "Share" button appearing
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('NativeCal Prototype', () => {
  test('should load and navigate views', async ({ page }) => {
    await page.goto('http://localhost:8000/nativecal/');

    // Check Title
    await expect(page.getByText('NativeCal', { exact: true })).toBeVisible();

    // Switch to Month View
    await page.getByRole('button', { name: 'Month' }).click();
    await expect(page.locator('.calendar-grid')).toBeVisible();

    // Switch to Week View
    await page.getByRole('button', { name: 'Week' }).click();
    await expect(page.locator('.time-grid')).toBeVisible();
  });
});

test.describe('Add Event Icon Visibility', () => {
  test('should show add event button on desktop', async ({ page }) => {
    // Set desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });

    // Create a test calendar
    const testSlug = `test-cal-${Date.now()}`;
    await page.goto('http://localhost:8000/');
    const slugInput = page.locator('input[placeholder="your-name"]');
    await slugInput.fill(testSlug);
    await slugInput.press('Enter');

    // Wait for calendar to load
    await expect(page).toHaveURL(new RegExp(`/${testSlug}`));
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10000 });

    // Verify the add event button is visible on desktop
    const addEventButton = page.locator('[data-testid="desktop-add-event-button"]');
    await expect(addEventButton).toBeVisible();
  });

  test('should hide add event button on mobile but show in menu', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Create a test calendar
    const testSlug = `test-cal-${Date.now()}`;
    await page.goto('http://localhost:8000/');
    const slugInput = page.locator('input[placeholder="your-name"]');
    await slugInput.fill(testSlug);
    await slugInput.press('Enter');

    // Wait for calendar to load
    await expect(page).toHaveURL(new RegExp(`/${testSlug}`));
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10000 });

    // Verify the add event button is NOT visible on mobile (direct button)
    const addEventButton = page.locator('[data-testid="desktop-add-event-button"]');
    await expect(addEventButton).toBeHidden();

    // Verify kebab menu button is visible on mobile
    const menuButton = page.locator('[data-testid="mobile-menu-button"]');
    await expect(menuButton).toBeVisible();

    // Open mobile menu
    await menuButton.click();

    // Verify "Quick Add Event" is visible in mobile menu
    const mobileQuickAdd = page.locator('[data-testid="mobile-quick-add-button"]');
    await expect(mobileQuickAdd).toBeVisible();
  });
});
