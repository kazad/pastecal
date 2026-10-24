// Test inbox (TestInbox.js): mail routed to test@ / test-signin@ / test-welcome@ / test-weekly@pastecal.com
// is stored for admin reads; anything else is rejected. Mail goes in through wrangler dev's local email
// trigger, POST /cdn-cgi/handler/email?from=&to= with a raw RFC 822 body (it needs Message-ID and Date).
// Setup: the BASE instance from accounts.test.mjs (IMPORT_SECRET=dev-secret, ACCOUNTS_DEV_MODE=1), on its
// own --persist-to (this test clears the whole inbox). Then: node test/test-inbox.test.mjs
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8822', SECRET = process.env.IMPORT_SECRET || 'dev-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
let mid = 0;

const admin = (path, init = {}) => fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
const inbox = async (q = '') => { const r = await admin('/api/admin/test-inbox' + q); assert.equal(r.status, 200); return r.json(); };
const eml = (headers, body) => [`Message-ID: <t${++mid}-${Date.now()}@example.com>`, 'Date: Thu, 23 Oct 2026 10:00:00 +0000',
    ...headers, '', body].join('\r\n');
const deliver = (to, raw, from = 'sender@example.com') => fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: 'POST', body: raw });
const AR = 'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=pastecal.com header.s=cf-bounce; spf=pass smtp.mailfrom=cf-bounce.pastecal.com; dmarc=pass header.from=pastecal.com';

// Admin auth.
assert.equal((await fetch(BASE + '/api/admin/test-inbox')).status, 403);
assert.equal((await fetch(BASE + '/api/admin/test-inbox', { headers: { Authorization: 'Bearer wrong' } })).status, 403);
assert.equal((await fetch(BASE + '/api/admin/test-inbox', { method: 'DELETE' })).status, 403);
assert.equal((await fetch(BASE + '/api/admin/test-inbox/dev-seed', { method: 'POST', body: '{}' })).status, 403);
assert.equal((await admin('/api/admin/test-inbox?to=support@pastecal.com')).status, 400);
assert.equal((await admin('/api/admin/test-inbox', { method: 'DELETE' })).status, 200);
assert.deepEqual(await inbox(), []);
step('admin routes need the Bearer secret; a non-test address is a 400; DELETE without to clears everything');

// Accept and reject.
let r = await deliver('test@pastecal.com', eml(['From: Sender <sender@example.com>', 'To: test@pastecal.com', 'Subject: Plain one', AR,
    'Content-Type: text/plain; charset=utf-8'], 'Hello from a plain message.\r\n'));
assert.equal(r.status, 200, await r.text());
r = await deliver('TEST-SIGNIN@PastEcal.com', eml(['From: login@pastecal.com', 'To: TEST-SIGNIN@PastEcal.com', 'Subject: Upper', 'Content-Type: text/plain'], 'x'));
assert.equal(r.status, 200, 'addresses are case-insensitive');
for (const to of ['support@pastecal.com', 'test-other@pastecal.com', 'test@example.com', 'xtest@pastecal.com', 'test-@pastecal.com']) {
    r = await deliver(to, eml(['From: a@example.com', `To: ${to}`, 'Subject: no', 'Content-Type: text/plain'], 'no'));
    assert.equal(r.status, 400, to); assert.match(await r.text(), /unknown address/, to);
}
let all = await inbox();
assert.equal(all.length, 2, 'rejected mail is not stored');
assert.deepEqual(all.map((m) => m.to), ['test-signin@pastecal.com', 'test@pastecal.com'], 'newest first, lowercased');
const plain = all[1];
assert.equal(plain.from, 'sender@example.com'); assert.equal(plain.subject, 'Plain one'); assert.equal(plain.text, 'Hello from a plain message.');
assert.match(plain.receivedAt, /^\d{4}-\d\d-\d\dT/); assert.ok(Number.isInteger(plain.id));
assert.deepEqual(plain.auth, { spf: 'pass', dkim: 'pass', dmarc: 'pass' });
assert.equal(plain.headers.dkimSignature, false); assert.equal(plain.headers.arcAuthenticationResults, false);
assert.match(plain.headers.authenticationResults, /^mx\.cloudflare\.net; dkim=pass/);
assert.deepEqual(all[0].auth, { spf: null, dkim: null, dmarc: null }, 'no Authentication-Results: nulls');
step('accepts test@ and test-signin@ (any case), rejects every other address with "unknown address" and stores nothing for them');

// multipart/alternative: quoted-printable text/plain wins over html; encoded-word subject.
r = await deliver('test-welcome@pastecal.com', eml(['From: login@pastecal.com', 'To: test-welcome@pastecal.com',
    `Subject: =?utf-8?B?${Buffer.from('Pro is on for Team NUÑEZ').toString('base64')}?= =?utf-8?Q?_caf=C3=A9?=`,
    'Authentication-Results: mx.cloudflare.net;\r\n dkim=fail header.d=pastecal.com;\r\n spf=softfail smtp.mailfrom=x;\r\n dmarc=fail header.from=pastecal.com',
    'DKIM-Signature: v=1; a=rsa-sha256; d=pastecal.com; s=cf-bounce; b=abc',
    'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"'],
    ['--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
        'Caf=C3=A9 line that is long enough to be soft-wrapped by the encoder so it conti=', 'nues here.', '',
        '--b1', 'Content-Type: text/html; charset=utf-8', '', '<p>HTML version</p>', '--b1--', ''].join('\r\n')));
assert.equal(r.status, 200);
let m = (await inbox('?to=test-welcome@pastecal.com'))[0];
assert.equal(m.text, 'Café line that is long enough to be soft-wrapped by the encoder so it continues here.');
assert.equal(m.subject, 'Pro is on for Team NUÑEZ café');
assert.deepEqual(m.auth, { spf: 'softfail', dkim: 'fail', dmarc: 'fail' }, 'folded header, failing verdicts');
assert.equal(m.headers.dkimSignature, true);
step('multipart/alternative: the quoted-printable text/plain part is used; RFC 2047 subjects decode; folded Authentication-Results parse (fail/softfail)');

// html only (base64), nested in multipart/mixed with an attachment; ARC fallback for the verdicts.
const html = '<html><head><style>p{color:red}</style></head><body><p>Here is your link:</p><p><a href="https://pastecal.com/signin#t=AAAAAAAAAAAAAAAAAAAAAA">Sign in</a></p><p>Tom &amp; Jerry&nbsp;&lt;3</p></body></html>';
r = await deliver('test-weekly@pastecal.com', eml(['From: login@pastecal.com', 'To: test-weekly@pastecal.com', 'Subject: Weekly',
    'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=pastecal.com; spf=none; dmarc=pass',
    'Content-Type: multipart/mixed; boundary=outer'],
    ['--outer', 'Content-Type: multipart/alternative; boundary=inner', '',
        '--inner', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
        ...Buffer.from(html).toString('base64').match(/.{1,76}/g), '--inner--', '',
        '--outer', 'Content-Type: text/plain; name=a.txt', 'Content-Disposition: attachment; filename=a.txt', '', 'attachment text, not the body', '--outer--', ''].join('\r\n')));
assert.equal(r.status, 200);
m = (await inbox('?to=test-weekly@pastecal.com'))[0];
assert.equal(m.text, 'Here is your link:\nSign in (https://pastecal.com/signin#t=[token:22])\nTom & Jerry <3', 'the sign-in token is redacted');
assert.ok(!JSON.stringify(m).includes('AAAAAAAAAAAAAAAAAAAAAA'), 'the raw token is stored nowhere');
assert.deepEqual(m.auth, { spf: 'none', dkim: 'pass', dmarc: 'pass' }, 'from ARC-Authentication-Results when there is no Authentication-Results');
assert.equal(m.headers.arcAuthenticationResults, true); assert.equal(m.headers.authenticationResults, null);
step('html-only (base64, nested multipart/mixed): tags and styles stripped, links kept (token redacted to [token:22]), entities decoded; attachments ignored; ARC verdicts as fallback');

// Over 200 KB: stored, truncated.
r = await deliver('test@pastecal.com', eml(['From: a@example.com', 'To: test@pastecal.com', 'Subject: Big', 'Content-Type: text/plain'], 'y'.repeat(300 * 1024)));
assert.equal(r.status, 200);
m = (await inbox('?to=test@pastecal.com&limit=1'))[0];
assert.equal(m.subject, 'Big'); assert.equal(m.truncated, true); assert.ok(m.text.length < 200 * 1024 && m.text.length > 90 * 1024, String(m.text.length));
step('a message over 200 KB is read up to the cap, stored, and marked truncated');

// limit, filtering, delete by address.
assert.equal((await inbox('?limit=2')).length, 2);
assert.equal((await inbox('?limit=0')).length, 1, 'limit is clamped to at least 1');
assert.equal((await inbox('?to=test@pastecal.com')).length, 2);
r = await admin('/api/admin/test-inbox?to=test@pastecal.com', { method: 'DELETE' });
assert.deepEqual(await r.json(), { ok: true, deleted: 2 });
assert.equal((await inbox('?to=test@pastecal.com')).length, 0);
assert.equal((await inbox()).length, 3, 'other addresses untouched');
step('?limit= is clamped to 1..100; ?to= filters; DELETE ?to= clears only that address');

// Retention: 7 days, 500 messages.
const seed = (body) => admin('/api/admin/test-inbox/dev-seed', { method: 'POST', body: JSON.stringify(body) });
r = await seed({ to: 'test@pastecal.com', count: 5, ageMs: 8 * 24 * 3600e3 });
assert.equal(r.status, 200); assert.equal((await r.json()).total, 3, 'seeded mail 8 days old is pruned as it goes in');
r = await seed({ to: 'test@pastecal.com', count: 510 });
assert.equal((await r.json()).total, 500);
const kept = await inbox('?limit=100');
assert.equal(kept.length, 100); assert.equal(kept[0].subject, 'seed 509', 'the newest are kept');
assert.equal((await inbox('?to=test-weekly@pastecal.com')).length, 0, 'the oldest went first');
r = await deliver('test@pastecal.com', eml(['From: a@example.com', 'To: test@pastecal.com', 'Subject: After cap', 'Content-Type: text/plain'], 'z'));
assert.equal(r.status, 200);
assert.equal((await inbox('?limit=1'))[0].subject, 'After cap');
assert.equal((await (await seed({ to: 'test@pastecal.com', count: 1 })).json()).total, 500);
step('retention: older than 7 days is pruned on insert, and only the newest 500 messages are kept');

await admin('/api/admin/test-inbox', { method: 'DELETE' });
console.log(`\n${n} checks passed`); process.exit(0);
