// A local "test Pro account": one wrangler dev + the fake Stripe, seeded with every Pro state, so
// the owner can click through them. Local only: real calendar rooms in a dedicated persist dir,
// Firebase off, Stripe faked on a loopback port. Never preview, production or real Stripe.
//
//   node scripts/demo-pro.mjs [--reset]   start (seeding on first run), print the links, run until Ctrl-C
//   node scripts/demo-pro.mjs link        a fresh one-time owner sign-in link, from the running demo
//
// See docs/DEMO-PRO.md. Usually run through scripts/demo-pro.sh (npm run demo:pro).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeStripe, signStripe } from '../cloudflare/test/fake-stripe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CF = path.join(ROOT, 'cloudflare');
const PORT = Number(process.env.DEMO_PORT || 8970);
const BASE = `http://localhost:${PORT}`;
const STATE = process.env.DEMO_STATE || path.join(os.homedir(), '.pastecal-demo-state');
const SAVED = path.join(STATE, 'demo.json');            // editor keys, owner id, fake Stripe objects
const SECRET = 'dev-secret', WHSEC = 'fake-webhook-secret';
const OWNER = 'owner@demo.test';
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const cf = (p) => `${BASE}${p}${p.includes('?') ? '&' : '?'}backend=cf`;   // every app link: the local Worker, never Firebase

let ipN = 0;
const ip = () => `10.77.${Math.floor(++ipN / 200)}.${ipN % 200}`;
const post = (p, body, cookie) => fetch(BASE + p, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': ip(), ...(cookie ? { Cookie: cookie } : {}) } });
const admin = async (p, init = {}) => (await fetch(BASE + p, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } })).json();
const outbox = async (email) => (await admin(`/api/admin/accounts/outbox?email=${enc(email)}`)).emails || [];
const must = async (r, what) => { if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${await r.text()}`); return r; };

// A sign-in email's token. The link in the email says https://pastecal.com (SITE_URL can only be https);
// the token is what matters, and /signin#t=<token> on this server uses it.
async function mintToken(email, next) {
    const before = (await outbox(email)).length;
    await must(await post('/api/auth/start', { email, ...(next ? { next } : {}) }), 'auth/start');
    const mails = await outbox(email);
    if (mails.length <= before) throw new Error(`no new sign-in email for ${email}: sign-in links are limited to 5 an hour. Wait, or start over with --reset.`);
    return mails.at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
}
const signinLink = (token) => `${BASE}/signin#t=${token}`;

if (args[0] === 'link') {
    try { console.log(signinLink(await mintToken(OWNER, '/demo-rooftop'))); process.exit(0); }
    catch (e) { console.error(`Could not mint a link (is the demo running on ${BASE}?): ${e.message}`); process.exit(1); }
}

// ---- start ---------------------------------------------------------------------------------
function freePort() {
    return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function portBusy(port) {
    return new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
}
if (await portBusy(PORT)) { console.error(`Port ${PORT} is in use. Is the demo already running? (stop it with Ctrl-C in its terminal)`); process.exit(1); }

fs.mkdirSync(STATE, { recursive: true });
const saved = fs.existsSync(SAVED) ? JSON.parse(fs.readFileSync(SAVED, 'utf8')) : null;
const fakePort = await freePort();
const fake = await startFakeStripe(fakePort);
// The fake keeps Stripe's objects in memory; reload them so a restart still answers for the trial's customer etc.
for (const [k, v] of Object.entries(saved?.stripe?.subs || {})) fake.subs.set(k, v);
for (const [k, v] of Object.entries(saved?.stripe?.customers || {})) fake.customers.set(k, v);
const save = (data) => fs.writeFileSync(SAVED, JSON.stringify({ ...data,
    stripe: { subs: Object.fromEntries(fake.subs), customers: Object.fromEntries(fake.customers) } }, null, 2));

const vars = {
    FIREBASE_DB_URL: '', COPY_BACK: '',                      // never Firebase
    ACCOUNTS_DEV_MODE: '1', IMPORT_SECRET: SECRET,
    STRIPE_SECRET_KEY: 'fake-stripe-key', STRIPE_WEBHOOK_SECRET: WHSEC,
    STRIPE_PRICE_PRO_YEARLY: 'price_fake_yearly', STRIPE_PRICE_PRO_MONTHLY: 'price_fake_monthly',
    STRIPE_API_BASE: `http://127.0.0.1:${fakePort}/stripe`,
    LOCK_API_BASE: '',                                       // real rooms, even if cloudflare/.dev.vars points at a test fake
};
// wrangler listens on a private loopback port; the demo's own proxy on PORT passes everything through
// and tightens the pages' Content-Security-Policy (demoCsp), so a browser on the demo can't reach
// production Firebase (the app still signs in anonymously and writes author signals there otherwise)
// or production analytics. Calendar data never went there with ?backend=cf; this closes the rest.
const INNER = await freePort();
const wranglerArgs = ['node_modules/.bin/wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(INNER), '--inspector-port', String(await freePort()),
    '--persist-to', STATE, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
const log = fs.openSync(path.join(STATE, 'wrangler.log'), 'a');
const wrangler = spawn(process.execPath, wranglerArgs, { cwd: CF, detached: true, stdio: ['ignore', log, log] });

function demoCsp(csp) {
    return csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
        const [name] = d.split(/\s+/);
        if (name === 'connect-src') return "connect-src 'self'";                       // no Firebase, Google, analytics
        if (name === 'script-src' || name === 'frame-src') return d.split(/\s+/).filter((t) => !/firebase|google|clarity|hotjar|cloudflareinsights/.test(t)).join(' ');
        return d;
    }).join('; ');
}
const proxyHandler = (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: INNER, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        const h = { ...ur.headers };
        if (h['content-security-policy']) h['content-security-policy'] = demoCsp(h['content-security-policy']);
        res.writeHead(ur.statusCode, h); ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('demo: the Worker is not up yet'); } else res.destroy(); });
    req.pipe(up);
};
const proxyUpgrade = (req, sock, head) => {
    const up = net.connect(INNER, '127.0.0.1', () => {
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        up.write(raw + '\r\n'); if (head && head.length) up.write(head);
        sock.pipe(up).pipe(sock);
    });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
};
const proxies = [];
for (const host of ['127.0.0.1', '::1']) {
    const srv = http.createServer(proxyHandler); srv.on('upgrade', proxyUpgrade);
    await new Promise((resolve) => { srv.once('error', resolve); srv.listen(PORT, host, resolve); });   // no IPv6: 127.0.0.1 is enough
    proxies.push(srv);
}
let stopping = false;
function stop(code = 0) {
    if (stopping) return; stopping = true;
    try { save(currentData); } catch { /* best effort */ }
    try { process.kill(-wrangler.pid, 'SIGTERM'); } catch { /* already gone */ }
    fake.close();
    for (const p of proxies) p.close();
    setTimeout(() => process.exit(code), 500);
}
let currentData = saved || {};
process.on('SIGINT', () => { console.log('\nStopping the demo...'); stop(0); });
process.on('SIGTERM', () => stop(0));
wrangler.on('exit', (c) => { if (!stopping) { console.error(`wrangler dev exited (${c}); see ${path.join(STATE, 'wrangler.log')}`); stop(1); } });

process.stdout.write(`Starting wrangler dev on ${BASE} (state: ${STATE}) `);
for (let i = 0; ; i++) {
    try { if ((await fetch(BASE + '/robots.txt')).ok) break; } catch { /* not yet */ }
    if (i > 240) { console.error(`\nwrangler dev never answered; see ${path.join(STATE, 'wrangler.log')}`); stop(1); await sleep(1e9); }
    if (i % 4 === 0) process.stdout.write('.');
    await sleep(500);
}
console.log(' up.');

// ---- seed (first run only) ------------------------------------------------------------------
const day = (offset, h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString(); };
const ev = (id, title, offset, h, hours = 1, type = 1, description = '') =>
    ({ id, title, description, start: day(offset, h), end: day(offset, h + hours), type, isAllDay: false });
const allDay = (id, title, offset, type = 1) => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
    const s = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    return { id, title, start: s.toISOString(), end: new Date(+s + 864e5).toISOString(), type, isAllDay: true };
};
const CALS = {
    'demo-rooftop': { title: 'Riverside rooftop', events: [
        ev('r1', 'Sunset yoga', 0, 18, 1, 2, 'Bring a mat. Rooftop opens at 5:45.'),
        ev('r2', 'Private event: Patel wedding', 1, 16, 5, 3),
        ev('r3', 'Open mic night', 2, 19, 3, 1),
        ev('r4', 'Maintenance: string lights', 3, 9, 2, 4),
        ev('r5', 'Wine tasting', 4, 18, 2, 2),
        allDay('r6', 'Closed for deck staining', 6, 4),
        ev('r7', 'Community board meeting', 8, 17, 1, 1),
        ev('r8', 'Jazz trio', 9, 19, 2, 2),
    ] },
    'demo-trial': { title: 'Robotics club (trial)', events: [
        ev('t1', 'Build night', 1, 18, 2, 1), ev('t2', 'Regional qualifier', 5, 9, 8, 3), ev('t3', 'Parent meeting', 3, 19, 1, 2)] },
    'demo-lapsed': { title: 'Choir rehearsals (Pro ended)', events: [
        ev('l1', 'Sectionals', 1, 19, 2, 1), ev('l2', 'Full rehearsal', 4, 19, 2, 2), ev('l3', 'Spring concert', 12, 18, 3, 3)] },
    'demo-free': { title: 'Book club (free)', events: [
        ev('f1', 'Book club: chapters 1-8', 2, 19, 2, 1), ev('f2', 'Book club: finale', 9, 19, 2, 1)] },
};
const proStatus = async (id, cookie) => (await fetch(`${BASE}/api/pro/status?calendar=${enc(id)}`, { headers: cookie ? { Cookie: cookie } : {} })).json();
const run = Date.now().toString(36);
let evN = 0;
const webhook = async (type, object) => {
    const body = JSON.stringify({ id: `evt_demo_${run}_${++evN}`, object: 'event', type, data: { object } });
    await must(await fetch(BASE + '/api/stripe/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) } }), `webhook ${type}`);
};
const paidSub = (id, calendarId, userId, status, interval = 'year') => ({ id, object: 'subscription', status, customer: `cus_demo_${calendarId}`,
    created: Math.floor(Date.now() / 1000), metadata: { calendar_id: calendarId, user_id: userId },
    items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + (interval === 'year' ? 365 : 30) * 86400,
        price: { id: interval === 'year' ? 'price_fake_yearly' : 'price_fake_monthly', recurring: { interval } } }] } });

async function seed() {
    console.log('Seeding demo calendars...');
    for (const [id, c] of Object.entries(CALS)) {
        const r = await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: { 'CF-Connecting-IP': ip() }, body: JSON.stringify({ title: c.title, options: {}, events: c.events }) });
        if (r.status !== 201 && r.status !== 409) await must(r, `create ${id}`);
    }
    // A view-only link (before the lock: views are made while the calendar is open).
    const view = await (await must(await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip() },
        body: JSON.stringify({ sourceCalendarId: 'demo-rooftop', customSlug: 'demo-rooftop-view' }) }), 'create-view')).json();

    // Stats: visitors on distinct networks with varied browsers and sources, plus calendar apps following the feed.
    // (Counts land on today, at this hour: the Worker only counts real requests, there is no backfill.)
    const uas = ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0'];
    const srcs = ['', '', '', 'embed', 'search', 'site'];
    for (let i = 0; i < 18; i++) {
        await fetch(`${BASE}/cal/demo-rooftop${srcs[i % srcs.length] ? `?src=${srcs[i % srcs.length]}` : ''}`,
            { headers: { 'CF-Connecting-IP': `198.51.${100 + i}.${10 + i}`, 'User-Agent': uas[i % uas.length] } });
    }
    const apps = ['Google-Calendar-Importer', 'Google-Calendar-Importer', 'iOS/18.0 (22A3354) dataaccessd/1.0', 'iOS/17.6 (21G80) dataaccessd/1.0',
        'macOS/14.5 (23F79) CalendarAgent/988', 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928)', 'Thunderbird/128.0'];
    for (let i = 0; i < apps.length; i++) await fetch(`${BASE}/demo-rooftop.ics`, { headers: { 'CF-Connecting-IP': `203.0.${10 + i}.5`, 'User-Agent': apps[i] } });
    for (let i = 0; i < 6; i++) await fetch(`${BASE}/cal/demo-free`, { headers: { 'CF-Connecting-IP': `192.0.${20 + i}.9`, 'User-Agent': uas[i % uas.length] } });
    await sleep(300);

    // The owner's account (a verified sign-in, for seeding).
    const token = await mintToken(OWNER);
    const v = await must(await post('/api/auth/verify', { token }), 'auth/verify');
    const cookie = v.headers.get('set-cookie').split(';')[0];
    const userId = (await admin(`/api/admin/accounts/lookup?email=${enc(OWNER)}`)).user.id;

    // Riverside rooftop: paid Pro (yearly) through the Stripe webhook, then named editor links.
    fake.customers.set('cus_demo_demo-rooftop', { id: 'cus_demo_demo-rooftop', object: 'customer', email: OWNER, invoice_settings: { default_payment_method: 'pm_demo_visa' } });
    fake.subs.set('sub_demo_rooftop', paidSub('sub_demo_rooftop', 'demo-rooftop', userId, 'active'));
    await webhook('customer.subscription.created', { id: 'sub_demo_rooftop', object: 'subscription' });
    const editors = {};
    for (const label of ['Maria', 'Dev']) {
        const r = await (await must(await post('/api/pro/editor-links', { calendarId: 'demo-rooftop', label }, cookie), `editor link ${label}`)).json();
        editors[label] = r.url_fragment_key;
    }

    // Robotics club: the 30-day trial (one per person, so the owner's only one).
    await must(await post('/api/pro/trial', { calendarId: 'demo-trial' }, cookie), 'trial');

    // Choir: paid monthly, then canceled -> Pro ended, paused (read-only for everyone).
    fake.customers.set('cus_demo_demo-lapsed', { id: 'cus_demo_demo-lapsed', object: 'customer', email: OWNER });
    fake.subs.set('sub_demo_lapsed', paidSub('sub_demo_lapsed', 'demo-lapsed', userId, 'active', 'month'));
    await webhook('customer.subscription.created', { id: 'sub_demo_lapsed', object: 'subscription' });
    fake.subs.get('sub_demo_lapsed').status = 'canceled';
    await webhook('customer.subscription.deleted', { id: 'sub_demo_lapsed', object: 'subscription' });

    const st = { rooftop: await proStatus('demo-rooftop', cookie), trial: await proStatus('demo-trial', cookie), lapsed: await proStatus('demo-lapsed', cookie), free: await proStatus('demo-free', cookie) };
    const want = [[st.rooftop.locked && st.rooftop.isOwner, 'demo-rooftop locked for the owner'], [!!st.trial.trial, 'demo-trial on a trial'],
        [st.lapsed.paused && st.lapsed.lapsedOwner, 'demo-lapsed paused'], [!st.free.locked && !st.free.paused, 'demo-free plain']];
    for (const [ok, what] of want) if (!ok) throw new Error(`seed check failed: ${what} (${JSON.stringify(st)})`);
    return { seededAt: new Date().toISOString(), userId, editors, viewId: view.publicViewId || view.slug || 'demo-rooftop-view' };
}

try {
    const seeded = saved?.editors && (await proStatus('demo-rooftop')).locked;
    if (!seeded) { currentData = await seed(); save(currentData); }
    else console.log('Already seeded (start over with --reset).');
    const token = await mintToken(OWNER, '/demo-rooftop');
    const { editors, viewId } = currentData;
    const L = (label, url) => console.log(`  ${label.padEnd(26)} ${url}`);
    console.log(`
=== pastecal Pro demo: ${BASE} ===

1. Open this first in the browser you'll use (switches it to the local backend, never Firebase):
  ${cf('/demo-free')}
2. Then sign in as the owner (${OWNER}). One-time link, expires in 15 minutes:
  ${signinLink(token)}
   (a fresh one: bash scripts/demo-pro.sh link)

Owner (signed in) views:`);
    L('Riverside rooftop (Pro)', cf('/demo-rooftop'));
    L('Robotics club (trial)', cf('/demo-trial'));
    L('Choir (Pro ended, paused)', cf('/demo-lapsed'));
    L('Book club (free)', cf('/demo-free'));
    console.log(`
Use a private window (or another browser) for these; open ${cf('/demo-free')} there first too:`);
    for (const [label, key] of Object.entries(editors)) L(`Editor link "${label}"`, `${cf('/demo-rooftop')}#k=${key}`);
    L('Visitor (edit name)', cf('/demo-rooftop'));
    L('View-only link', cf(`/view/${enc(viewId)}`));
    L('Visitor on paused', cf('/demo-lapsed'));
    console.log(`
Pro stats: as the owner on Riverside rooftop, Share -> Stats (or the logo menu -> Stats).
Stop: Ctrl-C here.  Start over: bash scripts/demo-pro.sh --reset
Logs: ${path.join(STATE, 'wrangler.log')}
DEMO READY`);
} catch (e) {
    console.error(`\nDemo setup failed: ${e.message}\nLogs: ${path.join(STATE, 'wrangler.log')}`);
    stop(1);
}
