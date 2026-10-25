// The calendar's time zone (options.tz) and who gets per-calendar link-preview tags, against `wrangler dev`
// (real rooms; any vars, IMPORT_SECRET for /import):
//   BASE=http://localhost:8787 node test/previews-tz.test.mjs
// - tz: set on create from the browser's zone (an invalid name is dropped); an editing browser names its zone
//   with each save and it is stored once, while the calendar has none; never replaced automatically after that
//   (a meta with another tz keeps the stored one; only an explicit setTz changes it); the Firebase shadow
//   (/import) keeps it.
// - previews: a link-preview fetcher gets the calendar's title, description and card (times in its zone); a
//   person's browser gets the static page.
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const run = Date.now().toString(36), enc = encodeURIComponent;
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
let ip = 0;
const BOT = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const PERSON = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const la5pm = (d) => new Date(Date.UTC(2026, 10, d, 1)).toISOString();          // Nov <d-1> 5pm PST = <d> 01:00Z
const create = async (id, options) => fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', headers: { 'CF-Connecting-IP': `10.70.0.${++ip}` },
    body: JSON.stringify({ title: 'U10 Soccer', options, events: [{ id: 'p', title: 'Practice', start: la5pm(4), end: la5pm(4).replace('T01', 'T02'), type: 1 }] }) });
const tzOf = async (id) => ((await (await fetch(`${BASE}/cal/${enc(id)}`)).json()).calendar.options || {}).tz;
function tab(id) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${enc(id)}/ws`);
    const got = []; ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const waitFor = async (pred) => { for (let i = 0; i < 200; i++) { const h = got.find(pred); if (h) return h; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
    let k = 0;
    return { ready: waitFor((m) => m.t === 'snapshot'), send: async (m) => { const id2 = `m${++k}`; ws.send(JSON.stringify({ ...m, id: id2 })); return waitFor((x) => x.id === id2); }, close: () => ws.close() };
}

// --- tz on create
let id = `tz-a-${run}`;
assert.equal((await create(id, { tz: 'America/Los_Angeles' })).status, 201);
assert.equal(await tzOf(id), 'America/Los_Angeles');
const bad = `tz-b-${run}`;
assert.equal((await create(bad, { tz: 'Mars/Olympus', notes: 'x' })).status, 201);
assert.equal(await tzOf(bad), undefined, 'an invalid zone is dropped');
step('create stores the browser\'s IANA zone; an invalid name is dropped');

// --- a save names the editing browser's zone: stored once, while unset; never replaced automatically
const t = tab(bad); await t.ready;
let r = await t.send({ t: 'save', v: 0, commands: [{ type: 'add', event: { id: 'e2', title: 'Game', start: la5pm(6), end: la5pm(6).replace('T01', 'T02'), type: 2 } }], tz: 'America/Los_Angeles' });
assert.equal(r.t, 'ack');
assert.equal(await tzOf(bad), 'America/Los_Angeles', 'stored from the first editing browser');
r = await t.send({ t: 'save', v: 0, commands: [{ type: 'add', event: { id: 'e3', title: 'Photo', start: la5pm(7), end: la5pm(7).replace('T01', 'T02'), type: 3 } }], tz: 'Europe/Berlin' });
assert.equal(await tzOf(bad), 'America/Los_Angeles', 'another browser\'s zone never replaces it');
r = await t.send({ t: 'meta', options: { notes: 'y', tz: 'Asia/Tokyo' } });
assert.equal(await tzOf(bad), 'America/Los_Angeles', 'a meta with another zone keeps the stored one');
r = await t.send({ t: 'meta', options: { tz: 'Not/AZone' }, setTz: true });
assert.equal(await tzOf(bad), 'America/Los_Angeles', 'an explicit but invalid zone changes nothing');
r = await t.send({ t: 'meta', options: { tz: 'America/New_York' }, setTz: true });
assert.equal(await tzOf(bad), 'America/New_York', 'only an explicit setTz (a future Settings field) changes it');
t.close();
step('a save stores the editing browser\'s zone once; later saves and metas never replace it; only an explicit, valid setTz does');

// --- the Firebase shadow (/import) keeps a stored zone
r = await (await fetch(`${BASE}/cal/${enc(id)}/import`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ id, title: 'U10 Soccer', options: { notes: 'from firebase' }, events: [] }) })).json();
assert.equal(r.ok, true, JSON.stringify(r));
assert.equal(await tzOf(id), 'America/Los_Angeles');
step('/import (the Firebase shadow, which never carries tz) keeps the stored zone');

// --- previews: bots get the calendar's tags (times in its zone); people get the static page
const cal = `tz-p-${run}`;
assert.equal((await create(cal, { tz: 'America/Los_Angeles' })).status, 201);
const head = async (ua, p = `/${cal}`) => (await (await fetch(BASE + p, { headers: { 'User-Agent': ua } })).text()).split('</head>')[0];
const botHead = await head(BOT);
assert.match(botHead, /<title>U10 Soccer · pastecal<\/title>/);
assert.match(botHead, /<meta name="description" content="Tue Nov 3 · Practice">/, 'the LA date, not the UTC one');
const img = /<meta property="og:image" content="[^"]*(\/og\/[^"?]+\.png\?v=[^"]+)"/.exec(botHead)[1];
assert.equal((await fetch(BASE + img.replace(/&amp;/g, '&'))).headers.get('content-type'), 'image/png');
step('a link-preview fetcher gets the calendar\'s title, LA-dated description and card');

console.log(`\n${n} checks passed`);
process.exit(0);
