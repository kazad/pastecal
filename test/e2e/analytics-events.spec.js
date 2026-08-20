// @ts-check
const { test, expect } = require('./fixtures');

// The analytics seam shipped fully built but with no call sites, so for months
// GA4 recorded only its four built-in events and every product question about
// claiming, adding, or sharing was unanswerable. These tests assert the wiring
// exists, so it can't silently rot back to nothing.
//
// They capture Analytics.track() in-page rather than asserting on network calls:
// the fixture sets window.__TEST__, which correctly disables delivery, and what
// matters here is that the call sites fire at all.
//
// Note the capture re-enables the seam and installs a recording sink. Under
// __TEST__ the module sets enabled=false and track() returns before doing any
// work, so params captured at the call site never carry baseParams. Recording at
// the sink is the only place the enriched params actually exist.

/**
 * Records every event into window.__fired, installing before any page script
 * runs so events fired during app boot are not missed.
 */
async function captureEvents(page) {
  await page.addInitScript(() => {
    window.__fired = [];
    let held;
    Object.defineProperty(window, 'Analytics', {
      configurable: true,
      get() { return held; },
      set(value) {
        held = value;
        // Record raw call-site args, which is what proves the wiring exists...
        const original = value.track.bind(value);
        value.track = function (name, params) {
          window.__fired.push({ name, params });
          return original(name, params);
        };
        // ...and capture enriched params by standing in as the only sink.
        value.enabled = true;
        value.SINKS = {
          record(name, params) { window.__enriched = window.__enriched || []; window.__enriched.push({ name, params }); },
        };
        value.active = ['record'];
      },
    });
  });
}

const firedNames = (page) => page.evaluate(() => window.__fired.map((e) => e.name));

test.describe('Analytics call sites', () => {
  test.beforeEach(async ({ page }) => {
    await captureEvents(page);
  });

  test('the naming prompt is counted on the homepage', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2500);

    // This is the denominator for the whole naming question: everyone who was
    // shown a generated name they could have changed.
    expect(await firedNames(page)).toContain('slug_prompt_shown');
  });

  test('the naming prompt is not counted on an existing calendar', async ({ page }) => {
    await page.goto('/some-existing-calendar');
    await page.waitForTimeout(2500);

    // No claim bar is shown here, so counting it would inflate the denominator.
    expect(await firedNames(page)).not.toContain('slug_prompt_shown');
  });

  test('adding an event via quick add is attributed to quick_add', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    // Selectors mirror quick-add-dialog.spec.js. Driving the real dialog means
    // this breaks if the dialog stops reaching handleQuickAddEvent at all.
    await page.locator('[data-testid="desktop-add-event-button"]').click();
    await expect(page.locator('textarea[aria-label="Event description"]')).toBeVisible();

    await page.locator('textarea[aria-label="Event description"]').fill('lunch tomorrow at noon');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(1200);

    const events = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'event_added'));

    expect(events.length).toBeGreaterThan(0);
    // The source param is the whole point: it separates the typed path from the
    // grid path, which is what decides where to invest.
    expect(events[0].params.source).toBe('quick_add');
  });

  // Claims a real calendar against Firebase, so it needs more than the 30s default.
  test('copying a link is attributed, and ICS is distinguished from a plain link', async ({ page, context }) => {
    test.setTimeout(90_000);
    // The share panel only exists on a saved calendar (v-if="isExisting"), and
    // Vue ships here as the production build, so there is no component instance
    // to reach into. Drive the real thing: claim a calendar, open Share, click
    // the actual Copy buttons. That also makes this a test of the markup, which
    // is where the method argument lives and where it would regress.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

    const slug = `t-analytics-${Date.now().toString(36)}`;
    await page.goto('/');
    await page.waitForTimeout(2500);

    await page.locator('#slug').fill(slug);
    await page.getByRole('button', { name: /^Claim/ }).first().click();
    await page.waitForURL(`**/${slug}`, { timeout: 15000 });
    await page.waitForTimeout(2500);

    // The [aria-label="Share calendar"] button is the mobile one and is hidden at
    // desktop width; the desktop affordance is this pill.
    await page.locator('[data-testid="share-pill-existing"]').click();
    await page.waitForTimeout(800);

    const copyButtons = page.locator('button:has-text("Copy")');
    const count = await copyButtons.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      await copyButtons.nth(i).click({ force: true }).catch(() => {});
      await page.waitForTimeout(150);
    }

    const methods = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'calendar_shared').map((e) => e.params.method));

    expect(methods).toContain('copy');
    expect(methods).toContain('ics');
  });

  test('every event carries the params its schema promises', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2500);

    const prompt = await page.evaluate(() =>
      (window.__enriched || []).find((e) => e.name === 'slug_prompt_shown'));

    expect(prompt).toBeTruthy();
    expect(prompt.params.where).toBe('homepage_bar');
    // Buckets, not raw counts -- raw values blow up dimension cardinality.
    expect(prompt.params.event_count_bucket).toBeTruthy();
    // baseParams rides along on everything so segmentation works without the
    // call sites having to remember it.
    expect(prompt.params.surface).toBe('test');
  });
});

test.describe('Analytics is optional', () => {
  // analytics.js is a separate <script>, so an ad blocker or CDN failure can
  // leave the global undefined. Bare `Analytics.foo()` call sites throw a
  // ReferenceError there and take the calendar down -- which is exactly what
  // happened when these call sites were first added. The track() wrapper in
  // app.js exists to make that a no-op instead.
  test('the calendar still works when analytics.js never loads', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.route('**/utils/analytics.js*', (route) => route.abort());

    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    // The homepage claim bar is where slug_prompt_shown fires, so this path
    // executes a call site with no Analytics global present.
    await expect(page.locator('#slug')).toBeVisible();

    const analyticsErrors = errors.filter((e) => e.includes('Analytics'));
    expect(analyticsErrors).toEqual([]);
  });

  test('adding an event still works when analytics.js never loads', async ({ page }) => {
    await page.route('**/utils/analytics.js*', (route) => route.abort());

    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="desktop-add-event-button"]').click();
    await page.locator('textarea[aria-label="Event description"]').fill('dinner tomorrow 7pm');
    await expect(page.locator('#qa-subject')).toHaveValue('dinner');
  });
});

test.describe('Events are counted once, and surfaces stay distinct', () => {
  // QuickAddDialog.js used to call Analytics.eventAdded('quick_add') itself while
  // app.js also counted the same action, so every typed event was recorded twice
  // -- and the component's call was unguarded, so a throwing helper stranded the
  // dialog open with the event lost. app.js owns the call now.
  test('a quick-add event produces exactly one event_added', async ({ page }) => {
    await captureEvents(page);
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="desktop-add-event-button"]').click();
    await page.locator('textarea[aria-label="Event description"]').fill('lunch tomorrow 2pm');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(1500);

    const added = await page.evaluate(() =>
      window.__fired.filter((e) => e.name === 'event_added'));

    expect(added).toHaveLength(1);
    expect(added[0].params.source).toBe('quick_add');
    // The component's version passed no calendar, so the bucket was always wrong.
    expect(added[0].params.event_count_bucket).toBeTruthy();
  });

  // SlugManager instruments the read-only link flow with the same event names
  // app.js uses for claiming the calendar's own URL. Without a discriminator the
  // two actions are indistinguishable in reporting, which defeats the point.
  test('claiming the calendar URL is tagged as a distinct surface', async ({ page }) => {
    await captureEvents(page);
    await page.goto('/');
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 10_000 });

    // The homepage assigns a generated id during boot; filling before that lands
    // gets silently overwritten, and the claim then reads as auto-assigned.
    await expect(page.locator('#slug')).not.toHaveValue('');

    const slug = `t-where-${Date.now().toString(36)}`;
    await page.locator('#slug').fill(slug);
    await expect(page.locator('#slug')).toHaveValue(slug);

    // A successful claim redirects to /<slug>, which tears down window.__fired.
    // sessionStorage survives a same-origin navigation, so mirror into it.
    await page.evaluate(() => {
      const original = window.Analytics.track.bind(window.Analytics);
      window.Analytics.track = function (name, params) {
        const kept = JSON.parse(sessionStorage.getItem('__kept') || '[]');
        kept.push({ name, params });
        sessionStorage.setItem('__kept', JSON.stringify(kept));
        return original(name, params);
      };
    });

    await page.getByRole('button', { name: /^Claim/ }).first().click();
    await page.waitForURL(`**/${slug}`, { timeout: 20_000 });

    const claims = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('__kept') || '[]')
        .filter((e) => e.name === 'slug_claimed'));

    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].params.where).toBe('calendar_url');
  });
});
