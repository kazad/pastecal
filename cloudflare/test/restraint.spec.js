// @ts-check
/**
 * Design restraint budget (docs/DESIGN-RESTRAINT.md). On the key pages, what is in the FIRST screen is counted, and
 * the counts may only go down: filled buttons (one loud action), accent-colored links, chips and badges, and words
 * outside the calendar grid. A change that adds noise fails here and has to argue its case (raise a budget in the doc
 * and here, with the reason). Owner, Oct 26 2026: "how do I make pastecal have more design restraint".
 * Needs `wrangler dev` on BASE_URL (scripts/test-browser.sh).
 */
const { test, expect } = require('@playwright/test');
const { NOT_LOCAL } = require('./helpers');

const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const MEASURE_ONLY = !!process.env.RESTRAINT_MEASURE;

/** What the first screen holds. Calendar grids (classic and native) are content, not chrome: their words don't count. */
async function loudness(page) {
  return page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const seen = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
    const grid = (el) => !!el.closest('.e-schedule .e-table-container, .e-schedule .e-content-wrap, .nc-grid-scroll, .nc-month, .nc-allday, .pc-print-only');
    const rgb = (c) => (c.match(/\d+(\.\d+)?/g) || []).slice(0, 4).map(Number);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('span'); document.body.appendChild(probe);
    probe.style.color = 'var(--pc-link)'; const link = getComputedStyle(probe).color;
    probe.style.color = 'var(--pc-primary)'; const primary = getComputedStyle(probe).color; probe.remove();
    const same = (a, b) => { const x = rgb(a), y = rgb(b); return x.length >= 3 && y.length >= 3 && Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 12 && (x[3] === undefined || x[3] > 0.5); };
    const all = [...document.querySelectorAll('body *')].filter((el) => !el.closest('[hidden], template, script, style') && seen(el));
    const clickable = all.filter((el) => el.matches('a[href], button, [role=button], [role=tab]'));
    const filled = clickable.filter((el) => same(getComputedStyle(el).backgroundColor, primary));
    const accent = clickable.filter((el) => !filled.includes(el) && !grid(el) && (same(getComputedStyle(el).color, link) || same(getComputedStyle(el).color, primary)) && el.textContent.trim());
    const chips = all.filter((el) => el.matches('.pc-chip, .pc-pill-tag, .pc-view-badge, .pc-badge, [class*="badge"]') && !grid(el));
    let words = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const el = n.parentElement; if (!el || grid(el) || el.closest('script, style, template, [hidden]')) continue;
      const t = n.textContent.trim(); if (!t) continue;
      const range = document.createRange(); range.selectNodeContents(n); const r = range.getBoundingClientRect();
      if (r.width === 0 || r.bottom <= 0 || r.top >= vh || getComputedStyle(el).visibility === 'hidden') continue;
      words += t.split(/\s+/).length;
    }
    return { filled: filled.length, accentLinks: accent.length, chipsBadges: chips.length, words,
      filledText: filled.map((e) => e.textContent.trim().slice(0, 24)), accentText: accent.map((e) => e.textContent.trim().slice(0, 24)) };
  });
}

async function seed(request) {
  const id = `restraint-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const at = (d, h) => { const x = new Date(); x.setDate(d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  expect((await request.post(`/cal/${id}`, { data: { title: 'Tigers U10 Soccer', options: { notes: 'Lincoln Field. Bring water.' },
    events: [{ id: 'e1', title: 'Practice', start: at(6, 17), end: at(6, 18), type: 1 }, { id: 'e2', title: 'Game vs Hawks', start: at(10, 9), end: at(10, 10), type: 2 }] } })).status()).toBe(201);
  const view = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
  return { id, viewId: view.publicViewId };
}

// Budgets: today's counts (Oct 26 2026), to be lowered as the pages get quieter. Never raised without a reason in the doc.
const PAGES = [
  { name: 'homepage desktop', path: () => '/?backend=cf', size: { width: 1440, height: 900 }, budget: { filled: 1, accentLinks: 3, chipsBadges: 0, words: 118 } },
  // filled 2 on the phone homepage (+ and Save & share) breaks 'one loud action': next to fix (docs/DESIGN-RESTRAINT.md).
  { name: 'homepage phone', path: () => '/?backend=cf', size: { width: 390, height: 844 }, budget: { filled: 2, accentLinks: 2, chipsBadges: 0, words: 33 } },
  { name: 'edit link desktop', path: (s) => `/${s.id}?backend=cf`, size: { width: 1440, height: 900 }, budget: { filled: 1, accentLinks: 1, chipsBadges: 1, words: 36 } },
  { name: 'view link desktop', path: (s) => `/view/${s.viewId}?backend=cf`, size: { width: 1440, height: 900 }, budget: { filled: 0, accentLinks: 3, chipsBadges: 1, words: 46 } },
  { name: 'view link phone', path: (s) => `/view/${s.viewId}?backend=cf`, size: { width: 390, height: 844 }, budget: { filled: 0, accentLinks: 2, chipsBadges: 1, words: 32 } },
  { name: 'embed', path: (s) => `/view/${s.viewId}?backend=cf&embed`, size: { width: 720, height: 640 }, budget: { filled: 0, accentLinks: 0, chipsBadges: 0, words: 18 } },
];

for (const p of PAGES) {
  test(`restraint: ${p.name}`, async ({ browser, request }) => {
    const s = await seed(request);
    for (const scheme of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: p.size, colorScheme: scheme, hasTouch: p.size.width < 600 });
      await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
      const page = await ctx.newPage();
      await page.goto(p.path(s));
      await page.waitForFunction(() => window.__appMounted, null, { timeout: 20_000 });
      await page.waitForTimeout(1200);
      await page.mouse.move(1, 1);
      const m = await loudness(page);
      await page.screenshot({ path: `snapshots/restraint-${p.name.replace(/ /g, '-')}-${scheme}.png` });
      console.log(`RESTRAINT ${p.name} ${scheme} ${JSON.stringify(m)}`);
      if (!MEASURE_ONLY && p.budget) {
        expect(m.filled, `filled buttons (${m.filledText.join(' | ')})`).toBeLessThanOrEqual(p.budget.filled);
        expect(m.accentLinks, `accent links (${m.accentText.join(' | ')})`).toBeLessThanOrEqual(p.budget.accentLinks);
        expect(m.chipsBadges, 'chips and badges').toBeLessThanOrEqual(p.budget.chipsBadges);
        expect(m.words, 'words outside the calendar').toBeLessThanOrEqual(p.budget.words);
      }
      await ctx.close();
    }
  });
}

// The event card is a screen too (Oct 27 2026: an "Edited just now" line under every event shipped because the budget
// only covered pages). An event without details: its title, type, time, and the actions; nothing that repeats what
// the person just did. Words and lines may only go down.
test('restraint: event card (quick view of an event without details)', async ({ browser, request }) => {
  const s = await seed(request);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.goto(`/${s.id}?backend=cf&cal=native&view=month`);
  await page.waitForFunction(() => window.__appMounted, null, { timeout: 20_000 });
  await page.locator('.nc [data-testid="event-e1"]').first().click();
  const c = page.getByTestId('event-card');
  await expect(c).toBeVisible();
  await page.waitForTimeout(300);
  const m = await c.evaluate((el) => {
    const text = [...el.querySelectorAll('*')].filter((x) => x.offsetParent && !x.children.length).map((x) => x.textContent.trim()).filter(Boolean);
    const vals = [...el.querySelectorAll('textarea, input')].filter((x) => x.offsetParent).map((x) => x.value).filter(Boolean);
    const words = [...text, ...vals].join(' ').split(/\s+/).filter((w) => /\w/.test(w)).length;
    return { words, text: [...vals, ...text].join(' | ') };
  });
  console.log(`RESTRAINT event card ${JSON.stringify(m)}`);
  if (!MEASURE_ONLY) expect(m.words, `words on the quick card (${m.text})`).toBeLessThanOrEqual(13);   // Practice, Type 1, the date and times, More details, Done (16 with the old "Edited just now")
  await ctx.close();
});
