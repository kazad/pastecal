/**
 * Which site this Worker is: production (pastecal.com) or the staging copy (preview.pastecal.com).
 *
 * SITE_URL (a var, set only in env.staging) is the site's own origin, e.g. https://preview.pastecal.com.
 * Unset, it is https://pastecal.com. Every link the Worker writes (sign-in and welcome emails,
 * Checkout success/cancel, the billing portal's return) starts with siteUrl(env), never with the
 * request's host: production also answers on new.pastecal.com and workers.dev.
 *
 * Staging is a SITE_URL whose host is not a production host. Only then:
 *   - allowedOrigins is that one origin (cookie POSTs and session sockets), instead of pastecal.com + www;
 *   - BILLING_TEST_MODE=1 lets a Stripe TEST key work, and only on requests to SITE_URL's own host
 *     (testKeyAllowed). A production Worker (no SITE_URL) never accepts a test key this way.
 *   - every response says noindex (index.js).
 */
export const PRODUCTION_SITE = 'https://pastecal.com';
export const PRODUCTION_HOSTS = ['pastecal.com', 'www.pastecal.com'];
export const PRODUCTION_ORIGINS = ['https://pastecal.com', 'https://www.pastecal.com'];

// https://<host> and nothing else (no path, port, user or query), or null.
function cleanOrigin(v) {
    if (typeof v !== 'string' || !v) return null;
    let u; try { u = new URL(v); } catch { return null; }
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
    return u.origin;
}

export function siteUrl(env) {
    return cleanOrigin(env && env.SITE_URL) || PRODUCTION_SITE;
}

export function siteHost(env) {
    return new URL(siteUrl(env)).hostname;
}

export function isStaging(env) {
    return !PRODUCTION_HOSTS.includes(siteHost(env));
}

// Origins whose cookie-authenticated POSTs and WebSockets count (dev-mode localhost is added by the callers).
export function allowedOrigins(env) {
    return isStaging(env) ? [siteUrl(env)] : PRODUCTION_ORIGINS;
}

// A Stripe TEST key is usable: in local dev mode, or on staging with BILLING_TEST_MODE=1 and only
// for a request to staging's own host. `host` is the request's hostname (null: refuse).
export function testKeyAllowed(env, host) {
    if (env.ACCOUNTS_DEV_MODE === '1') return true;
    if (env.BILLING_TEST_MODE !== '1' || !isStaging(env)) return false;
    return typeof host === 'string' && !PRODUCTION_HOSTS.includes(host) && host === siteHost(env);
}

// Every response from a staging Worker stays out of search engines, whatever host it came in on.
export function noindexEverywhere(env, host) {
    return isStaging(env) || host === 'preview.pastecal.com';
}

export const ROBOTS_DISALLOW_ALL = 'User-agent: *\nDisallow: /\n';
