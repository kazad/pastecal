// @ts-check
/**
 * Import a .ics three ways (Oct 28 2026), and never twice. Driven like a person, in the classic calendar and ?cal=native,
 * checked against what the SERVER stored (GET /cal/<id>), not the screen.
 *
 * Three ways in: Settings' Backup row (ics-backup.spec.js), quick add's quiet "or import a .ics file" link, and a file
 * dropped on the calendar ("Drop to add these events" only while it is over the page). All three open the same import
 * dialog (its lists: ics-preview.spec.js): the plan, Import / Cancel (Done when there is nothing to do), then Undo.
 *
 * The owner, Oct 28 2026: "robust, no duplicates, if you import multiple times etc.":
 *   R1  the same file 3 times in a row from each way in, and mixed (Settings, then a drop, then quick add): the events
 *       and every stored row identical after the first
 *   R2  two browsers importing the same file at the same moment: no duplicates once both are done
 *   R3  import, Undo, import again: exactly one copy
 *   R4  import, rename an imported event, import again: the plan says Update 1 event; Cancel keeps the rename
 *   R5  a series with an edited occurrence (RECURRENCE-ID) and a skipped date (EXDATE), twice: one series, one edited
 *       occurrence, the date stays skipped, nothing drawn twice in the month
 *   R6  Download .ics into the same calendar twice: nothing changes; into an empty one twice: the source's rows
 *   R7  a Google Calendar export (TZID, folded lines, alarms, attendees) twice: no duplicates, alarms and attendees ignored
 *   R8  1,000 events twice: the second adds nothing
 *   R9  dropping a file that isn't a calendar, or a broken one: said on the page, nothing saved
 * Screenshots (light, dark): cloudflare/test-results/ics-entry/. Run with scripts/test-on-box.sh ics-entry.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'test-results', 'ics-entry');
fs.mkdirSync(OUT, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const LABELS = ['Practice', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];
const TZ = 'America/Los_Angeles';

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (uid, summary, start, end, extra = []) => ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART;TZID=${TZ}:${start}`, `DTEND;TZID=${TZ}:${end}`, ...extra, 'END:VEVENT'];
const write = (name, text) => { const f = path.join(OUT, name); fs.writeFileSync(f, text); return f; };

// A small team calendar: three events.
const TEAM = write('team.ics', ics(
    vevent('t1@x', 'Practice', '20261006T170000', '20261006T183000'),
    vevent('t2@x', 'Game vs Hawks', '20261010T100000', '20261010T113000'),
    vevent('t3@x', 'Team party', '20261024T160000', '20261024T190000')));
// A series with a skipped date and an edited occurrence (Google writes the override as a second VEVENT, same UID).
const SERIES = write('series.ics', ics(
    vevent('swim@google.com', 'Swim', '20261005T160000', '20261005T170000', ['RRULE:FREQ=WEEKLY;BYDAY=MO', `EXDATE;TZID=${TZ}:20261012T160000`]),
    ['BEGIN:VEVENT', 'UID:swim@google.com', `RECURRENCE-ID;TZID=${TZ}:20261019T160000`, 'SUMMARY:Swim (late)',
        `DTSTART;TZID=${TZ}:20261019T180000`, `DTEND;TZID=${TZ}:20261019T190000`, 'END:VEVENT']));
// A Google Calendar export: a VTIMEZONE, folded lines, alarms and attendees.
const GOOGLE = write('google.ics', ['BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:Family', `X-WR-TIMEZONE:${TZ}`,
    'BEGIN:VTIMEZONE', `TZID:${TZ}`, 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700', 'TZNAME:PDT', 'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'TZNAME:PST',
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', `DTSTART;TZID=${TZ}:20261015T090000`, `DTEND;TZID=${TZ}:20261015T100000`, 'DTSTAMP:20261001T000000Z',
    'UID:dentist-9f8e7d@google.com', 'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Sam Lee;X-NUM-GUESTS=0:mailto:sam@',
    ' example.com', 'ORGANIZER;CN=Ann:mailto:ann@example.com', 'CREATED:20261001T000000Z',
    'DESCRIPTION:Bring the insurance card and the forms from the school office. This line is long enough that Goo',
    ' gle folds it onto a second line.', 'LOCATION:Main St\\, Suite 4', 'SEQUENCE:0', 'STATUS:CONFIRMED', 'SUMMARY:Dentist', 'TRANSP:OPAQUE',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:This is an event reminder', 'TRIGGER:-P0DT0H30M0S', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:EMAIL', 'DESCRIPTION:This is an event reminder', 'SUMMARY:Alarm notification', 'ATTENDEE:mailto:sam@example.com',
    'TRIGGER:-P1D', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261126', 'DTEND;VALUE=DATE:20261127', 'UID:thanksgiving-1a2b@google.com', 'SUMMARY:Thanksgiving',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME:20261125T170000Z', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n'));
const NOT_ICS = write('roster.csv', 'name,date\nSam,2026-10-06\n');
const BROKEN = write('broken.ics', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:half@x\r\nSUMMARY:Half an event\r\n');
const NO_DATE = write('no-date.ics', ics(['BEGIN:VEVENT', 'UID:nodate@x', 'SUMMARY:Sometime', 'END:VEVENT']));

let n = 0;
async function seed(events = [], title = 'Import test') {
  const id = `icse-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, options: { typeLabels: LABELS, tz: TZ }, events }) });
  expect(res.status).toBe(201);
  return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const sorted = (events) => [...events].sort((a, b) => `${a.id}|${a.recurrenceID}`.localeCompare(`${b.id}|${b.recurrenceID}`));
const soon = (fn, timeout = 10_000) => expect.poll(fn, { timeout, intervals: [100] });

async function open(browser, id, { native = false, colorScheme = 'light', query = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, timezoneId: TZ, locale: 'en-US', colorScheme, acceptDownloads: true });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${id}?backend=cf${native ? '&cal=native' : ''}${query}`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  await expect(page.locator(native ? '.nc.nc-editable' : '.e-schedule .e-work-cells').first()).toBeVisible({ timeout: 20_000 });
  // A save the server refused says so in the console (CloudCalendarService._onError).
  const refused = [];
  page.on('console', (m) => { if (m.type() === 'error' && /refused/i.test(m.text())) refused.push(m.text()); });
  return { ctx, page, errors, native, refused };
}
const calendarEl = (native) => (native ? '.nc.nc-editable' : '#Schedule');

/** A file dragged over the calendar: the overlay shows while it is over, and goes when it drops. */
async function drop(page, native, file, { type = 'text/calendar', check = true } = {}) {
  const content = fs.readFileSync(file, 'utf8');
  await page.evaluate(({ content, name, type, sel }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type }));
    window.__dt = dt;
    const el = document.querySelector(sel);
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { content, name: path.basename(file), type, sel: calendarEl(native) });
  if (check) await expect(page.getByTestId('ics-drop')).toHaveText('Drop to add these events');
  const prevented = await page.evaluate(({ sel }) => {
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt });
    document.querySelector(sel).dispatchEvent(ev);
    return ev.defaultPrevented;
  }, { sel: calendarEl(native) });
  expect(prevented, 'the browser never opens the dropped file in place of the page').toBe(true);
  await expect(page.getByTestId('ics-drop')).toHaveCount(0);
}

/** Quick add's "or import a .ics file": its file picker, then the dialog. */
async function viaQuickAdd(page, file) {
  await page.getByTestId('desktop-add-event-button').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('qa-import').click()]);
  await expect(page.locator('.pc-qa-dialog')).toHaveCount(0);   // quick add makes way for the import
  await chooser.setFiles(file);
}

/** Settings' Backup row: Import .ics. */
async function viaSettings(page, file) {
  if (!(await page.getByTestId('settings-backup').isVisible().catch(() => false))) await page.getByTestId('settings-button-desktop').click();
  await page.getByTestId('ics-file').setInputFiles(file);
}

/** One import from `how`, to the plan: its summary. */
async function plan(t, how, file) {
  if (how === 'settings') await viaSettings(t.page, file);
  else if (how === 'quickadd') await viaQuickAdd(t.page, file);
  else await drop(t.page, t.native, file);
  const where = t.page.getByTestId('ics-dialog');
  // Reading and planning the file is quick, but a classic calendar on a fully loaded test box (24 browsers) has taken over
  // 5 s to show it (passes 16/16 at 4 workers): wait longer here rather than call it flaky.
  // What the dialog proposes: its Import button ("Import 3 events"), or with nothing to do its one line ("Nothing new: ...").
  const says = where.locator('[data-testid="ics-confirm"], [data-testid="ics-plan"]').first();
  await expect(says).toBeVisible({ timeout: 15_000 });
  return (await says.textContent()).trim();
}
/** Import, and the result line; a dialog is then closed with Done. */
async function confirm(t, how) {
  await t.page.getByTestId('ics-confirm').click();
  const note = (await t.page.getByTestId('ics-note').textContent()).trim();
  return note;
}
/** Cancel, or Done when the plan has nothing to do (then there is no Cancel). */
async function cancel(t) {
  const nothing = !(await t.page.getByTestId('ics-confirm').count());
  await t.page.getByTestId(nothing ? 'ics-done' : 'ics-cancel').click();
  await expect(t.page.getByTestId('ics-plan')).toHaveCount(0);
  await expect(t.page.getByTestId('ics-dialog')).toHaveCount(0);
}
async function done(t) { await t.page.getByTestId('ics-done').click(); await expect(t.page.getByTestId('ics-dialog')).toHaveCount(0); }

for (const native of [false, true]) {
  const where = native ? 'native' : 'classic';

  for (const how of ['settings', 'quickadd', 'drop']) {
    test(`R1 ${where} ${how}: the same file 3 times in a row: the events and every stored row identical after the first`, async ({ browser }) => {
      const id = await seed();
      const t = await open(browser, id, { native, query: '&view=month&date=2026-10-01' });
      expect(await plan(t, how, TEAM)).toBe('Import 3 events');
      expect(await stored(id)).toEqual([]);   // nothing saved before Import
      if (!native) await t.page.screenshot({ path: path.join(OUT, `${how}-plan-light.png`) });
      expect(await confirm(t, how)).toContain('Added 3 events.');
      if (!native) await t.page.getByTestId('ics-dialog').screenshot({ path: path.join(OUT, `${how}-result-light.png`) });
      await done(t);
      await soon(async () => (await stored(id)).length).toBe(3);
      const first = sorted(await stored(id));
      for (const round of [2, 3]) {
        expect(await plan(t, how, TEAM), `round ${round}`).toBe('Nothing new: all 3 events in this file are already in this calendar.');
        await expect(t.page.getByTestId('ics-confirm')).toHaveCount(0);
        await cancel(t);
        expect(sorted(await stored(id)), `round ${round}`).toEqual(first);
      }
      expect(t.errors).toEqual([]);
      await t.ctx.close();
    });
  }

  test(`R1 ${where} mixed: Settings, then a drop, then quick add: one copy`, async ({ browser }) => {
    const id = await seed();
    const t = await open(browser, id, { native });
    expect(await plan(t, 'settings', TEAM)).toBe('Import 3 events');
    await confirm(t, 'settings');
    await done(t);
    await soon(async () => (await stored(id)).length).toBe(3);
    const first = sorted(await stored(id));
    await t.page.getByTestId('side-close').click();
    expect(await plan(t, 'drop', TEAM)).toBe('Nothing new: all 3 events in this file are already in this calendar.');
    await cancel(t);
    expect(await plan(t, 'quickadd', TEAM)).toBe('Nothing new: all 3 events in this file are already in this calendar.');
    await cancel(t);
    expect(sorted(await stored(id))).toEqual(first);
    await t.ctx.close();
  });

  test(`R2 ${where}: two browsers import the same file at the same moment: no duplicates once both are done`, async ({ browser }) => {
    const id = await seed();
    const A = await open(browser, id, { native });
    const B = await open(browser, id, { native });
    expect(await plan(A, 'drop', TEAM)).toBe('Import 3 events');
    expect(await plan(B, 'quickadd', TEAM)).toBe('Import 3 events');
    await Promise.all([A.page.getByTestId('ics-confirm').click(), B.page.getByTestId('ics-confirm').click()]);
    await soon(async () => (await stored(id)).length).toBe(3);
    await A.page.waitForTimeout(2500);   // both saves (and the echo of each to the other) have landed
    const events = await stored(id);
    expect(events.map((e) => e.title).sort()).toEqual(['Game vs Hawks', 'Practice', 'Team party']);
    // Each browser shows the three, once.
    for (const t of [A, B]) {
      await soon(() => t.page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.events.map((e) => e.title).sort()))
        .toEqual(['Game vs Hawks', 'Practice', 'Team party']);
    }
    // And a third import, from either, adds nothing.
    await done(A).catch(() => {});
    await A.page.keyboard.press('Escape');
    expect(await plan(A, 'drop', TEAM)).toBe('Nothing new: all 3 events in this file are already in this calendar.');
    expect(A.errors).toEqual([]); expect(B.errors).toEqual([]);
    expect([...A.refused, ...B.refused], 'neither save was refused').toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test(`R3 ${where}: import, Undo, import again: exactly one copy`, async ({ browser }) => {
    const id = await seed();
    const t = await open(browser, id, { native });
    expect(await plan(t, 'drop', TEAM)).toBe('Import 3 events');
    await confirm(t, 'drop');
    await soon(async () => (await stored(id)).length).toBe(3);
    await t.page.getByTestId('ics-undo').click();
    await soon(async () => (await stored(id)).length).toBe(0);
    await t.page.keyboard.press('Escape');
    await expect(t.page.getByTestId('ics-dialog')).toHaveCount(0);
    expect(await plan(t, 'drop', TEAM)).toBe('Import 3 events');
    await confirm(t, 'drop');
    await done(t);
    await soon(async () => (await stored(id)).map((e) => e.title).sort()).toEqual(['Game vs Hawks', 'Practice', 'Team party']);
    await t.page.waitForTimeout(1000);
    expect((await stored(id)).length).toBe(3);
    await t.ctx.close();
  });

  test(`R4 ${where}: import, rename an imported event, import again: "Update 1 event" is shown first, and Cancel keeps the rename`, async ({ browser }) => {
    const id = await seed();
    const t = await open(browser, id, { native });
    expect(await plan(t, 'quickadd', TEAM)).toBe('Import 3 events');
    await confirm(t, 'quickadd');
    await done(t);
    await soon(async () => (await stored(id)).length).toBe(3);
    // Renamed in the app (the store, as the card's title field does), saved like any edit.
    await t.page.evaluate(() => {
      const p = document.querySelector('#app')._vnode.component.proxy;
      const e = p.calendar.events.find((x) => x.title === 'Practice');
      p.store().dispatch({ type: 'update', key: { id: e.id, recurrenceID: e.recurrenceID ?? null }, changes: { title: 'Practice (moved to Field 2)' } }, { label: 'Renamed' });
    });
    await soon(async () => (await stored(id)).map((e) => e.title).sort()).toEqual(['Game vs Hawks', 'Practice (moved to Field 2)', 'Team party']);
    const summary = await plan(t, 'drop', TEAM);
    expect(summary).toBe('Update 1 event');
    await expect(t.page.getByTestId('ics-changes').locator('.pc-imp-head')).toHaveText('Changes · 1');
    await expect(t.page.getByTestId('ics-here').locator('.pc-imp-head')).toContainText('Already in this calendar · 2');
    await cancel(t);
    await t.page.waitForTimeout(800);
    expect((await stored(id)).map((e) => e.title).sort()).toEqual(['Game vs Hawks', 'Practice (moved to Field 2)', 'Team party']);
    await t.ctx.close();
  });

  test(`R5 ${where}: a series with an edited occurrence and a skipped date, twice: one series, one override, nothing drawn twice`, async ({ browser }) => {
    const id = await seed();
    const t = await open(browser, id, { native, query: '&view=month&date=2026-10-01' });
    expect(await plan(t, 'drop', SERIES)).toBe('Import 2 events');
    await confirm(t, 'drop');
    await done(t);
    await soon(async () => (await stored(id)).length).toBe(2);
    const first = sorted(await stored(id));
    expect(await plan(t, 'quickadd', SERIES)).toBe('Nothing new: all 2 events in this file are already in this calendar.');
    await cancel(t);
    expect(await plan(t, 'settings', SERIES)).toBe('Nothing new: all 2 events in this file are already in this calendar.');
    await cancel(t);
    const events = await stored(id);
    expect(sorted(events)).toEqual(first);
    const swim = events.find((e) => e.title === 'Swim'), late = events.find((e) => e.title === 'Swim (late)');
    expect(events.filter((e) => e.recurrencerule && !e.recurrenceID)).toHaveLength(1);
    expect(late.recurrenceID).toBe(swim.id);
    expect(swim.recurrenceException).toBe('20261012T230000Z,20261019T230000Z');
    // Drawn: Swim on Oct 5 and 26, the late one on the 19th, nothing on the 12th, and no day with a title twice.
    const drawn = await drawnInOctober(t.page, native);
    expect(drawn).toMatchObject({ 5: ['Swim'], 19: ['Swim (late)'], 26: ['Swim'] });
    expect(drawn[12]).toBeUndefined();
    for (const [day, titles] of Object.entries(drawn)) expect(new Set(titles).size, `Oct ${day}`).toBe(titles.length);
    await t.ctx.close();
  });
}

test('R6 Download .ics: into the same calendar twice nothing changes; into an empty one twice, the source\'s rows', async ({ browser }) => {
  const iso = (s) => new Date(s).toISOString();
  const row = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
    recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
  const id = await seed([
    row('s1', 'Practice', '2026-10-05T17:30:00-07:00', '2026-10-05T19:00:00-07:00', { repeat: 'Weekly', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', recurrenceException: '20261013T003000Z' }),
    row('c1', 'Practice (Tuesday)', '2026-10-13T17:30:00-07:00', '2026-10-13T19:00:00-07:00', { type: 2, recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;', recurrenceID: 's1', recurrenceException: '20261013T003000Z' }),
    row(7, 'Trip', '2026-11-01T00:00:00-07:00', '2026-11-04T00:00:00-08:00', { type: 6, isAllDay: true }),
  ], 'U10 Soccer');
  const t = await open(browser, id);
  await t.page.getByTestId('settings-button-desktop').click();
  const [download] = await Promise.all([t.page.waitForEvent('download'), t.page.getByTestId('ics-download').click()]);
  const file = path.join(OUT, 'backup.ics');
  await download.saveAs(file);
  const before = sorted(await stored(id));
  for (const how of ['settings', 'drop']) {
    expect(await plan(t, how, file), how).toBe('Nothing new: all 3 events in this file are already in this calendar.');
    await cancel(t);
  }
  expect(sorted(await stored(id))).toEqual(before);
  await t.ctx.close();

  const fresh = await seed([], 'Rebuilt');
  const o = await open(browser, fresh, { native: true });
  expect(await plan(o, 'drop', file)).toBe('Import 3 events');
  await confirm(o, 'drop');
  await done(o);
  await soon(async () => (await stored(fresh)).length).toBe(3);
  expect(await plan(o, 'quickadd', file)).toBe('Nothing new: all 3 events in this file are already in this calendar.');
  await cancel(o);
  expect(sorted(await stored(fresh))).toEqual(before);
  await o.ctx.close();
});

for (const native of [false, true]) {
  test(`R7 ${native ? 'native' : 'classic'}: a Google Calendar export (time zone, folded lines, alarms, attendees) twice: no duplicates`, async ({ browser }) => {
    const id = await seed();
    const t = await open(browser, id, { native });
    expect(await plan(t, 'drop', GOOGLE)).toBe('Import 2 events');
    await confirm(t, 'drop');
    await done(t);
    await soon(async () => (await stored(id)).length).toBe(2);
    const first = sorted(await stored(id));
    expect(await plan(t, 'drop', GOOGLE)).toBe('Nothing new: all 2 events in this file are already in this calendar.');
    await cancel(t);
    expect(sorted(await stored(id))).toEqual(first);
    const dentist = first.find((e) => e.title === 'Dentist');
    expect(dentist.start).toBe('2026-10-15T16:00:00.000Z');
    // The folded description joined; the location kept; nothing from an alarm or an attendee.
    expect(dentist.description).toContain('This line is long enough that Google folds it onto a second line.');
    expect(dentist.description).toContain('Main St, Suite 4');
    expect(JSON.stringify(first)).not.toMatch(/reminder|mailto|sam@example|Alarm/i);
    expect(first.find((e) => e.title === 'Thanksgiving')).toMatchObject({ isAllDay: true });
    expect(t.errors).toEqual([]);
    await t.ctx.close();
  });
}

test('R8 1,000 events twice: the second import adds nothing, and the first is saved in full', async ({ browser }) => {
  test.setTimeout(150_000);
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    const d = String(1 + (i % 28)).padStart(2, '0'), h = String(8 + (i % 10)).padStart(2, '0');
    lines.push(...vevent(`shift-${i}@x`, `Shift ${i}`, `202611${d}T${h}0000`, `202611${d}T${h}3000`, [`DESCRIPTION:${'Notes for shift '.padEnd(200, 'x')}`]));
  }
  const file = write('thousand.ics', ics(lines));
  const id = await seed();
  const t = await open(browser, id);
  expect(await plan(t, 'drop', file)).toBe('Import 1000 events');
  await confirm(t, 'drop');
  await done(t);
  await expect.poll(async () => (await stored(id)).length, { timeout: 60_000, intervals: [500] }).toBe(1000);
  const first = sorted(await stored(id));
  expect(await plan(t, 'quickadd', file)).toBe('Nothing new: all 1000 events in this file are already in this calendar.');
  await expect(t.page.getByTestId('ics-confirm')).toHaveCount(0);
  await cancel(t);
  await t.page.waitForTimeout(1500);
  expect(sorted(await stored(id))).toEqual(first);
  await expect(t.page.locator('.pc-toast')).toHaveCount(0);
  expect(t.errors).toEqual([]);
  await t.ctx.close();
});

for (const native of [false, true]) {
  test(`R9 ${native ? 'native' : 'classic'}: dropping a file that isn't a calendar, or a broken one: said on the page, nothing saved; dark`, async ({ browser }) => {
    const id = await seed();
    const t = await open(browser, id, { native, colorScheme: 'dark' });
    await drop(t.page, native, NOT_ICS, { type: 'text/csv' });
    await expect(t.page.getByTestId('ics-dialog').getByTestId('ics-note')).toHaveText('That file isn’t a calendar (.ics).');
    await expect(t.page.getByTestId('ics-confirm')).toHaveCount(0);
    if (!native) await t.page.getByTestId('ics-dialog').screenshot({ path: path.join(OUT, 'drop-not-ics-dark.png') });
    await t.page.keyboard.press('Escape');
    await expect(t.page.getByTestId('ics-dialog')).toHaveCount(0);
    // Cut off mid-event: nothing in it.
    await drop(t.page, native, BROKEN);
    await expect(t.page.getByTestId('ics-dialog').getByTestId('ics-note')).toHaveText('No events in that file.');
    await t.page.getByTestId('ics-done').click();
    // An event with no date: it can't be read, and there is nothing to import.
    await drop(t.page, native, NO_DATE);
    await expect(t.page.getByTestId('ics-dialog').getByTestId('ics-plan')).toHaveText('Nothing to import: 1 can’t be read.');
    await expect(t.page.getByTestId('ics-skipped').locator('.pc-imp-head')).toContainText('Not imported · 1');
    await t.page.getByTestId('ics-skipped-toggle').click();
    await expect(t.page.getByTestId('ics-skipped').locator('.pc-imp-text')).toHaveText(['Sometime']);
    await expect(t.page.getByTestId('ics-skipped').locator('.pc-imp-what')).toHaveText(['no date']);
    await expect(t.page.getByTestId('ics-confirm')).toHaveCount(0);
    await cancel(t);
    await t.page.waitForTimeout(800);
    expect(await stored(id)).toEqual([]);
    // A drag that is not a file (an event being moved) never shows the overlay.
    await t.page.evaluate((sel) => {
      const dt = new DataTransfer(); dt.setData('text/plain', 'Practice');
      document.querySelector(sel).dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, calendarEl(native));
    await expect(t.page.getByTestId('ics-drop')).toHaveCount(0);
    // The overlay, as a person sees it mid-drag.
    if (!native) {
      await t.page.evaluate((sel) => {
        const dt = new DataTransfer(); dt.items.add(new File(['BEGIN:VCALENDAR'], 'a.ics', { type: 'text/calendar' }));
        document.querySelector(sel).dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, calendarEl(native));
      await expect(t.page.getByTestId('ics-drop')).toBeVisible();
      await t.page.screenshot({ path: path.join(OUT, 'drop-overlay-dark.png') });
    }
    expect(t.errors).toEqual([]);
    await t.ctx.close();
  });
}

test('a view link: a dropped file is not imported and the page stays', async ({ browser }) => {
  const id = await seed();
  const viewId = (await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json()).publicViewId;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, timezoneId: TZ });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  await page.goto(`/view/${viewId}?backend=cf`);
  await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
  await expect(page.locator('.e-schedule .e-work-cells').first()).toBeVisible({ timeout: 20_000 });
  await drop(page, false, TEAM, { check: false });
  await expect(page.getByTestId('ics-drop')).toHaveCount(0);
  await expect(page.getByTestId('ics-dialog')).toHaveCount(0);
  expect(await stored(id)).toEqual([]);
  await ctx.close();
});

/** What the month view draws on each October day: { 5: ['Swim'], ... } (the browser is in Los Angeles). */
async function drawnInOctober(page, native) {
  return page.evaluate((native) => {
    const out = {};
    const put = (d, t) => { if (d.getMonth() === 9) (out[d.getDate()] = out[d.getDate()] || []).push(t); };
    if (native) {
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      for (const b of document.querySelectorAll('.nc .nc-bar')) {
        const m = new RegExp(`(${months.join('|')}) (\\d+)`).exec(b.getAttribute('aria-label') || '');
        if (m) put(new Date(2026, months.indexOf(m[1]), +m[2]), b.getAttribute('title'));
      }
    } else {
      for (const td of document.querySelectorAll('.e-month-view td.e-work-cells')) {
        for (const a of td.querySelectorAll('.e-appointment .e-subject')) put(new Date(+td.dataset.date), a.textContent.trim());
      }
    }
    for (const k of Object.keys(out)) out[k].sort();
    return out;
  }, native);
}
