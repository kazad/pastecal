/**
 * pastecal-sync Worker: routes calendar requests to Durable Objects and static assets.
 *
 *   GET  /:id.ics, /view/:id.ics  iCalendar subscription feed (RFC 5545, ETag 304 caching)
 *   GET  /api/lookup              Case-insensitive calendar / view lookup
 *   POST /lookupCalendar          Firebase callable compatible lookup endpoint
 *   POST /api/create-view         Create a view-only slug / random publicViewId
 *   POST /createPublicLink        Firebase callable compatible view link creation
 *   GET  /cal/<id>/ws             WebSocket live sync
 *   GET  /cal/<id>                Calendar JSON
 *   GET  /cal/<id>/history        Recent changes history entries for undo
 *   GET  /cal/<id>/authors        Author signal continuity rankings
 *   HEAD /cal/<id>                200 / 404 existence check
 *   POST /cal/<id>                Create empty calendar (rate-limited per IP)
 *   PUT  /cal/<id>/import         Full calendar replace (Bearer IMPORT_SECRET)
 *   PUT  /cal/<id>/from-firebase  Firebase sync write (same auth)
 *   /api/auth/*, /api/me, /api/pro/*, /api/stripe/webhook   Pro accounts + billing (Accounts.js)
 *   /api/pro/stats, /api/pro/versions[/preview|/restore]     Pro stats + restore (Insight.js)
 *   POST /api/admin/cal/<id>/{lock,unlock,rotate-editor-key}, GET .../lock-status
 *                                 Pro lock, for support and tests (Bearer IMPORT_SECRET)
 */
import { ICSService } from './ICSService.js';
import { SlugService } from './SlugService.js';
import { handleCollect } from './Collector.js';
export { CalendarRoom } from './CalendarRoom.js';
export { CalendarDirectory } from './CalendarDirectory.js';
export { Waitlist } from './Waitlist.js';
export { Accounts } from './Accounts.js';
import { handleAccounts, sessionUserId as accountsSessionUserId } from './Accounts.js';
import { PLANS } from './Waitlist.js';
import { handleInsight, hitHeaders } from './Insight.js';

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
    return { found: out.found, actualSlug: out.actualSlug, isReadOnly: true };
}

// The signed-in pastecal user making this request, or null. The accounts code fills this in
// (validate the session cookie, return the user id). Until then nobody is signed in. Its answer is
// the ONLY source of the trusted X-PC-User header a room sees.
// UNSAFE_DEV_SESSION_HEADER is for local tests only (wrangler dev --var), never in wrangler.jsonc:
// it takes the user from an X-Dev-Session-User header, and only from a loopback client.
async function sessionUserId(request, env) {
    // wrangler dev rewrites the URL to the route's host, so "local" is the client address: Cloudflare
    // sets CF-Connecting-IP itself in production, where it is never loopback.
    if (env.UNSAFE_DEV_SESSION_HEADER === 'on' && /^(::1|127\.0\.0\.1)$/.test(request.headers.get('CF-Connecting-IP') || '')) {
        return request.headers.get('X-Dev-Session-User') || null;
    }
    return accountsSessionUserId(request, env);   // the pc_session cookie (magic-link sign-in)
}

// A request to forward to a room, without any X-PC-* header the client sent (rooms trust them).
// `userId` is set only from sessionUserId; `hit` only from hitHeaders (stats, Insight.js).
function forRoom(request, url = request.url, userId = null, hit = null) {
    const headers = new Headers(request.headers);
    for (const k of [...headers.keys()]) if (k.toLowerCase().startsWith('x-pc-')) headers.delete(k);
    if (userId) headers.set('X-PC-User', userId);
    if (hit) for (const [k, v] of Object.entries(hit)) headers.set(k, v);
    return new Request(url, new Request(request, { headers }));
}

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

export default {
    async fetch(request, env) {
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

        // 1. ICS Feed: /:slug.ics and /view/:slug.ics
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
                    if (lookup.found) {
                        targetId = lookup.targetId || lookup.actualSlug;
                        actualSlug = lookup.actualSlug;
                    }
                } catch (e) {
                    console.error('[Worker ICS] directory lookup error:', e);
                }
            }

            const room = env.CALENDARS.get(env.CALENDARS.idFromName(targetId));
            // Counted as a follow inside the room, during the read it already does (Insight.js hitHeaders).
            const hit = hitHeaders(request, env, 'follow');
            const roomRes = await room.fetch(new Request(`http://internal/cal/${encodeURIComponent(targetId)}`, hit ? { headers: {
                ...hit, 'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || '', 'User-Agent': request.headers.get('User-Agent') || '' } } : {}));
            if (!roomRes.ok) return new Response('Calendar not found', { status: 404 });
            const roomData = await roomRes.json();
            const cal = roomData?.calendar;
            if (!cal || !cal.id) return new Response('Calendar not found', { status: 404 });

            const etag = '"' + await sha1Hex(JSON.stringify(cal.events ?? null)) + '"';
            if (request.headers.get('if-none-match') === etag) {
                return new Response(null, {
                    status: 304,
                    headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300' }
                });
            }

            const icsText = ICSService.generateICS(cal, actualSlug);
            return new Response(icsText, {
                status: 200,
                headers: {
                    'Content-Type': 'text/calendar; charset=utf-8',
                    'Content-Disposition': `inline; filename="${actualSlug}.ics"`,
                    'ETag': etag,
                    'Cache-Control': 'public, max-age=300'
                }
            });
        }

        // Pro stats and restore (before the accounts handler, which owns the rest of /api/pro/*).
        const insightRes = await handleInsight(request, env, url, sessionUserId);
        if (insightRes) return insightRes;

        // Pro accounts and billing: /api/auth/*, /api/me, /api/pro/*, /api/stripe/webhook, /api/admin/accounts/*
        const accountsRes = await handleAccounts(request, env, url);
        if (accountsRes) return accountsRes;

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
            if (!env.WAITLIST || !env.IMPORT_SECRET || request.headers.get('Authorization') !== `Bearer ${env.IMPORT_SECRET}`) {
                return new Response('forbidden', { status: 403 });
            }
            return env.WAITLIST.get(env.WAITLIST.idFromName('pro')).fetch('http://internal/export');
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
            if (typeof sourceCalendarId !== 'string' || !validId(sourceCalendarId)) {
                return withCors(Response.json({ ok: false, error: 'invalid-argument', message: 'sourceCalendarId is required' }, { status: 400 }));
            }
            const room = env.CALENDARS.get(env.CALENDARS.idFromName(sourceCalendarId));
            // A locked calendar's read-only link is made only by its owner or an editor -- checked
            // BEFORE the directory, so no one else can even mint a view name pointing at it.
            const access = await (await room.fetch(`http://internal/cal/${encodeURIComponent(sourceCalendarId)}/can-edit`, {
                method: 'POST',
                body: JSON.stringify({ editorKey: payload?.editorKey, userId: await sessionUserId(request, env) }),
            })).json();
            if (access.locked && !access.canEdit) {
                const err = { ok: false, error: 'locked', message: 'This calendar is locked. Only its owner and people with an editor key can change it.' };
                return withCors(Response.json(path === '/createPublicLink' ? { error: err } : err, { status: 403 }));
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
            if (!env.IMPORT_SECRET || request.headers.get('Authorization') !== `Bearer ${env.IMPORT_SECRET}`) {
                return new Response('forbidden', { status: 403 });
            }
            let id = null;
            try { id = decodeURIComponent(adminLock[1]); } catch { /* bad escape */ }
            const op = adminLock[2];
            if (!id || !validId(id) || !ADMIN_LOCK_OPS.has(op)) return new Response('not found', { status: 404 });
            if ((op === 'lock-status') !== (request.method === 'GET')) return new Response('method not allowed', { status: 405 });
            const room = env.CALENDARS.get(env.CALENDARS.idFromName(id));
            return room.fetch(`http://internal/cal/${encodeURIComponent(id)}/${op}`,
                op === 'lock-status' ? {} : { method: 'POST', body: await request.text() });
        }

        // 4. Directory maintenance: /api/directory/*
        if (path === '/api/directory/backfill' && request.method === 'POST') {
            if (!env.IMPORT_SECRET || request.headers.get('Authorization') !== `Bearer ${env.IMPORT_SECRET}`) {
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
            const dir = getDirectory(env);
            let targetId = null;
            if (dir) {
                const lookupRes = await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(viewId)}`);
                const lookup = await lookupRes.json();
                if (lookup.found && lookup.isReadOnly) {
                    targetId = lookup.targetId;
                }
            }
            if (!targetId) return new Response('not found', { status: 404 });
            const room = env.CALENDARS.get(env.CALENDARS.idFromName(targetId));
            const subPath = viewMatch[2] === '/ws' ? '/ws' : '';
            const roomUrl = new URL(`http://internal/cal/${encodeURIComponent(targetId)}${subPath}`);
            roomUrl.searchParams.set('view', viewId);
            return withCors(await room.fetch(forRoom(request, roomUrl, null, request.method === 'GET' ? hitHeaders(request, env, 'view') : null)));
        }

        // 6. Regular /cal/<id> endpoints
        if (path.startsWith('/cal/')) {
            const m = path.match(/^\/cal\/([^/]+)(\/ws|\/import|\/from-firebase|\/archive|\/history|\/authors)?$/);
            let id = null;
            try { id = m && decodeURIComponent(m[1]); } catch { /* bad escape */ }
            if (!id || !validId(id)) return new Response('not found', { status: 404 });

            if (m[2] === '/archive' && (request.method !== 'POST' || !env.IMPORT_SECRET || request.headers.get('Authorization') !== `Bearer ${env.IMPORT_SECRET}`)) {
                return new Response('forbidden', { status: 403 });
            }
            if (m[2] === '/import' || m[2] === '/from-firebase') {
                if (request.method !== 'PUT' || !env.IMPORT_SECRET
                    || request.headers.get('Authorization') !== `Bearer ${env.IMPORT_SECRET}`) {
                    return new Response('forbidden', { status: 403 });
                }
            }
            if (m[2] === '/ws' && request.headers.get('Upgrade') !== 'websocket') {
                return new Response('expected a WebSocket', { status: 426 });
            }
            if (request.method === 'POST' && !m[2] && env.CREATE_LIMITER) {
                const { success } = await env.CREATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
                if (!success) return withCors(Response.json({ ok: false, error: 'too many new calendars from here; try again in a minute' }, { status: 429 }));
            }

            const room = env.CALENDARS.get(env.CALENDARS.idFromName(id));
            // Never pass on a client's X-PC-User; on the WebSocket, set it from the session.
            const userId = m[2] === '/ws' ? await sessionUserId(request, env) : null;
            const hit = request.method === 'GET' && (!m[2] || m[2] === '/ws') ? hitHeaders(request, env, 'view') : null;
            return withCors(await room.fetch(forRoom(request, request.url, userId, hit)));
        }

        // 7. Static assets & Single Page App rewrites
        const isFile = /\.[a-z0-9]+$/i.test(path);
        const beta = path === '/beta' || path.startsWith('/beta/') || (path.startsWith('/nativecal/') && !isFile);
        const res = await env.ASSETS.fetch(beta ? new Request(new URL('/nativecal/', url), request) : request);
        const out = new Response(res.body, res);
        // Only the test site stays out of search. Sending this on every hostname told Google to drop
        // pastecal.com itself (Oct 2026: organic visitors fell from ~110/week to ~5).
        // Pages served here are beta EDIT links; only / and /view/ may be indexed (see public/_headers).
        const indexable = url.hostname !== 'new.pastecal.com' && (path === '/' || path.startsWith('/view/'));
        if (indexable) out.headers.delete('X-Robots-Tag'); else out.headers.set('X-Robots-Tag', 'noindex');
        if (/\.(js|css|json)$/.test(path) || beta) out.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return out;
    },
};
