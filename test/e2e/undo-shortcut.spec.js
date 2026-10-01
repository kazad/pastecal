// @ts-check
const { test, expect } = require('./fixtures');

/**
 * The two recovery paths a person actually reaches for: Cmd/Ctrl+Z, and the Undo offered
 * in the toast at the moment of deletion.
 *
 * Why both exist. The toast catches the immediate "no, not that one" -- it is the pattern
 * Drive, Gmail and Notion all use, and the one moment a person is guaranteed to be looking
 * at the screen. Cmd+Z catches everything after that: it is the reflex, it needs no
 * discovery at all. It undoes this tab's own actions first, from memory (the server's
 * /history entry for something done a moment ago may not exist yet), then falls back to
 * /history -- so it still works after a reload or when the change came from another
 * browser.
 *
 * Neither existed when a user lost a whole calendar and had to file an issue to get it
 * back (#44) -- there was no recovery path in the product at all.
 */

const VM = `document.querySelector('#app')._vnode.component.proxy`;

async function freshCalendar(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const slug = `test-undo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.locator('input[placeholder="your-name"]').fill(slug);
  await page.locator('button:has-text("Claim")').locator('visible=true').first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}`), { timeout: 15_000 });
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });
  return slug;
}

const titlesOnServer = (page) => page.evaluate(`(async () => {
  const snap = await firebase.database().ref('/calendars/' + ${VM}.calendar.id + '/events').once('value');
  const v = snap.val();
  return v ? (Array.isArray(v) ? v : Object.values(v)).map(e => e.title) : [];
})()`);

async function seed(page, titles) {
  await page.evaluate(`(() => {
    const vm = ${VM};
    ${JSON.stringify(titles)}.forEach((t, i) => {
      const s = new Date(); s.setDate(s.getDate() + i + 1); s.setHours(9, 0, 0, 0);
      const e = new Date(s); e.setHours(10);
      vm.calendar.events.push(new Event({ id: 'Z' + i, title: t, start: s.toISOString(), end: e.toISOString(), type: 1 }));
    });
  })()`);
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 })
    .toEqual(expect.arrayContaining(titles));
}

/** Delete through the scheduler, the path a user takes. */
async function deleteEvent(page, title) {
  await page.waitForFunction(
    `window.scheduleObj.eventsData.some(e => e.Subject === ${JSON.stringify(title)})`,
    null, { timeout: 10_000 });
  await page.evaluate(`(() => {
    const s = window.scheduleObj;
    const t = s.eventsData.find(e => e.Subject === ${JSON.stringify(title)});
    if (t) s.deleteEvent(t);
  })()`);
}

const pressUndo = (page) => page.evaluate(
  `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }))`);

test('the delete toast offers Undo, and it puts the event back', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Standup', 'Design review']);
  await deleteEvent(page, 'Design review');

  const undo = page.locator('button', { hasText: /^Undo$/ });
  await expect(page.getByText('Deleted "Design review"')).toBeVisible();
  await expect(undo).toBeVisible();

  await undo.click();
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).toContain('Design review');
  expect(await titlesOnServer(page)).toContain('Standup');
});

const historyCount = (page) => page.evaluate(`(async () => {
  const snap = await firebase.database().ref('/history/' + ${VM}.calendar.id).once('value');
  return snap.numChildren();
})()`);

test('Cmd+Z restores the last deletion after a reload', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Standup', 'Design review']);
  await deleteEvent(page, 'Design review');

  // Reload, so this exercises the server-history path rather than the in-memory stack --
  // the state someone is in when they notice a loss later.
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).not.toContain('Design review');
  await expect.poll(() => historyCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await page.reload();
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });

  await pressUndo(page);
  await expect.poll(() => titlesOnServer(page), { timeout: 15_000 }).toContain('Design review');
  expect(await titlesOnServer(page)).toContain('Standup');
});

test('a second Cmd+Z goes further back instead of redoing the first', async ({ page }) => {
  // Two defects this pins down. Cmd+Z right after a delete used to undo an OLDER change,
  // because the delete's own /history entry had not been written yet. And a second Cmd+Z
  // found the restore -- logged by the server as an addition -- and deleted the event
  // again, so pressing it twice did nothing at all.
  await freshCalendar(page);
  await seed(page, ['Standup', 'Design review', 'Old one']);
  await deleteEvent(page, 'Old one');
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).not.toContain('Old one');
  await expect.poll(() => historyCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  // A fresh tab: 'Old one' is now only reachable through /history.
  await page.reload();
  await page.waitForFunction(`${VM}.isExisting === true`, null, { timeout: 15_000 });

  await deleteEvent(page, 'Design review');
  await pressUndo(page);   // immediately: the server has not logged the delete yet
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).toContain('Design review');
  expect(await titlesOnServer(page), 'the first Cmd+Z must undo the delete just made')
    .not.toContain('Old one');

  // Let the server log both the delete and the restore, so the second press sees them.
  await expect.poll(() => historyCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  await pressUndo(page);
  await expect.poll(() => titlesOnServer(page), { timeout: 15_000 }).toContain('Old one');
  expect(await titlesOnServer(page), 'the second Cmd+Z must not re-delete what the first restored')
    .toContain('Design review');
});

test('a keydown with no key (Chrome autofill) does not throw', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await freshCalendar(page);
  await page.evaluate(`window.dispatchEvent(new Event('keydown'))`);
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true }))`);
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test('an actionable toast stays up while the pointer is on it', async ({ page }) => {
  await freshCalendar(page);
  await page.evaluate(`${VM}.showToast('Deleted "Thing"', 'info', { actionLabel: 'Undo', action: () => {}, duration: 400 })`);
  const undo = page.locator('button', { hasText: /^Undo$/ });
  await expect(undo).toBeVisible();
  await undo.hover();
  await page.waitForTimeout(1_000);
  await expect(undo, 'auto-dismiss must wait while it is hovered').toBeVisible();
  await page.mouse.move(5, 5);
  await expect(undo).toHaveCount(0, { timeout: 5_000 });
});

test('Cmd+Z is ignored while typing, so it still means undo-my-text', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Standup', 'Design review']);
  await deleteEvent(page, 'Design review');
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).not.toContain('Design review');

  // Focus a real text field -- the notes textarea -- then fire the same shortcut.
  // Mobile and desktop each render a notes button; only one is visible at a given width.
  await page.locator('button[aria-label="Toggle notes"]').locator('visible=true').first().click();
  const notes = page.locator('textarea').locator('visible=true').first();
  await expect(notes).toBeVisible({ timeout: 10_000 });
  await notes.focus();
  await pressUndo(page);

  await page.waitForTimeout(2_500);
  expect(await titlesOnServer(page), 'typing must not trigger a calendar-wide undo')
    .not.toContain('Design review');
});

test('Cmd+Z on a calendar with no history says so instead of doing nothing', async ({ page }) => {
  await freshCalendar(page);
  await page.waitForTimeout(1_500);

  await pressUndo(page);
  await expect(page.getByText('Nothing to undo')).toBeVisible({ timeout: 8_000 });
});
