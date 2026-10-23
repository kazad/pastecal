/**
 * Accounts -- Pro owners' sign-in (magic link) and their Stripe subscriptions, in one global
 * Durable Object's SQLite. Only a calendar's paying owner ever has an account; helpers never do.
 *
 *   POST /api/auth/start      {email, next?}     -> {ok:true} always (never says if the email is known)
 *   POST /api/auth/verify     {token}            -> {ok, email, next} + Set-Cookie pc_session (30 days)
 *   POST /api/auth/signout                       -> {ok:true}, cookie cleared
 *   GET  /api/me                                 -> {email, calendars:[{id, status, plan, interval, currentPeriodEnd}]} | 401
 *   POST /api/pro/checkout    {calendarId, interval?:'year'|'month', editName?} -> {url} (Stripe Checkout)
 *   POST /api/pro/portal      {calendarId?}      -> {url} (Stripe Billing Portal)
 *   POST /api/pro/editor-key  {calendarId}       -> {editorKey}, shown once (owner only)
 *   GET  /api/pro/status?calendar=<id>           -> {locked, pro, isOwner}
 *   POST /api/stripe/webhook                     Stripe events (signed), see handleWebhook
 *   POST /api/admin/accounts/reassign {calendarId, email}   (Bearer IMPORT_SECRET; lost access, disputes)
 *   GET  /api/admin/accounts/lookup?email=                  (same)
 *
 * Tokens (sign-in links, sessions) are 128-bit random, base64url; only their SHA-256 is stored.
 * Cookie-authenticated POSTs need Content-Type: application/json and an Origin of pastecal.com.
 *
 * ACCOUNTS_DEV_MODE=1 (only ever in .dev.vars or --var, never in wrangler.jsonc) is for local tests:
 * it allows http://localhost origins, writes sign-in emails to an outbox instead of sending them,
 * lets STRIPE_API_BASE / LOCK_API_BASE point at local fakes, and opens three admin test hooks:
 *   GET  /api/admin/accounts/outbox?email=, POST /api/admin/accounts/expire-tokens {email},
 *   POST /api/admin/accounts/dev-subscription {email, calendarId, status?, interval?, currentPeriodEnd?}
 *        (a subscription row without Stripe, so /api/me lists the calendar; no lock is changed).
 */
import { DurableObject } from 'cloudflare:workers';
import { LockClient } from './LockClient.js';
import { INTERVALS, stripeConfig, stripeRequest, verifyStripeSignature, summarizeSubscription, subscriptionIdOf, timingSafeEqual } from './Stripe.js';

const SITE = 'https://pastecal.com';
const LOGIN_TTL = 15 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const LOGINS_PER_EMAIL_PER_HOUR = 5;
const ACTIVE = new Set(['active', 'trialing', 'past_due']);
const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);
const SUBSCRIPTION_EVENTS = new Set(['checkout.session.completed', 'customer.subscription.created',
    'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed']);

// Same rule as index.js: any name Firebase allowed.
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);
const validEmail = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function randomToken() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const looksLikeToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{22}$/.test(t);

export class Accounts extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER);
            CREATE TABLE IF NOT EXISTS login_tokens (hash TEXT PRIMARY KEY, email TEXT, next TEXT,
                created_at INTEGER, expires_at INTEGER, used INTEGER DEFAULT 0);
            CREATE INDEX IF NOT EXISTS login_tokens_email ON login_tokens(email);
            CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER, expires_at INTEGER);
            CREATE TABLE IF NOT EXISTS subscriptions (stripe_subscription_id TEXT PRIMARY KEY, user_id TEXT,
                stripe_customer_id TEXT, calendar_id TEXT, plan TEXT, interval TEXT, price_id TEXT, status TEXT,
                current_period_end INTEGER, updated_at INTEGER);
            CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id);
            CREATE INDEX IF NOT EXISTS subscriptions_calendar ON subscriptions(calendar_id);
            CREATE TABLE IF NOT EXISTS processed_events (event_id TEXT PRIMARY KEY, at INTEGER);
            CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT, subject TEXT, text TEXT, at INTEGER);
            CREATE TABLE IF NOT EXISTS checkout_holds (calendar_id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);`);
    }

    // A new sign-in link for this email, or null past the per-email limit (the caller still says ok).
    async issueLoginToken(email, next) {
        const now = Date.now();
        this.sql.exec(`DELETE FROM login_tokens WHERE expires_at < ?`, now - 24 * 3600 * 1000);
        this.sql.exec(`DELETE FROM sessions WHERE expires_at < ?`, now);
        const recent = this.sql.exec(`SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?`, email, now - 3600 * 1000).one().n;
        if (recent >= LOGINS_PER_EMAIL_PER_HOUR) return null;
        const token = randomToken();
        this.sql.exec(`INSERT INTO login_tokens (hash, email, next, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
            await sha256(token), email, next || null, now, now + LOGIN_TTL);
        return token;
    }

    // Uses up a sign-in link: the user (created on first sign-in) and a new session token.
    async consumeLoginToken(token) {
        const now = Date.now(), hash = await sha256(token);
        const row = this.sql.exec(`SELECT * FROM login_tokens WHERE hash = ?`, hash).toArray()[0];
        if (!row || !timingSafeEqual(row.hash, hash) || row.used || row.expires_at <= now) return null;
        this.sql.exec(`UPDATE login_tokens SET used = 1 WHERE hash = ?`, hash);
        const userId = this.ensureUser(row.email);
        const session = randomToken();
        this.sql.exec(`INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, await sha256(session), userId, now, now + SESSION_TTL);
        return { session, email: row.email, next: row.next };
    }

    async sessionUser(token) {
        const hash = await sha256(token);
        const row = this.sql.exec(`SELECT s.hash, s.user_id, s.expires_at, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?`, hash).toArray()[0];
        if (!row || !timingSafeEqual(row.hash, hash) || row.expires_at <= Date.now()) return null;
        return { userId: row.user_id, email: row.email };
    }

    async endSession(token) { this.sql.exec(`DELETE FROM sessions WHERE hash = ?`, await sha256(token)); }

    ensureUser(email) {
        const row = this.sql.exec(`SELECT id FROM users WHERE email = ?`, email).toArray()[0];
        if (row) return row.id;
        const id = 'u_' + randomToken();
        this.sql.exec(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`, id, email, Date.now());
        return id;
    }
    getUser(userId) { return this.sql.exec(`SELECT * FROM users WHERE id = ?`, userId).toArray()[0] || null; }
    findUser(email) { return this.sql.exec(`SELECT * FROM users WHERE email = ?`, email).toArray()[0] || null; }

    me(userId) {
        const user = this.getUser(userId);
        if (!user) return null;
        const rows = this.sql.exec(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC`, userId).toArray();
        const byCal = new Map();     // one entry per calendar: an active subscription wins over old ones
        for (const r of rows) {
            const have = byCal.get(r.calendar_id);
            if (!have || (!ACTIVE.has(have.status) && ACTIVE.has(r.status))) byCal.set(r.calendar_id, r);
        }
        return {
            email: user.email,
            calendars: [...byCal.values()].map((r) => ({ id: r.calendar_id, status: r.status, plan: r.plan, interval: r.interval, priceId: r.price_id, currentPeriodEnd: r.current_period_end })),
        };
    }

    getSubscription(id) { return this.sql.exec(`SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`, id).toArray()[0] || null; }
    upsertSubscription(s) {
        this.sql.exec(`INSERT INTO subscriptions (stripe_subscription_id, user_id, stripe_customer_id, calendar_id, plan, interval, price_id, status, current_period_end, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(stripe_subscription_id) DO UPDATE SET user_id = excluded.user_id, stripe_customer_id = excluded.stripe_customer_id,
                calendar_id = excluded.calendar_id, plan = excluded.plan, interval = excluded.interval, price_id = excluded.price_id,
                status = excluded.status, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`,
            s.id, s.userId, s.customer || null, s.calendarId, 'pro', s.interval || null, s.priceId || null, s.status, s.currentPeriodEnd || null, Date.now());
    }
    otherActiveSubscription(calendarId, exceptId) {
        const rows = this.sql.exec(`SELECT status FROM subscriptions WHERE calendar_id = ? AND stripe_subscription_id != ?`, calendarId, exceptId).toArray();
        return rows.some((r) => ACTIVE.has(r.status));
    }
    customerForUser(userId) {
        const row = this.sql.exec(`SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, userId).toArray()[0];
        return row ? row.stripe_customer_id : null;
    }
    // One buyer at a time per calendar: a hold lasts as long as the Stripe Checkout page it guards
    // (both CHECKOUT_HOLD_MS), so a second person can't pay for a calendar someone is already buying
    // and end up charged without the lock. The same user may restart their own checkout.
    holdCheckout(calendarId, userId, ms) {
        const now = Date.now();
        const row = this.sql.exec(`SELECT user_id, expires_at FROM checkout_holds WHERE calendar_id = ?`, calendarId).toArray()[0];
        if (row && row.user_id !== userId && row.expires_at > now) return false;
        this.sql.exec(`INSERT OR REPLACE INTO checkout_holds (calendar_id, user_id, expires_at) VALUES (?, ?, ?)`, calendarId, userId, now + ms);
        return true;
    }
    releaseCheckout(calendarId) { this.sql.exec(`DELETE FROM checkout_holds WHERE calendar_id = ?`, calendarId); }

    // Support: move a calendar's subscriptions to another owner. Returns {previousUserIds, active}.
    reassignCalendar(calendarId, userId) {
        const rows = this.sql.exec(`SELECT user_id, status FROM subscriptions WHERE calendar_id = ?`, calendarId).toArray();
        if (!rows.length) return null;
        this.sql.exec(`UPDATE subscriptions SET user_id = ?, updated_at = ? WHERE calendar_id = ?`, userId, Date.now(), calendarId);
        return { previousUserIds: [...new Set(rows.map((r) => r.user_id))], active: rows.some((r) => ACTIVE.has(r.status)) };
    }
    lookup(email) {
        const user = this.findUser(email);
        if (!user) return null;
        const subscriptions = this.sql.exec(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC`, user.id).toArray();
        const sessions = this.sql.exec(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?`, user.id, Date.now()).one().n;
        return { user, subscriptions, activeSessions: sessions };
    }

    eventSeen(id) { return this.sql.exec(`SELECT 1 FROM processed_events WHERE event_id = ?`, id).toArray().length > 0; }
    markEvent(id) {
        const now = Date.now();
        this.sql.exec(`INSERT OR IGNORE INTO processed_events (event_id, at) VALUES (?, ?)`, id, now);
        this.sql.exec(`DELETE FROM processed_events WHERE at < ?`, now - 60 * 24 * 3600 * 1000);   // Stripe retries for 3 days
    }

    // Dev mode only (see the file header).
    addOutbox(to, subject, text) { this.sql.exec(`INSERT INTO outbox (to_email, subject, text, at) VALUES (?, ?, ?, ?)`, to, subject, text, Date.now()); }
    listOutbox(to) { return this.sql.exec(`SELECT to_email, subject, text, at FROM outbox WHERE to_email = ? ORDER BY id`, to).toArray(); }
    expireLoginTokens(email) { this.sql.exec(`UPDATE login_tokens SET expires_at = ? WHERE email = ?`, Date.now() - 1, email); }
}

// --- Worker side -------------------------------------------------------------------------------

const accounts = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const devMode = (env) => env.ACCOUNTS_DEV_MODE === '1';
const isAdmin = (request, env) => !!env.IMPORT_SECRET && request.headers.get('Authorization') === `Bearer ${env.IMPORT_SECRET}`;

function cookieToken(request) {
    const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)pc_session=([^;]+)/);
    return m && looksLikeToken(m[1]) ? m[1] : null;
}

// The signed-in owner's user id, or null. This is what the lock routes in index.js call.
export async function sessionUserId(request, env) {
    const token = cookieToken(request);
    if (!token || !env.ACCOUNTS) return null;
    const s = await accounts(env).sessionUser(token);
    return s ? s.userId : null;
}

// CSRF: a cross-site form can't send application/json without a preflight, and browsers always
// send Origin on POST. Production accepts only pastecal.com; dev mode also accepts localhost.
function sameSite(request, env) {
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return false;
    const origin = request.headers.get('Origin') || '';
    if (origin === SITE || origin === 'https://www.pastecal.com') return true;
    // wrangler dev rewrites a same-host Origin (http://localhost:<port>) to http://<first route's host>.
    return devMode(env) && (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === 'http://pastecal.com');
}

const sessionCookie = (token, maxAge) => `pc_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

// The one place a sign-in email leaves. Never logs the link: Workers Logs are on.
async function sendSignInEmail(env, to, token) {
    const link = `${SITE}/signin#t=${token}`;
    const subject = 'Your pastecal sign-in link';
    const text = `Here is your link to sign in to pastecal:\n\n${link}\n\n`
        + `It works once and expires in 15 minutes.\n\n`
        + `If you didn't ask to sign in, you can ignore this email. Nothing will change.\n`;
    const html = `<p>Here is your link to sign in to pastecal:</p><p><a href="${link}">Sign in to pastecal</a></p>`
        + `<p>It works once and expires in 15 minutes.</p><p>If you didn't ask to sign in, you can ignore this email. Nothing will change.</p>`;
    if (devMode(env)) return accounts(env).addOutbox(to, subject, text);
    if (!env.EMAIL) { console.error('[accounts] EMAIL binding missing; sign-in email not sent'); return; }
    try {
        await env.EMAIL.send({ to, from: { email: 'login@pastecal.com', name: 'pastecal' }, subject, text, html });
    } catch (err) {
        console.error('[accounts] sign-in email failed:', err && err.code, err && err.message);
    }
}

async function readJson(request) {
    const body = await request.json().catch(() => null);
    return body && typeof body === 'object' ? body : null;
}

// Returns a Response for every accounts/billing path, or null for paths it doesn't own.
export async function handleAccounts(request, env, url) {
    const path = url.pathname;
    const owned = path === '/api/me' || path === '/api/stripe/webhook' || path.startsWith('/api/auth/')
        || path.startsWith('/api/pro/') || path.startsWith('/api/admin/accounts/');
    if (!owned) return null;
    if (!env.ACCOUNTS) return json({ error: 'not-available' }, 503);
    try {
        return await route(request, env, url, path);
    } catch (err) {
        console.error('[accounts]', path, err && err.message);
        return json({ error: 'internal' }, 500);
    }
}

async function route(request, env, url, path) {
    const m = request.method;
    if (path === '/api/stripe/webhook') return m === 'POST' ? handleWebhook(request, env) : json({ error: 'method' }, 405);
    if (path.startsWith('/api/admin/accounts/')) return handleAdmin(request, env, url, path);
    if (path === '/api/me') {
        if (m !== 'GET') return json({ error: 'method' }, 405);
        const userId = await sessionUserId(request, env);
        const me = userId && await accounts(env).me(userId);
        return me ? json(me) : json({ error: 'signed-out' }, 401);
    }
    if (path === '/api/pro/status') {
        if (m !== 'GET') return json({ error: 'method' }, 405);
        const id = url.searchParams.get('calendar');
        if (!validId(id)) return json({ error: 'bad-calendar' }, 400);
        const [st, userId] = await Promise.all([LockClient.lockStatus(env, id), sessionUserId(request, env)]);
        if (st.status === 404) return json({ locked: false, pro: false, isOwner: false });
        if (!st.ok && st.status >= 500) return json({ error: 'unavailable' }, 502);
        const locked = !!st.locked;
        return json({ locked, pro: locked && st.plan === 'pro', isOwner: !!(locked && userId && st.ownerId === userId) });
    }

    if (m !== 'POST') return json({ error: 'method' }, 405);
    if (!sameSite(request, env)) return json({ error: 'forbidden-origin' }, 403);
    const body = (await readJson(request)) || {};

    if (path === '/api/auth/start') {
        const email = String(body.email || '').trim().toLowerCase();
        if (!validEmail(email)) return json({ ok: false, error: 'Enter an email address, like you@example.com.' }, 400);
        if (env.CREATE_LIMITER) {
            const { success } = await env.CREATE_LIMITER.limit({ key: 'auth:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
            if (!success) return json({ ok: false, error: 'Too many tries. Wait a minute and send it again.' }, 429);
        }
        // Only a path on this site: no "//evil.example" or "https://..." open redirect.
        const next = typeof body.next === 'string' && /^\/(?![\/\\])[^\s]{0,300}$/.test(body.next) ? body.next : null;
        const token = await accounts(env).issueLoginToken(email, next);
        if (token) await sendSignInEmail(env, email, token);
        return json({ ok: true });
    }
    if (path === '/api/auth/verify') {
        if (!looksLikeToken(body.token)) return json({ ok: false, error: 'This sign-in link is not valid. Ask for a new one.' }, 400);
        const out = await accounts(env).consumeLoginToken(body.token);
        if (!out) return json({ ok: false, error: 'This sign-in link has expired or was already used. Ask for a new one.' }, 400);
        return json({ ok: true, email: out.email, next: out.next || null }, 200, { 'Set-Cookie': sessionCookie(out.session, SESSION_TTL / 1000) });
    }
    if (path === '/api/auth/signout') {
        const token = cookieToken(request);
        if (token) await accounts(env).endSession(token);
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (path === '/api/pro/checkout') return checkout(request, env, body);
    if (path === '/api/pro/portal') {
        const cfg = stripeConfig(env);
        if (!cfg) return json({ error: 'billing-not-configured' }, 503);
        const userId = await sessionUserId(request, env);
        if (!userId) return json({ error: 'signed-out' }, 401);
        const customer = await accounts(env).customerForUser(userId);
        if (!customer) return json({ error: 'no-billing-account' }, 404);
        const returnUrl = validId(body.calendarId) ? `${SITE}/${encodeURIComponent(body.calendarId)}` : `${SITE}/`;
        const r = await stripeRequest(cfg, 'POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl });
        if (!r.ok || !r.data.url) { console.error('[accounts] portal session failed:', r.status); return json({ error: 'stripe-error' }, 502); }
        return json({ url: r.data.url });
    }
    if (path === '/api/pro/editor-key') {
        const userId = await sessionUserId(request, env);
        if (!userId) return json({ error: 'signed-out' }, 401);
        if (!validId(body.calendarId)) return json({ error: 'bad-calendar' }, 400);
        const st = await LockClient.lockStatus(env, body.calendarId);
        if (st.status === 404) return json({ error: 'no-calendar' }, 404);
        if (!st.locked || st.ownerId !== userId) return json({ error: 'not-owner' }, 403);
        const r = await LockClient.rotateEditorKey(env, body.calendarId, userId);
        if (!r.ok || !r.editorKey) return json({ error: r.error || 'unavailable' }, r.status >= 400 && r.status < 500 ? r.status : 502);
        return json({ editorKey: r.editorKey });
    }
    return json({ error: 'not-found' }, 404);
}

// Stripe requires a Checkout page to live at least 30 minutes from when IT creates the session,
// so ask for 31 to absorb clock drift and network time. The per-calendar hold lasts as long.
const CHECKOUT_HOLD_MS = 31 * 60 * 1000;

async function checkout(request, env, body) {
    const cfg = stripeConfig(env);
    if (!cfg) return json({ error: 'billing-not-configured' }, 503);
    const userId = await sessionUserId(request, env);
    if (!userId) return json({ error: 'signed-out' }, 401);
    const calendarId = body.calendarId;
    if (!validId(calendarId)) return json({ error: 'bad-calendar' }, 400);
    const interval = body.interval === undefined ? 'year' : body.interval;
    if (!Object.hasOwn(INTERVALS, interval)) return json({ error: 'bad-interval' }, 400);
    const price = cfg.prices[interval];
    if (!price) return json({ error: 'billing-not-configured' }, 503);

    // v1: they have the calendar open; it must exist and not be someone else's.
    const st = await LockClient.lockStatus(env, calendarId);
    if (st.status === 404) return json({ error: 'no-calendar' }, 404);
    if (!st.ok) return json({ error: 'unavailable' }, 502);
    if (st.locked) return json({ error: st.ownerId === userId ? 'already-pro' : 'locked-by-other' }, 409);

    const acc = accounts(env);
    const [user, customer] = await Promise.all([acc.getUser(userId), acc.customerForUser(userId)]);
    if (!user) return json({ error: 'signed-out' }, 401);
    if (!(await acc.holdCheckout(calendarId, userId, CHECKOUT_HOLD_MS))) return json({ error: 'checkout-in-progress' }, 409);
    const back = validId(body.editName) ? body.editName : calendarId;
    const meta = { calendar_id: calendarId, user_id: userId };
    const params = {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        metadata: { ...meta, interval },
        subscription_data: { metadata: meta },
        success_url: `${SITE}/pro/done?session_id={CHECKOUT_SESSION_ID}#${encodeURIComponent(calendarId)}`,
        cancel_url: `${SITE}/${encodeURIComponent(back)}`,
        expires_at: Math.floor((Date.now() + CHECKOUT_HOLD_MS) / 1000),
    };
    // Stripe limits client_reference_id's characters; calendar names can be anything, and metadata has the real id.
    if (/^[A-Za-z0-9_-]{1,200}$/.test(calendarId)) params.client_reference_id = calendarId;
    if (customer) params.customer = customer; else params.customer_email = user.email;
    const r = await stripeRequest(cfg, 'POST', '/v1/checkout/sessions', params);
    if (!r.ok || !r.data.url) { console.error('[accounts] checkout session failed:', r.status, r.data && r.data.error && r.data.error.code); return json({ error: 'stripe-error' }, 502); }
    return json({ url: r.data.url });
}

// Stripe webhook. The body is read raw before anything parses it (the signature covers the bytes).
// Events can arrive out of order or twice, so each one only names a subscription: we fetch that
// subscription's CURRENT state from Stripe and make the calendar match it.
async function handleWebhook(request, env) {
    const raw = await request.text();
    const cfg = stripeConfig(env);
    if (!cfg) return json({ error: 'billing-not-configured' }, 503);
    const v = await verifyStripeSignature(cfg.webhookSecret, request.headers.get('Stripe-Signature'), raw);
    if (!v.ok) return json({ error: 'invalid-signature', reason: v.reason }, 400);
    let event;
    try { event = JSON.parse(raw); } catch { return json({ error: 'bad-json' }, 400); }
    if (!event || typeof event.id !== 'string') return json({ error: 'bad-event' }, 400);

    const acc = accounts(env);
    if (await acc.eventSeen(event.id)) return json({ received: true, duplicate: true });
    const subId = SUBSCRIPTION_EVENTS.has(event.type) ? subscriptionIdOf(event) : null;
    if (subId) {
        const r = await stripeRequest(cfg, 'GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
        if (r.status >= 500 || r.status === 429 || (!r.ok && r.status !== 404)) return json({ error: 'retry' }, 500);
        if (r.ok) {
            const outcome = await applySubscription(env, acc, summarizeSubscription(r.data));
            if (outcome.retry) return json({ error: 'retry' }, 500);       // not marked: Stripe sends it again
        }
    }
    await acc.markEvent(event.id);
    return json({ received: true });
}

// Make the calendar match the subscription. {retry:true} when the calendar couldn't be reached.
async function applySubscription(env, acc, s) {
    const prev = await acc.getSubscription(s.id);
    // Our row wins over Stripe's metadata: support may have reassigned the owner.
    const calendarId = (prev && prev.calendar_id) || s.calendarId;
    const userId = (prev && prev.user_id) || s.userId;
    if (!validId(calendarId) || !userId) { console.warn('[accounts] subscription without calendar/user metadata:', s.id); return {}; }
    await acc.upsertSubscription({ ...s, calendarId, userId });

    if (!ACTIVE.has(s.status) && !ENDED.has(s.status)) return {};       // incomplete, paused: leave as is
    const st = await LockClient.lockStatus(env, calendarId);
    if (st.status >= 500) return { retry: true };
    if (st.status === 404) { console.warn('[accounts] paid calendar not found:', calendarId); return {}; }
    if (ACTIVE.has(s.status)) {
        if (st.locked && st.ownerId === userId) return {};
        // The first lock returns an editor key, but there is no browser here to give it to.
        // It is dropped unseen; the owner makes a fresh one from the calendar (POST /api/pro/editor-key).
        const r = await LockClient.lock(env, calendarId, userId);
        if (r.status >= 500) return { retry: true };
        if (!r.ok) console.warn('[accounts] could not lock paid calendar:', calendarId, r.status, r.error);
        else await acc.releaseCheckout(calendarId);
        return {};
    }
    if (await acc.otherActiveSubscription(calendarId, s.id)) return {};   // still paid for by another subscription
    if (!st.locked || st.ownerId !== userId) return {};
    const r = await LockClient.unlock(env, calendarId, userId);
    return r.status >= 500 ? { retry: true } : {};
}

async function handleAdmin(request, env, url, path) {
    if (!isAdmin(request, env)) return new Response('forbidden', { status: 403 });
    const acc = accounts(env);
    if (path === '/api/admin/accounts/lookup' && request.method === 'GET') {
        const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
        const out = await acc.lookup(email);
        return out ? json(out) : json({ error: 'no-user' }, 404);
    }
    if (path === '/api/admin/accounts/reassign' && request.method === 'POST') {
        const body = (await readJson(request)) || {};
        const email = String(body.email || '').trim().toLowerCase();
        if (!validId(body.calendarId) || !validEmail(email)) return json({ error: 'need calendarId and email' }, 400);
        const userId = await acc.ensureUser(email);
        const moved = await acc.reassignCalendar(body.calendarId, userId);
        if (!moved) return json({ error: 'no-subscription' }, 404);
        let relocked = false;
        if (moved.active) {
            const st = await LockClient.lockStatus(env, body.calendarId);
            if (st.locked && st.ownerId !== userId) await LockClient.unlock(env, body.calendarId, st.ownerId);
            if (!(st.locked && st.ownerId === userId)) relocked = (await LockClient.lock(env, body.calendarId, userId)).ok;   // key dropped unseen
        }
        return json({ ok: true, userId, calendarId: body.calendarId, relocked });
    }
    // Test hooks, dev mode only.
    if (devMode(env) && path === '/api/admin/accounts/outbox' && request.method === 'GET') {
        return json({ emails: await acc.listOutbox(String(url.searchParams.get('email') || '').toLowerCase()) });
    }
    if (devMode(env) && path === '/api/admin/accounts/expire-tokens' && request.method === 'POST') {
        const body = (await readJson(request)) || {};
        await acc.expireLoginTokens(String(body.email || '').toLowerCase());
        return json({ ok: true });
    }
    if (devMode(env) && path === '/api/admin/accounts/dev-subscription' && request.method === 'POST') {
        const body = (await readJson(request)) || {};
        const email = String(body.email || '').trim().toLowerCase();
        if (!validId(body.calendarId) || !validEmail(email)) return json({ error: 'need calendarId and email' }, 400);
        const status = typeof body.status === 'string' && /^[a-z_]{1,30}$/.test(body.status) ? body.status : 'active';
        const userId = await acc.ensureUser(email);
        const id = 'sub_dev_' + body.calendarId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) + '_' + userId.slice(-8);
        await acc.upsertSubscription({ id, userId, calendarId: body.calendarId, status,
            interval: body.interval === 'month' ? 'month' : 'year',
            currentPeriodEnd: Number.isFinite(body.currentPeriodEnd) ? body.currentPeriodEnd : Math.floor(Date.now() / 1000) + 365 * 86400 });
        return json({ ok: true, userId, subscriptionId: id });
    }
    return json({ error: 'not-found' }, 404);
}
