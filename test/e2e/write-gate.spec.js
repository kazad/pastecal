const { test, expect } = require('@playwright/test');

/**
 * Write-path gate: incomplete events must never reach Firebase.
 *
 * Root-cause coverage for the "Server error generating ICS" incident. An event with no
 * start/end was persisted, and the ICS feed for that entire calendar returned 500 to every
 * subscriber until the data was repaired.
 *
 * The server-side tolerance fix (test/unit/ics.test.js) stops a bad row from breaking the
 * feed. This spec covers the other half: stopping the bad row from being written at all.
 *
 * CalendarDataService can't be unit-tested in node — it calls firebase.database() at class
 * load — so this runs in the browser like the other specs here.
 */

const BASE = 'http://localhost:8000';

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return el && el._vnode && el._vnode.component;
  }, { timeout: 15_000 });
}

test('sync() drops events with a missing or invalid start/end', async ({ page }) => {
  await page.goto(BASE + '/');
  await waitForApp(page);

  const result = await page.evaluate(() => {
    // Capture what would actually be handed to Firebase, without writing.
    const written = [];
    const realDb = CalendarDataService.db;
    const realConnected = CalendarDataService.connected;
    CalendarDataService.db = { child: () => ({ set: (v) => written.push(v) }) };
    CalendarDataService.connected = true;

    try {
      const good = new Event({
        title: 'Keep me', start: '2026-05-27T10:00:00.000Z', end: '2026-05-27T13:00:00.000Z',
      });
      // The exact shape of the record that took down the live feed.
      const bad = new Event({ title: 'Öffentlichkeitsreferat', type: 1 });
      const halfBad = new Event({ title: 'Half', start: '2026-05-27T10:00:00.000Z' });

      CalendarDataService.sync({ id: 'test-cal', events: [good, bad, halfBad] });

      return {
        writes: written.length,
        titles: (written[0]?.events ?? []).map(e => e.title),
      };
    } finally {
      CalendarDataService.db = realDb;
      CalendarDataService.connected = realConnected;
    }
  });

  expect(result.writes).toBe(1);
  expect(result.titles).toEqual(['Keep me']);
});

test('sync() still writes a fully valid calendar untouched', async ({ page }) => {
  await page.goto(BASE + '/');
  await waitForApp(page);

  const titles = await page.evaluate(() => {
    const written = [];
    const realDb = CalendarDataService.db;
    const realConnected = CalendarDataService.connected;
    CalendarDataService.db = { child: () => ({ set: (v) => written.push(v) }) };
    CalendarDataService.connected = true;

    try {
      const events = [1, 2, 3].map(n => new Event({
        title: `Event ${n}`, start: '2026-05-27T10:00:00.000Z', end: '2026-05-27T13:00:00.000Z',
      }));
      CalendarDataService.sync({ id: 'test-cal', events });
      return (written[0]?.events ?? []).map(e => e.title);
    } finally {
      CalendarDataService.db = realDb;
      CalendarDataService.connected = realConnected;
    }
  });

  expect(titles).toEqual(['Event 1', 'Event 2', 'Event 3']);
});

test('creating an event through the UI still saves normally', async ({ page }) => {
  // Guards against the gate being over-eager: Calendar.defaultEvent() builds a dateless
  // Event and assigns dates immediately after, so a naive constructor-level check would
  // break real event creation. The gate must sit at the write boundary, not construction.
  await page.goto(BASE + '/');
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const cal = new Calendar('test', 'test', []);
    const e = cal.defaultEvent('Lunch');
    return { complete: Event.isComplete(e), start: e.start, end: e.end };
  });

  expect(result.complete).toBe(true);
  expect(result.start).toBeTruthy();
  expect(result.end).toBeTruthy();
});
