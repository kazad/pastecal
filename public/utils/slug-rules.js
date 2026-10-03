/*
 * slug-rules.js -- the ONE definition of what a calendar or view name may be.
 *
 * SOURCE OF TRUTH: functions/slug-rules.js. public/utils/slug-rules.js is a byte-identical
 * copy made by scripts/sync-shared.sh (deploy.sh and the hosting predeploy run it), and
 * test/unit/slug-rules.test.js fails if the copies differ.
 *
 * Why it exists: the rule lived in four places and each said something different.
 *   - the router (public/app.js, nativecal) accepted [A-Za-z0-9_-] under 40 chars, so a
 *     45-char name the database accepted reloaded as the homepage;
 *   - the claim box accepted anything, so "My Carpool 1" reached the database, was refused
 *     there with PERMISSION_DENIED, and left the page on "Loading..." forever; "a.b1"
 *     threw inside the SDK (".", "#", "$", "[", "]" are illegal in a key); "x/y" wrote
 *     calendars/x/y;
 *   - functions/index.js had its own regex and its own reserved list (for view links only);
 *   - database.rules.json accepted 1-100 chars with no reserved words, so "nativecal"
 *     (a hosting rewrite) and "view" could be claimed and could never be opened.
 * Every one of them now reads this module; the rules file cannot import JavaScript, so
 * test/unit/slug-rules.test.js asserts that the regexes written there are the ones built
 * here, and the emulator suite exercises them.
 *
 * Case: names are case-INSENSITIVE and new ones are stored lowercase. Typing "Trip-2025"
 * claims "trip-2025". Calendars created before this rule may have mixed-case keys
 * (LEGACY_KEY); they still route, resolve (lookupCalendar maps any casing to the stored
 * key) and accept edits -- the database rules only apply CLAIM to a node being created.
 *
 * Pure: no DOM, no Node APIs.
 */
(function (root, factory) {
    if (typeof module === 'object' && module && module.exports) module.exports = factory();
    else root.SlugRules = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MIN = 3;
    const MAX = 50;
    // A name that may be claimed now.
    const CLAIM = /^[a-z0-9_-]{3,50}$/;
    // A key that may already exist (the old database rule): what the router must still open.
    const LEGACY_KEY = /^[A-Za-z0-9_-]{1,100}$/;

    // Names that would collide with a route, a hosting path, a file in public/, or would
    // simply mislead ("admin", "support"). One list for calendars AND view links. Every
    // entry is slug-shaped (a word with a "." can never be claimed anyway), which keeps the
    // database rule's alternation simple. test/unit/slug-rules.test.js also asserts every
    // top-level directory in public/ is listed here.
    const RESERVED = Object.freeze([
        // routes and hosting rewrites
        'view', 'nativecal', 'api', 'ics', 'feed', 'embed', 'new', 'create', 'claim', 'share',
        'edit', 'calendars', 'history', 'poll',
        // directories served from public/
        'components', 'demo', 'directives', 'img', 'js-old-components', 'models', 'services',
        'utils',
        // the long-standing view-link list (functions/index.js, pre-2026-10)
        'admin', 'administrator', 'www', 'app', 'apps', 'calendar', 'cal',
        'about', 'account', 'accounts', 'assets', 'auth', 'bin', 'billing', 'blog', 'bot',
        'cache', 'careers', 'cgi-bin', 'config', 'contact', 'cpanel', 'css', 'dashboard',
        'dev', 'docs', 'download', 'downloads', 'enterprise', 'faq', 'ftp',
        'ghost', 'guide', 'help', 'home', 'hostmaster', 'images', 'imap', 'index',
        'jobs', 'js', 'legal', 'login', 'logout', 'mail', 'manage', 'media', 'me',
        'moderator', 'mx', 'news', 'ns', 'ns1', 'ns2', 'null', 'oauth', 'password', 'pop',
        'pop3', 'postmaster', 'press', 'pricing', 'privacy', 'pro', 'profile', 'public',
        'recover', 'register', 'reset', 'root', 'settings', 'setup', 'signin',
        'signout', 'signup', 'smtp', 'ssl', 'static', 'status',
        'subscriptions', 'superuser', 'support', 'sys', 'sysadmin', 'system', 'team',
        'terms', 'tos', 'undefined', 'user', 'users', 'v1', 'v2', 'webhooks', 'webmail',
        'wiki', 'wp-admin', 'wp-content', 'wp-login',
    ]);
    const RESERVED_SET = new Set(RESERVED);
    // The same list as one anchored alternation, for database.rules.json.
    const RESERVED_PATTERN = new RegExp('^(' + RESERVED.join('|') + ')$');

    /**
     * Turn whatever was typed into a name, as it is typed: lowercase, accents dropped,
     * spaces and punctuation to single hyphens. `final` also trims hyphens/underscores off
     * the ends (not done while typing, or "my " would eat the space before "cal").
     */
    function slugify(input, { final = false } = {}) {
        let s = String(input == null ? '' : input);
        try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old engines */ }
        s = s.toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/-{2,}/g, '-');
        if (final) s = s.replace(/^[-_]+|[-_]+$/g, '');
        else s = s.replace(/^-+/, '');
        return s.slice(0, MAX);
    }

    const MESSAGES = {
        empty: 'Pick a name for the link.',
        short: `Use at least ${MIN} characters.`,
        long: `Use at most ${MAX} characters.`,
        chars: 'Use only lowercase letters, numbers, hyphens and underscores.',
        reserved: (s) => `"${s}" is reserved by PasteCal. Try another name.`,
    };

    /**
     * Can this exact string be claimed? { ok, code, message }. Does NOT lowercase: callers
     * slugify first, so a validator that silently fixed case would let the shown name and
     * the stored name disagree.
     */
    function check(slug) {
        const s = typeof slug === 'string' ? slug : '';
        if (!s) return { ok: false, code: 'empty', message: MESSAGES.empty };
        if (!/^[a-z0-9_-]*$/.test(s)) return { ok: false, code: 'chars', message: MESSAGES.chars };
        if (s.length < MIN) return { ok: false, code: 'short', message: MESSAGES.short };
        if (s.length > MAX) return { ok: false, code: 'long', message: MESSAGES.long };
        if (RESERVED_SET.has(s)) return { ok: false, code: 'reserved', message: MESSAGES.reserved(s) };
        return { ok: true, code: 'ok', message: '' };
    }

    const isClaimable = (slug) => check(slug).ok && CLAIM.test(slug);
    const isReserved = (slug) => typeof slug === 'string' && RESERVED_SET.has(slug.toLowerCase());
    /**
     * Could this URL segment name a calendar that exists? Legacy keys included, and
     * reserved words too: the old rules let anyone create "team" or "home", and those
     * calendars must keep opening. Reserving a word only stops NEW claims of it.
     */
    const isRoutable = (segment) => typeof segment === 'string' && LEGACY_KEY.test(segment);

    return {
        MIN, MAX, CLAIM, LEGACY_KEY, RESERVED, RESERVED_PATTERN,
        slugify, check, isClaimable, isReserved, isRoutable,
    };
}));
