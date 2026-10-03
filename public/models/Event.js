// Event Model Class
// May be created from JSON object or SyncFusion internal calendar event
//
// Which calendar date a stored value names is decided in caldate.js (the global CalDate,
// loaded before this file; the same module the ICS feed uses). Nothing here re-implements
// that mapping.

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
        // The dates an all-day event covers, { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
        // (end exclusive), stored ALONGSIDE the legacy start/end instants. The instants
        // alone cannot name a date in every zone (see CalDate.instantDate: UTC-11 and
        // UTC+14 fall outside its window, so an event created there read back a day off
        // and could not be corrected). Clients from before this field drop it when they
        // save (this constructor copies only known fields), so a row that has it was last
        // written by a client that kept it consistent with start/end; readers still check
        // (CalDate.datesMatch) and fall back to the instants. Timed events never carry it.
        this.allDayDates = this.isAllDay ? Event.cleanDates(options.allDayDates) : null;
        // An event minted here (no id yet: quick-add in either app, paste import) was
        // dated by THIS client's clock, so its local dates are the ones meant. Without
        // this, a quick-added all-day event at UTC-11/UTC+14 read back a day off. The +1s
        // reads an inclusive end (local 23:59:59.999 of the last day) as the next date,
        // like an exclusive one.
        const minted = !(options.Id || options.id);
        if (this.isAllDay && !this.allDayDates && minted && !('StartTime' in options || 'EndTime' in options)) {
            const s = CalDate.localYmd(this.start);
            const endMs = CalDate.toMs(this.end);
            const e = isNaN(endMs) ? null : CalDate.localYmd(endMs + 1000);
            if (s) this.allDayDates = { start: s, end: e && e > s ? e : CalDate.addDays(s, 1) };
        }

        // for SyncFusion Internal Object. StartTime and EndTime are converted
        // independently: a bad StartTime must not throw away a good EndTime (Syncfusion
        // records have no `end` to fall back on). Calendar.getSyncFusionEvents() hands
        // each record the stored values it was built from (_storedStart/_storedEnd/
        // _storedDates, and _storedRule/_storedException for an all-day series); a value
        // whose meaning is unchanged is kept verbatim, so rebuilding every event in
        // setEvents() after an unrelated edit rewrites nothing.
        if ('StartTime' in options || 'EndTime' in options) {
            if (this.isAllDay) {
                Object.assign(this, Event.allDayFromShown(options));
            } else {
                this.start = Event.timedFromLocal(options.StartTime, options._storedStart);
                this.end = Event.timedFromLocal(options.EndTime, options._storedEnd);
            }

            // EXDATE and UNTIL of an all-day series name dates; they are stored as
            // floating stamps of those dates (see CalDate.floatingStamp). The series'
            // shape decides, not the record's own: an edited occurrence records its slot
            // in the parent's grid.
            const allDaySeries = '_allDaySeries' in options ? !!options._allDaySeries : this.isAllDay;
            if (allDaySeries) {
                this.recurrencerule = Event.allDayRuleFromLocal(this.recurrencerule, options._storedRule);
                this.recurrenceException = Event.allDayExceptionsFromLocal(
                    this.recurrenceException, options._storedException);
            }

            // A rule handed back with the same meaning is kept as stored: Syncfusion
            // appends ';' ("FREQ=DAILY;INTERVAL=1;"), so every series the grid touched
            // was rewritten and its history read "repeat changed" when nothing had. A
            // rule that did change is stored in one spelling (Event.normalizeRule).
            if (this.recurrencerule && '_storedRule' in options
                && Event.ruleKey(this.recurrencerule) === Event.ruleKey(options._storedRule)) {
                this.recurrencerule = options._storedRule;
            } else if (this.recurrencerule) {
                this.recurrencerule = Event.normalizeRule(this.recurrencerule);
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

    // A well-formed allDayDates value (a fresh copy), or null.
    static cleanDates(dates) {
        if (!dates || typeof dates !== 'object') return null;
        if (!CalDate.isYmd(dates.start) || !CalDate.isYmd(dates.end) || dates.end <= dates.start) return null;
        return { start: dates.start, end: dates.end };
    }

    // ---- All-day: stored <-> shown -----------------------------------------------------
    //
    // An all-day event is shown at the VIEWER's local midnight of each of its dates.
    // Writes store the dates (allDayDates) and, for clients that predate that field, the
    // legacy instants too: the WRITER's local midnight (Tokyo's Oct 2 is
    // "2026-10-01T15:00:00.000Z"). A tab opened before a deploy keeps running the old code
    // (there is no forced reload) and shows that instant as-is, so it agrees with this
    // client in the writer's zone.

    // The viewer's local midnights of an all-day event's first date and of the date after
    // its last ({ start, end } Dates), or null if it has no usable start. The dates come
    // from CalDate.allDayDates (stored dates when they match, else the instants).
    static allDayLocalRange(e) {
        const d = CalDate.allDayDates(e);
        return d && { start: CalDate.localMidnight(d.start), end: CalDate.localMidnight(d.end) };
    }

    // A single stored all-day instant -> the viewer's local midnight of the date it names
    // (no allDayDates to consult). Prefer allDayLocalRange(event) when the event is at hand.
    static allDayToLocal(value) {
        return CalDate.localMidnight(CalDate.instantDate(value));
    }

    // The dates a stored all-day event's start and end name, for deciding whether a value
    // shown back unchanged can be kept verbatim: its dates, or -- when its start is
    // unusable -- whatever each instant names on its own.
    static storedDatesOf(e) {
        return CalDate.allDayDates(e)
            || { start: CalDate.instantDate(e.start), end: CalDate.instantDate(e.end) };
    }

    // Syncfusion all-day record (StartTime/EndTime at the viewer's local midnight, end
    // exclusive) -> { start, end, allDayDates } to store. Each stored value whose date is
    // unchanged is kept verbatim (an untouched event is not rewritten); a changed one is
    // written as this client's local midnight (the legacy form), and the dates are written
    // whenever either end changed.
    static allDayFromShown(options) {
        // A stored TIMED value is an instant, not a date: never "the same date".
        const hasStored = ('_storedStart' in options || '_storedEnd' in options)
            && options._storedAllDay !== false;
        const was = hasStored ? Event.storedDatesOf({ start: options._storedStart,
            end: options._storedEnd, allDayDates: options._storedDates }) : null;
        const pick = (shown, wasDate, stored) => {
            const date = CalDate.localYmd(shown);
            if (date === null) {
                return { date, value: stored !== undefined && Event.toISOStringOrNull(stored) === null ? stored : null };
            }
            if (wasDate && wasDate === date) return { date, value: stored, kept: true };
            return { date, value: CalDate.localMidnight(date).toISOString() };
        };
        const s = pick(options.StartTime, was && was.start, options._storedStart);
        const e = pick(options.EndTime, was && was.end, options._storedEnd);
        let allDayDates = null;
        if (s.kept && e.kept) allDayDates = Event.cleanDates(options._storedDates);
        else if (s.date && e.date) {
            allDayDates = { start: s.date, end: e.date > s.date ? e.date : CalDate.addDays(s.date, 1) };
        }
        return { start: s.value, end: e.value, allDayDates };
    }

    // nativecal shows an all-day event as local midnight of its first day through local
    // 23:59:59.999 of its last day (epoch ms), and works on stored events directly, so it
    // maps them at its boundary with this pair.
    static allDayDisplayRange(e) {
        const r = Event.allDayLocalRange(e);
        if (!r) {
            const end = Event.allDayToLocal(e && e.end);
            return { start: null, end: end && end.getTime() - 1 };
        }
        return { start: r.start.getTime(), end: r.end.getTime() - 1 };
    }

    // Inverse of allDayDisplayRange, in nativecal's own storage format: epoch ms of the
    // writer's local midnight of the first date and local 23:59:59.999 of the last, plus
    // allDayDates. `stored` is the event as stored before the edit, or null; each value
    // whose date is unchanged is kept verbatim, so an untouched event is not rewritten.
    static allDayStoredRange(displayStart, displayEnd, stored) {
        const was = stored ? Event.storedDatesOf(stored) : null;
        const s = CalDate.localYmd(displayStart);
        // The shown end is inclusive (last day 23:59:59.999): the date after it is the end.
        const lastDay = CalDate.localYmd(displayEnd);
        const e = lastDay && CalDate.addDays(lastDay, 1);
        const startKept = !!(was && s === was.start);
        const endKept = !!(was && e === was.end);
        const out = {
            start: s === null ? null : startKept ? stored.start : CalDate.localMidnight(s).getTime(),
            end: e === null ? null : endKept ? stored.end : CalDate.localMidnight(e).getTime() - 1,
        };
        if (startKept && endKept) out.allDayDates = Event.cleanDates(stored.allDayDates);
        else out.allDayDates = s && e ? { start: s, end: e > s ? e : CalDate.addDays(s, 1) } : null;
        return out;
    }

    // ---- Recurrence stamps ---------------------------------------------------------------

    // Recurrence stamps (RRULE UNTIL, RecurrenceException): "20261015T070000Z" (UTC, as
    // Syncfusion writes them), floating "20261015T000000", or a DATE. Epoch ms of the
    // stamp (a floating one's wall clock read as UTC fields); NaN for anything else.
    static recurrenceStampMs(stamp) {
        const s = CalDate.parseStamp(stamp);
        return s ? s.ms : NaN;
    }

    static recurrenceStamp(date) {
        return CalDate.utcStamp(date);
    }

    // An all-day series' EXDATE and UNTIL name DATES (CalDate.stampDate). They are shown
    // to the scheduler as floating stamps of those dates, which Syncfusion reads as the
    // viewer's local midnight -- exactly where the occurrences are. Passing a stored
    // instant through hid Tokyo's deleted Oct 15 on Oct 14 in LA. Anything that is not a
    // stamp is left alone.
    static allDayStampToLocal(stamp) {
        const date = CalDate.stampDate(stamp);
        return date === null ? stamp : CalDate.floatingStamp(date);
    }

    // Inverse: a stamp the scheduler produced (the viewer's local midnight as a UTC stamp,
    // or a floating one we handed it) -> the floating stamp of that LOCAL date. Floating
    // is the form every reader takes the same date from, in every zone (old tabs too:
    // Syncfusion parses it as local wall-clock time; the feed takes its Y-M-D).
    static allDayStampFromLocal(stamp) {
        const s = CalDate.parseStamp(stamp);
        if (!s) return stamp;
        return CalDate.floatingStamp(s.utc ? CalDate.localYmd(s.ms) : CalDate.ymdFromUTC(s.ms));
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
    // names: for an all-day series, CalDate.stampDate; for a timed one, a floating or
    // DATE stamp's own Y-M-D and a UTC stamp's local date. '' if there is none.
    static ruleUntilDate(rule, allDay) {
        const until = Event.allDayRuleUntil(rule);
        const s = until && CalDate.parseStamp(until);
        if (!s) return '';
        if (allDay) return CalDate.stampDate(until) || '';
        return (s.utc ? CalDate.localYmd(s.ms) : CalDate.ymdFromUTC(s.ms)) || '';
    }

    // Inverse, for a date the user picked: an all-day series gets the floating stamp of
    // that date (see allDayStampFromLocal); a timed one a UTC stamp of this client's local
    // 23:59:59 that day, as Syncfusion writes it. The floating "T235959" written for timed
    // series before read as UTC in the feed and dropped the last occurrence west of UTC.
    static ruleUntilStamp(dateStr, allDay) {
        if (!CalDate.isYmd(dateStr)) return null;
        if (allDay) return CalDate.floatingStamp(dateStr);
        const d = CalDate.localMidnight(dateStr);
        d.setHours(23, 59, 59);
        return CalDate.utcStamp(d);
    }

    // `rule` with its UNTIL rewritten, naming the same date, for a series switched between
    // all-day and timed: an all-day UNTIL (that date's start) kept on a timed series cut
    // off its last day. A rule without UNTIL comes back unchanged.
    static ruleUntilForType(rule, allDay, wasAllDay) {
        const date = Event.ruleUntilDate(rule, wasAllDay);
        const stamp = date && Event.ruleUntilStamp(date, allDay);
        if (!stamp) return rule;
        return rule.replace(/(^|;)UNTIL=[0-9TZ]+/i, (m, sep) => `${sep}UNTIL=${stamp}`);
    }

    // The UNTIL stamp of a rule, or null.
    static allDayRuleUntil(rule) {
        const m = typeof rule === 'string' && /(?:^|;)UNTIL=(\d{8}(?:T\d{6}Z?)?)(?=;|$)/i.exec(rule);
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

    // ---- Rule spelling -----------------------------------------------------------------

    // One spelling of an RRULE: no "RRULE:" prefix, no empty parts, no trailing ';'.
    // Anything that is not a non-empty string comes back unchanged.
    static normalizeRule(rule) {
        if (typeof rule !== 'string' || !rule.trim()) return rule;
        return rule.trim().replace(/^RRULE:/i, '').split(';').map(p => p.trim()).filter(Boolean).join(';');
    }

    // A rule's meaning, for comparison: parts in a fixed order, keys upper-cased, and the
    // default INTERVAL=1 dropped. '' for no rule.
    static ruleKey(rule) {
        const r = Event.normalizeRule(rule);
        if (typeof r !== 'string' || !r) return '';
        return r.split(';').map(p => {
            const i = p.indexOf('=');
            return i < 0 ? p.toUpperCase() : `${p.slice(0, i).trim().toUpperCase()}=${p.slice(i + 1).trim().toUpperCase()}`;
        }).filter(p => p !== 'INTERVAL=1').sort().join(';');
    }

    // ---- One occurrence of a series ------------------------------------------------------

    // The exception stamp that hides the occurrence of `series` starting at
    // `occurrenceStart` (epoch ms / Date / ISO, as shown to the viewer), in the form each
    // reader expects: a timed series' occurrence instant as a UTC stamp (what Syncfusion
    // writes), an all-day series' DATE as a floating stamp (CalDate.floatingStamp; see
    // allDayStampToLocal for why).
    static exceptionStampFor(series, occurrenceStart) {
        if (!series) return null;
        if (series.isAllDay) {
            const ymd = CalDate.localYmd(occurrenceStart);
            return ymd ? CalDate.floatingStamp(ymd) : null;
        }
        return CalDate.utcStamp(occurrenceStart);
    }

    // `series` with the occurrence at `occurrenceStart` hidden (its exception list
    // gains that date; a date already there is not added twice). A new Event.
    static withoutOccurrence(series, occurrenceStart) {
        const stamp = Event.exceptionStampFor(series, occurrenceStart);
        const list = String(series.recurrenceException || '').split(',').map(x => x.trim()).filter(Boolean);
        if (stamp && !list.includes(stamp)) list.push(stamp);
        return new Event({ ...series, recurrenceException: list.length ? list.join(',') : null });
    }

    // `series` ending the day before its occurrence at `occurrenceStart` ("delete this
    // and following", and the first half of "edit this and following"): any UNTIL or
    // COUNT is replaced by an UNTIL through the previous day, in the series type's form
    // (Event.ruleUntilStamp). A new Event; null if that would leave no occurrence at all
    // (the occurrence is the series' first), which is "the whole series".
    static endSeriesBefore(series, occurrenceStart) {
        const ymd = CalDate.localYmd(occurrenceStart);
        if (!ymd || !series || !series.recurrencerule) return null;
        const firstDay = series.isAllDay ? CalDate.allDayDates(series)?.start : CalDate.localYmd(series.start);
        if (!firstDay || ymd <= firstDay) return null;
        const stamp = Event.ruleUntilStamp(CalDate.addDays(ymd, -1), !!series.isAllDay);
        const parts = Event.normalizeRule(series.recurrencerule).split(';')
            .filter(p => !/^(UNTIL|COUNT)=/i.test(p));
        parts.push(`UNTIL=${stamp}`);
        return new Event({ ...series, recurrencerule: parts.join(';') });
    }

    // ---- Quick Add -------------------------------------------------------------------------

    // The event Quick Add creates, in either UI, from the dialog's output
    // ({ subject, startDateTime, endDateTime, isAllDay, recurrenceRule }). An end it
    // could not work out is the app's one-hour default: an event with no end is dropped
    // at the write boundary and vanishes on reload.
    static fromQuickAdd(q) {
        const start = q.startDateTime;
        let end = q.endDateTime;
        if (start && !end) {
            const ms = new Date(start).getTime();
            if (!isNaN(ms)) end = new Date(ms + 3600000).toISOString();
        }
        return new Event({
            title: q.subject && String(q.subject).trim() ? String(q.subject).trim() : 'Untitled event',
            start,
            end,
            isAllDay: !!q.isAllDay,
            recurrencerule: q.recurrenceRule ? Event.normalizeRule(q.recurrenceRule) : '',
        });
    }

    // ---- Recurrence expansion (nativecal) ---------------------------------------------

    // The occurrences of a nativecal display event (epoch ms; an all-day one runs from
    // local midnight of its first day to 23:59:59.999 of its last) that start within
    // [rangeStart, rangeEnd], as display events -- expanded the way the grid (Syncfusion)
    // expands them, in the viewer's wall-clock time.
    //
    // rrule.js computes in UTC, so per its docs the wall clock goes in as UTC fields
    // ("floating") and comes back out to local time. The rule is parsed with
    // RRule.parseString and given the series' own DTSTART: rrulestr(rule).options had
    // BYWEEKDAY/BYMONTHDAY/BYHOUR/BYMINUTE/BYSECOND already filled in from a DTSTART of
    // NOW, so a weekly series showed on today's weekday at page-load time of day.
    // Deleted and moved occurrences (recurrenceException, matched by local date as
    // Syncfusion does) are left out; a moved one is drawn from its own row.
    static expandOccurrences(event, rangeStart, rangeEnd, rrule) {
        const RRule = rrule && rrule.RRule;
        if (!RRule || !event || !event.recurrencerule) return [event];
        const allDay = !!event.isAllDay;
        const startMs = CalDate.toMs(event.start);
        if (isNaN(startMs)) return [event];
        const toFloating = (ms) => {
            const d = new Date(ms);
            return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(),
                d.getHours(), d.getMinutes(), d.getSeconds()));
        };
        const fromFloating = (d) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
            d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
        // The local date a stamp names: an all-day series' through CalDate.stampDate; a
        // timed series' UTC stamp by its local date, a floating one by its own Y-M-D.
        const stampLocalDate = (x) => {
            if (allDay) return CalDate.stampDate(x);
            const s = CalDate.parseStamp(x);
            return s ? (s.utc ? CalDate.localYmd(s.ms) : CalDate.ymdFromUTC(s.ms)) : null;
        };

        let ruleText = String(event.recurrencerule).replace(/^RRULE:/i, '');
        const untilStamp = Event.allDayRuleUntil(ruleText);
        ruleText = ruleText.split(';').map(p => p.trim())
            .filter(p => p && !/^UNTIL=/i.test(p)).join(';');
        const options = { ...RRule.parseString(ruleText), dtstart: toFloating(startMs) };
        // Syncfusion ends a series on UNTIL's local DATE, whatever its time of day: a timed
        // weekly series whose UNTIL is the last occurrence's UTC instant keeps that
        // occurrence after a DST change moved it an hour later. So: through that date.
        const untilDate = untilStamp && stampLocalDate(untilStamp);
        if (untilDate) options.until = new Date(CalDate.utcOfYmd(untilDate) + CalDate.DAY - 1000);

        const excluded = new Set(String(event.recurrenceException || '').split(',')
            .map(x => x.trim()).filter(Boolean).map(stampLocalDate).filter(Boolean));

        const endMs = CalDate.toMs(event.end);
        const duration = isNaN(endMs) ? 0 : Math.max(0, endMs - startMs);
        const days = allDay ? Math.max(1, Math.round((duration + 1) / CalDate.DAY)) : 0;

        return new RRule(options)
            .between(toFloating(CalDate.toMs(rangeStart)), toFloating(CalDate.toMs(rangeEnd)), true)
            .map(fromFloating)
            .filter(d => !excluded.has(CalDate.localYmd(d)))
            .map(d => {
                const start = d.getTime();
                const end = allDay
                    ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime() - 1
                    : start + duration;
                return { ...event, start, end, id: event.id + '_' + start,
                    originalEventId: event.id, isRecurringInstance: true };
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
