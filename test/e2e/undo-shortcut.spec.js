// @ts-check
const { test, expect } = require('./fixtures');

/**
 * The two recovery paths a person actually reaches for: Cmd/Ctrl+Z, and the Undo offered
 * in the toast at the moment of deletion.
 *
 * Why both exist. The toast catches the immediate "no, not that one" -- it is the pattern
 * Drive, Gmail and Notion all use, and the one moment a person is guaranteed to be looking
 * at the screen. Cmd+Z catches everything after that: it is the reflex, it needs no
 * discovery at all, and because it reads the server's /history rather than a local stack,
 * it still works after a reload or when the change came from another browser.
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

test('Cmd+Z restores the last deletion after the toast is gone', async ({ page }) => {
  await freshCalendar(page);
  await seed(page, ['Standup', 'Design review']);
  await deleteEvent(page, 'Design review');

  // Wait past the toast, so this exercises the server-history path rather than the
  // in-memory offer -- the state someone is in when they notice a loss later.
  await expect.poll(() => titlesOnServer(page), { timeout: 10_000 }).not.toContain('Design review');
  await page.evaluate(`document.querySelector('#app')._vnode.component.proxy.$refs.toast.hide()`);

  await pressUndo(page);
  await expect.poll(() => titlesOnServer(page), { timeout: 15_000 }).toContain('Design review');
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
