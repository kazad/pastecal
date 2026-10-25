// RED TEAM #5 -- Accounts, sessions, CSRF, magic links, webhook.
// Requires the server in dev mode with Stripe webhook secret set (see _h.mjs header). Uses the pure
// signStripe() from ../fake-stripe.mjs; webhook checks use an innocuous event type so no Stripe
// network call is made. Covers: CSRF origin/content-type gating, magic-link single-use + expiry,
// email enumeration (identical responses), session fixation (attacker-chosen cookie rejected;
// signout-all), account-delete-while-subscribed, and webhook bad-signature + replay.
import { signStripe } from '../fake-stripe.mjs';
import { BASE, SECRET, auth, uid, sleep, step, finding, done, assert } from './_h.mjs';

const WHSEC = 'fake-webhook-secret';
const run = Date.now().toString(36);
let ipN = 0;
const ORIGIN = 'http://localhost:8910';
// A same-site JSON POST (the only shape the app ever makes), fresh IP each time to dodge the limiter.
const post = (path, body, { origin = ORIGIN, ct = 'application/json', cookie } = {}) =>
    fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': ct, Origin: origin, 'CF-Connecting-IP': `10.90.0.${++ipN % 250}`, ...(cookie ? { Cookie: cookie } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const adminGet = (path) => fetch(BASE + path, { headers: auth });
const outbox = async (email) => (await (await adminGet(`/api/admin/accounts/outbox?email=${encodeURIComponent(email)}`)).json()).emails || [];
async function signIn(email) {
    await post('/api/auth/start', { email });
    const mails = await outbox(email);
    const token = mails.at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    const r = await post('/api/auth/verify', { token });
    assert.equal(r.status, 200, 'sign-in verify');
    return r.headers.get('set-cookie').split(';')[0];   // pc_session=...
}

// ---- 5a. CSRF: cookie POSTs need JSON + an allowed Origin --------------------------------------
{
    const email = `csrf-${run}@example.com`;
    for (const [what, opts] of [
        ['cross-site Origin', { origin: 'https://evil.example' }],
        ['null Origin', { origin: 'null' }],
        ['form content-type', { ct: 'application/x-www-form-urlencoded' }],
        ['text/plain content-type', { ct: 'text/plain' }],
    ]) {
        const r = await post('/api/auth/start', { email }, opts);
        assert.equal(r.status, 403, `${what} must be 403 forbidden-origin; got ${r.status}`);
        assert.equal((await r.json()).error, 'forbidden-origin');
    }
    // The honest same-site JSON POST is accepted.
    assert.equal((await post('/api/auth/start', { email })).status, 200);
    step('CSRF gate: cross-site/null Origin and non-JSON content-types are 403; same-site JSON is accepted');
}

// ---- 5b. Email enumeration: identical response for known vs unknown ----------------------------
{
    const known = `known-${run}@example.com`;
    await signIn(known);                                   // now a real account
    const unknown = `nobody-${run}-${Math.random().toString(36).slice(2)}@example.com`;
    const rk = await post('/api/auth/start', { email: known });
    const ru = await post('/api/auth/start', { email: unknown });
    assert.equal(rk.status, ru.status, 'same status for known/unknown');
    assert.deepEqual(await rk.json(), await ru.json(), 'identical body for known/unknown (no enumeration)');
    // peek: a made-up token answers the same as an expired/used one.
    const madeUp = await post('/api/auth/peek', { token: 'AAAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(madeUp.status, 400);
    assert.match((await madeUp.json()).error, /expired or was already used/);
    step('email enumeration: /api/auth/start returns identical {ok:true} for known & unknown; peek reveals nothing');
}

// ---- 5c. Magic link is single-use and expires -------------------------------------------------
{
    const email = `once-${run}@example.com`;
    await post('/api/auth/start', { email });
    const token = (await outbox(email)).at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    const first = await post('/api/auth/verify', { token });
    assert.equal(first.status, 200, 'first verify signs in');
    assert.match(first.headers.get('set-cookie') || '', /pc_session=/);
    const second = await post('/api/auth/verify', { token });
    assert.equal(second.status, 400, 'the same link cannot be used twice');
    // Expiry: a fresh link, aged past its 15-min TTL, is refused.
    const e2 = `expire-${run}@example.com`;
    await post('/api/auth/start', { email: e2 });
    const tok2 = (await outbox(e2)).at(-1).text.match(/#t=([A-Za-z0-9_-]+)/)[1];
    await fetch(BASE + '/api/admin/accounts/expire-tokens', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e2 }) });
    assert.equal((await post('/api/auth/verify', { token: tok2 })).status, 400, 'an expired link is refused');
    step('magic link: single-use (2nd verify 400) and expires (expired link 400)');
}

// ---- 5d. Session fixation: attacker-chosen cookie is not a session; signout-all kills sessions --
{
    // A random, well-formed-but-unknown token is not a valid session.
    const forged = 'ZmFrZXNlc3Npb250b2tlbg';   // 22-char base64url, never issued
    assert.equal((await fetch(BASE + '/api/me', { headers: { Cookie: `pc_session=${forged}` } })).status, 401, 'an attacker-chosen session cookie is rejected');
    const email = `fix-${run}@example.com`;
    const cookie = await signIn(email);
    assert.notEqual(cookie.split('=')[1], forged, 'verify issues a server-generated token, not one the client supplied');
    assert.equal((await fetch(BASE + '/api/me', { headers: { Cookie: cookie } })).status, 200, 'the real session works');
    // signout-all ends every session for the user.
    const so = await post('/api/auth/signout-all', {}, { cookie });
    assert.equal(so.status, 200);
    assert.equal((await fetch(BASE + '/api/me', { headers: { Cookie: cookie } })).status, 401, 'session dead after signout-all');
    step('session fixation: forged cookie rejected, verify mints a fresh token, signout-all ends sessions');
}

// ---- 5e. Account delete is refused while a subscription is active ------------------------------
{
    const email = `del-${run}@example.com`;
    const cookie = await signIn(email);
    const calId = `test-rt-delcal-${run}`;
    // dev-subscription: an active subscription row for this owner (no Stripe, no lock change).
    const mk = (status) => fetch(BASE + '/api/admin/accounts/dev-subscription', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, calendarId: calId, status }) });
    assert.equal((await mk('active')).status, 200);
    const refused = await post('/api/account/delete', {}, { cookie });
    assert.equal(refused.status, 409, 'delete refused while subscribed');
    assert.equal((await refused.json()).error, 'active-subscription');
    // Once canceled, delete proceeds.
    assert.equal((await mk('canceled')).status, 200);
    const okDel = await post('/api/account/delete', {}, { cookie });
    assert.equal(okDel.status, 200, 'delete allowed once no active subscription');
    assert.equal((await fetch(BASE + '/api/me', { headers: { Cookie: cookie } })).status, 401, 'session gone after delete');
    step('account delete: 409 active-subscription while subscribed; succeeds after cancel; session ends');
}

// ---- 5f. Webhook: bad signature rejected; a replayed event id is a no-op -----------------------
{
    const body = JSON.stringify({ id: `evt_${run}_rt1`, object: 'event', type: 'customer.created', livemode: false, data: { object: { id: 'cus_x' } } });
    // Bad signature -> 400, no processing.
    const bad = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=deadbeef' }, body });
    assert.equal(bad.status, 400, `bad signature -> ${bad.status}`);
    assert.equal((await bad.json()).error, 'invalid-signature');
    // No signature header at all -> 400.
    const none = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(none.status, 400, 'missing signature -> 400');
    // Valid signature, innocuous event -> received; replay of the SAME id -> duplicate.
    const sig = signStripe(WHSEC, body);
    const r1 = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body });
    const j1 = await r1.json();
    assert.equal(r1.status, 200, `valid webhook -> ${r1.status} ${JSON.stringify(j1)}`);
    const r2 = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(WHSEC, body) }, body });
    const j2 = await r2.json();
    assert.equal(j2.duplicate, true, `replayed event id must be a no-op (duplicate); got ${JSON.stringify(j2)}`);
    // An old timestamp (stale signature) is rejected by the tolerance window.
    const old = signStripe(WHSEC, body, Math.floor(Date.now() / 1000) - 3600);
    const stale = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': old }, body });
    assert.equal(stale.status, 400, `a stale (1h old) signature is rejected; got ${stale.status}`);
    step('webhook: bad/missing signature 400, stale timestamp 400, valid processed once, replay = duplicate no-op');
}

done('accounts');
