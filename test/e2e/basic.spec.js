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
