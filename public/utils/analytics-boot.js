// Analytics bootstrap -- the ONE place that decides whether GA loads and what it is told.
//
// Loaded synchronously in <head> by every page (index.html, nativecal/index.html) so
// the pages cannot drift. They did: nativecal had GTM but never the gtag shim, so
// every custom event it tracked was dropped on the floor.
//
// Why the location fields are overridden. On this site the URL path IS the edit
// credential -- anyone holding /<slug> can edit that calendar. gtag's default is to
// send the full URL (dl), the referrer (dr) and the page title (dt) with every hit,
// so every edit link visited was being handed to Google and kept in GA reports. GTM
// was dropped rather than patched for the same reason: its page_view tag lives in
// the container, outside this repo, and sends location.href no matter what the page
// sets. gtag.js now sends the one page_view itself, with a route TEMPLATE in place of
// the path, and a one-way key (cal_key) in place of the slug for per-calendar counts.
//
// Exposes window.AnalyticsBoot. analytics.js reads its gate and keys, so there is a
// single decision about whether anything is sent.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') {
        try {
            window.AnalyticsBoot = api.boot(window);
        } catch (err) {
            // A broken bootstrap must never break the page; it just means no analytics.
            window.AnalyticsBoot = { enabled: false, reason: 'boot_failed', ready: Promise.resolve() };
        }
    }
})(this, function () {
    const MEASUREMENT_ID = 'G-4J99GY9KE6';

    // Production only (.firebaserc: pastecal-web). Local dev, previews and preview
    // channels (pastecal-web--<channel>.web.app) used to report into the live
    // property, because the only gate was test mode.
    const PROD_HOSTS = [
        'pastecal.com',
        'www.pastecal.com',
        'pastecal-web.web.app',
        'pastecal-web.firebaseapp.com',
    ];

    const PAGE_TITLE = 'PasteCal';

    /**
     * Whether this page may send analytics at all, and if not, why. One gate for
     * every reason, so the loader and analytics.js can never disagree.
     */
    function gate(win) {
        const loc = win.location || {};
        const nav = win.navigator || {};
        if (win.__TEST__) return { enabled: false, reason: 'test' };
        if (String(loc.search || '').includes('no-analytics')) return { enabled: false, reason: 'opt_out' };
        // GPC is a legal opt-out signal in some jurisdictions; DNT is the older form of
        // the same request. Either is the visitor saying no, so nothing is loaded.
        if (nav.globalPrivacyControl === true) return { enabled: false, reason: 'gpc' };
        if (nav.doNotTrack === '1' || win.doNotTrack === '1') return { enabled: false, reason: 'dnt' };
        // __ANALYTICS_ALLOW_HOST__ lets the delivery e2e test run on localhost. It is a
        // global set by script before load, not a URL flag, so ordinary dev traffic
        // can't trip it.
        if (!PROD_HOSTS.includes(String(loc.hostname || '').toLowerCase()) && !win.__ANALYTICS_ALLOW_HOST__) {
            return { enabled: false, reason: 'host' };
        }
        return { enabled: true, reason: null };
    }

    /**
     * Which page this is, as a template, plus the calendar slug it names. The template
     * is what GA sees; the slug never leaves this function except as a hash.
     * Mirrors the routing in app.js / nativecal/app.js: /view/<id> is a read-only view,
     * /edit/<id> and /<id> are the editable calendar.
     */
    function route(pathname) {
        let path = String(pathname || '/');
        let prefix = '';
        if (path === '/nativecal' || path.startsWith('/nativecal/')) {
            prefix = '/nativecal';
            path = path.slice(prefix.length) || '/';
        }
        const parts = path.split('/').filter(Boolean);
        let template, slug = null;
        if (!parts.length) {
            template = prefix || '/';
        } else if (parts[0] === 'view') {
            template = prefix + '/view';
            slug = parts[1] || null;
        } else if (parts[0] === 'edit' && parts[1]) {
            template = prefix + '/cal';
            slug = parts[1];
        } else {
            template = prefix + '/cal';
            slug = parts[0];
        }
        return { template, slug: normalizeSlug(slug) };
    }

    // Same normalization the app and backend use for lookup, so /Team and /team are
    // one calendar here too.
    function normalizeSlug(slug) {
        if (!slug) return null;
        let s = String(slug);
        try { s = decodeURIComponent(s); } catch (err) { /* keep the raw form */ }
        s = s.trim().toLowerCase();
        return s || null;
    }

    /**
     * First 16 hex chars of SHA-256(normalized slug): enough to count calendars apart
     * (64 bits), not the credential itself. Resolves null when Web Crypto is missing
     * (insecure origin, very old browser) -- the param is omitted rather than faked.
     */
    async function calKey(slug, cryptoImpl) {
        const s = normalizeSlug(slug);
        const subtle = cryptoImpl && cryptoImpl.subtle;
        if (!s || !subtle || typeof TextEncoder === 'undefined') return null;
        try {
            const buf = await subtle.digest('SHA-256', new TextEncoder().encode(s));
            return Array.from(new Uint8Array(buf))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('')
                .slice(0, 16);
        } catch (err) {
            return null;
        }
    }

    /** The referrer's origin only: an internal referrer is a pastecal URL with a slug in it. */
    function referrerOrigin(referrer) {
        if (!referrer) return '';
        try {
            return new URL(referrer).origin + '/';
        } catch (err) {
            return '';
        }
    }

    /** The fields every hit carries in place of gtag's URL-derived defaults. */
    function pageFields(win, template) {
        const origin = (win.location && win.location.origin) || 'https://pastecal.com';
        return {
            page_location: origin + template,
            page_referrer: referrerOrigin(win.document && win.document.referrer),
            page_title: PAGE_TITLE,
        };
    }

    function boot(win) {
        const g = gate(win);
        const r = route(win.location && win.location.pathname);
        const state = {
            enabled: g.enabled,
            reason: g.reason,
            surface: r.template.startsWith('/nativecal') ? 'nativecal' : 'web',
            template: r.template,
            calKey: null,
            ready: Promise.resolve(),
            route,
        };
        if (!g.enabled) {
            if (win.console) win.console.log('[analytics] disabled:', g.reason);
            return state;
        }

        win.dataLayer = win.dataLayer || [];
        win.gtag = function () { win.dataLayer.push(arguments); };
        win.gtag('js', new Date());

        const fields = pageFields(win, r.template);
        // 'set' as well as config: it covers every hit gtag builds, including ones it
        // sends on its own (user_engagement, scroll), not only the page_view.
        win.gtag('set', fields);

        // The config call (which sends the page_view) waits for the key so the page_view
        // carries it too; analytics.js waits on `ready` for the same reason. The digest
        // takes well under a millisecond, and `ready` never rejects.
        state.ready = calKey(r.slug, win.crypto).then((key) => {
            state.calKey = key;
            const extra = key ? { cal_key: key } : {};
            if (key) win.gtag('set', extra);
            win.gtag('config', MEASUREMENT_ID, Object.assign({}, fields, extra));
        }, () => {
            win.gtag('config', MEASUREMENT_ID, fields);
        });

        const d = win.document;
        if (d && d.createElement) {
            const s = d.createElement('script');
            s.async = true;
            s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
            (d.head || d.getElementsByTagName('head')[0]).appendChild(s);
        }
        return state;
    }

    return { gate, route, calKey, normalizeSlug, referrerOrigin, pageFields, boot, PROD_HOSTS, MEASUREMENT_ID };
});
