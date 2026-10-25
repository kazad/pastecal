/**
 * Link-preview meta tags for calendar pages. When someone pastes pastecal.com/<name> or
 * pastecal.com/view/<id> into iMessage, WhatsApp, Slack, Discord, X, LinkedIn or email, the app's
 * index.html is what the preview fetcher reads; the Worker swaps its generic block (between the
 * `preview:meta` markers) for one about that calendar. Pure: string in, string out.
 */
import { escapeHtml, clip, clean } from './text.js';
import { RESERVED_CALENDAR_NAMES } from '../SlugService.js';

export const META_START = '<!-- preview:meta -->';
export const META_END = '<!-- /preview:meta -->';
export const SITE_NAME = 'pastecal';
export const STATIC_CARD = '/img/og-card.png';

// Top-level pages that are not calendars (public/*.html and app routes), besides the reserved names.
const SITE_PAGES = new Set(['about', 'help', 'contact', 'poll', 'signin', 'report', 'design-ideas', 'pricing-next', 'privacy', 'terms',
    'pricing', 'index', 'og', 'img', 'vendor', 'components', 'services', 'models', 'utils', 'directives', 'demo', 'nativecal', 'beta',
    'account', 'handle', 'link-ended']);

// Any name Firebase allowed (index.js validId).
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);

/**
 * Which calendar a page path names: {kind: 'edit'|'view', id} or null (site pages, files, embeds).
 * A Pro short link (/<short>) is an 'edit' target whose directory row is read-only: it previews its calendar.
 * An @link (/@handle/<name>) is served by Names.js serveAt, which previews its hidden view name (kind 'view').
 */
export function calendarTarget(pathname, search = '') {
    if (/(^|[?&])embed(=|&|$)/i.test(String(search).replace(/^\?/, '&'))) return null;     // embeds: no preview needed
    const parts = String(pathname || '').split('/').filter(Boolean);
    let kind, raw;
    if (parts.length === 1) { kind = 'edit'; raw = parts[0]; }
    else if (parts.length === 2 && parts[0] === 'view') { kind = 'view'; raw = parts[1]; }
    else return null;
    let id;
    try { id = decodeURIComponent(raw); } catch { return null; }
    if (!validId(id)) return null;                     // also: anything with a dot (files)
    if (kind === 'edit' && (RESERVED_CALENDAR_NAMES.has(id.toLowerCase()) || SITE_PAGES.has(id.toLowerCase()))) return null;
    return { kind, id };
}

/** The page's own address, as pasted: https://pastecal.com/<name> or /view/<id>. */
export function pageUrl(origin, target) {
    return `${origin}/${target.kind === 'view' ? 'view/' : ''}${encodeURIComponent(target.id)}`;
}
/** The card image for a calendar page. `stamp` changes when the card should (version + date). */
export function cardUrl(origin, target, stamp) {
    return `${origin}/og/${target.kind === 'view' ? 'view/' : ''}${encodeURIComponent(target.id)}.png${stamp ? `?v=${encodeURIComponent(stamp)}` : ''}`;
}

/**
 * The meta block: {title (page and og), description, url, image, imageAlt, type}.
 * Every value is escaped here; callers pass plain text.
 */
export function metaBlock({ title, description, url, image, imageAlt, type = 'website', docTitle = null }) {
    const t = escapeHtml(clip(clean(title), 90));
    const d = escapeHtml(clip(clean(description), 200));
    const u = escapeHtml(url), img = escapeHtml(image), alt = escapeHtml(clip(clean(imageAlt || title), 120));
    return [
        META_START,
        `<title>${escapeHtml(clip(clean(docTitle || title), 120))}</title>`,
        `<meta name="description" content="${d}">`,
        `<meta property="og:site_name" content="${SITE_NAME}">`,
        `<meta property="og:type" content="${escapeHtml(type)}">`,
        `<meta property="og:url" content="${u}">`,
        `<meta property="og:title" content="${t}">`,
        `<meta property="og:description" content="${d}">`,
        `<meta property="og:image" content="${img}">`,
        `<meta property="og:image:type" content="image/png">`,
        `<meta property="og:image:width" content="1200">`,
        `<meta property="og:image:height" content="630">`,
        `<meta property="og:image:alt" content="${alt}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${t}">`,
        `<meta name="twitter:description" content="${d}">`,
        `<meta name="twitter:image" content="${img}">`,
        `<meta name="twitter:image:alt" content="${alt}">`,
        `<link rel="canonical" href="${u}">`,
        META_END,
    ].join('\n    ');
}

/** index.html with its marked meta block replaced. Unchanged if the markers are missing. */
export function injectMeta(html, block) {
    const a = html.indexOf(META_START), b = html.indexOf(META_END);
    if (a < 0 || b < a) return html;
    return html.slice(0, a) + block + html.slice(b + META_END.length);
}

/** The meta for a calendar page from its preview (model.js) values. */
export function calendarMeta(origin, target, { title, description, stamp, url = null }) {
    return metaBlock({
        title,
        description,
        url: url || pageUrl(origin, target),          // url: the address as shared, when it isn't the target's own (an @link)
        image: cardUrl(origin, target, stamp),
        imageAlt: `${title}: upcoming events`,
        docTitle: `${title} · pastecal`,
    });
}
