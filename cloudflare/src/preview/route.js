/**
 * Link previews on the Worker:
 *   - calendar pages (/<name>, /view/<id>): index.html with meta tags about that calendar (meta.js);
 *   - GET /og/<name>.png, /og/view/<id>.png: the 1200x630 card (svg.js calendarCard, rasterized here).
 *
 * A preview must never fail and never slow the page much: the page waits at most PAGE_BUDGET_MS for
 * the calendar and otherwise goes out with its generic tags; the image falls back to the static site
 * card (public/img/og-card.png) on any error or timeout. Nothing is counted as a view.
 *
 * Privacy: both link kinds show the same view-safe card -- title and the next 3 events that have not
 * ended, never notes (the room's preview route doesn't even send them). URLs in the tags use only the
 * id from the request path, never the calendar behind a view link.
 */
import resvgWasm from '../vendor/resvg-2.6.2/index_bg.wasm';
import figtree500 from '../vendor/fonts/Figtree-500.ttf';
import figtree700 from '../vendor/fonts/Figtree-700.ttf';
import figtree800 from '../vendor/fonts/Figtree-800.ttf';
import { setup, prepare, toPng } from './render.js';
import { Pen, calendarCard } from './svg.js';
import { cardModel } from './model.js';
import { calendarTarget, STATIC_CARD } from './meta.js';
import { loadPreview, cardStamp, previewPage, timeout } from './page.js';

export const IMAGE_BUDGET_MS = 4000;
const CARD_CACHE_SECONDS = 3600;        // the rendered card, per calendar version and date
const CARD_MAX_AGE = 600;               // what fetchers are told

let figtree = null;
function ensureRenderer() {
    if (!figtree) figtree = { 500: figtree500, 700: figtree700, 800: figtree800 };
    return setup(resvgWasm, figtree);
}

// A fetch through the Cache API, for fallback fonts and emoji (they never change).
function cachedFetcher(ctx) {
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    return async (u) => {
        const key = new Request(u);
        const hit = cache && await cache.match(key);
        if (hit) return hit;
        const res = await fetch(u, { cf: { cacheTtl: 30 * 86400, cacheEverything: true } });
        if (res.ok && cache) {
            const copy = new Response(res.clone().body, res);
            copy.headers.set('Cache-Control', 'public, max-age=2592000');
            ctx && ctx.waitUntil ? ctx.waitUntil(cache.put(key, copy)) : await cache.put(key, copy);
        }
        return res;
    };
}

/** The static site card, as a 200 that fetchers may cache briefly. */
async function staticCard(env, url) {
    const res = await env.ASSETS.fetch(new Request(new URL(STATIC_CARD, url)));
    const out = new Response(res.body, res);
    out.headers.set('Content-Type', 'image/png');
    out.headers.set('Cache-Control', 'public, max-age=300');
    out.headers.set('X-Preview', 'static');
    return out;
}

/** GET /og/<name>.png, /og/view/<id>.png -> the calendar's card. Never an error status. */
export async function previewImage(request, env, ctx, url, now = Date.now()) {
    const m = /^\/og\/((?:view\/)?[^/]+)\.png$/.exec(url.pathname);
    const target = m && calendarTarget('/' + m[1], '');
    if (!target) return staticCard(env, url);
    try {
        return await Promise.race([renderCard(env, ctx, target, now), timeout(IMAGE_BUDGET_MS)]);
    } catch (err) {
        console.error('[preview] card fell back to the static one:', err && err.message);
        return staticCard(env, url);
    }
}

async function renderCard(env, ctx, target, now) {
    const cal = await loadPreview(env, target);
    if (!cal) throw new Error('no calendar');
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    // Keyed on what the card shows, never on the URL's ?v= (anyone can write that).
    const key = new Request(`https://og-cache.pastecal.internal/${target.kind}/${encodeURIComponent(target.id)}/${cardStamp(cal, now)}`);
    const hit = cache && await cache.match(key);
    if (hit) { const out = new Response(hit.body, hit); out.headers.set('Cache-Control', `public, max-age=${CARD_MAX_AGE}`); return out; }
    const t0 = Date.now();
    await ensureRenderer();
    const model = cardModel(cal, now);
    const strings = [[model.title, 800], ...model.events.map((e) => [e.title, 700])];
    const { fontSet, emoji } = await prepare(strings, { fetcher: cachedFetcher(ctx), deadlineMs: 1500 });
    const svg = calendarCard(new Pen(fontSet, emoji), model);
    const png = await toPng(svg, fontSet, 1200);
    const res = new Response(png, { headers: {
        'Content-Type': 'image/png',
        'Cache-Control': `public, max-age=${CARD_MAX_AGE}`,
        'X-Content-Type-Options': 'nosniff',
        'X-Preview-Ms': String(Date.now() - t0),
    } });
    if (cache) {
        const stored = res.clone();
        stored.headers.set('Cache-Control', `public, max-age=${CARD_CACHE_SECONDS}`);
        const put = cache.put(key, stored);
        ctx && ctx.waitUntil ? ctx.waitUntil(put) : await put;
    }
    return res;
}

export { calendarTarget, previewPage };
