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
 */
import { ICSService } from './ICSService.js';
import { SlugService } from './SlugService.js';
export { CalendarRoom } from './CalendarRoom.js';
export { CalendarDirectory } from './CalendarDirectory.js';

// Any name Firebase allowed: real calendars include "TEAM NUÑEZ", "d&d8", "강아지봉사" and
// trailing spaces. Firebase keys cannot hold . # $ [ ] / or control chars.
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);

async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getDirectory(env) {
    return env.DIRECTORY ? env.DIRECTORY.get(env.DIRECTORY.idFromName('global')) : null;
}

export default {
    async fetch(request, env) {
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
            const roomRes = await room.fetch(new Request(`http://internal/cal/${encodeURIComponent(targetId)}`));
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

        // 2. Directory lookup API: /api/lookup and callable /lookupCalendar
        if ((request.method === 'GET' || request.method === 'POST') && path === '/api/lookup') {
            const dir = getDirectory(env);
            if (!dir) return Response.json({ found: false });
            return dir.fetch(request);
        }

        if (request.method === 'POST' && path === '/lookupCalendar') {
            const body = await request.json().catch(() => ({}));
            const slug = body?.data?.slug || body?.slug;
            const dir = getDirectory(env);
            if (!dir || !slug) return Response.json({ data: { found: false }, result: { found: false } });
            const res = await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(slug)}`);
            const out = await res.json();
            return Response.json({ data: out, result: out });
        }

        // 3. View creation API: /api/create-view and callable /createPublicLink
        if (request.method === 'POST' && (path === '/api/create-view' || path === '/createPublicLink')) {
            const body = await request.json().catch(() => ({}));
            const payload = body?.data || body;
            const sourceCalendarId = payload?.sourceCalendarId;
            const customSlug = payload?.customSlug;
            const dir = getDirectory(env);
            if (!dir) return Response.json({ ok: false, error: 'Directory unavailable' }, { status: 500 });

            const dirRes = await dir.fetch('http://internal/create-view', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceCalendarId, customSlug })
            });
            const out = await dirRes.json();
            if (!dirRes.ok || !out.ok) {
                return Response.json(path === '/createPublicLink' ? { error: out } : out, { status: dirRes.status });
            }

            // Save publicViewId into the source room's options
            try {
                const room = env.CALENDARS.get(env.CALENDARS.idFromName(sourceCalendarId));
                const getRes = await room.fetch(`http://internal/cal/${encodeURIComponent(sourceCalendarId)}`);
                if (getRes.ok) {
                    const current = await getRes.json();
                    if (current?.calendar) {
                        const nextOptions = { ...(current.calendar.options || {}), publicViewId: out.publicViewId };
                        await room.fetch(`http://internal/cal/${encodeURIComponent(sourceCalendarId)}/from-firebase`, {
                            method: 'PUT',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bearer ${env.IMPORT_SECRET || 'dev-secret'}`
                            },
                            body: JSON.stringify({ ...current.calendar, options: nextOptions })
                        });
                    }
                }
            } catch (err) {
                console.error('[Worker create-view] failed to update source room options:', err);
            }

            if (path === '/createPublicLink') {
                return Response.json({ data: { publicViewId: out.publicViewId }, result: { publicViewId: out.publicViewId } });
            }
            return Response.json(out);
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
            if (!dir) return Response.json({ total: 0 });
            return dir.fetch('http://internal/stats');
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
            return room.fetch(new Request(roomUrl, request));
        }

        // 6. Regular /cal/<id> endpoints
        if (path.startsWith('/cal/')) {
            const m = path.match(/^\/cal\/([^/]+)(\/ws|\/import|\/from-firebase|\/history|\/authors)?$/);
            let id = null;
            try { id = m && decodeURIComponent(m[1]); } catch { /* bad escape */ }
            if (!id || !validId(id)) return new Response('not found', { status: 404 });

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
                if (!success) return Response.json({ ok: false, error: 'too many new calendars from here; try again in a minute' }, { status: 429 });
            }

            const room = env.CALENDARS.get(env.CALENDARS.idFromName(id));
            return room.fetch(request);
        }

        // 7. Static assets & Single Page App rewrites
        const isFile = /\.[a-z0-9]+$/i.test(path);
        const beta = path === '/beta' || path.startsWith('/beta/') || (path.startsWith('/nativecal/') && !isFile);
        const res = await env.ASSETS.fetch(beta ? new Request(new URL('/nativecal/', url), request) : request);
        const out = new Response(res.body, res);
        out.headers.set('X-Robots-Tag', 'noindex');
        if (/\.(js|css|json)$/.test(path) || beta) out.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return out;
    },
};
