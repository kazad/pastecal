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
      AuthorSignal.touch('zz-should-not-be-recorded');
      if (AuthorSignal.creationRecord('zz-should-not-be-recorded') !== null) attempted = true;
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

  test('a viewer who never edits is not recorded as an author', async ({ page }) => {
    // THE regression this file exists for. sync() runs from a deep Vue watcher on
    // `calendar`, and that watcher also fires when the live subscription imports data
    // FROM the server -- so recording authorship there made every viewer echo the
    // calendar back and look like an editor. Observed in production before this was
    // fixed: 27 of 31 browsers on /rldispatch had exactly editCount=1, which is the
    // signature of a write on page load rather than a real edit.
    //
    // Asserts on touch() calls rather than on database writes, because the signal
    // captures firebase.database() internally and an outer db.ref hook never sees it.
    await page.addInitScript(() => {
      window.__touches = [];
      const install = () => {
        if (typeof AuthorSignal === 'undefined') return setTimeout(install, 20);
        const real = AuthorSignal.touch.bind(AuthorSignal);
        AuthorSignal.touch = function (id, opts) {
          window.__touches.push(id);
          return real(id, opts);
        };
      };
      install();
    });

    await page.goto('/rldispatch');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
    // Long enough for the subscription to deliver, the watcher to fire, and the
    // 500ms debounce on sync() to elapse several times over.
    await page.waitForTimeout(4000);

    // Passive interaction only: change views, never touch an event.
    await page.locator('text=MONTH').first().click().catch(() => {});
    await page.waitForTimeout(1500);

    expect(await page.evaluate(() => window.__touches)).toEqual([]);
  });

  const recordTouches = (page) => page.addInitScript(() => {
    window.__touches = [];
    const install = () => {
      if (typeof AuthorSignal === 'undefined') return setTimeout(install, 20);
      const real = AuthorSignal.touch.bind(AuthorSignal);
      AuthorSignal.touch = function (id, opts) {
        window.__touches.push(id);
        return real(id, opts);
      };
    };
    install();
  });

  const addEventViaPopup = async (page, title) => {
    await page.locator('.e-work-cells').nth(30).click();
    await page.waitForTimeout(600);
    const input = page.locator('input[placeholder="Add title"]');
    if (await input.count()) {
      await input.fill(title);
      await page.locator('button.e-event-create').click();
      await page.waitForTimeout(1500);
    }
  };

  test('an edit on the unsaved homepage calendar is not recorded', async ({ page }) => {
    // The homepage holds a random id that does not exist on the server until claimed.
    // Recording authorship of it filed records against ids nobody ever saved.
    await recordTouches(page);
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    await addEventViaPopup(page, 'an unsaved edit');

    expect(await page.evaluate(() => window.__touches)).toEqual([]);
  });

  test('a real edit IS recorded', async ({ page }) => {
    // Claims a real calendar against Firebase, so it needs more than the 30s default.
    test.setTimeout(60_000);
    // The other half: proving the tests above are not passing simply because the
    // signal never fires at all.
    await recordTouches(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    const slug = `test-author-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await page.locator('input[placeholder="your-name"]').fill(slug);
    await page.locator('button:has-text("Claim")').locator('visible=true').first().click();
    await expect(page).toHaveURL(new RegExp(`/${slug}`), { timeout: 15_000 });
    await page.waitForFunction(
      `document.querySelector('#app')._vnode.component.proxy.isExisting === true`,
      null, { timeout: 15_000 });
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    await addEventViaPopup(page, 'a genuine edit');

    expect(await page.evaluate(() => window.__touches)).toContain(slug);
  });
});
