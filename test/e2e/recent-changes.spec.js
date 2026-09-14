// @ts-check
const { test, expect } = require('./fixtures');

/**
 * The "Recent changes" dialog: what it lists, and whether Restore actually works.
 *
 * This reads the /history node written by the recordHistory Cloud Function, so it needs a
 * claimed calendar and real writes -- there is no way to exercise it from unit tests.
 *
 * The specific defect these cover, found by hand: a row rendered as a bare "1 event
 * deleted" with nothing named, because the diff compared each snapshot only against its
 * neighbour. When an intervening change put an event back, two neighbours hold the same
 * events in a different order, the diff found nothing removed, and the row named nothing
 * the user could act on.
 */

const VM = `document.querySelector('#app')._vnode.component.proxy`;

async function freshCalendar(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const slug = `test-recent-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.locator('input[placeholder="your-name"]').fill(slug);
  await page.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}`), { timeout: 15_000 });
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  return slug;
}

/** Add events straight to the store, then wait for the server to have them. */
async function seed(page, titles) {
  await page.evaluate(`(() => {
    const vm = ${VM};
    ${JSON.stringify(titles)}.forEach((t, i) => {
      const s = new Date(); s.setDate(s.getDate() + i + 1); s.setHours(9, 0, 0, 0);
      const e = new Date(s); e.setHours(10);
      vm.calendar.events.push(new Event({ id: 'R' + i, title: t, start: s.toISOString(), end: e.toISOString(), type: 1 }));
    });
  })()`);
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 })
    .toEqual(expect.arrayContaining(titles));
}

const titlesOnServer = (page) => page.evaluate(`(async () => {
  const snap = await firebase.database().ref('/calendars/' + ${VM}.calendar.id + '/events').once('value');
  const v = snap.val();
  return v ? (Array.isArray(v) ? v : Object.values(v)).map(e => e.title) : [];
})()`);

/** Delete through the scheduler, which is the path that declares intent to the write gate. */
async function deleteEvent(page, title) {
  // The scheduler renders asynchronously after a store change, so wait for it to know
  // about the event before asking it to delete it -- otherwise deleteEvent is a no-op.
  await page.waitForFunction(
    `window.scheduleObj.eventsData.some(e => e.Subject === ${JSON.stringify(title)})`,
    null, { timeout: 10_000 });
  await page.evaluate(`(() => {
    const s = window.scheduleObj;
    const t = s.eventsData.find(e => e.Subject === ${JSON.stringify(title)});
    if (t) s.deleteEvent(t);
  })()`);
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).not.toContain(title);
}

async function openRecentChanges(page) {
  await page.locator('button[aria-label="Settings"]').click();
  await page.locator('button:has-text("Recent changes")').click();
  await expect(page.getByText('Restore events that were deleted or edited.')).toBeVisible();
}

const rows = (page) => page.evaluate(`${VM}.undoEntries.map(e => ({
  what: e.what, label: e.restoreLabel, lost: e.lost.map(x => x.title),
}))`);

test('a deleted event is named in the list, not just counted', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Standup', 'Design review']);
  await deleteEvent(page, 'Design review');

  await openRecentChanges(page);
  const list = await rows(page);

  expect(list.length).toBeGreaterThan(0);
  expect(list[0].what).toContain('Design review');
  expect(list[0].lost).toEqual(['Design review']);
  expect(list[0].label).toBe('Restore event');
  await expect(page.getByText('Deleted "Design review"')).toBeVisible();
});

test('several events deleted at once are all named', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Keep me', 'Budget sync', 'Offsite planning']);

  // Remove two in a single write, as a bulk edit would.
  await page.evaluate(`(() => {
    const vm = ${VM};
    const keep = vm.calendar.events.filter(e => !['Budget sync', 'Offsite planning'].includes(e.title));
    CalendarDataService.declareIntent(2);
    vm.calendar.setEvents(keep);
  })()`);
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).not.toContain('Budget sync');

  await openRecentChanges(page);
  const [first] = await rows(page);

  expect(first.lost.sort()).toEqual(['Budget sync', 'Offsite planning']);
  expect(first.what).toContain('Budget sync');
  expect(first.label).toBe('Restore 2 events');
});

test('every row names what it lost, even after a restore reorders the history', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Standup', 'Design review']);

  // delete -> restore -> delete. The middle entry used to show nothing, because its
  // neighbouring snapshots hold the same events in a different order.
  await deleteEvent(page, 'Design review');
  await openRecentChanges(page);
  await page.locator('button:has-text("Restore event")').first().click();
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).toContain('Design review');

  await page.reload();
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  await deleteEvent(page, 'Design review');
  await openRecentChanges(page);

  const list = await rows(page);
  expect(list.length).toBeGreaterThan(1);
  for (const row of list) {
    // A row that names nothing is the bug: the user cannot tell what it would bring back.
    expect(row.what, `row had no label: ${JSON.stringify(row)}`).not.toMatch(/^\d+ events? deleted$/);
    expect(row.label).not.toBe('');
  }
});

test('Restore puts the event back on the server', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Standup', 'Design review']);
  await deleteEvent(page, 'Design review');

  await openRecentChanges(page);
  await page.locator('button:has-text("Restore")').first().click();

  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).toContain('Design review');
  // and the event it was sitting next to is untouched
  expect(await titlesOnServer(page)).toContain('Standup');
});

test('the Recent changes link is hidden when there is nothing to restore', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Standup']);

  await page.locator('button[aria-label="Settings"]').click();
  await page.waitForTimeout(1_500);
  await expect(page.locator('button:has-text("Recent changes")')).toHaveCount(0);
});
