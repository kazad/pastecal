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
    const recKey = (r) => `${blank(r.Id) ? '' : String(r.Id)}|${blank(r.RecurrenceID) ? '' : String(r.RecurrenceID)}`;

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

        /** The fields the user changed: record vs the event as it was when they started. */
        changesFrom(record) {
            const now = ScheduleAdapter.fromRecord(record);
            const start = opened.get(recKey(record));
            opened.delete(recKey(record));
            if (!start) return now;                      // no snapshot: the whole record
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

        /** Syncfusion's exception stamp for an occurrence start: UTC, YYYYMMDDTHHMMSSZ. */
        stamp(when) {
            return new Date(when).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        },

        /** Our events -> the records Syncfusion draws. */
        toView(events) {
            return (events || []).map((e) => ({
                Id: asText(e.id),
                Subject: e.title,
                StartTime: toDate(e.start),
                EndTime: toDate(e.end),
                Description: e.description,
                RecurrenceRule: e.recurrencerule,
                Type: parseInt(e.type || 1, 10),
                IsAllDay: !!e.isAllDay,
                Recurrence: e.repeat,
                RecurrenceID: asText(e.recurrenceID),
                RecurrenceException: e.recurrenceException,
            }));
        },

        /** One Syncfusion record -> the fields of our event it describes. */
        fromRecord(r) {
            const out = {
                id: blank(r.Id) ? null : r.Id,
                recurrenceID: blank(r.RecurrenceID) ? null : r.RecurrenceID,
            };
            if ('Subject' in r) out.title = unescape(r.Subject || '');
            if ('Description' in r) out.description = unescape(r.Description || '');
            if ('StartTime' in r) out.start = r.StartTime;
            if ('EndTime' in r) out.end = r.EndTime;
            if ('Type' in r) out.type = r.Type;
            if ('IsAllDay' in r) out.isAllDay = !!r.IsAllDay;
            if ('RecurrenceRule' in r) out.recurrencerule = r.RecurrenceRule || '';
            if ('RecurrenceException' in r) out.recurrenceException = r.RecurrenceException || null;
            if ('Recurrence' in r) out.repeat = r.Recurrence || '';
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
                const when = context.occurrenceStart || (r && r.StartTime);
                if (master && when && (!store.find(keyOf(r)) || action === 'DeleteOccurrence')) {
                    const stamp = ScheduleAdapter.stamp(when);
                    const list = String(master.recurrenceException || '').split(',').map((x) => x.trim()).filter(Boolean);
                    if (!list.includes(stamp)) list.push(stamp);
                    commands.push({ type: 'update', key: master, changes: { recurrenceException: list.join(',') } });
                    if (action === 'EditOccurrence') {
                        commands.push({ type: 'add', event: { ...ScheduleAdapter.fromRecord(r), id: null, recurrenceID: master.id,
                            recurrencerule: master.recurrencerule, recurrenceException: stamp } });
                    }
                    for (const d of args.deletedRecords || []) commands.push({ type: 'remove', key: keyOf(d) });
                    return { type: 'batch', commands, label: args.requestType };
                }
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
