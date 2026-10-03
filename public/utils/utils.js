// Shared utilities
// Defines a single global Utils object used across services/components

// nanoid generator
const nanoid = (t = 21) => {
    let e = "";
    const r = crypto.getRandomValues(new Uint8Array(t));
    for (; t--;) {
        const n = 63 & r[t];
        e +=
            n < 36
                ? n.toString(36)
                : n < 62
                    ? (n - 26).toString(36).toUpperCase()
                    : n < 63
                        ? nanoid(1) // replace with another random character
                        : nanoid(1);
    }
    return e;
};

function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

function beforeUnmount() {
    try {
        if (this._quickAddShortcutHandler) {
            window.removeEventListener('keydown', this._quickAddShortcutHandler);
            this._quickAddShortcutHandler = null;
        }
    } catch (e) {
        console.warn('Error removing quick-add keyboard handler', e);
    }
}

function sanitizeUrl(url) {
    const sanitized = url.replaceAll("amp;", "&").replace(/&+/g, '&');
    return sanitized;
}

function randomID(size = 21) {
    const alphabet = '123456789abcdefghjklmnpqrstuvwxyz';
    let id = '';
    let i = size;
    while (i--) {
        id += alphabet[(Math.random() * alphabet.length) | 0];
    }
    return id;
}

function uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

function parseDate(str) {
    let date = null;
    if (!str) return date;
    if (str.match(/\D/)) {
        const parts = str.split(/\D/);
        date = new Date((parts[0].length == 2 ? "20" : 0) + parts[0], parts[1] - 1, parts[2]);
    } else {
        if (str.length === 6) date = new Date("20" + str.substring(0, 2), str.substring(2, 4) - 1, str.substring(4, 6));
        if (str.length === 8) date = new Date(str.substring(0, 4), str.substring(4, 6) - 1, str.substring(6, 8));
    }
    return date.toString() == 'Invalid Date' ? null : date;
}

// Expose as a single shared object
const Utils = window.Utils || {};
Object.assign(Utils, {
    nanoid,
    uuidv4,
    randomID,
    debounce,
    beforeUnmount,
    sanitizeUrl,
    parseDate,
    safeReadArray,
});
window.Utils = Utils;

// Every localStorage-backed list is read through safeReadArray.
//
// localStorage is shared, user-editable, quota-limited state written by every
// build this browser has ever run. A value of `{bad`, `"x"`, `{"a":1}` or
// `[null]` used to throw from JSON.parse / .filter / item.mine inside the app's
// created() hook, which blanked the app on EVERY load until site data was
// cleared -- a corrupt convenience list took down the whole product. The cause
// is reading untrusted storage as if it were typed, so the fix is one reader
// that types it: parse failures and non-arrays become [], each entry goes
// through `normalize` (return null to drop it), and if the cleaned list differs
// from what was stored the key is rewritten so the damage is repaired once
// rather than re-tolerated on every load. Never throws.
function safeReadArray(key, normalize = normalizeIdEntry) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { return []; }
    if (raw === null) return [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    const clean = Array.isArray(parsed)
        ? parsed.map(entry => { try { return normalize(entry); } catch (e) { return null; } })
            .filter(entry => entry !== null && entry !== undefined)
        : [];
    const cleanJson = JSON.stringify(clean);
    if (cleanJson !== raw) {
        try { localStorage.setItem(key, cleanJson); } catch (e) { /* quota/blocked: still return the clean list */ }
    }
    return clean;
}

// Default entry shape: an object with a non-empty string id.
function normalizeIdEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.id !== 'string' || !entry.id) return null;
    return entry;
}

// Recents entries. Older builds recorded "this is a read-only link" only as a
// " (View Only)" suffix on the title, so nothing could build the right URL
// (/view/<slug>) from the entry. Kind is now a field; old entries are migrated
// here, at the one place every entry is read.
const VIEW_ONLY_SUFFIX = ' (View Only)';
function normalizeRecentEntry(entry) {
    entry = normalizeIdEntry(entry);
    if (!entry) return null;
    const out = { ...entry };
    if (typeof out.title !== 'string' || !out.title) out.title = out.id;
    if (out.title.endsWith(VIEW_ONLY_SUFFIX)) {
        out.title = out.title.slice(0, -VIEW_ONLY_SUFFIX.length) || out.id;
        out.kind = 'view';
    }
    if (out.kind !== 'view') delete out.kind;
    return out;
}

// RecentCalendars manager (localStorage-backed)
class RecentCalendars {
    constructor() {
        // Ids whose visit has been counted during this page load. The calendar
        // subscriptions re-fire on every remote edit; see visit().
        this.counted = new Set();
        this.load();
    }

    load() {
        // Calendars you created live under their own key and are never evicted.
        // Calendars you merely visited stay in the capped `recentCalendars` list.
        const mine = safeReadArray('myCalendars', normalizeRecentEntry);
        const visited = safeReadArray('recentCalendars', normalizeRecentEntry);

        // Older builds stored everything in `recentCalendars`. Anything already
        // flagged `mine` there is migrated across on first load so upgrading
        // users don't lose ownership of calendars they made.
        const migrated = visited.filter(item => item.mine);

        this.items = [
            ...mine.map(item => ({ ...item, mine: true })),
            ...migrated.map(item => ({ ...item, mine: true })),
            ...visited.filter(item => !item.mine).map(item => ({ ...item, mine: false })),
        ].filter((item, i, all) => all.findIndex(o => o.id === item.id) === i);

        if (migrated.length) this.save();
    }

    save() {
        const mine = this.items.filter(item => item.mine);
        const visited = this.items.filter(item => !item.mine);
        // Recents are a convenience. A full or blocked localStorage must never
        // turn into an exception in the code path that opened or created a
        // calendar; the in-memory list stays correct for this page either way.
        try {
            localStorage.setItem('myCalendars', JSON.stringify(mine));
            localStorage.setItem('recentCalendars', JSON.stringify(visited));
        } catch (e) {
            console.warn('Could not save recent calendars', e);
        }
    }

    /**
     * Record that this page opened a calendar, from a live subscription callback.
     *
     * Both the editable and the /view/ subscriptions re-fire on every remote edit.
     * Calling add() from them counted every edit by anyone as a visit, inflating
     * visitCount and firing calendarReturned on the first real return. This is the
     * one place that decides "first time this page load": the first call per id
     * counts a visit, later calls only refresh the title.
     *
     * Returns { firstLoad, visitCount } so the caller can report return depth once.
     */
    visit(id, title, { kind } = {}) {
        const firstLoad = !this.counted.has(id);
        if (firstLoad) {
            this.add(id, title, false, kind);
        } else {
            this.touchTitle(id, title);
        }
        const item = this.items.find(entry => entry.id === id);
        return { firstLoad, visitCount: item ? item.visitCount : 0 };
    }

    add(id, title, mine = false, kind) {
        // Anything that records an id (create, rename, visit) counts as this page
        // load's visit, so a later subscription fire for it is not counted again.
        this.counted.add(id);
        const existingItem = this.items.find(item => item.id === id);
        const wasPinned = existingItem ? existingItem.pinned : false;
        // `mine` is sticky: visiting a calendar you created must never demote it
        // back to a plain visit.
        const isMine = mine || (existingItem ? !!existingItem.mine : false);
        const createdAt = existingItem?.createdAt || (isMine ? new Date().toISOString() : undefined);

        // How many times this browser has opened this calendar. Return depth is the
        // one signal that separates a calendar someone keeps using from one they
        // made once, and lastVisited alone can't express it. Entries written before
        // this existed have no count, so treat a missing value as the first visit.
        const visitCount = (existingItem?.visitCount || 1) + (existingItem ? 1 : 0);

        // Remove if exists
        this.items = this.items.filter(item => item.id !== id);

        // Add to front, preserving pinned state
        this.items.unshift({
            id: id,
            title: title || id,
            pinned: wasPinned,
            mine: isMine,
            visitCount: visitCount,
            // 'view' marks a read-only link, which lives at /view/<id>. Kept from the
            // existing entry when the caller doesn't say.
            ...((kind || existingItem?.kind) === 'view' ? { kind: 'view' } : {}),
            ...(createdAt ? { createdAt } : {}),
            lastVisited: new Date().toISOString()
        });

        // Keep only the last 10 unpinned *visited* calendars. Calendars you
        // created are exempt: browsing 10 other calendars must never push your
        // own work out of the list.
        const keep = this.items.filter(item => item.pinned || item.mine);
        const capped = this.items.filter(item => !item.pinned && !item.mine).slice(0, 10);
        this.items = [...keep, ...capped];

        this.save();
    }

    /**
     * Update a stored title in place, without counting a visit.
     *
     * The calendar subscription re-fires on every remote edit, so the title can
     * change while the tab is open. Routing that through add() would inflate
     * visitCount with other people's edits, so this touches only the title.
     */
    touchTitle(id, title) {
        const item = this.items.find(entry => entry.id === id);
        if (!item || !title || item.title === title) return;
        item.title = title;
        this.save();
    }

    /** Calendars this browser created — never evicted by the recents cap. */
    getMine() {
        return this.getAll().filter(item => item.mine);
    }

    /** Calendars merely visited, most recent first. */
    getVisited() {
        return this.getAll().filter(item => !item.mine);
    }

    remove(id) {
        this.items = this.items.filter(item => item.id !== id);
        this.save();
    }

    togglePin(id) {
        const item = this.items.find(item => item.id === id);
        if (item) {
            item.pinned = !item.pinned;
            this.save();
        }
    }

    getAll() {
        return [...this.items].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            if (!!a.mine !== !!b.mine) return a.mine ? -1 : 1;
            return new Date(b.lastVisited) - new Date(a.lastVisited);
        });
    }
}

// Every stored-JSON read goes through here. Blocked site data makes the localStorage
// accessor THROW (not return null), and an unguarded read in mounted() aborted the rest of
// it before the scheduler was built: the page sat on "Loading..." forever. Corrupt JSON
// did the same. Returns `fallback` for missing, blocked or unparseable values.
function safeReadJSON(key, fallback = null) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        const v = JSON.parse(raw);
        return (v === null || v === undefined) ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

// Colors arrive from calendar options anyone with the link can write, and are spliced into
// a <style> sheet. An unvalidated value like `red} body{display:none}` closed the rule and
// blanked every viewer's page (or pulled a tracking URL). Only plain color syntaxes pass.
const CSS_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\(\s*[-0-9.%,\s/]+\)|[a-z]{3,20})$/i;
function safeCssColor(value, fallback) {
    return (typeof value === 'string' && CSS_COLOR.test(value.trim())) ? value.trim() : fallback;
}

// Legacy calendar helpers (localStorage-backed)
let _calstore = (typeof window !== 'undefined' && window._calstore) ? window._calstore : {};

Object.assign(Utils, {
    init() {
        _calstore = _calstore ?? safeReadJSON("_calstore", {});
        _calstore.events = _calstore.events ?? [];
        Utils.sync();
        console.log(_calstore);

        if (typeof calendar !== 'undefined' && calendar.on) {
            calendar.on({
                clickSchedule: function (e) {
                    console.log("clickSchedule", e);
                },
                beforeCreateSchedule: function (e) {
                    console.log("beforeCreateSchedule", e);
                    Utils.createEvent(e);
                    Utils.render();
                },
                beforeUpdateSchedule: function (e) {
                    console.log("beforeUpdateSchedule", e);
                    e.schedule.start = e.start;
                    e.schedule.end = e.end;
                    Utils.updateEvent(e);
                    Utils.render();
                },
                beforeDeleteSchedule: function (e) {
                    console.log("beforeDeleteSchedule", e);
                    Utils.deleteEvent(e);
                    Utils.render();
                },
            });
        }
    },

    sync() {
        localStorage.setItem("_calstore", JSON.stringify(_calstore));
        if (typeof CalendarDataService !== 'undefined') {
            CalendarDataService.sync();
        }
    },

    createEvent(e) {
        const ev = {
            id: e.id ?? _calstore.events.length + 100,
            calendarId: e.calendarId ?? 1,
            title: e.title,
            category: e.category ?? "time",
            start: e.start._date.toISOString(),
            end: e.end._date.toISOString(),
        };
        _calstore.events.push(ev);
        Utils.sync();
    },

    updateEvent(e) {
        // Merge changes and reinsert
        e = { ...e.schedule, ...e.changes };
        e.id = e.id ?? e.schedule.id;
        Utils.deleteEvent(e);
        Utils.createEvent(e);
    },

    deleteEvent(e) {
        e.id = e.id ?? e.schedule.id;
        _calstore.events = _calstore.events.filter((ev) => ev.id != e.id);
        Utils.sync();
    },

    clearEvents() {
        _calstore.events = [];
        Utils.sync();
    },

    getEvents() {
        return _calstore.events;
    },

    render() {
        if (typeof calendar !== 'undefined' && typeof calendar.clear === 'function') {
            calendar.clear();
            calendar.createSchedules(Utils.getEvents());
        }
    },

    parseHumanWrittenCalendar(entry) {
        const parsedResults = chrono.parse(entry, new Date(), { forwardDate: true });

        if (parsedResults.length === 0) {
            return { subject: entry, startDateTime: null, endDateTime: null };
        }

        const result = parsedResults[0];
        let startDate = result.start.date();
        let endDate = result.end ? result.end.date() : null;

        const parsedText = result.text;
        // Removing a mid-sentence date phrase leaves the spaces from both sides
        // behind, so collapse runs of whitespace rather than only trimming ends.
        let remainingText = entry.replace(parsedText, '').replace(/\s+/g, ' ').trim();

        const { subject, duration, days } = extractDuration(remainingText);

        // chrono fills a missing time with 12:00, so "vacation dec 11 - dec 15" came out
        // as a noon-to-noon timed event. The rule for all-day:
        //
        //   1. No time-of-day signal at all. An explicit hour ("2pm", "at noon") is one,
        //      and so is a part of day: chrono 1.4.9 reports "morning", "afternoon",
        //      "evening", "night" and "tonight" as IMPLIED hours (with an implied
        //      meridiem), so checking isCertain('hour') alone turned "call tomorrow
        //      morning" and "dinner friday night" into all-day events. An hour or minute
        //      duration ("for 1 hour") is one too.
        //   2. And the input is a bare date or a span of days: nothing but the date
        //      ("tomorrow", "dec 11"), a range ("vacation dec 11 - dec 15") or "for N
        //      days". A titled single day with no time ("lunch tomorrow", "dentist oct
        //      5") stays the timed event at chrono's noon it always was.
        //
        // All-day ends (exclusively) the day after the last date.
        const timeOfDay = (c) => !!(c && typeof c.isCertain === 'function' && (c.isCertain('hour')
            || c.isCertain('meridiem')
            || (c.impliedValues && c.impliedValues.meridiem !== undefined)));
        const partOfDay = !!(result.tags && result.tags.ENCasualTimeParser);
        const hasTime = timeOfDay(result.start) || timeOfDay(result.end) || partOfDay || !!duration;
        const spansDays = !!endDate || !!days || !subject;
        const isAllDay = !hasTime && spansDays;
        if (isAllDay) {
            startDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
            if (endDate) {
                endDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1);
            }
        }

        // A range the user typed backwards ("dec 15 - dec 11", "5pm - 3pm") gets the
        // default length rather than an end before its start. Quick-add is one of the two
        // places an inverted range is repaired (Event's constructor does it for scheduler
        // edits); stored events are never repaired after the fact.
        if (endDate && endDate < startDate) endDate = null;

        if (!endDate && days) {
            // Calendar-day arithmetic: N * 24h drifts an hour across a DST change.
            endDate = new Date(startDate);
            endDate.setDate(endDate.getDate() + days);
        } else if (!endDate && duration) {
            endDate = new Date(startDate.getTime() + duration);
        } else if (!endDate && isAllDay) {
            endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1);
        } else if (!endDate) {
            const defaultDuration = 60 * 60 * 1000;
            endDate = new Date(startDate.getTime() + defaultDuration);
        }

        return {
            subject: subject || 'Untitled Event',
            startDateTime: startDate.toISOString(),
            endDateTime: endDate ? endDate.toISOString() : null,
            isAllDay
        };
    }
});

// Duration helper for parseHumanWrittenCalendar
function extractDuration(text) {
    const durationRegex = /(?:(?:for|in)\s+)?(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day)s?/i;
    const match = text.match(durationRegex);

    if (!match) {
        return { subject: text, duration: null, days: null };
    }

    const [fullMatch, amount, unit] = match;
    let durationMs;

    switch (unit.toLowerCase()) {
        case 'hour':
        case 'hr':
            durationMs = parseFloat(amount) * 60 * 60 * 1000;
            break;
        case 'minute':
        case 'min':
            durationMs = parseFloat(amount) * 60 * 1000;
            break;
        case 'day':
            // Whole days are added as calendar days by the caller (DST-safe); a
            // fractional day has no calendar meaning, so it stays elapsed time.
            if (Number.isInteger(parseFloat(amount))) {
                const subject = text.replace(fullMatch, '').replace(/\s+/g, ' ').trim();
                return { subject, duration: null, days: parseInt(amount, 10) };
            }
            durationMs = parseFloat(amount) * 24 * 60 * 60 * 1000;
            break;
        default:
            durationMs = 0;
    }

    const subject = text.replace(fullMatch, '').replace(/\s+/g, ' ').trim();

    return { subject, duration: durationMs, days: null };
}

window.RecentCalendars = RecentCalendars;

// Links in user text come from one place, utils/linkify.js (see its header for why).
const LINKIFY_LINK_STYLE = 'color:#2563eb;text-decoration:underline;';
const linkify = (text) => Linkify.toHtml(text, { linkStyle: LINKIFY_LINK_STYLE });

// MutationObserver to linkify schedule descriptions
function startLinkifyObserver() {
    const linkifyObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                const descriptionEl = document.querySelector(".e-event-popup .e-description-details");
                if (descriptionEl && !descriptionEl.hasAttribute('data-processed')) {
                    descriptionEl.setAttribute('data-processed', 'true');
                    // Its own TEXT, rebuilt as nodes -- never an innerHTML round-trip.
                    Linkify.renderInto(descriptionEl, descriptionEl.textContent, { linkStyle: LINKIFY_LINK_STYLE });
                }
            }
        });
    });

    linkifyObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

// This script runs from a <head> <script> tag with no `defer`, so document.body is null
// at execution time -- observing it immediately would silently no-op. Defer to
// DOMContentLoaded when body isn't available yet.
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    if (document.body) {
        startLinkifyObserver();
    } else {
        document.addEventListener('DOMContentLoaded', startLinkifyObserver);
    }
}

Object.assign(Utils, { linkify, safeReadJSON, safeCssColor });
