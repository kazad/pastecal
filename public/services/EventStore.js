/**
 * EventStore -- the one owner of a calendar's events.
 *
 * Every change to events goes through here as a COMMAND ("add this", "change these fields
 * of that", "remove that"), whichever screen it came from: the Syncfusion grid and editor,
 * +Event, paste, undo. The store validates it against one schema, applies it to the list,
 * works out the command that undoes it, and hands the new list to `commit` to be saved.
 *
 * Why it exists: before this, each screen wrote the calendar in its own shape. The grid
 * saved whatever Syncfusion's internal records looked like (number ids, HTML-escaped
 * titles), +Event built its own objects, and each writer declared deletions to the save
 * gate by its own arithmetic. Every one of those was a separate place to get it wrong --
 * mixed id kinds made events uneditable (#32), stale records reverted edits (#41), and a
 * wrong count got a real delete refused. Here there is one schema, one way to find an
 * event, one place that counts removals, and one log line per command that fails.
 *
 * The STORED FORMAT DOES NOT CHANGE. Events are the same objects in the same array, saved
 * by the same CalendarDataService path; this only decides what goes into that array.
 *
 * Pure core: `EventStore.apply(events, command)` never touches the page, so the rules can
 * be unit-tested in node (test/unit/event-store.test.js).
 *
 * Commands
 *   { type: 'add',    event }                   a new event (a fresh id if it has none or it clashes)
 *   { type: 'update', key, changes }            only the fields that changed
 *   { type: 'remove', key }                     one row
 *   { type: 'batch',  commands, label }         several, as one undoable change
 * `key` is { id, recurrenceID } or an event: rows are identified by BOTH, because an edited
 * occurrence of a repeating event may share its series' id and differ only by recurrenceID.
 */
(function (root) {
    'use strict';

    const FIELDS = ['title', 'description', 'start', 'end', 'type', 'isAllDay',
        'repeat', 'recurrencerule', 'recurrenceID', 'recurrenceException'];

    const blank = (v) => v === undefined || v === null || v === '';
    const uuid = () => (root.Utils && root.Utils.uuidv4) ? root.Utils.uuidv4()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });

    /** A date-ish value as ISO, or null if it is not a real date. */
    function iso(v) {
        if (blank(v)) return null;
        const d = v instanceof Date ? v : new Date(v);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    /** Identity of a row. Ids compare as TEXT: stored ids are numbers (old grid events) or uuids. */
    function keyOf(e) {
        if (!e) return '';
        return `${blank(e.id) ? '' : String(e.id)}|${blank(e.recurrenceID) ? '' : String(e.recurrenceID)}`;
    }

    /**
     * The one schema. Accepts every shape that has ever been stored (title/Subject,
     * id/Id, ...) and returns the canonical one. The id keeps its stored value and kind --
     * a number stays a number -- so saving never changes an existing row's identity.
     */
    function normalize(raw) {
        const r = raw || {};
        const pick = (a, b) => (!blank(r[a]) ? r[a] : r[b]);
        const typeN = parseInt(pick('type', 'Type'), 10);
        const out = {
            id: !blank(r.id) ? r.id : (!blank(r.Id) ? r.Id : null),
            title: String(pick('title', 'Subject') ?? '').trim(),
            description: String(pick('description', 'Description') ?? ''),
            start: iso(pick('start', 'StartTime')),
            end: iso(pick('end', 'EndTime')),
            type: typeN >= 1 ? typeN : 1,
            isAllDay: !!(r.isAllDay ?? r.IsAllDay),
            repeat: String(pick('repeat', 'Recurrence') ?? ''),
            recurrencerule: String(pick('recurrencerule', 'RecurrenceRule') ?? ''),
            recurrenceID: blank(pick('recurrenceID', 'RecurrenceID')) ? null : pick('recurrenceID', 'RecurrenceID'),
            recurrenceException: blank(pick('recurrenceException', 'RecurrenceException')) ? null : String(pick('recurrenceException', 'RecurrenceException')),
        };
        return out;
    }

    /**
     * Why a repeat rule is unsafe to expand, or null. A browser expands a rule into every
     * occurrence it shows: FREQ=SECONDLY is 3.6 million in a month view (the native view froze
     * then ran out of memory), COUNT=10000000 froze the classic view, INTERVAL=0 hung its
     * Agenda. No real calendar repeats by the minute or second, more than 5000 times, or every
     * 0 days. The server refuses these on save; the views show such a stored event once,
     * unrepeated. DAILY to YEARLY with BYDAY/BYMONTHDAY/BYSETPOS/UNTIL/COUNT/INTERVAL, and
     * HOURLY, stay allowed.
     */
    function unsafeRecurrence(rule) {
        if (blank(rule)) return null;
        if (typeof rule !== 'string') return 'repeat rule is not text';
        const parts = {};
        for (const p of rule.replace(/^\s*RRULE:/i, '').split(';')) {
            const i = p.indexOf('=');
            if (i > 0) parts[p.slice(0, i).trim().toUpperCase()] = p.slice(i + 1).trim();
        }
        const freq = String(parts.FREQ || '').toUpperCase();
        if (freq === 'SECONDLY' || freq === 'MINUTELY') return `repeats every ${freq === 'SECONDLY' ? 'second' : 'minute'}`;
        if ('BYSECOND' in parts) return 'repeats by the second';
        if ('BYMINUTE' in parts && parts.BYMINUTE.split(',').length > 4) return 'repeats too often in an hour';
        if ('COUNT' in parts && !(/^\d+$/.test(parts.COUNT) && +parts.COUNT >= 1 && +parts.COUNT <= 5000)) return 'repeats more than 5000 times';
        if ('INTERVAL' in parts && !/^[1-9]\d*$/.test(parts.INTERVAL)) return 'repeat interval is not a positive number';
        return null;
    }

    /** Why this event cannot be stored, or null. */
    function invalid(e) {
        if (!e.start) return 'start is not a date';
        if (!e.end) return 'end is not a date';
        if (new Date(e.end) < new Date(e.start)) return 'end is before start';
        return null;
    }

    /** Same meaning, field by field (type as number, empty == null). */
    function sameField(f, a, b) {
        if (f === 'type') return (parseInt(a, 10) || 1) === (parseInt(b, 10) || 1);
        if (f === 'isAllDay') return !!a === !!b;
        if (f === 'start' || f === 'end') return iso(a) === iso(b);
        return (blank(a) ? null : String(a)) === (blank(b) ? null : String(b));
    }

    /** The fields of `next` that differ from `prev` -- what a change actually changes. */
    function diff(prev, next) {
        const out = {};
        for (const f of FIELDS) if (f in next && !sameField(f, prev[f], next[f])) out[f] = next[f];
        return out;
    }

    const stampsOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

    /**
     * An undo (an update carrying `wrote`, what the undone change wrote) takes back only this tab's own change,
     * measured against the row as it is NOW, so it never reverts what someone else changed since:
     *   - recurrenceException: remove exactly the stamps the change added and put back the ones it removed; a
     *     date someone else skipped meanwhile stays skipped.
     *   - any other field: undone only while it still holds what this change wrote.
     * Edits `changes` in place.
     */
    function undoOnly(current, changes, wrote) {
        for (const f of Object.keys(changes)) {
            if (!(f in wrote)) continue;
            if (f === 'recurrenceException') {
                const was = stampsOf(changes[f]), put = stampsOf(wrote[f]);
                const added = new Set(put.filter((s) => !was.includes(s)));
                const removed = was.filter((s) => !put.includes(s));
                const now = stampsOf(current[f]).filter((s) => !added.has(s));
                for (const s of removed) if (!now.includes(s)) now.push(s);
                changes[f] = now.length ? now.join(',') : null;
            } else if (!sameField(f, current[f], wrote[f])) {
                delete changes[f];
            }
        }
    }

    class CommandError extends Error {
        constructor(message, command, code) { super(message); this.name = 'CommandError'; this.command = command; this.code = code || 'command_error'; }
    }

    /**
     * Apply one command to a list, purely. Returns the new list, the command that undoes
     * it, and what it did. Throws CommandError for a command that cannot be applied --
     * never half-applies.
     */
    function apply(events, command) {
        const list = (events || []).map((e) => e);            // shallow: rows are replaced, not mutated
        const index = new Map(list.map((e, i) => [keyOf(e), i]));
        const findKey = (key) => {
            const k = typeof key === 'string' ? key : keyOf(key);
            if (index.has(k)) return k;
            // An edited occurrence can arrive without its recurrenceID; fall back to id alone
            // only when exactly one row has that id, so the lookup is never a guess.
            const id = k.split('|')[0];
            const hits = [...index.keys()].filter((x) => x.split('|')[0] === id);
            return hits.length === 1 ? hits[0] : null;
        };
        const c = command || {};

        switch (c.type) {
            case 'add': {
                const e = normalize(c.event);
                if (blank(e.id) || index.has(keyOf(e))) e.id = uuid();
                const why = invalid(e);
                if (why) throw new CommandError(`add: ${why}`, c, 'invalid_dates');
                list.push(e);
                return { events: list, inverse: { type: 'remove', key: keyOf(e) }, added: [e], changed: [], removed: [] };
            }
            case 'update': {
                const k = findKey(c.key);
                if (!k) throw new CommandError(`update: no event ${typeof c.key === 'string' ? c.key : keyOf(c.key)}`, c, 'no_event');
                const i = index.get(k), prev = list[i];
                // An edit never changes WHICH row it is: id and recurrenceID come from the
                // key, not from the changes. (Sep 26: editing a whole series from one of its
                // occurrences arrived with the occurrence's RecurrenceID, turned the series
                // into an orphan "edited occurrence" of itself, and it vanished.)
                const { id: _id, recurrenceID: _rid, ...fieldChanges } = c.changes || {};
                if (c.wrote) undoOnly(prev, fieldChanges, c.wrote);
                const changes = diff(prev, normalize({ ...prev, ...fieldChanges }));
                if (!Object.keys(changes).length) return { events: list, inverse: null, added: [], changed: [], removed: [] };
                const next = { ...prev, ...changes };
                const why = invalid(next);
                if (why) throw new CommandError(`update: ${why}`, c, 'invalid_dates');
                const before = {}; for (const f of Object.keys(changes)) before[f] = prev[f];
                list[i] = next;
                // The inverse remembers what this change wrote, so an undo can take back only that (undoOnly).
                return { events: list, inverse: { type: 'update', key: keyOf(next), changes: before, wrote: changes }, added: [], changed: [next], removed: [] };
            }
            case 'remove': {
                const k = findKey(c.key);
                if (!k) throw new CommandError(`remove: no event ${typeof c.key === 'string' ? c.key : keyOf(c.key)}`, c, 'no_event');
                const i = index.get(k), gone = list[i];
                list.splice(i, 1);
                return { events: list, inverse: { type: 'add', event: gone, restoreId: true }, added: [], changed: [], removed: [gone] };
            }
            case 'batch': {
                let cur = list; const inverses = [], added = [], changed = [], removed = [];
                for (const sub of c.commands || []) {
                    const r = sub.type === 'add' && sub.restoreId ? restore(cur, sub.event) : apply(cur, sub);
                    cur = r.events; if (r.inverse) inverses.unshift(r.inverse);
                    added.push(...r.added); changed.push(...r.changed); removed.push(...r.removed);
                }
                return { events: cur, inverse: inverses.length ? { type: 'batch', commands: inverses, label: c.label } : null, added, changed, removed };
            }
            default:
                throw new CommandError(`unknown command ${c.type}`, c, 'unknown_command');
        }
    }

    // Undo of a remove puts the row back with its ORIGINAL id, so anything that pointed at
    // it (an occurrence's recurrenceID, a shared link) still does.
    function restore(events, event) {
        const e = normalize(event);
        if (events.some((x) => keyOf(x) === keyOf(e))) throw new CommandError('restore: already there', { type: 'add', event }, 'already_there');
        return { events: [...events, e], inverse: { type: 'remove', key: keyOf(e) }, added: [e], changed: [], removed: [] };
    }

    /**
     * The structure every save must keep: a row that is an edited occurrence (has a
     * recurrenceID) must point at a series that is in the calendar. Checked for the rows a
     * command touched -- older data may already hold orphans, and a change elsewhere must
     * not be refused for them. A command that breaks it is refused and reported, instead
     * of saving a calendar whose series has silently disappeared.
     */
    function structureProblem(events, touched) {
        const series = new Set(events.filter((e) => blank(e.recurrenceID)).map((e) => String(e.id)));
        for (const e of touched) {
            if (!blank(e.recurrenceID) && !series.has(String(e.recurrenceID))) {
                // No title in the message: it goes to logs and analytics. The toast adds it from err.title.
                const err = new CommandError('would point at a repeating series that is not in the calendar', null, 'orphan_occurrence');
                err.title = e.title || '';
                return err;
            }
        }
        return null;
    }

    /**
     * What a failed command may tell analytics: a code and where it came from, never the user's text. A message
     * can quote an event (a title in a toast, an id in a log); a calendar's contents never leave the page.
     */
    function report(err, command) {
        const code = err && /^[a-z_]+$/.test(String(err.code || '')) ? err.code : 'command_error';
        const where = command && (command.where || command.type);
        return { message: code, where: /^[\w/]+$/.test(String(where || '')) ? String(where) : 'command' };
    }

    function applyAny(events, command) {
        return command.type === 'add' && command.restoreId ? restore(events, command.event) : apply(events, command);
    }

    /**
     * The live store around one calendar.
     *   getEvents()          the current stored list (calendar.events)
     *   commit(list, info)   save it (calendar.setEvents); info.removed is how many rows went
     *   onError(err, cmd)    report a command that could not be applied
     */
    class EventStore {
        constructor({ getEvents, commit, onError } = {}) {
            this.getEvents = getEvents;
            this.commit = commit;
            this.onError = onError || (() => {});
            this.undoStack = [];
        }

        /** The stored row for a key (see apply's findKey for the id-only fallback). */
        find(key) {
            const k = typeof key === 'string' ? key : keyOf(key);
            const list = this.getEvents() || [];
            const exact = list.find((e) => keyOf(e) === k);
            if (exact) return exact;
            const sameId = list.filter((e) => String(e.id) === k.split('|')[0]);
            return sameId.length === 1 ? sameId[0] : null;
        }

        /** Apply a command and save. Returns { ok, result } or { ok: false, error }; never throws. */
        dispatch(command, { label, undoable = true } = {}) {
            try {
                const before = this.getEvents() || [];
                const result = applyAny(before, command);
                const broken = structureProblem(result.events, [...result.added, ...result.changed]);
                if (broken) { broken.command = command; throw broken; }
                // How many rows the save will be shorter by -- what the write gate must be told.
                const shrink = Math.max(0, before.length - result.events.length);
                this.commit(result.events, { shrink, added: result.added, changed: result.changed, removed: result.removed, label });
                if (undoable && result.inverse) this.undoStack.push({ inverse: result.inverse, label });
                if (this.undoStack.length > 50) this.undoStack.shift();
                return { ok: true, result };
            } catch (err) {
                this.onError(err, command);
                return { ok: false, error: err };
            }
        }

        get canUndo() { return this.undoStack.length > 0; }

        /** Undo the last command. Returns its label, or null if there was nothing to undo. */
        undo() {
            const last = this.undoStack.pop();
            if (!last) return null;
            const r = this.dispatch(last.inverse, { label: `Undo ${last.label || ''}`.trim(), undoable: false });
            return r.ok ? (last.label || 'change') : null;
        }
    }

    /**
     * The commands that turn `current` into `target`, row by row: removes for rows only in
     * current, restores for rows only in target, updates for rows whose fields differ. A
     * whole-list restore (Recent changes, undo of a bulk change) becomes an ordinary,
     * counted, undoable batch instead of a blind overwrite.
     */
    function changesBetween(current, target) {
        const cur = new Map((current || []).map((e) => [keyOf(e), e]));
        const tgt = new Map((target || []).map((e) => [keyOf(normalize(e)), normalize(e)]));
        const commands = [];
        for (const [k] of cur) if (!tgt.has(k)) commands.push({ type: 'remove', key: k });
        for (const [k, e] of tgt) {
            if (!cur.has(k)) commands.push({ type: 'add', event: e, restoreId: true });
            else if (Object.keys(diff(cur.get(k), e)).length) commands.push({ type: 'update', key: k, changes: e });
        }
        return commands;
    }

    EventStore.apply = applyAny;
    EventStore.changesBetween = changesBetween;
    EventStore.normalize = normalize;
    EventStore.keyOf = keyOf;
    EventStore.diff = diff;
    EventStore.CommandError = CommandError;
    EventStore.report = report;
    EventStore.FIELDS = FIELDS;
    EventStore.unsafeRecurrence = unsafeRecurrence;

    if (typeof module !== 'undefined' && module.exports) module.exports = EventStore;
    else root.EventStore = EventStore;
})(typeof window !== 'undefined' ? window : globalThis);
