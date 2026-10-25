// @ts-check
/**
 * Pro (beta), early access: while Stripe isn't configured (GET /api/pro/config -> {billing:false}), every place
 * Pro is offered says "Join the Pro beta" and puts the email on the Pro waitlist instead of the trial or checkout.
 * With billing on, the offer is the trial and checkout as before. Pro carries a small "Beta" tag either way.
 *
 * Run against BOTH servers; each test skips on the other mode:
 *   billing off (plain local, no Stripe vars):
 *     node node_modules/.bin/wrangler dev --port 8871 --var FIREBASE_DB_URL: --var COPY_BACK: --var IMPORT_SECRET:dev-secret
 *     BASE_URL=http://localhost:8871 npx playwright test -c cloudflare/playwright.config.js pro-beta
 *   billing on (fake Stripe vars, as in trial.test.mjs):
 *     ... --var ACCOUNTS_DEV_MODE:1 --var STRIPE_SECRET_KEY:fake-stripe-key --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret \
 *         --var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly
 *     BASE_URL=http://localhost:8872 npx playwright test -c cloudflare/playwright.config.js pro-beta
 * The waitlist rows are read back through the admin export (Bearer IMPORT_SECRET, default dev-secret).
 */
const { test, expect } = require('@playwright/test');

const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const DONE = 'You’re on the list. We’ll email you when your Pro beta trial is ready.';
const run = Date.now().toString(36);

let shared;
async function seed(request) {
  if (shared) return shared;
  const id = `test-beta-${run}-${Math.floor(Math.random() * 1e5)}`;
  const d = new Date(); d.setDate(9); d.setHours(17, 0, 0, 0);
  const events = [{ id: 'e1', title: 'Practice', start: d.toISOString(), end: new Date(d.getTime() + 3600e3).toISOString(), type: 1 }];
  expect((await request.post(`/cal/${id}`, { data: { title: 'Pro beta test', events } })).status()).toBe(201);
  return (shared = { id });
}
async function billingOf(request) { return (await (await request.get('/api/pro/config')).json()).billing; }

async function open(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    window.__TEST__ = true;
    // Analytics is off in tests; record what would have been sent.
    window.__tracked = [];
    const hook = () => {
      if (!window.Analytics || window.Analytics.__hooked) return;
      const orig = window.Analytics.track.bind(window.Analytics);
      window.Analytics.track = (name, params) => { window.__tracked.push({ name, params }); return orig(name, params); };
      window.Analytics.__hooked = true;
    };
    document.addEventListener('DOMContentLoaded', hook);
  });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  if (path.startsWith('/pricing')) { await page.goto(path); return { ctx, page }; }
  await page.goto('/?backend=cf');
  await page.goto(path);
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20_000 });
  await page.waitForTimeout(400);
  return { ctx, page };
}
async function openShare(page) {
  await page.getByTestId('share-pill-more').click();
  await expect(page.getByTestId('share-pro-card')).toBeVisible();
}
async function waitlistRows(request) {
  const r = await request.get('/api/waitlist/export', { headers: { Authorization: `Bearer ${SECRET}` } });
  expect(r.status()).toBe(200);
  const [head, ...lines] = (await r.text()).split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries((l.match(/"((?:[^"]|"")*)"/g) || []).map((c, i) => [cols[i], c.slice(1, -1).replace(/""/g, '"')])));
}

// ---------- billing off ----------

test('billing off: the Share card offers "Join the Pro beta", and joining stores a waitlist row', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== false, 'needs a server without Stripe');
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await openShare(page);
  const card = page.getByTestId('share-pro-card');
  await expect(card).toContainText('Go Pro');
  await expect(card.getByTestId('share-pro-beta-tag')).toHaveText('Beta');
  await expect(page.getByTestId('share-try-pro')).toHaveCount(0);
  await expect(page.getByTestId('share-get-pro')).toHaveCount(0);
  await expect(card.getByText(/Try Pro free|Get Pro|Lock this calendar/)).toHaveCount(0);

  await card.getByTestId('pro-beta-btn').click();
  const email = card.getByTestId('pro-beta-email');
  await expect(email).toBeFocused();
  await email.fill('not-an-email');
  await card.getByTestId('pro-beta-submit').click();
  await expect(card.getByTestId('pro-beta-error')).toHaveText('Enter an email address, like you@example.com.');
  const addr = `beta-share-${run}@example.com`;
  await email.fill(addr);
  await card.getByTestId('pro-beta-submit').click();
  await expect(card.getByTestId('pro-beta-done')).toHaveText(DONE);

  const tracked = await page.evaluate(() => window.__tracked.filter((e) => e.name === 'pro_beta_joined'));
  expect(tracked.map((e) => e.params)).toEqual([{ beta_surface: 'share' }]);
  const row = (await waitlistRows(request)).find((r) => r.email === addr);
  expect(row, 'stored on the waitlist').toBeTruthy();
  expect(row.plan).toBe('pro');
  expect(row.use).toBe('Pro beta');
  expect(row.page).toBe('/' + id);
  await ctx.close();
});

test('billing off: Stats and the Pro panel offer the beta, never the trial or checkout', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== false, 'needs a server without Stripe');
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await openShare(page);
  await page.getByTestId('side-tab-stats').click();
  const teaser = page.getByTestId('stats-teaser');
  await expect(teaser).toContainText('More with Pro');
  await expect(teaser.getByTestId('stats-pro-beta-tag')).toHaveText('Beta');
  await expect(page.getByTestId('stats-get-pro')).toHaveCount(0);
  await teaser.getByTestId('pro-beta-btn').click();
  const addr = `beta-stats-${run}@example.com`;
  await teaser.getByTestId('pro-beta-email').fill(addr);
  await teaser.getByTestId('pro-beta-email').press('Enter');
  await expect(teaser.getByTestId('pro-beta-done')).toHaveText(DONE);
  expect(await page.evaluate(() => window.__tracked.filter((e) => e.name === 'pro_beta_joined').map((e) => e.params))).toEqual([{ beta_surface: 'stats' }]);

  // The upsell line ("Join the Pro beta →") and every other way into the Pro offer open the panel on the beta form.
  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.openProUpsell());
  const panel = page.getByTestId('pro-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('pro-beta-tag')).toHaveText('Beta');
  await expect(panel.getByTestId('pro-beta-email')).toBeVisible();
  await expect(panel.getByTestId('pro-trial-box')).toHaveCount(0);
  await expect(panel.getByTestId('pro-lock-btn')).toHaveCount(0);
  await expect(panel.getByTestId('pro-email-form')).toHaveCount(0);
  await panel.getByTestId('pro-beta-email').fill(`beta-lock-${run}@example.com`);
  await panel.getByTestId('pro-beta-submit').click();
  await expect(panel.getByTestId('pro-beta-done')).toHaveText(DONE);
  expect(await page.evaluate(() => window.__tracked.filter((e) => e.name === 'pro_beta_joined').map((e) => e.params.beta_surface))).toEqual(['stats', 'lock']);
  await ctx.close();
});

test('billing off: pricing says "Join the Pro beta", hides Get Pro, and the waitlist stores it as the Pro beta', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== false, 'needs a server without Stripe');
  const { ctx, page } = await open(browser, '/pricing');
  const cta = page.locator('.plan.pro .cta');
  await expect(cta).toHaveText('Join the Pro beta');
  await expect(page.locator('.plan.pro .badge')).toHaveText('Beta');
  await expect(page.locator('thead th.pro .beta-tag')).toHaveText('Beta');
  await expect(page.locator('#get-pro')).toBeHidden();
  await expect(page.getByText('Pro is in beta: features may change.')).toHaveCount(1);
  await cta.click();
  await expect(page.locator('#plan')).toHaveValue('pro');
  await expect(page.locator('#email')).toBeFocused();
  const addr = `beta-pricing-${run}@example.com`;
  await page.locator('#email').fill(addr);
  await page.locator('#waitBtn').click();
  await expect(page.locator('#done')).toHaveText("You're on the list. We'll email you when your Pro beta trial is ready.");
  const row = (await waitlistRows(request)).find((r) => r.email === addr);
  expect(row && row.plan).toBe('pro');
  expect(row.page).toBe('/pricing');
  await ctx.close();
});

test('billing off: the hidden website field (a bot) is answered ok and stores nothing', async ({ request }) => {
  test.skip(await billingOf(request) !== false, 'needs a server without Stripe');
  const addr = `beta-bot-${run}@example.com`;
  const r = await request.post('/api/waitlist', { data: { email: addr, plan: 'pro', website: 'http://spam.example' } });
  expect((await r.json()).ok).toBe(true);
  expect((await waitlistRows(request)).some((x) => x.email === addr)).toBe(false);
});

// ---------- billing on ----------

test('billing on: the trial and checkout are offered as before, with the Beta tag', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const { id } = await seed(request);
  const { ctx, page } = await open(browser, `/${id}?backend=cf`);
  await openShare(page);
  const card = page.getByTestId('share-pro-card');
  await expect(card.getByTestId('share-pro-beta-tag')).toHaveText('Beta');
  await expect(page.getByTestId('share-try-pro')).toHaveText('Try Pro free for 30 days. No card needed.');
  await expect(page.getByTestId('share-get-pro')).toBeVisible();
  await expect(card.getByTestId('pro-beta-btn')).toHaveCount(0);
  await page.getByTestId('share-get-pro').click();
  const panel = page.getByTestId('pro-panel');
  await expect(panel.getByTestId('pro-trial-box')).toBeVisible();
  await expect(panel.getByTestId('pro-lock-btn')).toHaveText('Lock this calendar');
  await expect(panel.getByTestId('pro-beta-tag')).toHaveText('Beta');
  await expect(panel.getByTestId('pro-beta-join')).toHaveCount(0);
  await page.getByTestId('share-show-all').click();
  await page.getByTestId('side-tab-stats').click();
  await expect(page.getByTestId('stats-get-pro')).toBeVisible();
  await expect(page.getByTestId('stats-pro-beta-tag')).toHaveText('Beta');
  await expect(page.getByTestId('stats-teaser').getByTestId('pro-beta-btn')).toHaveCount(0);
  await ctx.close();
});

test('billing on: pricing keeps Get Pro and the picker, with the Beta tag', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const { ctx, page } = await open(browser, '/pricing');
  await expect(page.locator('.plan.pro .cta')).toHaveText('Get Pro');
  await expect(page.locator('.plan.pro .cta')).toBeVisible();
  await expect(page.locator('.plan.pro .badge')).toHaveText('Beta');
  await expect(page.locator('thead th.pro .beta-tag')).toHaveText('Beta');
  await expect(page.locator('#get-pro')).toBeVisible();
  await page.locator('.plan.pro .cta').click();
  await expect(page.locator('#calLink')).toBeFocused();
  await ctx.close();
});
