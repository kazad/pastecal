// UndoService -- one definition of "what did this action change, how is it taken back,
// and what do we tell the user", shared by both UIs (the Syncfusion app in app.js and
// nativecal).
//
// Why it exists: nativecal had none of this. Its delete removed the whole row with no
// confirm, no toast and no undo, while the main app offered "Deleted X -- Undo" and a
// targeted, collaborator-safe revert. Two UIs had two behaviors because the machinery
// lived inside one app's Vue methods. It lives here now; each app keeps only its own
// wiring (where the toast goes, which keys it has already undone).
//
// Pure apart from commit(), which writes through CalendarDataService. Reads the globals
// Event, CalDate and CalendarDataService when called, so load order is only "before use".

const UndoService = {
    UNTITLED: 'Untitled event',

    /** An event's identity: an occurrence exception shares its series' id. */
    eventKey(e) {
        return `${e.id}|${e.recurrenceID ?? ''}`;
    },

    eventName(e) {
        return e && e.title && String(e.title).trim() ? String(e.title).trim() : UndoService.UNTITLED;
    },

    // One definition of "the same event" on the client (the service's).
    sameEvent(a, b) {
        if (!a || !b) return false;
        return CalendarDataService._sameEvent(a, b);
    },

    /** What turned `before` into `after`, in the same shape the server records. */
    deltaBetween(before, after) {
        const keyOf = UndoService.eventKey;
        const plain = (e) => JSON.parse(JSON.stringify(e));
        const afterByKey = new Map(after.map(e => [keyOf(e), e]));
        const beforeKeys = new Set(before.map(keyOf));
        const delta = { removed: [], changed: [], added: [] };
        for (const e of before) {
            const now = afterByKey.get(keyOf(e));
            if (!now) delta.removed.push(plain(e));
            else if (!UndoService.sameEvent(e, now)) delta.changed.push({ from: plain(e), to: plain(now) });
        }
        for (const e of after) {
            if (!beforeKeys.has(keyOf(e))) delta.added.push(plain(e));
        }
        return delta;
    },

    isEmpty(delta) {
        return !delta || (!delta.removed.length && !delta.changed.length && !delta.added.length);
    },

    /**
     * Work out what undoing these changes would do to `events` (the calendar AS IT IS
     * NOW), without doing it. Deltas are applied in the order given (newest first).
     *
     * A targeted patch, never a snapshot restore: putting back an old snapshot also
     * wiped every later add and edit, by anyone. So each part is reversed only where
     * the calendar still shows it -- a deleted event comes back only if it is missing,
     * an edit is reverted only if the event still holds the edited version, and an
     * addition is removed only if it is still there untouched. Anything changed since
     * is left alone and reported.
     */
    planUndo(events, deltas) {
        const keyOf = UndoService.eventKey;
        const same = UndoService.sameEvent;
        const next = events.map(e => new Event(e));
        const at = (k) => next.findIndex(e => keyOf(e) === k);
        const plan = { next, restored: [], reverted: [], removed: [], skipped: [] };

        // Each reversal checks the calendar as it is now: 'done' (already as it was),
        // 'skip' (changed since) or 'apply'.
        const restoreOp = (e) => ({
            subject: e, list: plan.restored,
            check: () => (at(keyOf(e)) !== -1 ? 'done' : 'apply'),
            apply: () => next.push(new Event(e)),
        });
        const removeOp = (e) => ({
            subject: e, list: plan.removed,
            check: () => {
                const i = at(keyOf(e));
                if (i === -1) return 'done';
                return same(next[i], e) ? 'apply' : 'skip';
            },
            apply: () => next.splice(at(keyOf(e)), 1),
        });
        const revertOp = ({ from, to }) => {
            // The edit touched nothing but the series' exception dates -- what editing
            // or deleting ONE occurrence does to the master. Reverting the whole master
            // would also wipe exception dates added since (another occurrence edited),
            // so only this edit's own dates are taken back out, or put back.
            const exOnly = UndoService.isExceptionOnly(from, to);
            const target = (cur) => (exOnly
                ? new Event({ ...cur, recurrenceException: UndoService.revertExdates(cur.recurrenceException, from, to) })
                : new Event(from));
            return {
                subject: from, list: plan.reverted,
                check: () => {
                    const i = at(keyOf(from));
                    if (i === -1) return 'skip';
                    if (same(next[i], from)) return 'done';
                    if (same(next[i], to)) return 'apply';
                    if (!exOnly) return 'skip';
                    return same(next[i], target(next[i])) ? 'done' : 'apply';
                },
                apply: () => { const i = at(keyOf(from)); next[i] = target(next[i]); },
            };
        };

        for (const d of deltas) {
            // A series master and its occurrence exceptions are one unit: undoing an
            // occurrence edit both hides the exception row and un-hides the date on the
            // master. Done piecemeal, the exception could go while the master revert
            // was skipped (its exception dates changed since), and the occurrence
            // vanished; the reverse would show it twice. So all of a unit, or none.
            const all = [
                ...(d.removed || []).map(e => ({ row: e, op: restoreOp(e) })),
                ...(d.changed || []).map(p => ({ row: p.from, op: revertOp(p) })),
                ...(d.added || []).map(e => ({ row: e, op: removeOp(e) })),
            ];
            const series = new Set(all.filter(x => !x.row.recurrenceID && x.row.recurrencerule)
                .map(x => String(x.row.id)));
            const unitOf = (row) => {
                if (row.recurrenceID && series.has(String(row.recurrenceID))) return 's:' + row.recurrenceID;
                if (!row.recurrenceID && series.has(String(row.id))) return 's:' + row.id;
                return 'k:' + keyOf(row);
            };
            const units = new Map();
            for (const x of all) {
                const u = unitOf(x.row);
                if (!units.has(u)) units.set(u, []);
                units.get(u).push(x.op);
            }
            for (const ops of units.values()) {
                const states = ops.map(op => op.check());
                if (states.includes('skip')) {
                    ops.forEach((op, i) => { if (states[i] !== 'done') plan.skipped.push(op.subject); });
                    continue;
                }
                ops.forEach((op, i) => {
                    if (states[i] !== 'apply') return;
                    op.apply();
                    op.list.push(op.subject);
                });
            }
        }

        const nextKeys = new Set(next.map(keyOf));
        // What actually leaves the calendar -- the only number the write gate is told.
        plan.removingKeys = events.map(keyOf).filter(k => !nextKeys.has(k));
        plan.removing = plan.removingKeys.length;
        plan.touched = new Set([...plan.restored, ...plan.reverted, ...plan.removed].map(keyOf));
        plan.noop = plan.touched.size === 0;
        return plan;
    },

    /** The edit changed nothing on a series master but its exception dates. */
    isExceptionOnly(from, to) {
        return !from.recurrenceID && UndoService.sameEvent(
            { ...from, recurrenceException: null }, { ...to, recurrenceException: null });
    },

    exdates(v) {
        return String(v || '').split(',').map(x => x.trim()).filter(Boolean);
    },

    /**
     * A series' exception dates (comma-separated EXDATEs) as they are now, with ONE
     * edit's change (from -> to) taken back: dates it added are removed, dates it
     * removed are put back, and anything else added since is kept.
     */
    revertExdates(current, from, to) {
        const list = UndoService.exdates;
        const was = new Set(list(from.recurrenceException));
        const became = new Set(list(to.recurrenceException));
        const out = list(current).filter(x => !(became.has(x) && !was.has(x)));
        for (const x of was) if (!became.has(x) && !out.includes(x)) out.push(x);
        return out.length ? out.join(',') : null;
    },

    /**
     * Write a plan from planUndo onto `calendar`. `undoOf` names what it reverses --
     * history entry keys, or the gesture id of this session's own action -- and rides
     * on the write as `_undoOf`, so /history records that the entry is an undo.
     */
    commit(calendar, plan, undoOf = []) {
        if (plan.noop) return false;
        if (plan.removingKeys.length) CalendarDataService.declareIntent(plan.removingKeys);
        CalendarDataService.markUndo(undoOf);
        calendar.setEvents(plan.next);
        return true;
    },

    /** Say what an undo actually did -- never "Restored 12 events" when it removed one. */
    describeUndo(plan) {
        const name = UndoService.eventName;
        // A collapsed drag reverts one event several times over; it is still one event,
        // named as it ends up (the last version written for its key).
        const phrase = (all, verb) => {
            const list = [...new Map(all.map(e => [UndoService.eventKey(e), e])).values()];
            return list.length === 1
                ? `${verb} "${name(list[0])}"`
                : `${verb} ${list.length} events`;
        };
        const parts = [];
        if (plan.restored.length) parts.push(phrase(plan.restored, 'Restored'));
        if (plan.reverted.length) parts.push(phrase(plan.reverted, 'Reverted'));
        if (plan.removed.length) parts.push(phrase(plan.removed, 'Removed'));
        const skippedList = [...new Map(plan.skipped.map(e => [UndoService.eventKey(e), e])).values()];
        const skipped = skippedList.length;
        const since = skipped === 1
            ? `"${name(skippedList[0])}" was changed since, so it was left as is`
            : `${skipped} events were changed since, so they were left as is`;
        if (!parts.length) return skipped ? `Nothing undone: ${since}` : 'Nothing to undo: already as it was';
        const text = parts.map((p, i) => i ? p.charAt(0).toLowerCase() + p.slice(1) : p).join(', ');
        return skipped ? `${text}; ${since}` : text;
    },

    // ---- What an action did, in words (the toast) -----------------------------------------

    /**
     * The toast for a delete, or null if the delta deleted nothing. One thing is one
     * thing: a series and its stored occurrence exceptions share an id (keyed on
     * recurrenceID || id), and deleting ONE occurrence removes no row at all -- it adds
     * an exception date to the master -- so that reads "Deleted X on Tue, Oct 6", not
     * nothing (it used to show no toast) or "Deleted 2 events".
     */
    describeDelete(delta) {
        const name = UndoService.eventName;
        const removed = delta.removed || [];
        const series = (e) => String(e.recurrenceID || e.id);
        const things = new Set(removed.map(series));
        // Occurrences hidden by this action: exception dates a master gained.
        const hidden = (delta.changed || []).filter(p => UndoService.isExceptionOnly(p.from, p.to))
            .map(p => ({ series: p.to, dates: UndoService.exdates(p.to.recurrenceException)
                .filter(x => !UndoService.exdates(p.from.recurrenceException).includes(x)) }))
            .filter(h => h.dates.length);
        // An edited occurrence deleted: its row goes and (usually) its master gains a date.
        const onlyOccurrences = removed.every(e => e.recurrenceID)
            && (removed.length || hidden.length);
        if (onlyOccurrences) {
            for (const h of hidden) things.add(String(h.series.id));
            if (things.size === 1) {
                const subject = hidden[0] ? hidden[0].series : removed[0];
                const count = Math.max(removed.length, hidden.reduce((n, h) => n + h.dates.length, 0));
                if (count > 1) return `Deleted ${count} occurrences of "${name(subject)}"`;
                const when = hidden[0]
                    ? UndoService.stampDay(hidden[0].dates[0], hidden[0].series)
                    : UndoService.shortDay(removed[0]);
                return when ? `Deleted "${name(subject)}" on ${when}` : `Deleted one "${name(subject)}"`;
            }
        }
        if (!removed.length) return null;
        if (things.size === 1) {
            const master = removed.find(e => !e.recurrenceID) || removed[0];
            return master.recurrencerule ? `Deleted every "${name(master)}"` : `Deleted "${name(master)}"`;
        }
        return `Deleted ${things.size} events`;
    },

    /**
     * The toast for an edit, saying what changed: "Moved "Alpha" to Tue 3pm", "Renamed
     * "Alpha" to "Beta"", "Changed the time of one "Standup"". Null if nothing a person
     * would notice changed.
     */
    describeEdit(delta) {
        const name = UndoService.eventName;
        const changed = (delta.changed || []);
        const added = delta.added || [];
        // Editing one occurrence: the master gains an exception date and the occurrence
        // is added (or, re-editing it, changed) as its own row.
        const occurrence = added.find(e => e.recurrenceID)
            || (changed.find(p => p.to.recurrenceID) || {}).to;
        const masters = changed.filter(p => !p.to.recurrenceID);
        if (occurrence && masters.every(p => UndoService.isExceptionOnly(p.from, p.to))) {
            const before = (changed.find(p => p.to.recurrenceID) || {}).from
                || UndoService.seriesOf(masters, occurrence);
            const what = before ? UndoService.describeEventDiff(before, occurrence, { short: true }) : null;
            const others = new Set([...changed.map(p => String(p.to.recurrenceID || p.to.id)),
                ...added.map(e => String(e.recurrenceID || e.id))]);
            if (others.size === 1) {
                return UndoService.editSentence(name(before || occurrence), what, ' (this occurrence)');
            }
        }
        const things = new Set([...changed.map(p => String(p.to.recurrenceID || p.to.id)),
            ...added.map(e => String(e.recurrenceID || e.id))]);
        // "This and following": the old series gains an UNTIL and a new series starts.
        const split = masters.find(p => UndoService.ruleUntil(p.to.recurrencerule)
            && !UndoService.ruleUntil(p.from.recurrencerule));
        if (split && added.some(e => e.recurrencerule && !e.recurrenceID)) {
            const next = added.find(e => e.recurrencerule && !e.recurrenceID);
            // Compared with the series as it was ON that date: the new series starting
            // later is the split itself, not a move.
            const what = UndoService.describeEventDiff(UndoService.onDateOf(split.from, next), next,
                { short: true, ignoreRule: true });
            return UndoService.editSentence(name(split.from), what, ' (this and following)');
        }
        if (things.size !== 1) return things.size ? `Edited ${things.size} events` : null;
        const pair = changed[0];
        if (!pair) return null;
        return UndoService.editSentence(name(pair.from), UndoService.describeEventDiff(pair.from, pair.to, { short: true }), '');
    },

    // The series row an occurrence came from, as it was (for "what changed").
    seriesOf(masters, occurrence) {
        const m = masters.find(p => String(p.from.id) === String(occurrence.recurrenceID));
        if (!m) return null;
        // The occurrence's original slot: the exception date the master gained.
        const added = UndoService.exdates(m.to.recurrenceException)
            .filter(x => !UndoService.exdates(m.from.recurrenceException).includes(x));
        const slot = added[0] && CalDate.parseStamp(added[0]);
        if (!slot) return m.from;
        const length = CalDate.toMs(m.from.end) - CalDate.toMs(m.from.start);
        const startMs = slot.utc ? slot.ms : CalDate.toMs(CalDate.localMidnight(CalDate.ymdFromUTC(slot.ms)));
        return { ...m.from, start: new Date(startMs).toISOString(),
            end: new Date(startMs + (isNaN(length) ? 0 : length)).toISOString() };
    },

    // `e` (a series) moved to the local date `ref` starts on, keeping its time of day
    // and length: what that series' occurrence on that date looked like.
    onDateOf(e, ref) {
        const s = new Date(CalDate.toMs(e.start)), r = new Date(CalDate.toMs(ref.start));
        if (isNaN(s.getTime()) || isNaN(r.getTime())) return e;
        const length = CalDate.toMs(e.end) - s.getTime();
        const start = new Date(r.getFullYear(), r.getMonth(), r.getDate(), s.getHours(), s.getMinutes(), s.getSeconds());
        if (e.isAllDay) return { ...e, start: ref.start, end: ref.end, allDayDates: ref.allDayDates };
        return { ...e, start: start.toISOString(), end: new Date(start.getTime() + (isNaN(length) ? 0 : length)).toISOString() };
    },

    editSentence(title, what, scope) {
        if (!what) return `Edited "${title}"${scope}`;
        const [first, ...rest] = what.split(', ');
        const verb = first.startsWith('moved to ') ? `Moved "${title}"${scope} to ${first.slice(9)}`
            : first.startsWith('retimed to ') ? `Changed "${title}"${scope} to ${first.slice(11)}`
            : first.startsWith('renamed to ') ? `Renamed "${title}"${scope} to ${first.slice(11)}`
                : `Edited "${title}"${scope}: ${first}`;
        return rest.length ? `${verb}, ${rest.join(', ')}` : verb;
    },

    /**
     * What actually changed between two versions of the same event, in the words a
     * person would use -- "renamed", "moved to Thu, Sep 17" -- or null if nothing
     * meaningful differs. Firebase drops empty values, so compare normalized; a rule is
     * compared by meaning (Event.ruleKey), so Syncfusion's trailing ';' is not a change.
     */
    describeEventDiff(from, to, { short = false, ignoreRule = false } = {}) {
        const norm = (v) => (v === undefined || v === null || v === '') ? null : v;
        const parts = [];
        if (norm(from.title) !== norm(to.title)) {
            parts.push(to.title && String(to.title).trim() ? `renamed to "${to.title}"` : 'title cleared');
        }
        const ms = (v) => (norm(v) === null ? null : CalDate.toMs(v));
        if (ms(from.start) !== ms(to.start) || ms(from.end) !== ms(to.end) || !!from.isAllDay !== !!to.isAllDay) {
            // A resize is not a move: same length = moved, else the new span.
            const resized = short && !to.isAllDay && !from.isAllDay
                && ms(from.end) - ms(from.start) !== ms(to.end) - ms(to.start);
            parts.push(resized
                ? `retimed to ${UndoService.shortWhen(to)}–${UndoService.shortTime(new Date(ms(to.end)))}`
                : `moved to ${short ? UndoService.shortWhen(to) : UndoService.describeEventTime(to)}`);
        }
        if (norm(from.description) !== norm(to.description)) parts.push('notes changed');
        if (String(from.type ?? 1) !== String(to.type ?? 1)) parts.push('color changed');
        if (!!from.isAllDay !== !!to.isAllDay && !short) parts.push(to.isAllDay ? 'made all-day' : 'given a time');
        if (!ignoreRule && Event.ruleKey(from.recurrencerule) !== Event.ruleKey(to.recurrencerule)) {
            parts.push(to.recurrencerule ? 'repeat changed' : 'no longer repeats');
        }
        return parts.length ? parts.join(', ') : null;
    },

    // ---- Dates in words ---------------------------------------------------------------

    /** When an event is, for lists: "Thu, Sep 17, 3:00 PM" / "Thu, Sep 17, all day". */
    describeEventTime(e) {
        // All-day: the date the grid shows (Event.allDayLocalRange), not the local
        // reading of the author's midnight.
        const range = e.isAllDay ? Event.allDayLocalRange(e) : null;
        const d = range ? range.start : new Date(CalDate.toMs(e.start));
        if (!d || isNaN(d.getTime())) return '';
        const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        if (e.isAllDay) return `${date}, all day`;
        return `${date}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    },

    /** Terse, for a toast: "Tue 3pm", "Oct 12 9:30am", "Sat (all day)". */
    shortWhen(e, now = new Date()) {
        const range = e.isAllDay ? Event.allDayLocalRange(e) : null;
        const d = range ? range.start : new Date(CalDate.toMs(e.start));
        if (!d || isNaN(d.getTime())) return '';
        const day = UndoService.shortDate(d, now);
        if (e.isAllDay) return `${day} (all day)`;
        return `${day} ${UndoService.shortTime(d)}`;
    },

    /** The day of an event, for "Deleted X on Tue, Oct 6". */
    shortDay(e) {
        const range = e.isAllDay ? Event.allDayLocalRange(e) : null;
        const d = range ? range.start : new Date(CalDate.toMs(e.start));
        return d && !isNaN(d.getTime())
            ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    },

    /** The day an exception stamp names, read the way the grid reads it for `series`. */
    stampDay(stamp, series) {
        const s = CalDate.parseStamp(stamp);
        if (!s) return '';
        const ymd = series && series.isAllDay ? CalDate.stampDate(stamp)
            : (s.utc ? CalDate.localYmd(s.ms) : CalDate.ymdFromUTC(s.ms));
        const d = ymd && CalDate.localMidnight(ymd);
        return d ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    },

    // A weekday within the coming week, else a month and day (and the year if not this one).
    shortDate(d, now = new Date()) {
        const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate())
            - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
        if (days >= 0 && days < 7) return d.toLocaleDateString([], { weekday: 'short' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric',
            year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    },

    // "3pm", "9:30am" where the locale uses a 12-hour clock; its own form otherwise.
    shortTime(d) {
        const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const m = /^(\d{1,2}):(\d{2})\s?([AP]M)$/i.exec(t.replace(/ /g, ' '));
        if (!m) return t;
        return `${m[1]}${m[2] === '00' ? '' : ':' + m[2]}${m[3].toLowerCase()}`;
    },

    ruleUntil(rule) {
        return typeof rule === 'string' && /(?:^|;)UNTIL=/i.test(rule);
    },
};

if (typeof window !== 'undefined') window.UndoService = UndoService;
if (typeof module === 'object' && module && module.exports) module.exports = UndoService;
