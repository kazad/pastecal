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
 *                                                   Names (decided Oct 2026): calendars already follow their "If your plan
 *                                                   ends" choice (a paused one stays read-only for good: nobody owns it);
 *                                                   @links keep serving the view-only calendar in place for 90 days (no
 *                                                   redirect: that would need a view link, and the alias already is one),
 *                                                   then end; the @ page goes at once; the handle is retired forever.
 *                                                   Short names are tombstones ("This link has ended") for 90 days, then free.
 *   GET  /api/me                                 -> {email, plan:'unlimited'|'single'|null, unlimited:{status, interval, currentPeriodEnd}|null,
 *                                                   calendars:[{id, status, plan:'single'|'unlimited', interval, currentPeriodEnd}]} | 401;
 *                                                   re-sends the cookie (fresh Max-Age) when the session was renewed
 *                                                   in the last day, so browsers keep it
 *   POST /api/pro/checkout    {calendarId, interval?:'year'|'month', plan?:'single'|'unlimited', editName?} -> {url} (Stripe Checkout).
 *                             plan 'unlimited' (Pro Unlimited, see "Pro Unlimited" below): calendarId optional, 409
 *                             already-unlimited; a Single checkout or a trial by an Unlimited owner is 409 has-unlimited.
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
 *   POST /api/pro/lock        {calendarId} -> {ok, already?}: a Pro Unlimited owner locks one of their calendars, no
 *                             checkout. 401, 400 bad-calendar, 403 no-unlimited, 404 no-calendar, 409 locked-by-other
 *                             (also a calendar paused for someone else), 403 buy-on-live (beta).
 *   POST /api/pro/unlock      {calendarId} -> {ok}: release a calendar from the owner's Unlimited (a plain unlock: a free
 *                             calendar again). 409 not-unlimited for a calendar not under their Unlimited.
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
 *   GET  /api/pro/config                         -> {billing, unlimited}: billing is true only when Stripe is configured (keys
 *                                                   and the Pro yearly price); unlimited also needs STRIPE_PRICE_UNLIMITED_YEARLY.
 *                                                   False: the site offers "Join the beta" (the waitlist) instead of
 *                                                   the trial and checkout. Public, cached 60 seconds.
 *   GET  /api/pro/status?calendar=<id>           -> {locked, pro, isOwner, paused, lapsedOwner, trialUsed}, plus unlimited:true
 *                                                   when the signed-in person has an active Pro Unlimited; the owner also
 *                                                   gets lapsedMode, plan:'single'|'unlimited', and trial:{endsAt, hasCard} while trialing; the
 *                                                   paused calendar's owner gets lapsedTrial (its Pro was a trial)
 *   POST /api/stripe/webhook                     Stripe events (signed), see handleWebhook
 *   POST /api/admin/accounts/reassign {calendarId, email}   (Bearer IMPORT_SECRET; lost access, disputes)
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
import { INTERVALS, PLANS, isUnlimited, stripeConfig, stripeRequest, verifyStripeSignature, summarizeSubscription, subscriptionIdOf, timingSafeEqual,
    eventModeMismatch, subscriptionOfInvoice, paymentOfInvoice, paymentOfInvoicePayments } from './Stripe.js';
import { siteUrl, siteHost, allowedOrigins, isStaging } from './Site.js';
import { removeDirectoryName, endDirectoryName, purgeNames } from './Names.js';

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
const CONFLICT = new Set(['refunded-conflict', 'conflict-refund-failed']);
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
const SHORT_HOLD_MS = 90 * 24 * 3600 * 1000;   // a lapsed owner's short names stay theirs this long, then are released
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
    const m = /^\/([^/?#\\\s]+)(\?pro=(?:year|month|trial))?$/.exec(raw);
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
            CREATE TABLE IF NOT EXISTS test_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, from_addr TEXT, subject TEXT,
                received_at INTEGER, text TEXT, truncated INTEGER, auth_results TEXT, arc_auth_results TEXT, has_dkim_signature INTEGER);
            CREATE INDEX IF NOT EXISTS test_inbox_to ON test_inbox(to_addr, id);
            CREATE TABLE IF NOT EXISTS checkout_claims (claim_hash TEXT PRIMARY KEY, session_id TEXT, used_at INTEGER);
            CREATE TABLE IF NOT EXISTS trials (calendar_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email_hash TEXT,
                subscription_id TEXT, started_at INTEGER);
            CREATE UNIQUE INDEX IF NOT EXISTS trials_user ON trials(user_id);
            CREATE UNIQUE INDEX IF NOT EXISTS trials_email ON trials(email_hash);
            CREATE TABLE IF NOT EXISTS trial_reminders (subscription_id TEXT PRIMARY KEY, at INTEGER);
            CREATE TABLE IF NOT EXISTS unlimited_locks (calendar_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subscription_id TEXT NOT NULL, locked_at INTEGER);
            CREATE INDEX IF NOT EXISTS unlimited_locks_sub ON unlimited_locks(subscription_id);
            CREATE INDEX IF NOT EXISTS unlimited_locks_user ON unlimited_locks(user_id);
            CREATE TABLE IF NOT EXISTS unlimited_first_lock (subscription_id TEXT PRIMARY KEY, at INTEGER);
            CREATE TABLE IF NOT EXISTS handles (handle TEXT PRIMARY KEY, user_id TEXT UNIQUE, created_at INTEGER);
            CREATE TABLE IF NOT EXISTS handle_links (handle TEXT NOT NULL, name TEXT NOT NULL, calendar_id TEXT NOT NULL UNIQUE, alias TEXT NOT NULL,
                show INTEGER DEFAULT 0, created_at INTEGER, PRIMARY KEY (handle, name));
            CREATE TABLE IF NOT EXISTS short_links (name TEXT PRIMARY KEY, user_id TEXT, calendar_id TEXT, created_at INTEGER, updated_at INTEGER, ended_at INTEGER);
            CREATE INDEX IF NOT EXISTS short_links_user ON short_links(user_id);
            CREATE TABLE IF NOT EXISTS account_calendars (user_id TEXT NOT NULL, calendar_id TEXT NOT NULL, added_at INTEGER, PRIMARY KEY (user_id, calendar_id));
            CREATE TABLE IF NOT EXISTS name_events (user_id TEXT, kind TEXT, detail TEXT, at INTEGER);
            CREATE INDEX IF NOT EXISTS name_events_user ON name_events(user_id, at);`);
        // Added later (an existing table keeps its columns): which subscription came first, and the
        // Checkout Session a hold guards plus how often its buyer restarted it.
        for (const col of ['subscriptions ADD COLUMN created INTEGER', 'checkout_holds ADD COLUMN session_id TEXT',
            'checkout_holds ADD COLUMN restarts INTEGER', 'checkout_holds ADD COLUMN window_start INTEGER',
            'sessions ADD COLUMN renewed_at INTEGER', 'users ADD COLUMN created_via TEXT', 'subscriptions ADD COLUMN trial_end INTEGER',
            'subscriptions ADD COLUMN has_payment_method INTEGER', 'subscriptions ADD COLUMN cancel_at_period_end INTEGER',
            'handles ADD COLUMN deleted_at INTEGER']) {
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
        const row = this.sql.exec(`SELECT hash, email, used, expires_at FROM login_tokens WHERE hash = ?`, hash).toArray()[0];
        if (!row || !timingSafeEqual(row.hash, hash) || row.used || row.expires_at <= Date.now()) return null;
        return row.email;
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
        if (active.length) return { active: [...new Set(active.map((r) => r.calendar_id || 'pro-unlimited'))] };
        // Pro names: the @links keep opening their view-only calendars for 90 days (handles.deleted_at),
        // then the sweep removes them and their hidden names; the @handle page itself is gone at once.
        // The handle stays taken, by nobody, forever, so an old shared @link can never be someone else's.
        // Short names are held 90 days like after a lapse, then released (alarm), never re-pointed: their
        // directory rows become tombstones ("This link has ended"), so nobody can make a calendar there first.
        const now = Date.now();
        const h = this.handleOf(userId);
        const links = h ? this.sql.exec(`SELECT name, alias FROM handle_links WHERE handle = ?`, h.handle).toArray() : [];
        const shorts = this.sql.exec(`SELECT name FROM short_links WHERE user_id = ?`, userId).toArray().map((r) => r.name);
        this.ctx.storage.transactionSync(() => {
            this.sql.exec(`DELETE FROM login_tokens WHERE email = ?`, user.email);
            this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, userId);
            this.sql.exec(`DELETE FROM checkout_holds WHERE user_id = ?`, userId);
            this.sql.exec(`DELETE FROM welcome_emails WHERE user_id = ?`, userId);
            this.sql.exec(`DELETE FROM unlimited_locks WHERE user_id = ?`, userId);   // only ever ended ones here
            this.sql.exec(`DELETE FROM outbox WHERE to_email = ?`, user.email);          // dev mode only ever writes here
            this.sql.exec(`UPDATE subscriptions SET user_id = NULL, updated_at = ? WHERE user_id = ?`, now, userId);
            if (h) this.sql.exec(`UPDATE handles SET user_id = NULL, deleted_at = ? WHERE handle = ?`, now, h.handle);
            this.sql.exec(`UPDATE short_links SET user_id = NULL, calendar_id = NULL, ended_at = COALESCE(ended_at, ?) WHERE user_id = ?`, now, userId);
            this.sql.exec(`DELETE FROM account_calendars WHERE user_id = ?`, userId);
            this.sql.exec(`DELETE FROM name_events WHERE user_id = ?`, userId);
            this.sql.exec(`DELETE FROM users WHERE id = ?`, userId);
        });
        if (shorts.length || links.length) this.scheduleSweep();
        return { deleted: true, handle: h ? h.handle : null, links: links.map((l) => l.name), removeSlugs: [], endSlugs: shorts, shortNames: shorts };
    }

    // ---- Pro Unlimited names: @handle, links under it, top-level short names ----
    // handles: one per account, claimed once (user_id NULL: the account was deleted, the name stays taken).
    // handle_links: pastecal.com/@handle/<name> -> a calendar, through `alias`, a hidden read-only name in the
    //   directory (so the view page and feed never see the calendar's edit id). A calendar has at most one.
    // short_links: pastecal.com/<name> -> a calendar; the name itself is the read-only directory row.
    //   ended_at: the owner's Unlimited ended (or the account was deleted); 90 days later it is released.
    // account_calendars: calendars this owner locked under Unlimited, kept after it lapses ("Your calendars").
    handleOf(userId) { return userId ? this.sql.exec(`SELECT * FROM handles WHERE user_id = ?`, userId).toArray()[0] || null : null; }
    handleRow(handle) { return this.sql.exec(`SELECT * FROM handles WHERE handle = ?`, handle).toArray()[0] || null; }
    claimHandle(userId, handle) {
        if (this.handleOf(userId)) return { error: 'has-handle' };
        if (this.handleRow(handle)) return { error: 'taken' };
        this.sql.exec(`INSERT INTO handles (handle, user_id, created_at) VALUES (?, ?, ?)`, handle, userId, Date.now());
        return { ok: true };
    }
    linkFor(calendarId) { return this.sql.exec(`SELECT * FROM handle_links WHERE calendar_id = ?`, calendarId).toArray()[0] || null; }
    linkByName(handle, name) { return this.sql.exec(`SELECT * FROM handle_links WHERE handle = ? AND name = ?`, handle, name).toArray()[0] || null; }
    // For the public pages: a live handle resolves, and a deleted account's for 90 days (then the sweep removes them).
    resolveLink(handle, name) {
        const r = this.sql.exec(`SELECT l.alias FROM handle_links l JOIN handles h ON h.handle = l.handle WHERE l.handle = ? AND l.name = ?
            AND (h.user_id IS NOT NULL OR h.deleted_at > ?)`, handle, name, Date.now() - SHORT_HOLD_MS).toArray()[0];
        return r ? { alias: r.alias } : null;
    }
    handlePage(handle) {
        const h = this.handleRow(handle);
        if (!h || !h.user_id) return null;
        return { handle, links: this.sql.exec(`SELECT name, calendar_id AS calendarId FROM handle_links WHERE handle = ? AND show = 1 ORDER BY name`, handle).toArray() };
    }
    // -> {ok, previous:{name, alias}|null} | {error:'name-taken'}
    setLink(handle, name, calendarId, alias) {
        const other = this.linkByName(handle, name);
        if (other && other.calendar_id !== calendarId) return { error: 'name-taken' };
        const prev = this.linkFor(calendarId);
        if (prev && prev.name === name) return { ok: true, previous: null, alias: prev.alias };
        if (prev) this.sql.exec(`UPDATE handle_links SET name = ? WHERE calendar_id = ?`, name, calendarId);
        else this.sql.exec(`INSERT INTO handle_links (handle, name, calendar_id, alias, show, created_at) VALUES (?, ?, ?, ?, 0, ?)`, handle, name, calendarId, alias, Date.now());
        return { ok: true, previous: prev ? { name: prev.name } : null, alias: prev ? prev.alias : alias };
    }
    removeLink(calendarId) {
        const prev = this.linkFor(calendarId);
        if (prev) this.sql.exec(`DELETE FROM handle_links WHERE calendar_id = ?`, calendarId);
        return prev;
    }
    setShow(calendarId, show) { this.sql.exec(`UPDATE handle_links SET show = ? WHERE calendar_id = ?`, show ? 1 : 0, calendarId); return this.linkFor(calendarId); }
    shortRow(name) { return this.sql.exec(`SELECT * FROM short_links WHERE name = ?`, name).toArray()[0] || null; }
    shortNamesOf(userId) { return this.sql.exec(`SELECT name, calendar_id AS calendarId, ended_at AS endedAt FROM short_links WHERE user_id = ? ORDER BY created_at`, userId).toArray(); }
    addShort(userId, name, calendarId, limit) {
        if (this.shortRow(name)) return { error: 'taken' };
        if (this.shortNamesOf(userId).length >= limit) return { error: 'short-limit' };
        const now = Date.now();
        this.sql.exec(`INSERT INTO short_links (name, user_id, calendar_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, name, userId, calendarId, now, now);
        return { ok: true };
    }
    remapShort(name, calendarId) { this.sql.exec(`UPDATE short_links SET calendar_id = ?, updated_at = ? WHERE name = ?`, calendarId, Date.now(), name); }
    removeShort(name) { this.sql.exec(`DELETE FROM short_links WHERE name = ?`, name); }
    // Rate limit and log for name changes: claims, links, remaps (no emails, only the account id).
    nameEventsLastHour(userId) { return this.sql.exec(`SELECT COUNT(*) AS n FROM name_events WHERE user_id = ? AND at > ?`, userId, Date.now() - 3600 * 1000).one().n; }
    noteNameEvent(userId, kind, detail) {
        const now = Date.now();
        this.sql.exec(`INSERT INTO name_events (user_id, kind, detail, at) VALUES (?, ?, ?, ?)`, userId, kind, String(detail || '').slice(0, 120), now);
        this.sql.exec(`DELETE FROM name_events WHERE at < ?`, now - 30 * 24 * 3600 * 1000);
    }
    addOwned(userId, calendarId) { this.sql.exec(`INSERT OR IGNORE INTO account_calendars (user_id, calendar_id, added_at) VALUES (?, ?, ?)`, userId, calendarId, Date.now()); }
    removeOwned(userId, calendarId) { this.sql.exec(`DELETE FROM account_calendars WHERE user_id = ? AND calendar_id = ?`, userId, calendarId); }
    // Calendars under this owner's Unlimited that count toward its 10: those not living under the owner's @handle.
    proCount(userId) {
        return this.sql.exec(`SELECT COUNT(*) AS n FROM unlimited_locks u WHERE u.user_id = ? AND NOT EXISTS
            (SELECT 1 FROM handle_links l JOIN handles h ON h.handle = l.handle WHERE l.calendar_id = u.calendar_id AND h.user_id = u.user_id)`, userId).one().n;
    }
    // The owner's Unlimited ended: their short names keep working, frozen, and are released 90 days later.
    markShortEnded(userId) {
        this.sql.exec(`UPDATE short_links SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL`, Date.now(), userId);
        this.scheduleSweep();
    }
    clearShortEnded(userId) { this.sql.exec(`UPDATE short_links SET ended_at = NULL WHERE user_id = ?`, userId); }
    scheduleSweep() {
        const a = this.sql.exec(`SELECT MIN(ended_at) AS t FROM short_links WHERE ended_at IS NOT NULL`).one().t;
        const b = this.sql.exec(`SELECT MIN(deleted_at) AS t FROM handles WHERE deleted_at IS NOT NULL`).one().t;
        const t = [a, b].filter(Boolean).sort((x, y) => x - y)[0];
        if (t) this.ctx.storage.setAlarm(t + SHORT_HOLD_MS);
    }
    // Release every short name held past 90 days: the row goes, and its directory name with it.
    async sweepShortHolds(now = Date.now()) {
        const due = this.sql.exec(`SELECT name FROM short_links WHERE ended_at IS NOT NULL AND ended_at <= ?`, now - SHORT_HOLD_MS).toArray().map((r) => r.name);
        for (const name of due) {
            this.sql.exec(`DELETE FROM short_links WHERE name = ?`, name);
            if (this.env.DIRECTORY) await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('global')).fetch('http://internal/remove', { method: 'POST', body: JSON.stringify({ slug: name }) });
            console.log('[names] short name released after the hold');
        }
        // A deleted account's @links: gone 90 days after the delete, with their hidden names. The handle stays retired.
        for (const h of this.sql.exec(`SELECT handle FROM handles WHERE user_id IS NULL AND deleted_at IS NOT NULL AND deleted_at <= ?`, now - SHORT_HOLD_MS).toArray()) {
            const links = this.sql.exec(`SELECT name, alias FROM handle_links WHERE handle = ?`, h.handle).toArray();
            for (const l of links) {
                if (this.env.DIRECTORY) await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('global')).fetch('http://internal/remove', { method: 'POST', body: JSON.stringify({ slug: l.alias }) });
            }
            this.sql.exec(`DELETE FROM handle_links WHERE handle = ?`, h.handle);
            this.sql.exec(`UPDATE handles SET deleted_at = NULL WHERE handle = ?`, h.handle);
            due.push('@' + h.handle, ...links.map((l) => `@${h.handle}/${l.name}`));
            console.log('[names] a deleted account\'s @links ended after the hold');
        }
        this.scheduleSweep();
        return due;
    }
    async alarm() { await this.sweepShortHolds(); }
    // Dev mode only: as if this account's Unlimited ended `ageMs` ago (the hold clock). `names`: those short
    // names instead (a deleted account has no email left to find them by).
    ageShortHolds(email, ageMs, names = null) {
        if (Array.isArray(names)) {
            for (const n of names) {
                if (String(n).startsWith('@')) this.sql.exec(`UPDATE handles SET deleted_at = deleted_at - ? WHERE handle = ? AND deleted_at IS NOT NULL`, ageMs, String(n).slice(1));
                else this.sql.exec(`UPDATE short_links SET ended_at = COALESCE(ended_at, ?) - ? WHERE name = ?`, Date.now(), ageMs, String(n));
            }
            return;
        }
        const u = this.findUser(email);
        if (u) this.sql.exec(`UPDATE short_links SET ended_at = COALESCE(ended_at, ?) - ? WHERE user_id = ?`, Date.now(), ageMs, u.id);
    }
    // Everything /account shows, in one read (calendar titles and lock states come from the rooms).
    accountView(userId) {
        const user = this.getUser(userId);
        if (!user) return null;
        const subs = this.sql.exec(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC`, userId).toArray().filter((r) => !CONFLICT.has(r.status));
        const sub = (r) => ({ status: r.status, interval: r.interval, currentPeriodEnd: r.current_period_end, trialEnd: r.trial_end || null,
            cancelAtPeriodEnd: !!r.cancel_at_period_end, endedAt: ENDED.has(r.status) ? r.updated_at : null });
        const unl = subs.filter((r) => r.plan === 'unlimited');
        const activeUnl = unl.find((r) => ACTIVE.has(r.status)) || null;
        const singles = subs.filter((r) => r.plan !== 'unlimited' && r.calendar_id);
        const h = this.handleOf(userId);
        const links = h ? this.sql.exec(`SELECT name, calendar_id AS calendarId, show FROM handle_links WHERE handle = ?`, h.handle).toArray() : [];
        const shortNames = this.shortNamesOf(userId);
        const owned = new Set([
            ...this.sql.exec(`SELECT calendar_id FROM account_calendars WHERE user_id = ? ORDER BY added_at`, userId).toArray().map((r) => r.calendar_id),
            ...singles.map((r) => r.calendar_id), ...links.map((l) => l.calendarId), ...shortNames.map((x) => x.calendarId).filter(Boolean)]);
        const covered = this.sql.exec(`SELECT u.calendar_id, s.status FROM unlimited_locks u JOIN subscriptions s ON s.stripe_subscription_id = u.subscription_id WHERE u.user_id = ?`, userId)
            .toArray().filter((r) => ACTIVE.has(r.status)).map((r) => r.calendar_id);
        const singleByCal = {};
        for (const r of singles) { const have = singleByCal[r.calendar_id]; if (!have || (!ACTIVE.has(have.status) && ACTIVE.has(r.status))) singleByCal[r.calendar_id] = r; }
        return {
            email: user.email,
            plan: activeUnl ? 'unlimited' : singles.some((r) => ACTIVE.has(r.status)) ? 'single' : null,
            unlimited: (activeUnl || unl[0]) ? sub(activeUnl || unl[0]) : null,
            singles: Object.values(singleByCal).map((r) => ({ calendarId: r.calendar_id, ...sub(r) })),
            hasBilling: subs.some((r) => r.stripe_customer_id),
            handle: h ? h.handle : null,
            links, shortNames, owned: [...owned], covered,
            proCount: this.proCount(userId),
        };
    }

    getUser(userId) { return this.sql.exec(`SELECT * FROM users WHERE id = ?`, userId).toArray()[0] || null; }
    findUser(email) { return this.sql.exec(`SELECT * FROM users WHERE email = ?`, email).toArray()[0] || null; }

    me(userId) {
        const user = this.getUser(userId);
        if (!user) return null;
        const rows = this.sql.exec(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC`, userId).toArray();
        const byCal = new Map();     // one entry per calendar: an active subscription wins over old ones
        for (const r of rows) {
            if (CONFLICT.has(r.status) || r.plan === 'unlimited' || !r.calendar_id) continue;   // refunded: never theirs
            const have = byCal.get(r.calendar_id);
            if (!have || (!ACTIVE.has(have.status) && ACTIVE.has(r.status))) byCal.set(r.calendar_id, { ...r, plan: 'single' });
        }
        // Pro Unlimited: the account's own subscription, and every calendar locked under it (which wins
        // over that calendar's old Single row).
        const unl = rows.filter((r) => r.plan === 'unlimited' && !CONFLICT.has(r.status));
        const activeUnl = unl.find((r) => ACTIVE.has(r.status)) || null;
        const shown = activeUnl || unl[0] || null;
        for (const c of this.unlimitedCalendarsOf(userId)) {
            if (ACTIVE.has(c.status)) byCal.set(c.calendar_id, { ...c, plan: 'unlimited' });
        }
        const calendars = [...byCal.values()];
        return {
            email: user.email,
            plan: activeUnl ? 'unlimited' : calendars.some((r) => ACTIVE.has(r.status)) ? 'single' : null,
            unlimited: shown ? { status: shown.status, interval: shown.interval, currentPeriodEnd: shown.current_period_end } : null,
            calendars: calendars.map((r) => ({ id: r.calendar_id, status: r.status, plan: r.plan, interval: r.interval, priceId: r.price_id,
                currentPeriodEnd: r.current_period_end, trialEnd: r.trial_end || null })),
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
            s.id, s.userId, s.customer || null, s.calendarId, s.plan === 'unlimited' ? 'unlimited' : 'pro', s.interval || null, s.priceId || null, s.status, s.currentPeriodEnd || null, Date.now(), s.created || null, s.trialEnd || null,
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
    customerForUser(userId) {
        // The Billing Portal opens on one customer: an active Pro Unlimited's first (it is what they pay for).
        const rows = this.sql.exec(`SELECT stripe_customer_id, plan, status FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL ORDER BY updated_at DESC`, userId).toArray();
        const row = rows.find((r) => r.plan === 'unlimited' && ACTIVE.has(r.status)) || rows[0];
        return row ? row.stripe_customer_id : null;
    }

    // ---- Pro Unlimited: one subscription per account; any number of its calendars locked under it ----
    // unlimited_locks: calendar -> the owner and the Unlimited subscription it is locked under. A row
    // means "this owner pays for this calendar through Unlimited"; the room holds the lock itself.
    // The owner's Unlimited subscriptions that are active, oldest first.
    activeUnlimitedAll(userId) {
        return this.sql.exec(`SELECT stripe_subscription_id AS id, user_id AS userId, status, created, stripe_customer_id AS customer FROM subscriptions
            WHERE user_id = ? AND plan = 'unlimited' ORDER BY COALESCE(created, 0), stripe_subscription_id`, userId).toArray().filter((r) => ACTIVE.has(r.status));
    }
    activeUnlimited(userId) { return userId ? this.activeUnlimitedAll(userId)[0] || null : null; }
    // The owner's active Single subscriptions (one calendar each), trials included.
    activeSingles(userId) {
        return this.sql.exec(`SELECT stripe_subscription_id AS id, calendar_id AS calendarId, status, stripe_customer_id AS customer, created FROM subscriptions
            WHERE user_id = ? AND COALESCE(plan, 'pro') != 'unlimited' AND calendar_id IS NOT NULL ORDER BY COALESCE(created, 0)`, userId).toArray().filter((r) => ACTIVE.has(r.status));
    }
    unlimitedRow(calendarId) { return this.sql.exec(`SELECT * FROM unlimited_locks WHERE calendar_id = ?`, calendarId).toArray()[0] || null; }
    unlimitedRowsOf(subscriptionId) { return this.sql.exec(`SELECT * FROM unlimited_locks WHERE subscription_id = ? ORDER BY locked_at`, subscriptionId).toArray(); }
    // Is this calendar paid for by this owner's active Unlimited?
    coveredByUnlimited(calendarId, userId) {
        const r = this.sql.exec(`SELECT s.status FROM unlimited_locks u JOIN subscriptions s ON s.stripe_subscription_id = u.subscription_id
            WHERE u.calendar_id = ? AND u.user_id = ?`, calendarId, userId).toArray()[0];
        return !!(r && ACTIVE.has(r.status));
    }
    // Record the calendar under this owner's Unlimited. Never takes a row another owner's ACTIVE
    // Unlimited holds (two owners racing for one calendar: the first row wins, the room decides the rest).
    coverUnlimited(calendarId, userId, subscriptionId) {
        const row = this.unlimitedRow(calendarId);
        if (row && row.user_id !== userId) {
            const st = this.getSubscription(row.subscription_id);
            if (st && ACTIVE.has(st.status)) return false;
        }
        this.sql.exec(`INSERT OR REPLACE INTO unlimited_locks (calendar_id, user_id, subscription_id, locked_at) VALUES (?, ?, ?, ?)`,
            calendarId, userId, subscriptionId, row && row.user_id === userId ? row.locked_at : Date.now());
        this.addOwned(userId, calendarId);
        return true;
    }
    uncoverUnlimited(calendarId, userId) { this.sql.exec(`DELETE FROM unlimited_locks WHERE calendar_id = ? AND user_id = ?`, calendarId, userId); }
    // The calendars under this owner's Unlimited, with that subscription's state.
    unlimitedCalendarsOf(userId) {
        return this.sql.exec(`SELECT u.calendar_id, s.status, s.interval, s.price_id, s.current_period_end, s.trial_end FROM unlimited_locks u
            JOIN subscriptions s ON s.stripe_subscription_id = u.subscription_id WHERE u.user_id = ? ORDER BY u.locked_at`, userId).toArray();
    }
    // The calendar an Unlimited checkout was started from is locked once, on its first activation (a
    // renewal must never re-lock a calendar its owner has since unlocked).
    claimFirstLock(subscriptionId) {
        if (this.sql.exec(`SELECT 1 FROM unlimited_first_lock WHERE subscription_id = ?`, subscriptionId).toArray().length) return false;
        this.sql.exec(`INSERT INTO unlimited_first_lock (subscription_id, at) VALUES (?, ?)`, subscriptionId, Date.now());
        return true;
    }
    releaseFirstLock(subscriptionId) { this.sql.exec(`DELETE FROM unlimited_first_lock WHERE subscription_id = ?`, subscriptionId); }
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
    trialUsedForCalendar(calendarId) { return this.sql.exec(`SELECT 1 FROM trials WHERE calendar_id = ?`, calendarId).toArray().length > 0; }
    // Once per subscription, like claimWelcome: Stripe may send trial_will_end twice.
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
        const rows = this.sql.exec(`SELECT calendar_id, user_id, status, stripe_subscription_id FROM subscriptions WHERE calendar_id IS NOT NULL ORDER BY updated_at DESC`).toArray();
        // Calendars under a Pro Unlimited count as paid by its owner (their old Single row may have ended).
        const covered = this.sql.exec(`SELECT u.calendar_id, u.user_id, s.status, s.stripe_subscription_id FROM unlimited_locks u
            JOIN subscriptions s ON s.stripe_subscription_id = u.subscription_id`).toArray();
        const byCal = new Map();
        for (const r of [...covered, ...rows]) {
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
    const subject = paid ? 'Your pastecal sign-in link: manage your new plan' : trial ? 'Your pastecal sign-in link: start your free Plus trial'
        : buying ? 'Your pastecal sign-in link: finish locking your calendar' : 'Your pastecal sign-in link';
    const lead = paid ? 'Thanks for upgrading. This email already has a pastecal account, so sign in here to get your editor link and manage your plan:'
        : trial ? `Here is your link to sign in and start your free ${TRIAL_DAYS}-day Plus trial. No card needed:`
        : buying ? 'Here is your link to sign in and finish locking your calendar. It takes you straight to payment:' : 'Here is your link to sign in to pastecal:';
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
async function sendWelcomeEmail(env, acc, calendarId, userId, title, trialEnd = null, hasCard = null, planName = 'Plus') {
    try {
        if (!(await acc.claimWelcome(calendarId, userId))) return;
        const user = await acc.getUser(userId);
        if (!user || !user.email) return;
        const name = cleanTitle(title, cleanTitle(calendarId, 'your calendar'));
        const link = `${siteUrl(env)}/${encodeURIComponent(calendarId)}`;
        const trialLine = !trialEnd ? '' : hasCard === false
            ? `Your free trial runs until ${formatDay(trialEnd)}. No card is on file, so nothing will be charged. We'll email you a few days before it ends.\n\n`
            : `Your free trial runs until ${formatDay(trialEnd)}. We'll email you a few days before it ends.\n\n`;
        const text = `${planName} is on for ${name}.\n\n${trialLine}`
            + `${link}\n\n`
            + `What's locked now: only you (signed in with this email) and people with an editor link can change this calendar. Everyone else can still view it.\n\n`
            + `To give someone editor access: open the calendar, choose Share, and copy the Editor link. You can reset or revoke editor links there at any time.\n\n`
            + `To manage billing: open the calendar's Share panel, or the logo menu, and choose Manage billing. You can also sign in at ${siteHost(env)} with this email.\n\n`
            + `Questions? Write to support@pastecal.com.\n`;
        await sendEmail(env, user.email, trialEnd ? `Your ${planName} trial is on for ${name}` : `${planName} is on for ${name}`, text, null, 'welcome');
    } catch (err) {
        console.error('[accounts] welcome email failed:', err && err.message);
    }
}

// Once per Pro subscription (id 'unlimited'), when it first turns active: the one thing Pro adds that
// nothing else teaches is the @name, so this says to claim it on /account. Plain text, no link but the site's.
async function sendProWelcome(env, acc, userId, subscriptionId) {
    try {
        if (!(await acc.claimWelcome('pro:' + subscriptionId, userId))) return;
        const user = await acc.getUser(userId);
        if (!user || !user.email) return;
        const host = siteHost(env);
        const text = `Thanks for getting Pro.\n\n`
            + `Next: claim your name. It's one name for all your calendars, like ${host}/@yourname/soccer, and you choose it once. Sign in with this email at:\n${siteUrl(env)}/account\n\n`
            + `Then make calendars under your name, as many as you like. Or open any calendar you run, press Share, and choose Lock this calendar: up to ${UNLIMITED_TOP_LEVEL} can have a short link like ${host}/soccer.\n\n`
            + `Short links and @links open the view-only calendar. You and your editors keep the edit link.\n\n`
            + `To manage billing: open your account page and choose Manage billing.\n\n`
            + `Questions? Write to support@pastecal.com.\n`;
        await sendEmail(env, user.email, 'Pro is on: claim your @name', text, null, 'welcome');
    } catch (err) {
        console.error('[accounts] pro welcome email failed:', err && err.message);
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
        // A plain link to the calendar (a Billing Portal link would expire): its Share panel has Keep Pro.
        const keep = `${siteUrl(env)}/${encodeURIComponent(calendarId)}?pro=keep`;
        if (card !== false) {
            // A card is on file (or Stripe couldn't say): never promise that nothing is charged.
            const text = `Your Plus trial for ${name} ends ${day}.\n\n`
                + `A card is on file for this subscription, so Plus continues after ${day} and the card is charged then. To change or cancel it, open the calendar's Share panel and choose Manage billing:\n${keep}\n\n`
                + `Questions? Write to support@pastecal.com.\n`;
            return await sendEmail(env, user.email, `Your Plus trial ends ${day}`, text, null, 'trial-reminder');
        }
        const text = `Your Plus trial for ${name} ends ${day}.\n\n`
            + `Keep Plus: $29 a year, and nothing changes.\n${keep}\n\n`
            + `If you do nothing, nothing is charged. On ${day} Plus ends and the calendar becomes read-only: everyone can still view it and its calendar feed keeps working, but nobody can edit it. `
            + `You can then open it to everyone (a free calendar, editable by anyone with the link) or keep Plus, from the calendar's Share panel.\n\n`
            + `Questions? Write to support@pastecal.com.\n`;
        await sendEmail(env, user.email, `Your Plus trial ends ${day}`, text, null, 'trial-reminder');
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
        const cfg = stripeConfig(env, url.hostname);
        return json({ billing: billingOn(env, url.hostname), unlimited: !!(cfg && cfg.prices.year && cfg.unlimitedPrices.year) },
            200, { 'Cache-Control': 'public, max-age=60' });
    }
    if (path === '/api/pro/status') {
        if (m !== 'GET') return json({ error: 'method' }, 405);
        const id = url.searchParams.get('calendar');
        if (!validId(id)) return json({ error: 'bad-calendar' }, 400);
        const [st, userId] = await Promise.all([LockClient.lockStatus(env, id), sessionUserId(request, env)]);
        if (st.status === 404) return json({ locked: false, pro: false, isOwner: false, paused: false, lapsedOwner: false, trialUsed: false });
        if (!st.ok && st.status >= 500) return json({ error: 'unavailable' }, 502);
        const locked = !!st.locked, isOwner = !!(locked && userId && st.ownerId === userId);
        const lapsed = !locked && st.lapsed ? st.lapsed : null;
        const out = { locked, pro: locked && st.plan === 'pro', isOwner, paused: !!(lapsed && lapsed.mode === 'readonly'),
            lapsedOwner: !!(lapsed && userId && lapsed.ownerId === userId), trialUsed: await accounts(env).trialUsedForCalendar(id) };
        // The signed-in person has Pro Unlimited: they lock this calendar with one click (POST /api/pro/lock).
        if (userId && await accounts(env).activeUnlimited(userId)) {
            out.unlimited = true;
            // Its 10 are used: this calendar can still go under the owner's @handle, without limit.
            const acc = accounts(env);
            if (!locked && !(await acc.linkFor(id)) && (await acc.proCount(userId)) >= UNLIMITED_TOP_LEVEL) out.unlimitedFull = true;
            const h = await acc.handleOf(userId);
            if (h) out.handle = h.handle;
        }
        if (out.lapsedOwner) {
            // Which words the owner sees: "Trial ended" or "Pro ended".
            const sub = await accounts(env).subscriptionFor(id, userId);
            out.lapsedTrial = !!(sub && sub.trial_end && !sub.has_payment_method);
        }
        if (isOwner) {
            out.lapsedMode = st.lapsedMode || 'readonly';
            out.plan = (await accounts(env).coveredByUnlimited(id, userId)) ? 'unlimited' : 'single';
            if (out.plan === 'unlimited' || out.unlimited) {
                // Its short links, for the owner panel: pastecal.com/@handle/<name> and any pastecal.com/<name> here.
                const acc = accounts(env), h = await acc.handleOf(userId), l = await acc.linkFor(id);
                if (h) out.handle = h.handle;
                out.atName = l && h && l.handle === h.handle ? l.name : null;
                const shorts = await acc.shortNamesOf(userId);
                out.shortNames = shorts.filter((x) => x.calendarId === id).map((x) => x.name);
                out.otherShortNames = shorts.filter((x) => x.calendarId && x.calendarId !== id).map((x) => x.name);   // remap one here
            }
            const sub = await accounts(env).subscriptionFor(id, userId);
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
        const email = await accounts(env).peekLoginToken(body.token);
        return email ? json({ ok: true, email }) : bad();
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
            const [status, res] = s ? await startTrial(request, env, s.userId, decodeURIComponent(tm[1])) : [401, { error: 'signed-out' }];
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
        const [status, res] = await startTrial(request, env, userId, body.calendarId);
        return json(res, status);
    }
    if (path === '/api/pro/lapsed-mode') return setLapsedMode(request, env, body);
    if (path === '/api/pro/lock') return unlimitedLock(request, env, body);
    if (path === '/api/pro/unlock') return unlimitedUnlock(request, env, body);
    if (path === '/api/pro/claim') return claimCheckout(request, env, body);
    if (path === '/api/pro/portal') {
        const cfg = stripeConfig(env, new URL(request.url).hostname);
        if (!cfg) return json({ error: 'billing-not-configured' }, 503);
        const userId = await sessionUserId(request, env);
        if (!userId) return json({ error: 'signed-out' }, 401);
        const customer = await accounts(env).customerForUser(userId);
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
        message: 'Cancel your subscription first (Manage billing), then delete your account.' }, 409);
    if (r.deleted) await forgetNames(env, r);
    return json({ ok: true, deleted: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

// After an account delete: its @links stop resolving at once; its short names become tombstones (a
// neutral "This link has ended" page, never creatable) until the sweep releases them.
async function forgetNames(env, r) {
    for (const slug of r.removeSlugs || []) await removeDirectoryName(env, slug);
    for (const slug of r.endSlugs || []) await endDirectoryName(env, slug);
    await purgeNames(r.handle, r.links || []);
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

// POST /api/pro/trial, and a "Try Pro free" sign-in link's verify. -> [status, body]
// A direct subscription with a 30-day trial and no payment method (Stripe ends it, canceled, if no card
// was added: trial_settings.end_behavior.missing_payment_method=cancel). It is applied at once, so the
// calendar is locked before this answers; the webhook's copy of the same events changes nothing.
async function startTrial(request, env, userId, calendarId) {
    if (env.BETA_REAL_DATA) return [403, { error: 'buy-on-live', message: 'Plans are started on pastecal.com. The beta shows the new design on your real calendars.' }];
    const cfg = stripeConfig(env, new URL(request.url).hostname);
    if (!cfg) return [503, { error: 'billing-not-configured' }];
    if (!validId(calendarId)) return [400, { error: 'bad-calendar' }];
    const price = cfg.prices.year;
    if (!price) return [503, { error: 'billing-not-configured' }];
    const acc = accounts(env);
    const user = await acc.getUser(userId);
    if (!user) return [401, { error: 'signed-out' }];
    // Pro Unlimited already covers every calendar: lock it instead (no trial needed).
    if (await acc.activeUnlimited(userId)) return [409, { error: 'has-unlimited', message: 'You have Pro: lock this calendar instead.' }];
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
    if (env.BETA_REAL_DATA) return json({ error: 'buy-on-live', message: 'Plans are bought on pastecal.com. The beta shows the new design on your real calendars.' }, 403);
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
    const plan = body.plan === undefined ? 'single' : body.plan;
    if (typeof plan !== 'string' || !PLANS.has(plan)) return json({ error: 'bad-plan' }, 400);
    const interval = body.interval === undefined ? 'year' : body.interval;
    if (!Object.hasOwn(INTERVALS, interval)) return json({ error: 'bad-interval' }, 400);
    if (plan === 'unlimited') return checkoutUnlimited(request, env, body, cfg, { userId, claim, claimHash, buyer, interval });
    const calendarId = body.calendarId;
    if (!validId(calendarId)) return json({ error: 'bad-calendar' }, 400);
    const price = cfg.prices[interval];
    if (!price) return json({ error: 'billing-not-configured' }, 503);
    // Pro Unlimited already pays for every calendar of theirs: no Single on top (POST /api/pro/lock).
    if (userId && await accounts(env).activeUnlimited(userId)) return json({ error: 'has-unlimited' }, 409);

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

    const acc = accounts(env);
    const [user, customer] = userId ? await Promise.all([acc.getUser(userId), acc.customerForUser(userId)]) : [null, null];
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
async function refundConflict(acc, cfg, s, why) {
    console.error('[accounts] refunded-conflict:', why, s.id);                 // health check: GET /api/admin/accounts/conflicts
    let failed = false;
    const pay = await latestPayment(cfg, s);
    if (pay.retry) return { retry: true };
    if (pay.ref) {
        const r = await stripeRequest(cfg, 'POST', '/v1/refunds', { ...pay.ref, reason: 'duplicate', metadata: { subscription: s.id, why } },
            { idempotencyKey: `refund-conflict-${s.id}` });
        if (retryable(r)) return { retry: true };
        const already = r.data && r.data.error && r.data.error.code === 'charge_already_refunded';
        if (!r.ok && !already) { failed = true; console.error('[accounts] conflict refund FAILED:', s.id, r.status, r.data && r.data.error && r.data.error.code); }
    } else if (pay.failed) { failed = true; console.error('[accounts] conflict refund FAILED: no payment found for', s.id); }
    const d = await stripeRequest(cfg, 'DELETE', `/v1/subscriptions/${encodeURIComponent(s.id)}`, null, { idempotencyKey: `cancel-conflict-${s.id}` });
    if (retryable(d)) return { retry: true };
    if (!d.ok) console.warn('[accounts] conflict cancel answered', d.status, s.id);
    await acc.setSubscriptionStatus(s.id, failed ? 'conflict-refund-failed' : 'refunded-conflict');
    return {};
}

// Make the calendar match the subscription. {retry:true} when the calendar (or Stripe) couldn't be reached.
async function applySubscription(env, acc, cfg, s) {
    if (isUnlimited(cfg, s)) return applyUnlimited(env, acc, cfg, s);
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
            // Already paid for by this owner's Pro Unlimited (an upgrade, or a Single bought after it):
            // the Single is canceled with its unused time credited, never refunded twice (same key as the upgrade).
            if (await acc.coveredByUnlimited(calendarId, userId)) return absorbSingle(env, acc, cfg, s);
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
            const trialEnd = s.status === 'trialing' ? s.trialEnd || s.currentPeriodEnd : null;
            await sendWelcomeEmail(env, acc, calendarId, userId, st.title, trialEnd, trialEnd ? await payerHasCard(cfg, s) : null);
        }
        return {};
    }
    if (others.some((o) => o.userId === userId)) return {};            // still paid for by this owner
    if (await acc.coveredByUnlimited(calendarId, userId)) return {};    // ... through their Pro Unlimited
    const heir = others[0];                                             // another person's active subscription, oldest first
    if (st.locked && st.ownerId === userId) {
        // Nobody else pays: Pro ended, so the calendar pauses (read-only) unless the owner chose 'open'.
        const r = await LockClient.unlock(env, calendarId, userId, { lapse: !heir });
        if (r.status >= 500) return { retry: true };
        if (!heir && r.ok && (s.trial || await acc.isTrialSubscription(s.id))) console.log(`[trial] lapsed mode=${r.paused ? 'readonly' : 'open'}`);
    } else if (st.locked || !heir) return {};
    if (!heir) return {};
    // The ex-owner's lock passes to the person still paying, instead of staying with someone who isn't.
    console.warn('[accounts] lock handed to the remaining subscription:', heir.id);
    const l = await LockClient.lock(env, calendarId, heir.userId);
    return l.status >= 500 ? { retry: true } : {};
}

// ---- Pro Unlimited ------------------------------------------------------------------------------
// One subscription per account (Pro, id 'unlimited': $96/year or $10/month) that pays for every calendar its owner locks
// under it. The Stripe subscription names no calendar (metadata.plan='unlimited', and lock_calendar
// when it was bought from a calendar's Share panel); unlimited_locks records which calendars it covers.
//   - While it is active, POST /api/pro/lock {calendarId} locks any calendar the owner can lock (not
//     locked by, or paused for, someone else), and POST /api/pro/unlock releases one (a plain unlock).
//   - Upgrade: when it becomes active, each of the owner's active Single subscriptions whose calendar
//     they hold moves under it, and the Single is canceled with proration (prorate + invoice_now):
//     Stripe credits the unused time to that Single's customer balance, which pays toward later
//     invoices on the same customer. Checkout reuses a signed-in owner's paid Single customer so the
//     credit lands where the Unlimited invoices are. A trial is simply canceled (it charged nothing).
//   - When it ends (canceled, unpaid, refunded, disputed), every calendar under it falls back exactly
//     like a Single that ended: unlock with lapse, so it is paused (read-only) unless the owner chose
//     'open'. A calendar the owner still pays for another way (a newer Unlimited) moves to that one.
const unlimitedHoldKey = (buyer) => 'unlimited:' + buyer;
export const UNLIMITED_TOP_LEVEL = 5;    // (owner decision Oct 2026: was 10; Teams will get 25) Pro calendars outside the owner's @handle (and top-level short names)

// POST /api/pro/checkout {plan:'unlimited', interval, calendarId?}: Stripe Checkout for Pro Unlimited.
// calendarId (optional): the calendar it was bought from, locked under it as soon as it is active.
async function checkoutUnlimited(request, env, body, cfg, { userId, claim, claimHash, buyer, interval }) {
    const price = cfg.unlimitedPrices[interval];
    if (!price) return json({ error: 'billing-not-configured' }, 503);
    const acc = accounts(env);
    const [user, active, singles] = userId ? await Promise.all([acc.getUser(userId), acc.activeUnlimited(userId), acc.activeSingles(userId)]) : [null, null, []];
    if (userId && !user) return json({ error: 'signed-out' }, 401);
    if (active) return json({ error: 'already-unlimited' }, 409);
    let calendarId = null;
    if (body.calendarId !== undefined && body.calendarId !== null && body.calendarId !== '') {
        if (!validId(body.calendarId)) return json({ error: 'bad-calendar' }, 400);
        calendarId = body.calendarId;
        const st = await LockClient.lockStatus(env, calendarId);
        if (st.status === 404) return json({ error: 'no-calendar' }, 404);
        if (!st.ok) return json({ error: 'unavailable' }, 502);
        if (st.locked && st.ownerId !== userId) return json({ error: 'locked-by-other' }, 409);
        if (st.lapsed && st.lapsed.mode === 'readonly' && st.lapsed.ownerId !== userId) return json({ error: userId ? 'locked-by-other' : 'signed-out' }, userId ? 409 : 401);
    }
    const holdKey = unlimitedHoldKey(buyer);
    const hold = await acc.holdCheckout(holdKey, buyer, CHECKOUT_HOLD_MS);
    if (!hold.ok) return json({ error: hold.error }, hold.error === 'too-many-checkouts' ? 429 : 409);
    if (hold.previousSession) {
        const path = `/v1/checkout/sessions/${encodeURIComponent(hold.previousSession)}`;
        const x = await stripeRequest(cfg, 'POST', path + '/expire');
        if (!x.ok) {
            const g = await stripeRequest(cfg, 'GET', path);
            if (!(g.ok && g.data.status === 'expired')) return json({ error: 'checkout-in-progress' }, 409);
        }
    }
    const meta = { plan: 'unlimited', ...(userId ? { user_id: userId } : { claim: claimHash }), ...(calendarId ? { lock_calendar: calendarId } : {}) };
    const site = siteUrl(env);
    const params = {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        payment_method_types: ['card'],
        wallet_options: { link: { display: 'never' } },
        metadata: { ...meta, interval },
        subscription_data: { metadata: meta },
        success_url: `${site}/pro/done?session_id={CHECKOUT_SESSION_ID}&plan=unlimited${calendarId ? '#' + encodeURIComponent(calendarId) : ''}`,
        cancel_url: calendarId ? `${site}/${encodeURIComponent(calendarId)}` : `${site}/pricing`,
        expires_at: Math.floor((Date.now() + CHECKOUT_HOLD_MS) / 1000),
    };
    const paidSingles = singles.filter((x) => x.status !== 'trialing');
    const forWhat = `Pro: ${UNLIMITED_TOP_LEVEL} upgraded calendars, plus unlimited under your @name.` + (paidSingles.length ? ' Your Plus calendars move to it, and their unused time is credited.' : '');
    params.custom_text = { submit: { message: cfg.livemode === false ? `${forWhat} ${TEST_CARD_HINT}` : forWhat } };
    // The upgrade credit lands on the paid Single's customer, so Unlimited is billed to that same customer.
    const customer = (paidSingles.find((x) => x.customer) || {}).customer || (userId ? await acc.customerForUser(userId) : null);
    if (customer) params.customer = customer; else if (user) params.customer_email = user.email;
    const r = await stripeRequest(cfg, 'POST', '/v1/checkout/sessions', params);
    if (!r.ok || !r.data.url) { console.error('[accounts] unlimited checkout failed:', r.status, r.data && r.data.error && r.data.error.code); return json({ error: 'stripe-error' }, 502); }
    if (r.data.id) await acc.setCheckoutSession(holdKey, buyer, r.data.id);
    return json({ url: r.data.url }, 200, claim ? { 'Set-Cookie': claimCookie(claim, CLAIM_MAX_AGE) } : {});
}

// A Single subscription whose calendar is now under the owner's Pro Unlimited: cancel it. Paid: with
// proration, so Stripe credits the unused time. A trial: plainly (nothing was charged). The same
// idempotency key wherever it is called from, so an upgrade and a racing webhook cancel it once.
async function absorbSingle(env, acc, cfg, single) {
    const trialing = single.status === 'trialing';
    const d = await stripeRequest(cfg, 'DELETE', `/v1/subscriptions/${encodeURIComponent(single.id)}`,
        trialing ? null : { prorate: true, invoice_now: true }, { idempotencyKey: `upgrade-cancel-${single.id}` });
    if (retryable(d)) return { retry: true };
    if (!d.ok) { console.warn('[accounts] upgrade: single cancel answered', d.status); return {}; }
    console.log(`[unlimited] single moved under unlimited trial=${trialing ? 1 : 0}`);
    return applySubscription(env, acc, cfg, summarizeSubscription(d.data));   // ended, still covered: no unlock
}

// Lock one calendar under an owner's active Unlimited. -> {ok, already?} | {status, error} | {retry}
async function lockUnderUnlimited(env, acc, cfg, calendarId, userId, subscriptionId, title = null) {
    const st = await LockClient.lockStatus(env, calendarId);
    if (st.status === 404) return { status: 404, error: 'no-calendar' };
    if (!st.ok) return { retry: true };
    if (st.locked && st.ownerId !== userId) return { status: 409, error: 'locked-by-other' };
    if (!st.locked && st.lapsed && st.lapsed.mode === 'readonly' && st.lapsed.ownerId !== userId) return { status: 409, error: 'locked-by-other' };
    // Pro Unlimited covers 10 calendars, plus any number living under the owner's @handle.
    // Only a link under THIS owner's @handle exempts it (another account's old link doesn't).
    const link = await acc.linkFor(calendarId), own = await acc.handleOf(userId);
    const underOwnHandle = !!(link && own && link.handle === own.handle);
    if (!(await acc.coveredByUnlimited(calendarId, userId)) && !underOwnHandle
        && (await acc.proCount(userId)) >= UNLIMITED_TOP_LEVEL) return { status: 409, error: 'unlimited-full', message: `You've used your ${UNLIMITED_TOP_LEVEL}. Put more under your @name, without limit.` };
    if (!(await acc.coverUnlimited(calendarId, userId, subscriptionId))) return { status: 409, error: 'locked-by-other' };
    if (st.locked) {
        // Already theirs (a Single): it moves under Unlimited, and that Single is canceled with credit.
        for (const one of (await acc.activeSingles(userId)).filter((x) => x.calendarId === calendarId)) {
            if ((await absorbSingle(env, acc, cfg, one)).retry) return { retry: true };
        }
        return { ok: true, already: true };
    }
    const r = await LockClient.lock(env, calendarId, userId);
    if (r.status >= 500 || r.status === 0) { await acc.uncoverUnlimited(calendarId, userId); return { retry: true }; }
    if (!r.ok) { await acc.uncoverUnlimited(calendarId, userId); return { status: r.status === 409 ? 409 : 502, error: r.error || 'unavailable' }; }
    await sendWelcomeEmail(env, acc, calendarId, userId, title || st.title, null, null, 'Pro');
    return { ok: true };
}

// Make the account match its Pro Unlimited subscription. {retry:true} when a room or Stripe couldn't be reached.
async function applyUnlimited(env, acc, cfg, s) {
    const prev = await acc.getSubscription(s.id);
    if (prev && CONFLICT.has(prev.status)) return {};
    let userId = (prev && prev.user_id) || s.userId;
    if (!userId && s.claim && s.customer) {
        const c = await stripeRequest(cfg, 'GET', `/v1/customers/${encodeURIComponent(s.customer)}`);
        if (retryable(c)) return { retry: true };
        const email = String(c.ok && c.data.email || '').trim().toLowerCase();
        if (validEmail(email)) userId = (await acc.userForCheckout(email, s.claim)).userId;
    }
    if (!userId) { console.warn('[accounts] unlimited subscription without user metadata:', s.id); return {}; }
    await acc.upsertSubscription({ ...s, calendarId: null, userId, plan: 'unlimited' });
    if (!ACTIVE.has(s.status) && !ENDED.has(s.status)) return {};       // incomplete, paused: leave as is

    if (ACTIVE.has(s.status)) {
        await acc.clearShortEnded(userId);                               // resubscribed: no release pending
        await acc.releaseCheckout(unlimitedHoldKey(userId));
        if (s.claim) await acc.releaseCheckout(unlimitedHoldKey('anon:' + s.claim));
        // The same person paying for Unlimited twice: the oldest stays, later ones are refunded.
        const others = (await acc.activeUnlimitedAll(userId)).filter((o) => o.id !== s.id);
        const isOlder = (o) => !o.created || !s.created || o.created < s.created || (o.created === s.created && o.id < s.id);
        if (others.some(isOlder)) return refundConflict(acc, cfg, s, 'duplicate-unlimited');
        for (const dup of others) {
            const g = await stripeRequest(cfg, 'GET', `/v1/subscriptions/${encodeURIComponent(dup.id)}`);
            if (retryable(g)) return { retry: true };
            if (g.ok && ACTIVE.has(g.data.status) && (await refundConflict(acc, cfg, summarizeSubscription(g.data), 'duplicate-unlimited')).retry) return { retry: true };
        }
        // Upgrade: every Single calendar this owner holds moves under Unlimited (covered first, so the
        // Single's cancellation keeps the lock), then the Single is canceled with credit.
        for (const one of await acc.activeSingles(userId)) {
            const st = await LockClient.lockStatus(env, one.calendarId);
            if (st.status >= 500 || st.status === 0) return { retry: true };
            if (!(st.locked && st.ownerId === userId)) continue;             // not holding it: left to the Single's own path
            if (!(await acc.coverUnlimited(one.calendarId, userId, s.id))) continue;
            if ((await absorbSingle(env, acc, cfg, one)).retry) return { retry: true };
        }
        // Bought from a calendar: lock that one too, once.
        if (s.lockCalendar && validId(s.lockCalendar) && await acc.claimFirstLock(s.id)) {
            const r = await lockUnderUnlimited(env, acc, cfg, s.lockCalendar, userId, s.id);
            if (r.retry) { await acc.releaseFirstLock(s.id); return { retry: true }; }
            if (r.error) console.warn('[accounts] unlimited: could not lock the calendar it was bought from:', r.error);
        }
        await sendProWelcome(env, acc, userId, s.id);                    // once per subscription: claim your @name
        return {};
    }

    // Ended: each calendar under it falls back the way a Single does (paused unless the owner chose 'open').
    const heir = await acc.activeUnlimited(userId);                      // a newer Unlimited of theirs
    for (const row of await acc.unlimitedRowsOf(s.id)) {
        const cal = row.calendar_id;
        if (heir) { await acc.coverUnlimited(cal, userId, heir.id); continue; }
        if ((await acc.otherActiveSubscriptions(cal, s.id)).some((o) => o.userId === userId)) { await acc.uncoverUnlimited(cal, userId); continue; }
        const st = await LockClient.lockStatus(env, cal);
        if (st.status >= 500 || st.status === 0) return { retry: true };
        if (st.ok && st.locked && st.ownerId === userId) {
            const r = await LockClient.unlock(env, cal, userId, { lapse: true });
            if (r.status >= 500 || r.status === 0) return { retry: true };
        }
        await acc.uncoverUnlimited(cal, userId);
    }
    if (!heir) await acc.markShortEnded(userId);                         // short names: frozen, released after 90 days
    if (prev && ACTIVE.has(prev.status)) console.log('[unlimited] lapsed');
    return {};
}

// POST /api/pro/lock {calendarId}: an Unlimited owner locks one of their calendars. No checkout.
async function unlimitedLock(request, env, body) {
    if (env.BETA_REAL_DATA) return json({ error: 'buy-on-live', message: 'Plans are used on pastecal.com. The beta shows the new design on your real calendars.' }, 403);
    const cfg = stripeConfig(env, new URL(request.url).hostname);
    if (!cfg) return json({ error: 'billing-not-configured' }, 503);
    const userId = await sessionUserId(request, env);
    if (!userId) return json({ error: 'signed-out' }, 401);
    if (!validId(body.calendarId)) return json({ error: 'bad-calendar' }, 400);
    const acc = accounts(env);
    const sub = await acc.activeUnlimited(userId);
    if (!sub) return json({ error: 'no-unlimited' }, 403);
    const title = typeof body.title === 'string' ? body.title : null;
    const r = await lockUnderUnlimited(env, acc, cfg, body.calendarId, userId, sub.id, title);
    if (r.retry) return json({ error: 'unavailable' }, 502);
    if (r.error) return json({ error: r.error, ...(r.message ? { message: r.message } : {}) }, r.status);
    return json({ ok: true, ...(r.already ? { already: true } : {}) });
}

// Lock a calendar under the owner's active Unlimited, for Names.js (a new calendar under @handle).
// -> {ok, already?} | {status, error, message?}
export async function lockForOwner(env, host, calendarId, userId, title = null) {
    if (env.BETA_REAL_DATA) return { status: 403, error: 'buy-on-live', message: 'Plans are used on pastecal.com.' };
    const cfg = stripeConfig(env, host);
    if (!cfg) return { status: 503, error: 'billing-not-configured' };
    const acc = accounts(env);
    const sub = await acc.activeUnlimited(userId);
    if (!sub) return { status: 403, error: 'no-unlimited' };
    const r = await lockUnderUnlimited(env, acc, cfg, calendarId, userId, sub.id, title);
    if (r.retry) return { status: 502, error: 'unavailable' };
    return r;
}

// POST /api/pro/unlock {calendarId}: release a calendar from the owner's Unlimited. A plain unlock: it
// becomes a free calendar again (editable with its link), and its editor links pause for a re-lock.
async function unlimitedUnlock(request, env, body) {
    const userId = await sessionUserId(request, env);
    if (!userId) return json({ error: 'signed-out' }, 401);
    if (!validId(body.calendarId)) return json({ error: 'bad-calendar' }, 400);
    const acc = accounts(env);
    if (!(await acc.coveredByUnlimited(body.calendarId, userId))) return json({ error: 'not-unlimited' }, 409);
    const st = await LockClient.lockStatus(env, body.calendarId);
    if (st.status >= 500 || st.status === 0) return json({ error: 'unavailable' }, 502);
    if (st.ok && st.locked && st.ownerId === userId) {
        const r = await LockClient.unlock(env, body.calendarId, userId);
        if (!r.ok) return r.status >= 500 ? json({ error: 'unavailable' }, 502) : roomError(r);
    }
    await acc.uncoverUnlimited(body.calendarId, userId);
    await acc.removeOwned(userId, body.calendarId);
    return json({ ok: true });
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
    // Test hooks, dev mode only.
    if (devMode(env) && path === '/api/admin/accounts/outbox' && request.method === 'GET') {
        return json({ emails: await acc.listOutbox(String(url.searchParams.get('email') || '').toLowerCase()) });
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
    // As if this account's Pro Unlimited ended ageMs ago, then release whatever short names are past the hold.
    if (devMode(env) && path === '/api/admin/accounts/age-short-holds' && request.method === 'POST') {
        const body = (await readJson(request)) || {};
        if (!Number.isFinite(body.ageMs) || body.ageMs <= 0) return json({ error: 'need ageMs' }, 400);
        await acc.ageShortHolds(String(body.email || '').toLowerCase(), body.ageMs, Array.isArray(body.names) ? body.names.slice(0, 50) : null);
        const released = await acc.sweepShortHolds();
        // The sweep runs in the Accounts object; drop this data center's cached @ lookups for what it ended.
        for (const r of released.filter((x) => x.includes('/'))) { const [hh, nn] = r.slice(1).split('/'); await purgeNames(hh, [nn]); }
        return json({ ok: true, released });
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
