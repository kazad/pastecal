/**
 * YourName -- the name a person gives in the You tab, so Activity says "Edited by Sam" instead of nothing.
 *
 * Optional, kept per browser (localStorage, like the writer id: CalendarDataService.writerId) and sent with every save
 * (CloudCalendarService _sendSave / _sendMeta, `name`). History is visible to everyone who can edit the calendar, so
 * the name is public there; the field says so. The server cleans it with the same clean() (CalendarRoom), so a name
 * typed in a console is held to the same rules.
 *
 *   clean(v)     a string of at most 40 characters, control characters removed, trimmed; '' for anything else
 *   get()        this browser's name, '' if none (or storage is blocked)
 *   set(v)       stores clean(v) (removes it when empty) and returns it
 *   initials(v)  "Sam Lee" -> "SL", "sam" -> "S", '' -> ''
 */
(function (root) {
    'use strict';

    const KEY = 'pastecal_my_name';
    const MAX = 40;

    function clean(v) {
        if (typeof v !== 'string') return '';
        // C0 and C1 controls, and the bidi overrides that could make a name read backwards.
        const s = v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
        return Array.from(s).slice(0, MAX).join('').trim();
    }

    function get() {
        try { return clean(root.localStorage ? root.localStorage.getItem(KEY) || '' : ''); } catch (e) { return ''; }
    }

    function set(v) {
        const name = clean(v);
        try {
            if (root.localStorage) { if (name) root.localStorage.setItem(KEY, name); else root.localStorage.removeItem(KEY); }
        } catch (e) { /* blocked: this page only */ }
        return name;
    }

    function initials(v) {
        const words = clean(v).split(' ').filter(Boolean);
        if (!words.length) return '';
        const first = (w) => Array.from(w)[0].toUpperCase();
        return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[words.length - 1]);
    }

    const YourName = { KEY, MAX, clean, get, set, initials };
    if (typeof module !== 'undefined' && module.exports) module.exports = YourName;
    else root.YourName = YourName;
})(typeof window !== 'undefined' ? window : globalThis);
