/**
 * Security headers for the pages. The same values are in public/_headers (for pages served
 * straight from the assets); the Worker sets them on the pages it serves itself ("/", /beta,
 * /nativecal/*), because a "/" rule in _headers did not apply on the live site (Oct 2026).
 * cloudflare/test/headers.test.mjs keeps the two copies equal.
 *
 * script-src keeps 'unsafe-inline' and 'unsafe-eval' for now (interim, documented):
 *   - 'unsafe-eval': Vue's global build compiles the in-page templates with new Function, and
 *     so do Syncfusion's templates; without it the page is blank.
 *   - 'unsafe-inline': index.html has inline scripts (GTM, gtag, theme, Firebase config) and the
 *     GTM container injects Hotjar and Clarity as inline custom-HTML tags.
 * What the policy still enforces: scripts only from these hosts, no plugins (object-src), no
 * <base> hijack, forms post only here, and framing: edit pages ('none') vs /view/* (embeds are
 * a feature: frame-ancestors *).
 */
export const CSP_BASE = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://*.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://www.gstatic.com https://apis.google.com https://*.firebaseio.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://static.cloudflareinsights.com https://*.hotjar.com https://*.clarity.ms",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.hotjar.com",
    "font-src 'self' data: https://fonts.gstatic.com https://*.hotjar.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https: wss://pastecal.com wss://www.pastecal.com wss://new.pastecal.com wss://*.firebaseio.com wss://*.hotjar.com wss://*.clarity.ms",
    "frame-src 'self' https://pastecal-web.firebaseapp.com https://*.firebaseio.com https://*.hotjar.com https://www.googletagmanager.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

export const isViewPath = (path) => path === '/view' || path.startsWith('/view/');

export function cspFor(path) {
    return `${CSP_BASE}; frame-ancestors ${isViewPath(path) ? '*' : "'none'"}`;
}

/** Set the page security headers on a (mutable) Response for `path`. */
export function applySecurityHeaders(headers, path) {
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    const type = headers.get('Content-Type') || '';
    if (type.includes('text/html')) headers.set('Content-Security-Policy', cspFor(path));
}
