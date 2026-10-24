// Browser walkthrough of Pro against a local Worker wired to the REAL Stripe sandbox (test mode).
// Same setup as stripe-sandbox-e2e.mjs (wrangler dev on 8850 + stripe listen). Never production.
// Run: NODE_PATH=<repo>/node_modules node test/pro-browser-e2e.mjs [screenshot dir]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.NODE_PATH + '/x')('playwright');

const BASE = process.env.BASE || 'http://localhost:8850', SECRET = 'dev-secret', OUT = process.argv[2] || '/tmp';
const H = { Origin: BASE, 'Content-Type': 'application/json' };
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 45000, every = 1000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every); } }
const admin = (p) => fetch(BASE + p, { headers: { Authorization: `Bearer ${SECRET}` } }).then((r) => r.json());
const stripeJson = (args) => JSON.parse(execFileSync('stripe', args, { encoding: 'utf8' }).replace(/^[^{]*/, ''));
const vm = (page, fn, arg) => page.evaluate(([src, a]) => {
    const el = [...document.querySelectorAll('*')].find((e) => e.__vue_app__); const app = el.__vue_app__;
    const v = app._instance?.proxy || app._container._vnode.component.proxy; return new Function('vm', 'a', src)(v, a);
}, [fn, arg]);

const run = Date.now().toString(36), cal = `ui-pro-${run}`, email = `owner-${run}@example.com`;
let r = await fetch(`${BASE}/cal/${cal}`, { method: 'POST', body: JSON.stringify({ title: 'Robotics club', events: [
    { id: 'e1', title: 'Build night', start: new Date(Date.now() + 864e5).toISOString().slice(0, 10) + 'T01:00:00.000Z', end: new Date(Date.now() + 864e5).toISOString().slice(0, 10) + 'T03:00:00.000Z', type: 1 }] }) });
assert.equal(r.status, 201);

const browser = await chromium.launch();
const ctx = (o = {}) => browser.newContext({ viewport: { width: 1280, height: 800 }, ...o });
const owner = await ctx(); const op = await owner.newPage();
await op.goto(`${BASE}/${cal}?backend=cf`); await op.waitForTimeout(3000);

// 1. Owner signs in first (a returning owner, from the logo menu's "Pro owner? Sign in"). Signed-out
//    buyers pay first instead (no email step): walked separately, see docs (pay-first walkthrough).
await vm(op, 'vm.showShare = true'); await op.waitForTimeout(600);
await op.locator('[data-testid=pro-panel]').waitFor({ timeout: 15000 });
await op.screenshot({ path: `${OUT}/1-share-offer.png` });
await fetch(`${BASE}/api/auth/start`, { method: 'POST', headers: H, body: JSON.stringify({ email, next: '/' + cal }) });
const mail = (await admin(`/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).emails.at(-1);
const token = mail.text.match(/#t=([A-Za-z0-9_-]+)/)[1];
await op.goto(`${BASE}/signin#t=${token}`);
await op.locator('#confirm').click({ timeout: 10000 });          // the page asks "Sign in to pastecal as <email>?" first
await op.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 20000 });
assert.ok(!(await op.evaluate(() => location.hash)).includes('t='), 'token left in URL');
step('owner got the sign-in email, the link signed them in and brought them back');

// 2. Lock this calendar -> real Stripe Checkout
await op.goto(`${BASE}/${cal}?backend=cf`); await op.waitForTimeout(3000);
await vm(op, 'vm.showShare = true'); await op.waitForTimeout(800);
await op.locator('[data-testid=pro-lock-btn]').click();
await op.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
await op.waitForTimeout(3000); await op.screenshot({ path: `${OUT}/2-stripe-checkout.png` });
step('"Lock this calendar" opened the real Stripe Checkout page');

// 3. Pay (test card via API: Checkout keeps card fields in a secure iframe), then the webhook locks it
const ownerId = (await admin(`/api/admin/accounts/lookup?email=${encodeURIComponent(email)}`)).user.id;
const cust = stripeJson(['customers', 'create', '--email', email, '-d', 'payment_method=pm_card_visa', '-d', 'invoice_settings[default_payment_method]=pm_card_visa']);
const sub = stripeJson(['subscriptions', 'create', '--customer', cust.id, '-d', 'items[0][price]=price_1UTr8UEPgWTHeJ7W3PQwUvXH', '-d', `metadata[calendar_id]=${cal}`, '-d', `metadata[user_id]=${ownerId}`]);
assert.equal(sub.status, 'active');
await op.goto(`${BASE}/pro/done#${encodeURIComponent(cal)}`);
const doneKey = await until(async () => { const t = await op.locator('[data-testid=pro-editor-link], input').first().inputValue().catch(() => ''); return /#k=/.test(t) ? t : null; }, 40000);
await op.screenshot({ path: `${OUT}/3-pro-done.png` });
assert.ok(doneKey, '/pro/done never showed an editor link');
step(`paid (yearly, test card); /pro/done shows "Pro is on" and the first editor link`);

// 4. Owner view: lock badge, owner panel
await op.goto(`${BASE}/${cal}?backend=cf`); await op.waitForTimeout(3500);
const badge = op.locator('[data-testid=lock-badge]').filter({ visible: true }).first(); await badge.waitFor({ timeout: 15000 });
assert.equal(await vm(op, 'return !vm.isReadOnly'), true, 'owner should be able to edit');
await vm(op, 'vm.showShare = true'); await op.waitForTimeout(1200);
assert.match(await op.locator('[data-testid=pro-panel]').innerText(), /Locked with Pro/);
await op.screenshot({ path: `${OUT}/4-owner-panel.png` });
step('owner: lock badge shown, can edit, share panel says "Locked with Pro"');

// 5. Visitor: read-only, lock badge, Locked pill
const visitor = await ctx(); const vp = await visitor.newPage();
await vp.goto(`${BASE}/${cal}?backend=cf`); await vp.waitForTimeout(3500);
assert.equal(await vm(vp, 'return vm.isReadOnly'), true, 'visitor should be read-only');
await vp.locator('[data-testid=lock-badge]').filter({ visible: true }).first().waitFor({ timeout: 10000 });
await vp.screenshot({ path: `${OUT}/5-visitor.png` });
step('visitor with the edit name: read-only, sees the lock badge');

// 6. Editor via editor link: can add an event that reaches the server
const editor = await ctx(); const ep = await editor.newPage();
const key = doneKey.split('#k=')[1];
await ep.goto(`${BASE}/${cal}?backend=cf#k=${key}`); await ep.waitForTimeout(4000);
assert.ok(!(await ep.evaluate(() => location.hash)).includes('k='), 'editor key left in the URL');
assert.equal(await vm(ep, 'return !vm.isReadOnly'), true, 'editor should be able to edit');
const before = (await (await fetch(`${BASE}/cal/${cal}`)).json()).calendar.events.length;
await ep.evaluate(() => { const el = [...document.querySelectorAll('*')].find((e) => e.__vue_app__); const a = el.__vue_app__; (a._instance?.proxy || a._container._vnode.component.proxy); });
await vm(ep, `const d = new Date(Date.now() + 2*864e5); window.scheduleObj.addEvent({ Id: 'ed-' + Date.now(), Subject: 'Added by editor', StartTime: d, EndTime: new Date(+d + 36e5), IsAllDay: false });`);
const after = await until(async () => { const c = (await (await fetch(`${BASE}/cal/${cal}`)).json()).calendar; return c.events.some((e) => e.title === 'Added by editor') ? c.events.length : null; }, 20000);
assert.ok(after && after === before + 1, 'editor event never reached the server');
await ep.screenshot({ path: `${OUT}/6-editor.png` });
step('editor link: key moved out of the URL, can edit, the new event reached the server');

// 7. Manage billing -> real Stripe portal
await vm(op, 'vm.showShare = true'); await op.waitForTimeout(800);
await op.getByRole('button', { name: /manage billing/i }).click();
await op.waitForURL(/billing\.stripe\.com/, { timeout: 30000 });
await op.waitForTimeout(2500); await op.screenshot({ path: `${OUT}/7-portal.png` });
step('"Manage billing" opened the real Stripe customer portal');

// 8. Cancel -> the visitor's open page unlocks live
execFileSync('stripe', ['subscriptions', 'cancel', sub.id, '--confirm'], { stdio: 'ignore' });
const unlocked = await until(async () => (await vm(vp, 'return !vm.isReadOnly')) ? true : null, 45000);
assert.ok(unlocked, 'visitor page never unlocked after cancel');
await vp.screenshot({ path: `${OUT}/8-visitor-after-cancel.png` });
step('cancelled in Stripe: the visitor\'s open page became editable without a reload');

await browser.close(); console.log(`\n${n} checks passed`); process.exit(0);
