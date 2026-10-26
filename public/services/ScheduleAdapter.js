/**
 * ScheduleAdapter -- the boundary between Syncfusion's Schedule and our events.
 *
 * Syncfusion is only a VIEW. Events go in as display records (toView) and come back as
 * the user's intent (toCommand), which the EventStore applies. Syncfusion never edits our
 * data itself: the app cancels its own add/change/remove in actionBegin and re-renders
 * from the store.
 *
 * Everything Syncfusion does differently from us is absorbed here, in one place:
 *   - IDS. Syncfusion decides "ids are numbers" or "strings" from the first event and
 *     looks events up with ===, so a calendar mixing old number ids and newer uuids made
 *     every event of the other kind uneditable (#32). It sees text ids only; the store
 *     matches them back to the stored row, so stored ids keep their kind.
 *   - NEW IDS. Syncfusion invents ids for what it creates (numbers once, guids now); the
 *     store assigns every new event its own uuid instead.
 *   - TEXT. Syncfusion's editor HTML-escapes what it collects ("A > B" arrived as
 *     "A &gt; B"); the text the user typed is what gets stored.
 *   - PARTIAL RECORDS. A changed record carries every field, including ones that are stale
 *     if someone else edited the event meanwhile; the store keeps only the fields that
 *     actually differ, so a stale field can never overwrite a newer one.
 */
(function (root) {
    'use strict';

    // The one list of event fields (services/EventStore.js: a page global, or required in node).
    const Store = () => (typeof EventStore !== 'undefined' && EventStore) || root.EventStore
        || (typeof require === 'function' ? require('./EventStore.js') : null);
    const warnedRules = new Set();
    const blank = (v) => v === undefined || v === null || v === '';
    const asText = (v) => blank(v) ? v : String(v);
    const toDate = (v) => { if (blank(v)) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };

    // Syncfusion escapes these five when it collects editor fields; decode exactly once.
    const unescape = (s) => typeof s !== 'string' ? s
        : s.replace(/&(lt|gt|quot|#39|amp);/g, (_, m) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[m]);

    // What each event looked like when the user started changing it (editor opened, drag
    // or resize began), keyed by Id|RecurrenceID. The user's change is the difference from
    // THIS, not from the current data -- see changesFrom.
    const opened = new Map();

    // Syncfusion 23.2.6 draws a yearly "Nth weekday of a month" rule (FREQ=YEARLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=10,
    // its own editor's "every year on Oct Last Mon") on the wrong years: it skipped Oct 2027 (issue #48), and 148
    // of 675 such rules checked against rrule.js came out wrong. The same rule written as every 12 months
    // (FREQ=MONTHLY;INTERVAL=12;BYDAY=MO;BYSETPOS=-1) it draws right in all 675. So the grid is shown that form
    // and the stored rule never changes: fromRecord turns it back. Only when BYMONTH is the start's month, where
    // the two rules mean exactly the same dates.
    const ruleParts = (rule) => String(rule || '').split(';').filter(Boolean).map((p) => p.split('='));
    const yearlyByPosToGrid = (rule, start) => {
        if (!rule || !start) return null;
        const parts = ruleParts(rule), get = (k) => (parts.find(([key]) => key.toUpperCase() === k) || [])[1];
        if (String(get('FREQ')).toUpperCase() !== 'YEARLY' || !/^-?[1-9]\d*$/.test(get('BYSETPOS') || '')
            || !/^(MO|TU|WE|TH|FR|SA|SU)$/i.test(get('BYDAY') || '') || get('BYMONTH') !== String(start.getMonth() + 1)
            || get('BYMONTHDAY') || get('BYWEEKNO') || get('BYYEARDAY')) return null;
        const interval = parseInt(get('INTERVAL') || '1', 10);
        if (!(interval >= 1)) return null;
        const out = parts.filter(([k]) => k.toUpperCase() !== 'BYMONTH' && k.toUpperCase() !== 'INTERVAL')
            .map(([k, v]) => k.toUpperCase() === 'FREQ' ? [k, 'MONTHLY'] : [k, v]);
        out.push(['INTERVAL', String(12 * interval)]);
        return out.map((p) => p.join('=')).join(';') + ';';
    };
    // The way back, also for a shown rule Syncfusion changed (e.g. "this and following" adds an UNTIL).
    const yearlyByPosFromGrid = (rule, grid) => {
        if (!grid || !rule) return rule;
        if (rule === grid.shown) return grid.rule;
        const parts = ruleParts(rule), get = (k) => (parts.find(([key]) => key.toUpperCase() === k) || [])[1];
        const interval = parseInt(get('INTERVAL') || '0', 10);
        if (String(get('FREQ')).toUpperCase() !== 'MONTHLY' || !get('BYSETPOS') || get('BYMONTH') || !(interval > 0) || interval % 12) return rule;
        const out = parts.filter(([k]) => k.toUpperCase() !== 'INTERVAL')
            .map(([k, v]) => k.toUpperCase() === 'FREQ' ? [k, 'YEARLY'] : [k, v]);
        out.push(['BYMONTH', String(grid.month)], ['INTERVAL', String(interval / 12)]);
        return out.map((p) => p.join('=')).join(';') + ';';
    };
    // How a record's field is read back into the event (fromRecord); any other field is taken as it is.
    const READ = {
        title: (v) => unescape(v || ''),
        description: (v) => unescape(v || ''),
        isAllDay: (v) => !!v,
        recurrencerule: (v) => v || '',
        recurrenceException: (v) => v || null,
        repeat: (v) => v || '',
        tz: (v) => v || null,
    };
    const recKey = (r) => `${blank(r.Id) ? '' : String(r.Id)}|${blank(r.RecurrenceID) ? '' : String(r.RecurrenceID)}`;

    // Text on an event chip: one of these two, by contrast with the event's color.
    const ON_LIGHT = '#ffffff';
    const ON_DARK = '#14171c';
    const luminance = (hex) => {
        let h = String(hex || '').trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, '$&$&');
        if (!/^[0-9a-f]{6}$/i.test(h)) return NaN;
        const [r, g, b] = [0, 2, 4].map((i) => {
            const c = parseInt(h.slice(i, i + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    // A change to a series (or one of its occurrences) that is no longer in the calendar. userMessage is what the
    // person is told; code is what analytics gets.
    const seriesDeleted = (action) => Object.assign(new Error(`${action}: the series is not in the calendar`),
        { code: 'series_deleted', userMessage: "This event's series was deleted." });

    const ScheduleAdapter = {
        /**
         * Remember an event as the user began to change it. Call from popupOpen (Editor),
         * dragStart and resizeStart. Without this, a record's untouched fields would be
         * compared with the CURRENT data -- so a description someone else changed while the
         * editor was open would look like "my change" and be overwritten.
         */
        noteStart(record) {
            if (record && !blank(record.Id)) opened.set(recKey(record), ScheduleAdapter.fromRecord(record));
        },

        /**
         * The fields the user changed: record vs the event as it was when they started (noteStart), or vs `fallback`
         * (a record of what they started from, when no snapshot could be noted). Never the whole record: a whole record
         * is a copy of every field as this tab last saw it, and stale fields in it overwrite someone else's newer ones.
         */
        changesFrom(record, fallback = null) {
            const now = ScheduleAdapter.fromRecord(record);
            const start = opened.get(recKey(record)) || (fallback ? ScheduleAdapter.fromRecord(fallback) : null);
            opened.delete(recKey(record));
            if (!start) {
                // A write path that did not note where the change began. The store still writes only what differs
                // from the stored row, but a stale field would count as a change: tests hear about it.
                if (root.__TEST__) setTimeout(() => { throw new Error(`ScheduleAdapter.changesFrom: no noteStart for ${recKey(record)}`); });
                return now;
            }
            const out = { id: now.id, recurrenceID: now.recurrenceID };
            const same = (a, b) => (a instanceof Date || b instanceof Date)
                ? new Date(a).getTime() === new Date(b).getTime()
                : (blank(a) ? null : String(a)) === (blank(b) ? null : String(b));
            for (const f of Object.keys(now)) if (f !== 'id' && f !== 'recurrenceID' && !same(now[f], start[f])) out[f] = now[f];
            return out;
        },

        /**
         * Show an event's title exactly as typed. Syncfusion's display sanitizer turns
         * "A > B" into the visible text "A &gt; B" (on the grid and in the popup); setting
         * textContent shows the real characters and can never run as HTML.
         */
        showTitle(element, data) {
            if (!element || !data || blank(data.Subject)) return;
            element.querySelectorAll('.e-subject').forEach((el) => {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;   // the popup's title field
                // Titles saved before the store went through Syncfusion's escaping ("A &gt; B"
                // is stored); show what the person typed. Display only -- the data is untouched.
                const title = unescape(String(data.Subject));
                if (el.textContent !== title) el.textContent = title;
            });
        },

        /** WCAG 2 contrast ratio between two #rgb/#rrggbb colors (1..21); NaN if either is unreadable. */
        contrastRatio(a, b) {
            const la = luminance(a), lb = luminance(b);
            if (isNaN(la) || isNaN(lb)) return NaN;
            return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        },

        /**
         * The text color for an event painted in `color`: whichever of white and near-black
         * reads better on it. White on the light palette colors (orange, sky, gray, lime)
         * was 2-3:1. Every built-in color reaches 4.5:1 with its pick (test/unit/event-on-color);
         * a custom color near the middle can't with either, and still gets the better one.
         */
        onColor(color) {
            const light = ScheduleAdapter.contrastRatio(color, ON_LIGHT);
            const dark = ScheduleAdapter.contrastRatio(color, ON_DARK);
            if (isNaN(light) || isNaN(dark)) return ON_LIGHT;
            return dark > light ? ON_DARK : ON_LIGHT;
        },

        /** Syncfusion's exception stamp for an occurrence start: UTC, YYYYMMDDTHHMMSSZ. */
        stamp(when) {
            return new Date(when).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        },

        /** The instant an exception stamp names (stamp's inverse), or null. */
        stampDate(s) {
            const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/i.exec(String(s || '').trim());
            return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
        },

        /**
         * Exception stamps moved as a series moved from `from` to `to` (a drag of "all events"): the same wall-clock
         * days and minutes (CalendarView.edits.shiftBy), so each stamp still names its slot in the moved series.
         * A stamp that can't be read is kept as it is.
         */
        shiftStamps(list, from, to) {
            const a = new Date(from), b = new Date(to);
            const days = Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
            const minutes = (b.getHours() * 60 + b.getMinutes()) - (a.getHours() * 60 + a.getMinutes());
            return String(list || '').split(',').map((x) => x.trim()).filter(Boolean).map((s) => {
                const d = ScheduleAdapter.stampDate(s);
                if (!d) return s;
                d.setDate(d.getDate() + days); d.setMinutes(d.getMinutes() + minutes);
                return ScheduleAdapter.stamp(d);
            }).join(',');
        },

        /**
         * Our events -> the records Syncfusion draws.
         *
         * All-day dates: stored as the author's local-midnight instant, shown at the VIEWER's
         * local midnight of the date they name (Event.allDayToLocal), or Tokyo's Oct 2 showed
         * on Oct 1 in LA. An all-day series' UNTIL and EXDATEs are dates too, mapped the same
         * way. Each record also carries the stored values it was built from (_stored*), so
         * fromRecord can keep a value verbatim when its meaning is unchanged.
         */
        toView(events) {
            const list = events || [];
            const allDayAware = typeof Event === 'function' && typeof Event.allDayToLocal === 'function';
            const byId = new Map(list.filter((e) => e && e.recurrencerule).map((e) => [String(e.id), e]));
            return list.map((e) => {
                const allDay = !!e.isAllDay && allDayAware;
                const toD = allDay ? (v) => Event.allDayToLocal(v) : toDate;
                // An edited occurrence's exception names a slot in its PARENT's grid, so the
                // parent's shape decides (as in ICSService.assignOccurrences).
                const parent = !blank(e.recurrenceID) ? byId.get(String(e.recurrenceID)) : null;
                const allDaySeries = allDayAware && (parent ? !!parent.isAllDay : !!e.isAllDay);
                const start = toD(e.start);
                let end = toD(e.end);
                // A zero-length or inverted all-day range would reach the grid with
                // EndTime == StartTime; show one day. Event keeps the stored end while this
                // shown end comes back unchanged.
                const shownEnd = allDay && start && (!end || end <= start)
                    ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) : null;
                if (shownEnd) end = shownEnd;
                // A stored rule that would freeze the grid (COUNT=10000000 never drew, INTERVAL=0 hung
                // Agenda): shown once, unrepeated, so the calendar loads and the event can be deleted.
                const unsafe = typeof EventStore !== 'undefined' && EventStore.unsafeRecurrence
                    ? EventStore.unsafeRecurrence(e.recurrencerule) : null;
                if (unsafe && !warnedRules.has(e.id)) { warnedRules.add(e.id); console.warn(`[pastecal] event ${e.id}: ${unsafe}; shown once, not repeated`); }
                const rule = unsafe ? '' : e.recurrencerule;
                const shownRule = allDaySeries ? Event.allDayRuleToLocal(rule) : rule;
                const gridRule = yearlyByPosToGrid(shownRule, start);
                // Every field of the one list (EventStore.RECORD) under its record name, as stored; then the ones
                // the grid is shown differently. A field added to the list rides along with no change here. (The
                // event's own zone too: classic neither shows nor edits it, and fromRecord hands it back.)
                const rec = { Id: asText(e.id) };
                for (const [f, R] of Object.entries(Store().RECORD)) if (f !== 'tz' || e.tz) rec[R] = e[f];
                return Object.assign(rec, {
                    StartTime: start,
                    EndTime: end,
                    ...(shownEnd ? { _shownEnd: shownEnd } : {}),
                    _storedStart: e.start,
                    _storedEnd: e.end,
                    _allDaySeries: allDaySeries,
                    ...(allDaySeries ? { _storedRule: rule, _storedException: e.recurrenceException } : {}),
                    RecurrenceRule: gridRule || shownRule,
                    ...(gridRule ? { _gridRule: { shown: gridRule, rule: shownRule, month: start.getMonth() + 1 } } : {}),
                    Type: parseInt(e.type || 1, 10),
                    IsAllDay: !!e.isAllDay,
                    RecurrenceID: asText(e.recurrenceID),
                    RecurrenceException: allDaySeries
                        ? Event.allDayExceptionsToLocal(e.recurrenceException) : e.recurrenceException,
                });
            });
        },

        /** The rule a record stands for, as Syncfusion's editor should show it (see yearlyByPosToGrid). */
        editorRule(r) {
            return r && r._gridRule ? yearlyByPosFromGrid(r.RecurrenceRule, r._gridRule) : r && r.RecurrenceRule;
        },

        /** One Syncfusion record -> the fields of our event it describes. */
        fromRecord(r) {
            if (r && r._gridRule && 'RecurrenceRule' in r) r = { ...r, RecurrenceRule: yearlyByPosFromGrid(r.RecurrenceRule, r._gridRule) };
            const out = {
                id: blank(r.Id) ? null : r.Id,
                recurrenceID: blank(r.RecurrenceID) ? null : r.RecurrenceID,
            };
            // Every field the record carries (EventStore.RECORD), read back; a field it does not carry (an editor that
            // rebuilt the record without the zone) changes nothing.
            for (const [f, R] of Object.entries(Store().RECORD)) {
                if (f !== 'recurrenceID' && R in r) out[f] = (READ[f] || ((v) => v))(r[R]);
            }
            // The way back from toView's all-day display (and an inverted range's repair) is
            // the Event model's: dates become the legacy stored form, and a value whose
            // meaning is unchanged keeps its stored text.
            if (('StartTime' in r || 'EndTime' in r) && typeof Event === 'function'
                && typeof Event.allDayFromLocal === 'function') {
                const ev = new Event(r);
                if ('StartTime' in r) out.start = ev.start;
                if ('EndTime' in r) out.end = ev.end;
                if ('_allDaySeries' in r ? r._allDaySeries : r.IsAllDay) {
                    if ('RecurrenceRule' in r) out.recurrencerule = ev.recurrencerule || '';
                    if ('RecurrenceException' in r) out.recurrenceException = ev.recurrenceException || null;
                }
            }
            return out;
        },

        /**
         * A Syncfusion actionBegin (eventCreate / eventChange / eventRemove) -> one batch
         * command. Syncfusion already expresses repeating-event edits in the stored format
         * (an occurrence edit = a changed master with a new exception stamp + an added row
         * with RecurrenceID), so each record maps to one primitive command.
         */
        toCommand(args, store, context = {}) {
            const commands = [];
            const keyOf = (r) => ({ id: r.Id, recurrenceID: r.RecurrenceID });

            // One occurrence of a repeating event. At actionBegin Syncfusion has NOT yet
            // stamped the series with the date to skip -- it does that after, in the step we
            // cancel -- so it is done here, in Syncfusion's own stored form: the occurrence's
            // ORIGINAL start as a UTC stamp (context.occurrenceStart), appended to the
            // series' recurrenceException; for an edit, the edited copy is a new row pointing
            // at the series. (Captured shapes: test/unit/event-store.test.js.)
            const action = context.action;
            if (action === 'EditOccurrence' || action === 'DeleteOccurrence') {
                const r = (args.changedRecords || [])[0];
                const master = r && store.find({ id: r.RecurrenceID ?? r.Id, recurrenceID: null });
                // The series was deleted (by someone else) while this occurrence's editor or popup was open.
                if (r && !master) throw seriesDeleted(action);
                const when = context.occurrenceStart || (r && r.StartTime);
                if (master && when && (!store.find(keyOf(r)) || action === 'DeleteOccurrence')) {
                    // The grid shows an all-day occurrence at the viewer's local midnight; the
                    // series stores its dates in the author's (see Event.allDayStampFromLocal).
                    const shown = ScheduleAdapter.stamp(when);
                    const stamp = master.isAllDay && typeof Event === 'function' && typeof Event.allDayStampFromLocal === 'function'
                        ? Event.allDayStampFromLocal(shown) : shown;
                    const list = String(master.recurrenceException || '').split(',').map((x) => x.trim()).filter(Boolean);
                    if (!list.includes(stamp)) list.push(stamp);
                    commands.push({ type: 'update', key: master, changes: { recurrenceException: list.join(',') } });
                    // One slot, one row: if this occurrence already has its edited row (someone else saved "This
                    // event" on it while this editor was open), change that row instead of adding a second.
                    const edited = action === 'EditOccurrence' && (store.getEvents() || []).find((e) => e && !blank(e.recurrenceID)
                        && String(e.recurrenceID) === String(master.id) && String(e.recurrenceException || '').trim() === stamp);
                    if (edited) {
                        // Only what this change changed, measured from where it began (noteStart) or else from the
                        // occurrence as the series draws it at this slot: the edited row's own fields stay.
                        const dur = new Date(master.end) - new Date(master.start);
                        const slot = { ...ScheduleAdapter.toView([master])[0], StartTime: new Date(when), EndTime: new Date(new Date(when).getTime() + dur) };
                        const { id: _i, recurrenceID: _r, recurrencerule: _rule, recurrenceException: _ex, ...fields } = ScheduleAdapter.changesFrom(r, slot);
                        commands.push({ type: 'update', key: edited, changes: fields });
                    } else if (action === 'EditOccurrence') {
                        opened.delete(recKey(r));   // (a new row: all of it is this change)
                        // (An edited occurrence keeps its series' zone.)
                        commands.push({ type: 'add', event: { ...(master.tz ? { tz: master.tz } : {}), ...ScheduleAdapter.fromRecord(r), id: null, recurrenceID: master.id,
                            recurrencerule: master.recurrencerule, recurrenceException: stamp } });
                    }
                    for (const d of args.deletedRecords || []) commands.push({ type: 'remove', key: keyOf(d) });
                    return { type: 'batch', commands, label: args.requestType };
                }
            }

            // The whole series. At actionBegin Syncfusion lists the series under CHANGED even
            // for a delete (Sep 26: "delete entire series" left the series in place) and with
            // the occurrence's RecurrenceID; only currentAction says what the user meant.
            if (action === 'DeleteSeries' || action === 'EditSeries') {
                const r = (args.changedRecords || [])[0] || (args.deletedRecords || [])[0];
                const master = r && store.find({ id: r.RecurrenceID ?? r.Id, recurrenceID: null });
                if (!master) throw seriesDeleted(action);
                const ownOccurrences = (store.getEvents() || []).filter((e) => e.recurrenceID !== null && e.recurrenceID !== undefined
                    && String(e.recurrenceID) === String(master.id));
                if (action === 'DeleteSeries') {
                    for (const e of ownOccurrences) commands.push({ type: 'remove', key: e });
                    commands.push({ type: 'remove', key: master });
                } else {
                    // Syncfusion's own EditSeries rule (ej2-schedule 23.2.6, crud "EditSeries"),
                    // which runs AFTER actionBegin -- in the step we cancel -- so it is done here:
                    // "Match every occurrence to the series again?" -- No (context.keepOccurrences,
                    // its uiStateValues.isIgnoreOccurrence) keeps the skipped dates and the
                    // separately edited occurrences; otherwise both are cleared.
                    const changes = ScheduleAdapter.changesFrom(r);
                    if (context.keepOccurrences && !blank(master.recurrenceException)) {
                        delete changes.recurrenceException;
                        // The series was moved (context.shift: { from, to }, a drag of "all events"): its skipped
                        // dates and its edited occurrences' slots move with it, or a deleted date comes back and an
                        // edited one shows twice.
                        const shift = context.shift;
                        if (shift) {
                            changes.recurrenceException = ScheduleAdapter.shiftStamps(master.recurrenceException, shift.from, shift.to);
                            for (const e of ownOccurrences) {
                                if (!blank(e.recurrenceException)) commands.push({ type: 'update', key: e,
                                    changes: { recurrenceException: ScheduleAdapter.shiftStamps(e.recurrenceException, shift.from, shift.to) } });
                            }
                        }
                    } else {
                        changes.recurrenceException = null;
                        for (const e of ownOccurrences) commands.push({ type: 'remove', key: e });
                    }
                    commands.push({ type: 'update', key: master, changes });
                }
                return { type: 'batch', commands, label: args.requestType };
            }
            // Anything else on a repeating event is an action we have not mapped: refuse it
            // (reported, nothing saved) rather than guess -- guessing is how a series vanished.
            const recurring = [...(args.changedRecords || []), ...(args.deletedRecords || [])]
                .some((r) => !blank(r.RecurrenceRule) || !blank(r.RecurrenceID));
            if (recurring && action && !['Save', 'Add', 'Delete', 'EditOccurrence', 'DeleteOccurrence'].includes(action)) {
                throw Object.assign(new Error(`unsupported action ${action} on a repeating event`), { code: 'unsupported_action' });
            }

            for (const r of args.deletedRecords || []) commands.push({ type: 'remove', key: keyOf(r) });
            for (const r of args.changedRecords || []) {
                const existing = store.find(keyOf(r));
                // A record Syncfusion calls "changed" that we do not hold is really new
                // (it happens when the series master is re-created); add it rather than fail.
                if (existing) commands.push({ type: 'update', key: existing, changes: ScheduleAdapter.changesFrom(r) });
                else commands.push({ type: 'add', event: { ...ScheduleAdapter.fromRecord(r), id: null } });
            }
            for (const r of args.addedRecords || []) {
                const e = ScheduleAdapter.fromRecord(r);
                // An edited occurrence points at its series by RecurrenceID; store that as
                // the series' STORED id (a number stays a number).
                if (!blank(e.recurrenceID)) {
                    const master = store.find({ id: e.recurrenceID, recurrenceID: null });
                    if (master) e.recurrenceID = master.id;
                }
                commands.push({ type: 'add', event: { ...e, id: null } });
            }
            return { type: 'batch', commands, label: args.requestType };
        },
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = ScheduleAdapter;
    else root.ScheduleAdapter = ScheduleAdapter;
})(typeof window !== 'undefined' ? window : globalThis);
