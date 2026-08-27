// @ts-check
const { test, expect } = require('./fixtures');

// pastecal is an open wiki: anyone with the link can read and write, and that does not
// change. AuthorSignal only leaves a trail so "who most likely owns this" has an answer
// when a slug leaks. These tests pin the properties that make it safe to ship:
// it must never gate the app, and it must never pollute real ownership data from CI.

test.describe('Author signal', () => {
  test('the calendar works when anonymous sign-in is blocked', async ({ page }) => {
    // Corporate proxies, tracker blockers and offline identitytoolkit are all real. The
    // signal is observational, so losing it must cost nothing -- a calendar that fails to
    // load because an auth endpoint is unreachable would be a catastrophic trade.
    await page.route('**identitytoolkit**', (r) => r.abort());
    await page.route('**securetoken**', (r) => r.abort());

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/rldispatch');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2000);

    // The grid renders and the app is usable with no uid at all.
    const signedIn = await page.evaluate(() => {
      try { return !!firebase.auth().currentUser; } catch (e) { return false; }
    });
    expect(signedIn).toBe(false);
    expect(errors).toHaveLength(0);
  });

  test('AuthorSignal.touch is inert without a signed-in user', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });

    // Calling it with no uid must be a no-op rather than a throw: it runs on every
    // write, so an exception here would break saving.
    const threw = await page.evaluate(() => {
      try { AuthorSignal.touch('some-calendar'); return false; } catch (e) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('test runs never write ownership records', async ({ page }) => {
    // fixtures.js sets window.__TEST__, and the signal honours it. Without this the e2e
    // suite would file dozens of throwaway calendars into the data a human reads during
    // an incident -- noise there is worse than a gap.
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });

    expect(await page.evaluate(() => window.__TEST__)).toBe(true);

    const wrote = await page.evaluate(async () => {
      let attempted = false;
      const realRef = firebase.database().ref.bind(firebase.database());
      firebase.database().ref = function (path) {
        if (String(path).startsWith('calendar_authors')) attempted = true;
        return realRef(path);
      };
      AuthorSignal.touch('zz-should-not-be-recorded', { created: true });
      await new Promise((r) => setTimeout(r, 300));
      firebase.database().ref = realRef;
      return attempted;
    });
    expect(wrote).toBe(false);
  });

  test('adding an event still saves normally with the signal in place', async ({ page }) => {
    // The signal is called from CalendarDataService on every write. If it ever threw or
    // blocked, saving would break -- so assert the end-to-end path still works.
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    const before = await page.locator('.e-appointment').count();
    await page.locator('.e-work-cells').nth(30).click();
    await page.waitForTimeout(600);
    const input = page.locator('input[placeholder="Add title"]');
    if (await input.count()) {
      await input.fill('signal does not block saving');
      await page.locator('button.e-event-create').click();
      await page.waitForTimeout(1200);
    }
    expect(await page.locator('.e-appointment').count()).toBeGreaterThan(before);
  });
});
