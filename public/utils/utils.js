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

    // Quick Add: one sentence -> { subject, startDateTime, endDateTime, isAllDay,
    // recurrenceRule, durationMs, reason }. Shared by both UIs (QuickAddDialog).
    //
    // Why it reads ALL of chrono's results, not the first. chrono returns one result per
    // date-ish phrase it finds, and the first one is often not the one that matters:
    // "1:1 with Alex Tue 2pm" led with "1:1" (01:01 today); "interview 10am PST tomorrow"
    // is two results, a zoned time and a date, and taking the first dropped "tomorrow".
    // So: the date comes from the first result that names a day, the time from the first
    // that names a time of day, and the two are combined (in the time's own zone when it
    // states one).
    //
    // All-day is "no time of day was given": "Mom birthday Oct 12" is the birthday, not a
    // noon-to-1pm meeting. (An earlier rule kept titled dates timed at chrono's implied
    // noon; nobody wanted those.) A meal word is a time of day: "lunch tomorrow" is noon.
    parseHumanWrittenCalendar(entry, now = new Date()) {
        const raw = String(entry || '');
        const recurrence = extractRecurrence(raw);
        // What chrono reads. Same length as `recurrence.text`, so its indexes still point
        // into the sentence the subject is cut from:
        //   - "1:1" / "2:1" are meeting names, not times (a one-digit minute is never a
        //     clock time), so their colon is swapped for a look-alike chrono ignores;
        //   - "midnight" is unknown to chrono 1.4.9 ("8pm-midnight" parsed as 8pm on the
        //     wrong day); "12am" means the same and is padded to the same length.
        // A length ("for 2h", "90m", "1h30m") is cut out first: chrono reads "1h30" as
        // 01:30 and "2h" as "2 hours ago".
        const { text: undurated, duration, days } = extractDuration(recurrence.text);
        const masked = undurated
            .replace(/\b(\d{1,2}):(\d)\b(?!\d)/g, '$1∶$2')
            .replace(/\bmidnight\b/gi, '12am    ');

        const all = (typeof chrono !== 'undefined' && chrono.parse(masked, now, { forwardDate: true })) || [];
        // "2h" and "90m" come back as "2 hours AGO": those are durations, read below.
        const results = all.filter(r => !(r.tags && (r.tags.ENTimeAgoFormatParser || r.tags.ENTimeLaterFormatParser))
            && r.start && Object.keys(r.start.knownValues || {}).length);

        const known = (c, k) => !!(c && c.knownValues && Object.prototype.hasOwnProperty.call(c.knownValues, k));
        // A time of day: an hour or meridiem stated, or a part of day -- chrono 1.4.9 gives
        // "morning"/"tonight" an IMPLIED hour and meridiem, so the hour alone misses them.
        const timeOfDay = (r, c) => !!c && (known(c, 'hour') || known(c, 'meridiem')
            || (c.impliedValues && c.impliedValues.meridiem !== undefined)
            || !!(r.tags && r.tags.ENCasualTimeParser));
        const namesDay = (c) => known(c, 'day') || known(c, 'weekday');

        const dateRes = results.find(r => namesDay(r.start));
        const timeRes = results.find(r => timeOfDay(r, r.start));

        // The subject: the sentence minus every phrase used, read from the unmasked text.
        const used = [dateRes, timeRes].filter((r, i, a) => r && a.indexOf(r) === i);
        let rest = masked;
        for (const r of used.slice().sort((a, b) => indexOf(b, masked) - indexOf(a, masked))) {
            const at = indexOf(r, masked);
            if (at < 0) continue;
            rest = rest.slice(0, at) + ' ' + rest.slice(at + r.text.length);
        }
        const subject = rest.replace(/\u2236/g, ':').replace(/\b12am {4}/g, 'midnight')
            .replace(/\s+/g, ' ').trim().replace(/\s+(?:at|on|from)$/i, '').trim();

        if (!dateRes && !timeRes && !recurrence.rule) {
            return { subject: subject || Utils.UNTITLED, startDateTime: null, endDateTime: null,
                isAllDay: false, recurrenceRule: null, durationMs: null, reason: 'no-date' };
        }

        const meal = !timeRes && MEAL_HOURS.find(([re]) => re.test(subject));
        const hasTime = !!timeRes || !!duration || !!meal;
        const isAllDay = !hasTime;

        // The day: the date phrase, else the day the time phrase landed on (today, or
        // later with forwardDate), else today (a repeat with no date starts now).
        const dayOf = (r) => { const d = r.start.date(); return [d.getFullYear(), d.getMonth(), d.getDate()]; };
        const [y, m, d] = dateRes ? dayOf(dateRes) : timeRes ? dayOf(timeRes)
            : [now.getFullYear(), now.getMonth(), now.getDate()];

        let startDate, endDate = null;
        if (timeRes) {
            const c = timeRes.start;
            const at = (field) => (known(c, field) ? c.knownValues[field] : (c.impliedValues || {})[field]) || 0;
            if (timeRes === dateRes) {
                startDate = c.date();
            } else if (known(c, 'timezoneOffset')) {
                // A stated zone ("10am PST") is honored: that wall clock in that zone.
                startDate = new Date(Date.UTC(y, m, d, at('hour'), at('minute')) - c.knownValues.timezoneOffset * 60000);
            } else {
                startDate = new Date(y, m, d, at('hour'), at('minute'));
            }
            if (timeRes.end) endDate = new Date(startDate.getTime() + (timeRes.end.date() - c.date()));
        } else if (meal || duration) {
            // A meal's hour, or for "call oct 5 for 1 hour" chrono's own noon.
            startDate = new Date(y, m, d, meal ? meal[1] : 12, 0);
        } else {
            startDate = new Date(y, m, d);
            if (dateRes && dateRes.end) {
                const e = dateRes.end.date();
                endDate = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
            }
        }

        // A range the user typed backwards ("dec 15 - dec 11", "5pm - 3pm") gets the
        // default length rather than an end before its start. Quick-add is one of the two
        // places an inverted range is repaired (Event's constructor does it for scheduler
        // edits); stored events are never repaired after the fact.
        if (endDate && endDate <= startDate) endDate = null;

        // A repeat on given weekdays starts on the first of them on or after the date.
        const rule = recurrence.rule && recurrenceRuleFor(recurrence, startDate);
        if (rule && recurrence.byDay) {
            const span = endDate ? endDate - startDate : null;
            for (let i = 0; i < 7 && !recurrence.byDay.includes(startDate.getDay()); i++) {
                startDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1,
                    startDate.getHours(), startDate.getMinutes());
            }
            if (span !== null) endDate = new Date(startDate.getTime() + span);
        }

        let durationMs = endDate ? endDate - startDate : null;
        if (!endDate && days) {
            // Calendar-day arithmetic: N * 24h drifts an hour across a DST change.
            endDate = new Date(startDate);
            endDate.setDate(endDate.getDate() + days);
            durationMs = endDate - startDate;
        } else if (!endDate && duration) {
            endDate = new Date(startDate.getTime() + duration);
            durationMs = duration;
        } else if (!endDate && isAllDay) {
            endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1);
        } else if (!endDate) {
            endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
        }

        return {
            subject: subject || Utils.UNTITLED,
            startDateTime: startDate.toISOString(),
            endDateTime: endDate.toISOString(),
            isAllDay,
            recurrenceRule: rule || null,
            // The length the sentence stated (a range, "for 2h", "for 3 days"), or null.
            // The dialog keeps it when the user has pinned a start of their own.
            durationMs: durationMs && durationMs > 0 ? durationMs : null,
        };
    },

    describeRecurrence,
});

Utils.UNTITLED = 'Untitled event';

// Hours a meal word implies, when no time is given ("lunch tomorrow" is noon).
const MEAL_HOURS = [[/\bbreakfast\b/i, 8], [/\bbrunch\b/i, 11], [/\blunch\b/i, 12], [/\bdinner\b/i, 19]];

function indexOf(result, text) {
    return typeof result.index === 'number' ? result.index : text.indexOf(result.text);
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_WORD = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?s?';

// The repeat a sentence asks for, cut out of it: { text (the sentence with the phrase
// blanked to the same length), rule: { freq, interval }, byDay: [0-6] | null }. The
// phrases are the ones people type: "daily", "every day", "every weekday", "weekly",
// "every other week", "every Monday", "every Tue and Thu", "monthly", "yearly".
function extractRecurrence(text) {
    const patterns = [
        [/\bevery\s+(?:week\s?day|work\s?day)s?\b|\bweekdays\b/i, () => ({ freq: 'WEEKLY', byDay: [1, 2, 3, 4, 5] })],
        [/\b(?:daily|every\s+day|each\s+day)\b/i, () => ({ freq: 'DAILY' })],
        [new RegExp(`\\bevery\\s+(other\\s+)?(${WEEKDAY_WORD}(?:\\s*(?:,|and|&|/|\\+)\\s*${WEEKDAY_WORD})*)\\b`, 'i'), (mm) => ({
            freq: 'WEEKLY', interval: mm[1] ? 2 : 1,
            byDay: [...mm[2].matchAll(new RegExp(WEEKDAY_WORD, 'gi'))].map(w => weekdayIndex(w[1])),
        })],
        [/\b(?:every\s+other\s+week|biweekly|every\s+2\s+weeks|fortnightly)\b/i, () => ({ freq: 'WEEKLY', interval: 2 })],
        [/\b(?:weekly|every\s+week)\b/i, () => ({ freq: 'WEEKLY' })],
        [/\b(?:monthly|every\s+month)\b/i, () => ({ freq: 'MONTHLY' })],
        [/\b(?:yearly|annually|every\s+year)\b/i, () => ({ freq: 'YEARLY' })],
    ];
    for (const [re, make] of patterns) {
        const mm = re.exec(text);
        if (!mm) continue;
        const rule = make(mm);
        const blanked = text.slice(0, mm.index) + ' '.repeat(mm[0].length) + text.slice(mm.index + mm[0].length);
        return { text: blanked, rule, byDay: rule.byDay || null };
    }
    return { text, rule: null, byDay: null };
}

function weekdayIndex(word) {
    const w = word.toLowerCase().slice(0, 2);
    return ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'].indexOf(w);
}

// RRULE text for a repeat starting at `start`, in the shape Syncfusion writes (it needs
// BYDAY on a weekly rule, and the month day on monthly/yearly ones).
function recurrenceRuleFor({ rule, byDay }, start) {
    const parts = [`FREQ=${rule.freq}`];
    if (rule.freq === 'WEEKLY') {
        const days = byDay && byDay.length ? byDay : [start.getDay()];
        parts.push(`BYDAY=${[...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(i => WEEKDAYS[i]).join(',')}`);
    }
    if (rule.freq === 'MONTHLY') parts.push(`BYMONTHDAY=${start.getDate()}`);
    if (rule.freq === 'YEARLY') parts.push(`BYMONTHDAY=${start.getDate()}`, `BYMONTH=${start.getMonth() + 1}`);
    parts.push(`INTERVAL=${rule.interval || 1}`);
    return parts.join(';');
}

// "every weekday", "every Mon, Wed", "every 2 weeks on Tue", "daily", "monthly"... for a
// rule string, or '' for none. Shown in the Quick Add dialog so a repeat is never silent.
function describeRecurrence(rule) {
    if (!rule) return '';
    const get = (k) => ((new RegExp(`(?:^|;)${k}=([^;]+)`, 'i').exec(rule) || [])[1] || '');
    const freq = get('FREQ').toUpperCase();
    const interval = parseInt(get('INTERVAL'), 10) || 1;
    const names = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
    const days = get('BYDAY').split(',').filter(Boolean).map(s => s.toUpperCase());
    const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[freq];
    if (!unit) return 'repeats';
    if (freq === 'WEEKLY' && interval === 1 && days.join() === 'MO,TU,WE,TH,FR') return 'every weekday';
    const every = interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
    if (freq === 'WEEKLY' && days.length) {
        const list = days.map(x => names[x] || x).join(', ');
        return interval === 1 ? `every ${list}` : `${every} on ${list}`;
    }
    return interval === 1 ? { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit] : every;
}

// Duration helper for parseHumanWrittenCalendar: "for 2 hours", "2h", "90m", "1h30m",
// "45 min", "for 3 days". Returns { text (the phrase blanked to the same length, so
// positions in it still line up), duration (ms), days }.
function extractDuration(text) {
    const blank = (m) => text.slice(0, m.index) + ' '.repeat(m[0].length) + text.slice(m.index + m[0].length);
    const both = /(?:\b(?:for|in)\s+)?\b(\d+)\s*(?:h|hrs?|hours?)\s*(\d+)\s*(?:m|mins?|minutes?)\b/i.exec(text);
    if (both) {
        return { text: blank(both), duration: (parseInt(both[1], 10) * 60 + parseInt(both[2], 10)) * 60000, days: null };
    }
    const match = /(?:\b(?:for|in)\s+)?\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|days?|d)\b/i.exec(text);
    if (!match) return { text, duration: null, days: null };

    const amount = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (/^h/.test(unit)) return { text: blank(match), duration: amount * 3600000, days: null };
    if (/^m/.test(unit)) return { text: blank(match), duration: amount * 60000, days: null };
    // Whole days are added as calendar days by the caller (DST-safe); a fractional day
    // has no calendar meaning, so it stays elapsed time.
    if (Number.isInteger(amount)) return { text: blank(match), duration: null, days: amount };
    return { text: blank(match), duration: amount * 86400000, days: null };
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
