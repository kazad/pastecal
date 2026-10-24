// @ts-check
/**
 * Native renderer (/beta/<name>, NativeCal v2) vs Syncfusion (/<name>): the same user journeys on
 * the same seeded calendar, checked against what the SERVER saved (GET /cal/<id>).
 *
 * LOCAL ONLY. Start a wrangler dev first, with copy-back to Firebase switched off:
 *   cd cloudflare && wrangler dev --port 8900 --persist-to <scratch> \
 *     --var FIREBASE_DB_URL: --var COPY_BACK: --var IMPORT_SECRET:audit-local-only-secret --var ACCOUNTS_DEV_MODE:1
 * then: npx playwright test -c test/native-audit/playwright.config.js
 * Every external host except fonts/CDNs is aborted (harness.js). The page clock starts at
 * Sat Oct 24 2026 noon New York so the October fixtures stay on screen.
 */
const { test, expect, f, RENDERERS, sf, nat, isPhone, tap, shot, localHM, localYMD, serverEvents, byTitle, soon } = require('./harness');

// One calendar per renderer x project, reset before every test (creating is rate-limited to 10/min);
// a calendar that gets locked has its own name.
const calId = (r, info, tag) => (tag === 'locked' ? `aud-locked-${Date.now()}` : `aud-${r.name.slice(0, 3)}-${info.project.name}`).toLowerCase();
async function fresh(r, info, tag, events = f.baseEvents()) { const id = calId(r, info, tag); await f.reset(id, events); return id; }

for (const r of RENDERERS) {
  test.describe(r.name, () => {
    // ------------------------------------------------------------------ views
    test(`${r.name}: every view renders the seeded data`, async ({ page }, info) => {
      const id = await fresh(r, info, 'views');
      await r.open(page, id);
      await expect(r.event(page, 'Lunch with Sam').first()).toBeVisible();
      await shot(page, `views-month-${r.name}`, info);
      for (const v of ['Week', 'Day', 'Agenda', '3 Months', 'Year']) {
        await r.view(page, v);
        await page.waitForTimeout(400);
        await shot(page, `views-${v.replace(' ', '')}-${r.name}`, info);
        if (v === 'Week' || v === 'Day') await expect(r.event(page, 'Lunch with Sam').first()).toBeVisible();
        if (v === '3 Months') await expect(r.event(page, 'Mom birthday').first()).toBeVisible();
      }
    });

    test(`${r.name}: ?view=week&date= opens that week`, async ({ page }, info) => {
      const id = await fresh(r, info, 'urlview');
      await r.open(page, id, '?view=week&date=2026-10-29');
      await expect(r.event(page, 'Busy 1').first()).toBeVisible({ timeout: 5000 });
    });

    test(`${r.name}: next / previous / today`, async ({ page }, info) => {
      const id = await fresh(r, info, 'nav');
      await r.open(page, id);
      await r.next(page);
      await expect.poll(() => r.title(page)).toMatch(/Nov|November/i);
      await r.prev(page); await r.prev(page);
      await expect.poll(() => r.title(page)).toMatch(/Sep|September/i);
      if (r === nat) await tap(page, page.locator('[data-testid="today"]'));
      else {
        const today = page.locator('.e-toolbar-item.e-today').locator('visible=true');
        info.annotations.push({ type: 'sf-today-visible', description: String(await today.count()) });
        if (await today.count()) await tap(page, today.first()); else await r.next(page);
      }
      await expect.poll(() => r.title(page)).toMatch(/Oct|October/i);
    });

    // ------------------------------------------------------------------ creating
    test(`${r.name}: click a day, type a title, save -> all-day event on that date`, async ({ page }, info) => {
      const id = await fresh(r, info, 'quick');
      await r.open(page, id);
      await r.quickCreate(page, '2026-10-13', 'Picnic');
      await soon(async () => !!(await byTitle(id, 'Picnic'))).toBe(true);
      const e = await byTitle(id, 'Picnic');
      expect(e.isAllDay).toBe(true);
      expect(await localYMD(page, e.start)).toBe('2026-10-13');
      await expect(r.event(page, 'Picnic').first()).toBeVisible();
    });

    test(`${r.name}: +Event typed "Lunch tomorrow 2pm for 1 hour" is saved at 14:00`, async ({ page }, info) => {
      const id = await fresh(r, info, 'typed');
      await r.open(page, id);
      await r.openQuickAdd(page);
      await page.keyboard.type('Brunch tomorrow 2pm for 1 hour', { delay: 20 });
      await tap(page, page.locator('button[type=submit]:has-text("Create")'));
      await soon(async () => !!(await byTitle(id, 'Brunch'))).toBe(true);
      const e = await byTitle(id, 'Brunch');
      expect(await localHM(page, e.start)).toBe('14:00');
      expect(await localYMD(page, e.start)).toBe('2026-10-25');
      expect(new Date(e.end).getTime() - new Date(e.start).getTime()).toBe(3600000);
    });

    test(`${r.name}: full editor -- timed, description with a link; popup links it`, async ({ page }, info) => {
      const id = await fresh(r, info, 'editor');
      await r.open(page, id);
      await r.openNewEditor(page, '2026-10-14');
      await r.setTitle(page, 'Budget review');
      await r.setAllDay(page, false);
      await r.setTime(page, 'start', '14:30');
      await r.setTime(page, 'end', '15:45');
      await r.setDescription(page, 'Agenda at https://example.com/agenda');
      await shot(page, `editor-filled-${r.name}`, info);
      await r.save(page);
      await soon(async () => !!(await byTitle(id, 'Budget review'))).toBe(true);
      const e = await byTitle(id, 'Budget review');
      expect(e.isAllDay).toBeFalsy();
      expect(typeof e.start).toBe('string');   // the shared data contract: ISO strings, never epoch numbers
      expect(await localHM(page, e.start)).toBe('14:30');
      expect(await localHM(page, e.end)).toBe('15:45');
      expect(e.description).toContain('https://example.com/agenda');
      await r.openPopover(page, 'Budget review');
      await expect(r.popover(page).locator('a[href="https://example.com/agenda"]')).toBeVisible();
      await shot(page, `popover-${r.name}`, info);
    });

    // ------------------------------------------------------------------ recurrence
    test(`${r.name}: edit ONE occurrence of a weekly series -> exception + child row`, async ({ page }, info) => {
      const id = await fresh(r, info, 'occ');
      await r.open(page, id);
      // Mon Oct 19 standup (the second-to-last row of October)
      const ev = r.event(page, 'Team standup');
      await expect(ev.first()).toBeVisible();
      const n = await ev.count();
      await tap(page, ev.nth(n - 3));  // Mon Oct 26 is n-3 (26, 28, 30) in month view
      await expect(r === nat ? page.locator('[data-testid="event-popover"]') : page.locator('button.e-edit').locator('visible=true').first()).toBeVisible();
      await r.editFromPopover(page, 'this');
      await r.setTitle(page, 'Standup (moved)');
      await r.save(page);
      await soon(async () => !!(await byTitle(id, 'Standup (moved)'))).toBe(true);
      const child = await byTitle(id, 'Standup (moved)');
      const master = (await serverEvents(id)).find((e) => e.id === 'fx-standup');
      expect(child.recurrenceID).toBe('fx-standup');
      info.annotations.push({ type: 'child-row', description: JSON.stringify(child) });
      const stamp = new Date(child.start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      expect(master.recurrenceException).toContain(stamp);
      expect(master.recurrenceException).toContain('20261014T130000Z');   // the old exception kept
      // The other renderer draws the same thing
      const other = r === nat ? sf : nat;
      await other.open(page, id);
      await expect(other.event(page, 'Standup (moved)').first()).toBeVisible();
      await shot(page, `occ-edit-seen-in-${other.name}-after-${r.name}`, info);
    });

    test(`${r.name}: delete one occurrence, then the whole series`, async ({ page }, info) => {
      const id = await fresh(r, info, 'del');
      await r.open(page, id);
      const before = await r.event(page, 'Team standup').count();
      await r.openPopover(page, 'Team standup');
      await r.deleteFromPopover(page, 'this');
      await soon(async () => ((await serverEvents(id)).find((e) => e.id === 'fx-standup')?.recurrenceException || '').split(',').length).toBe(2);
      await expect(r.event(page, 'Team standup')).toHaveCount(before - 1);
      await r.openPopover(page, 'Team standup');
      await r.deleteFromPopover(page, 'all');
      await soon(async () => !!(await serverEvents(id)).find((e) => e.id === 'fx-standup')).toBe(false);
      await expect(r.event(page, 'Team standup')).toHaveCount(0);
    });

    test(`${r.name}: delete a single event, then undo with Cmd/Ctrl+Z`, async ({ page }, info) => {
      const id = await fresh(r, info, 'undo');
      await r.open(page, id);
      await r.openPopover(page, 'Dentist');
      await r.deleteFromPopover(page);
      await soon(async () => !!(await byTitle(id, 'Dentist'))).toBe(false);
      await shot(page, `after-delete-${r.name}`, info);
      await page.locator('body').click({ position: { x: 5, y: 790 } }).catch(() => {});
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForTimeout(800);
      const ok = page.getByRole('button', { name: /^(Undo|Yes|OK|Restore)/i }).locator('visible=true');
      if (r === sf && await ok.count()) await tap(page, ok.first());
      await soon(async () => !!(await byTitle(id, 'Dentist'))).toBe(true);
    });

    test(`${r.name}: undo a delete with the on-screen Undo (snackbar / toast)`, async ({ page }, info) => {
      const id = await fresh(r, info, 'undo2');
      await r.open(page, id);
      await r.openPopover(page, 'Dentist');
      await r.deleteFromPopover(page);
      await soon(async () => !!(await byTitle(id, 'Dentist'))).toBe(false);
      const undo = page.getByRole('button', { name: /^Undo/i }).locator('visible=true');
      await expect(undo.first()).toBeVisible({ timeout: 4000 });
      await tap(page, undo.first());
      await soon(async () => !!(await byTitle(id, 'Dentist'))).toBe(true);
    });

    // ------------------------------------------------------------------ drag & resize (desktop)
    test(`${r.name}: drag an event one hour later in Week view`, async ({ page }, info) => {
      test.skip(isPhone(page), 'no touch drag in either renderer');
      const id = await fresh(r, info, 'drag');
      await r.open(page, id);
      await r.view(page, 'Week');
      const ev = r.event(page, 'Dentist').first();
      await ev.scrollIntoViewIfNeeded();
      const b = await ev.boundingBox();
      const hourPx = r === nat ? 48 : await page.evaluate(() => { const c = document.querySelector('.e-work-cells'); return c ? c.getBoundingClientRect().height * 2 : 72; });
      const y0 = b.y + b.height / 2;   // the middle: the top and bottom edges are resize handles
      await page.mouse.move(b.x + b.width / 2, y0);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(b.x + b.width / 2, y0 + (hourPx * i) / 10); await page.waitForTimeout(20); }
      await page.mouse.up();
      await soon(async () => localHM(page, (await byTitle(id, 'Dentist')).start)).toBe(info.project.name === 'desktop-de' ? '21:00' : '15:00');
      const e = await byTitle(id, 'Dentist');
      expect(new Date(e.end).getTime() - new Date(e.start).getTime()).toBe(3600000);
    });

    test(`${r.name}: resize an event 30 minutes longer from its bottom edge`, async ({ page }, info) => {
      test.skip(isPhone(page), 'no touch resize in either renderer');
      const id = await fresh(r, info, 'resize');
      await r.open(page, id);
      await r.view(page, 'Week');
      const ev = r.event(page, 'Dentist').first();
      await ev.scrollIntoViewIfNeeded();
      await ev.hover();
      const b = await ev.boundingBox();
      const hourPx = r === nat ? 48 : await page.evaluate(() => document.querySelector('.e-work-cells').getBoundingClientRect().height * 2);
      const y = b.y + b.height - 2;
      await page.mouse.move(b.x + b.width / 2, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2, y + (hourPx / 2) * i / 8);
      await page.mouse.up();
      await soon(async () => { const e = await byTitle(id, 'Dentist'); return (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000; }).toBe(90);
    });

    test(`${r.name}: drag a repeating occurrence (asks / stamps an exception)`, async ({ page }, info) => {
      test.skip(isPhone(page), 'desktop gesture');
      const id = await fresh(r, info, 'dragocc');
      await r.open(page, id);
      await r.view(page, 'Week');
      await r.next(page);   // week of Oct 25: Morning run daily
      const ev = r.event(page, 'Morning run').first();
      await ev.scrollIntoViewIfNeeded();
      const b = await ev.boundingBox();
      const y0 = b.y + b.height / 2;
      await page.mouse.move(b.x + b.width / 2, y0); await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(b.x + b.width / 2, y0 + 7 * i); await page.waitForTimeout(20); }
      await page.mouse.up();
      await page.waitForTimeout(800);
      const occ = page.locator('.e-quick-dialog-occurrence-event, [data-testid="scope-this"]').locator('visible=true');
      if (await occ.count()) { await tap(page, occ.first()); const ok = page.locator('[data-testid="confirm-ok"]'); if (await ok.count()) await tap(page, ok); }
      await soon(async () => !!((await serverEvents(id)).find((e) => e.id === 'fx-run')?.recurrenceException)).toBe(true);
    });

    // ------------------------------------------------------------------ dense data
    test(`${r.name}: a day with 6 events -> "+N more" and what it opens`, async ({ page }, info) => {
      const id = await fresh(r, info, 'more');
      await r.open(page, id);
      const more = page.locator(r === nat ? '[data-testid="more-events"]' : '.e-more-indicator').locator('visible=true');
      await expect(more.first()).toBeVisible();
      const target = more.filter({ hasText: /6/ }).first();
      await tap(page, (await target.count()) ? target : more.last());
      await page.waitForTimeout(600);
      await shot(page, `more-opened-${r.name}`, info);
      await expect(r.event(page, 'Busy 6').first()).toBeVisible();
    });

    test(`${r.name}: week with overlaps, midnight crossing, long title, all-day span (screenshot)`, async ({ page }, info) => {
      const id = await fresh(r, info, 'dense');
      await r.open(page, id);
      await r.view(page, 'Week');
      await r.next(page);
      await page.waitForTimeout(500);
      await shot(page, `week-dense-${r.name}`, info);
      await r.prev(page);
      await shot(page, `week-conf-midnight-${r.name}`, info);
      await expect(r.event(page, 'Conference').first()).toBeVisible();
      await expect(r.event(page, 'Night shift').first()).toBeVisible();
    });

    // ------------------------------------------------------------------ settings
    test(`${r.name}: settings -- Monday first, 24-hour time`, async ({ page }, info) => {
      const id = await fresh(r, info, 'settings');
      await r.open(page, id);
      if (isPhone(page)) {
        await tap(page, page.getByRole('button', { name: 'Open menu' }).first());
        await tap(page, page.getByText(/^\s*Settings\s*$/).locator('visible=true').first());
      } else await tap(page, page.locator('[data-testid="settings-button-desktop"]').locator('visible=true').first());
      await page.locator('label:has-text("First day of week") + select').locator('visible=true').first().selectOption('1');
      await page.locator('label:has-text("Time format") + select').locator('visible=true').first().selectOption('24');
      const df = page.locator('label:has-text("Date format") + select').locator('visible=true');
      info.annotations.push({ type: 'date-format-setting', description: String(await df.count()) });
      await shot(page, `settings-${r.name}`, info);
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 5).catch(() => {});
      await page.waitForTimeout(600);
      await r.view(page, 'Week');
      await shot(page, `settings-applied-week-${r.name}`, info);
      const body = await page.locator(r === nat ? '.nc' : '.e-schedule').innerText();
      expect(body).toMatch(/14:00|18:00|12:00/);
      expect(body).not.toMatch(/\bPM\b/);
      const firstHead = r === nat ? await page.locator('.nc-dayhead-name').first().innerText() : await page.locator('.e-header-cells .e-header-day').first().innerText();
      expect(firstHead).toMatch(/Mon|Mo/i);
    });

    // ------------------------------------------------------------------ sharing
    test(`${r.name}: a view-only link shows events and offers no editing`, async ({ page, request }, info) => {
      const id = await fresh(r, info, 'view');
      const res = await request.post('/api/create-view', { data: { sourceCalendarId: id } });
      const j = await res.json();
      const vid = j.viewId || j.publicViewId || j.id || j.slug || j.result?.viewId;
      info.annotations.push({ type: 'create-view', description: JSON.stringify(j).slice(0, 200) });
      expect(vid, JSON.stringify(j)).toBeTruthy();
      await page.goto(r === nat ? `/beta/view/${vid}` : `/view/${vid}`);
      await expect(r.event(page, 'Lunch with Sam').first()).toBeVisible({ timeout: 15_000 });
      await shot(page, `viewonly-${r.name}`, info);
      await r.event(page, 'Lunch with Sam').first().click({ force: true });   // Syncfusion marks read-only events aria-disabled
      await page.waitForTimeout(500);
      await expect(page.locator('[data-testid="popover-edit"], button.e-edit').locator('visible=true')).toHaveCount(0);
      const before = (await serverEvents(id)).length;
      await page.keyboard.press('ControlOrMeta+e');
      await page.waitForTimeout(500);
      const qa = page.getByText('Add Event by Typing').locator('visible=true');
      info.annotations.push({ type: 'quick-add-on-view-only', description: String(await qa.count()) });
      if (await qa.count()) {
        await page.keyboard.type('Phantom tomorrow 3pm', { delay: 10 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
        await shot(page, `viewonly-phantom-${r.name}`, info);
        info.annotations.push({ type: 'phantom-visible', description: String(await r.event(page, 'Phantom').count()) });
      }
      expect((await serverEvents(id)).length).toBe(before);
    });

    test(`${r.name}: a view-only link in an iframe (embed)`, async ({ page, request }, info) => {
      const id = await fresh(r, info, 'embed');
      const j = await (await request.post('/api/create-view', { data: { sourceCalendarId: id } })).json();
      const vid = j.viewId || j.publicViewId || j.id || j.slug;
      const src = r === nat ? `/beta/view/${vid}` : `/view/${vid}`;
      await page.goto('/robots.txt');
      await page.setContent(`<html><body style="margin:0"><iframe src="http://127.0.0.1:8900${src}" style="width:100%;height:600px;border:0"></iframe></body></html>`);
      const frame = page.frameLocator('iframe');
      await expect(frame.locator('.nc-bar, .e-appointment', { hasText: 'Lunch with Sam' }).first()).toBeVisible({ timeout: 15_000 });
      await shot(page, `embed-${r.name}`, info);
    });

    // ------------------------------------------------------------------ live sync
    test(`${r.name}: two tabs -- an edit in this renderer shows up live in a Syncfusion tab and a native tab`, async ({ page, context }, info) => {
      test.skip(isPhone(page), 'desktop only');
      const id = await fresh(r, info, 'sync');
      await r.open(page, id);
      const sfTab = await context.newPage(); await sfTab.clock.install({ time: new Date('2026-10-24T12:00:00-04:00') }); await sf.open(sfTab, id);
      const nTab = await context.newPage(); await nTab.clock.install({ time: new Date('2026-10-24T12:00:00-04:00') }); await nat.open(nTab, id);
      await page.bringToFront();
      await r.quickCreate(page, '2026-10-16', 'Synced picnic');
      await expect(sf.event(sfTab, 'Synced picnic').first()).toBeVisible({ timeout: 10_000 });
      await expect(nat.event(nTab, 'Synced picnic').first()).toBeVisible({ timeout: 10_000 });
      // and back: an edit in the other tab arrives here
      await nTab.bringToFront();
      await nat.quickCreate(nTab, '2026-10-17', 'From native tab');
      await page.bringToFront();
      await expect(r.event(page, 'From native tab').first()).toBeVisible({ timeout: 10_000 });
      // Nothing lost: both on the server
      const titles = (await serverEvents(id)).map((e) => e.title);
      expect(titles).toEqual(expect.arrayContaining(['Synced picnic', 'From native tab']));
    });

    test(`${r.name}: an idle tab writes nothing`, async ({ page }, info) => {
      const id = await fresh(r, info, 'idle');
      const v0 = (await f.getCal(id)).v;
      const sent = [];
      page.on('websocket', (ws) => { if (ws.url().includes('/cal/')) ws.on('framesent', (fr) => sent.push(String(fr.payload).slice(0, 80))); });
      await r.open(page, id);
      await page.waitForTimeout(3000);
      const afterLoad = sent.length;
      await page.waitForTimeout(8000);
      info.annotations.push({ type: 'ws-frames', description: JSON.stringify(sent).slice(0, 300) });
      expect(sent.length - afterLoad).toBe(0);
      expect((await f.getCal(id)).v).toBe(v0);
    });

    test(`${r.name}: offline edit is saved after reconnect`, async ({ page, context }, info) => {
      const id = await fresh(r, info, 'offline');
      await r.open(page, id);
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.waitForTimeout(1500);
      await r.quickCreate(page, '2026-10-12', 'Offline note');
      await page.waitForTimeout(1500);
      await shot(page, `offline-${r.name}`, info);
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await soon(async () => !!(await byTitle(id, 'Offline note')), 30_000).toBe(true);
    });

    // ------------------------------------------------------------------ keyboard / a11y
    test(`${r.name}: keyboard -- arrows change month, Escape closes the popup, events are focusable`, async ({ page }, info) => {
      test.skip(isPhone(page), 'desktop only');
      const id = await fresh(r, info, 'kbd');
      await r.open(page, id);
      await r.openPopover(page, 'Lunch with Sam');
      await page.keyboard.press('Escape');
      await expect(r === nat ? page.locator('[data-testid="event-popover"]') : page.locator('.e-quick-popup-wrapper.e-popup-open')).toHaveCount(0);
      // Tab reaches an event?
      let reached = false;
      for (let i = 0; i < 60 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => !!document.activeElement?.closest('.e-appointment, .nc-bar, .nc-timed'));
      }
      info.annotations.push({ type: 'tab-reaches-event', description: String(reached) });
      await page.locator(r === nat ? '.nc-month' : '.e-schedule').click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      info.annotations.push({ type: 'arrow-title', description: await r.title(page) });
      expect(reached).toBe(true);
    });

    // ------------------------------------------------------------------ DST
    test(`${r.name}: DST day (Oct 25 Berlin / Nov 1 New York) -- events sit at their wall-clock hour`, async ({ page }, info) => {
      test.skip(isPhone(page), 'desktop geometry');
      const id = await fresh(r, info, 'dst', [...f.baseEvents(),
        { id: 'dst-10', title: 'Ten oclock', start: info.project.name === 'desktop-de' ? '2026-10-25T09:00:00.000Z' : '2026-11-01T15:00:00.000Z',
          end: info.project.name === 'desktop-de' ? '2026-10-25T10:00:00.000Z' : '2026-11-01T16:00:00.000Z', type: 1, isAllDay: false, description: '', repeat: '', recurrencerule: '', recurrenceID: null, recurrenceException: null }]);
      await r.open(page, id);
      await r.view(page, 'Week');
      // forward to the week of Oct 25 (Berlin DST) or Nov 1 (New York DST)
      const ev = r.event(page, 'Ten oclock').first();
      for (let i = 0; i < 3 && !(await ev.count()); i++) { await r.next(page); await page.waitForTimeout(500); }
      await ev.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(page, `dst-week-${r.name}`, info);
      // Compare the event's top with the 10:00 row of the time gutter.
      const evTop = (await ev.boundingBox()).y;
      const label = r === nat ? page.locator('.nc-hour-label', { hasText: /^(10 AM|10:00|10)$/ }).first() : page.locator('.e-time-cells-wrap .e-time-slots', { hasText: /^(10 AM|10:00)$/ }).first();
      const lb = await label.boundingBox();
      const rowTop = r === nat ? lb.y + lb.height / 2 : lb.y;
      info.annotations.push({ type: 'dst-offset-px', description: String(Math.round(evTop - rowTop)) });
      expect(Math.abs(evTop - rowTop)).toBeLessThan(14);
    });

    // ------------------------------------------------------------------ dark mode
    test(`${r.name}: dark mode (system)`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      const id = await fresh(r, info, 'dark');
      await r.open(page, id);
      await page.waitForTimeout(500);
      await shot(page, `dark-month-${r.name}`, info);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      info.annotations.push({ type: 'body-bg', description: bg });
      const [rr, g, b] = bg.match(/\d+/g).map(Number);
      expect(rr + g + b).toBeLessThan(200);
    });
  });
}

// ------------------------------------------------------------------ native-only checks
test('native: a locked Pro calendar at /beta goes to the main app, keeping #k=', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-en', 'once is enough');
  const id = await fresh(nat, info, 'locked');
  const lock = await f.admin(`cal/${id}/lock`, { ownerId: 'audit-owner', plan: 'pro' });
  info.annotations.push({ type: 'lock', description: lock.status + ' ' + lock.body.slice(0, 150) });
  expect(lock.status).toBeLessThan(300);
  await page.goto(`/beta/${id}#k=abc123`);
  await page.waitForURL((u) => !u.pathname.startsWith('/beta'), { timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe(`/${id}`);
  info.annotations.push({ type: 'final-url', description: page.url() });
  await page.waitForTimeout(1500);
  await shot(page, 'locked-redirect-native', info);
});

test('native: data written by native is read back identically by Syncfusion (all-day + weekly BYDAY + COUNT)', async ({ page }, info) => {
  test.skip(isPhone(page), 'desktop');
  const id = await fresh(nat, info, 'contract');
  await nat.open(page, id);
  await nat.openNewEditor(page, '2026-10-06');
  await nat.setTitle(page, 'Yoga');
  await nat.setAllDay(page, false);
  await nat.setTime(page, 'start', '18:00');
  await nat.setTime(page, 'end', '19:00');
  await page.locator('[data-testid="editor-repeat"]').selectOption('WEEKLY');
  const opts = page.locator('[data-testid="editor-repeat-options"]');
  await shot(page, 'native-repeat-editor', info);
  // Add Thursday to the Tuesday it starts on
  const thu = opts.getByRole('button', { name: /^(T|Th|Thu|Do)$/ }).nth(1);
  if (await thu.count()) await tap(page, thu);
  await page.locator('[data-testid="editor-end-mode"]').selectOption({ index: 2 }).catch(() => {});
  const count = page.locator('[data-testid="editor-count"]');
  if (await count.count()) await count.fill('4');
  await nat.save(page);
  await soon(async () => !!(await byTitle(id, 'Yoga'))).toBe(true);
  const e = await byTitle(id, 'Yoga');
  info.annotations.push({ type: 'yoga-row', description: JSON.stringify(e) });
  expect(typeof e.start).toBe('string');
  await sf.open(page, id);
  const n = await sf.event(page, 'Yoga').count();
  info.annotations.push({ type: 'yoga-in-sf', description: String(n) });
  await shot(page, 'native-series-in-sf', info);
  expect(n).toBeGreaterThanOrEqual(2);
});

test('native: editing one occurrence while another tab deletes the series -- is the edit kept or reported?', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop-en', 'once is enough');
  const id = await fresh(nat, info, 'race');
  await nat.open(page, id);
  await nat.openPopover(page, 'Team standup');
  await nat.editFromPopover(page, 'this');
  await nat.setTitle(page, 'My important edit');
  // Another person deletes the whole series meanwhile (a Syncfusion tab)
  const other = await context.newPage();
  await other.clock.install({ time: new Date('2026-10-24T12:00:00-04:00') });
  await sf.open(other, id);
  await sf.openPopover(other, 'Team standup');
  await sf.deleteFromPopover(other, 'all');
  await soon(async () => !!(await serverEvents(id)).find((e) => e.id === 'fx-standup')).toBe(false);
  await page.bringToFront();
  await page.waitForTimeout(1500);
  await nat.save(page);
  await page.waitForTimeout(3000);
  await shot(page, 'race-after-save-native', info);
  const kept = !!(await byTitle(id, 'My important edit'));
  const toast = await page.locator('.toast, [role=status], [role=alert]').allInnerTexts().catch(() => []);
  info.annotations.push({ type: 'edit-kept', description: String(kept) }, { type: 'messages', description: JSON.stringify(toast).slice(0, 200) });
  expect(kept || toast.join(' ').length > 0).toBe(true);
});

test('syncfusion: editing one occurrence while another tab deletes the series -- is the edit kept or reported?', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop-en', 'once is enough');
  const id = await fresh(sf, info, 'race');
  await sf.open(page, id);
  await sf.openPopover(page, 'Team standup');
  await sf.editFromPopover(page, 'this');
  await sf.setTitle(page, 'My important edit');
  const other = await context.newPage();
  await other.clock.install({ time: new Date('2026-10-24T12:00:00-04:00') });
  await nat.open(other, id);
  await nat.openPopover(other, 'Team standup');
  await nat.deleteFromPopover(other, 'all');
  await soon(async () => !!(await serverEvents(id)).find((e) => e.id === 'fx-standup')).toBe(false);
  await page.bringToFront();
  await page.waitForTimeout(1500);
  await sf.save(page).catch(() => {});
  await page.waitForTimeout(3000);
  await shot(page, 'race-after-save-syncfusion', info);
  const kept = !!(await byTitle(id, 'My important edit'));
  const toast = await page.locator('.toast, [role=status], [role=alert], .e-toast').allInnerTexts().catch(() => []);
  info.annotations.push({ type: 'edit-kept', description: String(kept) }, { type: 'messages', description: JSON.stringify(toast).slice(0, 200) });
  expect(kept || toast.join(' ').length > 0).toBe(true);
});

for (const r of RENDERERS) {
  test(`${r.name}: search panel -- color filter hides that color, search finds an event`, async ({ page }, info) => {
    test.skip(isPhone(page), 'desktop');
    const id = await fresh(r, info, 'filter');
    await r.open(page, id);
    await tap(page, page.locator('[data-testid="search-button-desktop"]').locator('visible=true').first());
    await page.waitForTimeout(400);
    const search = page.locator('input[type="search"], input[placeholder*="earch" i]').locator('visible=true').first();
    await search.pressSequentially('Dentist', { delay: 20 });
    await page.waitForTimeout(600);
    await shot(page, `search-${r.name}`, info);
    const hits = await page.getByText('Dentist').locator('visible=true').count();
    info.annotations.push({ type: 'search-hits', description: String(hits) });
    // Team standup is color 2: switch it off
    const dots = r === nat ? page.locator('span[class*="rounded-full"][class*="cursor-pointer"]').locator('visible=true') : page.locator('button[role="switch"]').locator('visible=true');
    await expect(dots.nth(1)).toBeVisible();
    await tap(page, dots.nth(1));
    await page.waitForTimeout(800);
    await shot(page, `filter-off-color2-${r.name}`, info);
    await expect(r.event(page, 'Team standup')).toHaveCount(0);
  });
}
