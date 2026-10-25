// @ts-check
/**
 * The Plus tab, driven like a person, with billing ON (fake Stripe from test/fake-stripe.mjs on FAKE_PORT, 8832):
 *   - a free calendar's editor sees what Plus adds, one primary "Start 30-day free trial" and a small checkout link;
 *   - its owner sees the plan line, who can edit and the editor link, "If your plan ends", Manage billing, and
 *     "sign in on any device", with no "Pro" anywhere for a Plus calendar;
 *   - an editor-link holder and a visitor never see the owner's controls, and can't reach billing;
 *   - the creator's browser can undo someone else's upgrade for 7 days; a stranger's browser sees nothing;
 *   - the trial reminder's Keep link works signed out (sign in, then back on Keep).
 * One `wrangler dev`, from cloudflare/ (as trial.test.mjs), fake values only:
 *   node node_modules/.bin/wrangler dev --port 8826 --persist-to <dir> --var COPY_BACK: --var FIREBASE_DB_URL: \
 *     --var IMPORT_SECRET:dev-secret --var ACCOUNTS_DEV_MODE:1 --var STRIPE_SECRET_KEY:fake-stripe-key \
 *     --var STRIPE_WEBHOOK_SECRET:fake-webhook-secret --var STRIPE_PRICE_PRO_YEARLY:price_fake_yearly \
 *     --var STRIPE_PRICE_PRO_MONTHLY:price_fake_monthly --var STRIPE_API_BASE:http://127.0.0.1:8832/stripe
 *   BASE_URL=http://localhost:8826 npx playwright test -c cloudflare/playwright.config.js plus-tab
 * Each test skips on a server without billing. Browsers get a fixed author uid (AuthorSignal.uid), standing in
 * for the anonymous Firebase sign-in that tests block.
 */
const { test, expect, request: playwrightRequest } = require('@playwright/test');

const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const run = Date.now().toString(36);
let fake, ipN = 0;

test.beforeAll(async () => {
  const { startFakeStripe } = await import('./fake-stripe.mjs');
  fake = await startFakeStripe(Number(process.env.FAKE_PORT || 8832));
});
test.afterAll(async () => { if (fake) fake.close(); });

const base = () => test.info().project.use.baseURL;
const billingOf = async (request) => (await (await request.get('/api/pro/config')).json()).billing;
const H = () => ({ Origin: base(), 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.77.${Math.floor(++ipN / 200)}.${ipN % 200}` });
const post = (request, path, data, cookie) => request.post(path, { data, headers: { ...H(), ...(cookie ? { Cookie: cookie } : {}) } });
const admin = (request, path, data) => (data ? request.post(path, { data, headers: { Authorization: `Bearer ${SECRET}` } }) : request.get(path, { headers: { Authorization: `Bearer ${SECRET}` } }));

async function newCalendar(request, author, title = 'Soccer team') {
  const id = `plus-${run}-${Math.floor(Math.random() * 1e6)}`;
  const d = new Date(); d.setDate(9); d.setHours(17, 0, 0, 0);
  const events = [{ id: 'e1', title: 'Practice', start: d.toISOString(), end: new Date(d.getTime() + 3600e3).toISOString(), type: 1 }];
  const r = await request.post(`/cal/${id}`, { data: { title, events, author }, headers: { 'CF-Connecting-IP': `10.78.${Math.floor(++ipN / 200)}.${ipN % 200}` } });
  expect(r.status()).toBe(201);
  return id;
}
async function signIn(request, email) {
  await post(request, '/api/auth/start', { email });
  const mails = (await (await admin(request, `/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).json()).emails;
  const token = mails.at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
  const r = await post(request, '/api/auth/verify', { token });
  const cookie = r.headers()['set-cookie'].split(';')[0];
  return { cookie, value: cookie.split('=')[1] };
}
// A browser with a fixed author uid and, optionally, a signed-in session.
// authorDelay: the uid appears only after that many ms, as a real anonymous sign-in does on a fresh page load.
async function open(browser, path, { author, session, authorDelay = 0, viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 600 });
  if (session) await ctx.addCookies([{ name: 'pc_session', value: session, url: base() }]);
  await ctx.addInitScript(([uid, delay]) => {
    window.__TEST__ = true;
    if (!uid) return;
    const ready = Date.now() + delay;
    const t = setInterval(() => { try { if (typeof AuthorSignal !== 'undefined') { AuthorSignal.uid = () => (Date.now() >= ready ? uid : null); clearInterval(t); } } catch (e) { /* not yet */ } }, 5);
  }, [author || null, authorDelay]);
  await ctx.route('**/*', (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto('/?backend=cf');
  const [p0, hash] = path.split('#');
  await page.goto(p0 + (p0.includes('?') ? '&' : '?') + 'backend=cf' + (hash ? '#' + hash : ''));
  await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view'), null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  return { ctx, page };
}
const vm = (page, js) => page.evaluate(`(() => { const vm = document.querySelector('#app')._vnode.component.proxy; ${js} })()`);
const plusPanel = (page) => page.getByTestId('plus-panel');
// An upgraded calendar: made by `author`, trialed by a signed-in owner using that browser's uid.
async function trialCalendar(request, label) {
  const author = `auth-${label}-${run}`;
  const id = await newCalendar(request, author);
  const owner = await signIn(request, `${label}-${run}@example.com`);
  expect((await post(request, '/api/pro/trial', { calendarId: id, author }, owner.cookie)).status()).toBe(200);
  return { id, author, owner };
}

test('free editor, billing on: Plus adds a short list, one primary trial button, a small checkout link', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const author = `auth-free-${run}`;
  const id = await newCalendar(request, author);
  const { ctx, page } = await open(browser, `/${id}`, { author });
  await page.getByTestId('share-pill-more').click();
  await page.getByTestId('side-tab-plus').click();
  const tab = plusPanel(page);
  await expect(tab.getByRole('heading', { name: /Upgrade this calendar/ })).toBeVisible();
  await expect(tab.getByTestId('plus-features').locator('li')).toHaveText([/Choose who edits/, /name is reserved/, /Full stats/, /History/]);
  await expect(tab.getByText('Coming: subcalendars.')).toBeVisible();
  await expect(tab.locator('.pc-btn--primary')).toHaveCount(1);
  await expect(tab.getByTestId('pro-trial-btn')).toHaveText('Start 30-day free trial');
  await expect(tab.getByTestId('pro-lock-btn')).toHaveText('upgrade now: $29/year');
  await expect(tab.getByTestId('pro-lock-btn')).not.toHaveClass(/pc-btn--primary/);
  // Signed out, the trial asks for an email first; the link it sends starts it.
  await tab.getByTestId('pro-trial-btn').click();
  await expect(tab.getByTestId('pro-trial-email-form')).toBeVisible();
  // Six tabs fit a phone too.
  await ctx.close();
  const phone = await open(browser, `/${id}`, { author, viewport: { width: 390, height: 844 } });
  await phone.page.getByTestId('share-button-mobile').click();
  const row = await phone.page.$eval('.pc-side-tabs', (e) => [e.scrollWidth, e.clientWidth]);
  expect(row[0], 'six tabs fit at 390px').toBeLessThanOrEqual(row[1]);
  await expect(phone.page.getByTestId('side-tab-plus')).toBeVisible();
  await phone.ctx.close();
});

test('signed out, the creator starts the trial by email: the link signs in, and the calendar page starts it once its uid is ready', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const author = `auth-link-${run}`, email = `linktrial-${run}@example.com`;
  const id = await newCalendar(request, author);
  const { ctx, page } = await open(browser, `/${id}`, { author, authorDelay: 1500 });
  await vm(page, "vm.openPlusTab('share')");
  await plusPanel(page).getByTestId('pro-trial-btn').click();
  await plusPanel(page).locator('#pc-pro-trial-email').fill(email);
  await plusPanel(page).getByRole('button', { name: 'Send link' }).click();
  await expect(plusPanel(page).getByTestId('pro-trial-sent')).toBeVisible();
  const mails = (await (await admin(request, `/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).json()).emails;
  const link = mails.at(-1).text.match(/https?:\/\/\S+\/signin#t=[A-Za-z0-9_-]+/)[0].replace(/^https?:\/\/[^/]+/, '');
  await page.goto(link);
  await expect(page.locator('#confirm')).toHaveText('Start my trial');
  await expect(page.locator('#msg')).toContainText('and start your free 30-day Plus trial?');
  await page.locator('#confirm').click();
  await page.waitForURL(new RegExp(`/${id}`));
  // The page loads with no uid for 1.5s (the anonymous sign-in restoring); the trial still starts, as its creator.
  await expect(page.getByTestId('pro-trial-line').filter({ visible: true })).toHaveText(/^Plus trial · (30|29) days left$/, { timeout: 20_000 });
  expect((await (await request.get(`/api/pro/status?calendar=${id}`)).json()).locked).toBe(true);
  await ctx.close();
});

test('a browser that never edited it can\'t start the trial: the server says how to upgrade', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const id = await newCalendar(request, `auth-maker-${run}`);
  const someone = await signIn(request, `someone-${run}@example.com`);
  const { ctx, page } = await open(browser, `/${id}`, { author: `auth-stranger-${run}`, session: someone.value });
  await vm(page, "vm.openPlusTab('share')");
  await plusPanel(page).getByTestId('pro-trial-btn').click();
  await expect(plusPanel(page).getByTestId('pro-error')).toHaveText('To upgrade, use a device you’ve edited this calendar on, or ask the person who runs it.');
  expect((await (await request.get(`/api/pro/status?calendar=${id}`)).json()).locked).toBe(false);
  await ctx.close();
});

test('owner of a Plus calendar: plan line, who can edit, if it ends, billing, any device; never the word "Pro"', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const { id, author, owner } = await trialCalendar(request, 'owner');
  const { ctx, page } = await open(browser, `/${id}`, { author, session: owner.value });
  await expect(page.getByTestId('lock-badge').filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('[role="status"], .pc-toast').filter({ hasText: 'Upgraded with Plus' }).first()).toBeVisible();   // the first-visit toast
  await vm(page, "vm.openPlusTab('share')");
  const tab = plusPanel(page);
  await expect(tab.getByTestId('pro-owner-title')).toHaveText(/Upgraded with Plus/);
  await expect(tab.getByTestId('pro-trial-line')).toHaveText(/^Plus trial · (30|29) days left$/);
  await expect(tab.getByTestId('pro-keep-trial')).toHaveText('Keep Plus');
  await expect(tab.getByTestId('plus-editors')).toContainText('Who can edit');
  await tab.getByTestId('pro-key-btn').click();                                   // confirm() accepted
  await expect(tab.getByTestId('pro-editor-link')).toHaveValue(new RegExp(`/${id}#k=`));
  await expect(tab.getByTestId('pro-lapse-choice')).toContainText('If your plan ends');
  await expect(tab.getByTestId('pro-lapse-choice').locator('input[value=open]')).toBeChecked();   // a trial ends open unless you choose
  await expect(tab.getByTestId('pro-billing-btn')).toHaveText('Manage billing');
  await expect(tab.getByTestId('plus-any-device')).toContainText('sign in with your email on any device');
  // No "Pro" in the owner's UI for a Plus calendar: the panel, the tab row, Activity, the logo menu.
  await expect(tab).not.toContainText(/\bPro\b/);
  await expect(page.locator('.pc-side-tabs')).not.toContainText(/\bPro\b/);
  await page.getByTestId('side-tab-changes').click();
  await expect(page.getByTestId('side-panel')).not.toContainText(/\bPro\b/);
  await expect(page.getByTestId('recent-history-link')).toContainText('Plus');
  // Share points to Plus for editor links; the plain URL isn't called an edit link once locked.
  await page.getByTestId('side-tab-share').click();
  await expect(page.getByTestId('share-helpers')).toContainText('Calendar link');
  await expect(page.getByTestId('share-helpers')).not.toContainText('can edit');
  await expect(page.getByTestId('share-plus-line')).toContainText('Editor links and billing are in');
  await ctx.close();
});

test('an editor-link holder and a visitor never see the owner\'s controls, and can\'t reach billing', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const { id, owner } = await trialCalendar(request, 'locked');
  const link = await (await post(request, '/api/pro/editor-links', { calendarId: id, label: 'Coach' }, owner.cookie)).json();
  expect(link.url_fragment_key).toBeTruthy();
  const ownerOnly = ['pro-billing-btn', 'pro-key-btn', 'pro-editor-link', 'pro-lapse-choice', 'plus-editors', 'pro-keep-trial'];

  const helper = await open(browser, `/${id}#k=${link.url_fragment_key}`, { author: `auth-helper-${run}` });
  await expect.poll(() => vm(helper.page, 'return !vm.isReadOnly')).toBe(true);             // the editor link edits
  await helper.page.getByTestId('share-pill-more').click();
  await helper.page.getByTestId('side-tab-plus').click();
  const t = plusPanel(helper.page);
  await expect(t.getByRole('heading', { name: 'This calendar is locked' })).toBeVisible();
  await expect(t.getByTestId('pro-owner-signin')).toBeVisible();
  for (const tid of ownerOnly) await expect(t.getByTestId(tid)).toHaveCount(0);
  await helper.ctx.close();

  const visitor = await open(browser, `/${id}`, { author: `auth-visitor-${run}` });
  await expect(visitor.page.getByTestId('side-tab-plus')).toHaveCount(0);                  // no tab row for a view
  await vm(visitor.page, "vm.openPlusTab('share')");
  for (const tid of ownerOnly) await expect(plusPanel(visitor.page).getByTestId(tid)).toHaveCount(0);
  await visitor.ctx.close();

  // Billing is the owner account's only: signed out 401; another account has no billing for this calendar (404).
  // Fresh request contexts: the shared one keeps the cookies of every sign-in above.
  const fresh = () => playwrightRequest.newContext({ baseURL: base() });
  const anon = await fresh();
  expect((await post(anon, '/api/pro/portal', { calendarId: id })).status()).toBe(401);
  const otherCtx = await fresh();
  const other = await signIn(otherCtx, `other-${run}@example.com`);
  expect((await post(otherCtx, '/api/pro/portal', { calendarId: id }, other.cookie)).status()).toBe(404);
  expect((await post(otherCtx, '/api/pro/editor-key', { calendarId: id }, other.cookie)).status()).toBe(403);
  expect((await post(otherCtx, '/api/pro/lapsed-mode', { calendarId: id, mode: 'open' }, other.cookie)).status()).toBe(403);
  await anon.dispose(); await otherCtx.dispose();
});

test('someone else upgraded it: the creator\'s browser can undo it for 7 days; a stranger\'s browser sees nothing', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const creator = `auth-creator-${run}`, helperUid = `auth-2nd-${run}`;
  const id = await newCalendar(request, creator);
  // A helper's browser that edited it on two days upgrades it.
  const h = await open(browser, `/${id}`, { author: helperUid });
  await h.page.locator('.e-appointment:has-text("Practice")').first().dblclick();
  const dialog = h.page.locator('.e-dialog.e-schedule-dialog');
  await dialog.locator('input.e-subject').fill('Practice (field 3)');
  await dialog.locator('button.e-event-save').click();
  await expect.poll(async () => (await (await request.get(`/cal/${id}`)).json()).calendar.events[0].title).toBe('Practice (field 3)');
  await h.ctx.close();
  expect((await admin(request, `/cal/${id}/authors`, { uid: helperUid, day: '2026-01-04' })).status()).toBe(200);
  const helperAcct = await signIn(request, `helper-${run}@example.com`);
  expect((await post(request, '/api/pro/trial', { calendarId: id, author: helperUid }, helperAcct.cookie)).status()).toBe(200);

  const stranger = await open(browser, `/${id}`, { author: `auth-nobody-${run}` });
  await expect(stranger.page.getByTestId('lock-badge').filter({ visible: true }).first()).toBeVisible();
  await stranger.page.waitForTimeout(1500);
  await expect(stranger.page.getByTestId('upgrade-notice')).toHaveCount(0);
  await stranger.ctx.close();

  const mine = await open(browser, `/${id}`, { author: creator });
  const notice = mine.page.getByTestId('upgrade-notice');
  await expect(notice).toContainText(/Someone upgraded this calendar on .+\. Not expected\?/);
  await notice.getByTestId('upgrade-undo').click();                                       // confirm() accepted
  await expect(notice).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/api/pro/status?calendar=${id}`)).json()).locked).toBe(false);
  await expect.poll(() => vm(mine.page, 'return !vm.isReadOnly')).toBe(true);             // editable again for everyone
  await mine.ctx.close();
});

test('the reminder\'s Keep link, signed out: the owner signs in from the Plus tab and the link comes back to Keep', async ({ browser, request }) => {
  test.skip(await billingOf(request) !== true, 'needs a server with (fake) Stripe vars');
  const { id, author } = await trialCalendar(request, 'keeper');
  const { ctx, page } = await open(browser, `/${id}?pro=keep`, { author });
  const tab = plusPanel(page);
  await expect(tab.locator('#pc-pro-email-input2')).toBeVisible();                        // straight to the sign-in form
  await tab.locator('#pc-pro-email-input2').fill(`keeper-${run}@example.com`);
  await tab.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(tab.getByText('Check your email for a sign-in link.')).toBeVisible();
  const mails = (await (await admin(request, `/api/admin/accounts/outbox?email=${encodeURIComponent(`keeper-${run}@example.com`)}`)).json()).emails;
  const token = mails.at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
  const verified = await (await post(request, '/api/auth/verify', { token })).json();
  expect(verified.next).toBe(`/${id}?pro=keep`);
  await ctx.close();
  // Signed in, the same link opens on the $29 Keep button.
  const owner = await signIn(request, `keeper-${run}@example.com`);
  const back = await open(browser, `/${id}?pro=keep`, { author, session: owner.value });
  await expect(plusPanel(back.page).getByTestId('pro-keep-checkout')).toHaveText('Keep Plus');
  await back.ctx.close();
});
