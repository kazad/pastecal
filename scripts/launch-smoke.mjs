// Launch smoke test: opens the live site the way people do, desktop and phone, and checks it is the
// code that was tested. Read-only: it never presses Save & share, never posts a form, and blocks
// analytics (GA, Clarity, Hotjar, /api/collect) so it is not counted as traffic.
//
//   node scripts/launch-smoke.mjs                         # https://pastecal.com
//   node scripts/launch-smoke.mjs --base https://preview.pastecal.com --billing any
//   options: --base URL  --view demo (an existing view-only name)  --billing off|on|any
//
// Checks:
//   1. The deployed static files are byte-identical to this checkout (index.html, pricing.html, app.js).
//   2. Homepage (desktop + phone): the calendar renders, the plan cards show this checkout's prices,
//      no page errors.
//   3. /pricing: renders with the same prices; the purchase button matches /api/pro/config.
//   4. A view-only calendar: events render, no editing UI, no edit id in the page; its .ics is a calendar.
//   5. /help, /about, /contact, /privacy, /terms load with the shared footer.
// Exit code 0 when everything passed.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'https://pastecal.com').replace(/\/$/, '');
const VIEW = arg('--view', 'demo');
const BILLING = arg('--billing', 'off');
let playwright;
for (const p of [join(root, 'node_modules/playwright'), '/Users/kazad/Dropbox/computer/Projects/pastecal/node_modules/playwright']) {
    try { playwright = require(p); break; } catch (e) { /* next */ }
}
if (!playwright) { console.error('playwright not found (npm i playwright, or run from the main checkout)'); process.exit(2); }

let failed = 0;
const ok = (c, msg, extra = '') => { console.log(`${c ? '  PASS' : '  FAIL'}  ${msg}${extra ? '  ' + extra : ''}`); if (!c) failed++; };
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);

// Prices a visitor should see, read from this checkout's pricing page ("$29" style amounts on the plan cards).
const pricingSrc = readFileSync(join(root, 'public/pricing.html'), 'utf8');
const cardPrices = [...pricingSrc.matchAll(/<div class="price"><strong>(\$[\d,]+)<\/strong>/g)].map((m) => m[1]);

console.log(`launch smoke: ${BASE}  (view: ${VIEW}, billing expected: ${BILLING})`);

// 1. The deployed files are this checkout's.
for (const f of ['index.html', 'pricing.html', 'app.js']) {
    const local = readFileSync(join(root, 'public', f));
    const r = await fetch(`${BASE}/${f === 'index.html' ? '' : f}`, { headers: { 'Cache-Control': 'no-cache' } });
    const live = Buffer.from(await r.arrayBuffer());
    ok(r.ok && sha(live) === sha(local), `deployed ${f} matches this checkout`, r.ok ? `(live ${sha(live)}, local ${sha(local)})` : `(HTTP ${r.status})`);
}
const cfg = await (await fetch(`${BASE}/api/pro/config`)).json().catch(() => null);
ok(cfg && typeof cfg.billing === 'boolean' && (BILLING === 'any' || cfg.billing === (BILLING === 'on')), `/api/pro/config billing is ${BILLING}`, JSON.stringify(cfg));

const browser = await playwright.chromium.launch();
const TRACKERS = /googletagmanager\.com|google-analytics\.com|clarity\.ms|hotjar\.com|\/api\/collect/;
async function visit(path, { viewport = { width: 1440, height: 900 }, mobile = false } = {}) {
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, timezoneId: 'America/New_York' });
    await ctx.route(TRACKERS, (r) => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(BASE + path + (path.includes('?') ? '&' : '?') + 'no-analytics', { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors, status: res ? res.status() : 0 };
}

// 2. Homepage, desktop and phone.
for (const [label, opts] of [['desktop', {}], ['phone', { viewport: { width: 390, height: 844 }, mobile: true }]]) {
    const { ctx, page, errors, status } = await visit('/', opts);
    const cal = await page.waitForFunction(() => window.scheduleObj && document.querySelector('.e-schedule .e-work-cells'), null, { timeout: 20000 }).then(() => true, () => false);
    ok(status === 200 && cal, `homepage (${label}) renders the calendar`);
    const text = await page.locator('#how').innerText().catch(() => '');
    const missing = cardPrices.filter((p) => !text.includes(p));
    ok(cardPrices.length > 0 && missing.length === 0, `homepage (${label}) plan cards show this checkout's prices`, missing.length ? `missing ${missing.join(', ')}` : cardPrices.join(' '));
    ok(errors.length === 0, `homepage (${label}) has no page errors`, errors.slice(0, 2).join(' | '));
    await ctx.close();
}

// 3. Pricing.
{
    const { ctx, page, errors, status } = await visit('/pricing');
    await page.waitForFunction(() => document.documentElement.dataset.billing !== 'pending', null, { timeout: 10000 }).catch(() => {});
    const body = await page.locator('body').innerText();
    const missing = cardPrices.filter((p) => !body.includes(p));
    ok(status === 200 && missing.length === 0, '/pricing shows every plan price', missing.join(', '));
    const mode = await page.evaluate(() => document.documentElement.dataset.billing);
    ok(!cfg || mode === (cfg.billing ? 'on' : 'off'), `/pricing purchase mode follows the server (${mode})`);
    ok(errors.length === 0, '/pricing has no page errors', errors.slice(0, 2).join(' | '));
    await ctx.close();
}

// 4. A view-only calendar and its feed.
{
    const { ctx, page, errors, status } = await visit(`/view/${encodeURIComponent(VIEW)}`, { viewport: { width: 390, height: 844 }, mobile: true });
    const rendered = await page.waitForFunction(() => window.scheduleObj && (scheduleObj.eventsData || []).length > 0, null, { timeout: 20000 }).then(() => true, () => false);
    ok(status === 200 && rendered, `/view/${VIEW} renders its events (phone)`);
    ok(await page.getByRole('button', { name: /Add event/ }).locator('visible=true').count() === 0, `/view/${VIEW} shows no Add event`);
    const html = await page.content();
    const lookup = await (await fetch(`${BASE}/api/lookup?slug=${encodeURIComponent(VIEW)}`)).json().catch(() => ({}));
    ok(!lookup.targetId || !html.includes(lookup.targetId), `/view/${VIEW} page holds no edit id`);
    ok(errors.length === 0, `/view/${VIEW} has no page errors`, errors.slice(0, 2).join(' | '));
    await ctx.close();
    const ics = await fetch(`${BASE}/view/${encodeURIComponent(VIEW)}.ics`);
    const t = await ics.text();
    ok(ics.ok && /BEGIN:VCALENDAR/.test(t) && /text\/calendar/.test(ics.headers.get('content-type') || ''), `/view/${VIEW}.ics is a calendar feed`);
}

// 5. Site pages.
for (const p of ['/help', '/about', '/contact', '/privacy', '/terms']) {
    const { ctx, page, errors, status } = await visit(p);
    const footer = await page.locator('footer.site-footer').count();
    ok(status === 200 && footer === 1 && errors.length === 0, `${p} loads with the shared footer`, errors.slice(0, 1).join(''));
    await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall smoke checks passed');
process.exit(failed ? 1 : 0);
