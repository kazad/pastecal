// @ts-check
// Harness for the native-vs-Syncfusion audit: a `page` that is safe (only local + CDNs), a
// fixed starting clock (Sat Oct 24 2026, noon New York, then running), and one adapter per
// renderer so each test is written once and run against both.
const base = require('@playwright/test');
const { expect } = base;
const f = require('./fixtures');

const OUT = process.env.OUT || require('path').join(__dirname, 'out');
const START = '2026-10-24T12:00:00-04:00';
const ALLOWED = ['fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'www.gstatic.com'];

const test = base.test.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      window.__TEST__ = true;
      try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* storage blocked */ }
    });
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (['127.0.0.1', 'localhost'].includes(u.hostname) || ALLOWED.includes(u.hostname)) return route.continue();
      return route.abort();
    });
    // Belt and braces with the DNS block in the config: any non-local WebSocket is closed.
    await context.routeWebSocket((u) => !/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (ws) => ws.close());
    await use(context);
  },
  page: async ({ page }, use, info) => {
    await page.clock.install({ time: new Date(START) });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await use(page);
    if (errors.length) info.annotations.push({ type: 'page-errors', description: errors.slice(0, 5).join(' || ') });
  },
});

const isPhone = (page) => (page.viewportSize()?.width || 1280) < 768;
const tap = async (page, loc) => { await page.waitForTimeout(150); if (isPhone(page)) await loc.tap(); else await loc.click(); };
const shot = (page, name, info) => page.screenshot({ path: `${OUT}/${name}-${info.project.name}.png` });

/** Local midnight (ms) of a Y-M-D in the browser's zone: the key native month cells carry. */
const localMidnight = (page, ymd) => page.evaluate((s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }, ymd);
const localHM = (page, iso) => page.evaluate((v) => { const d = new Date(v); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }, iso);
const localYMD = (page, iso) => page.evaluate((v) => { const d = new Date(v); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, iso);

/** Events as the server holds them. */
const serverEvents = async (id) => ((await f.getCal(id)).calendar.events || []);
const serverVersion = async (id) => (await f.getCal(id)).v;
const byTitle = async (id, title) => (await serverEvents(id)).find((e) => e.title === title);
const soon = (fn, timeout = 12_000) => expect.poll(fn, { timeout, intervals: [250, 500, 1000] });

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------
const sf = {
  name: 'syncfusion',
  path: (id) => `/${id}`,
  async open(page, id, query = '') {
    await page.goto(`/${id}${query}`);
    await expect(page.locator('.e-schedule')).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => document.querySelector('#app')?._vnode?.component?.proxy?.isLoading === false, null, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(600);
  },
  event: (page, title) => page.locator('.e-appointment', { hasText: title }).locator('visible=true'),
  async view(page, name) {
    if (isPhone(page)) {
      const item = page.locator('.e-toolbar-item.e-views', { hasText: new RegExp(`^${name}$`) }).locator('visible=true');
      if (!(await item.count())) {
        await tap(page, page.locator('.e-toolbar-pop, .e-hor-nav, .e-schedule-toolbar .e-icon-more, .e-toolbar-item.e-expand').locator('visible=true').first());
        await tap(page, page.locator('.e-toolbar-pop .e-toolbar-item', { hasText: new RegExp(`^${name}$`) }).locator('visible=true').first());
      } else await tap(page, item.first());
    } else {
      await tap(page, page.locator('.e-toolbar-item.e-views', { hasText: new RegExp(`^${name}$`) }).first());
    }
    await page.waitForTimeout(500);
  },
  next: (page) => tap(page, page.locator('.e-toolbar-item.e-next button').first()),
  prev: (page) => tap(page, page.locator('.e-toolbar-item.e-prev button').first()),
  title: (page) => page.locator('.e-toolbar-item.e-date-range').first().innerText(),
  async cellByDate(page, ymd) {
    const ms = await localMidnight(page, ymd);
    return page.locator(`.e-work-cells[data-date="${ms}"]`).first();
  },
  async quickCreate(page, ymd, title) {
    const c = await this.cellByDate(page, ymd);
    const b = await c.boundingBox();
    if (isPhone(page)) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height - 8); else await page.mouse.click(b.x + b.width / 2, b.y + b.height - 8);
    const subj = page.locator('.e-quick-popup-wrapper input.e-subject, .e-quick-popup-wrapper input[name="Subject"]').locator('visible=true').first();
    await expect(subj).toBeVisible();
    await subj.pressSequentially(title, { delay: 20 });
    await tap(page, page.locator('.e-quick-popup-wrapper .e-event-create').locator('visible=true').first());
  },
  async openNewEditor(page, ymd) {
    const c = await this.cellByDate(page, ymd);
    const b = await c.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height - 8;
    if (isPhone(page)) { await page.touchscreen.tap(x, y); await page.waitForTimeout(400); await page.touchscreen.tap(x, y); } else await page.mouse.dblclick(x, y);
    await expect(sf.dialog(page)).toBeVisible();
  },
  dialog: (page) => page.locator('.e-schedule-dialog.e-popup-open'),
  async openPopover(page, title) {
    await tap(page, sf.event(page, title).first());
    await expect(page.locator('button.e-edit').locator('visible=true').first()).toBeVisible();
  },
  popoverText: (page) => page.locator('.e-quick-popup-wrapper').locator('visible=true').first().innerText(),
  popover: (page) => page.locator('.e-quick-popup-wrapper').locator('visible=true').first(),
  async editFromPopover(page, scope /* 'this' | 'all' | undefined */) {
    await tap(page, page.locator('button.e-edit').locator('visible=true').first());
    if (scope) {
      const btn = scope === 'this' ? '.e-quick-dialog-occurrence-event' : '.e-quick-dialog-series-event';
      await tap(page, page.locator(btn).locator('visible=true').first());
    }
    await expect(sf.dialog(page)).toBeVisible();
  },
  async deleteFromPopover(page, scope) {
    await tap(page, page.locator('button.e-delete').locator('visible=true').first());
    if (scope === 'this') await tap(page, page.locator('.e-quick-dialog-occurrence-event').locator('visible=true').first());
    else if (scope === 'all') await tap(page, page.locator('.e-quick-dialog-series-event').locator('visible=true').first());
    else {
      const ok = page.locator('.e-quick-dialog-delete').locator('visible=true');
      await ok.first().waitFor({ timeout: 2500 }).catch(() => {});
      if (await ok.count()) await tap(page, ok.first());
    }
  },
  async setTitle(page, text) {
    const i = sf.dialog(page).locator('input[name="Subject"]');
    await tap(page, i); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text, { delay: 20 });
  },
  async setDescription(page, text) {
    const i = sf.dialog(page).locator('textarea[name="Description"]');
    await tap(page, i); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text, { delay: 5 });
  },
  async setAllDay(page, on) {
    const frame = sf.dialog(page).locator('.e-all-day-container .e-frame').first();
    const ticked = await frame.evaluate((e) => e.classList.contains('e-check'));
    if (ticked !== on) await tap(page, sf.dialog(page).locator('.e-all-day-container label').first());
  },
  async setTime(page, which, hhmm) {
    const input = sf.dialog(page).locator(`input[name="${which === 'start' ? 'StartTime' : 'EndTime'}"]`);
    const cur = await input.inputValue();
    const [h, m] = hhmm.split(':').map(Number);
    const twelve = /[AP]M/i.test(cur);
    const t = twelve ? `${String(((h + 11) % 12) + 1).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    await tap(page, input); await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(cur.replace(/\d{1,2}:\d{2}(\s?[AP]M)?/i, t), { delay: 15 }); await page.keyboard.press('Tab');
  },
  async save(page) {
    const footer = sf.dialog(page).locator('.e-event-save').locator('visible=true');
    if (await footer.count()) await tap(page, footer.first()); else await tap(page, sf.dialog(page).locator('.e-save-icon').locator('visible=true').first());
    await expect(sf.dialog(page)).toHaveCount(0);
  },
  async openQuickAdd(page) {
    if (isPhone(page)) {
      await tap(page, page.getByRole('button', { name: 'Open menu' }));
      await tap(page, page.getByText('Quick add event').locator('visible=true').first());
    } else await tap(page, page.locator('[data-testid="desktop-add-event-button"]').locator('visible=true').first());
    await expect(page.getByText('Add Event by Typing')).toBeVisible();
  },
};

const nat = {
  name: 'native',
  path: (id) => `/beta/${id}`,
  async open(page, id, query = '') {
    await page.goto(`/beta/${id}${query}`);
    await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 20_000 });
    await expect(page.locator('.nc')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
  },
  event: (page, title) => page.locator('.nc-bar, .nc-timed, .nc-agenda-item', { hasText: title }).locator('visible=true'),
  async view(page, name) {
    if (isPhone(page)) { await tap(page, page.locator('[data-testid="view-menu"]')); await tap(page, page.locator(`.nc-view-menu [data-testid="view-${name.replace(' ', '')}"]`)); }
    else await tap(page, page.locator(`.nc-views [data-testid="view-${name.replace(' ', '')}"]`));
    await page.waitForTimeout(300);
  },
  next: (page) => tap(page, page.locator('[data-testid="nav-next"]')),
  prev: (page) => tap(page, page.locator('[data-testid="nav-prev"]')),
  title: (page) => page.locator('[data-testid="current-date-range"]').innerText(),
  async cellByDate(page, ymd) { const ms = await localMidnight(page, ymd); return page.locator(`.nc-cell[data-day="${ms}"]`); },
  async quickCreate(page, ymd, title) {
    const c = await this.cellByDate(page, ymd);
    if (isPhone(page)) await c.tap({ position: { x: 20, y: 40 } }); else await c.click({ position: { x: 40, y: 60 } });
    await expect(page.locator('[data-testid="quick-create"]')).toBeVisible();
    await page.locator('[data-testid="quick-create-title"]').pressSequentially(title, { delay: 20 });
    await tap(page, page.locator('[data-testid="quick-create-save"]'));
  },
  async openNewEditor(page, ymd) {
    const c = await this.cellByDate(page, ymd);
    if (isPhone(page)) { await c.tap({ position: { x: 20, y: 40 } }); await tap(page, page.locator('[data-testid="quick-create-more"]')); }
    else await c.dblclick({ position: { x: 40, y: 60 } });
    await expect(page.locator('[data-testid="event-editor"]')).toBeVisible();
  },
  dialog: (page) => page.locator('[data-testid="event-editor"]'),
  async openPopover(page, title) { await tap(page, nat.event(page, title).first()); await expect(page.locator('[data-testid="event-popover"]')).toBeVisible(); },
  popoverText: (page) => page.locator('[data-testid="event-popover"]').innerText(),
  popover: (page) => page.locator('[data-testid="event-popover"]'),
  async pickScope(page, scope) {
    const dlg = page.locator('[data-testid="confirm-dialog"]');
    await expect(dlg).toBeVisible();
    await tap(page, dlg.locator(`[data-testid="scope-${scope}"]`));
    await tap(page, dlg.locator('[data-testid="confirm-ok"]'));
  },
  async editFromPopover(page, scope) {
    await tap(page, page.locator('[data-testid="popover-edit"]'));
    if (scope) await nat.pickScope(page, scope);
    await expect(nat.dialog(page)).toBeVisible();
  },
  async deleteFromPopover(page, scope) {
    await tap(page, page.locator('[data-testid="popover-delete"]'));
    if (scope) await nat.pickScope(page, scope);
  },
  async setTitle(page, text) { const i = page.locator('[data-testid="editor-title"]'); await tap(page, i); await i.fill(''); await i.pressSequentially(text, { delay: 20 }); },
  async setDescription(page, text) { const i = page.locator('[data-testid="editor-description"]'); await tap(page, i); await i.fill(''); await i.pressSequentially(text, { delay: 5 }); },
  async setAllDay(page, on) { const c = page.locator('[data-testid="editor-allday"]'); if ((await c.isChecked()) !== on) await tap(page, c); },
  async setTime(page, which, hhmm) { await page.locator(`[data-testid="editor-${which}-time"]`).fill(hhmm); },
  async save(page) { await tap(page, page.locator('[data-testid="editor-save"]')); await expect(nat.dialog(page)).toHaveCount(0); },
  async openQuickAdd(page) {
    if (isPhone(page)) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.count()) { await tap(page, menu.first()); await tap(page, page.getByText('Quick add event').locator('visible=true').first()); }
      else await page.keyboard.press('ControlOrMeta+e');
    } else await tap(page, page.getByRole('button', { name: /Add event/ }).locator('visible=true').first());
    await expect(page.getByText('Add Event by Typing')).toBeVisible();
  },
};

const RENDERERS = [sf, nat];

module.exports = { test, expect, f, OUT, RENDERERS, sf, nat, isPhone, tap, shot, localMidnight, localHM, localYMD, serverEvents, serverVersion, byTitle, soon };
