// Differential test: the same user actions through two versions of the app -- the one you
// are changing (OLD, e.g. live pastecal.com) and the change (NEW, e.g. a worktree served on
// :8020) -- on fresh test calendars, comparing what each STORES, field by field, plus how
// many events each draws.
//
//   OLD=https://pastecal.com NEW=http://localhost:8020 node test/differential/recurring-matrix.js [filter]
//
// Run it before shipping any change to how events are saved. It found both Sep 26 bugs in
// the EventStore (series edits and series deletes) that the journeys did not.
const { chromium } = require('playwright');
const VM = `document.querySelector('#app')._vnode.component.proxy`;
const OLD = process.env.OLD || 'https://pastecal.com', NEW = process.env.NEW || 'http://localhost:8020';

const SEED = `(() => { const a = ${VM}; const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString(); CalendarDataService.declareIntent(20);
  a.calendar.setEvents([
    new Event({ id: 9, title: 'Weekly', start: at(5, 14), end: at(5, 15), type: 3, recurrencerule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=1;' }),
    new Event({ id: 'dddd-uuid', title: 'Daily', start: at(6, 8), end: at(6, 9), type: 2, recurrencerule: 'FREQ=DAILY;INTERVAL=1;' }),
    new Event({ id: 5, title: 'Single', start: at(8, 10), end: at(8, 11), type: 1 }),
  ]); })()`;

const scenarios = {
  'edit series from occurrence (title)': async (p, h) => { await h.open('Weekly', 1); await h.q('series'); await h.title('Weekly renamed'); await h.save(); },
  'edit series time from occurrence': async (p, h) => { await h.open('Daily', 3); await h.q('series');
    const st = h.dlg.locator('input[name="StartTime"]'); await st.click(); await st.fill('10/06/26 09:30 AM'); await p.keyboard.press('Tab');
    const en = h.dlg.locator('input[name="EndTime"]'); await en.click(); await en.fill('10/06/26 10:30 AM'); await p.keyboard.press('Tab'); await h.save(); },
  'edit occurrence then series, Yes reset': async (p, h) => { await h.open('Weekly', 1); await h.q('occurrence'); await h.title('Weekly (one)'); await h.save();
    await h.openNot('Weekly', '(one)', 0); await h.q('series'); await h.title('Weekly all'); await h.save(); await h.answer('Yes'); },
  'edit occurrence then series, No keep': async (p, h) => { await h.open('Weekly', 1); await h.q('occurrence'); await h.title('Weekly (one)'); await h.save();
    await h.openNot('Weekly', '(one)', 0); await h.q('series'); await h.title('Weekly all'); await h.save(); await h.answer('No'); },
  'delete series from occurrence': async (p, h) => { await h.click('Weekly', 2); await p.locator('button.e-delete').locator('visible=true').first().click(); await p.waitForTimeout(600);
    await h.q('series'); const d = p.locator('.e-quick-dialog.e-popup-open .e-quick-dialog-delete'); if (await d.count()) await d.click(); },
  'delete occurrence of daily': async (p, h) => { await h.click('Daily', 4); await p.locator('button.e-delete').locator('visible=true').first().click(); await p.waitForTimeout(600); await h.q('occurrence'); },
  'change repeat rule weekly -> daily': async (p, h) => { await h.open('Weekly', 1); await h.q('series');
    await h.dlg.locator('.e-repeat-element').locator('..').click(); await p.waitForTimeout(400); await p.locator('.e-popup-open li', { hasText: /^Daily$/ }).first().click(); await p.waitForTimeout(400); await h.save(); },
  'resize single event': async (p, h) => { await p.locator('.e-toolbar-item', { hasText: /^week$/i }).first().click(); await p.waitForTimeout(1200);
    await p.evaluate(() => { const s = window.scheduleObj; s.selectedDate = new Date(2026, 9, 8); s.dataBind(); }); await p.waitForTimeout(1200);
    const ev = p.locator('.e-appointment', { hasText: 'Single' }).first(); const b = await ev.boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height - 2); await p.mouse.down(); await p.mouse.move(b.x + b.width / 2, b.y + b.height + 70, { steps: 10 }); await p.mouse.up(); },
  'all-day toggle single': async (p, h) => { await h.open('Single', 0); await h.dlg.locator('.e-all-day-container .e-checkbox-wrapper').first().click(); await p.waitForTimeout(300); await h.save(); },
  'drag occurrence of daily (this event)': async (p, h) => { const ev = p.locator('.e-appointment', { hasText: 'Daily' }).nth(5); const b = await ev.boundingBox();
    const t = await p.locator(`.e-work-cells[data-date="${new Date(2026, 9, 24).getTime()}"]`).boundingBox();
    await p.mouse.move(b.x + 15, b.y + 5); await p.mouse.down(); await p.mouse.move(t.x + 40, t.y + 40, { steps: 12 }); await p.mouse.up(); await p.waitForTimeout(700);
    const qd = p.locator('.e-quick-dialog.e-popup-open .e-quick-dialog-occurrence-event'); if (await qd.count()) await qd.click(); },
};

async function run(base, name) {
  const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  await c.addInitScript(() => { window.__TEST__ = true; });
  const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 120)));
  p.on('console', m => { if (/command failed|refused/i.test(m.text())) errs.push(m.text().slice(0, 160)); });
  const slug = `test-matrix-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  try {
    await p.goto(base + '/'); await p.locator('input[placeholder="your-name"]').fill(slug); await p.locator('button:has-text("Claim")').locator('visible=true').first().click();
    await p.waitForFunction(`document.querySelector('#app')?._vnode?.component?.proxy?.isExisting === true`, null, { timeout: 30000 });
    await p.evaluate(SEED); await p.waitForTimeout(2500); await p.reload(); await p.waitForFunction(`${VM}.isExisting === true`); await p.waitForTimeout(2000);
    await p.evaluate(() => { const s = window.scheduleObj; s.selectedDate = new Date(2026, 9, 15); s.currentView = 'Month'; s.dataBind(); }); await p.waitForTimeout(1500);
    const dlg = p.locator('.e-schedule-dialog.e-popup-open');
    const h = { dlg,
      click: async (t, n, re) => { await p.locator('.e-appointment').filter({ hasText: re || t }).nth(n).click(); await p.waitForTimeout(700); },
      open: async (t, n, re) => { await p.locator('.e-appointment').filter({ hasText: re || t }).nth(n).dblclick(); await p.waitForTimeout(800); },
      openNot: async (t, not, n) => { await p.locator('.e-appointment').filter({ hasText: t }).filter({ hasNotText: not }).nth(n).dblclick(); await p.waitForTimeout(800); },
      q: async (kind) => { const x = p.locator(`.e-quick-dialog.e-popup-open .e-quick-dialog-${kind}-event`); if (await x.count()) { await x.click(); await p.waitForTimeout(800); } },
      title: async (t) => { await dlg.locator('input[name="Subject"]').fill(t); },
      save: async () => { await dlg.locator('.e-event-save').click(); await p.waitForTimeout(1200); },
      answer: async (a) => { const x = p.locator('.e-dialog.e-popup-open button', { hasText: new RegExp(`^${a}$`, 'i') }).locator('visible=true'); if (await x.count()) await x.first().click(); await p.waitForTimeout(800); },
    };
    if (process.env.SHAPES) await p.evaluate(() => { const s = window.scheduleObj; const prev = s.actionBegin; window.__ab = [];
      const pick = (x) => x && ({ Id: x.Id, Subject: x.Subject, RecurrenceID: x.RecurrenceID, RecurrenceRule: x.RecurrenceRule ? 'yes' : '', RecurrenceException: x.RecurrenceException });
      s.actionBegin = (a) => { if (/^event/.test(a.requestType)) window.__ab.push({ t: a.requestType, action: s.currentAction, changed: (a.changedRecords || []).map(pick), added: (a.addedRecords || []).map(pick), deleted: (a.deletedRecords || []).map(pick), data: (Array.isArray(a.data) ? a.data : [a.data]).map(pick) }); if (prev) prev(a); }; });
    await scenarios[name](p, h);
    if (process.env.SHAPES) for (const x of await p.evaluate(() => window.__ab)) console.log('  [' + (base.includes('8020') ? 'new' : 'old') + '] ' + JSON.stringify(x));
    await p.waitForTimeout(3000);
    const open = await dlg.count(); if (open) errs.push('editor still open');
    const rows = await p.evaluate(`(async () => { const v = (await firebase.database().ref('/calendars/${slug}/events').once('value')).val() || [];
      return (Array.isArray(v) ? v : Object.values(v)).filter(e => e && e.title !== 'Sample event'); })()`);
    const drawn = await p.locator('.e-appointment').count();
    await b.close(); return { rows, errs, drawn };
  } catch (e) { errs.push('script: ' + e.message.split('\n')[0]); await b.close(); return { rows: [], errs, drawn: -1 }; }
}

const FIELDS = ['title', 'start', 'end', 'type', 'isAllDay', 'recurrencerule', 'recurrenceException', 'description'];
const norm = (v) => (v === undefined || v === null || v === '' || v === false) ? null : String(v);
const idKind = (id) => typeof id === 'number' ? 'number' : (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) ? 'uuid' : (id === undefined || id === null ? 'none' : 'text:' + id));
const shape = (r, all) => {
  const master = r.recurrenceID === undefined || r.recurrenceID === null ? null : all.find(x => String(x.id) === String(r.recurrenceID) && (x.recurrenceID === undefined || x.recurrenceID === null));
  return { ...Object.fromEntries(FIELDS.map(f => [f, norm(r[f])])), idKind: master === undefined ? '' : idKind(r.id),
    pointsAt: r.recurrenceID === undefined || r.recurrenceID === null ? null : (master ? `series "${master.title}" (${typeof r.recurrenceID})` : 'MISSING SERIES') };
};
// Exception stamps name the occurrence; compare the set, not the order.
const sortEx = (s) => s && s.recurrenceException ? { ...s, recurrenceException: s.recurrenceException.split(',').sort().join(',') } : s;

(async () => {
  const only = process.argv[2];
  let bad = 0;
  for (const name of Object.keys(scenarios).filter(n => !only || n.includes(only))) {
    const [o, n] = await Promise.all([run(OLD, name), run(NEW, name)]);
    const key = (r) => r.title + '|' + (r.recurrenceID === undefined || r.recurrenceID === null ? 'series' : 'occ');
    const om = new Map(o.rows.map(r => [key(r), sortEx(shape(r, o.rows))])), nm = new Map(n.rows.map(r => [key(r), sortEx(shape(r, n.rows))]));
    const diffs = [];
    for (const k of new Set([...om.keys(), ...nm.keys()])) {
      const a = om.get(k), c = nm.get(k);
      if (!a || !c) { diffs.push(`only in ${a ? 'OLD' : 'NEW'}: ${k}`); continue; }
      for (const f of Object.keys(a)) if (a[f] !== c[f]) diffs.push(`${k}.${f}: old=${a[f]} new=${c[f]}`);
    }
    if (o.drawn !== n.drawn) diffs.push(`events drawn: old=${o.drawn} new=${n.drawn}`);
    const ok = !diffs.length && !n.errs.length;
    if (!ok) bad++;
    console.log(`${ok ? 'SAME' : 'DIFF'}  ${name}`);
    for (const d of diffs) console.log('        ', d);
    if (o.errs.length) console.log('         old errors:', o.errs.join(' | '));
    if (n.errs.length) console.log('         new errors:', n.errs.join(' | '));
  }
  console.log(bad ? `${bad} scenario(s) differ` : 'ALL SCENARIOS IDENTICAL');
})();
