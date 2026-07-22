// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('NativeCal Event Popover', () => {

  test.beforeEach(async ({ page }) => {
    const slug = `popover-${Date.now()}`;
    await page.goto(`http://localhost:8000/nativecal/${slug}`);
    await expect(page.getByTestId('month-view-grid')).toBeVisible({ timeout: 10000 });
  });

  async function createEventWithDescription(page, title, description) {
    const currentMonthCells = page.locator('.calendar-cell:not(.opacity-50)');
    await currentMonthCells.nth(10).click();
    await page.getByTestId('quick-create-more-details').click();
    await page.getByTestId('editor-title').fill(title);
    await page.getByTestId('editor-description').fill(description);
    await page.getByTestId('editor-save').click();
    await expect(page.getByText(title).first()).toBeVisible();
    await page.getByText(title).first().click();
    await expect(page.getByTestId('popover-title')).toHaveText(title);
  }

  test('long description is fully reachable via scrolling, not cut off', async ({ page }) => {
    const longDescription = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a very long event description.`).join('\n');
    await createEventWithDescription(page, 'Long Description Event', longDescription);

    const popover = page.getByTestId('popover-title').locator('xpath=ancestor::div[contains(@class, "fixed")][1]');

    // The popover itself must never exceed the viewport height.
    const viewportHeight = page.viewportSize().height;
    const box = await popover.boundingBox();
    expect(box.height).toBeLessThanOrEqual(viewportHeight);

    // The last line of the description must be reachable (scrolled into view), not clipped off permanently.
    const lastLine = page.getByText('Line 40 of a very long event description.');
    await lastLine.scrollIntoViewIfNeeded();
    await expect(lastLine).toBeInViewport();
  });

  test('URL in description is rendered as a clickable link', async ({ page }) => {
    const url = 'https://example.com/some-page';
    await createEventWithDescription(page, 'Event With Link', `Details here: ${url}`);

    const link = page.locator('[data-testid="popover-description"] a', { hasText: url });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', url);
  });

});
