// @ts-check
const { test, expect } = require('./fixtures');

/**
 * Regression tests for the Quick Add dialog's editable parsed fields.
 *
 * The dialog parses a natural-language sentence into Subject/Start/End inputs.
 * Editing a field "pins" it: further typing re-parses the sentence but must not
 * overwrite the hand-edited value.
 */

/** Open a fresh calendar and the Quick Add dialog on it. */
async function openQuickAdd(page) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');

  const testSlug = `test-qa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const slugInput = page.locator('input[placeholder="your-name"]');
  await slugInput.fill(testSlug);
  await slugInput.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/${testSlug}`));
  await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

  await page.locator('[data-testid="desktop-add-event-button"]').click();
  await expect(page.locator('textarea[aria-label="Event description"]')).toBeVisible();
}

const f = {
  description: 'textarea[aria-label="Event description"]',
  subject: '#qa-subject',
  startDate: '#qa-start-date',
  startTime: '[aria-label="Start time"]',
  endDate: '#qa-end-date',
  endTime: '[aria-label="End time"]',
  create: 'button[type="submit"]',
};

test.describe('Quick Add — parsing into editable fields', () => {
  test('a typed sentence populates every field', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('lunch with sam tomorrow 2pm for 90 minutes');

    await expect(page.locator(f.subject)).toHaveValue('lunch with sam');
    await expect(page.locator(f.startTime)).toHaveValue('14:00');
    // 2pm + 90min = 3:30pm, so duration parsing drives the End field.
    await expect(page.locator(f.endTime)).toHaveValue('15:30');
    await expect(page.locator(f.startDate)).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('fields are editable, not read-only (the original bug)', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('meeting tomorrow 10am');

    // Each field must accept direct input rather than forcing the user to retype
    // the sentence. This is the regression the whole feature exists to prevent.
    await page.locator(f.subject).fill('renamed by hand');
    await page.locator(f.startTime).fill('09:15');
    await page.locator(f.endTime).fill('11:45');

    await expect(page.locator(f.subject)).toHaveValue('renamed by hand');
    await expect(page.locator(f.startTime)).toHaveValue('09:15');
    await expect(page.locator(f.endTime)).toHaveValue('11:45');
  });

  test('clearing the description clears unpinned fields', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('dentist friday 3pm');
    await expect(page.locator(f.subject)).toHaveValue('dentist');

    await page.locator(f.description).fill('');
    await expect(page.locator(f.subject)).toHaveValue('');
    await expect(page.locator(f.startDate)).toHaveValue('');
    await expect(page.locator(f.startTime)).toHaveValue('');
  });
});

test.describe('Quick Add — sticky override', () => {
  test('a hand-edited field survives further typing', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('lunch with sam tomorrow 2pm');
    await expect(page.locator(f.endTime)).toHaveValue('15:00');

    await page.locator(f.endTime).fill('17:45');
    // Appending to the sentence re-parses, but must not clobber the pinned End.
    await page.locator(f.description).fill('lunch with sam tomorrow 2pm at the cafe');

    await expect(page.locator(f.endTime)).toHaveValue('17:45');
    // ...while unpinned fields still track the sentence.
    await expect(page.locator(f.subject)).toHaveValue('lunch with sam at the cafe');
  });

  test('editing one field does not pin the others', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('lunch with sam tomorrow 2pm');

    await page.locator(f.startTime).fill('13:30');
    // Re-parsing must leave the edited Start alone but still update the rest.
    await page.locator(f.description).fill('dinner with sam tomorrow 6pm');

    await expect(page.locator(f.startTime)).toHaveValue('13:30');
    await expect(page.locator(f.subject)).toHaveValue('dinner with sam');
    await expect(page.locator(f.endTime)).toHaveValue('19:00');
  });

  test('pinned subject is not overwritten by re-parsing', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('standup tomorrow 9am');
    await page.locator(f.subject).fill('Daily standup');

    await page.locator(f.description).fill('standup tomorrow 9:30am');

    await expect(page.locator(f.subject)).toHaveValue('Daily standup');
    // The unpinned Start still follows the new time.
    await expect(page.locator(f.startTime)).toHaveValue('09:30');
  });

  test('closing the dialog clears pins for the next event', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('lunch tomorrow 2pm');
    await page.locator(f.endTime).fill('19:00');

    await page.keyboard.press('Escape');
    await page.locator('[data-testid="desktop-add-event-button"]').click();

    // A stale pin would silently apply the previous End time to a new event.
    await page.locator(f.description).fill('lunch tomorrow 2pm');
    await expect(page.locator(f.endTime)).toHaveValue('15:00');
  });
});

test.describe('Quick Add — validation', () => {
  test('Create is disabled until the event is valid', async ({ page }) => {
    await openQuickAdd(page);
    await expect(page.locator(f.create)).toBeDisabled();

    await page.locator(f.description).fill('lunch tomorrow 2pm');
    await expect(page.locator(f.create)).toBeEnabled();
  });

  test('an end before start blocks creation and warns', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('lunch tomorrow 2pm');

    await page.locator(f.endTime).fill('06:00');
    await expect(page.getByText('End is before start.')).toBeVisible();
    await expect(page.locator(f.create)).toBeDisabled();

    await page.locator(f.endTime).fill('15:30');
    await expect(page.getByText('End is before start.')).toBeHidden();
    await expect(page.locator(f.create)).toBeEnabled();
  });

  test('a whitespace-only subject blocks creation', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('lunch tomorrow 2pm');
    await page.locator(f.subject).fill('   ');
    await expect(page.locator(f.create)).toBeDisabled();
  });
});

test.describe('Quick Add — examples', () => {
  test('clicking an example fills the sentence and parses it', async ({ page }) => {
    await openQuickAdd(page);

    await page.locator('button[title="Use: birthday party Sat 7pm to 11pm"]').click();

    await expect(page.locator(f.description)).toHaveValue('birthday party Sat 7pm to 11pm');
    await expect(page.locator(f.subject)).toHaveValue('birthday party');
    await expect(page.locator(f.startTime)).toHaveValue('19:00');
    await expect(page.locator(f.endTime)).toHaveValue('23:00');
    await expect(page.locator(f.create)).toBeEnabled();
  });

  test('an example overrides existing pins', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('lunch tomorrow 2pm');
    await page.locator(f.endTime).fill('20:00');

    // Picking a fresh example should start clean, not inherit the old pin.
    await page.locator('button[title="Use: birthday party Sat 7pm to 11pm"]').click();

    await expect(page.locator(f.endTime)).toHaveValue('23:00');
  });

  test('all five examples are shown and each one parses', async ({ page }) => {
    await openQuickAdd(page);

    const examples = [
      'lunch tomorrow 2pm for 1 hour',
      'birthday party Sat 7pm to 11pm',
      'appointment 9/15 at 2:30pm',
      'workout 3pm May 20 for 90 minutes',
      'vacation dec 11 - dec 15',
    ];

    for (const ex of examples) {
      await expect(page.locator(`button[title="Use: ${ex}"]`)).toBeVisible();
    }

    // Every example must actually produce a creatable event — a stale example
    // that no longer parses would teach users the wrong syntax.
    for (const ex of examples) {
      await page.locator(`button[title="Use: ${ex}"]`).click();
      await expect(page.locator(f.description)).toHaveValue(ex);
      await expect(page.locator(f.startDate)).not.toHaveValue('');
      await expect(page.locator(f.create)).toBeEnabled();
    }
  });
});

test.describe('Quick Add — event creation', () => {
  test('a hand-edited time is what lands on the calendar', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('birthday party Sat 7pm to 11pm');

    // Override the parsed 11pm end; the calendar must honour 10:15pm.
    await page.locator(f.endTime).fill('22:15');
    await page.locator(f.create).click();

    await expect(page.locator(f.subject)).toBeHidden();
    const event = page.locator('[aria-label*="birthday party"]').first();
    await expect(event).toBeVisible({ timeout: 10_000 });
    const label = await event.getAttribute('aria-label');
    expect(label).toContain('7:00:00 PM');
    expect(label).toContain('10:15:00 PM');
  });

  test('local wall-clock times are not shifted by timezone conversion', async ({ page }) => {
    await openQuickAdd(page);
    await page.locator(f.description).fill('timezone check tomorrow 11pm');

    // 11pm is the classic UTC-rollover trap: a naive toISOString() on a
    // date-only string would land this on the wrong day.
    const startDate = await page.locator(f.startDate).inputValue();
    await page.locator(f.create).click();

    const event = page.locator('[aria-label*="timezone check"]').first();
    await expect(event).toBeVisible({ timeout: 10_000 });
    const label = await event.getAttribute('aria-label');
    expect(label).toContain('11:00:00 PM');

    // The rendered day must match the date shown in the input.
    const [y, m, d] = startDate.split('-').map(Number);
    const expectedDay = new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    expect(label).toContain(expectedDay);
  });
});

test.describe('Quick Add — theming', () => {
  test('native date/time controls follow the active theme', async ({ page }) => {
    await openQuickAdd(page);

    // color-scheme is what makes the browser's built-in calendar/clock glyphs
    // legible in dark mode; they ignore currentColor.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await expect(page.locator(f.startDate)).toHaveCSS('color-scheme', 'dark');

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect(page.locator(f.startDate)).toHaveCSS('color-scheme', 'light');
  });
});
