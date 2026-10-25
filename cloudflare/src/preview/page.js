/**
 * Link-preview tags on calendar pages (/<name>, /view/<id>), and loading a calendar's preview data.
 * Kept apart from route.js (which imports the wasm renderer) so node tests can load it.
 *
 * The page waits at most PAGE_BUDGET_MS for the calendar; on a miss, an error or a slow room it goes
 * out unchanged, with its generic tags. Privacy: both link kinds get the same view-safe values, and the
 * tags carry only the id from the request path, never the calendar behind a view link.
 */
import { describe, displayTitle } from './model.js';
import { calendarMeta, injectMeta } from './meta.js';
import { isoDay, dayOf } from './time.js';

export const PAGE_BUDGET_MS = 400;        // a person opening the link
export const BOT_BUDGET_MS = 2000;        // a link-preview fetcher: it caches what it gets, so a miss sticks
// The fetchers behind link previews (and search engines), in one place. Only these get per-calendar tags:
// a person opening a link gets the static page at once, with no directory or room lookup (the app sets its
// own title). iMessage previews with a Safari UA that names facebookexternalhit/Twitterbot; "LinkPreview"
// and the og checkers (opengraph.xyz, metatags.io, ...) name themselves.
export const PREVIEW_BOTS = /facebookexternalhit|facebot|twitterbot|slackbot|discordbot|whatsapp|linkedinbot|telegrambot|applebot|googlebot|bingbot|embedly|redditbot|skypeuripreview|mastodon|pinterest|iframely|vkshare|quora link preview|outbrain|w3c_validator|linkpreview|opengraph|metatags|preview\.?(bot|app)|snapchat|viber|line\/|kakaotalk|zoominfobot|yahoo! slurp|duckduckbot/i;
export const isPreviewBot = (request) => PREVIEW_BOTS.test(request.headers.get('User-Agent') || '');
export const pageBudget = (request) => (isPreviewBot(request) ? BOT_BUDGET_MS : PAGE_BUDGET_MS);
export const META_CACHE_SECONDS = 120;    // the rendered tags per calendar link: bots re-fetch, but rarely within this
export const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('preview timeout')), ms));

// The address the tags point at: https, on the host the page was asked for (production: pastecal.com).
export function publicOrigin(url) {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) ? url.origin : `https://${url.host}`;
}

/**
 * The room behind a target, and its preview data, or null. A view id must be a view link; an edit
 * name may be any case (the directory knows its stored spelling). A name the directory doesn't know
 * gets no preview: asking its room would create an empty one for every scanned path (/wp-admin...).
 * The answer must be the preview shape: a room running older code answers this path with its whole
 * calendar, which would read as an untitled calendar with no events.
 */
export async function loadPreview(env, target) {
    let roomId = null;
    const dir = env.DIRECTORY ? env.DIRECTORY.get(env.DIRECTORY.idFromName('global')) : null;
    if (dir) {
        const look = await (await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(target.id)}`)).json();
        if (look && look.found) {
            if (look.ended || (look.isReadOnly && !look.targetId)) return null;    // a tombstone ("This link has ended"): no room behind it
            if (target.kind === 'view' && !look.isReadOnly) return null;           // /view/<edit name> is no view link
            roomId = look.targetId || look.actualSlug;
        } else return null;
    }
    if (!roomId) roomId = target.id;          // no directory binding (tests): the name is the room
    const res = await env.CALENDARS.get(env.CALENDARS.idFromName(roomId)).fetch(`http://internal/cal/${encodeURIComponent(roomId)}/preview`);
    if (!res.ok) return null;
    const data = await res.json();
    return data && Array.isArray(data.events) && Array.isArray(data.zoneSamples) ? data : null;
}

// What changes the card: the calendar's version, the date (events pass), and the branding setting.
export function cardStamp(cal, now) {
    // the zone too: storing a calendar's time zone doesn't bump its version, but it changes the card's times
    const zone = cal.tz ? '-' + String(cal.tz).replace(/[^A-Za-z]/g, '').slice(0, 12) : '';
    return `${cal.v || 0}-${isoDay(dayOf(now, 'UTC')).replace(/-/g, '')}${zone}${cal.pro && cal.hideBranding ? '-nb' : ''}`;
}

/**
 * index.html (an assets Response) with this calendar's tags; the original on any problem or delay.
 * url: the address as shared when it isn't the target's own (an @link previews its hidden view name).
 * fallback: a meta block for when the calendar can't be read in time (else the page's generic tags).
 */
export async function previewPage(request, env, assetRes, target, now = Date.now(), { url = null, fallback = null } = {}) {
    if (!assetRes.ok || !(assetRes.headers.get('Content-Type') || '').includes('text/html')) return assetRes;
    // People: the static page (with the fallback tags if the caller has them), and not one lookup.
    if (!isPreviewBot(request)) {
        if (!fallback) return assetRes;
        const res = new Response(injectMeta(await assetRes.text(), fallback), assetRes);
        res.headers.delete('Content-Length'); res.headers.delete('ETag');
        return res;
    }
    const html = await assetRes.text();
    const plain = () => {
        if (!fallback) return new Response(html, assetRes);
        const res = new Response(injectMeta(html, fallback), assetRes);
        res.headers.delete('Content-Length'); res.headers.delete('ETag');
        return res;
    };
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const origin = publicOrigin(new URL(request.url));
    // Keyed on the link and the day (events pass); a short TTL covers edits.
    const key = new Request(`https://meta-cache.pastecal.internal/${target.kind}/${encodeURIComponent(target.id)}/${isoDay(dayOf(now, 'UTC'))}?o=${encodeURIComponent(origin)}&u=${encodeURIComponent(url || '')}`);
    const send = (block) => { const res = new Response(injectMeta(html, block), assetRes); res.headers.delete('Content-Length'); res.headers.delete('ETag'); return res; };
    try {
        const hit = cache && await cache.match(key).catch(() => null);
        if (hit) return send(await hit.text());
        const cal = await Promise.race([loadPreview(env, target), timeout(pageBudget(request))]);
        if (!cal) return plain();
        const block = calendarMeta(origin, target, { title: displayTitle(cal), description: describe(cal, now), stamp: cardStamp(cal, now), url });
        if (cache) await cache.put(key, new Response(block, { headers: { 'Cache-Control': `max-age=${META_CACHE_SECONDS}` } })).catch(() => {});
        const res = new Response(injectMeta(html, block), assetRes);
        res.headers.delete('Content-Length');
        res.headers.delete('ETag');                  // the asset's ETag names the generic page, not this one
        return res;
    } catch (err) {
        console.error('[preview] page meta skipped:', err && err.message);
        return plain();
    }
}
