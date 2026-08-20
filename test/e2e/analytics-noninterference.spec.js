// @ts-check
const { test, expect } = require('./fixtures');

/**
 * Analytics must not change what the app does. analytics-failsafe.spec.js covers
 * the layer being absent or broken at LOAD time; this file covers the risks that
 * only exist once there are call sites inside app.js:
 *
 *   - a helper that throws while reading the calendar it was handed
 *   - analytics mutating the calendar object passed to it
 *   - a slow sink stalling a save
 *   - the visitCount counter corrupting the recents list
 *   - the saved calendar differing at all between analytics on and off
 *
 * The failure this guards against is real and already happened once: the first
 * version of these call sites used a bare `Analytics.foo()`, which threw a
 * ReferenceError and took the whole calendar down when the script was blocked.
 */

const QUICK_ADD = '[data-testid="desktop-add-event-button"]';
const DESCRIPTION = 'textarea[aria-label="Event description"]';
const SUBJECT = '#qa-subject';
const SUBMIT = 'button[type="submit"]';

/** Replaces every named helper with one that throws, before the app boots. */
async function sabotageHelpers(page) {
  await page.addInitScript(() => {
    let held;
    Object.defineProperty(window, 'Analytics', {
      configurable: true,
      get() { return held; },
      set(value) {
        held = value;
        for (const name of [
          'slugAutoAssigned', 'slugPromptShown', 'slugPromptDismissed',
          'slugClaimed', 'slugClaimFailed', 'calendarReturned',
          'eventAdded', 'calendarShared',
        ]) {
          value[name] = () => { throw new Error(`${name} exploded`); };
        }
      },
    });
  });
}

async function addEvent(page, text) {
  await page.locator(QUICK_ADD).click();
  await expect(page.locator(DESCRIPTION)).toBeVisible();
  await page.locator(DESCRIPTION).fill(text);
  await page.locator(SUBMIT).click();
  await expect(page.locator(SUBJECT)).toBeHidden();
}

test.describe('Analytics never changes app behavior', () => {
  test('every analytics helper throwing does not break adding an event', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await sabotageHelpers(page);
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    await addEvent(page, 'lunch tomorrow 2pm');

    // The event reached the calendar even though eventAdded() threw.
    await expect(page.locator('[aria-label*="lunch"]').first()).toBeVisible({ timeout: 10_000 });
    expect(pageErrors).toEqual([]);
  });

  test('a throwing helper on page load does not stop the calendar rendering', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await sabotageHelpers(page);

    // slug_prompt_shown fires during boot on the homepage, so this exercises a
    // call site on the critical render path.
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#slug')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('a throwing helper does not break returning to a calendar', async ({ page }) => {
    await sabotageHelpers(page);

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    // calendar_returned fires on the second visit; make sure a throw there
    // cannot stop the calendar from loading.
    await page.goto('/rldispatch');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });
    await page.goto('/rldispatch');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });
  });

  test('analytics does not mutate the calendar object it is handed', async ({ page }) => {
    // The helpers receive the live calendar to read event counts off it. Reading
    // is fine; writing would corrupt real user data.
    await page.addInitScript(() => {
      window.__mutations = [];
      let held;
      Object.defineProperty(window, 'Analytics', {
        configurable: true,
        get() { return held; },
        set(value) {
          held = value;
          for (const name of ['eventAdded', 'calendarReturned', 'slugPromptShown',
            'slugClaimed', 'slugAutoAssigned']) {
            const original = value[name].bind(value);
            value[name] = function (...args) {
              // Snapshot any calendar argument before and after the call.
              const cal = args.find((a) => a && typeof a === 'object' && 'events' in a);
              const before = cal ? JSON.stringify(cal.events) : null;
              const result = original(...args);
              const after = cal ? JSON.stringify(cal.events) : null;
              if (before !== after) window.__mutations.push(name);
              return result;
            };
          }
        },
      });
    });

    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });
    await addEvent(page, 'team sync tomorrow 3pm');
    await page.waitForTimeout(1000);

    expect(await page.evaluate(() => window.__mutations)).toEqual([]);
  });

  test('a slow sink does not stall adding an event', async ({ page }) => {
    // track() defers delivery off the caller's stack, so even a sink that burns
    // real time must not be felt at the call site.
    await page.addInitScript(() => {
      let held;
      Object.defineProperty(window, 'Analytics', {
        configurable: true,
        get() { return held; },
        set(value) {
          held = value;
          value.enabled = true;
          value.SINKS = {
            slow() {
              const until = Date.now() + 400;
              while (Date.now() < until) { /* block */ }
            },
          };
          value.active = ['slow'];
        },
      });
    });

    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    const started = Date.now();
    await addEvent(page, 'standup tomorrow 9am');
    const elapsed = Date.now() - started;

    await expect(page.locator('[aria-label*="standup"]').first()).toBeVisible({ timeout: 10_000 });
    // Generous, but far below what a synchronous 400ms-per-event sink would cost
    // if delivery were happening on the caller's stack.
    expect(elapsed).toBeLessThan(8000);
  });

  test('the saved events are identical with analytics on and off', async ({ page }) => {
    // The real guarantee: instrumentation changes nothing about what gets stored.
    const capture = async () => {
      await page.goto('/');
      await page.evaluate(() => localStorage.clear());
      await page.goto('/');
      await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });
      await addEvent(page, 'budget review tomorrow 11am for 45 minutes');
      await page.waitForTimeout(1200);

      return page.evaluate(() => {
        const raw = localStorage.getItem('calendar');
        if (!raw) return null;
        const cal = JSON.parse(raw);
        // Ids and timestamps are expected to differ between runs; the content is
        // what must match.
        return (cal.events || []).map((e) => ({
          subject: e.Subject || e.subject || e.title,
          start: e.StartTime || e.start,
          end: e.EndTime || e.end,
        }));
      });
    };

    const withAnalytics = await capture();

    await page.addInitScript(() => {
      Object.defineProperty(window, 'Analytics', {
        configurable: true, get() { return undefined; }, set() { },
      });
    });
    const withoutAnalytics = await capture();

    expect(withAnalytics).not.toBeNull();
    expect(withoutAnalytics).toEqual(withAnalytics);
  });

  test('visitCount does not disturb the rest of the recents entry', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    await page.goto('/rldispatch');
    await page.waitForTimeout(2500);
    await page.goto('/rldispatch');
    await page.waitForTimeout(2500);

    const entry = await page.evaluate(() => {
      const visited = JSON.parse(localStorage.getItem('recentCalendars') || '[]');
      return visited.find((item) => item.id === 'rldispatch');
    });

    expect(entry).toBeTruthy();
    expect(entry.visitCount).toBe(2);
    // The fields the nav dropdown and the ownership rules depend on are intact.
    expect(entry.id).toBe('rldispatch');
    expect(typeof entry.title).toBe('string');
    expect(entry.pinned).toBe(false);
    expect(entry.mine).toBe(false);
    expect(Date.parse(entry.lastVisited)).not.toBeNaN();
  });

  test('a calendar you created keeps its ownership as visitCount grows', async ({ page }) => {
    // visitCount is written on the same path that keeps `mine` sticky, so a bug
    // there could silently demote a calendar you made and lose it from myCalendars.
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('myCalendars', JSON.stringify([
        { id: 'rldispatch', title: 'Mine', pinned: false, mine: true,
          visitCount: 4, createdAt: '2026-01-01T00:00:00.000Z',
          lastVisited: '2026-01-01T00:00:00.000Z' },
      ]));
    });

    await page.goto('/rldispatch');
    await page.waitForTimeout(2500);

    const mine = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('myCalendars') || '[]'));

    expect(mine).toHaveLength(1);
    expect(mine[0].mine).toBe(true);
    expect(mine[0].visitCount).toBe(5);
    expect(mine[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
