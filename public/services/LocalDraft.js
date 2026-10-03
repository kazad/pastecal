// LocalDraft -- this browser's copy of an UNCLAIMED /slug page, shared by both UIs.
//
// Why it exists: on pastecal.com/some-name before anyone has claimed it, the page is a
// calendar that exists nowhere. The homepage draft is kept in localStorage, but that save
// was homepage-only (saveLocalStorage: `if (isHomepageCalendar)`), and nothing else stored
// an unclaimed slug -- so events added there were drawn, looked saved, and were gone on
// reload. The page gave no hint either. Now the slug has its own draft, restored when the
// page reopens, the page warns before it is closed with unsaved events, and the header can
// say "Unsaved -- claim to keep" (hasContent decides when).
//
// Per browser, keyed by the normalized slug. Every storage call is guarded: a full or
// blocked localStorage must never break editing.

const LocalDraft = {
    PREFIX: 'pastecal_draft_',

    key(slug) {
        return LocalDraft.PREFIX + String(slug || '').toLowerCase();
    },

    /** Something worth keeping: an event, a renamed title, or notes. */
    hasContent(calendar) {
        if (!calendar) return false;
        const events = Array.isArray(calendar.events) ? calendar.events : [];
        const title = calendar.title && calendar.title !== 'New Calendar';
        const notes = calendar.options && typeof calendar.options.notes === 'string' && calendar.options.notes.trim();
        return events.length > 0 || !!title || !!notes;
    },

    /** Store the draft, or drop it once there is nothing in it. */
    save(slug, calendar) {
        if (!slug) return;
        try {
            if (!LocalDraft.hasContent(calendar)) {
                localStorage.removeItem(LocalDraft.key(slug));
                return;
            }
            localStorage.setItem(LocalDraft.key(slug), JSON.stringify({
                savedAt: Date.now(),
                title: calendar.title || '',
                notes: (calendar.options && calendar.options.notes) || '',
                events: JSON.parse(JSON.stringify(calendar.events || [])),
            }));
        } catch (e) {
            // Quota or private mode: the page still works, it just cannot keep the draft.
        }
    },

    /** The stored draft ({ savedAt, title, notes, events }), or null. Never throws. */
    load(slug) {
        if (!slug) return null;
        let raw = null;
        try { raw = localStorage.getItem(LocalDraft.key(slug)); } catch (e) { return null; }
        if (!raw) return null;
        try {
            const d = JSON.parse(raw);
            if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
            const events = Array.isArray(d.events)
                ? d.events.filter(e => e && typeof e === 'object' && !Array.isArray(e)) : [];
            return {
                savedAt: Number(d.savedAt) || 0,
                title: typeof d.title === 'string' ? d.title : '',
                notes: typeof d.notes === 'string' ? d.notes : '',
                events,
            };
        } catch (e) {
            return null;
        }
    },

    clear(slug) {
        try { localStorage.removeItem(LocalDraft.key(slug)); } catch (e) { /* nothing to do */ }
    },

    /**
     * Put a stored draft back into `calendar` (a Calendar). Returns how many events came
     * back. Called only for a slug that does not exist on the server.
     */
    restoreInto(slug, calendar) {
        const d = LocalDraft.load(slug);
        if (!d || !calendar) return 0;
        if (d.title) calendar.title = d.title;
        if (d.notes) {
            if (!calendar.options) calendar.options = {};
            calendar.options.notes = d.notes;
        }
        if (d.events.length) calendar.setEvents(d.events);
        return d.events.length;
    },

    /**
     * The slug now exists on the server (`serverEvents`): the draft is done with once the
     * server holds every event in it. One that it does not (someone else claimed the name
     * first) is left alone rather than silently discarded.
     */
    settle(slug, serverEvents) {
        const d = LocalDraft.load(slug);
        if (!d) return;
        const have = new Set((Array.isArray(serverEvents) ? serverEvents : Object.values(serverEvents || {}))
            .filter(Boolean).map(e => String(e.id)));
        if (d.events.every(e => have.has(String(e.id)))) LocalDraft.clear(slug);
    },
};

if (typeof window !== 'undefined') window.LocalDraft = LocalDraft;
if (typeof module === 'object' && module && module.exports) module.exports = LocalDraft;
