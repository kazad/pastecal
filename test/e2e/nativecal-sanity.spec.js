// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('NativeCal Sanity Tests', () => {
  
  test.beforeEach(async ({ page }) => {
    // Use a unique slug for each test to ensure clean state
    const slug = `sanity-${Date.now()}`;
    await page.goto(`http://localhost:8000/nativecal/${slug}`);
    
    // Wait for calendar to initialize
    await expect(page.getByTestId('month-view-grid')).toBeVisible({ timeout: 10000 });
  });

  test('should dismiss Quick Create popup when an existing event is clicked', async ({ page }) => {
    // 1. Create a test event
    // Find a cell that represents a day in the current month (avoiding prev/next month days)
    // Using data-testid logic if possible, or stick to class filtering as fallback since testid doesn't encode current-month status yet
    const currentMonthCells = page.locator('.calendar-cell:not(.opacity-50)');
    const targetCell = currentMonthCells.nth(10); 
    
    await targetCell.click();
    
    // Quick Create should appear
    // Check for presence of Quick Create specific elements via testid
    await expect(page.getByTestId('quick-create-title')).toBeVisible();
    
    // Enter title and save
    const titleInput = page.getByTestId('quick-create-title');
    await titleInput.fill('Popup Test Event');
    await page.getByTestId('quick-create-save').click();
    
    // Verify event appears on calendar
    // Events render with data-testid="event-{id}" but we don't know the ID.
    // Fallback to text check for verification of creation.
    const eventEl = page.getByText('Popup Test Event');
    await expect(eventEl).toBeVisible();
    
    // 2. Open Quick Create popup again on a different cell
    const otherCell = currentMonthCells.nth(15);
    await otherCell.click();
    
    // Verify Quick Create is open
    await expect(page.getByTestId('quick-create-title')).toBeVisible();
    
    // 3. Click the EXISTING event
    await eventEl.click();
    
    // 4. Verify Quick Create is CLOSED
    await expect(page.getByTestId('quick-create-title')).toBeHidden();
    
    // 5. Verify Event Popover is OPEN
    await expect(page.getByTestId('popover-title')).toHaveText('Popup Test Event');
  });

  test('should handle recurring events without crashing', async ({ page }) => {
    // 1. Open Quick Create
    const currentMonthCells = page.locator('.calendar-cell:not(.opacity-50)');
    await currentMonthCells.nth(5).click();
    
    // 2. Go to Full Editor
    await page.getByTestId('quick-create-more-details').click();
    
    // 3. Fill details
    await page.getByTestId('editor-title').fill('Recurring Meeting');
    
    // 4. Set Recurrence
    await page.getByTestId('editor-repeat').selectOption('DAILY'); 
    
    // 5. Save
    await page.getByTestId('editor-save').click();
    
    // 6. Verify multiple instances appear
    await page.waitForTimeout(500);
    
    const instances = page.getByText('Recurring Meeting');
    const count = await instances.count();
    
    console.log(`Found ${count} instances of recurring event`);
    expect(count).toBeGreaterThan(1);
    
    // 7. Verify Recurrence Icon (↻) is present
    const firstInstance = instances.first();
    await expect(firstInstance).toContainText('↻');
  });

});