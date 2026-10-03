/**
 * The one way user text becomes links, in both UIs.
 *
 * There used to be four linkifiers (the Syncfusion popup observer, the notes panel in each
 * app, nativecal's event popover), each emitting HTML strings with regex replacements. One
 * of them re-scanned its own output: its `www.` pass rewrote text INSIDE the href the URL
 * pass had just emitted, and the innerHTML round-trip turned a description like
 * `https://a.com/?q=www.zz.com/onmouseover=...` into a live event handler -- stored XSS on
 * every page that showed the event, read-only /view/ pages included.
 *
 * So: one tokenizing pass over plain text, never over markup. Tokens are either text or a
 * link with an http(s)/mailto href; rendering builds DOM nodes (renderInto) or escapes every
 * piece (toHtml). Nothing here ever parses its own output.
 */
(function (root) {
    // URLs end at whitespace, quotes and angle brackets; trailing sentence punctuation is
    // left as text ("see https://x.com." links x.com, not "x.com.").
    const TOKEN = /\b((?:https?:\/\/|www\.)[^\s<>"']+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;
    const TRAILING = /[)\].,!?;:'"]+$/;

    function tokenize(text) {
        const s = String(text ?? '');
        const out = [];
        let last = 0;
        for (const m of s.matchAll(TOKEN)) {
            let raw = m[0];
            const trail = raw.match(TRAILING);
            if (trail) raw = raw.slice(0, -trail[0].length);
            if (!raw) continue;
            if (m.index > last) out.push({ text: s.slice(last, m.index) });
            const href = raw.includes('@') && !/^(https?:\/\/|www\.)/i.test(raw) ? `mailto:${raw}`
                : /^www\./i.test(raw) ? `http://${raw}` : raw;
            out.push({ text: raw, href });
            last = m.index + raw.length;
        }
        if (last < s.length) out.push({ text: s.slice(last) });
        return out;
    }

    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ESC[c]);

    /** Escaped HTML with links (and, optionally, <br> for newlines) -- for v-html. */
    function toHtml(text, { breaks = false, linkClass = '', linkStyle = '' } = {}) {
        const cls = (linkClass ? ` class="${escapeHtml(linkClass)}"` : '')
            + (linkStyle ? ` style="${escapeHtml(linkStyle)}"` : '');
        return tokenize(text).map(t => {
            const body = escapeHtml(t.text);
            const html = t.href
                ? `<a href="${escapeHtml(t.href)}" target="_blank" rel="noopener noreferrer"${cls}>${body}</a>`
                : body;
            return breaks ? html.replace(/\r?\n/g, '<br>') : html;
        }).join('');
    }

    /** Replace an element's content with its own text, linkified, built as DOM nodes. */
    function renderInto(el, text, { linkStyle = '' } = {}) {
        const doc = el.ownerDocument;
        const frag = doc.createDocumentFragment();
        for (const t of tokenize(text)) {
            if (!t.href) { frag.appendChild(doc.createTextNode(t.text)); continue; }
            const a = doc.createElement('a');
            a.href = t.href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            if (linkStyle) a.setAttribute('style', linkStyle);
            a.textContent = t.text;
            frag.appendChild(a);
        }
        el.replaceChildren(frag);
    }

    const Linkify = { tokenize, toHtml, renderInto, escapeHtml };
    if (typeof module !== 'undefined' && module.exports) module.exports = Linkify;
    else root.Linkify = Linkify;
})(typeof window !== 'undefined' ? window : globalThis);
