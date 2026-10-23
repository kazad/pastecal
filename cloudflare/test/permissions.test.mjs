// Pro permissions: named editor links, owner-only proSettings, and the owner/editor/viewer roles on a
// locked calendar. Against `wrangler dev` with the real lock (no LOCK_API_BASE) and dev sign-in:
//   node node_modules/.bin/wrangler dev --port 8860 --inspector-port 9260 --persist-to /tmp/pc-perms \
//     --var COPY_BACK: --var FIREBASE_DB_URL:http://127.0.0.1:9 --var UNSAFE_DEV_SESSION_HEADER:on --var ACCOUNTS_DEV_MODE:1
//   BASE=http://localhost:8860 node test/permissions.test.mjs
// (.dev.vars: IMPORT_SECRET=dev-secret, and no LOCK_API_BASE.) Owners sign in for real: magic link from
// the dev outbox, then the pc_session cookie on /api/pro/*. On sockets, X-Dev-Session-User stands in for it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8860', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const run = Date.now().toString(36);
const enc = encodeURIComponent;
const auth = { Authorization: `Bearer ${SECRET}` };
const at = (d, h) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1 });
let ip = 0; const nextIp = () => `10.30.${Math.floor(++ip / 200)}.${ip % 200}`;

const post = (path, body, { cookie, origin = BASE, type = 'application/json' } = {}) => fetch(BASE + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': type, ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), 'CF-Connecting-IP': nextIp() },
});
const getJ = async (path, cookie) => { const r = await fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} }); return { status: r.status, body: await r.json().catch(() => null), text: '' }; };
const admin = async (id, op, body) => {
    const r = await fetch(`${BASE}/api/admin/cal/${enc(id)}/${op}`, op === 'lock-status' ? { headers: auth } : { method: 'POST', headers: auth, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
};
async function signIn(email) {
    assert.equal((await post('/api/auth/start', { email })).status, 200);
    const mails = (await (await fetch(`${BASE}/api/admin/accounts/outbox?email=${enc(email)}`, { headers: auth })).json()).emails;
    const token = mails.at(-1).text.match(/\/signin#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const userId = (await (await fetch(`${BASE}/api/admin/accounts/lookup?email=${enc(email)}`, { headers: auth })).json()).user.id;
    return { cookie, userId };
}
const getCal = async (id) => (await fetch(`${BASE}/cal/${enc(id)}`)).json();

function tab(path, { headers } = {}) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + path, headers ? { headers } : undefined);
    const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const waitFor = async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await sleep(20); }
        throw new Error('timed out; got ' + JSON.stringify(got.slice(-3)));
    };
    const send = (m) => ws.send(JSON.stringify(m));
    let k = 0;
    const save = async (commands) => { const sid = `s${++k}-${Math.random()}`; send({ t: 'save', id: sid, v: 0, commands }); return waitFor((m) => m.id === sid); };
    const meta = async (fields) => { const sid = `m${++k}-${Math.random()}`; send({ t: 'meta', id: sid, ...fields }); return waitFor((m) => m.id === sid); };
    const authKey = async (key) => { const before = got.length; send({ t: 'auth', key }); return waitFor((m) => m.t === 'auth' && got.indexOf(m) >= before); };
    return { ws, got, waitFor, send, save, meta, authKey, ready: waitFor((m) => m.t === 'snapshot') };
}
const calTab = (id, opts) => tab(`/cal/${enc(id)}/ws`, opts);

const owner = await signIn(`perm-owner-${run}@example.com`);
const other = await signIn(`perm-other-${run}@example.com`);
const id = `test-perms-${run}`;
assert.equal((await fetch(`${BASE}/cal/${enc(id)}`, { method: 'POST', body: JSON.stringify({ title: 'Team', events: [ev('a', 'first', 1)] }) })).status, 201);

// Before the lock: owner routes say not-locked, and nobody can set Pro settings.
let r = await post('/api/pro/settings', { calendarId: id, settings: { hideBranding: true } }, { cookie: owner.cookie });
assert.equal(r.status, 409); assert.equal((await r.json()).error, 'not-locked');
assert.equal((await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie)).status, 409);
assert.equal((await getCal(id)).proSettings, null);
const locked = await admin(id, 'lock', { ownerId: owner.userId, plan: 'pro' });
assert.equal(locked.status, 200);
const KEY0 = locked.body.editorKey;
step('unlocked: owner routes answer 409 not-locked and proSettings is null; locking returns the first (\'Editors\') link key');

// 1. The new internal routes cannot be reached from outside.
for (const suffix of ['create-editor-link', 'list-editor-links', 'revoke-editor-link', 'set-pro-settings', 'dev-legacy-key']) {
    const rr = await fetch(`${BASE}/cal/${enc(id)}/${suffix}`, { method: 'POST', body: JSON.stringify({ ownerId: owner.userId, label: 'x', settings: {} }) });
    assert.ok(rr.status === 404 || rr.status === 403, `POST /cal/<id>/${suffix} answered ${rr.status}`);
}
assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(id)}/dev-legacy-key`, { method: 'POST', body: '{}' })).status, 403);
assert.equal((await fetch(`${BASE}/api/admin/cal/${enc(id)}/create-editor-link`, { method: 'POST', headers: auth, body: JSON.stringify({ ownerId: owner.userId, label: 'x' }) })).status, 404,
    'the admin route does not expose link creation');
step('create/list/revoke-editor-link, set-pro-settings, dev-legacy-key are 404/403 from outside');

// 2. Named links: create two, both work; list never shows keys.
const mk = async (label, cookie = owner.cookie) => post('/api/pro/editor-links', { calendarId: id, label }, { cookie });
r = await mk('Alice'); assert.equal(r.status, 200);
const A = await r.json();
r = await mk('  Bob  '); const B = await r.json();
assert.deepEqual(Object.keys(A).sort(), ['createdAt', 'id', 'label', 'url_fragment_key']);
assert.match(A.url_fragment_key, /^[A-Za-z0-9_-]{22}$/); assert.match(A.id, /^[A-Za-z0-9_-]{8}$/);
assert.equal(A.label, 'Alice'); assert.equal(B.label, 'Bob'); assert.notEqual(A.url_fragment_key, B.url_fragment_key);
assert.equal((await mk('')).status, 400); assert.equal((await mk('x'.repeat(41))).status, 400); assert.equal((await mk(42)).status, 400);
let list = await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie);
assert.equal(list.status, 200); assert.ok(Array.isArray(list.body));
assert.deepEqual(list.body.map((l) => l.label), ['Editors', 'Alice', 'Bob']);
for (const l of list.body) assert.deepEqual(Object.keys(l).sort(), ['createdAt', 'id', 'label', 'lastUsedAt']);
const listText = JSON.stringify(list.body);
for (const key of [KEY0, A.url_fragment_key, B.url_fragment_key]) {
    assert.ok(!listText.includes(key) && !listText.includes(createHash('sha256').update(key).digest('hex')), 'the list carries no key or hash');
}
const tA = calTab(id); await tA.ready; const tB = calTab(id); await tB.ready;
let res = await tA.authKey(A.url_fragment_key); assert.deepEqual([res.ok, res.canEdit, res.role], [true, true, 'editor']);
res = await tB.authKey(B.url_fragment_key); assert.deepEqual([res.ok, res.canEdit, res.role], [true, true, 'editor']);
assert.equal((await tA.save([{ type: 'add', event: ev('ea', 'by Alice', 2) }])).t, 'ack');
assert.equal((await tB.save([{ type: 'add', event: ev('eb', 'by Bob', 3) }])).t, 'ack');
list = await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie);
assert.ok(list.body.find((l) => l.id === A.id).lastUsedAt > 0, 'lastUsedAt recorded on auth');
assert.equal(list.body.find((l) => l.label === 'Editors').lastUsedAt, null);
step('two named links (labels trimmed, 1-40 chars) both authorize editing; the plaintext key is returned once as url_fragment_key; the list is [{id,label,createdAt,lastUsedAt}] with no keys or hashes; lastUsedAt is recorded');

// 3. Roles in snapshots.
// On the socket, the dev header stands in for the session (UNSAFE_DEV_SESSION_HEADER wins over the cookie on loopback).
const ownerTab = calTab(id, { headers: { 'X-Dev-Session-User': owner.userId } }); let snap = await ownerTab.ready;
assert.deepEqual([snap.role, snap.canEdit], ['owner', true]);
const otherTab = calTab(id, { headers: { 'X-Dev-Session-User': other.userId } }); snap = await otherTab.ready;
assert.deepEqual([snap.role, snap.canEdit], ['viewer', false]);
const anon = calTab(id); snap = await anon.ready;
assert.deepEqual([snap.role, snap.canEdit, snap.locked], ['viewer', false, true]);
r = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'X-Dev-Session-User': owner.userId }, body: JSON.stringify({ sourceCalendarId: id }) });
const VIEW = (await r.json()).publicViewId; assert.ok(VIEW);
const viewTab = tab(`/cal/view/${enc(VIEW)}/ws`); snap = await viewTab.ready;
assert.deepEqual([snap.role, snap.canEdit], ['viewer', false]);
step('snapshots carry role: owner (session), editor (link), viewer (other signed-in user, anonymous, view link)');

// 4. Revoking one link drops only its sockets.
r = await post('/api/pro/editor-links/revoke', { calendarId: id, id: A.id }, { cookie: owner.cookie });
assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
res = await tA.waitFor((m) => m.t === 'auth' && m.reason === 'link-revoked');
assert.deepEqual([res.ok, res.canEdit, res.role], [false, false, 'viewer']);
assert.equal((await tA.save([{ type: 'add', event: ev('late', 'after revoke', 4) }])).code, 'locked');
assert.equal((await tB.save([{ type: 'add', event: ev('eb2', 'Bob still', 4) }])).t, 'ack');
assert.ok(!tB.got.some((m) => m.t === 'auth' && m.ok === false), 'Bob was not told anything');
const fresh = calTab(id); await fresh.ready;
assert.equal((await fresh.authKey(A.url_fragment_key)).ok, false, 'a revoked key is refused');
list = await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie);
assert.deepEqual(list.body.map((l) => l.label), ['Editors', 'Bob']);
r = await post('/api/pro/editor-links/revoke', { calendarId: id, id: A.id }, { cookie: owner.cookie });
assert.equal(r.status, 404); assert.equal((await r.json()).error, 'no-link');
step('revoking a link: its socket is told {t:auth, ok:false, reason:link-revoked} and can no longer save, its key is refused, other links keep working, it leaves the list; revoking again is 404 no-link');

// 5. At most 20 live links (the 'Editors' link counts).
for (let i = list.body.length; i < 20; i++) assert.equal((await mk(`Helper ${i}`)).status, 200);
r = await mk('One too many');
assert.equal(r.status, 409); assert.equal((await r.json()).error, 'too-many-links');
assert.equal((await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie)).body.length, 20);
step('the 21st live link is refused with 409 too-many-links');

// 6. Nobody but the owner manages links or settings.
const BKEY = B.url_fragment_key;
const settingsBody = { calendarId: id, settings: { hideBranding: false } };
for (const [who, cookie, want] of [['nobody', null, 401], ['an editor (a key, no session)', null, 401], ['another signed-in user', other.cookie, 403]]) {
    assert.equal((await mk('Sneaky', cookie)).status, want, `${who}: create`);
    assert.equal((await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, cookie)).status, want, `${who}: list`);
    assert.equal((await post('/api/pro/editor-links/revoke', { calendarId: id, id: B.id }, { cookie })).status, want, `${who}: revoke`);
    assert.equal((await post('/api/pro/settings', settingsBody, { cookie })).status, want, `${who}: settings`);
    assert.equal((await post('/api/pro/editor-key', { calendarId: id }, { cookie })).status, want, `${who}: editor-key`);
}
assert.equal((await post('/api/pro/settings', { ...settingsBody, editorKey: BKEY }, {})).status, 401, 'a key in the body is not a session');
assert.equal((await post('/api/pro/settings', settingsBody, { cookie: owner.cookie, origin: 'https://evil.example' })).status, 403, 'CSRF: foreign origin');
assert.equal((await post('/api/pro/editor-links', { calendarId: id, label: 'x' }, { cookie: owner.cookie, type: 'text/plain' })).status, 403, 'CSRF: not JSON');
// The socket offers no way in either: unknown messages are refused.
res = await tB.meta({ proSettings: { hideBranding: false } });
assert.equal(res.t, 'ack');
tB.send({ t: 'pro', id: 'p1', settings: { hideBranding: false } });
assert.equal((await tB.waitFor((m) => m.id === 'p1')).code, 'unknown');
assert.equal((await getCal(id)).proSettings.hideBranding, true, 'nothing reached proSettings');
assert.equal((await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie)).body.length, 20, 'no link was revoked');
step('create/list/revoke links, settings and editor-key: 401 without a session (editors have none), 403 for another signed-in user, 403 cross-origin or non-JSON; no socket message reaches proSettings');

// 7. Settings validation: strict, nothing stored on any error.
const bads = [
    { theme: { accent: '#fff' } }, { theme: { accent: 'red' } }, { theme: { accent: '#12345g' } },
    { theme: { font: 'comic-sans' } }, { theme: { embedMode: 'neon' } }, { theme: { embedMode: null } },
    { theme: 'dark' }, { theme: { accent: '#123456', extra: 1 } },
    { branding: { name: 'x'.repeat(61) } }, { branding: { name: 5 } }, { branding: { name: 'a\u0007b' } },
    { branding: { logoUrl: 'http://example.com/logo.png' } }, { branding: { logoUrl: 'javascript:alert(1)' } },
    { branding: { logoUrl: 'data:image/png;base64,AAAA' } }, { branding: { logoUrl: 'https://user:pw@example.com/x.png' } },
    { branding: { logoUrl: 'https://example.com/' + 'x'.repeat(500) } }, { branding: { logoUrl: 'not a url' } },
    { hideBranding: 'yes' }, { pro: true }, { theme: { accent: '#123456' }, locked: false }, [], 'x', null,
];
const before = (await getCal(id)).proSettings;
for (const settings of bads) {
    r = await post('/api/pro/settings', { calendarId: id, settings }, { cookie: owner.cookie });
    const b = await r.json();
    assert.equal(r.status, 400, `accepted ${JSON.stringify(settings)}`); assert.equal(b.error, 'bad-settings'); assert.ok(b.message);
}
assert.deepEqual((await getCal(id)).proSettings, before);
assert.deepEqual(before, { theme: { accent: null, font: null, embedMode: 'auto' }, branding: { name: null, logoUrl: null }, hideBranding: true });
step(`settings validation refuses ${bads.length} bad values (short/odd hex, unknown font/embedMode, unknown keys, long or control-char name, non-https/credentialed/long logo URL, non-boolean hideBranding, non-objects) with 400 bad-settings; defaults stand`);

// 8. Saving settings: stored, in snapshots and GET, broadcast to every open socket (views too), merged as a patch.
const everyone = [ownerTab, tB, anon, otherTab, viewTab, tA];
r = await post('/api/pro/settings', { calendarId: id, settings: { theme: { accent: '#FF6600', font: 'serif', embedMode: 'dark' }, branding: { name: '  Acme Club ', logoUrl: 'https://cdn.example.com/logo.png' } } }, { cookie: owner.cookie });
assert.equal(r.status, 200);
const S1 = { theme: { accent: '#ff6600', font: 'serif', embedMode: 'dark' }, branding: { name: 'Acme Club', logoUrl: 'https://cdn.example.com/logo.png' }, hideBranding: true };
assert.deepEqual(await r.json(), { ok: true, settings: S1 });
for (const t of everyone) assert.deepEqual((await t.waitFor((m) => m.t === 'pro')).settings, S1);
r = await post('/api/pro/settings', { calendarId: id, settings: { hideBranding: false, branding: { logoUrl: null } } }, { cookie: owner.cookie });
const S2 = { ...S1, branding: { name: 'Acme Club', logoUrl: null }, hideBranding: false };
assert.deepEqual((await r.json()).settings, S2, 'a patch: untouched fields stay');
let cal = await getCal(id);
assert.deepEqual(cal.proSettings, S2); assert.equal(cal.calendar.options.theme, undefined, 'never inside options');
assert.deepEqual((await (await fetch(`${BASE}/cal/view/${enc(VIEW)}`)).json()).proSettings, S2);
const late = calTab(id); snap = await late.ready; assert.deepEqual(snap.proSettings, S2);
const lateView = tab(`/cal/view/${enc(VIEW)}/ws`); snap = await lateView.ready; assert.deepEqual(snap.proSettings, S2);
step('owner saves settings (partial patch, normalized): every open socket incl. view links gets {t:pro, settings}; GET /cal, the view and new snapshots carry proSettings at the top level, never in options');

// 9. Editors edit content (events, title, notes, categories) but Pro-ish option keys are stripped, for the owner too.
assert.equal((await tB.save([{ type: 'update', key: 'a', changes: { title: 'edited by Bob' } }])).t, 'ack');
assert.equal((await tB.meta({ title: 'Renamed by editor' })).t, 'ack');
res = await tB.meta({ options: { notes: 'Bring snacks', categories: ['Games'], theme: { accent: '#000000' }, branding: { name: 'Hijack' }, hideBranding: false, proSettings: { hideBranding: true }, ProSettings: 1, editorLinks: [], pro: true } });
assert.equal(res.t, 'ack');
assert.equal((await ownerTab.meta({ options: { theme: 'x', Branding: 'y', HIDEBRANDING: true, color: 'green' } })).t, 'ack');
cal = await getCal(id);
assert.equal(cal.calendar.title, 'Renamed by editor');
assert.equal(cal.calendar.events.find((e) => e.id === 'a').title, 'edited by Bob');
assert.equal(cal.calendar.options.notes, 'Bring snacks'); assert.deepEqual(cal.calendar.options.categories, ['Games']); assert.equal(cal.calendar.options.color, 'green');
for (const k of Object.keys(cal.calendar.options)) assert.ok(!/^(theme|branding|hidebranding|prosettings|editorlinks?|pro)$/i.test(k), `option ${k} got through`);
assert.deepEqual(cal.proSettings, S2, 'proSettings untouched by meta');
res = await anon.meta({ title: 'viewer title' }); assert.equal(res.code, 'locked');
res = await viewTab.meta({ title: 'view title' }); assert.equal(res.code, 'read_only');
assert.equal((await getCal(id)).calendar.title, 'Renamed by editor');
step('an editor saves events, the title and notes/categories; theme/branding/hideBranding/proSettings/editorLinks/pro option keys (any case) are stripped from editor and owner meta alike; viewers stay refused');

// 10. No key material or owner id anywhere public.
const leaks = [];
const secrets = [KEY0, A.url_fragment_key, BKEY, owner.userId, ...[KEY0, BKEY].map((k) => createHash('sha256').update(k).digest('hex'))];
for (const path of [`/cal/${enc(id)}`, `/cal/${enc(id)}/history`, `/cal/view/${enc(VIEW)}`, `/api/pro/status?calendar=${enc(id)}`]) {
    const text = await (await fetch(BASE + path)).text();
    for (const s of secrets) if (text.includes(s)) leaks.push(`${path} leaks`);
}
for (const t of everyone) for (const m of t.got) for (const s of secrets.slice(3)) if (JSON.stringify(m).includes(s)) leaks.push(`ws ${m.t} leaks`);
assert.deepEqual(leaks, []);
step('no key, key hash or owner id in GET /cal, history, the view, /api/pro/status or any socket message');

// 11. The old single-key route: revokes every link, makes one 'Editors' link.
r = await post('/api/pro/editor-key', { calendarId: id }, { cookie: owner.cookie });
assert.equal(r.status, 200);
const NEWKEY = (await r.json()).editorKey; assert.match(NEWKEY, /^[A-Za-z0-9_-]{22}$/);
res = await tB.waitFor((m) => m.t === 'auth' && m.reason === 'key-rotated');
assert.deepEqual([res.ok, res.canEdit], [false, false]);
assert.equal((await tB.save([{ type: 'add', event: ev('x', 'stale', 5) }])).code, 'locked');
list = await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie);
assert.deepEqual(list.body.map((l) => l.label), ['Editors']);
assert.equal((await fresh.authKey(BKEY)).ok, false);
assert.equal((await fresh.authKey(NEWKEY)).ok, true);
assert.equal((await fresh.save([{ type: 'add', event: ev('nk', 'new key', 5) }])).t, 'ack');
assert.equal((await ownerTab.save([{ type: 'add', event: ev('ow', 'owner', 5) }])).t, 'ack');
step('POST /api/pro/editor-key still returns {editorKey}: all links revoked (sockets told key-rotated), one new \'Editors\' link that works; the owner is unaffected');

// 12. Migration: a lock holding the legacy single key becomes one 'Editors' link with the same id.
const legacy = await admin(id, 'dev-legacy-key', { ownerId: owner.userId });
assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
list = await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie);
assert.deepEqual(list.body.map((l) => [l.id, l.label]), [[legacy.body.keyId, 'Editors']]);
const lt = calTab(id); await lt.ready;
assert.equal((await lt.authKey(legacy.body.editorKey)).ok, true);
assert.equal((await lt.save([{ type: 'add', event: ev('lg', 'legacy key', 6) }])).t, 'ack');
assert.equal((await lt.authKey(NEWKEY)).ok, false, 'links that predate the reset are gone');
step('legacy lock row (key_hash/key_id) migrates on load to one live \'Editors\' link keeping the old key id; its key works');

// 13. Unlock: settings hidden (kept for the same owner), routes 409; re-lock restores them.
assert.equal((await admin(id, 'unlock', { ownerId: owner.userId })).body.ok, true);
snap = await anon.waitFor((m) => m.t === 'snapshot' && m.locked === false);
assert.deepEqual([snap.proSettings, snap.role, snap.canEdit], [null, 'editor', true]);
assert.equal((await getCal(id)).proSettings, null);
assert.equal((await post('/api/pro/settings', settingsBody, { cookie: owner.cookie })).status, 409);
assert.equal((await mk('After unlock')).status, 409);
assert.equal((await anon.meta({ options: { theme: { accent: '#000000' }, color: 'blue' } })).t, 'ack');
assert.equal((await getCal(id)).calendar.options.theme, undefined, 'unlocked calendars cannot smuggle theme into options either');
const relock = await admin(id, 'lock', { ownerId: owner.userId });
assert.ok(relock.body.editorKey);
assert.deepEqual((await getCal(id)).proSettings, S2, 'same owner: settings come back');
list = await getJ(`/api/pro/editor-links?calendar=${enc(id)}`, owner.cookie);
assert.equal(list.body.length, 1, 'a re-lock starts with one fresh link');
assert.equal((await lt.save([{ type: 'add', event: ev('st', 'stale socket', 7) }])).code, 'locked');
await admin(id, 'unlock', {});
step('unlock: proSettings null, owner routes 409, everyone edits again; a re-lock by the same owner restores the settings and starts with one fresh link; sockets keyed before stay read-only');

for (const t of [tA, tB, ownerTab, otherTab, anon, viewTab, fresh, late, lateView, lt]) t.ws.close();
console.log(`\n${n} checks passed`); process.exit(0);
