/**
 * EditorKeys -- the editor key a Pro owner hands out, kept per calendar in this browser.
 *
 * An editor link is https://pastecal.com/<calendar>#k=<key>. An inline script at the very
 * top of index.html <head> (before any analytics) moves the key out of the URL and into
 * storage under `pastecal_editor_key:<calendar, lowercased>`, the same name used here. The key
 * is sent only over the calendar's WebSocket ({t:'auth', key}) and in the create-view body:
 * never in a URL, never to analytics.
 *
 * Storage can be blocked (private windows, embeds): the inline script then leaves the key in
 * window.__pcEditorKey for this page load, so the link still works until the tab closes.
 */
const EditorKeys = {
    PREFIX: 'pastecal_editor_key:',
    _name(id) { return this.PREFIX + String(id || '').toLowerCase(); },
    get(id) {
        if (!id) return null;
        try {
            const v = localStorage.getItem(this._name(id));
            if (v) return v;
        } catch (e) { /* storage blocked */ }
        const mem = (typeof window !== 'undefined') && window.__pcEditorKey;
        return mem && mem.id === String(id).toLowerCase() ? mem.key : null;
    },
    forget(id) {
        if (!id) return;
        try { localStorage.removeItem(this._name(id)); } catch (e) { /* storage blocked */ }
        if (typeof window !== 'undefined' && window.__pcEditorKey && window.__pcEditorKey.id === String(id).toLowerCase()) window.__pcEditorKey = null;
    },
};
