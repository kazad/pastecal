// Event Model Class
// May be created from JSON object or SyncFusion internal calendar event

class Event {
    constructor(options) {
        this.id = options.Id || options.id || Utils.uuidv4();
        this.title = options.Subject || options.text || options.title || "";
        this.description = options.Description || options.description || "";
        this.repeat = options.Recurrence || options.repeat || "";
        this.recurrencerule = options.RecurrenceRule || options.recurrencerule || "";
        this.start = options.start || null;
        this.end = options.end || null;
        // parseInt('abc') is NaN, and one NaN field makes Firebase reject the whole
        // calendar write, so anything non-numeric falls back to the default type.
        const type = parseInt(options.Type || options.type || 1);
        this.type = Number.isFinite(type) ? type : 1;

        this.recurrenceID = options.RecurrenceID || options.recurrenceID || null;
        this.recurrenceException = options.RecurrenceException || options.recurrenceException || null;
        this.isAllDay = options.IsAllDay || options.isAllDay || false;

        // for SyncFusion Internal Object. StartTime and EndTime are converted
        // independently: a bad StartTime must not throw away a good EndTime (Syncfusion
        // records have no `end` to fall back on).
        if ('StartTime' in options || 'EndTime' in options) {
            if (this.isAllDay) {
                this.start = Event.allDayFromLocal(options.StartTime, options._storedStart);
                this.end = Event.allDayFromLocal(options.EndTime, options._storedEnd);
            } else {
                this.start = Event.toISOStringOrNull(options.StartTime);
                this.end = Event.toISOStringOrNull(options.EndTime);
            }
        }

        // An inverted range is almost always a typo or a drag gone wrong, and dropping it
        // at the write boundary would lose the user's event. Keep the start and give it
        // the default length instead (one day all-day, one hour timed).
        const startMs = this.start ? new Date(this.start).getTime() : NaN;
        const endMs = this.end ? new Date(this.end).getTime() : NaN;
        if (endMs < startMs) {
            const end = new Date(startMs);
            if (this.isAllDay) end.setUTCDate(end.getUTCDate() + 1);
            else end.setTime(startMs + 3600000);
            this.end = end.toISOString();
        }

        // Firebase saves fail with undefined properties, ensure they are null instead
        for (let prop in this) {
            if (this[prop] === undefined) {
                this[prop] = null;
            }
        }
    }

    // Convert a Date/string/whatever into an ISO string, or null if it isn't a real date.
    // `new Date(undefined).toISOString()` THROWS rather than returning a falsy value, so
    // the old `new Date(x).toISOString() || null` could never fall back — a Syncfusion
    // event with a missing EndTime crashed here instead of degrading to null.
    static toISOStringOrNull(value) {
        if (value === null || value === undefined || value === "") return null;
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    // All-day events are stored as UTC midnight of their calendar date
    // ("2026-10-02T00:00:00.000Z"), so every viewer sees the same date whatever their
    // timezone. Legacy data is the UTC instant of the AUTHOR's local midnight (Tokyo's
    // Oct 2 is "2026-10-01T15:00:00.000Z"); floor((ms + 13h) / 1 day) maps both to the
    // right date for authors from just east of UTC-11 through UTC+13 (NZ summer). This
    // mapping must match ICSService.formatDate in functions/index.js so the grid and
    // the feed always agree.
    static allDayDateUTC(value) {
        const iso = Event.toISOStringOrNull(value);
        if (iso === null) return null;
        const DAY = 86400000;
        return new Date(Math.floor((new Date(iso).getTime() + 13 * 3600000) / DAY) * DAY);
    }

    // Stored all-day instant -> the viewer's LOCAL midnight of its calendar date.
    static allDayToLocal(value) {
        const utc = Event.allDayDateUTC(value);
        return utc && new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }

    // nativecal shows an all-day event as local midnight of its first day through local
    // 23:59:59.999 of its last day (epoch ms), and works on stored events directly, so it
    // maps them at its boundary with this pair. The stored end is exclusive, like the
    // Syncfusion and ICS conventions; nativecal's legacy inclusive end (23:59:59.999
    // local) maps to the next date under allDayDateUTC, so it reads as exclusive too.
    static allDayDisplayRange(e) {
        const start = Event.allDayToLocal(e.start);
        let end = Event.allDayToLocal(e.end);
        if (!start) return { start: null, end: end && end.getTime() - 1 };
        if (!end || end <= start) end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        return { start: start.getTime(), end: end.getTime() - 1 };
    }

    // Inverse of allDayDisplayRange: UTC midnight of the first local date and of the day
    // after the last, as epoch ms (nativecal's storage type). `stored` is the event as
    // stored before the edit, or null; a value whose date is unchanged is kept verbatim
    // so an untouched event is not rewritten.
    static allDayStoredRange(displayStart, displayEnd, stored) {
        const toUTC = (value, addDays) => {
            const iso = Event.toISOStringOrNull(value);
            if (iso === null) return null;
            const d = new Date(iso);
            return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + addDays);
        };
        const keep = (ms, prev) => {
            const prevDate = Event.allDayDateUTC(prev);
            return prevDate && prevDate.getTime() === ms ? prev : ms;
        };
        const start = toUTC(displayStart, 0);
        const end = toUTC(displayEnd, 1);
        return {
            start: start === null ? null : keep(start, stored && stored.start),
            end: end === null ? null : keep(end, stored && stored.end),
        };
    }

    // Syncfusion all-day record (viewer's local midnight) -> stored UTC midnight of
    // that local Y-M-D. `stored` is the value the record was built from: when it maps
    // to the same date it is kept verbatim, so an untouched legacy event is not
    // rewritten on every save (and cannot drift if it sits outside the window above).
    static allDayFromLocal(value, stored) {
        const iso = Event.toISOStringOrNull(value);
        if (iso === null) return null;
        const d = new Date(iso);
        const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        const prev = Event.allDayDateUTC(stored);
        if (prev && prev.getTime() === utc.getTime()) return stored;
        return utc.toISOString();
    }

    // An event is only usable once it has both endpoints. A dateless Event is a legitimate
    // intermediate state (see Calendar.defaultEvent, which builds then assigns), so the
    // constructor stays permissive and this is the gate the write path checks instead.
    //
    // Incident this guards: an event with no start/end reached Firebase, and the ICS feed
    // for that whole calendar returned 500 for every subscriber until the data was fixed.
    // Works on plain objects too, since events read back from Firebase aren't Event instances.
    static isComplete(event) {
        if (!event) return false;
        return Event.toISOStringOrNull(event.start) !== null
            && Event.toISOStringOrNull(event.end) !== null;
    }

    isComplete() {
        return Event.isComplete(this);
    }
}
