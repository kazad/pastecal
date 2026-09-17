// Event Model Class
// May be created from JSON object or SyncFusion internal calendar event

class Event {
    constructor(options) {
        this.id = options.Id || options.id || Utils.uuidv4();
        this.title = options.Subject || options.text || options.title || "";
        this.description = options.Description || options.description || "";
        this.repeat = options.Recurrence || options.repeat || "";
        this.recurrencerule = options.RecurrenceRule || options.recurrencerule || "";
        // Normalized to ISO, never stored as whatever the caller happened to pass.
        //
        // These used to pass through verbatim, so the app that created an event decided
        // its storage format: the Syncfusion app writes ISO strings, NativeCal wrote
        // epoch-ms numbers. CalendarDataService._mergeEvents compares start/end RAW, so
        // 1790006400000 !== "2026-09-21T16:00:00.000Z" even though they are the same
        // instant -- after any NativeCal write, EVERY event read as "changed by me" and
        // a concurrent edit from the other app was overwritten wholesale. That is
        // precisely the last-write-wins data loss the merge exists to prevent.
        //
        // Normalizing here rather than at the call sites keeps the stored shape
        // unchanged (ISO, exactly what is already in every calendar) and makes it
        // impossible for a third writer to reintroduce the split. A value that is not a
        // real date becomes null, same as toISOStringOrNull has always done.
        this.start = Event.toISOStringOrNull(options.start);
        this.end = Event.toISOStringOrNull(options.end);
        this.type = parseInt(options.Type || options.type || 1);

        this.recurrenceID = options.RecurrenceID || options.recurrenceID || null;
        this.recurrenceException = options.RecurrenceException || options.recurrenceException || null;
        this.isAllDay = options.IsAllDay || options.isAllDay || false;

        // for SyncFusion Internal Object
        if (options.StartTime) {
            this.start = Event.toISOStringOrNull(options.StartTime);
            this.end = Event.toISOStringOrNull(options.EndTime);
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
