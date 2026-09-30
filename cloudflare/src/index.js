/**
 * pastecal-sync Worker: routes each calendar's requests to its Durable Object.
 *
 *   GET  /cal/<id>/ws       WebSocket: live sync (see CalendarRoom for the protocol)
 *   GET  /cal/<id>          the calendar as JSON (read-only views, ICS, checks)
 *   PUT  /cal/<id>/import   replace the whole calendar (Authorization: Bearer IMPORT_SECRET)
 */
export { CalendarRoom } from './CalendarRoom.js';

// Any name Firebase allowed: real calendars include "TEAM NUÑEZ", "d&d8", "강아지봉사" and
// trailing spaces (153 of them, Sep 27). Firebase keys can't hold . # $ [ ] / or control chars.
const validId = (id) => id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        // Pages that Firebase Hosting rewrites: /beta and /nativecal/** -> the beta page.
        if (!url.pathname.startsWith('/cal/')) {
            const isFile = /\.[a-z0-9]+$/i.test(url.pathname);
            const beta = url.pathname === '/beta' || url.pathname.startsWith('/beta/') || (url.pathname.startsWith('/nativecal/') && !isFile);
            const res = await env.ASSETS.fetch(beta ? new Request(new URL('/nativecal/', url), request) : request);
            const out = new Response(res.body, res);          // headers on a fetched response are read-only
            out.headers.set('X-Robots-Tag', 'noindex');
            if (/\.(js|css|json)$/.test(url.pathname) || beta) out.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
            return out;
        }
        const m = url.pathname.match(/^\/cal\/([^/]+)(\/ws|\/import)?$/);
        let id = null;
        try { id = m && decodeURIComponent(m[1]); } catch { /* bad escape */ }
        if (!id || !validId(id)) return new Response('not found', { status: 404 });
        if (m[2] === '/import') {
            if (request.method !== 'PUT' || !env.IMPORT_SECRET
                || request.headers.get('Authorization') !== `Bearer ${env.IMPORT_SECRET}`) {
                return new Response('forbidden', { status: 403 });
            }
        }
        if (m[2] === '/ws' && request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected a WebSocket', { status: 426 });
        }
        const room = env.CALENDARS.get(env.CALENDARS.idFromName(id));
        return room.fetch(request);
    },
};
