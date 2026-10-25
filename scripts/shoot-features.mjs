// Screenshots for pastecal.com/features (public/features.html), taken from the real app.
// Seeds its own demo calendar (a youth soccer team) and view link, then writes public/img/features/*.jpg (1x JPEG, light theme).
// Run against a local `wrangler dev`, never the live site:
//   (cd cloudflare && node node_modules/.bin/wrangler dev --port 8899 --persist-to $(mktemp -d) --var IMPORT_SECRET:dev-secret --var COPY_BACK: --var FIREBASE_DB_URL:)
//   BASE=http://localhost:8899 node scripts/shoot-features.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('/Users/kazad/Dropbox/computer/Projects/pastecal/node_modules/playwright');
const BASE = process.env.BASE || 'http://localhost:8899';
if (/pastecal\.com/.test(BASE)) throw new Error('shoot-features seeds a calendar: point it at a local wrangler dev, not ' + BASE);
const OUT = 'public/img/features';
fs.mkdirSync(OUT, { recursive: true });

// ---- The demo calendar: October 2026, pinned so the pictures (and features.css's overlay positions) never move.
const Y = 2026, M = 9;
const at = (day, h, m = 0) => new Date(Y, M, day, h, m).toISOString();
const days = new Date(Y, M + 1, 0).getDate();
const dow = (day) => new Date(Y, M, day).getDay();
const events = [];
let n = 0;
const add = (title, day, h, m, mins, type) => events.push({ id: `f${++n}`, title, start: at(day, h, m), end: new Date(new Date(Y, M, day, h, m).getTime() + mins * 60e3).toISOString(), type });
for (let d = 1; d <= days; d++) {
  if (dow(d) === 2 || dow(d) === 4) add('Practice', d, 17, 30, 75, 1);
  if (dow(d) === 6) add(d % 2 ? 'Game vs Hawks' : 'Game at Eastside', d, 10, 0, 90, 2);
}
const firstSat = [...Array(days).keys()].map((i) => i + 1).find((d) => dow(d) === 6);
add('Snacks: Patel family', firstSat, 9, 30, 30, 3);
add('Snacks: Okafor family', firstSat + 14, 9, 30, 30, 3);
add('Photo day', firstSat + 7, 9, 0, 60, 4);
// Wednesday the 14th stays empty: the page's first animation adds "Picture day" there.
const lastFri = [...Array(days).keys()].map((i) => i + 1).filter((d) => dow(d) === 5).pop();
add('Team pizza party', lastFri, 18, 0, 120, 4);
const NOTES = 'Home field: Riverside Park, Field 3\nRainouts are decided by 7am on game day.\nBring water and shin guards.\nCoach Dana: 555-0142';
const options = { typeLabels: ['Practice', 'Game', 'Snacks', 'Team event'], notes: NOTES };

// The name shows in the pictures, so it is a plain one; a server that already has it gets -2, -3...
// To shoot again on the same server without a new calendar: VIEW=<its newest view id> node scripts/shoot-features.mjs
// (Share shows a calendar's newest view link, so every picture shows the same one.)
let id, view;
if (process.env.VIEW) { id = 'riverside-tigers'; view = { ok: true, publicViewId: process.env.VIEW }; }
else {
  for (const name of ['riverside-tigers', ...[2, 3, 4, 5, 6, 7, 8, 9].map((k) => `riverside-tigers-${k}`)]) {
    const made = await fetch(`${BASE}/cal/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Riverside Tigers U10', options, events }) });
    if (made.status === 201) { id = name; break; }
  }
  if (!id) throw new Error('could not create the demo calendar');
  view = await (await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceCalendarId: id }) })).json();
  if (!view.ok) throw new Error('create-view failed');
}
console.log('seeded', id, 'view', view.publicViewId, '(features.html shows this view link in its chat bubble: update it to match)');

// ---- The browser ---------------------------------------------------------------------------------
const HIDE = '.pc-grid-tip,.pc-tour,.pc-tpl-nudge,.pc-home-aside,.welcome-dock,.pc-toast,.pc-snackbar{display:none!important}';
const b = await chromium.launch();
async function open(path, ctxOpts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1, colorScheme: 'light', ...ctxOpts });
  await ctx.addInitScript(() => { window.__TEST__ = true; try { localStorage.setItem('pastecal_global_settings', JSON.stringify({ darkMode: 'light' })); } catch (e) { /* */ } });
  await ctx.route(/googletagmanager|google-analytics|clarity|hotjar|\/api\/collect/, (r) => r.abort());
  const p = await ctx.newPage();
  await p.goto(`${BASE}/?backend=cf`);
  await p.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}backend=cf`);
  return { ctx, p };
}
// Ready, and on October 2026 whatever today is.
const ready = async (p) => {
  await p.waitForFunction(() => window.scheduleObj && document.querySelector('.e-month-view .e-appointment'), null, { timeout: 20000 });
  await p.evaluate(([y, m]) => { const d = scheduleObj.selectedDate; if (d.getFullYear() !== y || d.getMonth() !== m) { scheduleObj.selectedDate = new Date(y, m, 1); scheduleObj.dataBind(); } }, [Y, M]);
  await p.waitForTimeout(400);
};
const vm = (p, js) => p.evaluate(`(() => { const vm = document.querySelector('#app')._vnode.component.proxy; ${js} })()`);
const shot = (p, name, opts) => p.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 78, ...opts }).then(() => console.log('shot', name));
const settle = async (p) => { await p.addStyleTag({ content: HIDE }); await p.waitForTimeout(700); };

// 1. The calendar: the header with quick add, and the month.
{
  const { ctx, p } = await open(`/${id}`);
  await ready(p); await settle(p);
  await shot(p, 'calendar', { clip: { x: 0, y: 0, width: 1180, height: 700 } });
  // Where the first animation's pieces go, as a share of the picture (features.css uses these numbers).
  const cell = await p.evaluate(() => { const td = [...document.querySelectorAll('#Schedule .e-work-cells')].find((c) => new Date(+c.dataset.date).getDate() === 14 && new Date(+c.dataset.date).getMonth() === 9); const r = td.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); });
  const pill = await p.evaluate(() => { const el = document.querySelector('.pc-slug-pill, [data-testid="share-pill-more"]'); const r = el && el.closest('div').getBoundingClientRect(); return r && [r.x, r.y, r.width, r.height].map(Math.round); });
  console.log('  Wed 14 cell (x,y,w,h of 1180x700):', cell, ' link pill:', pill);
  await ctx.close();
}
// 2. Share: the edit link and the view link.
{
  const { ctx, p } = await open(`/${id}`);
  await ready(p);
  await vm(p, 'if (!vm.showShare) vm.toggleShare();');
  await p.getByTestId('side-panel').waitFor();
  await settle(p);
  const box = await p.getByTestId('side-panel').boundingBox();
  await shot(p, 'share', { clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 560) } });
  await ctx.close();
}
// 3. Add to my calendar: the view link's add page, on an iPhone.
{
  const iphone = devices['iPhone 13'];
  const { ctx, p } = await open(`/view/${view.publicViewId}/add`, { ...iphone, viewport: { width: 390, height: 760 }, deviceScaleFactor: 1 });
  await p.locator('h1').waitFor();
  await p.getByTestId('subscribe-address').evaluate((el, prod) => { el.textContent = el.textContent.replace(/https?:\/\/(localhost|127\.0\.0\.1):\d+/, prod); }, 'https://pastecal.com');
  await settle(p);
  await shot(p, 'add', { clip: { x: 0, y: 0, width: 390, height: 760 } });
  await ctx.close();
}
// 4. Colors, notes and search: the month with the notes beside it.
{
  const { ctx, p } = await open(`/${id}`);
  await ready(p);
  await vm(p, 'if (!vm.showNotes) vm.toggleNotes();');
  await p.getByTestId('side-panel').waitFor();
  await settle(p);
  await shot(p, 'notes', { clip: { x: 470, y: 64, width: 710, height: 380 } });
  await ctx.close();
}
// 5. Print: one page, the month with its name, dates and a QR code.
{
  const { ctx, p } = await open(`/${id}`, { viewport: { width: 1056, height: 816 } });
  await ready(p);
  await p.waitForFunction(() => typeof window.qrcode === 'function', null, { timeout: 15000 });
  await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  // The footer's link and QR code as they print on pastecal.com.
  await vm(p, `vm.printLink = vm.printLink.replace(/^(localhost|127\\.0\\.0\\.1):\\d+/, 'pastecal.com'); const q = qrcode(0, 'M'); q.addData('https://' + vm.printLink + '/add'); q.make(); vm.printQr = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });`);
  await p.emulateMedia({ media: 'print' });
  await settle(p);
  await shot(p, 'print', { clip: { x: 0, y: 0, width: 1056, height: 730 } });
  await ctx.close();
}
// 6. Plus: who can edit.
{
  const { ctx, p } = await open(`/${id}`);
  await ready(p);
  await vm(p, "vm.openSideTab('plus');");
  await p.getByTestId('plus-panel').waitFor();
  await settle(p);
  const box = await p.getByTestId('side-panel').boundingBox();
  await shot(p, 'plus', { clip: { x: box.x, y: box.y, width: box.width, height: 290 } });
  await ctx.close();
}
await b.close();
