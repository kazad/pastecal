/**
 * SlugService -- slug validation, normalization, and reserved words for Cloudflare.
 */
export const RESERVED_WORDS = new Set([
    'view', 'beta', 'nativecal', 'api', 'admin', 'administrator', 'www', 'app', 'apps', 'calendar', 'cal',
    'about', 'account', 'accounts', 'assets', 'auth', 'bin', 'billing', 'blog', 'bot',
    'cache', 'careers', 'cgi-bin', 'config', 'contact', 'cpanel', 'css', 'dashboard',
    'dev', 'docs', 'download', 'downloads', 'enterprise', 'explore', 'faq', 'favicon.ico', 'ftp',
    'ghost', 'guide', 'help', 'home', 'hostmaster', 'images', 'img', 'imap', 'index',
    'jobs', 'js', 'legal', 'login', 'logout', 'mail', 'manage', 'media', 'me',
    'moderator', 'mx', 'news', 'ns', 'ns1', 'ns2', 'null', 'oauth', 'password', 'pop',
    'pop3', 'postmaster', 'press', 'pricing', 'privacy', 'pro', 'profile', 'public',
    'recover', 'register', 'report', 'reset', 'robots.txt', 'root', 'settings', 'setup', 'signin',
    'signout', 'signup', 'sitemap.xml', 'smtp', 'ssl', 'static', 'status',
    'subscriptions', 'superuser', 'support', 'sys', 'sysadmin', 'system', 'team',
    'terms', 'tos', 'undefined', 'user', 'users', 'v1', 'v2', 'webhooks', 'webmail',
    'wiki', 'wp-admin', 'wp-content', 'wp-login',
]);

// Calendar names the site routes itself (pages and paths it serves, or will: /explore). A calendar
// created under one would have an address that opens something else, so POST /cal/<name> refuses
// them. Only creation: an existing calendar keeps working. The apps' checkExists lists match.
export const RESERVED_CALENDAR_NAMES = new Set([
    'beta', 'nativecal', 'view', 'dev', 'api', 'cal',
    'report', 'signin', 'pro', 'pricing', 'explore', 'privacy', 'terms', 'contact', 'account', 'templates', 'features',
]);

// Every top-level entry of public/ (a page, a folder, a file), without its extension. A short name
// (pastecal.com/<name>) must never shadow one; test/unit/names.test.js keeps this list complete.
export const STATIC_PAGE_NAMES = new Set([
    '_headers', 'about', 'app', 'components', 'contact', 'demo', 'design-ideas', 'dev', 'directives', 'help', 'img', 'index',
    'js-old-components', 'legal', 'models', 'nativecal', 'poll', 'pricing', 'pricing-next', 'privacy', 'pro', 'report', 'robots',
    'selftest', 'services', 'signin', 'site', 'style', 'tailwind', 'terms', 'tokens', 'utils', 'vendor', 'account', 'handle', 'templates', 'features', 'sitemap', 'subscribe',
]);

// Names that would read as pastecal itself, staff, or a site function on a public @ page or a short
// link (pastecal.com/@pastecal/billing "Account suspended..."). Refused for handles and short names,
// compared by skeleton (namesSkeleton): case, dashes and look-alike digits/letters folded, so
// "Past-ecaI", "pa5tecal" and "adrnin" are caught too. Anything containing "pastecal" is refused.
export const RESERVED_NAME_WORDS = [
    'official', 'staff', 'admin', 'administrator', 'support', 'help', 'helpdesk', 'billing', 'security', 'team',
    'root', 'system', 'moderator', 'mod', 'owner', 'verify', 'verified', 'safety', 'trust', 'abuse', 'legal',
    'payment', 'payments', 'invoice', 'refund', 'account', 'accounts', 'login', 'log-in', 'signin', 'sign-in',
    'signup', 'sign-up', 'logout', 'password', 'favicon', 'sitemap', 'robots', 'link-ended', 'news', 'status',
];
const LOOKS = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', i: 'l' };
export function namesSkeleton(raw) {
    return String(raw ?? '').toLowerCase().normalize('NFKC').replace(/[-_.\s]/g, '')
        .replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[0-9i]/g, (c) => LOOKS[c] || c);
}
const RESERVED_SKELETONS = new Set(RESERVED_NAME_WORDS.map(namesSkeleton));
const BRAND = namesSkeleton('pastecal');
export function looksOfficial(raw) {
    const k = namesSkeleton(raw);
    return k.includes(BRAND) || RESERVED_SKELETONS.has(k);
}

// Pro Unlimited names. A handle (pastecal.com/@handle) and a top-level short name (pastecal.com/<name>):
// 3-30 of a-z, 0-9 and "-", starting and ending with a letter or digit, never a reserved or site name.
// A name under a handle (pastecal.com/@handle/<name>): 1-40 of the same.
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const LINK_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export function nameProblem(raw, kind) {
    const s = String(raw ?? '').trim().toLowerCase();
    const re = kind === 'link' ? LINK_RE : NAME_RE;
    if (!re.test(s)) return kind === 'link' ? 'Use 1 to 40 letters, numbers or dashes.' : 'Use 3 to 30 letters, numbers or dashes.';
    if (kind !== 'link' && (RESERVED_WORDS.has(s) || RESERVED_CALENDAR_NAMES.has(s) || STATIC_PAGE_NAMES.has(s) || looksOfficial(s))) return 'That name is reserved. Try another.';
    return null;
}

export const SlugService = {
    normalizeSlug(slug) {
        return String(slug ?? '').trim().toLowerCase();
    },

    isReserved(slug) {
        return RESERVED_WORDS.has(this.normalizeSlug(slug));
    },

    validateSlug(slug) {
        const s = String(slug ?? '').trim();
        const slugRegex = /^[a-zA-Z0-9-_]{3,50}$/;
        return slugRegex.test(s) && !this.isReserved(s);
    },

    isLookupable(slug) {
        const s = String(slug ?? '').trim();
        return s.length > 0 && s.length <= 100 && !/[/.#$[\]\x00-\x1f\x7f]/.test(s);
    },

    generatePublicViewId(length = 10) {
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const out = [];
        const bytes = new Uint8Array(length * 2);
        crypto.getRandomValues(bytes);
        for (const b of bytes) {
            if (b < 252 && out.length < length) {
                out.push(alphabet[b % 36]);
            }
        }
        return out.join('');
    }
};

export default SlugService;
