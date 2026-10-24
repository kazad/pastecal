// Native renderer: report uncaught errors and rejected promises as js_error, exactly as the
// main app does (public/app.js installErrorReporting), so the native renderer's error rate can
// be compared with Syncfusion's before it becomes the default. Loaded in <head> right after
// analytics.js, so errors thrown while later scripts load are caught too. Every event from
// /beta carries renderer=native (Analytics.baseParams). Only the message and origin are sent,
// never calendar contents; the listeners do not preventDefault.
(function installErrorReporting() {
    if (typeof window === 'undefined') return;
    const seen = new Set();
    const scrub = (m) => String(m).replace(
        /\b(calendars(?:_readonly)?|history(?:_meta)?|slug_mappings|calendar_authors)([./])[^\s.\/'"]+/g, '$1$2<id>');
    const report = (kind, message, where) => {
        try {
            message = scrub(message);
            const key = kind + '|' + message + '|' + where;
            if (seen.has(key) || seen.size > 20) return;
            seen.add(key);
            if (typeof Analytics !== 'undefined' && Analytics) Analytics.jsError(kind, message, where);
        } catch (err) { /* reporting must never become the failure */ }
    };
    window.addEventListener('error', (e) => {
        const where = e.filename ? `${String(e.filename).split('/').pop().split('?')[0]}:${e.lineno || 0}` : 'unknown';
        report('error', (e.error && e.error.message) || e.message, where);
    });
    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        report('unhandledrejection', (r && (r.message || r.code)) || String(r), 'promise');
    });
})();
