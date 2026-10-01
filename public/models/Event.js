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
        // records have no `end` to fall back on). Calendar.getSyncFusionEvents() hands
        // each record the stored values it was built from (_storedStart/_storedEnd, and
        // _storedRule/_storedException for an all-day series); a value whose meaning is
        // unchanged is kept verbatim, so rebuilding every event in setEvents() after an
        // unrelated edit rewrites nothing.
        if ('StartTime' in options || 'EndTime' in options) {
            if (this.isAllDay) {
                this.start = Event.allDayFromLocal(options.StartTime, options._storedStart);
                this.end = Event.allDayFromLocal(options.EndTime, options._storedEnd);
            } else {
                this.start = Event.timedFromLocal(options.StartTime, options._storedStart);
                this.end = Event.timedFromLocal(options.EndTime, options._storedEnd);
            }

            // EXDATE and UNTIL of an all-day series were shown at the viewer's local
            // midnight (see Calendar.getSyncFusionEvents); store them as UTC midnight of
            // that date. The series' shape decides, not the record's own: an edited
            // occurrence records its slot in the parent's grid.
            const allDaySeries = '_allDaySeries' in options ? !!options._allDaySeries : this.isAllDay;
            if (allDaySeries) {
                this.recurrencerule = Event.allDayRuleFromLocal(this.recurrencerule, options._storedRule);
                this.recurrenceException = Event.allDayExceptionsFromLocal(
                    this.recurrenceException, options._storedException);
            }

            // An inverted range is almost always a typo or a drag gone wrong, and dropping
            // it at the write boundary would lose the user's event. Keep the start and give
            // it the default length instead (one day all-day, one hour timed) -- but only
            // for a range the user just set in the scheduler. Every untouched stored row
            // also passes through here (setEvents rebuilds them all after any action), and
            // repairing one of those made the merge read it as this client's edit and
            // overwrite a concurrent edit of it from someone else. For the same reason,
            // data in the stored shape (start/end) is never repaired here; quick-add
            // repairs its own output in Utils.parseHumanWrittenCalendar.
            const untouched = '_storedStart' in options && '_storedEnd' in options
                && this.start === options._storedStart && this.end === options._storedEnd;
            if (!untouched) this.end = Event.repairedEnd(this.start, this.end, this.isAllDay);
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

    // The end to store for start..end: `end` itself unless the range is inverted, in
    // which case start plus the default length (one day all-day, one hour timed).
    static repairedEnd(start, end, isAllDay) {
        const startMs = start ? new Date(start).getTime() : NaN;
        const endMs = end ? new Date(end).getTime() : NaN;
        if (!(endMs < startMs)) return end;
        const fixed = new Date(startMs);
        if (isAllDay) fixed.setUTCDate(fixed.getUTCDate() + 1);
        else fixed.setTime(startMs + 3600000);
        return fixed.toISOString();
    }

    // Syncfusion timed value -> stored ISO string, keeping `stored` verbatim when it is
    // the same instant (nativecal stores epoch numbers; an untouched one stays a number).
    // An unusable stored value the record could not carry stays as it was, too.
    static timedFromLocal(value, stored) {
        const iso = Event.toISOStringOrNull(value);
        if (stored !== undefined && Event.toISOStringOrNull(stored) === iso) return stored;
        return iso;
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
        if (iso === null) return stored !== undefined && Event.toISOStringOrNull(stored) === null ? stored : null;
        const d = new Date(iso);
        const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        const prev = Event.allDayDateUTC(stored);
        if (prev && prev.getTime() === utc.getTime()) return stored;
        return utc.toISOString();
    }

    // Recurrence stamps (RRULE UNTIL, RecurrenceException) are UTC DATE-TIMEs,
    // "20261015T070000Z", as Syncfusion writes them. NaN for anything else.
    static recurrenceStampMs(stamp) {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(String(stamp).trim());
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
    }

    static recurrenceStamp(date) {
        return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    }

    // An all-day series' EXDATE and UNTIL name DATES, but are stored as instants: UTC
    // midnight, or (legacy) the author's local midnight. Syncfusion compares them with
    // occurrences that start at the VIEWER's local midnight -- exceptions by local date,
    // UNTIL by instant -- so passing the author's instant through hid Tokyo's deleted
    // Oct 15 on Oct 14 in LA. Read them through allDayDateUTC like the series start
    // (and like ICSService.formatDate), and show them at the viewer's local midnight.
    // Anything that is not a DATE-TIME stamp is left alone.
    static allDayStampToLocal(stamp) {
        const ms = Event.recurrenceStampMs(stamp);
        return isNaN(ms) ? stamp : Event.recurrenceStamp(Event.allDayToLocal(ms));
    }

    // Inverse: a stamp at the viewer's local midnight -> UTC midnight of that local date.
    static allDayStampFromLocal(stamp) {
        const ms = Event.recurrenceStampMs(stamp);
        if (isNaN(ms)) return stamp;
        const d = new Date(ms);
        return Event.recurrenceStamp(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
    }

    static allDayExceptionsToLocal(list) {
        if (!list || typeof list !== 'string') return list;
        return list.split(',').map(s => Event.allDayStampToLocal(s.trim())).join(',');
    }

    // `stored` is the list the record was built from. Each stamp that is one we showed
    // for a stored stamp gets that stored stamp back verbatim, so an untouched list (or
    // the untouched part of one the user just added to) is not rewritten.
    static allDayExceptionsFromLocal(list, stored) {
        if (!list || typeof list !== 'string') return list;
        if (typeof stored !== 'string' || !stored) {
            return list.split(',').map(s => Event.allDayStampFromLocal(s.trim())).join(',');
        }
        if (list === Event.allDayExceptionsToLocal(stored)) return stored;
        const keep = new Map(stored.split(',').map(s => [Event.allDayStampToLocal(s.trim()), s.trim()]));
        return list.split(',').map(s => s.trim())
            .map(s => (keep.has(s) ? keep.get(s) : Event.allDayStampFromLocal(s))).join(',');
    }

    static allDayRuleUntil(rule) {
        const m = typeof rule === 'string' && /(?:^|;)UNTIL=(\d{8}T\d{6}Z?)/i.exec(rule);
        return m ? m[1] : null;
    }

    static allDayRuleToLocal(rule) {
        if (!rule || typeof rule !== 'string') return rule;
        return rule.replace(/(^|;)UNTIL=(\d{8}T\d{6}Z?)/i,
            (match, sep, value) => `${sep}UNTIL=${Event.allDayStampToLocal(value)}`);
    }

    static allDayRuleFromLocal(rule, stored) {
        if (!rule || typeof rule !== 'string') return rule;
        if (typeof stored === 'string' && stored && rule === Event.allDayRuleToLocal(stored)) return stored;
        const storedUntil = Event.allDayRuleUntil(stored);
        return rule.replace(/(^|;)UNTIL=(\d{8}T\d{6}Z?)/i, (match, sep, value) => {
            const kept = storedUntil && Event.allDayStampToLocal(storedUntil) === value;
            return `${sep}UNTIL=${kept ? storedUntil : Event.allDayStampFromLocal(value)}`;
        });
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
