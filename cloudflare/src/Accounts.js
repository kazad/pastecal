/**
 * Accounts -- Pro owners' sign-in (magic link) and their Stripe subscriptions, in one global
 * Durable Object's SQLite. Only a calendar's paying owner ever has an account; helpers never do.
 *
 *   POST /api/auth/start      {email, next?}     -> {ok:true} always (never says if the email is known)
 *   POST /api/auth/peek       {token}            -> {ok, email} without using the link up (the sign-in page asks
 *                                                   "Sign in as <email>?" and verifies only on a click: no login CSRF)
 *   POST /api/auth/verify     {token}            -> {ok, email, next} + Set-Cookie pc_session (Max-Age 400 days)
 *   POST /api/auth/signout                       -> {ok:true}, cookie cleared
 *   POST /api/auth/signout-all                   -> {ok:true, sessionsEnded}: every session of this user, on every
 *                                                   device, ends (cookie cleared); 401 signed-out
 *   POST /api/account/delete                     -> {ok:true, deleted:true}: sessions, sign-in links and the user row
 *                                                   are deleted; subscription rows keep their Stripe ids (accounting)
 *                                                   but lose the link to the user. Cancels nothing: 409
 *                                                   {error:'active-subscription', calendars} while any subscription
 *                                                   is active, trialing or past_due (cancel it first). 401 signed-out
 *   GET  /api/me                                 -> {email, calendars:[{id, status, plan, interval, currentPeriodEnd, cancelAtPeriodEnd}]} | 401;
 *                                                   re-sends the cookie (fresh Max-Age) when the session was renewed
 *                                                   in the last day, so browsers keep it
 *   POST /api/pro/checkout    {calendarId, interval?:'year'|'month', editName?} -> {url} (Stripe Checkout).
 *                             Signed out works too (pay first): it sets an HttpOnly pc_claim cookie whose hash rides
 *                             on the checkout; Stripe asks for the email and the webhook finds or makes that account.
 *   POST /api/pro/trial       {calendarId}       -> {ok, trialEnd} (signed in): a 30-day Pro trial, no card. A direct
 *                             Stripe subscription (trial_period_days=30, trial_settings.end_behavior.missing_payment_method
 *                             =cancel) applied at once, so the calendar is locked for this user before it answers. Saved
 *                             calendars only (a draft has no room: 404 no-calendar). One trial per calendar EVER and one
 *                             per person (user id and email hash), in `trials`, claimed before Stripe is called: 409
 *                             {error:'trial-used-calendar'|'trial-used-account', message}; also 409 locked-by-other /
 *                             already-pro, 403 buy-on-live (beta), 503 billing-not-configured. Pressing it again while
 *                             the trial runs answers {ok, already:true}. A sign-in link asked for with next
 *                             "/<calendar>?pro=trial" starts it on verify (verify's answer then carries trial:{ok, error?}).
 *                             Day 27 (customer.subscription.trial_will_end): one reminder email, "Your Pro trial ends
 *                             <date>", with a Keep Pro link to the calendar (?pro=keep); skipped if a card is on file.
 *                             Day 30 with no card: Stripe deletes it, and the calendar falls back as below.
 *                             Keep Pro (during or after the trial) is the ordinary /api/pro/checkout: a trialing owner may
 *                             check out their own locked calendar, and the paid subscription replaces the trial (canceled,
 *                             never refunded). Each trial has its own Stripe customer, so a card saved for another calendar
 *                             is never charged when it ends. Logs (no ids, no emails): "[trial] converted interval=… via=
 *                             checkout|card", "[trial] lapsed mode=readonly|open".
 *   POST /api/pro/lapsed-mode {calendarId, mode:'readonly'|'open'} -> {ok, mode, paused}: what happens when Pro ends.
 *                             Every ended subscription (trial or paid, no one else paying) unlocks with lapse:true, and
 *                             the calendar is then PAUSED (read-only for everyone, views and feeds as before) unless its
 *                             owner chose 'open'. The owner sets it while locked, or after: 'open' on a paused calendar
 *                             makes it a normal free calendar. Only that owner can lock a paused calendar again
 *                             (resubscribe). Errors: 401, 400 bad-calendar / bad-mode, 409 not-locked, 403 not-owner.
 *   POST /api/pro/claim       {sessionId} -> {ok, signedIn, email}: /pro/done after a signed-out checkout. Needs the
 *                             pc_claim cookie, a paid recent checkout carrying its hash, and is single-use. Signs in
 *                             only an account that checkout made; an existing account gets a sign-in link instead.
 *   POST /api/pro/portal      {calendarId?, flow?:'add-card'} -> {url} (Stripe Billing Portal; add-card opens its
 *                                                   payment-method page: Keep Pro during a trial)
 *   POST /api/pro/editor-key  {calendarId}       -> {editorKey}, shown once (owner only). Compatibility: revokes
 *                                                   every editor link and makes one new link labeled 'Editors'.
 *   POST /api/pro/editor-links {calendarId, label} -> {id, label, createdAt, url_fragment_key} (key shown once; owner only)
 *   GET  /api/pro/editor-links?calendar=<id>     -> [{id, label, createdAt, lastUsedAt}] live links only, never keys (owner only)
 *   POST /api/pro/editor-links/revoke {calendarId, id} -> {ok:true}; that link's sockets drop to read-only (owner only)
 *   POST /api/pro/settings    {calendarId, settings} -> {ok:true, settings} (owner only; a partial patch, see
 *                                                   mergeProSettings in CalendarRoom.js; 400 {error:'bad-settings', message})
 *     Owner routes answer 401 signed-out, 400 bad-calendar, 404 no-calendar, 409 not-locked, 403 not-owner;
 *     editor-links also 400 bad-label, 409 too-many-links (20 live), 404 no-link.
 *   GET  /api/pro/config                         -> {billing}: true only when Stripe is configured (keys and both prices).
 *                                                   False: the site offers "Join the beta" (the waitlist) instead of
 *                                                   the trial and checkout. Public, cached 60 seconds.
 *   GET  /api/pro/status?calendar=<id>           -> {locked, pro, plan, isOwner, paused, lapsedOwner, trialUsed}; plan is the
 *                                                   lock's plan id (null unlocked; Plans.js names it); the owner also
 *                                                   gets lapsedMode, and trial:{endsAt, hasCard} while trialing; the
 *                                                   paused calendar's owner gets lapsedTrial (its Pro was a trial)
 *   POST /api/stripe/webhook                     Stripe events (signed), see handleWebhook
 *   POST /api/admin/accounts/reassign {calendarId, email}   (Bearer IMPORT_SECRET; lost access, disputes)
 *   POST /api/admin/accounts/reset-trial {calendarId}            (same) cancel its trial, unlock it (not paused), free its trial
 *   GET  /api/admin/accounts/lookup?email=                  (same)
 *   GET  /api/admin/accounts/conflicts                      (same) subscriptions refunded because they could not
 *                                                           get the lock (status refunded-conflict / conflict-refund-failed)
 *   GET  /api/admin/pro/health                              (same) subscription counts, lock mismatches,
 *                                                           sign-in funnel for the last 24h; see proHealth
 *
 * The first time the webhook locks a calendar for an owner, that owner gets one welcome email
 * (sendWelcomeEmail). welcome_emails records it per (calendar, owner), so retries, replays,
 * renewals and a later re-subscribe never send it again.
 *
 * Tokens (sign-in links, sessions) are 128-bit random, base64url; only their SHA-256 is stored.
 * Sessions roll: each lasts 365 days from its last renewal, and any use more than a day after the
 * last renewal renews it (one UPDATE, at most daily). Someone who visits at least once a year never
 * signs in again. Sign out (everywhere) and account delete still end them at once.
 * Cookie-authenticated POSTs need Content-Type: application/json and an Origin of pastecal.com
 * (on staging: SITE_URL's origin; see Site.js). Every link in an email or a Stripe redirect starts with siteUrl(env).
 *
 * ACCOUNTS_DEV_MODE=1 (only ever in .dev.vars or --var, never in wrangler.jsonc) is for local tests:
 * it allows http://localhost origins, writes sign-in emails to an outbox instead of sending them,
 * lets STRIPE_API_BASE / LOCK_API_BASE point at local fakes, and opens these admin test hooks:
 *   GET  /api/admin/accounts/outbox?email=, POST /api/admin/accounts/expire-tokens {email, ageMs?},
 *   POST /api/admin/accounts/age-sessions {email, ageMs} (moves that user's sessions back in time),
 *   POST /api/admin/accounts/dev-subscription {email, calendarId, status?, interval?, currentPeriodEnd?}
 *        (a subscription row without Stripe, so /api/me lists the calendar; no lock is changed).
 */
import { DurableObject } from 'cloudflare:workers';
import { LockClient } from './LockClient.js';
import { INTERVALS, stripeConfig, stripeRequest, verifyStripeSignature, summarizeSubscription, subscriptionIdOf, timingSafeEqual,
    eventModeMismatch, subscriptionOfInvoice, paymentOfInvoice, paymentOfInvoicePayments } from './Stripe.js';
import { siteUrl, siteHost, allowedOrigins, isStaging } from './Site.js';
import { planName } from './Plans.js';

const LOGIN_TTL = 15 * 60 * 1000;
const SESSION_TTL = 365 * 24 * 3600 * 1000;   // from the last renewal (see sessionUser)
const SESSION_RENEW_AFTER = 24 * 3600 * 1000;  // renew at most once a day per session
const COOKIE_MAX_AGE = 400 * 24 * 3600;        // seconds; Chrome caps cookie lifetimes at 400 days
const LOGINS_PER_EMAIL_PER_HOUR = 5;
const LOGINS_PER_EMAIL_PER_DAY = 10;     // and no more than this a day: nobody can flood an inbox slowly either
const ACTIVE = new Set(['active', 'trialing', 'past_due']);
const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);
// Our own final statuses for a subscription we refunded and canceled because it could not get the
// lock (another owner, or a duplicate). Later events for it change nothing.
// 'undone' / 'undone-refund-failed': an editor of record undid someone else's upgrade within 7 days (undoUpgrade).
const CONFLICT = new Set(['refunded-conflict', 'conflict-refund-failed', 'undone', 'undone-refund-failed']);
const UNDO_DAYS = 7;
const SUBSCRIPTION_EVENTS = new Set(['checkout.session.completed', 'customer.subscription.created',
    'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed', 'customer.subscription.trial_will_end']);
const TRIAL_DAYS = 30;
const TRIAL_ERRORS = {
    'trial-used-calendar': 'This calendar has already had a free trial.',
    'trial-used-account': 'You have already used your free trial.',
};
// A full refund or a dispute ends the subscription that charge paid for (which unlocks as usual).
const CHARGE_EVENTS = new Set(['charge.refunded', 'charge.dispute.created']);
const CHECKOUT_RESTARTS_PER_HOUR = 3;
const TEST_INBOX_RETAIN_MS = 7 * 24 * 3600 * 1000, TEST_INBOX_MAX = 500;   // see TestInbox.js

// Same rule as index.js: any name Firebase allowed.
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);
const validEmail = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
// Where a sign-in link may send people afterwards: exactly "/" or "/<calendar>" (one segment, a valid
// calendar id once decoded; the only query allowed is ?pro=year|month|trial, see safeNext). Never /pro/done (it makes editor links), /signin, or another site.
const RESERVED_NEXT = new Set(['signin', 'pro', 'pricing', 'view', 'beta', 'nativecal', 'api', 'cal', 'report', 'explore']);
// A calendar path, optionally with ?pro=year|month: the lock the person was buying when they asked
// for the link, so they can finish it even if the email opens in another browser.
function safeNext(raw) {
    if (raw === '/') return '/';
    if (typeof raw !== 'string' || raw.length > 700) return null;
    // ?pro=keep: the trial reminder's Keep link, which may need a sign-in first (it opens the Plus tab on Keep).
    const m = /^\/([^/?#\\\s]+)(\?pro=(?:year|trial|keep))?$/.exec(raw);
    if (!m) return null;
    let id; try { id = decodeURIComponent(m[1]); } catch { return null; }
    if (!validId(id) || RESERVED_NEXT.has(id.toLowerCase())) return null;
    return '/' + encodeURIComponent(id) + (m[2] || '');
}

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
            CREATE TABLE IF NOT EXISTS checkout_holds (calendar_id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);
            CREATE TABLE IF NOT EXISTS welcome_emails (calendar_id TEXT, user_id TEXT, at INTEGER, PRIMARY KEY (calendar_id, user_id));
            -- Who upgraded a calendar, for the 7-day undo: the upgrading browser's author uid, whether it was the creator's,
            -- and when the lock landed (NULL while a checkout is still open). Never shown: uids are proof (CalendarRoom).
            CREATE TABLE IF NOT EXISTS upgrades (calendar_id TEXT PRIMARY KEY, user_id TEXT, author TEXT, by_creator INTEGER, at INTEGER, undone_at INTEGER);
            CREATE TABLE IF NOT EXISTS test_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, from_addr TEXT, subject TEXT,
                received_at INTEGER, text TEXT, truncated INTEGER, auth_results TEXT, arc_auth_results TEXT, has_dkim_signature INTEGER);
            CREATE INDEX IF NOT EXISTS test_inbox_to ON test_inbox(to_addr, id);
            CREATE TABLE IF NOT EXISTS checkout_claims (claim_hash TEXT PRIMARY KEY, session_id TEXT, used_at INTEGER);
            CREATE TABLE IF NOT EXISTS trials (calendar_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email_hash TEXT,
                subscription_id TEXT, started_at INTEGER);
            CREATE UNIQUE INDEX IF NOT EXISTS trials_user ON trials(user_id);
            CREATE UNIQUE INDEX IF NOT EXISTS trials_email ON trials(email_hash);
            CREATE TABLE IF NOT EXISTS trial_reminders (subscription_id TEXT PRIMARY KEY, at INTEGER);
            CREATE TABLE IF NOT EXISTS notice_emails (k TEXT PRIMARY KEY, at INTEGER);`);
        // Added later (an existing table keeps its columns): which subscription came first, and the
        // Checkout Session a hold guards plus how often its buyer restarted it.
        for (const col of ['subscriptions ADD COLUMN created INTEGER', 'checkout_holds ADD COLUMN session_id TEXT',
            'checkout_holds ADD COLUMN restarts INTEGER', 'checkout_holds ADD COLUMN window_start INTEGER',
            'sessions ADD COLUMN renewed_at INTEGER', 'users ADD COLUMN created_via TEXT', 'subscriptions ADD COLUMN trial_end INTEGER',
            'subscriptions ADD COLUMN has_payment_method INTEGER', 'subscriptions ADD COLUMN cancel_at_period_end INTEGER']) {
            try { this.sql.exec(`ALTER TABLE ${col}`); } catch (_) { /* already there */ }
        }
    }

    // A new sign-in link for this email, or null past the per-email limit (the caller still says ok).
    async issueLoginToken(email, next) {
        const now = Date.now();
        this.sql.exec(`DELETE FROM login_tokens WHERE expires_at < ?`, now - 24 * 3600 * 1000);
        this.sql.exec(`DELETE FROM sessions WHERE expires_at < ?`, now);
        const recent = this.sql.exec(`SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?`, email, now - 3600 * 1000).one().n;
        if (recent >= LOGINS_PER_EMAIL_PER_HOUR) return null;
        const today = this.sql.exec(`SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?`, email, now - 24 * 3600 * 1000).one().n;
        if (today >= LOGINS_PER_EMAIL_PER_DAY) return null;
        const token = randomToken();
        this.sql.exec(`INSERT INTO login_tokens (hash, email, next, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
            await sha256(token), email, next || null, now, now + LOGIN_TTL);
        return token;
    }

    // Which email a sign-in link is for, without using it up; null when it would not sign in.
    async peekLoginToken(token) {
        const hash = await sha256(token);
        const row = this.sql.exec(`SELECT hash, email, used, expires_at, next FROM login_tokens WHERE hash = ?`, hash).toArray()[0];
        if (!row || !timingSafeEqual(row.hash, hash) || row.used || row.expires_at <= Date.now()) return null;
        return { email: row.email, next: row.next || null };
    }

    // Uses up a sign-in link: the user (created on first sign-in) and a new session token.
    async consumeLoginToken(token) {
        const now = Date.now(), hash = await sha256(token);
        const row = this.sql.exec(`SELECT * FROM login_tokens WHERE hash = ?`, hash).toArray()[0];
        if (!row || !timingSafeEqual(row.hash, hash) || row.used || row.expires_at <= now) return null;
        this.sql.exec(`UPDATE login_tokens SET used = 1 WHERE hash = ?`, hash);
        const userId = this.ensureUser(row.email);
        // An account a checkout made (pay first) was never proven to belong to this email until now:
        // whoever typed the address at Stripe is signed out, and the account counts as verified.
        const via = this.sql.exec(`SELECT created_via FROM users WHERE id = ?`, userId).one().created_via;
        if (via) {
            this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, userId);
            this.sql.exec(`UPDATE users SET created_via = NULL WHERE id = ?`, userId);
        }
        const session = randomToken();
        this.sql.exec(`INSERT INTO sessions (hash, user_id, created_at, expires_at, renewed_at) VALUES (?, ?, ?, ?, ?)`, await sha256(session), userId, now, now + SESSION_TTL, now);
        return { session, email: row.email, next: row.next };
    }

    // A live session's user, renewing it when its last renewal is over a day old. An expired session is
    // refused, never revived. renewedAt says when it was last renewed (the caller may re-send the cookie).
    async sessionUser(token) {
        const now = Date.now(), hash = await sha256(token);
        const row = this.sql.exec(`SELECT s.hash, s.user_id, s.expires_at, COALESCE(s.renewed_at, s.created_at) AS renewed, u.email
            FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?`, hash).toArray()[0];
        if (!row || !timingSafeEqual(row.hash, hash) || row.expires_at <= now) return null;
        let renewedAt = row.renewed;
        if (now - renewedAt > SESSION_RENEW_AFTER) {
            this.sql.exec(`UPDATE sessions SET expires_at = ?, renewed_at = ? WHERE hash = ?`, now + SESSION_TTL, now, hash);
            renewedAt = now;
        }
        return { userId: row.user_id, email: row.email, renewedAt };
    }

    async endSession(token) { this.sql.exec(`DELETE FROM sessions WHERE hash = ?`, await sha256(token)); }

    // Pay first: the owner of a checkout started signed out, found by the email typed at Stripe
    // (never verified). A new email gets an account marked as made by this checkout (claimHash). An
    // existing one is used as is, except that an account another unverified checkout made has its
    // sessions ended first: someone who typed this address before can't watch a new purchase land.
    userForCheckout(email, claimHash) {
        const row = this.sql.exec(`SELECT id, created_via FROM users WHERE email = ?`, email).toArray()[0];
        if (!row) {
            const id = 'u_' + randomToken();
            this.sql.exec(`INSERT INTO users (id, email, created_at, created_via) VALUES (?, ?, ?, ?)`, id, email, Date.now(), claimHash);
            return { userId: id, madeHere: true };
        }
        if (row.created_via === claimHash) return { userId: row.id, madeHere: true };
        if (row.created_via) this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, row.id);
        return { userId: row.id, madeHere: false };
    }
    // The paid checkout's browser asks to be signed in, once. A session only for an account this
    // checkout made; for any other account {existing} (the caller emails a sign-in link instead).
    async claimCheckout(claimHash, sessionId, email) {
        if (this.sql.exec(`SELECT 1 FROM checkout_claims WHERE claim_hash = ? AND used_at IS NOT NULL`, claimHash).toArray().length) return { used: true };
        this.sql.exec(`INSERT OR REPLACE INTO checkout_claims (claim_hash, session_id, used_at) VALUES (?, ?, ?)`, claimHash, sessionId, Date.now());
        const u = this.userForCheckout(email, claimHash);
        if (!u.madeHere) return { existing: true };
        const now = Date.now(), session = randomToken();
        this.sql.exec(`INSERT INTO sessions (hash, user_id, created_at, expires_at, renewed_at) VALUES (?, ?, ?, ?, ?)`, await sha256(session), u.userId, now, now + SESSION_TTL, now);
        return { session };
    }

    ensureUser(email) {
        const row = this.sql.exec(`SELECT id FROM users WHERE email = ?`, email).toArray()[0];
        if (row) return row.id;
        const id = 'u_' + randomToken();
        this.sql.exec(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`, id, email, Date.now());
        return id;
    }
    // Sign out everywhere: every session of this user. Returns how many ended.
    endAllSessions(userId) {
        const n = this.sql.exec(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, userId).one().n;
        this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, userId);
        return n;
    }
    // Delete an account. Refuses (returns {active:[calendarIds]}) while any subscription is still
    // active/trialing/past_due: Stripe would keep charging a user who can no longer sign in to cancel.
    // Otherwise drops sessions, sign-in links, holds and the user row (the email lives only there and in
    // login_tokens), and unlinks the user's subscriptions: their Stripe ids stay for accounting.
    deleteAccount(userId) {
        const user = this.getUser(userId);
        if (!user) return { deleted: false };
        const active = this.sql.exec(`SELECT calendar_id, status FROM subscriptions WHERE user_id = ?`, userId).toArray().filter((r) => ACTIVE.has(r.status));
        if (active.length) return { active: [...new Set(active.map((r) => r.calendar_id))] };
        this.ctx.storage.transactionSync(() => {
            this.sql.exec(`DELETE FROM login_tokens WHERE email = ?`, user.email);
            this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, userId);
            this.sql.exec(`DELETE FROM checkout_holds WHERE user_id = ?`, userId);
            this.sql.exec(`DELETE FROM welcome_emails WHERE user_id = ?`, userId);
            this.sql.exec(`DELETE FROM outbox WHERE to_email = ?`, user.email);          // dev mode only ever writes here
            this.sql.exec(`UPDATE subscriptions SET user_id = NULL, updated_at = ? WHERE user_id = ?`, Date.now(), userId);
            this.sql.exec(`DELETE FROM users WHERE id = ?`, userId);
        });
        return { deleted: true };
    }

    getUser(userId) { return this.sql.exec(`SELECT * FROM users WHERE id = ?`, userId).toArray()[0] || null; }
    findUser(email) { return this.sql.exec(`SELECT * FROM users WHERE email = ?`, email).toArray()[0] || null; }

    me(userId) {
        const user = this.getUser(userId);
        if (!user) return null;
        const rows = this.sql.exec(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC`, userId).toArray();
        const byCal = new Map();     // one entry per calendar: an active subscription wins over old ones
        for (const r of rows) {
            if (CONFLICT.has(r.status)) continue;          // refunded: never theirs
            const have = byCal.get(r.calendar_id);
            if (!have || (!ACTIVE.has(have.status) && ACTIVE.has(r.status))) byCal.set(r.calendar_id, r);
        }
        return {
            email: user.email,
            calendars: [...byCal.values()].map((r) => ({ id: r.calendar_id, status: r.status, plan: r.plan, interval: r.interval, priceId: r.price_id,
                currentPeriodEnd: r.current_period_end, trialEnd: r.trial_end || null, cancelAtPeriodEnd: !!r.cancel_at_period_end })),
        };
    }

    getSubscription(id) { return this.sql.exec(`SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`, id).toArray()[0] || null; }
    upsertSubscription(s) {
        this.sql.exec(`INSERT INTO subscriptions (stripe_subscription_id, user_id, stripe_customer_id, calendar_id, plan, interval, price_id, status, current_period_end, updated_at, created, trial_end, has_payment_method, cancel_at_period_end)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(stripe_subscription_id) DO UPDATE SET user_id = excluded.user_id, stripe_customer_id = excluded.stripe_customer_id,
                calendar_id = excluded.calendar_id, plan = excluded.plan, interval = excluded.interval, price_id = excluded.price_id,
                status = excluded.status, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at,
                created = COALESCE(excluded.created, subscriptions.created), trial_end = COALESCE(excluded.trial_end, subscriptions.trial_end),
                has_payment_method = excluded.has_payment_method, cancel_at_period_end = excluded.cancel_at_period_end`,
            s.id, s.userId, s.customer || null, s.calendarId, 'pro', s.interval || null, s.priceId || null, s.status, s.currentPeriodEnd || null, Date.now(), s.created || null, s.trialEnd || null,
            s.hasPaymentMethod ? 1 : 0, s.cancelAtPeriodEnd ? 1 : 0);
    }
    setSubscriptionStatus(id, status) { this.sql.exec(`UPDATE subscriptions SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?`, status, Date.now(), id); }
    // The calendar's other active subscriptions, oldest first (a row without `created` predates the column: oldest).
    otherActiveSubscriptions(calendarId, exceptId) {
        return this.sql.exec(`SELECT stripe_subscription_id AS id, user_id AS userId, status, created FROM subscriptions
            WHERE calendar_id = ? AND stripe_subscription_id != ? ORDER BY COALESCE(created, 0), stripe_subscription_id`, calendarId, exceptId)
            .toArray().filter((r) => ACTIVE.has(r.status));
    }
    conflicts() {
        return this.sql.exec(`SELECT stripe_subscription_id, user_id, calendar_id, status, updated_at FROM subscriptions WHERE status IN ('refunded-conflict', 'conflict-refund-failed') ORDER BY updated_at DESC LIMIT 100`).toArray();
    }
    // The Stripe customer for Manage billing with no calendar named: a paid (never-trial) subscription's if
    // there is one, else the most recent. Each trial has its own customer, so "most recent" alone could open
    // a trial's customer where the paid plan isn't listed.
    customerForUser(userId) {
        return this.paidCustomerForUser(userId) || (this.sql.exec(`SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1`, userId).toArray()[0] || {}).stripe_customer_id || null;
    }
    // A customer from a subscription that never was a trial. Checkout reuses only this one: a trial's customer
    // must never get a card from another calendar's checkout, or that trial would charge it when it ends.
    paidCustomerForUser(userId) {
        const row = this.sql.exec(`SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL
            AND stripe_subscription_id NOT IN (SELECT subscription_id FROM trials WHERE subscription_id IS NOT NULL)
            ORDER BY updated_at DESC LIMIT 1`, userId).toArray()[0];
        return row ? row.stripe_customer_id : null;
    }
    // One buyer at a time per calendar: a hold lasts as long as the Stripe Checkout page it guards
    // (both CHECKOUT_HOLD_MS), so a second person can't pay for a calendar someone is already buying
    // and end up charged without the lock. The same user may restart their own checkout, at most
    // CHECKOUT_RESTARTS_PER_HOUR times an hour, and the caller expires their previous page first
    // (previousSession), so only one page can ever take a payment.
    holdCheckout(calendarId, userId, ms) {
        const now = Date.now();
        const row = this.sql.exec(`SELECT user_id, expires_at, session_id, restarts, window_start FROM checkout_holds WHERE calendar_id = ?`, calendarId).toArray()[0];
        // A signed-out checkout (anon:) never blocks anyone: starting one costs nothing, so honoring it
        // would let anyone keep a calendar from its owner. If both pay, the conflict refund settles it.
        if (row && row.user_id !== userId && row.expires_at > now && !String(row.user_id).startsWith('anon:')) return { ok: false, error: 'checkout-in-progress' };
        const mine = row && row.user_id === userId;
        const inWindow = mine && row.window_start && now - row.window_start < 3600 * 1000;
        const restarts = inWindow ? (row.restarts || 0) + 1 : 0;
        if (restarts > CHECKOUT_RESTARTS_PER_HOUR) return { ok: false, error: 'too-many-checkouts' };
        this.sql.exec(`INSERT OR REPLACE INTO checkout_holds (calendar_id, user_id, expires_at, session_id, restarts, window_start) VALUES (?, ?, ?, ?, ?, ?)`,
            calendarId, userId, now + ms, mine ? row.session_id : null, restarts, inWindow ? row.window_start : now);
        return { ok: true, previousSession: mine ? row.session_id || null : null };
    }
    setCheckoutSession(calendarId, userId, sessionId) {
        this.sql.exec(`UPDATE checkout_holds SET session_id = ? WHERE calendar_id = ? AND user_id = ?`, sessionId, calendarId, userId);
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

    // ---- 30-day trial (POST /api/pro/trial) ----
    // One trial per calendar, ever, and one per person (user id, and the email's hash, which outlives
    // an account delete). Claimed before Stripe is called, check and insert in one synchronous step,
    // so two requests can't both start one. The same person retrying on the same calendar is let
    // through (Stripe's idempotency key makes it the same subscription).
    // -> {ok, retry?} | {error:'trial-used-calendar'|'trial-used-account'}
    claimTrial(calendarId, userId, emailHash) {
        const cal = this.sql.exec(`SELECT user_id, subscription_id FROM trials WHERE calendar_id = ?`, calendarId).toArray()[0];
        if (cal) return cal.user_id === userId ? { ok: true, retry: true, subscriptionId: cal.subscription_id || null } : { error: 'trial-used-calendar' };
        if (this.sql.exec(`SELECT 1 FROM trials WHERE user_id = ? OR email_hash = ?`, userId, emailHash).toArray().length) return { error: 'trial-used-account' };
        this.sql.exec(`INSERT INTO trials (calendar_id, user_id, email_hash, subscription_id, started_at) VALUES (?, ?, ?, NULL, ?)`, calendarId, userId, emailHash, Date.now());
        return { ok: true };
    }
    // Stripe refused (nothing was made): the claim goes, so the trial can be tried again.
    releaseTrial(calendarId, userId) {
        this.sql.exec(`DELETE FROM trials WHERE calendar_id = ? AND user_id = ? AND subscription_id IS NULL`, calendarId, userId);
    }
    setTrialSubscription(calendarId, subscriptionId) {
        this.sql.exec(`UPDATE trials SET subscription_id = ? WHERE calendar_id = ?`, subscriptionId, calendarId);
    }
    // A trial subscription seen by the webhook (made by us, or by hand in Stripe): it counts as used.
    noteTrial(calendarId, userId, emailHash, subscriptionId) {
        this.sql.exec(`INSERT OR IGNORE INTO trials (calendar_id, user_id, email_hash, subscription_id, started_at) VALUES (?, ?, ?, ?, ?)`,
            calendarId, userId, emailHash, subscriptionId, Date.now());
    }
    isTrialSubscription(id) { return this.sql.exec(`SELECT 1 FROM trials WHERE subscription_id = ?`, id).toArray().length > 0; }
    // Support (reset-trial): this calendar's trial subscriptions, and freeing its one trial.
    trialSubscriptionsFor(calendarId) {
        return this.sql.exec(`SELECT s.stripe_subscription_id AS id, s.status FROM subscriptions s JOIN trials t ON t.subscription_id = s.stripe_subscription_id
            WHERE t.calendar_id = ?`, calendarId).toArray();
    }
    resetTrial(calendarId) { this.sql.exec(`DELETE FROM trials WHERE calendar_id = ?`, calendarId); }
    // ---- the 7-day undo ----
    noteUpgrade(calendarId, author, byCreator) {
        this.sql.exec(`INSERT OR REPLACE INTO upgrades (calendar_id, user_id, author, by_creator, at, undone_at) VALUES (?, NULL, ?, ?, NULL, NULL)`,
            calendarId, author || null, byCreator ? 1 : 0);
    }
    markUpgraded(calendarId, userId) {
        this.sql.exec(`UPDATE upgrades SET at = ?, user_id = ? WHERE calendar_id = ? AND at IS NULL`, Date.now(), userId, calendarId);
    }
    getUpgrade(calendarId) { return this.sql.exec(`SELECT * FROM upgrades WHERE calendar_id = ?`, calendarId).toArray()[0] || null; }
    ageUpgrade(calendarId, ms) { this.sql.exec(`UPDATE upgrades SET at = at - ? WHERE calendar_id = ?`, ms, calendarId); }
    markUndone(calendarId) { this.sql.exec(`UPDATE upgrades SET undone_at = ? WHERE calendar_id = ?`, Date.now(), calendarId); }
    activeSubscriptionsFor(calendarId, userId) {
        return this.sql.exec(`SELECT stripe_subscription_id AS id, status FROM subscriptions WHERE calendar_id = ? AND user_id = ?`, calendarId, userId)
            .toArray().filter((r) => ACTIVE.has(r.status));
    }
    ownsOrOwned(calendarId, userId) {
        return this.sql.exec(`SELECT 1 FROM subscriptions WHERE calendar_id = ? AND user_id = ? LIMIT 1`, calendarId, userId).toArray().length > 0;
    }
    trialUsedForCalendar(calendarId) { return this.sql.exec(`SELECT 1 FROM trials WHERE calendar_id = ?`, calendarId).toArray().length > 0; }
    // Once per subscription, like claimWelcome: Stripe may send trial_will_end twice.
    // Once per key ('ended:<sub>', 'canceled:<sub>'): claimed before sending, so retried webhooks send nothing twice.
    claimNotice(k) {
        if (this.sql.exec(`SELECT 1 FROM notice_emails WHERE k = ?`, k).toArray().length) return false;
        this.sql.exec(`INSERT INTO notice_emails (k, at) VALUES (?, ?)`, k, Date.now());
        return true;
    }
    claimTrialReminder(subscriptionId) {
        if (this.sql.exec(`SELECT 1 FROM trial_reminders WHERE subscription_id = ?`, subscriptionId).toArray().length) return false;
        this.sql.exec(`INSERT INTO trial_reminders (subscription_id, at) VALUES (?, ?)`, subscriptionId, Date.now());
        return true;
    }
    // The calendar's current subscription for this owner (an active one wins), for /api/pro/status.
    subscriptionFor(calendarId, userId) {
        const rows = this.sql.exec(`SELECT status, trial_end, current_period_end, has_payment_method, stripe_customer_id FROM subscriptions WHERE calendar_id = ? AND user_id = ? ORDER BY updated_at DESC`, calendarId, userId).toArray();
        return rows.find((r) => ACTIVE.has(r.status)) || rows[0] || null;
    }

    // True only for the first caller per (calendar, owner): the welcome email is claimed before it
    // is sent, so two webhook events racing for the same new subscription can't both send it.
    claimWelcome(calendarId, userId) {
        if (this.sql.exec(`SELECT 1 FROM welcome_emails WHERE calendar_id = ? AND user_id = ?`, calendarId, userId).toArray().length) return false;
        this.sql.exec(`INSERT INTO welcome_emails (calendar_id, user_id, at) VALUES (?, ?, ?)`, calendarId, userId, Date.now());
        return true;
    }

    // For the health check: subscription counts by status, one row per calendar (an active
    // subscription wins over ended ones), and the sign-in funnel for the last 24 hours. Login
    // tokens are kept for a day past expiry, so the last 24 hours are all still here.
    healthSnapshot() {
        const now = Date.now();
        const byStatus = {};
        for (const r of this.sql.exec(`SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status`).toArray()) byStatus[r.status || 'unknown'] = r.n;
        const rows = this.sql.exec(`SELECT calendar_id, user_id, status, stripe_subscription_id FROM subscriptions ORDER BY updated_at DESC`).toArray();
        const byCal = new Map();
        for (const r of rows) {
            const have = byCal.get(r.calendar_id);
            if (!have || (!ACTIVE.has(have.status) && ACTIVE.has(r.status))) byCal.set(r.calendar_id, r);
        }
        const since = now - 24 * 3600 * 1000;
        const issued = this.sql.exec(`SELECT COUNT(*) AS n FROM login_tokens WHERE created_at > ?`, since).one().n;
        const consumed = this.sql.exec(`SELECT COUNT(*) AS n FROM login_tokens WHERE created_at > ? AND used = 1`, since).one().n;
        return {
            byStatus,
            calendars: [...byCal.values()].map((r) => ({ calendarId: r.calendar_id, userId: r.user_id, status: r.status, subscriptionId: r.stripe_subscription_id })),
            signIn: { issued, consumed },
        };
    }

    eventSeen(id) { return this.sql.exec(`SELECT 1 FROM processed_events WHERE event_id = ?`, id).toArray().length > 0; }
    markEvent(id) {
        const now = Date.now();
        this.sql.exec(`INSERT OR IGNORE INTO processed_events (event_id, at) VALUES (?, ?)`, id, now);
        this.sql.exec(`DELETE FROM processed_events WHERE at < ?`, now - 60 * 24 * 3600 * 1000);   // Stripe retries for 3 days
    }

    // Test inbox (TestInbox.js): kept 7 days, 500 messages at most, pruned on every insert.
    addTestMail(m, receivedAt = Date.now()) {
        this.sql.exec(`INSERT INTO test_inbox (to_addr, from_addr, subject, received_at, text, truncated, auth_results, arc_auth_results, has_dkim_signature)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.to, m.from, m.subject, receivedAt, m.text, m.truncated, m.authResults, m.arcAuthResults, m.hasDkimSignature);
        this.sql.exec(`DELETE FROM test_inbox WHERE received_at < ?`, Date.now() - TEST_INBOX_RETAIN_MS);
        this.sql.exec(`DELETE FROM test_inbox WHERE id NOT IN (SELECT id FROM test_inbox ORDER BY id DESC LIMIT ?)`, TEST_INBOX_MAX);
    }
    listTestMail(to, limit) {
        return to ? this.sql.exec(`SELECT * FROM test_inbox WHERE to_addr = ? ORDER BY id DESC LIMIT ?`, to, limit).toArray()
            : this.sql.exec(`SELECT * FROM test_inbox ORDER BY id DESC LIMIT ?`, limit).toArray();
    }
    clearTestMail(to) {
        const where = to ? ['WHERE to_addr = ?', to] : [''];
        const n = this.sql.exec(`SELECT COUNT(*) AS n FROM test_inbox ${where[0]}`, ...where.slice(1)).one().n;
        this.sql.exec(`DELETE FROM test_inbox ${where[0]}`, ...where.slice(1));
        return n;
    }
    // Dev mode only: placeholder messages, received ageMs ago, through the same pruning.
    seedTestMail(to, count, ageMs) {
        for (let i = 0; i < count; i++) this.addTestMail({ to, from: 'seed@example.com', subject: `seed ${i}`, text: '', truncated: 0,
            authResults: '', arcAuthResults: '', hasDkimSignature: 0 }, Date.now() - ageMs);
        return { total: this.sql.exec(`SELECT COUNT(*) AS n FROM test_inbox`).one().n };
    }

    // Dev mode only (see the file header).
    addOutbox(to, subject, text) { this.sql.exec(`INSERT INTO outbox (to_email, subject, text, at) VALUES (?, ?, ?, ?)`, to, subject, text, Date.now()); }
    listOutbox(to) { return this.sql.exec(`SELECT to_email, subject, text, at FROM outbox WHERE to_email = ? ORDER BY id`, to).toArray(); }
    expireLoginTokens(email) { this.sql.exec(`UPDATE login_tokens SET expires_at = ? WHERE email = ?`, Date.now() - 1, email); }
    ageSessions(email, ms) {
        this.sql.exec(`UPDATE sessions SET created_at = created_at - ?, expires_at = expires_at - ?, renewed_at = COALESCE(renewed_at, created_at) - ?
            WHERE user_id = (SELECT id FROM users WHERE email = ?)`, ms, ms, ms, email);
    }
    ageLoginTokens(email, ms) { this.sql.exec(`UPDATE login_tokens SET created_at = created_at - ?, expires_at = expires_at - ? WHERE email = ?`, ms, ms, email); }
}

// --- Worker side -------------------------------------------------------------------------------

const accounts = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const devMode = (env) => env.ACCOUNTS_DEV_MODE === '1';
const isAdmin = (request, env) => !!env.IMPORT_SECRET && timingSafeEqual(request.headers.get('Authorization') || '', `Bearer ${env.IMPORT_SECRET}`);

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
// send Origin on POST. Production accepts only pastecal.com (+ www), staging only its SITE_URL;
// dev mode also accepts localhost.
export function sameSite(request, env) {
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return false;
    const origin = request.headers.get('Origin') || '';
    if (allowedOrigins(env).includes(origin)) return true;
    // wrangler dev rewrites a same-host Origin (http://localhost:<port>) to http://<first route's host>.
    return devMode(env) && (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === 'http://pastecal.com');
}

const sessionCookie = (token, maxAge) => `pc_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
// Pay first: a random token in the browser that started a signed-out checkout. Stripe only ever sees
// its hash, so the checkout's id (in /pro/done's URL) is useless without this browser.
const CLAIM_MAX_AGE = 2 * 3600;
const claimCookie = (token, maxAge) => `pc_claim=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
function claimToken(request) {
    const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)pc_claim=([^;]+)/);
    return m && looksLikeToken(m[1]) ? m[1] : null;
}

// The one place a sign-in email leaves. Never logs the link: Workers Logs are on.
async function sendSignInEmail(env, to, token, next, kind) {
    const link = `${siteUrl(env)}/signin#t=${token}`;
    // Asked for in the middle of buying Pro (?pro=), or sent after paying while signed out with an email
    // that already had an account (kind 'paid'): say what the link is for. Never the calendar's name:
    // anyone can make us email any address, so nothing they chose goes in the message.
    const trial = typeof next === 'string' && /\?pro=trial$/.test(next);
    const buying = !trial && typeof next === 'string' && /\?pro=/.test(next), paid = kind === 'paid';
    // Checkout and the trial sell Plus (plan id 'pro'), so these name it.
    const subject = paid ? 'Your pastecal sign-in link: manage your upgraded calendar' : trial ? 'Your pastecal sign-in link: start your free Plus trial'
        : buying ? 'Your pastecal sign-in link: finish upgrading your calendar' : 'Your pastecal sign-in link';
    const lead = paid ? 'Thanks for upgrading. This email already has a pastecal account, so sign in here to get your editor link and manage your plan:'
        : trial ? `Here is your link to sign in and start your free ${TRIAL_DAYS}-day Plus trial. No card needed:`
        : buying ? 'Here is your link to sign in and finish upgrading your calendar. It takes you straight to payment:' : 'Here is your link to sign in to pastecal:';
    const text = `${lead}\n\n${link}\n\n`
        + `It works once and expires in 15 minutes.\n\n`
        + `If you didn't ask to sign in, you can ignore this email. Nothing will change.\n`;
    const html = `<p>${lead}</p><p><a href="${link}">${trial ? 'Sign in and start the trial' : buying ? 'Sign in and continue' : 'Sign in to pastecal'}</a></p>`
        + `<p>It works once and expires in 15 minutes.</p><p>If you didn't ask to sign in, you can ignore this email. Nothing will change.</p>`;
    await sendEmail(env, to, subject, text, html, 'sign-in');
}

// Every email leaves here, from login@pastecal.com; in dev mode it lands in the outbox instead.
// Never throws: a failed send is logged (without the body) and the caller carries on.
async function sendEmail(env, to, subject, text, html, kind) {
    try {
        if (devMode(env)) return await accounts(env).addOutbox(to, subject, text);
        if (!env.EMAIL) { console.error(`[accounts] EMAIL binding missing; ${kind} email not sent`); return; }
        // Staging sends from the same address (the sending domain is pastecal.com), marked so nobody mistakes it.
        const subj = isStaging(env) ? `[Preview] ${subject}` : subject;
        await env.EMAIL.send({ to, from: { email: 'login@pastecal.com', name: 'pastecal' }, subject: subj, text, ...(html ? { html } : {}) });
    } catch (err) {
        console.error(`[accounts] ${kind} email failed:`, err && err.code, err && err.message);
    }
}

// A calendar title is anyone's text: no control characters or line breaks (it goes in a header), short.
function cleanTitle(title, fallback) {
    const t = typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!t) return fallback;
    return t.length > 80 ? t.slice(0, 79).trimEnd() + '…' : t;
}

// Once per (calendar, owner), the first time the webhook locks it. Plain text, no key, no token:
// the owner makes editor links from the calendar itself.
async function sendWelcomeEmail(env, acc, calendarId, userId, title, trialEnd = null, hasCard = null, plan = 'pro') {
    try {
        if (!(await acc.claimWelcome(calendarId, userId))) return;
        const user = await acc.getUser(userId);
        if (!user || !user.email) return;
        const name = cleanTitle(title, cleanTitle(calendarId, 'your calendar'));
        const link = `${siteUrl(env)}/${encodeURIComponent(calendarId)}`;
        const trialLine = !trialEnd ? '' : hasCard === false
            ? `Your free trial runs until ${formatDay(trialEnd)}. No card is on file, so nothing will be charged. We'll email you a few days before it ends.\n\n`
            : `Your free trial runs until ${formatDay(trialEnd)}. We'll email you a few days before it ends.\n\n`;
        const P = planName(plan);
        const text = `${P} is on for ${name}.\n\n${trialLine}`
            + `${link}\n\n`
            + `Who can edit now: only you (signed in with this email) and people with an editor link. Everyone else can still view it.\n\n`
            + `To give someone editor access: open the calendar, choose the Plus tab, and copy the Editor link. You can reset or revoke editor links there at any time.\n\n`
            + `To manage billing: open the calendar's Plus tab, or the logo menu, and choose Manage billing. You can also sign in at ${siteHost(env)} with this email.\n\n`
            + `Questions? Write to support@pastecal.com.\n`;
        await sendEmail(env, user.email, trialEnd ? `Your ${P} trial is on for ${name}` : `${P} is on for ${name}`, text, null, 'welcome');
    } catch (err) {
        console.error('[accounts] welcome email failed:', err && err.message);
    }
}

// The owner hears when their plan changes on its own: a trial or plan ended (and what the calendar is now),
// or they canceled in the portal (when it ends, and what happens then). Plain, short, once per subscription.
async function sendPlanNotice(env, acc, kind, s, calendarId, userId, { paused = false } = {}) {
    try {
        if (!(await acc.claimNotice(`${kind}:${s.id}`))) return;
        const user = await acc.getUser(userId);
        if (!user || !user.email) return;
        const st = await LockClient.lockStatus(env, calendarId);
        const name = cleanTitle(st.title, cleanTitle(calendarId, 'your calendar'));
        const row = await acc.getSubscription(s.id);
        const P = planName(row && row.plan);
        const link = `${siteUrl(env)}/${encodeURIComponent(calendarId)}`;
        const now = paused
            ? `${name} is now read-only: everyone can still view it and follow it in their calendar app, but nobody can edit it until you choose. `
            : `${name} is a free calendar again: anyone with the edit link can change it. `;
        let subject, text;
        if (kind === 'canceled') {
            const day = s.currentPeriodEnd ? formatDay(s.currentPeriodEnd) : 'the end of the period you paid for';
            const then = st.lapsedMode === 'open' && st.lapsedModeChosen ? 'a free calendar anyone with the edit link can change' : 'read-only (everyone can view, nobody edits until you choose)';
            subject = `${P} for ${name} ends ${day}`;
            text = `You canceled ${P} for ${name}. Nothing else will be charged.\n\n`
                + `It stays upgraded until ${day}. Then it becomes ${then}. You can change that, or keep ${P}, from the calendar's Plus tab:\n${link}\n\n`
                + `Questions? Write to support@pastecal.com.\n`;
        } else {
            subject = kind === 'trial-ended' ? `Your ${P} trial for ${name} ended` : `${P} for ${name} ended`;
            text = (kind === 'trial-ended' ? `Your ${P} trial for ${name} ended. Nothing was charged.\n\n` : `${P} for ${name} ended.\n\n`)
                + now + `\n\nTo keep ${P}${paused ? ' or open it to everyone' : ''}, open the calendar's Plus tab:\n${link}\n\n`
                + `Questions? Write to support@pastecal.com.\n`;
        }
        await sendEmail(env, user.email, subject, text, null, 'plan-notice');
    } catch (err) {
        console.error('[accounts] plan notice failed:', err && err.message);
    }
}

// "October 24, 2026" for a Stripe timestamp (seconds) or ms. UTC, so the date doesn't depend on the server.
function formatDay(t) {
    const ms = t < 1e12 ? t * 1000 : t;
    return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Does this subscription's payer have a card Stripe will charge (the subscription's own, or the customer's
// default)? null when Stripe can't say. Used so trial emails never promise "nothing is charged" falsely.
// Pro can be bought here: Stripe is configured with the yearly price (Pro is yearly only; a monthly
// price, if set, is still honored for old links). Off, every Pro offer is "Join the beta"
// (GET /api/pro/config), and checkout and the trial answer 503 billing-not-configured as before.
function billingOn(env, host) {
    const cfg = stripeConfig(env, host);
    return !!(cfg && cfg.prices.year);
}

async function payerHasCard(cfg, s) {
    if (s.hasPaymentMethod) return true;
    if (!cfg || !s.customer) return false;
    const c = await stripeRequest(cfg, 'GET', `/v1/customers/${encodeURIComponent(s.customer)}`);
    if (!c.ok) return null;
    return !!((c.data.invoice_settings && c.data.invoice_settings.default_payment_method) || c.data.default_source);
}

// Day 27 of a trial (Stripe's customer.subscription.trial_will_end): one email, ever, per subscription.
// Skipped when a card is already on file (the trial simply becomes paid Pro).
async function sendTrialReminder(env, acc, cfg, s) {
    try {
        if (s.status !== 'trialing') return;
        const card = await payerHasCard(cfg, s);
        const row = await acc.getSubscription(s.id);
        const calendarId = row && row.calendar_id, userId = row && row.user_id;
        if (!validId(calendarId) || !userId) return;
        const user = await acc.getUser(userId);
        if (!user || !user.email) return;
        if (!(await acc.claimTrialReminder(s.id))) return;
        const st = await LockClient.lockStatus(env, calendarId);
        const name = cleanTitle(st.title, cleanTitle(calendarId, 'your calendar'));
        const day = formatDay(s.trialEnd || s.currentPeriodEnd);
        // A plain link to the calendar (a Billing Portal link would expire): it opens the Plus tab, which has Keep Plus.
        const keep = `${siteUrl(env)}/${encodeURIComponent(calendarId)}?pro=keep`;
        const P = planName(row.plan);
        if (card !== false) {
            // A card is on file (or Stripe couldn't say): never promise that nothing is charged.
            const text = `Your ${P} trial for ${name} ends ${day}.\n\n`
                + `A card is on file for this subscription, so ${P} continues after ${day} and the card is charged then. To change or cancel it, open the calendar's Plus tab and choose Manage billing:\n${keep}\n\n`
                + `Questions? Write to support@pastecal.com.\n`;
            return await sendEmail(env, user.email, `Your ${P} trial ends ${day}`, text, null, 'trial-reminder');
        }
        const text = `Your ${P} trial for ${name} ends ${day}.\n\n`
            + `Keep ${P}: $29 a year, and nothing changes.\n${keep}\n\n`
            + (st.lapsedModeChosen && st.lapsedMode === 'readonly'
                ? `If you do nothing, nothing is charged. On ${day} ${P} ends and, as you chose, the calendar becomes read-only: everyone can still view it and its calendar feed keeps working, but nobody can edit it until you open it or keep ${P}, from the calendar's Plus tab.\n\n`
                : `If you do nothing, nothing is charged. On ${day} ${P} ends and the calendar goes back to a free calendar anyone with the edit link can change. To make it read-only instead, choose that in the calendar's Plus tab.\n\n`)
            + `Questions? Write to support@pastecal.com.\n`;
        await sendEmail(env, user.email, `Your ${P} trial ends ${day}`, text, null, 'trial-reminder');
    } catch (err) {
        console.error('[accounts] trial reminder failed:', err && err.message);
    }
}

async function readJson(request) {
    const body = await request.json().catch(() => null);
    return body && typeof body === 'object' ? body : null;
}

// Returns a Response for every accounts/billing path, or null for paths it doesn't own.
export async function handleAccounts(request, env, url) {
    const path = url.pathname;
    const owned = path === '/api/me' || path === '/api/stripe/webhook' || path.startsWith('/api/auth/') || path === '/api/account/delete'
        || path.startsWith('/api/pro/') || path.startsWith('/api/admin/accounts/') || path === '/api/admin/pro/health';
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
    if (path === '/api/admin/pro/health') {
        if (!isAdmin(request, env)) return new Response('forbidden', { status: 403 });
        return m === 'GET' ? json(await proHealth(env)) : json({ error: 'method' }, 405);
    }
    if (path === '/api/me') {
        if (m !== 'GET') return json({ error: 'method' }, 405);
        // Not sessionUserId: this needs renewedAt. The socket or /api/pro/status may have renewed the
        // session moments before on the same page load, so "renewed in the last day" re-sends the cookie
        // (same token, fresh Max-Age), not only "renewed by this request".
        const token = cookieToken(request);
        const s = token && await accounts(env).sessionUser(token);
        const me = s && await accounts(env).me(s.userId);
        if (!me) return json({ error: 'signed-out' }, 401);
        return json(me, 200, Date.now() - s.renewedAt < SESSION_RENEW_AFTER ? { 'Set-Cookie': sessionCookie(token, COOKIE_MAX_AGE) } : {});
    }
    if (path === '/api/pro/config') {
        if (m !== 'GET') return json({ error: 'method' }, 405);
        return json({ billing: billingOn(env, url.hostname) }, 200, { 'Cache-Control': 'public, max-age=60' });
    }
    if (path === '/api/pro/status') {
        if (m !== 'GET') return json({ error: 'method' }, 405);
        const id = url.searchParams.get('calendar');
        if (!validId(id)) return json({ error: 'bad-calendar' }, 400);
        const [st, userId] = await Promise.all([LockClient.lockStatus(env, id), sessionUserId(request, env)]);
        if (st.status === 404) return json({ locked: false, pro: false, plan: null, isOwner: false, paused: false, lapsedOwner: false, trialUsed: false });
        if (!st.ok && st.status >= 500) return json({ error: 'unavailable' }, 502);
        const locked = !!st.locked, isOwner = !!(locked && userId && st.ownerId === userId);
        const lapsed = !locked && st.lapsed ? st.lapsed : null;
        // plan: the lock's plan id, for its display name (Plans.js): 'pro' is Plus, 'unlimited' is Pro.
        const out = { locked, pro: locked && st.plan === 'pro', plan: locked ? (st.plan || 'pro') : null, isOwner, paused: !!(lapsed && lapsed.mode === 'readonly'),
            lapsedOwner: !!(lapsed && userId && lapsed.ownerId === userId), trialUsed: await accounts(env).trialUsedForCalendar(id) };
        if (out.lapsedOwner) {
            // Which words the owner sees: "Trial ended" or "Pro ended".
            const sub = await accounts(env).subscriptionFor(id, userId);
            out.lapsedTrial = !!(sub && sub.trial_end && !sub.has_payment_method);
            out.plan = (sub && sub.plan) || 'pro';           // which plan ended, for "Plus ended" / "Pro ended"
        }
        if (isOwner) {
            const sub = await accounts(env).subscriptionFor(id, userId);
            // Not chosen yet: a trial ends open, a paid plan read-only (CalendarRoom unlock).
            out.lapsedMode = st.lapsedModeChosen === false ? (sub && sub.status === 'trialing' ? 'open' : 'readonly') : (st.lapsedMode || 'readonly');
            if (sub && sub.status === 'trialing') {
                const cfg = stripeConfig(env, url.hostname);
                const card = await payerHasCard(cfg, { hasPaymentMethod: !!sub.has_payment_method, customer: sub.stripe_customer_id });
                out.trial = { endsAt: sub.trial_end || sub.current_period_end || null, hasCard: card !== false };
            }
        }
        return json(out);
    }
    if (path === '/api/pro/editor-links' && m === 'GET') {
        const calendarId = url.searchParams.get('calendar');
        const o = await requireOwner(request, env, calendarId);
        if (o.res) return o.res;
        const r = await LockClient.listEditorLinks(env, calendarId, o.userId);
        if (!r.ok || !Array.isArray(r.links)) return roomError(r);
        return json(r.links);
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
        // Only "/" or a calendar on this site: no open redirect, and no /pro/... page (see safeNext).
        const next = safeNext(body.next);
        const token = await accounts(env).issueLoginToken(email, next);
        if (token) await sendSignInEmail(env, email, token, next);
        return json({ ok: true });
    }
    if (path === '/api/auth/peek') {
        // Same answer for a made-up, used or expired link: it only says the email of a link that works.
        const bad = () => json({ ok: false, error: 'This sign-in link has expired or was already used. Ask for a new one.' }, 400);
        if (env.CREATE_LIMITER) {
            const { success } = await env.CREATE_LIMITER.limit({ key: 'peek:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
            if (!success) return json({ ok: false, error: 'Too many tries. Wait a minute and open the link again.' }, 429);
        }
        if (!looksLikeToken(body.token)) return bad();
        const peeked = await accounts(env).peekLoginToken(body.token);
        if (!peeked) return bad();
        // What Continue will do, so the page can say it (never the calendar's name: anyone can make us send a link).
        const kind = /\?pro=trial$/.test(peeked.next || '') ? 'trial' : /\?pro=keep$/.test(peeked.next || '') ? 'keep' : /\?pro=year$/.test(peeked.next || '') ? 'buy' : null;
        return json({ ok: true, email: peeked.email, ...(kind ? { kind } : {}) });
    }
    if (path === '/api/auth/verify') {
        if (!looksLikeToken(body.token)) return json({ ok: false, error: 'This sign-in link is not valid. Ask for a new one.' }, 400);
        const out = await accounts(env).consumeLoginToken(body.token);
        if (!out) return json({ ok: false, error: 'This sign-in link has expired or was already used. Ask for a new one.' }, 400);
        // A link asked for from "Try Pro free": signing in starts the trial (the calendar page shows how it went).
        let trial;
        const tm = typeof out.next === 'string' && /^\/([^/?]+)\?pro=trial$/.exec(out.next);
        if (tm) {
            const s = await accounts(env).sessionUser(out.session);
            // body.author: the calendar page's author uid when it has one; without it the trial waits for the
            // calendar page, which starts it with the uid (Pro.js startTrial).
            const [status, res] = s ? await startTrial(request, env, s.userId, decodeURIComponent(tm[1]), body.author) : [401, { error: 'signed-out' }];
            trial = status === 200 ? { ok: true } : { ok: false, error: res.error };
        }
        return json({ ok: true, email: out.email, next: out.next || null, ...(trial ? { trial } : {}) }, 200, { 'Set-Cookie': sessionCookie(out.session, COOKIE_MAX_AGE) });
    }
    if (path === '/api/auth/signout') {
        const token = cookieToken(request);
        if (token) await accounts(env).endSession(token);
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }
    if (path === '/api/auth/signout-all') return signOutAll(request, env);
    if (path === '/api/account/delete') return deleteAccount(request, env);

    if (path === '/api/pro/checkout') return checkout(request, env, body);
    if (path === '/api/pro/trial') {
        const userId = await sessionUserId(request, env);
        if (!userId) return json({ error: 'signed-out' }, 401);
        const [status, res] = await startTrial(request, env, userId, body.calendarId, body.author);
        return json(res, status);
    }
    if (path === '/api/pro/lapsed-mode') return setLapsedMode(request, env, body);
    if (path === '/api/pro/upgrade-notice') return upgradeNotice(request, env, body);
    if (path === '/api/pro/undo-upgrade') return undoUpgrade(request, env, body);
    if (path === '/api/pro/claim') return claimCheckout(request, env, body);
    if (path === '/api/pro/portal') {
        const cfg = stripeConfig(env, new URL(request.url).hostname);
        if (!cfg) return json({ error: 'billing-not-configured' }, 503);
        const userId = await sessionUserId(request, env);
        if (!userId) return json({ error: 'signed-out' }, 401);
        // The calendar's own subscription's customer (each trial has its own customer); none named: the account's.
        const sub = validId(body.calendarId) ? await accounts(env).subscriptionFor(body.calendarId, userId) : null;
        const customer = validId(body.calendarId) ? (sub && sub.stripe_customer_id) || null : await accounts(env).customerForUser(userId);
        if (!customer) return json({ error: 'no-billing-account' }, 404);
        const site = siteUrl(env);
        const returnUrl = validId(body.calendarId) ? `${site}/${encodeURIComponent(body.calendarId)}` : `${site}/`;
        const params = { customer, return_url: returnUrl };
        // Keep Pro during a trial: straight to adding a card (the trial then becomes paid Pro when it ends).
        if (body.flow === 'add-card') params.flow_data = { type: 'payment_method_update', after_completion: { type: 'redirect', redirect: { return_url: returnUrl } } };
        const r = await stripeRequest(cfg, 'POST', '/v1/billing_portal/sessions', params);
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
    if (path === '/api/pro/editor-links') {
        const o = await requireOwner(request, env, body.calendarId);
        if (o.res) return o.res;
        if (typeof body.label !== 'string' || !body.label.trim() || body.label.trim().length > 40) return json({ error: 'bad-label' }, 400);
        const r = await LockClient.createEditorLink(env, body.calendarId, o.userId, body.label);
        if (!r.ok || !r.editorKey) return roomError(r);
        return json({ id: r.id, label: r.label, createdAt: r.createdAt, url_fragment_key: r.editorKey });
    }
    if (path === '/api/pro/editor-links/revoke') {
        const o = await requireOwner(request, env, body.calendarId);
        if (o.res) return o.res;
        if (typeof body.id !== 'string' || !body.id || body.id.length > 100) return json({ error: 'no-link' }, 404);
        const r = await LockClient.revokeEditorLink(env, body.calendarId, o.userId, body.id);
        return r.ok ? json({ ok: true }) : roomError(r);
    }
    if (path === '/api/pro/settings') {
        const o = await requireOwner(request, env, body.calendarId);
        if (o.res) return o.res;
        const r = await LockClient.setProSettings(env, body.calendarId, o.userId, body.settings);
        return r.ok ? json({ ok: true, settings: r.settings }) : roomError(r);
    }
    return json({ error: 'not-found' }, 404);
}

// The signed-in owner of a locked calendar: {userId}, or {res} to send back. The room checks the
// owner id again on every owner-only route.
// POST /api/auth/signout-all and /api/account/delete (session + CSRF, checked by route()). Kept apart
// from the sign-in and checkout code above.
async function signOutAll(request, env) {
    const userId = await sessionUserId(request, env);
    if (!userId) return json({ error: 'signed-out' }, 401);
    const sessionsEnded = await accounts(env).endAllSessions(userId);
    return json({ ok: true, sessionsEnded }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}
async function deleteAccount(request, env) {
    const userId = await sessionUserId(request, env);
    if (!userId) return json({ error: 'signed-out' }, 401);
    const r = await accounts(env).deleteAccount(userId);
    if (r.active) return json({ error: 'active-subscription', calendars: r.active,
        message: 'Cancel your plan first (Manage billing), then delete your account.' }, 409);
    return json({ ok: true, deleted: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function requireOwner(request, env, calendarId) {
    const userId = await sessionUserId(request, env);
    if (!userId) return { res: json({ error: 'signed-out' }, 401) };
    if (!validId(calendarId)) return { res: json({ error: 'bad-calendar' }, 400) };
    const st = await LockClient.lockStatus(env, calendarId);
    if (st.status === 404) return { res: json({ error: 'no-calendar' }, 404) };
    if (!st.ok) return { res: json({ error: 'unavailable' }, 502) };
    if (!st.locked) return { res: json({ error: 'not-locked' }, 409) };
    if (st.ownerId !== userId) return { res: json({ error: 'not-owner' }, 403) };
    return { userId };
}
// A room's refusal, passed on: its 4xx status and error (and message, for bad-settings); 502 otherwise.
function roomError(r) {
    if (r.status >= 400 && r.status < 500) return json({ error: r.error || 'refused', ...(r.message ? { message: r.message } : {}) }, r.status);
    return json({ error: 'unavailable' }, 502);
}

// Stripe requires a Checkout page to live at least 30 minutes from when IT creates the session,
// so ask for 31 to absorb clock drift and network time. The per-calendar hold lasts as long.
const CHECKOUT_HOLD_MS = 31 * 60 * 1000;
export const TEST_CARD_HINT = 'Test mode: use card 4242 4242 4242 4242, any future date, any CVC. No real money moves.';

// POST /api/pro/claim {sessionId}: /pro/done, in the browser that paid while signed out. Signs it in
// when the checkout is paid, carries this browser's claim, is recent, was never claimed, and made a
// new account. An email that already had an account gets a sign-in link instead: Stripe never
// verified it, so a typed address must not open someone else's account.
async function claimCheckout(request, env, body) {
    const cfg = stripeConfig(env, new URL(request.url).hostname);
    if (!cfg) return json({ error: 'billing-not-configured' }, 503);
    const claim = claimToken(request);
    if (!claim) return json({ error: 'no-claim' }, 403);
    const sessionId = body.sessionId;
    if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) return json({ error: 'bad-session' }, 400);
    const r = await stripeRequest(cfg, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (!r.ok) return json({ error: r.status === 404 ? 'no-session' : 'stripe-error' }, r.status === 404 ? 404 : 502);
    const sess = r.data, hash = await sha256(claim);
    const mine = sess.metadata && typeof sess.metadata.claim === 'string' && timingSafeEqual(sess.metadata.claim, hash);
    const paid = sess.status === 'complete' && (sess.payment_status === 'paid' || sess.payment_status === 'no_payment_required');
    const recent = Number.isFinite(sess.created) && Date.now() / 1000 - sess.created < CLAIM_MAX_AGE;
    if (!mine || !paid || !recent) return json({ error: 'not-claimable' }, 403);
    const email = String((sess.customer_details && sess.customer_details.email) || sess.customer_email || '').trim().toLowerCase();
    if (!validEmail(email)) return json({ error: 'no-email' }, 409);
    const acc = accounts(env);
    const out = await acc.claimCheckout(hash, sess.id, email);
    if (out.used) return json({ error: 'already-claimed' }, 409);
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', claimCookie('', 0));
    if (out.existing) {
        const calendarId = sess.metadata && sess.metadata.calendar_id;
        const token = await acc.issueLoginToken(email, safeNext('/' + encodeURIComponent(calendarId || '')) || '/');
        if (token) await sendSignInEmail(env, email, token, null, 'paid');
        return Response.json({ ok: true, signedIn: false, email }, { headers });
    }
    headers.append('Set-Cookie', sessionCookie(out.session, COOKIE_MAX_AGE));
    return Response.json({ ok: true, signedIn: true, email }, { headers });
}

// Trial and checkout are for an editor of record (CalendarRoom editor-of-record: the browser that created
// the calendar, or one that edited it on 2+ days), or an account that already owns it. Knowing the URL is
// not enough: anyone can edit a free calendar. -> {res: null | 403 body, creator}
const NOT_EDITOR = 'To upgrade, use a device you’ve edited this calendar on, or ask the person who runs it.';
async function editorCheck(env, calendarId, author, userId) {
    const r = await LockClient.editorOfRecord(env, calendarId, typeof author === 'string' ? author.slice(0, 128) : '');
    const creator = !!(r.ok && r.creator);
    if (r.ok && r.editor) return { res: null, creator };
    if (userId && await accounts(env).ownsOrOwned(calendarId, userId)) return { res: null, creator };
    return { res: { error: 'not-an-editor', message: NOT_EDITOR }, creator };
}

// POST /api/pro/trial, and a "Try Pro free" sign-in link's verify. -> [status, body]
// A direct subscription with a 30-day trial and no payment method (Stripe ends it, canceled, if no card
// was added: trial_settings.end_behavior.missing_payment_method=cancel). It is applied at once, so the
// calendar is locked before this answers; the webhook's copy of the same events changes nothing.
async function startTrial(request, env, userId, calendarId, author) {
    if (env.BETA_REAL_DATA) return [403, { error: 'buy-on-live', message: 'Plus is started on pastecal.com. The beta shows the new design on your real calendars.' }];
    const cfg = stripeConfig(env, new URL(request.url).hostname);
    if (!cfg) return [503, { error: 'billing-not-configured' }];
    if (!validId(calendarId)) return [400, { error: 'bad-calendar' }];
    const price = cfg.prices.year;
    if (!price) return [503, { error: 'billing-not-configured' }];
    const acc = accounts(env);
    const user = await acc.getUser(userId);
    if (!user) return [401, { error: 'signed-out' }];
    // Saved calendars only: a draft (only in one browser) has no room yet, so it answers 404.
    const st = await LockClient.lockStatus(env, calendarId);
    if (st.status === 404) return [404, { error: 'no-calendar' }];
    if (!st.ok) return [502, { error: 'unavailable' }];
    if (st.locked) {
        if (st.ownerId !== userId) return [409, { error: 'locked-by-other' }];
        const sub = await acc.subscriptionFor(calendarId, userId);           // pressed twice, or the link opened twice
        return sub && sub.status === 'trialing' ? [200, { ok: true, already: true, trialEnd: sub.trial_end || null }] : [409, { error: 'already-pro' }];
    }
    if (st.lapsed && st.lapsed.mode === 'readonly' && st.lapsed.ownerId !== userId) return [409, { error: 'locked-by-other' }];
    const ownPaused = !!(st.lapsed && st.lapsed.ownerId === userId);
    const ed = ownPaused ? { res: null, creator: true } : await editorCheck(env, calendarId, author, userId);
    if (ed.res) return [403, ed.res];
    const claim = await acc.claimTrial(calendarId, userId, await sha256(user.email));
    // A finished trial of this person's on this calendar counts as used too.
    const err = claim.error || (claim.retry && claim.subscriptionId ? 'trial-used-calendar' : null);
    if (err) return [409, { error: err, message: TRIAL_ERRORS[err] }];
    const failed = async (r, what) => {
        console.error('[accounts] trial', what, 'failed:', r.status, r.data && r.data.error && r.data.error.code);
        if (!retryable(r)) await acc.releaseTrial(calendarId, userId);   // nothing was made; a retry reuses the idempotency key anyway
        return [502, { error: 'stripe-error' }];
    };
    // Its own customer, never the person's existing one: Stripe would charge a saved card at the end, and
    // the trial promises nothing is charged unless they choose Keep Pro.
    const c = await stripeRequest(cfg, 'POST', '/v1/customers', { email: user.email, metadata: { user_id: userId, trial_calendar: calendarId } },
        { idempotencyKey: `trial-customer-${calendarId}-${userId}` });
    if (!c.ok || !c.data.id) return failed(c, 'customer');
    const customer = c.data.id;
    const r = await stripeRequest(cfg, 'POST', '/v1/subscriptions', {
        customer,
        items: [{ price, quantity: 1 }],
        trial_period_days: TRIAL_DAYS,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata: { calendar_id: calendarId, user_id: userId, trial: '1' },
    }, { idempotencyKey: `trial-${calendarId}-${userId}` });
    if (!r.ok || !r.data.id) return failed(r, 'subscription');
    await acc.setTrialSubscription(calendarId, r.data.id);
    if (!ownPaused) await acc.noteUpgrade(calendarId, author, ed.creator);       // for the 7-day undo (marked when the lock lands)
    const s = summarizeSubscription(r.data);
    const outcome = await applySubscription(env, acc, cfg, s);
    const now = await LockClient.lockStatus(env, calendarId);
    if (outcome.retry || !(now.locked && now.ownerId === userId)) {
        // The trial exists; the webhook locks it on Stripe's retry. Say so rather than pretend.
        console.warn('[accounts] trial started but not locked yet:', calendarId);
        return [502, { error: 'unavailable', started: true }];
    }
    return [200, { ok: true, trialEnd: s.trialEnd }];
}

// ---- The 7-day undo. Someone who isn't the calendar's creator upgraded it (an editor of record on
// another device, or a stranger who got past the check). For 7 days the creator's browser and other
// editors of record see a notice with Undo; undoing cancels the subscription (refunding any payment),
// unlocks it as a normal free calendar, logs it in Activity, and frees its trial. After 7 days only
// support can (POST /api/admin/accounts/reset-trial).
// -> {row, st} when this author may undo it now, else {error:[status, body]}.
async function undoable(env, calendarId, author) {
    if (!validId(calendarId)) return { error: [400, { error: 'bad-calendar' }] };
    const acc = accounts(env);
    const row = await acc.getUpgrade(calendarId);
    const st = await LockClient.lockStatus(env, calendarId);
    if (!row || !row.at || row.undone_at || row.by_creator || !st.locked || st.ownerId !== row.user_id) return { error: [404, { error: 'nothing-to-undo' }] };
    const uid = typeof author === 'string' ? author.slice(0, 128) : '';
    if (!uid || uid === row.author) return { error: [403, { error: 'not-an-editor' }] };
    const r = await LockClient.editorOfRecord(env, calendarId, uid);
    if (!(r.ok && r.editor)) return { error: [403, { error: 'not-an-editor' }] };
    if (Date.now() - row.at > UNDO_DAYS * 86400000) return { error: [410, { error: 'too-late', message: 'It’s been more than 7 days. Write to support@pastecal.com and we’ll sort it out.' }] };
    return { row, st };
}
// POST /api/pro/upgrade-notice {calendarId, author} -> {notice: {at} | null}. POST so the uid stays out of URLs.
async function upgradeNotice(request, env, body) {
    const u = await undoable(env, body.calendarId, body.author);
    return json({ notice: u.error ? null : { at: u.row.at } });
}
// POST /api/pro/undo-upgrade {calendarId, author} -> {ok, refunded}
async function undoUpgrade(request, env, body) {
    const u = await undoable(env, body.calendarId, body.author);
    if (u.error) return json(u.error[1], u.error[0]);
    const { row } = u, calendarId = body.calendarId;
    const acc = accounts(env);
    const cfg = stripeConfig(env, new URL(request.url).hostname);
    let refunded = false;
    for (const sub of await acc.activeSubscriptionsFor(calendarId, row.user_id)) {
        if (!cfg) return json({ error: 'billing-not-configured' }, 503);
        const g = await stripeRequest(cfg, 'GET', `/v1/subscriptions/${encodeURIComponent(sub.id)}`);
        if (!g.ok) return json({ error: 'stripe-error' }, 502);
        const out = await refundConflict(acc, cfg, summarizeSubscription(g.data), 'undo', true);
        if (out.retry) return json({ error: 'stripe-error' }, 502);
        refunded = refunded || !(await acc.isTrialSubscription(sub.id));
    }
    const un = await LockClient.unlock(env, calendarId, row.user_id, { undo: true });   // a plain unlock: open, not paused
    if (!un.ok) return json({ error: 'unavailable' }, 502);
    await acc.markUndone(calendarId);
    await acc.resetTrial(calendarId);                                                    // the trial was never really used
    console.log('[accounts] upgrade undone by an editor of record:', calendarId);
    return json({ ok: true, refunded });
}

// POST /api/pro/lapsed-mode {calendarId, mode:'readonly'|'open'}: what happens when Pro ends (owner,
// while locked), or, once it has ended and the calendar is paused, 'open' ends the pause.
async function setLapsedMode(request, env, body) {
    const userId = await sessionUserId(request, env);
    if (!userId) return json({ error: 'signed-out' }, 401);
    if (!validId(body.calendarId)) return json({ error: 'bad-calendar' }, 400);
    if (body.mode !== 'readonly' && body.mode !== 'open') return json({ error: 'bad-mode' }, 400);
    const r = await LockClient.setLapsedMode(env, body.calendarId, userId, body.mode);
    if (r.status === 404 && !r.error) return json({ error: 'no-calendar' }, 404);
    return r.ok ? json({ ok: true, mode: r.mode, paused: !!r.paused }) : roomError(r);
}

async function checkout(request, env, body) {
    // The beta (preview.pastecal.com) runs on live calendars with Stripe in test mode: a test card must
    // never lock a real calendar, so Pro is bought on pastecal.com.
    if (env.BETA_REAL_DATA) return json({ error: 'buy-on-live', message: 'Plus is bought on pastecal.com. The beta shows the new design on your real calendars.' }, 403);
    const cfg = stripeConfig(env, new URL(request.url).hostname);
    if (!cfg) return json({ error: 'billing-not-configured' }, 503);
    const userId = await sessionUserId(request, env);
    // Signed out: pay first. The buyer is this browser's claim token until Stripe tells us their email.
    const claim = userId ? null : (claimToken(request) || randomToken());
    const claimHash = claim ? await sha256(claim) : null;
    const buyer = userId || 'anon:' + claimHash;
    // Signed out costs nothing to repeat, and each checkout holds the calendar for 31 minutes: limit it
    // per address so nobody can keep a calendar's real owner from buying.
    if (!userId && env.CREATE_LIMITER) {
        const { success } = await env.CREATE_LIMITER.limit({ key: 'checkout:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
        if (!success) return json({ error: 'too-many-checkouts' }, 429);
    }
    const calendarId = body.calendarId;
    if (!validId(calendarId)) return json({ error: 'bad-calendar' }, 400);
    const interval = body.interval === undefined ? 'year' : body.interval;
    // Plus (plan id 'pro') is yearly only. A monthly price, if still configured, is never sold.
    if (interval !== 'year' || !Object.hasOwn(INTERVALS, interval)) return json({ error: 'bad-interval', message: 'Plus is yearly: $29 a year.' }, 400);
    const price = cfg.prices[interval];
    if (!price) return json({ error: 'billing-not-configured' }, 503);

    // v1: they have the calendar open; it must exist and not be someone else's.
    const st = await LockClient.lockStatus(env, calendarId);
    if (st.status === 404) return json({ error: 'no-calendar' }, 404);
    if (!st.ok) return json({ error: 'unavailable' }, 502);
    // Keep Pro during a trial: the owner buys as usual; the paid subscription replaces the trial (applySubscription).
    const trialSub = st.locked && userId && st.ownerId === userId ? await accounts(env).subscriptionFor(calendarId, userId) : null;
    const keepingTrial = !!(trialSub && trialSub.status === 'trialing');
    if (st.locked && !keepingTrial) return json({ error: userId && st.ownerId === userId ? 'already-pro' : 'locked-by-other' }, 409);
    // Paused after Pro: only its owner can buy it back (signed out can't prove that; the room refuses others too).
    if (st.lapsed && st.lapsed.mode === 'readonly' && st.lapsed.ownerId !== userId) return json({ error: userId ? 'locked-by-other' : 'signed-out' }, userId ? 409 : 401);
    // Only an editor of record (or the account that owns it) upgrades it. Keeping one's own trial and buying
    // back one's own paused calendar are already the owner's.
    const ownsIt = keepingTrial || !!(userId && st.lapsed && st.lapsed.ownerId === userId);
    const ed = ownsIt ? null : await editorCheck(env, calendarId, body.author, userId);
    if (ed && ed.res) return json(ed.res, 403);

    const acc = accounts(env);
    // Keep during a trial: that trial's customer. Anything else: a paid customer only, never another trial's.
    const [user, customer] = userId ? await Promise.all([acc.getUser(userId), keepingTrial ? trialSub.stripe_customer_id : acc.paidCustomerForUser(userId)]) : [null, null];
    if (userId && !user) return json({ error: 'signed-out' }, 401);
    const hold = await acc.holdCheckout(calendarId, buyer, CHECKOUT_HOLD_MS);
    if (!hold.ok) return json({ error: hold.error }, hold.error === 'too-many-checkouts' ? 429 : 409);
    // A restart: expire the previous page first, so two pages for one calendar can never both take a payment.
    if (hold.previousSession) {
        const path = `/v1/checkout/sessions/${encodeURIComponent(hold.previousSession)}`;
        const x = await stripeRequest(cfg, 'POST', path + '/expire');
        if (!x.ok) {
            const g = await stripeRequest(cfg, 'GET', path);
            if (!(g.ok && g.data.status === 'expired')) {
                console.warn('[accounts] could not expire the previous checkout page:', x.status, g.ok ? g.data.status : g.status);
                return json({ error: 'checkout-in-progress' }, 409);
            }
        }
    }
    const back = validId(body.editName) ? body.editName : calendarId;
    const meta = userId ? { calendar_id: calendarId, user_id: userId } : { calendar_id: calendarId, claim: claimHash };
    const params = {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        // Card only (Apple Pay and Google Pay ride on it): no Cash App or bank options to scan past.
        payment_method_types: ['card'],
        wallet_options: { link: { display: 'never' } },   // no "save with Link" phone box or Link bank option
        metadata: { ...meta, interval },
        // Keep Pro mid-trial: the trial's remaining days carry over (first charge when it would have ended).
        // Stripe needs a trial_end at least 48 hours ahead; closer than that, billing starts now.
        subscription_data: { metadata: meta, ...(keepingTrial && trialSub.trial_end && trialSub.trial_end - Date.now() / 1000 > 49 * 3600 ? { trial_end: trialSub.trial_end } : {}) },
        success_url: `${siteUrl(env)}/pro/done?session_id={CHECKOUT_SESSION_ID}#${encodeURIComponent(calendarId)}`,
        cancel_url: `${siteUrl(env)}/${encodeURIComponent(back)}`,
        expires_at: Math.floor((Date.now() + CHECKOUT_HOLD_MS) / 1000),
    };
    // Right above Stripe's Pay button: which calendar this is for (the title is the payer's own, shown
    // only to them), and on staging which test card to use.
    const title = typeof body.title === 'string' ? body.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
    const forWhat = `Plus for ${title ? `“${title}” (${siteHost(env)}/${back})` : `${siteHost(env)}/${back}`}.`;
    params.custom_text = { submit: { message: cfg.livemode === false ? `${forWhat} ${TEST_CARD_HINT}` : forWhat } };
    // Stripe limits client_reference_id's characters; calendar names can be anything, and metadata has the real id.
    if (/^[A-Za-z0-9_-]{1,200}$/.test(calendarId)) params.client_reference_id = calendarId;
    if (customer) params.customer = customer; else if (user) params.customer_email = user.email;   // signed out: Stripe asks
    const r = await stripeRequest(cfg, 'POST', '/v1/checkout/sessions', params);
    if (!r.ok || !r.data.url) { console.error('[accounts] checkout session failed:', r.status, r.data && r.data.error && r.data.error.code); return json({ error: 'stripe-error' }, 502); }
    if (r.data.id) await acc.setCheckoutSession(calendarId, buyer, r.data.id);
    if (ed) await acc.noteUpgrade(calendarId, body.author, ed.creator);           // for the 7-day undo, once the lock lands
    return json({ url: r.data.url }, 200, claim ? { 'Set-Cookie': claimCookie(claim, CLAIM_MAX_AGE) } : {});
}

// Stripe webhook. The body is read raw before anything parses it (the signature covers the bytes).
// Events can arrive out of order or twice, so each one only names a subscription: we fetch that
// subscription's CURRENT state from Stripe and make the calendar match it.
async function handleWebhook(request, env) {
    const raw = await request.text();
    const cfg = stripeConfig(env, new URL(request.url).hostname);
    if (!cfg) return json({ error: 'billing-not-configured' }, 503);
    const v = await verifyStripeSignature(cfg.webhookSecret, request.headers.get('Stripe-Signature'), raw);
    if (!v.ok) return json({ error: 'invalid-signature', reason: v.reason }, 400);
    let event;
    try { event = JSON.parse(raw); } catch { return json({ error: 'bad-json' }, 400); }
    if (!event || typeof event.id !== 'string') return json({ error: 'bad-event' }, 400);

    const acc = accounts(env);
    if (await acc.eventSeen(event.id)) return json({ received: true, duplicate: true });
    if (eventModeMismatch(cfg, event)) {
        console.error('[accounts] ignoring a', event.livemode ? 'live' : 'test', 'mode event: the key is the other mode', event.id);
        await acc.markEvent(event.id);
        return json({ received: true, ignored: 'mode' });
    }
    const subId = SUBSCRIPTION_EVENTS.has(event.type) ? subscriptionIdOf(event) : null;
    if (subId) {
        const r = await stripeRequest(cfg, 'GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
        if (r.status >= 500 || r.status === 429 || (!r.ok && r.status !== 404)) return json({ error: 'retry' }, 500);
        if (r.ok) {
            const summary = summarizeSubscription(r.data);
            const outcome = await applySubscription(env, acc, cfg, summary);
            if (outcome.retry) return json({ error: 'retry' }, 500);       // not marked: Stripe sends it again
            if (event.type === 'customer.subscription.trial_will_end') await sendTrialReminder(env, acc, cfg, summary);
        }
    }
    if (CHARGE_EVENTS.has(event.type)) {
        const outcome = await endForCharge(env, acc, cfg, event);
        if (outcome.retry) return json({ error: 'retry' }, 500);
    }
    await acc.markEvent(event.id);
    return json({ received: true });
}

const retryable = (r) => r.status >= 500 || r.status === 429 || r.status === 0;

// A full refund or a dispute: find the subscription the charge paid for and cancel it now. The
// cancellation then unlocks the calendar through the usual path (applied here too, not only when
// Stripe's customer.subscription.deleted arrives).
async function endForCharge(env, acc, cfg, event) {
    const o = event.data && event.data.object || {};
    if (event.type === 'charge.refunded' && o.refunded !== true) return {};      // partial refund: keep Pro
    let charge = event.type === 'charge.refunded' ? o : null;
    if (!charge) {
        const chId = typeof o.charge === 'string' ? o.charge : o.charge && o.charge.id;
        if (!chId) return {};
        const c = await stripeRequest(cfg, 'GET', `/v1/charges/${encodeURIComponent(chId)}`);
        if (retryable(c)) return { retry: true };
        if (!c.ok) { console.warn('[accounts] dispute: charge not found', chId); return {}; }
        charge = c.data;
    }
    const ref = (v) => (typeof v === 'string' ? v : v && v.id) || null;
    // Older API versions name the invoice on the charge; newer ones only through invoice_payments.
    let invoiceId = ref(charge.invoice);
    const pi = ref(charge.payment_intent) || ref(o.payment_intent);
    if (!invoiceId && pi) {
        const p = await stripeRequest(cfg, 'GET', `/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(pi)}`);
        if (retryable(p)) return { retry: true };
        invoiceId = p.ok && p.data.data && p.data.data[0] ? ref(p.data.data[0].invoice) : null;
    }
    if (!invoiceId) return {};                                               // not a subscription payment
    const inv = await stripeRequest(cfg, 'GET', `/v1/invoices/${encodeURIComponent(invoiceId)}`);
    if (retryable(inv)) return { retry: true };
    const subId = inv.ok ? subscriptionOfInvoice(inv.data) : null;
    if (!subId) return {};
    const prev = await acc.getSubscription(subId);
    if (prev && CONFLICT.has(prev.status)) return {};                       // our own conflict refund
    const g = await stripeRequest(cfg, 'GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
    if (retryable(g)) return { retry: true };
    if (!g.ok) return {};
    let sub = g.data;
    if (ACTIVE.has(sub.status) || sub.status === 'incomplete') {
        const d = await stripeRequest(cfg, 'DELETE', `/v1/subscriptions/${encodeURIComponent(subId)}`, null, { idempotencyKey: `cancel-${event.type}-${subId}` });
        if (retryable(d)) return { retry: true };
        if (d.ok) sub = d.data;
        console.warn('[accounts]', event.type, '-> canceled subscription', subId, d.ok ? '' : `(cancel answered ${d.status})`);
    }
    return applySubscription(env, acc, cfg, summarizeSubscription(sub));
}

// The payment behind a subscription's latest invoice, for a refund: {ref} | {none} (nothing paid) | {retry} | {failed}.
async function latestPayment(cfg, s) {
    if (!s.latestInvoice) return { none: true };
    const inv = await stripeRequest(cfg, 'GET', `/v1/invoices/${encodeURIComponent(s.latestInvoice)}`);
    if (retryable(inv)) return { retry: true };
    if (!inv.ok) return { failed: true };
    if (!inv.data.amount_paid) return { none: true };
    const direct = paymentOfInvoice(inv.data);
    if (direct) return { ref: direct };
    const p = await stripeRequest(cfg, 'GET', `/v1/invoice_payments?invoice=${encodeURIComponent(s.latestInvoice)}`);
    if (retryable(p)) return { retry: true };
    const found = p.ok ? paymentOfInvoicePayments(p.data) : null;
    return found ? { ref: found } : { failed: true };
}

// A paid subscription that cannot get the lock (someone else holds it, or the same person already
// pays for this calendar): refund what it took, cancel it now, and mark it. Refund first, so a
// retry after a failure still finds it active; both calls carry idempotency keys, so a retry
// never refunds or cancels twice. {retry:true} when Stripe could not be reached.
async function refundConflict(acc, cfg, s, why, undo = false) {
    if (!undo) console.error('[accounts] refunded-conflict:', why, s.id);     // health check: GET /api/admin/accounts/conflicts
    const tag = undo ? 'undo' : 'conflict';
    let failed = false;
    const pay = await latestPayment(cfg, s);
    if (pay.retry) return { retry: true };
    if (pay.ref) {
        const r = await stripeRequest(cfg, 'POST', '/v1/refunds', { ...pay.ref, reason: undo ? 'requested_by_customer' : 'duplicate', metadata: { subscription: s.id, why } },
            { idempotencyKey: `refund-${tag}-${s.id}` });
        if (retryable(r)) return { retry: true };
        const already = r.data && r.data.error && r.data.error.code === 'charge_already_refunded';
        if (!r.ok && !already) { failed = true; console.error('[accounts] conflict refund FAILED:', s.id, r.status, r.data && r.data.error && r.data.error.code); }
    } else if (pay.failed) { failed = true; console.error('[accounts] conflict refund FAILED: no payment found for', s.id); }
    const d = await stripeRequest(cfg, 'DELETE', `/v1/subscriptions/${encodeURIComponent(s.id)}`, null, { idempotencyKey: `cancel-${tag}-${s.id}` });
    if (retryable(d)) return { retry: true };
    if (!d.ok) console.warn(`[accounts] ${tag} cancel answered`, d.status, s.id);
    await acc.setSubscriptionStatus(s.id, undo ? (failed ? 'undone-refund-failed' : 'undone') : (failed ? 'conflict-refund-failed' : 'refunded-conflict'));
    return { failed };
}

// Make the calendar match the subscription. {retry:true} when the calendar (or Stripe) couldn't be reached.
async function applySubscription(env, acc, cfg, s) {
    const prev = await acc.getSubscription(s.id);
    if (prev && CONFLICT.has(prev.status)) return {};                   // refunded and canceled by us: final
    // Our row wins over Stripe's metadata: support may have reassigned the owner.
    const calendarId = (prev && prev.calendar_id) || s.calendarId;
    let userId = (prev && prev.user_id) || s.userId;
    if (!userId && s.claim && s.customer) {
        // Pay first: the owner is the email typed at Stripe (see userForCheckout).
        const c = await stripeRequest(cfg, 'GET', `/v1/customers/${encodeURIComponent(s.customer)}`);
        if (c.status >= 500 || c.status === 429 || c.status === 0) return { retry: true };
        const email = String(c.ok && c.data.email || '').trim().toLowerCase();
        if (validEmail(email)) userId = (await acc.userForCheckout(email, s.claim)).userId;
    }
    if (!validId(calendarId) || !userId) { console.warn('[accounts] subscription without calendar/user metadata:', s.id); return {}; }
    await acc.upsertSubscription({ ...s, calendarId, userId });
    // Canceled in the portal just now (still running to the period's end): say what happens and when.
    if (s.cancelAtPeriodEnd && !(prev && prev.cancel_at_period_end) && ACTIVE.has(s.status) && s.status !== 'trialing') {
        await sendPlanNotice(env, acc, 'canceled', s, calendarId, userId);
    }
    if (s.trial) {
        const u = await acc.getUser(userId);
        await acc.noteTrial(calendarId, userId, u && u.email ? await sha256(u.email) : null, s.id);
    }

    if (!ACTIVE.has(s.status) && !ENDED.has(s.status)) return {};       // incomplete, paused: leave as is
    const st = await LockClient.lockStatus(env, calendarId);
    if (st.status >= 500) return { retry: true };
    if (st.status === 404) { console.warn('[accounts] paid calendar not found:', calendarId); return {}; }
    const others = await acc.otherActiveSubscriptions(calendarId, s.id);
    if (ACTIVE.has(s.status)) {
        if (prev && prev.status === 'trialing' && s.status === 'active' && s.trial) console.log(`[trial] converted interval=${s.interval === 'month' ? 'month' : 'year'} via=card`);
        if (st.locked && st.ownerId === userId) {
            // Keep Pro during a trial is an ordinary checkout: the paid subscription replaces the trial,
            // which is canceled now (never refunded: it charged nothing).
            let mine = others.filter((o) => o.userId === userId);
            if (!s.trial && !(await acc.isTrialSubscription(s.id))) {
                for (const t of mine) {
                    if (!(await acc.isTrialSubscription(t.id))) continue;
                    const d = await stripeRequest(cfg, 'DELETE', `/v1/subscriptions/${encodeURIComponent(t.id)}`, null, { idempotencyKey: `cancel-trial-${t.id}` });
                    if (retryable(d)) return { retry: true };
                    if (d.ok) await applySubscription(env, acc, cfg, summarizeSubscription(d.data));   // ended, and this owner still pays: no unlock
                    else console.warn('[accounts] trial cancel answered', d.status);
                    console.log(`[trial] converted interval=${s.interval === 'month' ? 'month' : 'year'} via=checkout`);
                }
                mine = (await acc.otherActiveSubscriptions(calendarId, s.id)).filter((o) => o.userId === userId);
            }
            // The same person paying twice for one calendar: the oldest subscription stays, later ones are refunded.
            const older = mine.filter((o) => !o.created || !s.created || o.created < s.created || (o.created === s.created && o.id < s.id));
            if (older.length) return refundConflict(acc, cfg, s, 'duplicate');
            for (const dup of mine) {
                const g = await stripeRequest(cfg, 'GET', `/v1/subscriptions/${encodeURIComponent(dup.id)}`);
                if (retryable(g)) return { retry: true };
                if (g.ok && ACTIVE.has(g.data.status) && (await refundConflict(acc, cfg, summarizeSubscription(g.data), 'duplicate')).retry) return { retry: true };
            }
            return {};
        }
        // No editor link is made here (there is no browser to show its key to): the owner makes them from the calendar.
        const r = await LockClient.lock(env, calendarId, userId);
        if (r.status >= 500) return { retry: true };
        if (r.status === 409 && r.error === 'locked-by-other') return refundConflict(acc, cfg, s, 'locked-by-other');
        if (!r.ok) console.warn('[accounts] could not lock paid calendar:', calendarId, r.status, r.error);
        else {
            await acc.releaseCheckout(calendarId);
            await acc.markUpgraded(calendarId, userId);
            const trialEnd = s.status === 'trialing' ? s.trialEnd || s.currentPeriodEnd : null;
            const row = await acc.getSubscription(s.id);
            await sendWelcomeEmail(env, acc, calendarId, userId, st.title, trialEnd, trialEnd ? await payerHasCard(cfg, s) : null, row && row.plan);
        }
        return {};
    }
    if (others.some((o) => o.userId === userId)) return {};            // still paid for by this owner
    const heir = others[0];                                             // another person's active subscription, oldest first
    if (st.locked && st.ownerId === userId) {
        // Nobody else pays: Pro ended, so the calendar pauses (read-only) unless the owner chose 'open'.
        // A trial that ends unpaid goes back to open unless its owner chose read-only (a squatter's trial can't freeze it).
        const wasTrial = !!(s.trial || await acc.isTrialSubscription(s.id));
        const r = await LockClient.unlock(env, calendarId, userId, { lapse: !heir, trial: wasTrial });
        if (r.status >= 500) return { retry: true };
        if (!heir && r.ok) await sendPlanNotice(env, acc, wasTrial ? 'trial-ended' : 'ended', s, calendarId, userId, { paused: !!r.paused });
        if (!heir && r.ok && wasTrial) console.log(`[trial] lapsed mode=${r.paused ? 'readonly' : 'open'}`);
    } else if (st.locked || !heir) return {};
    if (!heir) return {};
    // The ex-owner's lock passes to the person still paying, instead of staying with someone who isn't.
    console.warn('[accounts] lock handed to the remaining subscription:', heir.id);
    const l = await LockClient.lock(env, calendarId, heir.userId);
    return l.status >= 500 ? { retry: true } : {};
}

// The daily health check (scripts/pro-health.sh). Every calendar with a subscription row is
// checked against its room's lock, up to HEALTH_CAP of them:
//   paid-not-locked    active/trialing/past_due, but not locked by that owner (or by anyone)
//   locked-not-paid    every subscription ended, yet still locked by that owner
//   no-calendar        paid for, but the room doesn't exist
// A room that can't be reached is listed under `unchecked`, not as a mismatch (but `ok` is false). Calendars locked
// with no subscription row at all (admin locks) can't be listed: locks live in each room, and
// there is no index of rooms to walk.
const HEALTH_CAP = 200;
async function proHealth(env) {
    const snap = await accounts(env).healthSnapshot();
    const todo = snap.calendars.filter((c) => ACTIVE.has(c.status) || ENDED.has(c.status));
    const checking = todo.slice(0, HEALTH_CAP);
    const mismatches = [], unchecked = [];
    for (let i = 0; i < checking.length; i += 20) {
        await Promise.all(checking.slice(i, i + 20).map(async (c) => {
            const paid = ACTIVE.has(c.status);
            let st;
            try { st = await LockClient.lockStatus(env, c.calendarId); } catch { st = { status: 0 }; }
            const base = { calendarId: c.calendarId, status: c.status, subscriptionId: c.subscriptionId };
            if (st.status === 404) { if (paid) mismatches.push({ kind: 'no-calendar', ...base }); return; }
            if (!st.ok) { unchecked.push({ ...base, httpStatus: st.status }); return; }
            const lockedByOwner = !!st.locked && st.ownerId === c.userId;
            if (paid && !lockedByOwner) mismatches.push({ kind: 'paid-not-locked', ...base, lockedByOther: !!st.locked });
            if (!paid && lockedByOwner) mismatches.push({ kind: 'locked-not-paid', ...base });
        }));
    }
    return {
        ok: mismatches.length === 0 && unchecked.length === 0,
        at: Date.now(),
        subscriptions: snap.byStatus,
        calendars: { total: todo.length, checked: checking.length, capped: todo.length > checking.length },
        mismatches,
        unchecked,
        notChecked: 'Calendars locked without any subscription row (admin locks) are not listed: there is no index of rooms.',
        signIn24h: snap.signIn,
    };
}

async function handleAdmin(request, env, url, path) {
    if (!isAdmin(request, env)) return new Response('forbidden', { status: 403 });
    const acc = accounts(env);
    if (path === '/api/admin/accounts/lookup' && request.method === 'GET') {
        const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
        const out = await acc.lookup(email);
        return out ? json(out) : json({ error: 'no-user' }, 404);
    }
    if (path === '/api/admin/accounts/conflicts' && request.method === 'GET') {
        // Subscriptions refunded because they could not get the lock (for the health check and support).
        return json({ conflicts: await acc.conflicts() });
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
            if (!(st.locked && st.ownerId === userId)) relocked = (await LockClient.lock(env, body.calendarId, userId, { takeover: true })).ok;   // no link made: the new owner makes them
        }
        return json({ ok: true, userId, calendarId: body.calendarId, relocked });
    }
    if (path === '/api/admin/accounts/reset-trial' && request.method === 'POST') {
        // Support: someone else trialed this calendar (or it needs a fresh start). Cancels its trial
        // subscriptions in Stripe, unlocks it to a normal free calendar (no pause), and frees its one trial.
        const body = (await readJson(request)) || {};
        if (!validId(body.calendarId)) return json({ error: 'need calendarId' }, 400);
        const cfg = stripeConfig(env, url.hostname);
        const canceled = [];
        for (const sub of await acc.trialSubscriptionsFor(body.calendarId)) {
            if (cfg && ACTIVE.has(sub.status)) {
                const d = await stripeRequest(cfg, 'DELETE', `/v1/subscriptions/${encodeURIComponent(sub.id)}`, null, { idempotencyKey: `reset-trial-${sub.id}` });
                if (!d.ok && d.status !== 404) return json({ error: 'stripe-error', subscription: sub.id }, 502);
            }
            await acc.setSubscriptionStatus(sub.id, 'canceled');
            canceled.push(sub.id);
        }
        const st = await LockClient.lockStatus(env, body.calendarId);
        if (st.status === 404) return json({ error: 'no-calendar' }, 404);
        let unlocked = false;
        if (st.locked) unlocked = (await LockClient.unlock(env, body.calendarId, st.ownerId)).ok;          // no lapse: a plain unlock, nothing paused
        else if (st.lapsed) unlocked = (await LockClient.setLapsedMode(env, body.calendarId, st.lapsed.ownerId, 'open')).ok;   // paused: open it
        await acc.resetTrial(body.calendarId);
        return json({ ok: true, calendarId: body.calendarId, canceled, unlocked });
    }
    // Test hooks, dev mode only.
    if (devMode(env) && path === '/api/admin/accounts/outbox' && request.method === 'GET') {
        return json({ emails: await acc.listOutbox(String(url.searchParams.get('email') || '').toLowerCase()) });
    }
    if (devMode(env) && path === '/api/admin/accounts/age-upgrade' && request.method === 'POST') {
        // Moves a calendar's upgrade back in time, for the 7-day undo limit.
        const body = (await readJson(request)) || {};
        await acc.ageUpgrade(String(body.calendarId || ''), Number(body.ageMs) || 0);
        return json({ ok: true });
    }
    if (devMode(env) && path === '/api/admin/accounts/expire-tokens' && request.method === 'POST') {
        const body = (await readJson(request)) || {};
        const email = String(body.email || '').toLowerCase();
        // ageMs: move the links back in time (as if sent that long ago), for the daily-limit test.
        if (Number.isFinite(body.ageMs) && body.ageMs > 0) await acc.ageLoginTokens(email, body.ageMs);
        else await acc.expireLoginTokens(email);
        return json({ ok: true });
    }
    if (devMode(env) && path === '/api/admin/accounts/age-sessions' && request.method === 'POST') {
        const body = (await readJson(request)) || {};
        if (!Number.isFinite(body.ageMs) || body.ageMs <= 0) return json({ error: 'need ageMs' }, 400);
        await acc.ageSessions(String(body.email || '').toLowerCase(), body.ageMs);
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
            currentPeriodEnd: Number.isFinite(body.currentPeriodEnd) ? body.currentPeriodEnd : Math.floor(Date.now() / 1000) + 365 * 86400,
            cancelAtPeriodEnd: !!body.cancelAtPeriodEnd });
        return json({ ok: true, userId, subscriptionId: id });
    }
    return json({ error: 'not-found' }, 404);
}
