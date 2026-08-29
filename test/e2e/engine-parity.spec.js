// @ts-check
//
// One spec, run against both calendar engines.
//
// The point is not to test NativeCal. It is to state what the calendar must do
// regardless of which engine draws it, so that "can the native engine replace
// Syncfusion yet" has an answer you can run. A case that passes under
// ?cal=syncfusion and fails under ?cal=native is, by definition, a parity gap.
//
// These drive the homepage calendar, which lives in memory until it is claimed,
// so they need no Firebase round trip and no cleanup.

const { test, expect } = require('./fixtures');

const ENGINES = ['syncfusion', 'native'];

// Seed the calendar directly rather than clicking events into existence: this
// spec is about how events are DRAWN, and building them through the UI would
// make every case depend on the create flow too.
const SEED = `(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  const day = (d, h = 0, m = 0) => {
    const x = new Date(); x.setDate(d); x.setHours(h, m, 0, 0); return x.toISOString();
  };
  app.calendar.setEvents([
    { id: 'multi',  title: 'PARITY_MULTI',  start: day(10),     end: day(13, 23, 59), type: 1, isAllDay: false },
    { id: 'allday', title: 'PARITY_ALLDAY', start: day(20),     end: day(20, 23, 59), type: 2, isAllDay: true  },
    { id: 'timed',  title: 'PARITY_TIMED',  start: day(20, 9),  end: day(20, 10),     type: 3, isAllDay: false },
  ]);
  app.updateCalendarView();
  if (app.dismissWelcome) app.dismissWelcome();
})()`;

/** Open the homepage on one engine, with events already in place. */
async function openCalendar(page, engine, { seed = true } = {}) {
  await page.goto(`/?cal=${engine}`);
  await page.waitForFunction(() => {
    const root = document.querySelector('#app');
    const app = root && root._vnode && root._vnode.component;
    return !!(app && app.proxy && app.proxy.engine);
  }, null, { timeout: 20_000 });
  if (seed) {
    await page.evaluate(SEED);
    await page.waitForTimeout(500);
  }
}

/** Put the calendar on a given date and view, whichever engine is running. */
async function show(page, view, dayOfMonth) {
  await page.evaluate(({ view, dayOfMonth }) => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    if (dayOfMonth) {
      const d = new Date(); d.setDate(dayOfMonth); d.setHours(0, 0, 0, 0);
      app.engine.setDate(d);
    }
    if (app.engineName === 'native') {
      app.engine.setView(view);
    } else {
      const index = app.engine.getViewNames().indexOf(view);
      const button = document.querySelectorAll('.e-toolbar-item.e-views button')[index];
      if (button) button.click();
    }
  }, { view, dayOfMonth });
  await page.waitForTimeout(800);
}

/** Every element that is drawing this event, in whichever engine's markup. */
function eventNodes(page, title) {
  return page.locator(
    `.month-bar:has-text("${title}"), .event-card:has-text("${title}"), .e-appointment:has-text("${title}")`
  );
}

for (const engine of ENGINES) {
  test.describe(`calendar parity [${engine}]`, () => {

    test('offers the same six views', async ({ page }) => {
      await openCalendar(page, engine, { seed: false });
      const views = await page.evaluate(
        () => document.querySelector('#app')._vnode.component.proxy.engine.getViewNames());
      // The fourth is the configurable custom view, so it is matched by shape
      // rather than by name -- it reads "3 Months" by default but follows the
      // calendar's own setting.
      expect(views.length).toBe(6);
      expect(views[0]).toBe('Day');
      expect(views[1]).toBe('Week');
      expect(views[2]).toBe('Month');
      expect(views[3]).toMatch(/^\d+ (Week|Weeks|Month|Months)$/);
      expect(views[4]).toBe('Year');
      expect(views[5]).toBe('Agenda');
    });

    // The gap that hid data: an event spanning four days must be findable on
    // all four, not only the day it started.
    test('a multi-day event appears on every day it covers', async ({ page }) => {
      await openCalendar(page, engine);
      await show(page, 'Month');

      const covered = await page.evaluate(() => {
        // Which day cells does the event's box actually overlap horizontally?
        const nodes = [...document.querySelectorAll('.month-bar, .e-appointment')]
          .filter(el => el.textContent.includes('PARITY_MULTI'));
        if (!nodes.length) return 0;
        const cells = [...document.querySelectorAll('.calendar-cell, .e-work-cells')];
        // Both axes: a month grid repeats the same columns on every row, so a
        // horizontal-only test counts the whole column, not the event's days.
        return cells.filter(cell => {
          const c = cell.getBoundingClientRect();
          return nodes.some(n => {
            const b = n.getBoundingClientRect();
            return b.width > 0
              && b.left < c.right - 2 && b.right > c.left + 2
              && b.top < c.bottom - 2 && b.bottom > c.top + 2;
          });
        }).length;
      });

      expect(covered).toBe(4);
    });

    test('an all-day event is separated from timed ones in Week view', async ({ page }) => {
      await openCalendar(page, engine);
      await show(page, 'Week', 20);

      await expect(eventNodes(page, 'PARITY_ALLDAY').first()).toBeVisible();
      await expect(eventNodes(page, 'PARITY_TIMED').first()).toBeVisible();

      // The all-day event belongs above the hour grid, not inside it. Both
      // engines have an all-day row; only its class name differs.
      const allDayIsAboveGrid = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.month-bar, .e-appointment')]
          .find(n => n.textContent.includes('PARITY_ALLDAY'));
        if (!el) return false;
        return !!el.closest('[data-testid="all-day-lane"], .e-all-day-appointment-wrapper, .e-date-header-wrap');
      });
      expect(allDayIsAboveGrid).toBe(true);
    });

    test('the vertical grid starts at the configured hour', async ({ page }) => {
      await openCalendar(page, engine, { seed: false });
      await page.evaluate(() => {
        const app = document.querySelector('#app')._vnode.component.proxy;
        app.globalSettings.startHour = '08:00';
        app.applyGlobalSettings();
      });
      await show(page, 'Week');

      const firstHour = await page.evaluate(() => {
        const app = document.querySelector('#app')._vnode.component.proxy;
        if (app.engineName === 'native') return app.engineState.startHour;
        return app.engine.obj.startHour;
      });
      expect(firstHour).toBe('08:00');
    });

    test('the week starts on the configured day', async ({ page }) => {
      await openCalendar(page, engine, { seed: false });
      await page.evaluate(() => {
        const app = document.querySelector('#app')._vnode.component.proxy;
        app.globalSettings.firstDayOfWeek = '1';
        app.applyGlobalSettings();
      });
      await show(page, 'Month');

      const first = await page.evaluate(() => {
        const header = document.querySelector('.grid-cols-7 > div, .e-header-cells');
        return header ? header.textContent.trim().slice(0, 3).toLowerCase() : null;
      });
      expect(first).toBe('mon');
    });

    test('?d= and ?v= open the calendar where they point', async ({ page }) => {
      await page.goto(`/?cal=${engine}&v=week&d=2027-03-15`);
      await page.waitForFunction(() => {
        const app = document.querySelector('#app')?._vnode?.component?.proxy;
        return !!(app && app.engine && app.engine.getView());
      }, null, { timeout: 20_000 });

      const state = await page.evaluate(() => {
        const app = document.querySelector('#app')._vnode.component.proxy;
        return { view: app.engine.getView(), date: new Date(app.engine.getDate()).toDateString() };
      });
      expect(state.view).toBe('Week');
      expect(state.date).toContain('Mar 15 2027');
    });

    test('?v=12w opens a twelve-week custom view', async ({ page }) => {
      await page.goto(`/?cal=${engine}&v=12w`);
      await page.waitForFunction(() => {
        const app = document.querySelector('#app')?._vnode?.component?.proxy;
        return !!(app && app.engine && app.engine.getView());
      }, null, { timeout: 20_000 });

      const view = await page.evaluate(
        () => document.querySelector('#app')._vnode.component.proxy.engine.getView());
      expect(view).toBe('12 Weeks');
    });

    // A read-only link is a shipped feature. The grid has to refuse edits on its
    // own -- hiding the surrounding chrome is not enough.
    test('a read-only calendar refuses edits from the grid', async ({ page }) => {
      await openCalendar(page, engine);
      await page.evaluate(() => {
        const app = document.querySelector('#app')._vnode.component.proxy;
        app.setIsReadOnly(true);
        app.applyGlobalSettings();
      });
      await show(page, 'Month');

      const before = await page.evaluate(
        () => document.querySelector('#app')._vnode.component.proxy.calendar.events.length);

      // Click an empty day cell, which would normally start a new event.
      const cell = page.locator('.calendar-cell, .e-work-cells').nth(3);
      await cell.click({ force: true });
      await page.waitForTimeout(600);

      await expect(page.getByTestId('quick-create-title')).toHaveCount(0);
      const after = await page.evaluate(
        () => document.querySelector('#app')._vnode.component.proxy.calendar.events.length);
      expect(after).toBe(before);
    });

    test('the agenda is in chronological order', async ({ page }) => {
      await openCalendar(page, engine);
      await page.evaluate(() => {
        const app = document.querySelector('#app')._vnode.component.proxy;
        const day = (d, h = 0) => { const x = new Date(); x.setDate(d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
        app.calendar.setEvents([
          // Deliberately out of order, and inside the window both engines show
          // (Syncfusion's agenda spans 7 days from the selected date, ours 14).
          { id: 'c', title: 'AGENDA_C', start: day(21, 9), end: day(21, 10), type: 1 },
          { id: 'a', title: 'AGENDA_A', start: day(17, 9), end: day(17, 10), type: 1 },
          { id: 'b', title: 'AGENDA_B', start: day(19, 9), end: day(19, 10), type: 1 },
        ]);
        app.updateCalendarView();
      });
      await show(page, 'Agenda', 16);

      const order = await page.evaluate(() =>
        (document.body.innerText.match(/AGENDA_[ABC]/g) || []).filter((v, i, a) => a.indexOf(v) === i));
      expect(order).toEqual(['AGENDA_A', 'AGENDA_B', 'AGENDA_C']);
    });
  });
}

// Rules the editor cannot draw must survive being opened and saved. Native-only:
// Syncfusion ships its own editor, and this is about ours not losing data.
test.describe('native editor keeps recurrence rules it cannot draw', () => {
  const ADVANCED = 'FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9';

  test('an untouched advanced rule is saved back unchanged', async ({ page }) => {
    await openCalendar(page, 'native', { seed: false });

    const saved = await page.evaluate(async (rule) => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      const start = new Date(); start.setDate(17); start.setHours(9, 0, 0, 0);
      const end = new Date(start); end.setHours(10, 0, 0, 0);
      const event = {
        id: 'adv', title: 'Advanced', start: start.toISOString(), end: end.toISOString(),
        type: 1, isAllDay: false, recurrencerule: rule,
      };
      app.calendar.setEvents([{ ...event }]);
      app.editorEvent = { ...event };
      app.showEditor = true;
      await new Promise(r => setTimeout(r, 400));
      document.querySelector('[data-testid="editor-save"]').click();
      await new Promise(r => setTimeout(r, 400));
      return app.calendar.events.find(e => e.id === 'adv').recurrencerule;
    }, ADVANCED);

    expect(saved).toBe(ADVANCED);
  });

  test('touching the weekday picker does rewrite the rule', async ({ page }) => {
    await openCalendar(page, 'native', { seed: false });

    const saved = await page.evaluate(async () => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      const start = new Date(); start.setDate(17); start.setHours(9, 0, 0, 0);
      const end = new Date(start); end.setHours(10, 0, 0, 0);
      const event = {
        id: 'wk', title: 'Weekly', start: start.toISOString(), end: end.toISOString(),
        type: 1, isAllDay: false, recurrencerule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      };
      app.calendar.setEvents([{ ...event }]);
      app.editorEvent = { ...event };
      app.showEditor = true;
      await new Promise(r => setTimeout(r, 400));
      document.querySelector('[data-testid="editor-byday-FR"]').click();
      await new Promise(r => setTimeout(r, 200));
      document.querySelector('[data-testid="editor-save"]').click();
      await new Promise(r => setTimeout(r, 400));
      return app.calendar.events.find(e => e.id === 'wk').recurrencerule;
    });

    expect(saved).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
  });
});

// A recurring event must repeat at its own time of day, not at whatever time the
// page was loaded -- rrule fills the time from the current clock when the rule
// string carries no DTSTART.
test('recurring events keep their own time of day [native]', async ({ page }) => {
  await openCalendar(page, 'native', { seed: false });
  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    const start = new Date(); start.setDate(3); start.setHours(11, 0, 0, 0);
    const end = new Date(start); end.setHours(12, 0, 0, 0);
    app.calendar.setEvents([{
      id: 'rec', title: 'RECUR_TIME', start: start.toISOString(), end: end.toISOString(),
      type: 1, isAllDay: false, recurrencerule: 'FREQ=WEEKLY;BYDAY=MO',
    }]);
    app.updateCalendarView();
    if (app.dismissWelcome) app.dismissWelcome();
  });
  await show(page, 'Month');

  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.month-bar')]
      .filter(el => el.textContent.includes('RECUR_TIME'))
      .map(el => el.textContent.trim().replace(/\s+/g, ' ')));

  expect(labels.length).toBeGreaterThan(1);
  for (const label of labels) expect(label).toContain('11:00');
});
