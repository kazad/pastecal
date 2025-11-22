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
        this.items = JSON.parse(localStorage.getItem('recentCalendars')) || [];
    }

    save() {
        localStorage.setItem('recentCalendars', JSON.stringify(this.items));
    }

    add(id, title) {
        const existingItem = this.items.find(item => item.id === id);
        const wasPinned = existingItem ? existingItem.pinned : false;

        // Remove if exists
        this.items = this.items.filter(item => item.id !== id);

        // Add to front, preserving pinned state
        this.items.unshift({
            id: id,
            title: title || id,
            pinned: wasPinned,
            lastVisited: new Date().toISOString()
        });

        // Keep only last 10 unpinned items
        const pinnedItems = this.items.filter(item => item.pinned);
        const unpinnedItems = this.items.filter(item => !item.pinned).slice(0, 10);
        this.items = [...pinnedItems, ...unpinnedItems];

        this.save();
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
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
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

    parseHumanWrittenCalendar(entry) {
        const parsedResults = chrono.parse(entry, new Date(), { forwardDate: true });

        if (parsedResults.length === 0) {
            return { subject: entry, startDateTime: null, endDateTime: null };
        }

        const result = parsedResults[0];
        let startDate = result.start.date();
        let endDate = result.end ? result.end.date() : null;

        const parsedText = result.text;
        let remainingText = entry.replace(parsedText, '').trim();

        const { subject, duration } = extractDuration(remainingText);

        if (duration && !endDate) {
            endDate = new Date(startDate.getTime() + duration);
        } else if (!endDate && !duration) {
            const defaultDuration = 60 * 60 * 1000;
            endDate = new Date(startDate.getTime() + defaultDuration);
        }

        return {
            subject: subject || 'Untitled Event',
            startDateTime: startDate.toISOString(),
            endDateTime: endDate ? endDate.toISOString() : null
        };
    }
});

// Duration helper for parseHumanWrittenCalendar
function extractDuration(text) {
    const durationRegex = /(?:(?:for|in)\s+)?(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day)s?/i;
    const match = text.match(durationRegex);

    if (!match) {
        return { subject: text, duration: null };
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
            durationMs = parseFloat(amount) * 24 * 60 * 60 * 1000;
            break;
        default:
            durationMs = 0;
    }

    const subject = text.replace(fullMatch, '').replace(/\s+/g, ' ').trim();

    return { subject, duration: durationMs };
}

window.RecentCalendars = RecentCalendars;

// Linkify utility - converts URLs and emails in text to clickable links
function linkify(inputText) {
    let replacedText, replacePattern1, replacePattern2, replacePattern3;

    replacePattern1 = /(\b(https?|ftp):\/\/[^<>\s"']*[-A-Z0-9+&@#\/%=~_|])/gim;
    replacedText = inputText.replace(replacePattern1, '<a href="$1" target="_blank">$1</a>');

    replacePattern2 = /(^|[^\/])(www\.[^<>\s"']+(\b|$))/gim;
    replacedText = replacedText.replace(replacePattern2, '$1<a href="http://$2" target="_blank">$2</a>');

    replacePattern3 = /(([a-zA-Z0-9\-\_\.])+@[a-zA-Z\_]+?(\.[a-zA-Z]{2,6})+)/gim;
    replacedText = replacedText.replace(replacePattern3, '<a href="mailto:$1">$1</a>');

    return replacedText;
}

// MutationObserver to linkify schedule descriptions
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body) {
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

Object.assign(Utils, { linkify });
