/**
 * SlugService -- slug validation, normalization, and reserved words for Cloudflare.
 */
export const RESERVED_WORDS = new Set([
    'view', 'beta', 'nativecal', 'api', 'admin', 'administrator', 'www', 'app', 'apps', 'calendar', 'cal',
    'about', 'account', 'accounts', 'assets', 'auth', 'bin', 'billing', 'blog', 'bot',
    'cache', 'careers', 'cgi-bin', 'config', 'contact', 'cpanel', 'css', 'dashboard',
    'dev', 'docs', 'download', 'downloads', 'enterprise', 'faq', 'favicon.ico', 'ftp',
    'ghost', 'guide', 'help', 'home', 'hostmaster', 'images', 'img', 'imap', 'index',
    'jobs', 'js', 'legal', 'login', 'logout', 'mail', 'manage', 'media', 'me',
    'moderator', 'mx', 'news', 'ns', 'ns1', 'ns2', 'null', 'oauth', 'password', 'pop',
    'pop3', 'postmaster', 'press', 'pricing', 'privacy', 'pro', 'profile', 'public',
    'recover', 'register', 'reset', 'robots.txt', 'root', 'settings', 'setup', 'signin',
    'signout', 'signup', 'sitemap.xml', 'smtp', 'ssl', 'static', 'status',
    'subscriptions', 'superuser', 'support', 'sys', 'sysadmin', 'system', 'team',
    'terms', 'tos', 'undefined', 'user', 'users', 'v1', 'v2', 'webhooks', 'webmail',
    'wiki', 'wp-admin', 'wp-content', 'wp-login',
]);

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
