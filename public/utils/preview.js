/**
 * PreviewSite: preview.pastecal.com is the staging copy (its own Worker and data, Stripe in TEST mode;
 * docs/pro-launch.md "Staging"). On that host only:
 *   - a calm banner at the top says payments are in test mode and which card to use
 *     (dismissible for this browser session; never in an embed);
 *   - the app skips production Firebase entirely (no anonymous sign-in, so no author signal writes;
 *     no history fallbacks) and analytics (index.html, utils/analytics.js);
 *   - the Pro checkout shows the same test-card hint (components/Pro.js).
 * On pastecal.com and everywhere else, PreviewSite.is() is false and this file does nothing.
 * Pure decisions are unit-tested in test/unit/preview-site.test.js.
 */
const PreviewSite = {
    HOST: 'preview.pastecal.com',
    DISMISS_KEY: 'pastecal_preview_banner_dismissed',
    TEST_CARD: '4242 4242 4242 4242',
    BANNER_TEXT: 'Beta · The new pastecal design, on your real calendars. Changes you make here are real. Plus is bought on pastecal.com.',
    CHECKOUT_HINT: 'Test mode: pay with card 4242 4242 4242 4242, any future date, any CVC. No real money moves.',

    is(loc = (typeof location !== 'undefined' ? location : null)) {
        return !!loc && loc.hostname === PreviewSite.HOST;
    },

    shouldShowBanner(loc, store, embedded) {
        if (!PreviewSite.is(loc) || embedded) return false;
        try { return !store || store.getItem(PreviewSite.DISMISS_KEY) !== '1'; } catch (e) { return true; }
    },

    dismiss(store) {
        try { store && store.setItem(PreviewSite.DISMISS_KEY, '1'); } catch (e) { /* storage blocked: it comes back next page */ }
    },

    _session() { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch (e) { return null; } },
    _embedded() { try { return window.self !== window.top; } catch (e) { return true; } },

    mountBanner(doc = (typeof document !== 'undefined' ? document : null)) {
        if (!doc || !PreviewSite.shouldShowBanner(location, PreviewSite._session(), PreviewSite._embedded())) return null;
        if (doc.getElementById('pc-preview-banner')) return null;
        const style = doc.createElement('style');
        style.textContent = '.pc-preview-banner{display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 44px 8px 16px;position:relative;'
            + 'font:500 14px/1.4 Figtree,system-ui,sans-serif;color:var(--pc-text,#1f2937);background:var(--pc-surface,#fffbeb);'
            + 'border-bottom:1px solid var(--pc-line,#fde68a);text-align:center}'
            + '.pc-preview-banner b{font-weight:700}'
            + '.pc-preview-banner button{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:none;cursor:pointer;'
            + 'font-size:20px;line-height:1;padding:4px 8px;color:var(--pc-text-muted,#6b7280);border-radius:6px}'
            + '.pc-preview-banner button:hover{background:rgba(0,0,0,.06)}'
            + '[data-theme="dark"] .pc-preview-banner{background:var(--pc-surface,#1f2937);color:var(--pc-text,#f3f4f6);border-color:var(--pc-line,#374151)}';
        const bar = doc.createElement('div');
        bar.id = 'pc-preview-banner';
        bar.className = 'pc-preview-banner';
        bar.setAttribute('role', 'note');
        bar.setAttribute('data-testid', 'preview-banner');
        const text = doc.createElement('span');
        const [head, ...rest] = PreviewSite.BANNER_TEXT.split(' · ');
        const b = doc.createElement('b'); b.textContent = head;
        text.appendChild(b);
        text.appendChild(doc.createTextNode(' · ' + rest.join(' · ')));
        const close = doc.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'Hide this notice');
        close.textContent = '×';
        close.addEventListener('click', () => { PreviewSite.dismiss(PreviewSite._session()); bar.remove(); });
        bar.appendChild(text); bar.appendChild(close);
        doc.head.appendChild(style);
        doc.body.insertBefore(bar, doc.body.firstChild);
        return bar;
    },
};

if (typeof window !== 'undefined' && typeof document !== 'undefined' && PreviewSite.is()) {
    if (document.body) PreviewSite.mountBanner();
    else document.addEventListener('DOMContentLoaded', () => PreviewSite.mountBanner());
}
