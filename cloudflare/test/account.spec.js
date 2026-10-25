// @ts-check
/**
 * /account and Pro names in the browser: signed out -> magic link -> signed in (Free) -> Pro bought on
 * /pricing (fake Stripe) -> claim @name -> new calendar under it (opens locked, for its owner) -> a visitor opens
 * pastecal.com/@name/<name>: view-only, and the edit id appears nowhere (requests, responses, storage, DOM) ->
 * "Show on my page" lists it on pastecal.com/@name.
 *
 * Runs against the single fake-Stripe server of handles.test.mjs (STRIPE_API_BASE on FAKE_PORT, default 8832;
 * this file runs the fake Stripe there):
 *   BASE_URL=http://localhost:8827 FAKE_PORT=8832 npx playwright test -c cloudflare/playwright.config.js account
 */
const { test, expect } = require('@playwright/test');

const SECRET = process.env.IMPORT_SECRET || 'dev-secret', WHSEC = 'fake-webhook-secret';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net', 'checkout.stripe.test']);
const run = Date.now().toString(36);
const email = `walk-${run}@example.com`;
const handle = `kal${run}`.slice(0, 30);
let fake, signStripe, BASE;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ baseURL }) => {
  BASE = baseURL;
  const m = await import('./fake-stripe.mjs');
  signStripe = m.signStripe;
  fake = await m.startFakeStripe(Number(process.env.FAKE_PORT || 8832));
});
test.afterAll(async () => { if (fake && fake.close) fake.close(); });

const admin = async (request, path, body) => (await request.fetch(path, { method: body ? 'POST' : 'GET', data: body,
  headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } })).json();
async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  await ctx.routeWebSocket((url) => !/localhost|127\.0\.0\.1/.test(String(url)), (ws) => ws.close());   // never a live Firebase socket
  return { ctx, page: await ctx.newPage() };
}
// The fake Stripe page a checkout opens: paying there is the subscription Stripe would make, and its webhook.
async function payFakeCheckout(request, page) {
  const id = new URL(page.url()).pathname.slice(1);
  const sess = fake.sessions.get(id);
  const meta = {};
  for (const [k, v] of Object.entries(fake.log.filter((l) => l.path === '/stripe/v1/checkout/sessions').at(-1).body)) {
    const mm = /^subscription_data\[metadata\]\[(\w+)\]$/.exec(k); if (mm) meta[mm[1]] = v;
  }
  const subId = `sub_walk_${run}`;
  fake.subs.set(subId, { id: subId, object: 'subscription', status: 'active', customer: `cus_walk_${run}`, metadata: meta, created: Math.floor(Date.now() / 1000),
    items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400, price: { id: 'price_fake_unl_yearly', recurring: { interval: 'year' } } }] } });
  const body = JSON.stringify({ id: `evt_walk_${run}`, object: 'event', type: 'checkout.session.completed', data: { object: { id, subscription: subId } } });
  const r = await request.post('/api/stripe/webhook', { data: body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) } });
  expect(r.status()).toBe(200);
  return { subId, sess };
}

let cookieJar, calendarId;

test('signed out: sign in by email link, land on /account (Free)', async ({ browser, request }) => {
  const { ctx, page } = await newPage(browser);
  await page.goto('/account');
  await expect(page.getByTestId('account-signed-out')).toContainText('Sign in to see your account');
  await expect(page.locator('#siteAccount')).toBeHidden();
  await page.locator('#signinEmail').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByTestId('account-link-sent')).toBeVisible();
  const mail = (await admin(request, `/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).emails.at(-1);
  const token = mail.text.match(/#t=([A-Za-z0-9_-]+)/)[1];
  await page.goto(`/signin#t=${token}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/account$/);
  await expect(page.getByTestId('account-email')).toHaveText(email);
  await expect(page.getByTestId('account-plan')).toHaveText('Free');
  await expect(page.getByTestId('account-name-card')).toBeHidden();
  await page.goto('/help');
  await expect(page.locator('#siteAccount')).toBeVisible();          // the site header, while signed in
  await expect(page.locator('#siteAccount')).toHaveAttribute('href', '/account');
  cookieJar = await ctx.storageState();
  await ctx.close();
});

test('Pro from /pricing (fake Stripe), claim @name, create a calendar under it', async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: cookieJar });
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  await ctx.routeWebSocket((url) => !/localhost|127\.0\.0\.1/.test(String(url)), (ws) => ws.close());   // never a live Firebase socket
  await ctx.route('https://checkout.stripe.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>Test checkout</h1>' }));
  const page = await ctx.newPage();
  await page.goto('/pricing');
  await page.locator('#unlCta').click();
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/checkout\.stripe\.test/);
  const checkoutId = new URL(page.url()).pathname.slice(1);
  await payFakeCheckout(request, page);
  // Stripe's success page: Pro says what's next, the @name, on /account. And one email says the same.
  await page.goto(`/pro/done?session_id=${checkoutId}&plan=unlimited`);
  await expect(page.locator('#title')).toHaveText('Pro is on');
  await expect(page.getByTestId('done-next-name')).toContainText('Next: claim your name');
  await expect(page.getByTestId('done-claim-name')).toHaveAttribute('href', '/account');
  const hello = (await admin(request, `/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).emails.filter((m) => m.subject === 'Pro is on: claim your @name');
  expect(hello.length).toBe(1);
  expect(hello[0].text).toContain('/account');
  await page.getByTestId('done-claim-name').click();
  await page.waitForURL(/\/account$/);
  await expect(page.getByTestId('account-plan')).toHaveText(/^Pro · renews (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/);
  await expect(page.locator('.who').getByTestId('account-signout')).toBeVisible();     // beside the email, not in the Plan card
  await expect(page.getByTestId('account-plan-card').getByTestId('account-signout')).toHaveCount(0);
  await expect(page.getByTestId('account-meter')).toHaveText('Upgraded calendars: 0 of 5 · unlimited under your @name');
  await page.getByTestId('handle-input').fill('pricing');
  await page.getByTestId('handle-claim').click();
  await expect(page.getByTestId('name-error')).toHaveText('That name is reserved. Try another.');
  await page.getByTestId('handle-input').fill(handle);
  await page.getByTestId('handle-claim').click();
  await expect(page.getByTestId('handle-link-own')).toHaveText(new RegExp(`/@${handle}$`));
  await expect(page.getByTestId('account-meter')).toHaveText(`Upgraded calendars: 0 of 5 · unlimited under @${handle}`);

  await page.getByTestId('newcal-input').fill('soccer');
  await page.getByTestId('newcal-create').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/account'));
  calendarId = decodeURIComponent(new URL(page.url()).pathname.slice(1));
  expect(calendarId).toMatch(/^[a-z0-9]{12}$/);
  await page.waitForFunction(() => window.scheduleObj, null, { timeout: 20_000 });
  const st = await (await request.get(`/api/admin/cal/${calendarId}/lock-status`, { headers: { Authorization: `Bearer ${SECRET}` } })).json();
  expect(st.locked).toBe(true);
  // Share leads with the @link, called view-only: the panel's one "Share to view" link, and the header pill.
  await expect(page.locator('[data-testid=share-group] h4')).toHaveText('Share to view', { timeout: 15_000 });
  await expect(page.getByTestId('share-readonly-addr')).toContainText(`pastecal.com/@${handle}/soccer`);
  // Locked: "Share to edit" is the editor link (none made in this browser yet: a button to the Plus tab's), then the
  // calendar's own address, which is view only for everyone but the owner and editors (stage2's wording).
  const heads = await page.locator('[data-testid=share-links] .pc-link-item h4').allTextContents();
  expect(heads.slice(0, 3)).toEqual(['Share to view', 'Share to edit', 'Calendar link']);
  await expect(page.getByTestId('share-editor-links')).toHaveCount(0);    // Share to edit already says where
  await expect(page.getByTestId('share-editor-get')).toBeVisible();
  await page.getByTestId('share-editor-get').click();                     // the Plus tab, at Who can edit
  // The owner's Plus tab shows its @link (the Pro links live there).
  await expect(page.getByTestId('pro-at-link').first()).toHaveText(new RegExp(`/@${handle}/soccer$`), { timeout: 15_000 });
  page.once('dialog', (d) => d.accept());                                     // "Make a new editor link?"
  await page.getByTestId('pro-key-btn').click();
  await page.getByTestId('side-tab-share').click();
  await expect(page.getByTestId('share-editor-copy')).toContainText('#k=');
  await expect(page.getByTestId('share-view-copy')).toContainText(`pastecal.com/@${handle}/soccer?date=`);   // This view: from the @link too
  // The header pill is the page's own link, the edit link; the @link is in Share (above).
  await expect(page.getByTestId('share-pill-url')).toContainText(calendarId);
  await expect(page.getByTestId('share-pill-url')).toContainText('can edit');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('share-pill-existing').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(calendarId);
  await ctx.close();
});

test('a visitor opens pastecal.com/@name/soccer: view-only, and the edit id is nowhere', async ({ browser, request }) => {
  // An event, so there is something to see.
  const d = new Date(); d.setDate(12); d.setHours(10, 0, 0, 0);
  const { ctx, page } = await newPage(browser);
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  page.on('response', async (r) => { try { if (new URL(r.url()).hostname === 'localhost') seen.push(await r.text()); } catch (e) { /* bodies of redirects */ } });
  page.on('websocket', (ws) => { seen.push(ws.url()); ws.on('framereceived', (f) => seen.push(String(f.payload))); });
  await page.goto(`/@${handle}/soccer`);
  await page.waitForFunction(() => window.scheduleObj, null, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toBe(`/@${handle}/soccer`);
  const vm = await page.evaluate(() => { const p = app; return { ro: p.isReadOnly, can: p.canEdit, title: p.calendar.title }; });
  expect(vm).toEqual({ ro: true, can: false, title: 'Soccer' });
  await expect(page).toHaveTitle('Soccer · pastecal');
  await expect(page.getByTestId('homepage-tour')).toHaveCount(0);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.documentElement.outerHTML + document.title + location.href);
  for (const s of [...seen, storage]) expect(s.includes(calendarId), `edit id leaked in: ${s.slice(0, 200)}`).toBe(false);
  expect((await request.get(`/@${handle}/soccer.ics`)).status()).toBe(200);
  await ctx.close();
});

test('"Show on my page" lists it on pastecal.com/@name', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: cookieJar });
  await ctx.routeWebSocket((url) => !/localhost|127\.0\.0\.1/.test(String(url)), (ws) => ws.close());   // never a live Firebase socket
  const page = await ctx.newPage();
  await page.goto(`/@${handle}`);
  await expect(page.getByTestId('handle-empty')).toBeVisible();
  await page.goto('/account');
  const row = page.locator(`[data-cal="${calendarId}"]`);
  await expect(row.getByTestId('cal-status')).toHaveText(`Pro · under @${handle}`);   // doesn't use one of the 5
  // A calendar locked at its own address does: the meter and its row say so.
  const plain = `walk-plain-${run}`;
  // Made by this browser (its pastecal id), so it may lock it under Pro: editors of record, like Plus.
  const author = `acct-author-${run}`;
  expect((await page.request.post(`/cal/${plain}`, { data: JSON.stringify({ title: 'Book club', options: {}, events: [], author }) })).status()).toBe(201);
  expect((await page.request.post('/api/pro/lock', { data: JSON.stringify({ calendarId: plain }), headers: { 'Content-Type': 'application/json', Origin: BASE } })).status()).toBe(403);   // the URL alone is not enough
  expect((await page.request.post('/api/pro/lock', { data: JSON.stringify({ calendarId: plain, author }), headers: { 'Content-Type': 'application/json', Origin: BASE } })).status()).toBe(200);
  await page.reload();
  await expect(page.locator(`[data-cal="${plain}"]`).getByTestId('cal-status')).toHaveText('Pro · 1 of your 5');
  await expect(page.getByTestId('account-meter')).toHaveText(`Upgraded calendars: 1 of 5 · unlimited under @${handle}`);
  await expect(page.locator('#newCalNote')).toContainText(`pastecal.com/@${handle}/… link`);
  await row.getByTestId('cal-at-edit').click();
  await row.getByTestId('cal-show').check();
  await expect(page.locator(`[data-cal="${calendarId}"]`).getByTestId('cal-show')).toBeChecked();
  await page.goto(`/@${handle}`);
  await expect(page.getByTestId('handle-name')).toHaveText(`@${handle}`);
  await expect(page.getByTestId('handle-link')).toHaveCount(1);
  await expect(page.getByTestId('handle-link')).toContainText('Soccer');
  const html = await page.content();
  expect(html.includes(calendarId)).toBe(false);
  await ctx.close();
});

test('a short link moves to another calendar only on Save (Change, pick, Save; Cancel leaves it)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: cookieJar });
  await ctx.routeWebSocket((url) => !/localhost|127\.0\.0\.1/.test(String(url)), (ws) => ws.close());
  const page = await ctx.newPage();
  await page.goto('/account');
  const made = await page.request.post('/api/names/calendar', { data: JSON.stringify({ name: 'hockey', title: 'Hockey' }), headers: { 'Content-Type': 'application/json', Origin: BASE } });
  expect(made.status()).toBe(200);
  const hockey = (await made.json()).calendarId;
  const short = `sh${run}`.slice(0, 30);
  await page.reload();
  await page.getByTestId('short-input').fill(short);
  await page.getByTestId('short-calendar').selectOption(calendarId);
  await page.getByTestId('short-add').click();
  const row = page.getByTestId('short-row').filter({ hasText: short });
  await expect(row).toContainText('→ Soccer');
  await expect(row.getByTestId('short-remap')).toBeHidden();                 // no select that moves it on change
  const target = async () => (await (await page.request.get('/api/account')).json()).shortNames.find((x) => x.name === short).calendarId;
  await row.getByTestId('short-change').click();
  await row.getByTestId('short-remap').selectOption(hockey);
  expect(await target()).toBe(calendarId);                                    // picking alone moves nothing
  await row.getByTestId('short-remap-cancel').click();
  await expect(row.getByTestId('short-pick')).toBeHidden();
  expect(await target()).toBe(calendarId);
  await row.getByTestId('short-change').click();
  await expect(row.getByTestId('short-remap-save')).toBeDisabled();           // same calendar: nothing to save
  await row.getByTestId('short-remap').selectOption(hockey);
  await row.getByTestId('short-remap-save').click();
  await expect(page.getByTestId('short-ok')).toHaveText(`pastecal.com/${short} now opens Hockey.`);
  await expect(page.getByTestId('short-row').filter({ hasText: short })).toContainText('→ Hockey');
  expect(await target()).toBe(hockey);
  // Its page: static, so the app names the tab after the calendar once it loads.
  await page.goto(`/${short}`);
  await expect(page).toHaveTitle('Hockey · pastecal', { timeout: 20_000 });
  await ctx.close();
});

test('a deleted account\'s short link opens "This link has ended", never a calendar anyone can edit', async ({ browser, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
  const post = async (path, body, headers = {}) => api.post(path, { data: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
  const who = `gone-${run}@example.com`, cal = `gone-cal-${run}`, short = `gone-${run}`.slice(0, 30);
  await post('/api/auth/start', { email: who });
  const mail = (await (await api.get(`/api/admin/accounts/outbox?email=${encodeURIComponent(who)}`, { headers: { Authorization: `Bearer ${SECRET}` } })).json()).emails.at(-1);
  expect((await post('/api/auth/verify', { token: mail.text.match(/#t=([A-Za-z0-9_-]+)/)[1] })).status()).toBe(200);
  const userId = (await (await api.get(`/api/admin/accounts/lookup?email=${encodeURIComponent(who)}`, { headers: { Authorization: `Bearer ${SECRET}` } })).json()).user.id;
  const sub = { id: `sub_gone_${run}`, object: 'subscription', status: 'active', customer: `cus_gone_${run}`, metadata: { plan: 'unlimited', user_id: userId }, created: Math.floor(Date.now() / 1000),
    items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400, price: { id: 'price_fake_unl_yearly', recurring: { interval: 'year' } } }] } };
  const hook = async (type, object) => { const body = JSON.stringify({ id: `evt_gone_${run}_${type}`, object: 'event', type, data: { object } });
    expect((await api.post('/api/stripe/webhook', { data: body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) } })).status()).toBe(200); };
  fake.subs.set(sub.id, sub);
  await hook('customer.subscription.created', { id: sub.id });
  expect((await api.post(`/cal/${cal}`, { data: JSON.stringify({ title: 'Tigers U10', options: {}, events: [], author: `gone-author-${run}` }) })).status()).toBe(201);
  expect((await post('/api/pro/lock', { calendarId: cal, author: `gone-author-${run}` })).status()).toBe(200);   // its creator's browser
  expect((await post('/api/names/short', { name: short, calendarId: cal })).status()).toBe(200);
  const ended = { ...sub, status: 'canceled' }; fake.subs.set(sub.id, ended);
  await hook('customer.subscription.deleted', ended);
  // Deleting from /account: it says what becomes of each thing, and lists every calendar's edit link to keep.
  const state = await api.storageState();
  await api.dispose();
  const own = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: state });
  await own.routeWebSocket((url) => !/localhost|127\.0\.0\.1/.test(String(url)), (ws) => ws.close());
  const op = await own.newPage();
  await op.goto('/account');
  await op.getByTestId('delete-open').click();
  await expect(op.getByTestId('delete-confirm')).toBeVisible();
  await expect(op.locator('#delPaused')).toContainText('Paused calendars stay read-only for good');
  await expect(op.locator('#delShort')).toContainText('This link has ended');
  await expect(op.locator('#delAt')).toBeHidden();                          // no @name on this account
  await expect(op.getByTestId('delete-cal')).toHaveCount(1);
  await expect(op.getByTestId('delete-cal')).toContainText('Paused: stays read-only');
  await expect(op.getByTestId('delete-cal-link')).toHaveText(`pastecal.com/${cal}`);
  await op.getByTestId('delete-input').fill('delete');
  await op.getByTestId('delete-go').click();
  await expect(op.getByTestId('account-deleted')).toBeVisible();
  await own.close();

  const { ctx, page } = await newPage(browser);
  await page.goto(`/${short}`);
  await page.waitForURL(new RegExp(`/link-ended/${short}$`), { timeout: 20_000 });
  await expect(page.getByTestId('link-ended')).toHaveText('This link has ended');
  expect(await page.content()).not.toContain('Tigers');
  await ctx.close();
});
