// RED TEAM #3 -- Stats inflation + privacy.
// Owner-facing stats (views / visitors / followers) must resist cheap inflation and must store no
// IP / User-Agent / referrer. Verifies: (a) X-Forwarded-For is ignored (only CF-Connecting-IP is
// trusted as the network); (b) rotating User-Agents on one IP collapses to <=3 visitors; (c) a
// reload loop from one visitor is deduped within the view gap; (d) a bot UA is not counted and a
// client-supplied X-PC-Hit is stripped; (e) the stats store holds no IP/UA/referrer (stats-dump,
// dev mode). Requires ACCOUNTS_DEV_MODE=1 for the stats-dump admin route.
import { BASE, enc, auth, create, uid, sleep, step, finding, done, assert } from './_h.mjs';

const UA_HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// A GET that counts as a human "view": a realistic UA, a spoofable IP + XFF.
const visit = (id, { ip = '203.0.113.7', ua = UA_HUMAN, xff, hit } = {}) =>
    fetch(`${BASE}/cal/${enc(id)}`, { headers: { 'CF-Connecting-IP': ip, 'User-Agent': ua, ...(xff ? { 'X-Forwarded-For': xff } : {}), ...(hit ? { 'X-PC-Hit': hit } : {}) } });
const followVisit = (id, { ip = '203.0.113.7', ua = UA_HUMAN } = {}) =>
    fetch(`${BASE}/${enc(id)}.ics`, { headers: { 'CF-Connecting-IP': ip, 'User-Agent': ua } });
const dump = async (id) => (await fetch(`${BASE}/api/admin/cal/${enc(id)}/stats-dump`, { headers: auth })).json();
const today = () => new Date().toISOString().slice(0, 10);
const counts = (d) => { const row = (d.daily || []).find((r) => r.day === today()) || {}; return { views: row.views || 0, visitors: row.visitors || 0, followers: row.followers || 0 }; };

// Confirm the dump route is available (dev mode). If not, we cannot verify privacy -> loud finding.
const probe = await fetch(`${BASE}/api/admin/cal/x/stats-dump`, { headers: auth });
assert.ok(probe.status === 200, `stats-dump must be reachable in dev mode (got ${probe.status}); run the server with ACCOUNTS_DEV_MODE:1`);
step('stats-dump admin route available (dev mode)');

// ---- (b) Rotating User-Agents on ONE IP collapses to <=3 visitors ------------------------------
{
    const id = uid('stats-ua');
    assert.equal((await create(id, { title: 's', events: [] })).status, 201);
    await sleep(100); const before = counts(await dump(id));
    for (let i = 0; i < 12; i++) { await visit(id, { ip: '198.51.100.9', ua: `Mozilla/5.0 Variant-${i} Chrome/14${i}.0` }); await sleep(20); }
    await sleep(200); const after = counts(await dump(id));
    const dv = after.visitors - before.visitors;
    assert.ok(dv <= 3, `12 UAs on one /24 should be <=3 visitors; got +${dv}`);
    step(`rotating 12 User-Agents on one IP added ${dv} visitor(s) (<=3, the 4th-UA collapse holds)`);
}

// ---- (a) X-Forwarded-For is ignored: only CF-Connecting-IP is the network ----------------------
{
    const id = uid('stats-xff');
    assert.equal((await create(id, { title: 's', events: [] })).status, 201);
    await sleep(100); const before = counts(await dump(id));
    // Same CF-Connecting-IP + UA, 10 different X-Forwarded-For: within the view gap this is ONE visit.
    for (let i = 0; i < 10; i++) { await visit(id, { ip: '192.0.2.50', ua: UA_HUMAN, xff: `10.0.0.${i}` }); await sleep(15); }
    await sleep(200); const after = counts(await dump(id));
    const dvis = after.visitors - before.visitors, dviews = after.views - before.views;
    assert.ok(dvis <= 1, `X-Forwarded-For must not create visitors; got +${dvis}`);
    assert.ok(dviews <= 1, `X-Forwarded-For + reloads within the gap must not add views; got +${dviews}`);
    step(`10 requests (same IP, 10 different X-Forwarded-For) added ${dvis} visitor / ${dviews} view (XFF ignored, gap-deduped)`);
}

// ---- (c) Reload loop from one visitor is deduped within the view gap ---------------------------
{
    const id = uid('stats-reload');
    assert.equal((await create(id, { title: 's', events: [] })).status, 201);
    await sleep(100); const before = counts(await dump(id));
    for (let i = 0; i < 60; i++) await visit(id, { ip: '203.0.113.200', ua: UA_HUMAN });
    await sleep(250); const after = counts(await dump(id));
    const dviews = after.views - before.views;
    assert.ok(dviews <= 1, `60 reloads from one visitor within the gap should add <=1 view; got +${dviews}`);
    step(`a 60-request reload loop from one visitor added ${dviews} view (gap dedup holds)`);
}

// ---- (d) A bot UA is not counted; a client X-PC-Hit is stripped --------------------------------
{
    const id = uid('stats-bot');
    assert.equal((await create(id, { title: 's', events: [] })).status, 201);
    await sleep(100); const before = counts(await dump(id));
    for (const ua of ['curl/8.4.0', 'python-requests/2.31', 'Mozilla/5.0 (compatible; SomeBot/1.0; +http://x)', 'Go-http-client/2.0']) {
        await visit(id, { ip: `10.8.0.${Math.floor(Math.random() * 250)}`, ua });
    }
    // A human-looking client that tries to FORGE a follow hit on the data endpoint.
    await visit(id, { ip: '172.16.9.9', ua: UA_HUMAN, hit: 'follow' });
    await sleep(250); const after = counts(await dump(id));
    assert.equal(after.followers - before.followers, 0, 'a forged X-PC-Hit:follow on /cal/<id> must not add a follower');
    assert.ok(after.views - before.views <= 1, 'bot UAs are not counted as views');
    step(`bot UAs added no counted views; a forged X-PC-Hit:follow added 0 followers (header stripped)`);
}

// ---- (e) Privacy: the stats store holds no IP / UA / referrer -----------------------------------
{
    const id = uid('stats-priv');
    assert.equal((await create(id, { title: 's', events: [] })).status, 201);
    const SECRET_IP = '66.66.66.66', SECRET_UA = 'SuperSecretAgent/9.9-UAMARKER';
    await visit(id, { ip: SECRET_IP, ua: SECRET_UA });
    await followVisit(id, { ip: SECRET_IP, ua: 'Google-Calendar-Importer-UAMARKER' });
    await sleep(250);
    const d = await dump(id);
    const blob = JSON.stringify(d);
    assert.ok(!blob.includes(SECRET_IP), 'the stats store must not contain the raw IP');
    assert.ok(!blob.includes('UAMARKER'), 'the stats store must not contain the User-Agent');
    assert.ok(!blob.includes('66.66.66'), 'the stats store must not contain even the IP /24');
    // seen rows should be (kind, hash, last_at) only -- a salted hash, nothing reversible.
    for (const row of d.seen || []) {
        assert.deepEqual(Object.keys(row).sort(), ['hash', 'kind', 'last_at'], 'a seen row exposes only kind/hash/last_at');
        assert.ok(/^[0-9a-f]+$/.test(row.hash), 'the stored visitor hash is a hex digest');
    }
    step(`stats store holds only salted hashes: no IP, no /24, no User-Agent (${(d.seen || []).length} seen rows)`);
}

done('stats-abuse');
