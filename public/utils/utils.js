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
});
window.Utils = Utils;

// RecentCalendars manager (localStorage-backed)
class RecentCalendars {
    constructor() {
        this.load();
    }

    load() {
        // Calendars you created live under their own key and are never evicted.
        // Calendars you merely visited stay in the capped `recentCalendars` list.
        const mine = JSON.parse(localStorage.getItem('myCalendars')) || [];
        const visited = JSON.parse(localStorage.getItem('recentCalendars')) || [];

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
        localStorage.setItem('myCalendars', JSON.stringify(mine));
        localStorage.setItem('recentCalendars', JSON.stringify(visited));
    }

    add(id, title, mine = false) {
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

// Legacy calendar helpers (localStorage-backed)
let _calstore = (typeof window !== 'undefined' && window._calstore) ? window._calstore : {};

Object.assign(Utils, {
    init() {
        _calstore = _calstore ?? JSON.parse(localStorage.getItem("_calstore")) ?? {};
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

    /**
     * Parse a date out of free text in the writer's own language, not just English.
     *
     * chrono.parse is English-only, and on other languages it does worse than find
     * nothing: it finds the WRONG thing. "Réunion demain 14h" read "14h" as "14 hours
     * from now", so at 17:30 the event was saved for 07:30 the next day -- presented
     * as success, with the right title, at a time nobody typed. "Réunion avec Paul"
     * found no date at all, which left the Create button disabled with no reason given.
     *
     * So parse with the reader's language AND English, and keep whichever understood
     * more of the sentence (the longer matched text). "demain 14h" beats "14h";
     * "tomorrow 2pm" beats "2pm". A tie goes to the reader's language. English stays in
     * the running because plenty of non-English browsers type English, and the example
     * chips in the dialog are English.
     */
    bestDateParse(entry, lang) {
        if (typeof chrono === 'undefined' || !entry) return null;
        const code = String(lang || (typeof navigator !== 'undefined' && navigator.language) || 'en')
            .toLowerCase().split('-')[0];
        // The reader's language first, then English, then the other European languages
        // chrono knows: plenty of people write French in an English-language browser
        // ("Réunion demain 14h" in an en-US browser landed at 03:12 -- the English parser
        // again reading "14h" as fourteen hours from now).
        const order = [code, 'en', 'fr', 'de', 'es', 'pt', 'nl']
            .filter((c, i, a) => a.indexOf(c) === i)
            .map(c => (c === 'en' ? chrono : chrono[c]))
            .filter(p => p && typeof p.parse === 'function');
        const opts = { forwardDate: true };
        const now = new Date();
        const parseBest = (text) => {
            let best = null;
            for (const p of order) {
                const r = p.parse(text, now, opts)[0];
                if (r && (!best || r.text.length > best.text.length)) best = r;   // ties: earlier language wins
            }
            return best;
        };

        // A number glued to the word before it is usually part of the TITLE: "Shift 2",
        // "Room 101", "Rapid 01". chrono reads it as a time -- "Shift 2 Friday at 3pm" was
        // saved as "Shift at 3pm" at 02:00. If the best date phrase starts with such a
        // number, hide that number and parse again; keep the retry when it still finds a
        // date. Month and weekday names are not title words, so "October 1" is untouched.
        const NOT_TITLE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janv|févr|fevr|mars|avr|mai|juin|juil|août|aout|sept|déc|mon|tue|wed|thu|fri|sat|sun|lun|mar|mer|jeu|ven|sam|dim|on|at|the|le|la|les|à|a|au|du|de|en|in|by|from|to|until|am|um|el)/i;
        let text = entry;
        let result = parseBest(text);
        for (let guard = 0; result && guard < 3; guard++) {
            const lead = /^(\d+)\b/.exec(result.text);
            if (!lead) break;
            const before = text.slice(0, result.index);
            const word = /([A-Za-zÀ-ÿ]+)\s+$/.exec(before);
            if (!word || NOT_TITLE.test(word[1])) break;
            const masked = text.slice(0, result.index) + lead[1].replace(/\d/g, '\u2009') + text.slice(result.index + lead[1].length);
            const retry = parseBest(masked);
            if (!retry) break;
            text = masked;
            result = retry;
        }
        return result;
    },

    parseHumanWrittenCalendar(entry, lang) {
        const result = Utils.bestDateParse(entry, lang);

        if (!result) {
            return { subject: entry, startDateTime: null, endDateTime: null };
        }

        let startDate = result.start.date();
        let endDate = result.end ? result.end.date() : null;

        const parsedText = result.text;
        // Removing a mid-sentence date phrase leaves the spaces from both sides
        // behind, so collapse runs of whitespace rather than only trimming ends.
        let remainingText = entry.replace(parsedText, '').replace(/\s+/g, ' ').trim()
            // The date phrase takes its words but leaves the little word that introduced
            // it: "Réunion le 25 septembre" became a title of "Réunion le", "lunch on
            // Friday" became "lunch on". Drop a dangling connector at the end -- only words that
            // cannot plausibly end a real title, so "Plan A" and "Vitamin D" are left alone.
            .replace(/\s+(?:le|la|les|l'|à|au|aux|du|des|pour|on|at|the|for|by|am|um)$/i, '')
            .trim();

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

// Linkify utility - converts URLs and emails in text to clickable links
const LINKIFY_LINK_STYLE = 'color:#2563eb;text-decoration:underline;';

function linkify(inputText) {
    let replacedText, replacePattern1, replacePattern2, replacePattern3;

    replacePattern1 = /(\b(https?|ftp):\/\/[^<>\s"']*[-A-Z0-9+&@#\/%=~_|])/gim;
    replacedText = inputText.replace(replacePattern1,
        `<a href="$1" target="_blank" rel="noopener noreferrer" style="${LINKIFY_LINK_STYLE}">$1</a>`);

    replacePattern2 = /(^|[^\/])(www\.[^<>\s"']+(\b|$))/gim;
    replacedText = replacedText.replace(replacePattern2,
        `$1<a href="http://$2" target="_blank" rel="noopener noreferrer" style="${LINKIFY_LINK_STYLE}">$2</a>`);

    replacePattern3 = /(([a-zA-Z0-9\-\_\.])+@[a-zA-Z\_]+?(\.[a-zA-Z]{2,6})+)/gim;
    replacedText = replacedText.replace(replacePattern3,
        `<a href="mailto:$1" style="${LINKIFY_LINK_STYLE}">$1</a>`);

    return replacedText;
}

// MutationObserver to linkify schedule descriptions
function startLinkifyObserver() {
    const linkifyObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                const descriptionEl = document.querySelector(".e-event-popup .e-description-details");
                if (descriptionEl && !descriptionEl.hasAttribute('data-processed')) {
                    descriptionEl.setAttribute('data-processed', 'true');
                    descriptionEl.innerHTML = linkify(descriptionEl.innerHTML);
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

Object.assign(Utils, { linkify });
