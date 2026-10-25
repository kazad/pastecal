/**
 * Insight -- the Worker half of per-calendar stats COUNTING (the room half is RoomInsight.js). This
 * is the production subset of the Pro branch's Insight.js: it marks calendar reads as countable hits
 * and nothing else. There is no stats read endpoint here (the Pro branch adds /api/stats and
 * /api/pro/stats); the only read path is a test hook that answers in dev mode only.
 *
 * hitHeaders() is here because the Worker is the only one that may say a request is a hit: rooms
 * trust X-PC-*, so index.js strips every X-PC-* header a client sent before forwarding (forRoom).
 *
 * Test hook (dev mode + admin secret), exactly as on the Pro branch:
 *   GET /api/admin/cal/<id>/stats-dump   (Authorization: Bearer IMPORT_SECRET, and ACCOUNTS_DEV_MODE=1)
 *        -> {daily:[...], seen:[{kind, hash, last_at}], saltDays:[day]}
 * ACCOUNTS_DEV_MODE is for local tests only (--var / .dev.vars); never set it in production.
 */
import { sourceOf } from './RoomInsight.js';

const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);
const devMode = (env) => env.ACCOUNTS_DEV_MODE === '1';

// Crawlers, link previews, monitors, scripts. Calendar apps (Google-Calendar-Importer, Outlook,
// iOS dataaccessd) don't match. The uptime check and GitHub Actions use curl.
const BOT_UA = /bot\b|bot\/|crawler|spider|preview|monitor|uptime|headless|lighthouse|curl\/|wget|python-requests|go-http-client|github/i;
export function isBot(request) {
    const bm = request.cf && request.cf.botManagement;
    if (bm && (bm.verifiedBot === true || (typeof bm.score === 'number' && bm.score > 0 && bm.score < 30))) return true;
    const ua = request.headers.get('User-Agent') || '';
    return !ua || BOT_UA.test(ua);
}

// Headers that mark a forwarded calendar read as a hit ('view' or 'follow'), with the place it came
// from (request.cf; wrangler dev fills it with this machine's place). null for bots. City is
// URI-encoded: header values must be Latin-1. A view also carries where it came from, as a category
// only (RoomInsight.sourceOf): the Referer and the page's ?ref= host stop here.
export function hitHeaders(request, env, kind) {
    if (isBot(request)) return null;
    const country = (request.cf && request.cf.country) || '', city = (request.cf && request.cf.city) || '';
    const h = { 'X-PC-Hit': kind, 'X-PC-Geo-Country': String(country).slice(0, 2), 'X-PC-Geo-City': encodeURIComponent(String(city).slice(0, 80)) };
    if (kind === 'view') {
        const url = new URL(request.url);
        // The page sends where it was opened from as a category only (?src=embed|search|site), so no other
        // site's hostname reaches a URL or a log. ?embed / ?ref still work for older pages.
        const src = url.searchParams.get('src') || '';
        h['X-PC-Source'] = /^(embed|search|site|direct)$/.test(src) ? src : sourceOf({ dest: request.headers.get('Sec-Fetch-Dest') || '', embed: url.searchParams.get('embed') || '',
            ref: url.searchParams.get('ref') || '', referer: request.headers.get('Referer') || '', host: url.host });
    }
    return h;
}
// The page's source markers (?embed=1, ?ref=<host>), removed from a URL before it goes to a room.
// A URL without any of them is returned exactly as it came (no re-serialized query).
export const SOURCE_PARAMS = ['embed', 'ref', 'src'];
export function withoutSourceParams(u) {
    const url = new URL(u);
    if (!SOURCE_PARAMS.some((k) => url.searchParams.has(k))) return u;
    for (const k of SOURCE_PARAMS) url.searchParams.delete(k);
    return url.toString();
}

// Returns a Response for the test hook, or null for every other path.
export async function handleInsight(request, env, url) {
    const dump = url.pathname.match(/^\/api\/admin\/cal\/([^/]+)\/stats-dump$/);
    if (!dump) return null;
    if (!devMode(env) || !env.IMPORT_SECRET || request.headers.get('Authorization') !== `Bearer ${env.IMPORT_SECRET}`) return new Response('forbidden', { status: 403 });
    let id = null; try { id = decodeURIComponent(dump[1]); } catch { /* bad escape */ }
    if (!validId(id)) return new Response('not found', { status: 404 });
    return env.CALENDARS.get(env.CALENDARS.idFromName(id)).fetch(`http://internal/cal/${encodeURIComponent(id)}/stats-dump`);
}
