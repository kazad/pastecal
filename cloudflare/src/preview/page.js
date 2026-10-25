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

export const PAGE_BUDGET_MS = 400;
export const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('preview timeout')), ms));

// The address the tags point at: https, on the host the page was asked for (production: pastecal.com).
export function publicOrigin(url) {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) ? url.origin : `https://${url.host}`;
}

/**
 * The room behind a target, and its preview data, or null. A view id must be a view link; an edit
 * name may be any case (the directory knows its stored spelling).
 */
export async function loadPreview(env, target) {
    let roomId = null;
    const dir = env.DIRECTORY ? env.DIRECTORY.get(env.DIRECTORY.idFromName('global')) : null;
    if (dir) {
        const look = await (await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(target.id)}`)).json();
        if (look && look.found) {
            if (target.kind === 'view' && !look.isReadOnly) return null;           // /view/<edit name> is no view link
            roomId = look.targetId || look.actualSlug;
        } else if (target.kind === 'view') return null;
    }
    if (!roomId) roomId = target.id;
    const res = await env.CALENDARS.get(env.CALENDARS.idFromName(roomId)).fetch(`http://internal/cal/${encodeURIComponent(roomId)}/preview`);
    if (!res.ok) return null;
    return res.json();
}

// What changes the card: the calendar's version, the date (events pass), and the branding setting.
export function cardStamp(cal, now) {
    return `${cal.v || 0}-${isoDay(dayOf(now, 'UTC')).replace(/-/g, '')}${cal.pro && cal.hideBranding ? '-nb' : ''}`;
}

/** index.html (an assets Response) with this calendar's tags; the original on any problem or delay. */
export async function previewPage(request, env, assetRes, target, now = Date.now()) {
    if (!assetRes.ok || !(assetRes.headers.get('Content-Type') || '').includes('text/html')) return assetRes;
    const html = await assetRes.text();
    const plain = () => new Response(html, assetRes);
    try {
        const cal = await Promise.race([loadPreview(env, target), timeout(PAGE_BUDGET_MS)]);
        if (!cal) return plain();
        const block = calendarMeta(publicOrigin(new URL(request.url)), target, { title: displayTitle(cal), description: describe(cal, now), stamp: cardStamp(cal, now) });
        const res = new Response(injectMeta(html, block), assetRes);
        res.headers.delete('Content-Length');
        return res;
    } catch (err) {
        console.error('[preview] page meta skipped:', err && err.message);
        return plain();
    }
}
