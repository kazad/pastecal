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
    const topStack = (err) => {
        try {
            const s = err && err.stack;
            if (!s) return '';
            const frames = [];
            for (const line of String(s).split('\n')) {
                const m = line.match(/(?:at\s+(?:([^\s(]+)\s+\()?|([^@\s]+)@)(?:https?:\/\/[^/]+)?([^):\s]+?)(?:\?[^:\s]*)?:(\d+):(\d+)/);
                if (!m) continue;
                const fn = m[1] || m[2] || '';
                const file = (m[3] || '').split('/').pop() || 'inline';
                frames.push((fn ? fn + '@' : '') + file + ':' + m[4] + ':' + m[5]);
                if (frames.length >= 2) break;
            }
            return frames.join(' <- ');
        } catch (e) { return ''; }
    };
    window.addEventListener('error', (e) => {
        const base = e.filename ? `${String(e.filename).split('/').pop().split('?')[0]}:${e.lineno || 0}:${e.colno || 0}` : 'unknown';
        const st = topStack(e.error);
        const where = st && !st.includes(base) ? `${base} | ${st}` : (st || base);
        report('error', (e.error && e.error.message) || e.message, where);
    });
    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        report('unhandledrejection', (r && (r.message || r.code)) || String(r), topStack(r) || 'promise');
    });
})();
