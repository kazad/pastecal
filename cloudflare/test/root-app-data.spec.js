// @ts-check
/**
 * Root-cause guards from the third stress pass (cloudflare/test/app-stress-3.spec.js), the browser halves. The unit
 * halves: test/unit/series-zones-agree.test.js, meta-merge.test.js, url-paths.test.js, utc-day-as-local.test.js,
 * change-words.test.js, ics-etag.test.js; the Worker half: cloudflare/test/hardening.test.mjs.
 *
 * ROOT 2 -- a repeating event is wall-clock, so it repeats in ONE zone (its own, else the calendar's) in the feed and
 * both calendars. A table: series x calendar zones x viewer zones, classic and native (calView.occurrences, what the
 * grid draws) against the feed read by ical.js in the same page. Past instances: A02 (the feed in UTC: Mondays, 4 PM
 * after Nov 1), S09.
 *
 * ROOT 1 -- the calendar's own fields (notes, title, type labels) merge field by field: browser A types one while
 * browser B changes the calendar, and every keystroke is on screen and on the server. Past instance: A01.
 *
 * ROOT A -- a calendar's name goes into a URL encoded (CalendarPath): Share's links for odd names open that calendar.
 * ROOT 5 -- names are exact: a name ending in a space opens itself. Past instances: A03, A04, A19, issue #51.
 *
 * Needs `wrangler dev` on BASE_URL with LOCAL_NO_LIMITS (scripts/test-browser.sh); run with scripts/test-on-box.sh root-app-data.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const { NOT_LOCAL, settled } = require('./helpers');
const EventZone = require(path.join(__dirname, '../../public/services/EventZone.js'));

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const ALLOW = new Set(['localhost', '127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net']);
const ICALJS = 'https://cdn.jsdelivr.net/npm/ical.js@1.5.0/build/ical.min.js';
const NOW = '2026-10-24T12:00:00-07:00';
let n = 0;
const rand = () => `${Date.now().toString(36)}${n++}${Math.floor(Math.random() * 1e4)}`;
const soon = (fn, timeout = 15_000) => expect.poll(fn, { timeout, intervals: [150] });

async function seed(events, o = {}) {
  const id = o.id || `rad-${rand()}`;
  const res = await fetch(`${BASE}/cal/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: o.title ?? 'Root app data', options: { notes: '', ...(o.options || {}) }, events }) });
  expect(res.status, `seed ${id}`).toBe(201);
  return id;
}
const calOf = async (id) => (await (await fetch(`${BASE}/cal/${encodeURIComponent(id)}`)).json()).calendar;
const vm = (page, expr) => page.evaluate(`(() => { const p = document.querySelector('#app')._vnode.component.proxy; return ${expr}; })()`);
const loaded = (page) => page.waitForFunction(() => { const p = document.querySelector('#app')?._vnode?.component?.proxy; return p && p.isLoading === false; }, null, { timeout: 30_000 });

async function open(browser, p, { timezoneId = 'America/Los_Angeles', cal = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId, locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript((c) => {
    window.__TEST__ = true;
    try { localStorage.setItem('pastecal_backend', 'cf'); if (c) localStorage.setItem('pc_cal', c); } catch (e) { /* blocked */ }
  }, cal);
  await ctx.route(NOT_LOCAL, (r) => (ALLOW.has(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(p);
  await loaded(page);
  await settled(page);
  return { ctx, page, errors };
}

// =====================================================================================================
// ROOT 2: one zone per series, in the feed and both calendars, wherever it is viewed
// =====================================================================================================
const at = (z, y, m, d, h = 0, min = 0) => EventZone.fromWall(y, m - 1, d, h, min, 0, z);
const isoAt = (z, ...a) => new Date(at(z, ...a)).toISOString();
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const p2 = (x) => String(x).padStart(2, '0');
function seriesIn(z) {
  const base = { description: '', repeat: '', isAllDay: false, recurrenceID: null, recurrenceException: null };
  return [
    { ...base, id: 'wk', title: 'Weekly', type: 1, start: isoAt(z, 2026, 10, 6, 17), end: isoAt(z, 2026, 10, 6, 18), recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=8;',
      recurrenceException: [stamp(at(z, 2026, 10, 20, 17)), stamp(at(z, 2026, 11, 10, 17))].join(',') },
    { ...base, id: 'wk-moved', title: 'Weekly', type: 1, start: isoAt(z, 2026, 11, 10, 19), end: isoAt(z, 2026, 11, 10, 20), recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;COUNT=8;',
      recurrenceID: 'wk', recurrenceException: stamp(at(z, 2026, 11, 10, 17)) },
    { ...base, id: 'mo', title: 'Monthly', type: 2, start: isoAt(z, 2026, 10, 13, 19), end: isoAt(z, 2026, 10, 13, 20), recurrencerule: `FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;INTERVAL=1;UNTIL=${stamp(at(z, 2027, 3, 9))};` },
    { ...base, id: 'ad', title: 'Saturdays', type: 3, isAllDay: true, start: isoAt(z, 2026, 10, 3), end: isoAt(z, 2026, 10, 4),
      recurrencerule: `FREQ=WEEKLY;BYDAY=SA;INTERVAL=1;UNTIL=${stamp(at(z, 2026, 11, 28))};`, recurrenceException: stamp(at(z, 2026, 10, 31)) },
  ];
}
const WANT = {
  Weekly: ['2026-10-06 17:00', '2026-10-13 17:00', '2026-10-27 17:00', '2026-11-03 17:00', '2026-11-10 19:00', '2026-11-17 17:00', '2026-11-24 17:00'],
  Monthly: ['2026-10-13 19:00', '2026-11-10 19:00', '2026-12-08 19:00', '2027-01-12 19:00', '2027-02-09 19:00', '2027-03-09 19:00'],
  Saturdays: ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28'],
};
const FROM = Date.UTC(2026, 8, 1), TO = Date.UTC(2027, 5, 1);
/** [{ title, allDay, ms | day }] -> { title: ['YYYY-MM-DD HH:MM' in zone z | 'YYYY-MM-DD'] } */
function read(list, z) {
  const out = {};
  for (const o of list) {
    let v = o.day;
    if (!o.allDay) { const w = EventZone.wall(o.ms, z); v = `${w.y}-${p2(w.m + 1)}-${p2(w.d)} ${p2(w.h)}:${p2(w.min)}`; }
    (out[o.title] = out[o.title] || []).push(v);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

for (const calZone of ['America/Los_Angeles', 'Asia/Tokyo']) {
  for (const viewer of ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo']) {
    test(`ROOT 2: a ${calZone} calendar seen from ${viewer}: classic, native and the feed draw every occurrence where it was planned`, async ({ browser }) => {
      const id = await seed(seriesIn(calZone), { options: { tz: calZone } });
      const got = {};
      for (const cal of [null, 'native']) {
        const { ctx, page } = await open(browser, `/${encodeURIComponent(id)}?backend=cf&date=2026-10-24`, { timezoneId: viewer, cal });
        if (cal) await expect(page.locator('.nc')).toBeVisible({ timeout: 20_000 });
        const occ = await page.evaluate(([from, to]) => {
          const p = document.querySelector('#app')._vnode.component.proxy;
          const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          return { kind: p.calView.kind, list: p.calView.occurrences(from, to).map((o) => (o.allDay ? { title: o.title, allDay: true, day: day(new Date(o.start)) } : { title: o.title, allDay: false, ms: new Date(o.start).getTime() })) };
        }, [FROM, TO]);
        got[occ.kind] = read(occ.list, calZone);
        if (!cal) {
          // The feed, as a calendar app in this zone reads it: its zones registered, moved occurrences in their place.
          await page.addScriptTag({ url: ICALJS });
          const feed = await page.evaluate(async ([url, to]) => {
            const text = await (await fetch(url)).text();
            const cal = new ICAL.Component(ICAL.parse(text));
            ICAL.TimezoneService.reset();
            for (const z of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(z);
            const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const one = (title, t) => (t.isDate ? { title, allDay: true, day: day(t.toJSDate()) } : { title, allDay: false, ms: t.toJSDate().getTime() });
            const groups = {};
            for (const v of cal.getAllSubcomponents('vevent')) (groups[v.getFirstPropertyValue('uid')] = groups[v.getFirstPropertyValue('uid')] || []).push(v);
            const out = [];
            for (const vs of Object.values(groups)) {
              const master = vs.find((v) => !v.hasProperty('recurrence-id')), moved = vs.filter((v) => v.hasProperty('recurrence-id'));
              const replaced = new Set(moved.map((v) => v.getFirstPropertyValue('recurrence-id').toJSDate().getTime()));
              for (const v of moved) out.push(one(v.getFirstPropertyValue('summary'), v.getFirstPropertyValue('dtstart')));
              if (!master) continue;
              const ev = new ICAL.Event(master);
              if (!ev.isRecurring()) { out.push(one(ev.summary, ev.startDate)); continue; }
              const it = ev.iterator();
              for (let x, i = 0; (x = it.next()) && i < 500 && x.toJSDate().getTime() < to; i++) if (!replaced.has(x.toJSDate().getTime())) out.push(one(ev.summary, x));
            }
            return out;
          }, [`/${encodeURIComponent(id)}.ics`, TO]);
          got.feed = read(feed, calZone);
        }
        await ctx.close();
      }
      expect(got, 'the wall clock each one reads, in the calendar\'s zone').toEqual({ syncfusion: WANT, native: WANT, feed: WANT });
    });
  }
}

// =====================================================================================================
// ROOT 1: the calendar's own fields, field by field, while someone else changes the calendar
// =====================================================================================================
async function quickAdd(page, text) {
  await page.getByTestId('desktop-add-event-button').click();
  await page.locator('textarea[aria-label="Event description"]').fill(text);
  await page.locator('.pc-qa-dialog button[type="submit"]').click();
}
const FIELDS = {
  notes: {
    async start(page) {
      await page.locator('.pc-hdr-actions').getByRole('button', { name: 'Toggle notes' }).click();
      await page.getByTestId('notes-edit').or(page.getByTestId('notes-add')).first().click();
      const ta = page.getByLabel('Calendar notes');
      await ta.click();
      await page.keyboard.press('ControlOrMeta+End');
      return ta;
    },
    was: 'Old notes', typed: ' and a line typed while B adds an event',
    stored: (c) => c.options.notes,
  },
  title: {
    async start(page) {
      await page.getByTestId('desktop-title-area').getByText('Old title').click();
      const input = page.locator('input[aria-label="Calendar title"]:visible');
      await input.click();
      await page.keyboard.press('End');
      return input;
    },
    was: 'Old title', typed: ' renamed while B adds an event',
    stored: (c) => c.title,
  },
  'type label': {
    async start(page) {
      await page.getByTestId('settings-button-desktop').click();
      const input = page.getByLabel('Label for type 1');
      await input.click();
      await page.keyboard.press('End');
      return input;
    },
    // (No space: a label box trims what it stores on every keystroke, so a space typed at its end is dropped before
    // the next letter arrives -- a separate bug of that box, reported, not this one.)
    was: 'Practice', typed: '-and-drills',
    stored: (c) => c.options.typeLabels[0],
  },
};
for (const [field, f] of Object.entries(FIELDS)) {
  test(`ROOT 1: ${field} typed in one browser while another adds an event keeps every keystroke, on screen and on the server`, async ({ browser }) => {
    const id = await seed([], { title: 'Old title', options: { notes: 'Old notes', typeLabels: ['Practice', 'Game', 'Type 3', 'Type 4', 'Type 5', 'Type 6', 'Type 7', 'Type 8'] } });
    const A = await open(browser, `/${id}?backend=cf`);
    const B = await open(browser, `/${id}?backend=cf`);
    const box = await f.start(A.page);
    const typing = A.page.keyboard.type(f.typed, { delay: 60 });   // a steady typist: the save waits for a 500 ms pause
    await A.page.waitForTimeout(700);
    await quickAdd(B.page, 'Snack duty tomorrow 3pm');
    await typing;
    await soon(async () => (await calOf(id)).events.length).toBe(1);
    await soon(async () => f.stored(await calOf(id))).toBe(f.was + f.typed);
    expect(await box.inputValue(), 'the box shows every keystroke').toBe(f.was + f.typed);
    await A.ctx.close(); await B.ctx.close();
  });
}

test('ROOT 1: two people rename different type labels at once: both names are kept', async ({ browser }) => {
  const id = await seed([], { options: { typeLabels: ['Type 1', 'Type 2', 'Type 3', 'Type 4', 'Type 5', 'Type 6', 'Type 7', 'Type 8'] } });
  const A = await open(browser, `/${id}?backend=cf`);
  const B = await open(browser, `/${id}?backend=cf`);
  await A.page.getByTestId('settings-button-desktop').click();
  await B.page.getByTestId('settings-button-desktop').click();
  await A.page.getByLabel('Label for type 1').click();
  const typing = A.page.keyboard.type('Practice', { delay: 120 });   // A is still typing (inside the save debounce)...
  await A.page.waitForTimeout(300);
  await B.page.getByLabel('Label for type 3').fill('Games');        // ...when B's rename is saved and reaches A
  await soon(async () => (await calOf(id)).options.typeLabels[2]).toBe('Games');
  await typing;
  await soon(async () => (await calOf(id)).options.typeLabels.slice(0, 3)).toEqual(['Practice', 'Type 2', 'Games']);
  await A.ctx.close(); await B.ctx.close();
});

// =====================================================================================================
// ROOT A + ROOT 5: odd names, through Share's links
// =====================================================================================================
test('ROOT A: Share\'s links for calendars named "50% off", "a?b", "TEAM NUÑEZ", "sp!x", "d&d8", "강아지봉사" and "trail " open that calendar', async ({ browser }) => {
  test.setTimeout(180_000);
  const out = {}, want = {};
  for (const name of ['50% off', 'a?b', 'TEAM NUÑEZ', 'sp!x', 'd&d8', '강아지봉사', 'trail ']) {
    const real = `${rand().slice(-5)} ${name}`;
    await seed([{ id: 'e1', title: 'Practice', start: '2026-10-23T00:00:00.000Z', end: '2026-10-23T01:00:00.000Z', description: '', repeat: '', recurrencerule: '',
      recurrenceID: null, recurrenceException: null, isAllDay: false, type: 1 }], { id: real, title: `Cal ${name}` });
    await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: real }) });
    const { ctx, page } = await open(browser, `/${encodeURIComponent(real)}?backend=cf`);
    await page.getByTestId('share-pill-more').click();
    const edit = ((await page.getByTestId('share-edit-copy').getAttribute('title')) || '').replace(/^Copy /, '');
    const here = ((await page.getByTestId('share-view-copy').getAttribute('title')) || '').replace(/^Copy /, '');
    const feed = await vm(page, 'p.getEditableICSURL()');
    const opened = {};
    for (const [k, link] of Object.entries({ edit, here })) {
      const p2 = await ctx.newPage();
      await p2.goto(link);
      await loaded(p2);
      // (A name with capitals opens its lowercase first, then the directory's answer: give that a moment.)
      await p2.waitForFunction(() => document.querySelector('#app')._vnode.component.proxy.isExisting, null, { timeout: 8000 }).catch(() => {});
      opened[k] = await vm(p2, '[p.calendar.title, p.isExisting]');
      await p2.close();
    }
    const feedText = await (await fetch(feed.replace(/^https?:\/\/[^/]+/, BASE))).text();
    out[name] = { rawSpaces: /\s/.test(edit + here + feed), ...opened, feed: feedText.includes(`X-WR-CALNAME:Cal ${name}`) };
    want[name] = { rawSpaces: false, edit: [`Cal ${name}`, true], here: [`Cal ${name}`, true], feed: true };
    await ctx.close();
  }
  expect(out, 'each copied link has no raw spaces and opens this calendar; the edit feed is its feed').toEqual(want);
});
