// @ts-check
const { test, expect } = require('./fixtures');

/**
 * The client-side half of the data-loss defences added after issues #42-#44:
 *
 *   - the write gate: sync() refuses to empty a calendar of >=3 events in one write
 *     unless a delete action declared itself first, and tells the user how to recover
 *   - the local backup: a named calendar now has a per-browser copy of its last good
 *     state, and that copy is never overwritten by an empty one
 *   - flush on pagehide: a pending debounced write is sent before the page goes away
 *
 * The server-side half (the /history trigger and its rules) is covered by
 * test/unit/history-service.emulator.test.js; the dev server here runs hosting only.
 */

const VM = `document.querySelector('#app')._vnode.component.proxy`;

async function freshCalendar(page) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  const slug = `test-safety-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.locator('input[placeholder="your-name"]').fill(slug);
  await page.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}`), { timeout: 15_000 });
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  return slug;
}

/** Push N events straight onto the reactive store (the path that has always worked). */
function seed(page, titles) {
  return page.evaluate(`(() => {
    const vm = ${VM};
    ${JSON.stringify(titles)}.forEach((t, i) => {
      const s = new Date(); s.setDate(s.getDate() + i); s.setHours(9, 0, 0, 0);
      const e = new Date(s); e.setHours(10);
      vm.calendar.events.push(new Event({ id: 'SEED' + i, title: t, start: s.toISOString(), end: e.toISOString(), type: 1 }));
    });
  })()`);
}

const serverTitles = (page) => page.evaluate(`(async () => {
  const id = ${VM}.calendar.id;
  const snap = await firebase.database().ref('/calendars/' + id + '/events').once('value');
  const v = snap.val();
  return v ? (Array.isArray(v) ? v : Object.values(v)).map(e => e.title).sort() : [];
})()`);

test('the gate refuses a write that would empty a calendar with no delete action', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['A', 'B', 'C']);
  await expect.poll(() => serverTitles(page)).toEqual(['A', 'B', 'C', 'Sample event']);

  // Wait for the subscription to deliver our own write back, so _lastSeen is the
  // 4-event state and the gate has a baseline to compare against.
  await page.waitForFunction(`(CalendarDataService._lastSeen[${VM}.calendar.id] || []).length === 4`, null, { timeout: 10_000 });

  // Record whether the gate fires, on the durable hook rather than the 3s-lived toast.
  await page.evaluate(`(() => {
    window.__refused = null;
    const orig = CalendarDataService.onSyncRefused;
    CalendarDataService.onSyncRefused = (x) => { window.__refused = x; if (orig) orig(x); };
  })()`);

  // Simulate the bug: a code path replaces the whole array with nothing, declaring no
  // intent. This is what actionComplete did on 11-14 Sept.
  await page.evaluate(`${VM}.calendar.events = []`);

  await expect.poll(() => page.evaluate(`window.__refused`), { timeout: 5_000 }).not.toBeNull();
  expect(await page.evaluate(`window.__refused.before`)).toBe(4);
  await page.waitForTimeout(1_000);
  expect(await serverTitles(page)).toEqual(['A', 'B', 'C', 'Sample event']);

  // And the screen is put back on its own: a refusal that left the user looking at an
  // emptied calendar until they thought to reload would be its own kind of data loss.
  await expect.poll(() => page.evaluate(`${VM}.calendar.events.length`), { timeout: 5_000 }).toBe(4);
});

test('a smaller loss is refused too: the gate is not limited to full wipes', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['A']);   // + Sample event = 2
  await expect.poll(() => serverTitles(page)).toEqual(['A', 'Sample event']);
  await page.waitForFunction(`(CalendarDataService._lastSeen[${VM}.calendar.id] || []).length === 2`, null, { timeout: 10_000 });

  await page.evaluate(`(() => { window.__refused = null; CalendarDataService.onSyncRefused = (x) => { window.__refused = x; }; })()`);
  await page.evaluate(`${VM}.calendar.events = []`);

  await expect.poll(() => page.evaluate(`window.__refused`), { timeout: 5_000 }).not.toBeNull();
  await page.waitForTimeout(1_000);
  expect(await serverTitles(page)).toEqual(['A', 'Sample event']);
});

test('a delete still in flight does not license a wipe behind it', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['A', 'B', 'C', 'D']);
  await expect.poll(() => serverTitles(page)).toHaveLength(5);
  await page.waitForFunction(`(CalendarDataService._lastSeen[${VM}.calendar.id] || []).length === 5`, null, { timeout: 10_000 });

  // The user deletes one event -- a declaration for exactly one removal.
  await page.evaluate(`(() => { const s = window.scheduleObj; s.deleteEvent(s.eventsData[0]); })()`);
  await expect.poll(() => serverTitles(page), { timeout: 8_000 }).toHaveLength(4);

  // A buggy path then empties the array. Authorising one removal must not authorise four.
  await page.evaluate(`(() => { window.__refused = null; CalendarDataService.onSyncRefused = (x) => { window.__refused = x; }; })()`);
  await page.evaluate(`${VM}.calendar.events = []`);
  await expect.poll(() => page.evaluate(`window.__refused`), { timeout: 5_000 }).not.toBeNull();
  await page.waitForTimeout(1_000);
  expect(await serverTitles(page)).toHaveLength(4);
});

test('deleting events one at a time down to zero is not refused', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['A', 'B', 'C']);
  await expect.poll(() => serverTitles(page)).toEqual(['A', 'B', 'C', 'Sample event']);
  await page.waitForFunction(`(CalendarDataService._lastSeen[${VM}.calendar.id] || []).length === 4`, null, { timeout: 10_000 });

  // Through the scheduler, which is the path that declares intent.
  for (const t of ['A', 'B', 'C', 'Sample event']) {
    await page.evaluate(`(() => { const s = window.scheduleObj; s.deleteEvent(s.eventsData.find(e => e.Subject === ${JSON.stringify(t)})); })()`);
    await page.waitForTimeout(700);
  }
  await expect.poll(() => serverTitles(page), { timeout: 8_000 }).toEqual([]);
  await expect(page.getByText(/Refused to save/)).toHaveCount(0);
});

test('a named calendar keeps a local backup, and an empty state never overwrites it', async ({ page }) => {
  const slug = await freshCalendar(page);
  await seed(page, ['KEEP_ME']);
  await expect.poll(() => serverTitles(page)).toContain('KEEP_ME');

  const backup = () => page.evaluate(`JSON.parse(localStorage.getItem('pastecal_backup_' + ${JSON.stringify(slug)}) || 'null')`);
  await expect.poll(async () => (await backup())?.events?.map(e => e.title)).toContain('KEEP_ME');

  // The failure this guards: events vanish locally. The backup must not follow them.
  await page.evaluate(`${VM}.calendar.events = []`);
  await page.waitForTimeout(800);
  const after = await backup();
  expect(after.events.map(e => e.title)).toContain('KEEP_ME');
});

test('a write pending in the debounce is flushed when the page is hidden', async ({ page }) => {
  await freshCalendar(page);
  await page.waitForTimeout(1_000);

  // Measured before this change: a create followed by a reload 50ms later was lost.
  // pagehide now flushes the pending sync first.
  await page.evaluate(`(() => {
    const vm = ${VM};
    const s = new Date(); s.setHours(9, 0, 0, 0); const e = new Date(s); e.setHours(10);
    vm.calendar.events.push(new Event({ id: 'TICK', title: 'FLUSHED', start: s.toISOString(), end: e.toISOString(), type: 1 }));
    setTimeout(() => location.reload(), 50);
  })()`).catch(() => {});
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  await expect.poll(() => serverTitles(page), { timeout: 8_000 }).toContain('FLUSHED');
});
