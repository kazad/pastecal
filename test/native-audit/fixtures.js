// Shared fixture data and browser helpers for the native-vs-Syncfusion audit.
// Runs only against a LOCAL wrangler dev (default http://127.0.0.1:8900); refuses anything else.
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8900';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) throw new Error('audit only runs against a local server: ' + BASE);

// Hosts the pages may load (CDNs and fonts). Everything else external is aborted, so nothing
// can reach production Firebase, analytics, Clarity, etc.
const ALLOWED_EXTERNAL = [
  'fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com', 'cdn.jsdelivr.net',
  'cdn.tailwindcss.com', 'www.gstatic.com', 'cdn.syncfusion.com', 'cdnjs.cloudflare.com',
];

// DNS-level block for everything else. page.route() does NOT see WebSockets, so without this the
// Firebase SDK opened a (read-only, unauthenticated) socket to production. Use for every launch.
const LAUNCH_ARGS = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE fonts.googleapis.com, EXCLUDE fonts.gstatic.com, EXCLUDE unpkg.com, EXCLUDE cdn.jsdelivr.net, EXCLUDE cdn.tailwindcss.com, EXCLUDE www.gstatic.com'];

const iso = (s) => new Date(s).toISOString();

// All-day values in the stored legacy form (UTC instant of a local midnight; end exclusive).
// UTC midnight reads back as the same calendar date in every zone (Event.allDayDateUTC).
const day = (d) => `${d}T00:00:00.000Z`;

function baseEvents() {
  const ev = [];
  let n = 0;
  const add = (o) => ev.push({ id: `fx-${++n}`, title: '', description: '', repeat: '', recurrencerule: '', type: 1,
    recurrenceID: null, recurrenceException: null, isAllDay: false, ...o });
  // Weekly series with an exception (Wed Oct 14 removed) - 9:00-9:30 New York
  add({ id: 'fx-standup', title: 'Team standup', start: iso('2026-10-05T13:00:00Z'), end: iso('2026-10-05T13:30:00Z'),
    recurrencerule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1', recurrenceException: '20261014T130000Z', type: 2 });
  // Monthly with COUNT
  add({ id: 'fx-bookclub', title: 'Book club', start: iso('2026-10-15T23:00:00Z'), end: iso('2026-10-16T01:00:00Z'),
    recurrencerule: 'FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6', type: 3 });
  // Daily with UNTIL
  add({ id: 'fx-run', title: 'Morning run', start: iso('2026-10-26T11:00:00Z'), end: iso('2026-10-26T11:45:00Z'),
    recurrencerule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20261030T235959Z', type: 4 });
  // All-day multi-day (Oct 20-23 inclusive)
  add({ id: 'fx-conf', title: 'Conference', start: day('2026-10-20'), end: day('2026-10-24'), isAllDay: true, type: 5 });
  // Single all-day
  add({ id: 'fx-bday', title: 'Mom birthday', start: day('2026-10-28'), end: day('2026-10-29'), isAllDay: true, type: 6 });
  // Description with links + location-in-description
  add({ id: 'fx-links', title: 'Dentist', start: iso('2026-10-22T18:00:00Z'), end: iso('2026-10-22T19:00:00Z'),
    description: 'Bring forms. Map: https://example.com/map?q=1 or mail desk@example.com\nRoom 4B', type: 1 });
  // Long title
  add({ id: 'fx-long', title: 'Quarterly planning offsite with the entire product, design and engineering leadership team (bring laptops)',
    start: iso('2026-10-27T14:00:00Z'), end: iso('2026-10-27T16:00:00Z'), type: 7 });
  // Many events on one day (Oct 29): 6 timed events, several overlapping
  const hrs = [[13, 14], [13, 15], [14, 15], [15, 16], [15, 17], [19, 20]];
  hrs.forEach(([a, b], i) => add({ id: `fx-busy-${i}`, title: `Busy ${i + 1}`,
    start: iso(`2026-10-29T${String(a).padStart(2, '0')}:00:00Z`), end: iso(`2026-10-29T${String(b).padStart(2, '0')}:00:00Z`), type: (i % 8) + 1 }));
  // Crossing midnight (New York 10pm -> 2am)
  add({ id: 'fx-midnight', title: 'Night shift', start: iso('2026-10-24T02:00:00Z'), end: iso('2026-10-24T06:00:00Z'), type: 8 });
  // Across the EU DST change (Sun Oct 25 2026 03:00 CEST -> 02:00 CET): 00:30-04:30 Berlin
  add({ id: 'fx-dst-eu', title: 'DST EU overnight', start: iso('2026-10-24T22:30:00Z'), end: iso('2026-10-25T03:30:00Z'), type: 2 });
  // Daily 9:00 New York series across the US DST change (Nov 1 2026)
  add({ id: 'fx-dst-us', title: 'Pill reminder', start: iso('2026-10-28T13:00:00Z'), end: iso('2026-10-28T13:15:00Z'),
    recurrencerule: 'FREQ=DAILY;INTERVAL=1;COUNT=7', type: 3 });
  // Today-ish single event
  add({ id: 'fx-today', title: 'Lunch with Sam', start: iso('2026-10-24T16:00:00Z'), end: iso('2026-10-24T17:00:00Z'), type: 1 });
  return ev;
}

function bigEvents(count = 600) {
  const ev = [];
  const t0 = Date.UTC(2026, 8, 1, 13); // Sep 1 2026
  for (let i = 0; i < count; i++) {
    const s = t0 + Math.floor(i / 5) * 86400000 + (i % 5) * 2 * 3600000;
    ev.push({ id: `big-${i}`, title: `Load event ${i}`, description: '', repeat: '', recurrencerule: '', type: (i % 8) + 1,
      recurrenceID: null, recurrenceException: null, isAllDay: false, start: new Date(s).toISOString(), end: new Date(s + 3600000).toISOString() });
  }
  return ev;
}

async function seed(id, events, title = 'Audit calendar', options = {}) {
  const res = await fetch(`${BASE}/cal/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, options, events }) });
  const txt = await res.text();
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 15000)); return seed(id, events, title, options); }
  if (!res.ok) throw new Error(`seed ${id}: ${res.status} ${txt}`);
  return txt;
}

async function getCal(id) {
  const res = await fetch(`${BASE}/cal/${id}`);
  return res.json();
}

// Replace all events of an existing calendar (to reset between tests without spending creates).
// Uses the admin import route with the LOCAL-ONLY secret wrangler dev was started with.
const SECRET = process.env.AUDIT_IMPORT_SECRET || 'audit-local-only-secret';
async function reset(id, events, title = 'Audit calendar', options = {}) {
  const head = await fetch(`${BASE}/cal/${id}`, { method: 'HEAD' });
  if (head.status === 404) return seed(id, events, title, options);
  const res = await fetch(`${BASE}/cal/${id}/import`, { method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ id, title, options, events }) });
  const body = await res.text();
  if (!res.ok) throw new Error(`reset ${id}: ${res.status} ${body}`);
  return body;
}

async function admin(path, body = {}) {
  const res = await fetch(`${BASE}/api/admin/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.text() };
}

async function newPage(browser, { locale = 'en-US', timezoneId = 'America/New_York', width = 1280, height = 800,
  mobile = false, colorScheme = 'light', storage = {} } = {}) {
  const ctx = await browser.newContext({
    locale, timezoneId, colorScheme,
    viewport: mobile ? { width: 390, height: 844 } : { width, height },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } : {}),
  });
  await ctx.addInitScript((st) => {
    window.__TEST__ = true;
    try { localStorage.setItem('pastecal_backend', 'cf'); for (const k in st) localStorage.setItem(k, st[k]); } catch (e) {}
  }, storage);
  const blocked = [];
  await ctx.routeWebSocket((u) => !/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (ws) => { blocked.push('ws:' + ws.url()); ws.close(); });
  if (process.env.NO_ROUTE) return finish(ctx, blocked);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (ALLOWED_EXTERNAL.includes(u.hostname)) return route.continue();
    blocked.push(u.hostname);
    return route.abort();
  });
  return finish(ctx, blocked);
}

async function finish(ctx, blocked) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return { ctx, page, errors, blocked };
}

module.exports = { LAUNCH_ARGS, BASE, baseEvents, bigEvents, seed, reset, admin, getCal, newPage, iso, day };
