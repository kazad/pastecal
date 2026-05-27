// @ts-check
// Regression tests for all-day event persistence.
//
// Bug history: The Calendar.getSyncFusionEvents() mapper omitted the IsAllDay field
// (line 23 was commented out), so:
//   1. Events with isAllDay=true were rendered by Syncfusion as timed events
//      (with a visible time block), and
//   2. When opened in the editor, the "All day" checkbox was unchecked because
//      Syncfusion never received the flag.
// The Event model stored isAllDay correctly — only the Syncfusion mapper dropped it.

const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8000';

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!window.scheduleObj && !!document.getElementById('app')?._vnode?.component?.proxy,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1500);
}

async function getProxy() {
  return document.getElementById('app')._vnode.component.proxy;
}

test.describe('All-day event persistence', () => {
  test('isAllDay survives the round-trip through Syncfusion', async ({ page }) => {
    // Use a fresh URL slug so we don't collide with other tests' Firebase writes.
    const slug = 'allday-test-' + Date.now().toString().slice(-8);
    await page.goto(BASE + '/' + slug);
    await waitForApp(page);

    // Seed an all-day event on the Vue-side Event model and push it into the calendar.
    await page.evaluate(() => {
      const proxy = document.getElementById('app')._vnode.component.proxy;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const allDayEvent = new Event({
        title: 'All Day Event',
        start: today.toISOString(),
        end: tomorrow.toISOString(),
        isAllDay: true,
        type: 1,
      });
      proxy.calendar.events = [allDayEvent];
      proxy.syncFusionEvents = proxy.calendar.getSyncFusionEvents();
      window.scheduleObj.eventSettings.dataSource = proxy.syncFusionEvents;
    });

    await page.waitForTimeout(500);

    // Assert: the Syncfusion data source for the rendered event carries IsAllDay.
    // This is what controls whether Syncfusion renders the event in the all-day band
    // (no time block) and shows the "All day" checkbox in the editor.
    const sfEvent = await page.evaluate(() => {
      const proxy = document.getElementById('app')._vnode.component.proxy;
      const sf = proxy.calendar.getSyncFusionEvents()[0];
      return { hasIsAllDay: 'IsAllDay' in sf, IsAllDay: sf.IsAllDay };
    });

    expect(sfEvent.hasIsAllDay).toBe(true);
    expect(sfEvent.IsAllDay).toBe(true);
  });

  test('round-trip Event(getSyncFusionEvents()[0]) preserves isAllDay', async ({ page }) => {
    // This test exercises the round-trip path Syncfusion takes when the user edits
    // an event: schedule emits an event object, we wrap it in `new Event(sf)`, and
    // store it. If isAllDay is dropped anywhere along the way, the user sees an
    // all-day event re-open with the "All day" checkbox unchecked.
    await page.goto(BASE + '/');
    await waitForApp(page);

    const result = await page.evaluate(() => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const original = new Event({
        title: 'All Day',
        start: today.toISOString(),
        end: tomorrow.toISOString(),
        isAllDay: true,
      });
      const cal = new Calendar('test', 'test', [original]);
      const sfEvents = cal.getSyncFusionEvents();
      const sf = sfEvents[0];
      const roundTripped = new Event(sf);
      return {
        sfHasIsAllDay: 'IsAllDay' in sf,
        sfIsAllDay: sf.IsAllDay,
        roundTrippedIsAllDay: roundTripped.isAllDay,
      };
    });

    expect(result.sfHasIsAllDay).toBe(true);
    expect(result.sfIsAllDay).toBe(true);
    expect(result.roundTrippedIsAllDay).toBe(true);
  });

  test('no field on a saved Event is ever undefined (Firebase compatibility)', async ({ page }) => {
    // Firebase real-time DB rejects any write containing undefined fields — the *entire*
    // calendar save fails silently. This is why the IsAllDay mapping was originally
    // commented out: an earlier attempt used the wrong field name (`e.allday`), produced
    // `IsAllDay: undefined`, and broke the whole save path. Lock in the contract: every
    // field on every Event after construction must be boolean, string, number, array, or
    // null — never undefined. Same for the Syncfusion-mapped shape we serialize.
    await page.goto(BASE + '/');
    await waitForApp(page);

    const result = await page.evaluate(() => {
      const minimalAllDay = new Event({ isAllDay: true });
      const minimalTimed = new Event({});
      const fromSyncfusionShape = new Event({
        Subject: 'From SF', StartTime: new Date(), EndTime: new Date(), Type: 2,
      });

      const cal = new Calendar('test', 'test', [minimalAllDay, minimalTimed, fromSyncfusionShape]);
      const sfEvents = cal.getSyncFusionEvents();

      const undefinedFieldsByCase = {
        minimalAllDay: Object.entries(minimalAllDay).filter(([, v]) => v === undefined).map(([k]) => k),
        minimalTimed: Object.entries(minimalTimed).filter(([, v]) => v === undefined).map(([k]) => k),
        fromSyncfusionShape: Object.entries(fromSyncfusionShape).filter(([, v]) => v === undefined).map(([k]) => k),
        sf_0: Object.entries(sfEvents[0]).filter(([, v]) => v === undefined).map(([k]) => k),
        sf_1: Object.entries(sfEvents[1]).filter(([, v]) => v === undefined).map(([k]) => k),
        sf_2: Object.entries(sfEvents[2]).filter(([, v]) => v === undefined).map(([k]) => k),
      };
      return { undefinedFieldsByCase, isAllDayValues: sfEvents.map(e => e.IsAllDay) };
    });

    expect(result.undefinedFieldsByCase.minimalAllDay).toEqual([]);
    expect(result.undefinedFieldsByCase.minimalTimed).toEqual([]);
    expect(result.undefinedFieldsByCase.fromSyncfusionShape).toEqual([]);
    expect(result.undefinedFieldsByCase.sf_0).toEqual([]);
    expect(result.undefinedFieldsByCase.sf_1).toEqual([]);
    expect(result.undefinedFieldsByCase.sf_2).toEqual([]);
    // IsAllDay should always be a real boolean, never undefined.
    for (const v of result.isAllDayValues) expect(typeof v).toBe('boolean');
  });

  test('CalendarDataService._sanitizeForFirebase strips undefined recursively', async ({ page }) => {
    // Belt-and-suspenders: even if a future code path tries to save an object with
    // undefined fields, the sanitizer at the write boundary converts them to null so
    // the Firebase save succeeds instead of silently failing.
    await page.goto(BASE + '/');
    await waitForApp(page);

    const result = await page.evaluate(() => {
      const input = {
        id: 'x',
        title: undefined,
        events: [
          { id: 'a', title: 'A', extra: undefined, nested: { keep: 1, drop: undefined } },
          undefined,
        ],
        options: { publicViewId: undefined, theme: 'dark' },
      };
      const out = CalendarDataService._sanitizeForFirebase(input);
      const findUndefined = (v, path = '') => {
        if (v === undefined) return [path || '<root>'];
        if (v === null || typeof v !== 'object') return [];
        const results = [];
        for (const [k, val] of Object.entries(v)) {
          results.push(...findUndefined(val, path ? `${path}.${k}` : k));
        }
        if (Array.isArray(v)) {
          v.forEach((val, i) => results.push(...findUndefined(val, `${path}[${i}]`)));
        }
        return results;
      };
      return {
        out,
        undefinedPaths: findUndefined(out),
      };
    });

    expect(result.undefinedPaths).toEqual([]);
    expect(result.out.title).toBeNull();
    expect(result.out.events[0].extra).toBeNull();
    expect(result.out.events[0].nested.drop).toBeNull();
    expect(result.out.events[0].nested.keep).toBe(1);
    expect(result.out.events[1]).toBeNull();
    expect(result.out.options.publicViewId).toBeNull();
    expect(result.out.options.theme).toBe('dark');
  });
});
