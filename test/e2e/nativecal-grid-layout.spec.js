// @ts-check
const { test, expect } = require('./fixtures');

// nativecal grid geometry. Each test pins a design-audit finding as a number, not a
// screenshot, as in quick-add-mobile.spec.js:
//   - week view hour labels drifted 10px per hour (labels 40px apart, rows 50px), so a
//     9 AM event sat on the 12 PM label
//   - overlapping events drew on top of each other
//   - month header and body columns misaligned, and a long title widened its column
//   - multi-day events showed on their first day only
//   - a busy day grew its cell without bound (200 events -> a 4,836px cell)
//   - phones scrolled sideways and clipped the view switcher
//   - a "New Event" popover outlived a view switch
//   - read-only links still offered create/drag/resize
//   - 5,000 events took 3.2s to paint (every cell scanned every event)
//
// Runs on /nativecal/ (the homepage calendar), seeding events through the app instance,
// so it needs no calendar in the database.

const APP = () => document.getElementById('app')._vnode.component.proxy;

async function open(page, { width = 1280, height = 900 } = {}) {
  await page.setViewportSize({ width, height });
  await page.goto('/nativecal/');
  await expect(page.getByTestId('native-calendar')).toBeVisible({ timeout: 20_000 });
}

// Events relative to today, so they are always on screen in the default month and week.
async function seed(page, build) {
  await page.evaluate(`(() => {
    const vm = document.getElementById('app')._vnode.component.proxy;
    const now = new Date();
    const day = (offset, h = 0, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m).getTime();
    const weekStart = now.getDate() - now.getDay();
    const wday = (i, h = 0, m = 0) => new Date(now.getFullYear(), now.getMonth(), weekStart + i, h, m).getTime();
    const allDay = (i, n) => ({ isAllDay: true, start: wday(i), end: wday(i + n) - 1 });
    vm.calendar.setEvents((${build})({ day, wday, allDay }));
  })()`);
}

async function switchView(page, view) {
  await page.getByTestId('view-' + view.toLowerCase()).click();
}

const rect = (page, sel) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
});

test.describe('nativecal week/day time grid', () => {
  test('hour labels sit on their hour lines, and a 9 AM event on the 9 AM label', async ({ page }) => {
    await open(page);
    await seed(page, `({ day }) => [{ id: 'nine', title: 'Nine', start: day(0, 9), end: day(0, 10), type: 1 }]`);
    await switchView(page, 'Week');
    const geo = await page.evaluate(() => {
      const col = document.querySelector('.time-col');
      const rows = [...col.querySelectorAll('.hour-row')].map((r) => r.getBoundingClientRect().top);
      const labels = [...document.querySelectorAll('.nc-hour-label')].map((l) => {
        const r = l.getBoundingClientRect();
        return { h: Number(l.dataset.hour), mid: (r.top + r.bottom) / 2 };
      });
      const ev = document.querySelector('[data-testid="event-nine"]').getBoundingClientRect();
      return { rows, labels, eventTop: ev.top };
    });
    expect(geo.labels.length).toBe(23);
    for (const l of geo.labels) {
      expect(Math.abs(l.mid - geo.rows[l.h]), `label ${l.h} vs its line`).toBeLessThanOrEqual(1.5);
    }
    const nine = geo.labels.find((l) => l.h === 9);
    expect(Math.abs(geo.eventTop - nine.mid)).toBeLessThanOrEqual(1.5);
  });

  test('overlapping events sit side by side, not on top of each other', async ({ page }) => {
    await open(page);
    await seed(page, `({ day }) => [
      { id: 'a', title: 'A', start: day(0, 9), end: day(0, 10), type: 1 },
      { id: 'b', title: 'B', start: day(0, 9), end: day(0, 10), type: 2 },
      { id: 'c', title: 'C', start: day(0, 9, 30), end: day(0, 11), type: 3 },
      { id: 'solo', title: 'Solo', start: day(0, 14), end: day(0, 15), type: 4 },
    ]`);
    await switchView(page, 'Day');
    const boxes = await page.evaluate(() => Object.fromEntries(['a', 'b', 'c', 'solo'].map((id) => {
      const r = document.querySelector(`[data-testid="event-${id}"]`).getBoundingClientRect();
      return [id, { left: r.left, right: r.right, top: r.top, bottom: r.bottom }];
    })));
    const col = await rect(page, '.time-col');
    const ids = ['a', 'b', 'c'];
    for (const x of ids) for (const y of ids) {
      if (x >= y) continue;
      const X = boxes[x], Y = boxes[y];
      const overlap = Math.min(X.right, Y.right) - Math.max(X.left, Y.left) > 1
        && Math.min(X.bottom, Y.bottom) - Math.max(X.top, Y.top) > 1;
      expect(overlap, `${x} and ${y} overlap`).toBe(false);
    }
    // Three columns in the cluster; the unrelated 2 PM event keeps the full width.
    expect(boxes.a.right - boxes.a.left).toBeLessThan(col.width / 3 + 1);
    expect(boxes.solo.right - boxes.solo.left).toBeGreaterThan(col.width - 8);
  });

  test('a multi-day all-day event spans its columns in the all-day row', async ({ page }) => {
    await open(page);
    await seed(page, `({ allDay }) => [{ id: 'trip', title: 'Trip', type: 6, ...allDay(1, 3) }]`);
    await switchView(page, 'Week');
    const bar = await rect(page, '[data-testid="event-trip"]');
    const cols = await page.evaluate(() => [...document.querySelectorAll('.time-col')].map((c) => {
      const r = c.getBoundingClientRect(); return { left: r.left, right: r.right };
    }));
    expect(Math.abs(bar.left - cols[1].left)).toBeLessThanOrEqual(4);
    expect(Math.abs(bar.right - cols[3].right)).toBeLessThanOrEqual(4);
    // The header, all-day row and body columns line up despite the body's scrollbar.
    const heads = await page.evaluate(() => [...document.querySelectorAll('.nc-tg-head-cell')].map((c) => c.getBoundingClientRect().left));
    heads.forEach((l, i) => expect(Math.abs(l - cols[i].left), `column ${i}`).toBeLessThanOrEqual(1.5));
  });
});

test.describe('nativecal month grid', () => {
  test('header and body columns align, equal width, even with a very long title', async ({ page }) => {
    await open(page);
    await seed(page, `({ day }) => [{ id: 'long', title: 'Supercalifragilisticexpialidocious_' .repeat(6), start: day(0, 9), end: day(0, 10), type: 2 }]`);
    const geo = await page.evaluate(() => ({
      head: [...document.querySelectorAll('.nc-month-head-cell')].map((c) => { const r = c.getBoundingClientRect(); return [r.left, r.right]; }),
      body: [...document.querySelectorAll('[data-testid="month-week-0"] .calendar-cell')].map((c) => { const r = c.getBoundingClientRect(); return [r.left, r.right]; }),
      chip: document.querySelector('[data-testid="event-long"]').getBoundingClientRect().width,
    }));
    expect(geo.head.length).toBe(7);
    const widths = geo.body.map(([l, r]) => r - l);
    for (let i = 0; i < 7; i++) {
      expect(Math.abs(geo.head[i][0] - geo.body[i][0]), `column ${i} left`).toBeLessThanOrEqual(1.5);
      expect(Math.abs(widths[i] - widths[0]), `column ${i} width`).toBeLessThanOrEqual(1.5);
    }
    expect(geo.chip).toBeLessThanOrEqual(widths[0]);
  });

  test('a multi-day event is one bar across its days, not a chip on its first day', async ({ page }) => {
    await open(page);
    await seed(page, `({ allDay }) => [{ id: 'trip', title: 'Trip', type: 6, ...allDay(1, 3) }]`);
    const bars = page.locator('[data-testid="event-trip"]');
    await expect(bars).toHaveCount(1); // the current week holds all three days
    const bar = await rect(page, '[data-testid="event-trip"]');
    const cells = await page.evaluate(() => {
      const today = new Date(); const ws = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
      const want = [1, 3].map((i) => new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i).toISOString());
      return want.map((iso) => { const r = document.querySelector(`.calendar-cell[data-date="${iso}"]`).getBoundingClientRect(); return { left: r.left, right: r.right }; });
    });
    expect(Math.abs(bar.left - cells[0].left)).toBeLessThanOrEqual(5);
    expect(Math.abs(bar.right - cells[1].right)).toBeLessThanOrEqual(5);
  });

  test('timed chips show their start time without a leading zero', async ({ page }) => {
    await open(page);
    await seed(page, `({ day }) => [{ id: 'nine', title: 'Dentist', start: day(0, 9, 5), end: day(0, 10), type: 3 }]`);
    await expect(page.getByTestId('event-nine')).toContainText(/^\s*9:05 AM\s*Dentist\s*$/);
  });

  test('a busy day shows "+N more" and keeps the row height', async ({ page }) => {
    await open(page);
    const before = await rect(page, '[data-testid="month-week-0"]');
    await seed(page, `({ day }) => Array.from({ length: 200 }, (_, i) => ({ id: 'b' + i, title: 'Busy ' + i, start: day(0, 9), end: day(0, 10), type: 1 }))`);
    const more = page.locator('[data-testid^="month-more-"]');
    await expect(more).toHaveCount(1);
    const n = Number((await more.innerText()).match(/\d+/)[0]);
    const shown = await page.locator('[data-testid^="event-b"]').count();
    expect(shown + n).toBe(200);
    expect(shown).toBeLessThanOrEqual(6);
    const after = await rect(page, '[data-testid="month-week-0"]');
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    // "+N more" opens that day.
    await more.click();
    await expect(page.getByTestId('view-day')).toHaveAttribute('aria-pressed', 'true');
  });

  test('5,000 events: the month paints fast and draws a bounded number of nodes', async ({ page }) => {
    await open(page);
    const ms = await page.evaluate(async () => {
      const vm = document.getElementById('app')._vnode.component.proxy;
      const now = new Date();
      const evs = [];
      for (let i = 0; i < 5000; i++) {
        // ~400 in the visible 6 weeks, the rest spread over two years either side.
        const offset = i % 12 === 0 ? (i % 40) - 20 : (i % 1460) - 730;
        const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 8 + (i % 10)).getTime();
        evs.push({ id: 'p' + i, title: 'Perf ' + i, start: s, end: s + 3600e3, type: 1 + (i % 8) });
      }
      const t0 = performance.now();
      vm.calendar.setEvents(evs);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    });
    expect(ms, `paint took ${Math.round(ms)}ms`).toBeLessThan(1500);
    const nodes = await page.locator('[data-testid^="event-p"]').count();
    expect(nodes).toBeLessThanOrEqual(42 * 6);
    const nav = await page.evaluate(async () => {
      const t0 = performance.now();
      document.querySelector('[data-testid="nav-next"]').click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    });
    expect(nav, `next month took ${Math.round(nav)}ms`).toBeLessThan(400);
  });
});

test.describe('nativecal on a phone', () => {
  for (const width of [320, 375]) {
    test(`opens on the agenda, no sideways scroll, switcher fully visible at ${width}px`, async ({ page }) => {
      await open(page, { width, height: 740 });
      await expect(page.getByTestId('agenda-view')).toBeVisible();
      for (const view of ['Agenda', 'Month', 'Week', 'Day']) {
        await switchView(page, view);
        const scrollW = await page.evaluate(() => document.querySelector('[data-testid="native-calendar"]').scrollWidth);
        const calW = await page.evaluate(() => document.querySelector('[data-testid="native-calendar"]').clientWidth);
        expect(scrollW, `${view} scrolls sideways`).toBeLessThanOrEqual(calW + 1);
        const btns = await page.locator('[data-testid="view-switcher"] button').evaluateAll((els) =>
          els.map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, sw: e.scrollWidth, cw: e.clientWidth }; }));
        for (const b of btns) {
          expect(b.left).toBeGreaterThanOrEqual(0);
          expect(b.right).toBeLessThanOrEqual(width);
          expect(b.sw, 'label clipped').toBeLessThanOrEqual(b.cw + 1);
        }
      }
    });
  }
});

test.describe('nativecal transient state', () => {
  test('a "New Event" popover closes when the view changes', async ({ page }) => {
    await open(page);
    await page.locator('.calendar-cell:not(.opacity-50)').nth(10).click();
    await expect(page.getByTestId('quick-create-title')).toBeVisible();
    await switchView(page, 'Week');
    await expect(page.getByTestId('quick-create-title')).toBeHidden();
    await expect(page.locator('.nc-card-ghost, .nc-ghost')).toHaveCount(0);
  });

  test('and when the date changes', async ({ page }) => {
    await open(page);
    await page.locator('.calendar-cell:not(.opacity-50)').nth(10).click();
    await expect(page.getByTestId('quick-create-title')).toBeVisible();
    await page.getByTestId('nav-next').click();
    await expect(page.getByTestId('quick-create-title')).toBeHidden();
  });
});

test.describe('nativecal read-only grid', () => {
  test('no create, drag or resize affordances; events still open', async ({ page }) => {
    await open(page);
    await seed(page, `({ day }) => [{ id: 'ro', title: 'Read me', start: day(0, 9), end: day(0, 10), type: 1 }]`);
    await page.evaluate(() => document.getElementById('app')._vnode.component.proxy.setIsReadOnly(true));
    await page.locator('.calendar-cell:not(.opacity-50)').nth(10).click();
    await expect(page.getByTestId('quick-create-title')).toBeHidden();

    await switchView(page, 'Day');
    await expect(page.locator('.resize-handle')).toHaveCount(0);
    const card = page.getByTestId('event-ro');
    const before = await rect(page, '[data-testid="event-ro"]');
    await card.hover();
    await page.mouse.down();
    await page.mouse.move(before.left + 10, before.top + 150, { steps: 5 });
    await page.mouse.up();
    const after = await rect(page, '[data-testid="event-ro"]');
    expect(after.top).toBe(before.top);
    await page.locator('.time-col').first().click({ position: { x: 20, y: 700 } });
    await expect(page.getByTestId('quick-create-title')).toBeHidden();
    await card.click();
    await expect(page.getByTestId('popover-title')).toHaveText('Read me');
  });
});
