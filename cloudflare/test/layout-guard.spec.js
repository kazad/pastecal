// @ts-check
/**
 * GUARD (root 4, Oct 26 2026): components that assumed their container. Each was fixed where it was found: a dialog's
 * close button floated (ignored in a flex panel) onto its own row; the embed's notes panel, anchored to its button, ran
 * off the left edge; the Undo toast covered the next card's Done (F31); a crowded hour drew a 20px sliver beside
 * "+19" (S07); "More details" on a short phone scrolled the event's title out of the sheet (S10); a long title showed
 * a sliver of its fourth line (S11). The class: a panel, popover or text box laid out for the room its author had.
 *
 * So this opens EVERY dialog, popover, picker and menu, in the native calendar and in classic, at 1280x800, 640x400
 * (a laptop zoomed in) and 360x640 (a small phone), light and dark, and asserts for each:
 *   - fully on screen;
 *   - its close (✕), when it has one, at the top-right corner, on the title's line;
 *   - its title in view, and its primary action not covered (by a toast either: one is shown over each);
 *   - no text clipped mid-line in a box that does not look scrollable (overflow hidden, a line clamp, a one-row field).
 * And on the grid: no event narrower than 40px. Screenshots: cloudflare/test-results/layout-guard/.
 * Needs `wrangler dev` on BASE_URL (scripts/test-browser.sh); run with scripts/test-on-box.sh layout-guard.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SHOTS = path.join(__dirname, '..', 'test-results', 'layout-guard');
fs.mkdirSync(SHOTS, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const NOW = '2026-10-24T12:00:00-07:00';
const VM = 'document.querySelector("#app")._vnode.component.proxy';
const iso = (s) => new Date(s).toISOString();
const timed = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
  recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'long-descriptions.json'), 'utf8'));
const LONG_TITLE = '🎉 会議 チーム 打ち合わせ — اجتماع الفريق الأسبوعي — a very long planning session title that keeps going and going past three lines of the card 🎉 会議 チーム 打ち合わせ — and more';

const VIEWPORTS = {
  '1280x800': { viewport: { width: 1280, height: 800 } },
  '640x400': { viewport: { width: 640, height: 400 } },
  '360x640': { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true },
};

async function seed() {
  const id = `lg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  const links = FIXTURE.events.find((e) => e.id === 'links');
  const events = [
    timed('p', 'Practice at Lincoln Field', '2026-10-22T17:00:00-07:00', '2026-10-22T18:00:00-07:00', { description: links.description }),
    timed('r', 'Team sync', '2026-10-20T12:00:00-07:00', '2026-10-20T13:00:00-07:00', { recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;' }),
    timed('long', LONG_TITLE, '2026-10-21T13:00:00-07:00', '2026-10-21T14:00:00-07:00', { type: 5 }),
  ];
  for (let i = 0; i < 9; i++) events.push(timed(`ov${i}`, `Crowd ${i}`, '2026-10-23T10:00:00-07:00', '2026-10-23T11:00:00-07:00', { type: (i % 8) + 1 }));
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Layout guard', options: { notes: 'Bring water. Directions: https://example.com/field', typeLabels: ['Practice', 'Game', 'Away game', 'Tournament', 'Party'] }, events }) });
  expect(res.status).toBe(201);
  const view = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json();
  return { id, viewId: view.publicViewId };
}

async function open(browser, url, vp, scheme, waitFor) {
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], colorScheme: scheme, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(NOW) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  await page.waitForFunction(waitFor, null, { timeout: 30_000 });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

/**
 * What is wrong with an open surface. o: { panel, title?, close?, primary? } (selectors; the last visible match is the
 * one on top). In the page, so every box is read in the same frame.
 */
const inspect = (page, o) => page.evaluate((o) => {
  const W = innerWidth, H = innerHeight, out = [];
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const last = (s, inEl) => (s ? [...(inEl || document).querySelectorAll(s)].filter(vis).pop() || null : null);
  const desc = (e) => (e ? `${e.tagName.toLowerCase()}${e.dataset.testid ? `[${e.dataset.testid}]` : ''}.${[...e.classList].slice(0, 2).join('.')}` : 'nothing');
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const fmt = (r) => `${Math.round(r.l)},${Math.round(r.t)} ${Math.round(r.w)}x${Math.round(r.h)}`;
  const panel = last(o.panel);
  if (!panel) return [`not open (${o.panel})`];
  // A panel in the page's flow (docked, or Syncfusion's popups inside the calendar) moves with the page: it must fit
  // the window and lie within the page, which scrolls to it. (Not scrolled here: a scroll closes Syncfusion's popups.)
  let fixed = false;
  for (let a = panel; a && a !== document.documentElement; a = a.parentElement) if (getComputedStyle(a).position === 'fixed') { fixed = true; break; }
  const p = R(panel), docH = document.documentElement.scrollHeight;
  if (fixed ? (p.l < -0.5 || p.t < -0.5 || p.r > W + 0.5 || p.b > H + 0.5)
    : (p.l < -0.5 || p.r > W + 0.5 || p.h > H + 0.5 || p.t + scrollY < -0.5 || p.b + scrollY > docH + 0.5)) out.push(`off screen: ${fmt(p)} in ${W}x${H}`);
  // What of the panel can be seen: the panel, the window, and every ancestor that clips.
  const view = (e) => { let v = { l: 0, t: 0, r: W, b: H }; for (let a = e.parentElement; a; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') { const r = R(a); v = { l: Math.max(v.l, r.l), t: Math.max(v.t, r.t), r: Math.min(v.r, r.r), b: Math.min(v.b, r.b) }; } } return v; };
  const seen = (e) => { const r = R(e), v = view(e); return r.t >= v.t - 1 && r.b <= v.b + 1 && r.l >= v.l - 1 && r.r <= v.r + 1; };
  const title = o.title ? last(o.title, panel) || last(o.title) : null;
  if (o.title && !title) out.push(`no title (${o.title})`);
  if (title) { const tr = R(title), v = view(title); if (tr.t < v.t - 1 || tr.t + Math.min(tr.h, 24) > v.b + 1) out.push(`title out of view: ${fmt(tr)} (visible ${Math.round(v.t)}-${Math.round(v.b)})`); }
  const close = last(o.close, panel) || (o.close ? last(o.close) : null);
  if (close) {
    const c = R(close);
    if (c.r < p.r - 28) out.push(`close not at the right: its right ${Math.round(c.r)}, the panel's ${Math.round(p.r)}`);
    if (c.t > p.t + 60) out.push(`close not at the top: ${Math.round(c.t - p.t)}px down`);
    // (closeRow: the close sits with its sibling actions in a row above the title, Syncfusion's event popup.)
    if (title && !o.closeRow) { const tr = R(title); if (!(c.t < tr.t + Math.min(tr.h, 40) && c.b > tr.t)) out.push(`close not on the title's line: close ${fmt(c)}, title ${fmt(tr)}`); }
    if (!seen(close)) out.push('close out of view');
  }
  const primary = last(o.primary, panel) || (o.primary ? last(o.primary) : null);
  if (o.primary && !primary) out.push(`no primary action (${o.primary})`);
  if (primary) {
    // Reachable: a primary further down a dialog that scrolls is scrolled to (within the dialog, not the page).
    if (!seen(primary)) primary.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = R(primary);
    if (!seen(primary)) out.push(`primary out of view: ${fmt(r)}`);
    else {
      const hit = document.elementFromPoint(r.l + r.w / 2, r.t + r.h / 2);
      if (!hit || !(hit === primary || primary.contains(hit))) out.push(`primary covered by ${desc(hit)}`);
    }
  }
  // Text clipped mid-line, in a box that does not look scrollable.
  for (const e of [panel, ...panel.querySelectorAll('*')]) {
    if (!vis(e)) continue;
    const cs = getComputedStyle(e);
    if (cs.overflowY === 'visible' || e.scrollHeight <= e.clientHeight + 1) continue;
    const text = e.tagName === 'TEXTAREA' ? e.value : [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!text) continue;
    const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
    const oneRow = e.tagName === 'TEXTAREA' && e.getAttribute('rows') === '1';
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && !clamp && !oneRow) continue;   // (a scroll box shows part of a line)
    const lh = parseFloat(cs.lineHeight) || 1.2 * parseFloat(cs.fontSize);
    const lines = (e.clientHeight - parseFloat(cs.paddingTop)) / lh;
    if (Math.abs(lines - Math.round(lines)) > 0.12) out.push(`text clipped mid-line: ${desc(e)} shows ${lines.toFixed(2)} lines`);
  }
  return out;
}, o);

/** One check: the surface, a screenshot, and (when it has a primary action) the same again under a toast. */
async function check(page, found, tag, name, o) {
  await page.waitForTimeout(250);   // (past entrance animations)
  await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) });
  for (const p of await inspect(page, o)) found.push(`${name}: ${p}`);
  if (o.primary && o.toast !== false) {
    await page.evaluate(`${VM}.showToast('Saved. Another browser changed this event a moment ago', 'info', { actionLabel: 'Undo', action: () => {} })`);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}-toast.png`) });
    for (const p of await inspect(page, { ...o, close: null, title: null })) found.push(`${name} with a toast: ${p}`);
    const toast = await page.evaluate(() => { const t = document.querySelector('.pc-toast'); if (!t) return null; const r = t.getBoundingClientRect(); return r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; });
    if (toast === false) found.push(`${name}: the toast is off screen`);
    await page.evaluate(`${VM}.$refs.toast && (${VM}.$refs.toast.show = false)`);
    await page.waitForTimeout(150);
  }
}
const tapOrClick = async (page, loc) => { if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await loc.tap(); else await loc.click(); };
const esc = (page) => page.keyboard.press('Escape');

for (const vp of Object.keys(VIEWPORTS)) for (const scheme of ['light', 'dark']) {
  const phone = vp === '360x640';

  test(`native ${vp} ${scheme}: every card, picker, menu, sheet, dialog and panel fits its window`, async ({ browser }) => {
    test.setTimeout(150_000);
    const { id } = await seed();
    const { ctx, page, errors } = await open(browser, `/${id}?backend=cf&cal=native&view=week&date=2026-10-22`, vp, scheme, () => document.querySelector('.nc.nc-editable'));
    const tag = `native-${vp}-${scheme}`, found = [];
    const card = '[data-testid="event-card"]', CARD = { panel: card, title: '[data-testid="card-title"]', primary: '[data-testid="card-done"]' };
    const ev = (k) => page.locator(`.nc [data-testid="event-${k}"]`).first();
    const openCard = async (k) => { await ev(k).scrollIntoViewIfNeeded(); await tapOrClick(page, ev(k)); await expect(page.locator(card)).toBeVisible(); await page.waitForTimeout(250); };
    const closeCard = async () => { await esc(page); await esc(page); await expect(page.locator(card)).toHaveCount(0); };

    // The grid: events side by side are never narrower than 40px (a crowded hour is "+N" past that). An event alone in
    // its day is as wide as the day (a phone's week: 38px), which no layout can widen.
    await page.locator('.nc [data-testid="event-ov0"], .nc [data-testid="more-timed"]').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, `${tag}-grid.png`) });
    const narrow = await page.evaluate(() => [...document.querySelectorAll('.nc .nc-timed, .nc [data-testid="more-timed"]')].filter((e) => e.getClientRects().length)
      .map((e) => [e.dataset.testid, Math.round(e.getBoundingClientRect().width), Math.round(e.closest('.nc-col').getBoundingClientRect().width)])
      .filter(([, w, col]) => w < 40 && w < col - 6));
    for (const [t, w] of narrow) found.push(`grid: ${t} is ${w}px wide`);

    // The event card, quick then full, and everything opened from it.
    await openCard('p');
    await check(page, found, tag, 'card', CARD);
    await tapOrClick(page, page.getByTestId('card-more'));
    await expect(page.getByTestId('card-start-date')).toBeVisible();
    await check(page, found, tag, 'card-full', CARD);
    for (const [f, name] of [['card-start-time', 'start time'], ['card-end-time', 'end time'], ['card-start-date', 'start date'], ['card-length', 'length'],
      ['card-repeat', 'repeat'], ['card-type', 'type'], ['card-tz-button', 'time zone']]) {
      await page.getByTestId(f).scrollIntoViewIfNeeded();
      await tapOrClick(page, page.getByTestId(f));
      await expect(page.getByTestId('card-picker')).toBeVisible();
      await check(page, found, tag, `picker-${name.replace(' ', '-')}`, { panel: '[data-testid="card-picker"]' });
      if (f === 'card-repeat') {
        await tapOrClick(page, page.getByTestId('picker-custom'));
        await expect(page.getByTestId('card-custom')).toBeVisible();
        await check(page, found, tag, 'card-custom-repeat', CARD);
        await esc(page);
        await page.waitForTimeout(300);   // (the card settles to its shorter height)
        continue;
      }
      await esc(page);
      await expect(page.getByTestId('card-picker')).toHaveCount(0);
    }
    await tapOrClick(page, page.getByTestId('card-more-actions'));
    await expect(page.getByTestId('card-menu')).toBeVisible();
    await check(page, found, tag, 'card-menu', { panel: '[data-testid="card-menu"]' });
    await esc(page);
    await closeCard();

    // A title of more than three lines.
    await openCard('long');
    await page.getByTestId('card-title').evaluate((el) => el.blur());
    await check(page, found, tag, 'card-long-title', CARD);
    await closeCard();

    // Right-click on an event (not where the calendar lays out for a phone, under 768px: no right-click menu there).
    if (!(await page.evaluate(`${VM}.$refs.nativeCal.isPhone`))) {
      await ev('p').scrollIntoViewIfNeeded();
      await ev('p').click({ button: 'right' });
      await expect(page.getByTestId('card-menu')).toBeVisible();
      await check(page, found, tag, 'right-click-menu', { panel: '[data-testid="card-menu"]' });
      await esc(page);
      await closeCard();
    }

    // "This event / all events" on a repeating event's first change.
    await openCard('r');
    await page.getByTestId('card-title').fill('Team sync moved');
    await page.getByTestId('card-title').evaluate((el) => el.blur());
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await check(page, found, tag, 'this-or-all', { panel: '[data-testid="confirm-dialog"]', title: '.pc-native-ask-title', primary: '[data-testid="confirm-ok"]' });
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await page.getByTestId('card-cancel').isVisible().then((v) => (v ? page.getByTestId('card-cancel').click() : esc(page)));
    await expect(page.locator(card)).toHaveCount(0);

    // The ? shortcuts sheet.
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts')).toBeVisible();
    await check(page, found, tag, 'shortcuts', { panel: '[data-testid="shortcuts"]', title: '.pc-native-ask-title', primary: '[data-testid="shortcuts-close"]' });   // (Done, no ✕)
    await esc(page);

    await sharedPanels(page, found, tag, phone);
    expect(found, `${tag}: screenshots in cloudflare/test-results/layout-guard/`).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test(`classic ${vp} ${scheme}: every popup, editor, menu, dialog and panel fits its window`, async ({ browser }) => {
    test.setTimeout(150_000);
    const { id, viewId } = await seed();
    const { ctx, page, errors } = await open(browser, `/${id}?backend=cf&cal=classic&view=month&date=2026-10-22`, vp, scheme,
      () => window.scheduleObj && document.querySelector('.e-schedule .e-appointment'));
    const tag = `classic-${vp}-${scheme}`, found = [];

    // An event's popup, then its editor.
    const appt = page.locator('.e-schedule .e-appointment').filter({ hasText: 'Practice' }).first();
    await appt.scrollIntoViewIfNeeded();
    await tapOrClick(page, appt);
    await expect(page.locator('.e-quick-popup-wrapper.e-popup-open')).toBeVisible();
    await check(page, found, tag, 'event-popup', { panel: '.e-quick-popup-wrapper.e-popup-open', title: '.e-subject', close: '.e-close', closeRow: true, primary: '.e-edit' });
    await tapOrClick(page, page.locator('.e-quick-popup-wrapper.e-popup-open .e-edit'));
    await expect(page.locator('.e-schedule-dialog.e-popup-open')).toBeVisible();
    await check(page, found, tag, 'editor', { panel: '.e-schedule-dialog.e-popup-open', title: '.e-dlg-header', close: '.e-dlg-closeicon-btn', primary: '.e-event-save' });
    await esc(page);
    await expect(page.locator('.e-schedule-dialog.e-popup-open')).toHaveCount(0);

    // The toolbar's date picker, and its overflow menu where the toolbar has one.
    const range = page.locator('.e-schedule .e-date-range').first();
    if (await range.isVisible()) {
      const popup = page.locator('.e-header-popup.e-popup-open, .e-schedule-popup.e-popup-open').first();
      await page.waitForTimeout(400);   // (Syncfusion's editor finishing its close: a click then can land on its way out)
      // Scrolled to first, and settled: a scroll event that lands after the click closes Syncfusion's popup (the
      // click's own scroll-into-view did exactly that, the frame after it opened).
      await range.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await tapOrClick(page, range);
      await expect(popup).toBeVisible();
      await check(page, found, tag, 'date-picker', { panel: '.e-header-popup.e-popup-open, .e-schedule-popup.e-popup-open' });
      await esc(page);
      await page.waitForTimeout(300);
    }
    const more = page.locator('.e-schedule .e-toolbar .e-hor-nav:visible, .e-schedule .e-toolbar .e-toolbar-item.e-overflow-show:visible').first();
    if (await more.isVisible().catch(() => false)) {
      await tapOrClick(page, more);
      await page.waitForTimeout(300);
      if (await page.locator('.e-toolbar-pop.e-popup-open').isVisible().catch(() => false)) await check(page, found, tag, 'toolbar-menu', { panel: '.e-toolbar-pop.e-popup-open' });
      await esc(page);
    }

    // Quick add (Cmd/Ctrl+E).
    await page.keyboard.press('Control+e');
    if (await page.locator('.pc-qa-dialog').isVisible().catch(() => false)) {
      await check(page, found, tag, 'quick-add', { panel: '.pc-qa-dialog', title: 'h3', primary: '.pc-qa-dialog button[type="submit"]', toast: false });
      await esc(page);
    }

    await sharedPanels(page, found, tag, phone);
    expect(found, `${tag}: screenshots in cloudflare/test-results/layout-guard/`).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();

    // The embed's Notes, inside the embed.
    const E = await open(browser, `/view/${viewId}?backend=cf&embed`, vp, scheme, () => window.scheduleObj && document.querySelector('.e-schedule .e-toolbar'));
    const efound = [];
    await tapOrClick(E.page, E.page.getByTestId('embed-notes-btn'));
    await expect(E.page.getByTestId('embed-notes')).toBeVisible();
    await check(E.page, efound, `embed-${vp}-${scheme}`, 'notes', { panel: '[data-testid="embed-notes"]' });
    expect(efound).toEqual([]);
    expect(E.errors).toEqual([]);
    await E.ctx.close();
  });
}

/** The app's own panels and dialogs, the same around either calendar: each side tab, the feedback dialog, the phone menu. */
async function sharedPanels(page, found, tag, phone) {
  for (const t of ['notes', 'share', 'changes', 'stats', 'plus', 'settings']) {
    await page.evaluate(`${VM}.openSideTab('${t}')`);
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await check(page, found, tag, `side-${t}`, { panel: '[data-testid="side-panel"]', title: '.pc-side-bar', close: '[data-testid="side-close"]', toast: false });
  }
  await page.getByTestId('side-close').click();
  await expect(page.getByTestId('side-panel')).toHaveCount(0);
  await page.evaluate(`${VM}.openCalFeedback()`);
  await expect(page.getByTestId('cal-feedback')).toBeVisible();
  await check(page, found, tag, 'feedback', { panel: '[data-testid="cal-feedback"]', title: '#cal-feedback-title', close: '.pc-modal-x', primary: '[data-testid="cal-feedback"] button[type="submit"]' });
  await page.evaluate(`${VM}.calFeedback = null`);
  if (phone && await page.getByTestId('mobile-menu-button').isVisible().catch(() => false)) {
    await page.getByTestId('mobile-menu-button').tap();
    await page.waitForTimeout(200);
    await check(page, found, tag, 'phone-menu', { panel: '.pc-menu' });
    await page.mouse.click(5, 300);
  }
}
