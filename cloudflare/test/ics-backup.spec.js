// @ts-check
/**
 * Backup (Settings, "This calendar"): Download .ics and Import .ics, driven like a person, in both calendars.
 *
 * Why: a person who lost edit access rebuilt her calendar by hand. A backup she can download and import back, and a
 * calendar file from another app, must come in once: importing the same file again adds nothing, and a calendar's own
 * download imported back changes nothing. Checked against what the SERVER stored (GET /cal/<id>), not the screen.
 *   1. Import a Google-style file (a series, an edited occurrence, a skipped date, all-day, a time zone) in classic and
 *      in ?cal=native: the summary, the events stored, Undo takes the whole import back, a second import adds nothing.
 *   2. Download .ics, then import that file into the same calendar (nothing changes) and into an empty one (the same
 *      events, every field).
 *   3. A file that is not a calendar says so on the page.
 * The parser, dedupe and round trip in detail: test/unit/ics-import.test.js. Screenshots (light, dark):
 * cloudflare/test-results/ics-backup/.
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh); run with scripts/test-on-box.sh ics-backup.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { NOT_LOCAL } = require('./helpers');

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'test-results', 'ics-backup');
fs.mkdirSync(OUT, { recursive: true });
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const LABELS = ['Practice', 'Game', 'Away game', 'Tournament', 'Party', 'Trip', 'Other', 'Meeting'];

const FILE = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:Family',
    'BEGIN:VEVENT', 'UID:abc123@google.com', 'SUMMARY:Dentist', 'LOCATION:Main St\\, Suite 4',
    'DTSTART;TZID=America/Los_Angeles:20261106T090000', 'DTEND;TZID=America/Los_Angeles:20261106T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:def456@google.com', 'SUMMARY:Swim', 'DTSTART;TZID=America/Los_Angeles:20261005T160000',
    'DTEND;TZID=America/Los_Angeles:20261005T170000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/Los_Angeles:20261012T160000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:def456@google.com', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261019T160000', 'SUMMARY:Swim (late)',
    'DTSTART;TZID=America/Los_Angeles:20261019T180000', 'DTEND;TZID=America/Los_Angeles:20261019T190000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:tokyo@google.com', 'SUMMARY:Call grandma', 'DTSTART;TZID=Asia/Tokyo:20261110T090000', 'DTEND;TZID=Asia/Tokyo:20261110T093000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:board@google.com', 'SUMMARY:Board', 'DTSTART;TZID=America/Los_Angeles:20260928T190000',
    'DTEND;TZID=America/Los_Angeles:20260928T200000', 'RRULE:FREQ=MONTHLY;BYDAY=-1MO', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:holiday@google.com', 'SUMMARY:Thanksgiving', 'DTSTART;VALUE=DATE:20261126', 'DTEND;VALUE=DATE:20261127', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
const FIXTURE = path.join(OUT, 'family.ics');
fs.writeFileSync(FIXTURE, FILE);
const NOT_ICS = path.join(OUT, 'roster.csv');
fs.writeFileSync(NOT_ICS, 'name,date\nSam,2026-10-06\n');

const iso = (s) => new Date(s).toISOString();
const row = (id, title, start, end, extra = {}) => ({ id, title, start: iso(start), end: iso(end), description: '', repeat: '', recurrencerule: '',
    recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1, ...extra });
// Every shape stored data has: a series with a skipped date and an edited occurrence, all-day, a number id, an own zone.
const RICH = [
    row('s1', 'Practice', '2026-10-05T17:30:00-07:00', '2026-10-05T19:00:00-07:00', { type: 1, repeat: 'Weekly', recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;',
        recurrenceException: '20261013T003000Z,20261020T003000Z', description: 'Bring water, cones; and\nballs' }),
    row('c1', 'Practice (Tuesday)', '2026-10-20T17:30:00-07:00', '2026-10-20T19:00:00-07:00', { type: 2, recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;',
        recurrenceID: 's1', recurrenceException: '20261020T003000Z' }),
    row(7, 'Trip', '2026-11-01T00:00:00-07:00', '2026-11-04T00:00:00-08:00', { type: 6, isAllDay: true }),
    row('tk', 'Tokyo standup', '2026-10-27T01:00:00Z', '2026-10-27T01:30:00Z', { type: 4, tz: 'Asia/Tokyo', recurrencerule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;' }),
];

let n = 0;
async function seed(events, title = 'Backup test') {
    const id = `ics-${Date.now().toString(36)}-${n++}-${Math.floor(Math.random() * 1e4)}`;
    const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, options: { typeLabels: LABELS, tz: 'America/Los_Angeles' }, events }) });
    expect(res.status).toBe(201);
    return id;
}
const stored = async (id) => ((await (await fetch(`${BASE}/cal/${id}`)).json()).calendar.events || []);
const soon = (fn) => expect.poll(fn, { timeout: 10_000, intervals: [100] });
const titles = async (id) => (await stored(id)).map((e) => e.title).sort();

/** The calendar's edit link, classic (default) or ?cal=native, in Los Angeles; Settings open. */
async function open(browser, id, { native = false, colorScheme = 'light', query = '' } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, timezoneId: 'America/Los_Angeles', locale: 'en-US', colorScheme, acceptDownloads: true });
    await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_backend', 'cf'); } catch (e) { /* blocked */ } });
    await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/${id}?backend=cf${native ? '&cal=native' : ''}${query}`);
    await page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });
    await expect(page.locator(native ? '.nc.nc-editable' : '.e-schedule .e-work-cells').first()).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('settings-button-desktop').click();
    await expect(page.getByTestId('settings-backup')).toBeVisible();
    return { ctx, page, errors };
}
const pick = (page, file) => page.getByTestId('ics-file').setInputFiles(file);

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

for (const native of [false, true]) {
    const where = native ? 'native' : 'classic';
    test(`${where}: import a calendar file; Undo takes it all back; the same file again adds nothing`, async ({ browser }) => {
        const id = await seed([row('trip', 'Trip', '2026-11-01T00:00:00-07:00', '2026-11-04T00:00:00-08:00', { isAllDay: true, type: 6 })]);
        const { ctx, page, errors } = await open(browser, id, { native, query: '&view=month&date=2026-10-01' });

        await pick(page, FIXTURE);
        await expect(page.getByTestId('ics-confirm')).toHaveText('Import 6 events', { timeout: 15_000 });
        await expect.poll(async () => (await stored(id)).length, { timeout: 1000 }).toBe(1);   // nothing saved before Import
        if (!native) {
            await page.getByTestId('ics-dialog').screenshot({ path: path.join(OUT, 'settings-plan-light.png') });
        }
        await page.getByTestId('ics-confirm').click();
        await expect(page.getByTestId('ics-note')).toContainText('Added 6 events.');
        await soon(() => titles(id)).toEqual(['Board', 'Call grandma', 'Dentist', 'Swim', 'Swim (late)', 'Thanksgiving', 'Trip']);
        let events = await stored(id);
        const swim = events.find((e) => e.title === 'Swim'), late = events.find((e) => e.title === 'Swim (late)');
        expect(late.recurrenceID).toBe(swim.id);
        expect(swim.recurrenceException).toBe('20261012T230000Z,20261019T230000Z');
        expect(events.find((e) => e.title === 'Call grandma').tz).toBe('Asia/Tokyo');
        expect(events.find((e) => e.title === 'Dentist').description).toBe('Main St, Suite 4');
        expect(events.find((e) => e.title === 'Thanksgiving')).toMatchObject({ isAllDay: true, start: '2026-11-26T08:00:00.000Z', end: '2026-11-27T08:00:00.000Z' });
        // Drawn, not only stored: Swim on the Mondays but the skipped Oct 12, the late one on Oct 19, Board on the last Monday.
        await expect.poll(() => drawnInOctober(page, native)).toMatchObject({ 5: ['Swim'], 19: ['Swim (late)'], 26: ['Board', 'Swim'] });
        expect((await drawnInOctober(page, native))[12]).toBeUndefined();
        if (!native) await page.getByTestId('ics-dialog').screenshot({ path: path.join(OUT, 'settings-result-light.png') });

        // Undo: the whole import, in one step.
        await page.getByTestId('ics-undo').click();
        await soon(() => titles(id)).toEqual(['Trip']);

        // Again, then the same file once more: nothing to add.
        await pick(page, FIXTURE);
        await page.getByTestId('ics-confirm').click();
        await soon(async () => (await stored(id)).length).toBe(7);
        events = await stored(id);
        await pick(page, FIXTURE);
        await expect(page.getByTestId('ics-plan')).toHaveText('Nothing new: all 6 events in this file are already in this calendar.');
        await expect(page.getByTestId('ics-confirm')).toHaveCount(0);
        await page.getByTestId('ics-done').click();
        await expect(page.getByTestId('ics-plan')).toHaveCount(0);
        expect(await stored(id)).toEqual(events);
        expect(errors).toEqual([]);
        await ctx.close();
    });
}

test('download a backup: imported into the same calendar nothing changes; into an empty one, the same events', async ({ browser }) => {
    const id = await seed(RICH, 'U10 Soccer');
    const { ctx, page } = await open(browser, id);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ics-download').click()]);
    expect(download.suggestedFilename()).toMatch(/^U10[ _]Soccer\.ics$/);
    const file = path.join(OUT, 'backup.ics');
    await download.saveAs(file);
    expect(fs.readFileSync(file, 'utf8')).toContain('X-PASTECAL-ROW:');

    const before = await stored(id);
    await pick(page, file);
    await expect(page.getByTestId('ics-plan')).toHaveText('Nothing new: all 4 events in this file are already in this calendar.');
    await page.getByTestId('ics-done').click();
    expect(await stored(id)).toEqual(before);
    await ctx.close();

    // Into a new, empty calendar (the person who lost the old one's edit link): every event back, every field.
    const fresh = await seed([], 'Rebuilt');
    const other = await open(browser, fresh, { native: true });
    await pick(other.page, file);
    await expect(other.page.getByTestId('ics-confirm')).toHaveText('Import 4 events', { timeout: 15_000 });
    await other.page.getByTestId('ics-confirm').click();
    await soon(async () => (await stored(fresh)).length).toBe(4);
    const back = await stored(fresh);
    for (const e of before) {
        const got = back.find((x) => String(x.id) === String(e.id) && (x.recurrenceID ?? null) === (e.recurrenceID ?? null));
        expect(got, e.title).toBeTruthy();
        expect(got).toEqual(e);
    }
    await other.ctx.close();
});

test('a file that is not a calendar says so on the page; dark mode', async ({ browser }) => {
    const id = await seed(RICH);
    const { ctx, page } = await open(browser, id, { colorScheme: 'dark' });
    await pick(page, NOT_ICS);
    await expect(page.getByTestId('ics-note')).toHaveText('That file isn’t a calendar (.ics).');
    await expect(page.getByTestId('ics-plan')).toHaveCount(0);
    await page.getByTestId('ics-dialog').screenshot({ path: path.join(OUT, 'settings-error-dark.png') });
    await pick(page, FIXTURE);
    await expect(page.getByTestId('ics-confirm')).toHaveText('Import 6 events', { timeout: 15_000 });
    await expect(page.getByTestId('ics-note')).toHaveCount(0);
    await page.getByTestId('ics-dialog').screenshot({ path: path.join(OUT, 'settings-plan-dark.png') });
    await ctx.close();
});

test('a big backup (2,500 events, over one save message) is saved in full', async ({ browser }) => {
    test.setTimeout(120_000);
    const big = Array.from({ length: 2500 }, (_, i) => row(`big-${i}`, `Shift ${i}`, Date.UTC(2026, 9, 1 + (i % 28), 15 + (i % 5)), Date.UTC(2026, 9, 1 + (i % 28), 16 + (i % 5)),
        { description: `Notes for shift ${i}: `.padEnd(300, 'x'), type: 1 + (i % 8) }));
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
    for (const e of big) lines.push('BEGIN:VEVENT', `UID:${e.id}`, `DTSTART:${e.start.replace(/[-:]|\.\d+/g, '')}`, `DTEND:${e.end.replace(/[-:]|\.\d+/g, '')}`,
        `SUMMARY:${e.title}`, `DESCRIPTION:${e.description}`, `X-PASTECAL-TYPE:${e.type}`, 'END:VEVENT');
    lines.push('END:VCALENDAR');
    const file = path.join(OUT, 'big.ics');
    fs.writeFileSync(file, lines.join('\r\n'));
    const id = await seed([]);
    const { ctx, page, errors } = await open(browser, id);
    await pick(page, file);
    await expect(page.getByTestId('ics-confirm')).toHaveText('Import 2500 events', { timeout: 15_000 });
    await page.getByTestId('ics-confirm').click();
    await expect.poll(async () => (await stored(id)).length, { timeout: 30_000, intervals: [500] }).toBe(2500);
    const back = await stored(id);
    expect(back.find((e) => e.title === 'Shift 2499')).toMatchObject({ description: big[2499].description, type: big[2499].type, start: big[2499].start });
    await expect(page.locator('.pc-toast')).toHaveCount(0);
    expect(errors).toEqual([]);
    await ctx.close();
});
