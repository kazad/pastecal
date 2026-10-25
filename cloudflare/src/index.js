/**
 * pastecal-sync Worker: routes calendar requests to Durable Objects and static assets.
 *
 *   GET  /:id.ics, /view/:id.ics  iCalendar subscription feed (RFC 5545, ETag 304 caching)
 *   GET  /@handle[/<name>[.ics]]  Pro Unlimited names: handle page, a calendar's view page, its feed (Names.js)
 *   GET  /api/account, POST /api/names/*   /account's data and name changes (Names.js)
 *   GET  /api/lookup              Case-insensitive calendar / view lookup
 *   POST /lookupCalendar          Firebase callable compatible lookup endpoint
 *   POST /api/create-view         Create a view-only slug / random publicViewId
 *   POST /createPublicLink        Firebase callable compatible view link creation
 *   GET  /cal/<id>/ws             WebSocket live sync
 *   GET  /cal/<id>                Calendar JSON
 *   GET  /cal/<id>/history        Recent changes history entries for undo
 *   GET  /cal/<id>/authors        Author signal continuity rankings (Bearer IMPORT_SECRET: the uids are proof of creation)
 *   HEAD /cal/<id>                200 / 404 existence check
 *   POST /cal/<id>                Create empty calendar (rate-limited per IP)
 *   PUT  /cal/<id>/import         Full calendar replace (Bearer IMPORT_SECRET)
 *   PUT  /cal/<id>/from-firebase  Firebase sync write (same auth)
 *   /api/auth/*, /api/me, /api/pro/*, /api/stripe/webhook   Pro accounts + billing (Accounts.js)
 *   /api/stats (free counts), /api/pro/stats, /api/pro/versions[/preview|/restore]   stats + restore (Insight.js)
 *   GET|DELETE /api/admin/test-inbox, and the email() handler   Test inbox for test@pastecal.com (TestInbox.js)
 *   POST /api/admin/cal/<id>/{lock,unlock,rotate-editor-key}, GET .../lock-status
 *                                 Pro lock, for support and tests (Bearer IMPORT_SECRET)
 *                                 (+ dev-legacy-key with ACCOUNTS_DEV_MODE=1: a test hook for the key migration)
 *   POST /api/contact             Contact form, incl. calendar reports (Contact.js: same-site, honeypot,
 *                                 fill time, 5 an hour per IP)
 *   GET  /api/admin/messages      Contact messages, newest first (Bearer IMPORT_SECRET)
 */
import { ICSService } from './ICSService.js';
import { SlugService, RESERVED_CALENDAR_NAMES } from './SlugService.js';
import { handleCollect } from './Collector.js';
import { handleContact } from './Contact.js';
import { applySecurityHeaders } from './SecurityHeaders.js';
import { calendarTarget, previewPage, previewImage } from './preview/route.js';
export { CalendarRoom } from './CalendarRoom.js';
export { CalendarDirectory } from './CalendarDirectory.js';
export { Waitlist } from './Waitlist.js';
export { Accounts } from './Accounts.js';
import { handleAccounts, sessionUserId as accountsSessionUserId } from './Accounts.js';
import { handleNames, serveAt, serveNamePage } from './Names.js';
import { PLANS } from './Waitlist.js';
import { handleInsight, hitHeaders, withoutSourceParams } from './Insight.js';
import { handleTestInboxEmail, handleTestInboxAdmin } from './TestInbox.js';
import { timingSafeEqual } from './Stripe.js';
import { allowedOrigins, noindexEverywhere, ROBOTS_DISALLOW_ALL } from './Site.js';

// Admin routes: Authorization: Bearer <IMPORT_SECRET>, compared in constant time. Callers check IMPORT_SECRET is set.
const bearerIsSecret = (request, env) => timingSafeEqual(request.headers.get('Authorization') || '', `Bearer ${env.IMPORT_SECRET}`);

// Any name Firebase allowed: real calendars include "TEAM NUÑEZ", "d&d8", "강아지봉사" and
// trailing spaces. Firebase keys cannot hold . # $ [ ] / or control chars.
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);

async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// What the public may learn from a lookup. A view-only name must never lead back to the
// calendar's edit name: that is full edit access (Oct 2026, the same hole PR #46 closed on
// Firebase). The Worker's own lookups go to the directory directly and still see targetId.
function publicLookup(out) {
    if (!out || !out.isReadOnly) return out;
    return { found: out.found, actualSlug: out.actualSlug, isReadOnly: true, ...(out.ended ? { ended: true } : {}) };
}

// The signed-in pastecal user making this request, or null. The accounts code fills this in
// (validate the session cookie, return the user id). Until then nobody is signed in. Its answer is
// the ONLY source of the trusted X-PC-User header a room sees.
// UNSAFE_DEV_SESSION_HEADER is for local tests only (wrangler dev --var), never in wrangler.jsonc:
// it takes the user from an X-Dev-Session-User header, and only from a loopback client.
// A WebSocket upgrade carries the session cookie even when another site opens it (no CORS for
// sockets), so on sockets the cookie counts only from pastecal's own pages (staging: its SITE_URL; dev
// mode: localhost too, and the http://pastecal.com that wrangler dev rewrites a same-host Origin to).
// Anything else is anonymous.
function trustedSocketOrigin(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (allowedOrigins(env).includes(origin)) return true;
    return env.ACCOUNTS_DEV_MODE === '1' && (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === 'http://pastecal.com');
}

async function sessionUserId(request, env, { socket = false } = {}) {
    // wrangler dev rewrites the URL to the route's host, so "local" is the client address: Cloudflare
    // sets CF-Connecting-IP itself in production, where it is never loopback.
    if (env.UNSAFE_DEV_SESSION_HEADER === 'on' && /^(::1|127\.0\.0\.1)$/.test(request.headers.get('CF-Connecting-IP') || '')) {
        return request.headers.get('X-Dev-Session-User') || null;
    }
    if (socket && !trustedSocketOrigin(request, env)) return null;       // not rejected: embeds still read
    // The pc_session cookie (magic-link sign-in). If the Accounts object fails, the caller is simply
    // anonymous: a calendar socket must never 500 because sign-in is down (viewers and editor links still work).
    try {
        return await accountsSessionUserId(request, env);
    } catch (err) {
        console.error('[Worker] session lookup failed; treating the request as signed out:', err && err.message);
        return null;
    }
}

// A request to forward to a room, without any X-PC-* header the client sent (rooms trust them).
// `userId` is set only from sessionUserId; `hit` only from hitHeaders (stats, Insight.js). The Referer
// is dropped too: rooms never use it, and stats get only the category hitHeaders derived from it.
function forRoom(request, url = request.url, userId = null, hit = null) {
    const headers = new Headers(request.headers);
    for (const k of [...headers.keys()]) if (k.toLowerCase().startsWith('x-pc-')) headers.delete(k);
    headers.delete('Referer');
    if (userId) headers.set('X-PC-User', userId);
    if (hit) for (const [k, v] of Object.entries(hit)) headers.set(k, v);
    return new Request(url, new Request(request, { headers }));
}

// hitHeaders, but a failure there only skips counting: it never fails the read (from prod-counting-live).
function hitFor(request, env, kind) {
    try { return hitHeaders(request, env, kind); } catch (e) { console.error('[stats] hit headers failed:', e && e.message); return null; }
}

// Pages search engines may list (public/_headers clears noindex for the same ones).
const INDEXABLE_PAGES = new Set(['/', '/privacy', '/terms', '/pricing', '/about', '/help', '/templates', '/sitemap.xml']);

const ADMIN_LOCK_OPS = new Set(['lock', 'unlock', 'rotate-editor-key', 'lock-status']);

function getDirectory(env) {
    return env.DIRECTORY ? env.DIRECTORY.get(env.DIRECTORY.idFromName('global')) : null;
}

function withCors(response) {
    if (!response || response.status === 101) return response;
    const res = new Response(response.body, response);
    res.headers.set('Access-Control-Allow-Origin', '*');
    return res;
}

// Staging (preview.pastecal.com) stays out of search everywhere: robots.txt disallows all, and every
// response says noindex. Its wrangler env sends every path through the Worker (run_worker_first: true)
// so this sees static pages too. Production is untouched: noindexEverywhere is false there.
function withStagingHeaders(response) {
    if (!response || response.status === 101) return response;     // a WebSocket upgrade: leave it alone
    const res = new Response(response.body, response);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return res;
}

// The iCalendar feed of the calendar in room `targetId`, named `actualSlug` (a view or short name keeps
// its own name: the feed never shows an edit id). `fileName` overrides the download name.
async function serveFeed(request, env, targetId, actualSlug, fileName = actualSlug) {
    const room = env.CALENDARS.get(env.CALENDARS.idFromName(targetId));
    // Counted as a follow inside the room, during the read it already does (Insight.js hitHeaders).
    const hit = hitFor(request, env, 'follow');
    const roomRes = await room.fetch(new Request(`http://internal/cal/${encodeURIComponent(targetId)}`, hit ? { headers: {
        ...hit, 'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || '', 'User-Agent': request.headers.get('User-Agent') || '' } } : {}));
    if (!roomRes.ok) return new Response('Calendar not found', { status: 404 });
    const roomData = await roomRes.json();
    const cal = roomData?.calendar;
    if (!cal || !cal.id) return new Response('Calendar not found', { status: 404 });

    // The view link every event carries (ICSService): the calendar's view id, never its edit name.
    const viewId = cal.options && typeof cal.options.publicViewId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(cal.options.publicViewId) ? cal.options.publicViewId : '';
    const at = new URL(request.url);   // https on every real host (a dev server may hand the Worker http)
    const origin = /^(localhost|127\.0\.0\.1)$/.test(at.hostname) ? at.origin : `https://${at.host}`;
    const viewUrl = viewId ? `${origin}/view/${viewId}` : '';
    // "v2": the feed's format changed (event links), so every calendar app refetches once.
    const etag = '"' + await sha1Hex('v2' + viewUrl + JSON.stringify(cal.events ?? null)) + '"';
    if (request.headers.get('if-none-match') === etag) {
        return new Response(null, {
            status: 304,
            headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300' }
        });
    }

    const icsText = ICSService.generateICS(cal, actualSlug, { viewUrl });
    return new Response(icsText, {
        status: 200,
        headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            // The name may hold quotes or non-ASCII ("TEAM NUÑEZ"): an ASCII fallback plus the RFC 5987 form.
            'Content-Disposition': `inline; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}.ics"; filename*=UTF-8''${encodeURIComponent(fileName)}.ics`,
            'ETag': etag,
            'Cache-Control': 'public, max-age=300'
        }
    });
}

export default {
    // Inbound mail from Email Routing: only the test inbox addresses are routed here.
    async email(message, env) {
        await handleTestInboxEmail(message, env);
    },

    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (!noindexEverywhere(env, url.hostname)) return route(request, env, ctx);
        if (url.pathname === '/robots.txt') {
            return withStagingHeaders(new Response(ROBOTS_DISALLOW_ALL, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' } }));
        }
        return withStagingHeaders(await route(request, env, ctx));
    },
};

async function route(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-View-Id, If-None-Match',
                    'Access-Control-Expose-Headers': 'ETag',
                    'Access-Control-Max-Age': '86400',
                }
            });
        }
        const url = new URL(request.url);
        const path = url.pathname;

        // Pro Unlimited names: pastecal.com/@handle[/<name>[.ics]] (before slug routing; a new calendar
        // can't start with "@"). null: an old calendar whose id starts with "@" keeps its address.
        if (path.startsWith('/@')) {
            const at = await serveAt(request, env, url, { serveFeed });
            if (at) return at;
        }

        // 1. ICS Feed: /:slug.ics and /view/:slug.ics (a short name is a read-only directory row too)
        const icsMatch = path.match(/^(\/view)?\/([^/]+)\.ics$/i);
        if (icsMatch) {
            let slug = '';
            try { slug = decodeURIComponent(icsMatch[2]); } catch { slug = icsMatch[2]; }
            if (!validId(slug)) return new Response('not found', { status: 404 });

            let targetId = slug;
            let actualSlug = slug;
            const dir = getDirectory(env);
            if (dir) {
                try {
                    const lookupRes = await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(slug)}`);
                    const lookup = await lookupRes.json();
                    if (lookup.ended) return new Response('This link has ended', { status: 410 });   // a released account's short name
                    if (lookup.found) {
                        targetId = lookup.targetId || lookup.actualSlug;
                        actualSlug = lookup.actualSlug;
                    }
                } catch (e) {
                    console.error('[Worker ICS] directory lookup error:', e);
                }
            }
            return serveFeed(request, env, targetId, actualSlug);
        }

        // Account page data and Pro Unlimited names: /api/account, /api/names/*
        const namesRes = await handleNames(request, env, url);
        if (namesRes) return namesRes;

        // Pro stats and restore (before the accounts handler, which owns the rest of /api/pro/*).
        const insightRes = await handleInsight(request, env, url, sessionUserId);
        if (insightRes) return insightRes;

        // Pro accounts and billing: /api/auth/*, /api/me, /api/pro/*, /api/stripe/webhook, /api/admin/accounts/*
        const accountsRes = await handleAccounts(request, env, url);
        if (accountsRes) return accountsRes;

        // Test inbox admin: GET|DELETE /api/admin/test-inbox (Bearer IMPORT_SECRET)
        const inboxRes = await handleTestInboxAdmin(request, env, url);
        if (inboxRes) return inboxRes;

        // Telemetry: POST /api/collect -> Analytics Engine
        if (request.method === 'POST' && path === '/api/collect') return handleCollect(request, env);

        // 2. Directory lookup API: /api/lookup and callable /lookupCalendar
        if ((request.method === 'GET' || request.method === 'POST') && path === '/api/lookup') {
            const dir = getDirectory(env);
            if (!dir) return withCors(Response.json({ found: false }));
            return withCors(Response.json(publicLookup(await (await dir.fetch(request)).json())));
        }

        // Pro waitlist: anyone may sign up (rate-limited, with a hidden field that only bots fill
        // in); only the owner, with IMPORT_SECRET, can export the list.
        if (path === '/api/waitlist' && request.method === 'POST') {
            if (!env.WAITLIST) return withCors(Response.json({ ok: false, error: 'not available' }, { status: 503 }));
            const body = await request.json().catch(() => null);
            if (!body || typeof body !== 'object') return withCors(Response.json({ ok: false, error: 'Send the form as JSON.' }, { status: 400 }));
            if (body.website) return withCors(Response.json({ ok: true }));          // the hidden field: a bot
            const email = String(body.email || '').trim().toLowerCase();
            if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return withCors(Response.json({ ok: false, error: 'Enter an email address, like you@example.com.' }, { status: 400 }));
            }
            if (env.CREATE_LIMITER) {
                const { success } = await env.CREATE_LIMITER.limit({ key: 'waitlist:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
                if (!success) return withCors(Response.json({ ok: false, error: 'Too many tries. Wait a minute and send it again.' }, { status: 429 }));
            }
            const entry = {
                email,
                plan: PLANS.includes(body.plan) ? body.plan : 'unsure',
                use: String(body.use || '').slice(0, 60),
                ideas: String(body.ideas || '').trim().slice(0, 2000),
                country: (request.cf && request.cf.country) || '',
                page: String(body.page || '').slice(0, 200),
            };
            const wl = env.WAITLIST.get(env.WAITLIST.idFromName('pro'));
            return withCors(await wl.fetch('http://internal/add', { method: 'POST', body: JSON.stringify(entry) }));
        }
        if (path === '/api/waitlist/export' && request.method === 'GET') {
            if (!env.WAITLIST || !env.IMPORT_SECRET || !bearerIsSecret(request, env)) {
                return new Response('forbidden', { status: 403 });
            }
            return env.WAITLIST.get(env.WAITLIST.idFromName('pro')).fetch('http://internal/export');
        }

        // Contact form (and calendar reports): public/contact.html. Same-site only, so no CORS.
        if (path === '/api/contact' && request.method === 'POST') return handleContact(request, env);
        if (path === '/api/admin/messages' && request.method === 'GET') {
            if (!env.WAITLIST || !env.IMPORT_SECRET || !bearerIsSecret(request, env)) {
                return new Response('forbidden', { status: 403 });
            }
            return env.WAITLIST.get(env.WAITLIST.idFromName('pro')).fetch('http://internal/messages');
        }

        if (request.method === 'POST' && path === '/lookupCalendar') {
            const body = await request.json().catch(() => ({}));
            const slug = body?.data?.slug || body?.slug;
            const dir = getDirectory(env);
            if (!dir || !slug) return withCors(Response.json({ data: { found: false }, result: { found: false } }));
            const res = await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(slug)}`);
            const out = publicLookup(await res.json());
            return withCors(Response.json({ data: out, result: out }));
        }

        // 3. View creation API: /api/create-view and callable /createPublicLink
        if (request.method === 'POST' && (path === '/api/create-view' || path === '/createPublicLink')) {
            const body = await request.json().catch(() => ({}));
            const payload = body?.data || body;
            const sourceCalendarId = payload?.sourceCalendarId;
            const customSlug = payload?.customSlug;
            const dir = getDirectory(env);
            if (!dir) return Response.json({ ok: false, error: 'Directory unavailable' }, { status: 500 });
            const fail = (status, out) => withCors(Response.json(path === '/createPublicLink' ? { error: out } : out, { status }));

            // Rate-limited per IP (its own key, so it never eats the budget for new calendars).
            if (env.CREATE_LIMITER) {
                const { success } = await env.CREATE_LIMITER.limit({ key: 'view:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
                if (!success) return fail(429, { ok: false, error: 'resource-exhausted', message: 'Too many read-only links from here; try again in a minute' });
            }
            // Before anything is written: the source must be a real calendar, and a custom name must not
            // be a calendar's name (rooms are exact-case, so check what was typed and its stored lowercase form).
            const hasCalendar = async (name) => validId(name)
                && (await env.CALENDARS.get(env.CALENDARS.idFromName(name)).fetch(`http://internal/cal/${encodeURIComponent(name)}`, { method: 'HEAD' })).status === 200;
            if (typeof sourceCalendarId !== 'string' || !(await hasCalendar(sourceCalendarId))) {
                return fail(404, { ok: false, error: 'not-found', message: 'Calendar not found' });
            }
            const room = env.CALENDARS.get(env.CALENDARS.idFromName(sourceCalendarId));
            // A locked calendar's read-only link is made only by its owner or an editor -- checked
            // BEFORE the directory, so no one else can even mint a view name pointing at it.
            const access = await (await room.fetch(`http://internal/cal/${encodeURIComponent(sourceCalendarId)}/can-edit`, {
                method: 'POST',
                body: JSON.stringify({ editorKey: payload?.editorKey, userId: await sessionUserId(request, env) }),
            })).json();
            if (access.locked && !access.canEdit) {
                return fail(403, { ok: false, error: 'locked', message: 'This calendar is locked. Only its owner and people with an editor key can change it.' });
            }
            if (access.paused) return fail(403, { ok: false, error: 'paused', message: 'Editing is paused by the owner.' });   // after Pro ended
            if (customSlug) {
                const typed = String(customSlug).trim();
                for (const name of new Set([typed, typed.toLowerCase()])) {
                    if (await hasCalendar(name)) return fail(409, { ok: false, error: 'already-exists', message: 'Slug is already taken' });
                }
            }

            const dirRes = await dir.fetch('http://internal/create-view', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceCalendarId, customSlug })
            });
            const out = await dirRes.json();
            if (!dirRes.ok || !out.ok) {
                return Response.json(path === '/createPublicLink' ? { error: out } : out, { status: dirRes.status });
            }

            // Save publicViewId into the source room's options: one field, through a narrow internal
            // route (it used to rewrite the whole calendar through /from-firebase, which a lock refuses).
            try {
                await room.fetch(`http://internal/cal/${encodeURIComponent(sourceCalendarId)}/set-view-id`, {
                    method: 'POST',
                    body: JSON.stringify({ publicViewId: out.publicViewId }),
                });
            } catch (err) {
                console.error('[Worker create-view] failed to update source room options:', err);
            }

            if (path === '/createPublicLink') {
                return withCors(Response.json({ data: { publicViewId: out.publicViewId }, result: { publicViewId: out.publicViewId } }));
            }
            return withCors(Response.json(out));
        }

        // Pro lock admin: what the billing code does internally, for support ("lost key", disputes) and tests.
        const adminLock = path.match(/^\/api\/admin\/cal\/([^/]+)\/([a-z-]+)$/);
        if (adminLock) {
            if (!env.IMPORT_SECRET || !bearerIsSecret(request, env)) {
                return new Response('forbidden', { status: 403 });
            }
            let id = null;
            try { id = decodeURIComponent(adminLock[1]); } catch { /* bad escape */ }
            const op = adminLock[2];
            // dev-legacy-key (local tests only) rewrites a lock into its pre-editor-links shape.
            const devOp = op === 'dev-legacy-key' && env.ACCOUNTS_DEV_MODE === '1';
            if (!id || !validId(id) || !(ADMIN_LOCK_OPS.has(op) || devOp)) return new Response('not found', { status: 404 });
            if ((op === 'lock-status') !== (request.method === 'GET')) return new Response('method not allowed', { status: 405 });
            const room = env.CALENDARS.get(env.CALENDARS.idFromName(id));
            return room.fetch(`http://internal/cal/${encodeURIComponent(id)}/${op}`,
                op === 'lock-status' ? {} : { method: 'POST', body: await request.text() });
        }

        // 4. Directory maintenance: /api/directory/*
        if (path === '/api/directory/backfill' && request.method === 'POST') {
            if (!env.IMPORT_SECRET || !bearerIsSecret(request, env)) {
                return new Response('forbidden', { status: 403 });
            }
            const dir = getDirectory(env);
            if (!dir) return Response.json({ ok: false }, { status: 500 });
            return dir.fetch(new Request('http://internal/backfill', request));
        }

        if (path === '/api/directory/stats') {
            const dir = getDirectory(env);
            if (!dir) return withCors(Response.json({ total: 0 }));
            return withCors(await dir.fetch('http://internal/stats'));
        }

        // 5. Read-only views routing: /cal/view/:viewId/ws and /cal/view/:viewId
        const viewMatch = path.match(/^\/cal\/view\/([^/]+)(\/ws)?$/);
        if (viewMatch) {
            let viewId = '';
            try { viewId = decodeURIComponent(viewMatch[1]); } catch { viewId = viewMatch[1]; }
            if (!validId(viewId)) return new Response('not found', { status: 404 });
            // A view link only reads: GET/HEAD and the read-only socket. A POST here once reached the room's
            // create path, so an empty room behind a view id could be created by its viewer, who got back
            // the edit name and became its creator of record (security review, Oct 25 2026).
            if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('read only', { status: 405, headers: { Allow: 'GET, HEAD' } });
            const dir = getDirectory(env);
            let targetId = null;
            if (dir) {
                const lookupRes = await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(viewId)}`);
                const lookup = await lookupRes.json();
                if (lookup.ended) return withCors(new Response('This link has ended', { status: 410 }));
                if (lookup.found && lookup.isReadOnly) {
                    targetId = lookup.targetId;
                }
            }
            if (!targetId) return new Response('not found', { status: 404 });
            if (viewMatch[2] === '/ws' && request.headers.get('Upgrade') !== 'websocket') {
                return new Response('expected a WebSocket', { status: 426 });
            }
            const room = env.CALENDARS.get(env.CALENDARS.idFromName(targetId));
            const subPath = viewMatch[2] === '/ws' ? '/ws' : '';
            const roomUrl = new URL(`http://internal/cal/${encodeURIComponent(targetId)}${subPath}`);
            roomUrl.searchParams.set('view', viewId);
            return withCors(await room.fetch(forRoom(request, roomUrl, null, request.method === 'GET' ? hitFor(request, env, 'view') : null)));
        }

        // 6. Regular /cal/<id> endpoints
        if (path.startsWith('/cal/')) {
            const m = path.match(/^\/cal\/([^/]+)(\/ws|\/import|\/from-firebase|\/archive|\/history|\/authors)?$/);
            let id = null;
            try { id = m && decodeURIComponent(m[1]); } catch { /* bad escape */ }
            if (!id || !validId(id)) return new Response('not found', { status: 404 });

            // The author signal names browsers by uid, and a creator's uid is what lets them upgrade the
            // calendar (CalendarRoom is-creator): support only, never public.
            if (m[2] === '/authors' && (!env.IMPORT_SECRET || !bearerIsSecret(request, env))) {
                return new Response('forbidden', { status: 403 });
            }
            if (m[2] === '/archive' && (request.method !== 'POST' || !env.IMPORT_SECRET || !bearerIsSecret(request, env))) {
                return new Response('forbidden', { status: 403 });
            }
            if (m[2] === '/import' || m[2] === '/from-firebase') {
                if (request.method !== 'PUT' || !env.IMPORT_SECRET
                    || !bearerIsSecret(request, env)) {
                    return new Response('forbidden', { status: 403 });
                }
            }
            if (m[2] === '/ws' && request.headers.get('Upgrade') !== 'websocket') {
                return new Response('expected a WebSocket', { status: 426 });
            }
            if (request.method === 'POST' && !m[2] && (RESERVED_CALENDAR_NAMES.has(id.toLowerCase()) || id.startsWith('@'))) {
                return withCors(Response.json({ ok: false, error: 'reserved name' }, { status: 409 }));
            }
            // A read-only name (a view link, or a Pro Unlimited short name) already answers at this address.
            if (request.method === 'POST' && !m[2]) {
                const dir = getDirectory(env);
                const look = dir ? await (await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(id)}`)).json().catch(() => ({})) : {};
                if (look.found && look.isReadOnly) return withCors(Response.json({ ok: false, error: 'name taken' }, { status: 409 }));
            }
            if (request.method === 'POST' && !m[2] && env.CREATE_LIMITER) {
                const { success } = await env.CREATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
                if (!success) return withCors(Response.json({ ok: false, error: 'too many new calendars from here; try again in a minute' }, { status: 429 }));
            }

            const room = env.CALENDARS.get(env.CALENDARS.idFromName(id));
            // Never pass on a client's X-PC-User; on the WebSocket, set it from the session.
            const userId = m[2] === '/ws' ? await sessionUserId(request, env, { socket: true }) : null;
            const hit = request.method === 'GET' && (!m[2] || m[2] === '/ws') ? hitFor(request, env, 'view') : null;
            return withCors(await room.fetch(forRoom(request, withoutSourceParams(request.url), userId, hit)));
        }

        // Link-preview cards: /og/<name>.png, /og/view/<id>.png (preview/route.js). Always an image.
        if ((request.method === 'GET' || request.method === 'HEAD') && path.startsWith('/og/')) return previewImage(request, env, ctx, url);

        // 7. /link-ended/<name>: the app lands here for a short name whose account was deleted (Names.js).
        const namePage = await serveNamePage(request, env, url);
        if (namePage) return namePage;

        // 8. Static assets & Single Page App rewrites
        const isFile = /\.[a-z0-9]+$/i.test(path);
        const beta = path === '/beta' || path.startsWith('/beta/') || (path.startsWith('/nativecal/') && !isFile);
        let res = await env.ASSETS.fetch(beta ? new Request(new URL('/nativecal/', url), request) : request);
        // A calendar page (/<name>, /view/<id>): index.html with tags about that calendar, for link previews.
        const target = !beta && request.method === 'GET' ? calendarTarget(path, url.search) : null;
        if (target) res = await previewPage(request, env, res, target);
        const out = new Response(res.body, res);
        // Only the test site stays out of search. Sending this on every hostname told Google to drop
        // pastecal.com itself (Oct 2026: organic visitors fell from ~110/week to ~5).
        // Every page passes through here now (link previews). Indexed: the same pages as public/_headers --
        // the homepage, view-only links and the public site pages; never an edit link (/<name>).
        const indexable = url.hostname !== 'new.pastecal.com' && (INDEXABLE_PAGES.has(path) || path.startsWith('/view/') || /^\/templates\/[a-z-]+$/.test(path));   // + the template pages (scripts/build-templates.mjs)
        if (indexable) out.headers.delete('X-Robots-Tag'); else out.headers.set('X-Robots-Tag', 'noindex');
        if (/\.(js|css|json)$/.test(path) || beta) out.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        applySecurityHeaders(out.headers, path);
        return out;
}
