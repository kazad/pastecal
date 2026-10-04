// Event Model Class
// May be created from JSON object or SyncFusion internal calendar event

class Event {
    constructor(options) {
        this.id = options.Id || options.id || Utils.uuidv4();
        this.title = options.Subject || options.text || options.title || "";
        this.description = options.Description || options.description || "";
        this.repeat = options.Recurrence || options.repeat || "";
        this.recurrencerule = options.RecurrenceRule || options.recurrencerule || "";
        // A Date object is stored as its ISO string (Firebase cannot hold one); a string or
        // number is kept as given. NativeCal wrote epoch-ms numbers where this app writes
        // ISO strings, and CalendarDataService now compares start/end by INSTANT, so the
        // two spellings no longer read as an edit (the last-write-wins loss the merge
        // exists to prevent) -- while an untouched stored row stays byte-identical, which
        // a tab still running older code relies on.
        this.start = options.start instanceof Date ? Event.toISOStringOrNull(options.start) : (options.start || null);
        this.end = options.end instanceof Date ? Event.toISOStringOrNull(options.end) : (options.end || null);
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
                // Calendar.getSyncFusionEvents shows a zero-length stored all-day range as
                // one day (_shownEnd); that end coming back unchanged is still untouched.
                this.end = '_shownEnd' in options
                    && Event.toISOStringOrNull(options.EndTime) === Event.toISOStringOrNull(options._shownEnd)
                    ? options._storedEnd
                    : Event.allDayFromLocal(options.EndTime, options._storedEnd);
            } else {
                this.start = Event.timedFromLocal(options.StartTime, options._storedStart);
                this.end = Event.timedFromLocal(options.EndTime, options._storedEnd);
            }

            // EXDATE and UNTIL of an all-day series were shown at the viewer's local
            // midnight (see Calendar.getSyncFusionEvents); store them as that local
            // midnight (the legacy format, see allDayDateUTC). The series' shape decides, not the record's own: an edited
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
        if (isAllDay) fixed.setDate(fixed.getDate() + 1);
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

    // All-day dates are WRITTEN as the UTC instant of the WRITER's local midnight
    // (Tokyo's Oct 2 is "2026-10-01T15:00:00.000Z"), the format every client has always
    // written. A client from before the cross-zone fix displays that instant as-is, and a
    // tab opened before a deploy keeps running that code (there is no forced reload):
    // writing UTC midnight instead showed a new client's Oct 2 on Oct 1 in an old LA tab,
    // and that tab's next save made it permanent. So writes stay legacy and only the READ
    // is new: floor((ms + 13h + 1s) / 1 day) maps any writer's local midnight to its
    // date, for writers from just east of UTC-11 through UTC+13 (NZ summer). It reads
    // UTC midnight (written by an unreleased build) correctly too, and the extra second
    // makes nativecal's inclusive end (local 23:59:59.999 of the last day) read as the
    // next date even at UTC+13, where it would otherwise land exactly one ms short.
    // This mapping must match ICSService.formatDate in functions/index.js so the grid
    // and the feed always agree.
    static allDayDateUTC(value) {
        const iso = Event.toISOStringOrNull(value);
        if (iso === null) return null;
        const DAY = 86400000;
        return new Date(Math.floor((new Date(iso).getTime() + 13 * 3600000 + 1000) / DAY) * DAY);
    }

    // The calendar date of a local Date (plus addDays), as UTC midnight ms: the same
    // scale as allDayDateUTC, for checking whether a stored value still means that date.
    static localDateUTC(d, addDays = 0) {
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + addDays);
    }

    // Stored all-day instant -> the viewer's LOCAL midnight of its calendar date.
    static allDayToLocal(value) {
        const utc = Event.allDayDateUTC(value);
        return utc && new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }

    // nativecal shows an all-day event as local midnight of its first day through local
    // 23:59:59.999 of its last day (epoch ms), and works on stored events directly, so it
    // maps them at its boundary with this pair. A Syncfusion-written end is exclusive
    // (local midnight after the last day); nativecal's inclusive end (23:59:59.999 local)
    // maps to the next date under allDayDateUTC, so it reads as exclusive too.
    static allDayDisplayRange(e) {
        const start = Event.allDayToLocal(e.start);
        let end = Event.allDayToLocal(e.end);
        if (!start) return { start: null, end: end && end.getTime() - 1 };
        if (!end || end <= start) end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        return { start: start.getTime(), end: end.getTime() - 1 };
    }

    // Inverse of allDayDisplayRange, in nativecal's own (legacy) storage format, epoch
    // ms: the writer's local midnight of the first date and local 23:59:59.999 of the
    // last (see allDayDateUTC for why writes stay legacy). `stored` is the event as
    // stored before the edit, or null; a range shown unchanged is kept verbatim, and so
    // is each value whose date is unchanged, so an untouched event is not rewritten.
    static allDayStoredRange(displayStart, displayEnd, stored) {
        if (stored) {
            const shown = Event.allDayDisplayRange(stored);
            const same = (a, b) => Event.toISOStringOrNull(a) === Event.toISOStringOrNull(b);
            if (same(shown.start, displayStart) && same(shown.end, displayEnd)) {
                return { start: stored.start, end: stored.end };
            }
        }
        const toDate = (value) => {
            const iso = Event.toISOStringOrNull(value);
            return iso === null ? null : new Date(iso);
        };
        const keep = (written, date, prev) => {
            const prevDate = Event.allDayDateUTC(prev);
            return prevDate && prevDate.getTime() === date ? prev : written;
        };
        const s = toDate(displayStart);
        const e = toDate(displayEnd);
        return {
            start: s === null ? null : keep(
                new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime(),
                Event.localDateUTC(s), stored && stored.start),
            end: e === null ? null : keep(
                new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1).getTime() - 1,
                Event.localDateUTC(e, 1), stored && stored.end),
        };
    }

    // Syncfusion all-day record (viewer's local midnight) -> the writer's local midnight
    // of that Y-M-D as an ISO instant (the legacy format; see allDayDateUTC). `stored` is
    // the value the record was built from: when it maps to the same date it is kept
    // verbatim, so an untouched event is not rewritten on every save (and cannot drift
    // if it sits outside the window above).
    static allDayFromLocal(value, stored) {
        const iso = Event.toISOStringOrNull(value);
        if (iso === null) return stored !== undefined && Event.toISOStringOrNull(stored) === null ? stored : null;
        const d = new Date(iso);
        const prev = Event.allDayDateUTC(stored);
        if (prev && prev.getTime() === Event.localDateUTC(d)) return stored;
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
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

    // An all-day series' EXDATE and UNTIL name DATES, but are stored as instants: the
    // writer's local midnight (or UTC midnight, from an unreleased build). Syncfusion compares them with
    // occurrences that start at the VIEWER's local midnight -- exceptions by local date,
    // UNTIL by instant -- so passing the author's instant through hid Tokyo's deleted
    // Oct 15 on Oct 14 in LA. Read them through allDayDateUTC like the series start
    // (and like ICSService.formatDate), and show them at the viewer's local midnight.
    // Anything that is not a DATE-TIME stamp is left alone.
    static allDayStampToLocal(stamp) {
        const date = Event.allDayStampDate(stamp);
        return date === null ? stamp
            : Event.recurrenceStamp(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    }

    // The date (UTC midnight) an all-day series' stamp names, or null if it is not a
    // DATE-TIME stamp. A floating stamp (no Z) is a wall-clock time, so its Y-M-D IS the
    // date: nativecal's editor writes UNTIL=20261025T235959 for "through Oct 25", and
    // pushing that through the instant window read it as Oct 26. Must match
    // ICSService.allDayStampDate in functions/index.js.
    static allDayStampDate(stamp) {
        const ms = Event.recurrenceStampMs(stamp);
        if (isNaN(ms)) return null;
        if (!/Z$/i.test(String(stamp).trim())) {
            const d = new Date(ms);
            return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        }
        return Event.allDayDateUTC(ms);
    }

    // Inverse: a stamp at the viewer's local midnight -> that local midnight of its local
    // date (the legacy format, which an old client compares by instant).
    static allDayStampFromLocal(stamp) {
        const ms = Event.recurrenceStampMs(stamp);
        if (isNaN(ms)) return stamp;
        // A floating stamp's Y-M-D is already the local date (see allDayStampDate).
        const floating = !/Z$/i.test(String(stamp).trim());
        const d = new Date(ms);
        return Event.recurrenceStamp(floating
            ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
            : new Date(d.getFullYear(), d.getMonth(), d.getDate()));
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

    // nativecal's editor edits UNTIL as a "YYYY-MM-DD" date input. The date an UNTIL
    // names: a floating or date-only stamp's own Y-M-D; a UTC stamp through the all-day
    // mapping (allDayStampDate) for an all-day series, or its local date for a timed
    // one. Reading the instant's local date showed the grid's Oct 25 (stored as UTC
    // midnight) as Oct 24 in LA, and saving wrote Oct 24 back. '' if there is none.
    static ruleUntilDate(rule, allDay) {
        const m = typeof rule === 'string' && /(?:^|;)UNTIL=(\d{8})(T\d{6}(Z?))?/i.exec(rule);
        if (!m) return '';
        const ymd = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (!m[2] || !m[3]) return ymd(m[1].slice(0, 4), m[1].slice(4, 6), m[1].slice(6, 8));
        if (allDay) {
            const date = Event.allDayStampDate(m[1] + m[2]);
            return date ? ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) : '';
        }
        const d = new Date(Event.recurrenceStampMs(m[1] + m[2]));
        return isNaN(d.getTime()) ? '' : ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }

    // Inverse, for a date the user picked: an all-day series gets the grid's format (the
    // writer's local midnight as a UTC stamp, which old clients compare by instant); a
    // timed one keeps the editor's floating end-of-day stamp.
    static ruleUntilStamp(dateStr, allDay) {
        const [y, m, d] = String(dateStr).split('-').map(Number);
        if (!y || !m || !d) return null;
        if (allDay) return Event.recurrenceStamp(new Date(y, m - 1, d));
        return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}T235959`;
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
