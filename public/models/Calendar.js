// Calendar Model Class
// Manages calendar data and events

class Calendar {
    constructor(id, title, events, options) {
        this.id = id;
        this.title = title || "";
        this.events = events || [];
        this.options = options || {};
    }

    // e.start/e.end may be a raw epoch-ms number (nativecal's EventEditor) or an ISO
    // string (the legacy Event model) -- Syncfusion's StartTime/EndTime require a real
    // Date instance and silently fail to render otherwise.
    static toDateOrNull(value) {
        if (value === null || value === undefined || value === "") return null;
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    // Syncfusion only ever sees ids as strings. It decides whether ids are numbers or
    // strings from the FIRST event in its data, converts the edited event's id to that
    // kind, and then finds the event with ===. Real calendars mix both kinds -- events made
    // on the grid long ago carry Syncfusion's number ids, events from +Event, paste and
    // NativeCal carry uuids -- so whichever kind the first event was not became
    // uneditable: Save threw "can't access property RecurrenceRule, o is undefined" and
    // the editor stayed open (#32, Sep 25; /ywxa56kc had 26 number + 19 uuid ids).
    // All strings, the lookup always matches. restoreIds() gives records coming back the
    // exact ids that are stored, so the saved data never changes shape.
    static sfId(v) {
        return (v === null || v === undefined || v === '') ? v : String(v);
    }

    restoreIds(records) {
        const stored = new Map();
        for (const e of this.events) {
            if (e.id !== null && e.id !== undefined) stored.set(String(e.id), e.id);
            if (e.recurrenceID !== null && e.recurrenceID !== undefined) stored.set(String(e.recurrenceID), e.recurrenceID);
        }
        const back = (v) => (v === null || v === undefined || v === '' || !stored.has(String(v))) ? v : stored.get(String(v));
        return records.map(r => ({ ...r, Id: back(r.Id), RecurrenceID: back(r.RecurrenceID) }));
    }

    getSyncFusionEvents() {
        return this.events.map(e => {
            return {
                Id: Calendar.sfId(e.id),
                Subject: e.title,
                StartTime: Calendar.toDateOrNull(e.start),
                EndTime: Calendar.toDateOrNull(e.end),
                Description: e.description,
                RecurrenceRule: e.recurrencerule,
                Type: parseInt(e.type || 1),
                IsAllDay: !!e.isAllDay,
                Recurrence: e.repeat,
                RecurrenceID: Calendar.sfId(e.recurrenceID),
                RecurrenceException: e.recurrenceException
            }
        });
    }

    defaultEvent(title) {
        var e = new Event({ title: title });

        // sample 1-hour event in local timezone
        var d = new Date();
        d.setHours(12, 0, 0, 0);
        e.start = d.toISOString();
        d.setHours(13, 0, 0, 0);
        e.end = d.toISOString();

        return e;
    }

    import(c) {
        Object.assign(this, c);
    }

    setEvents(events) {
        console.log(`[app] setEvents ${events.length}`, events);
        this.events = events.map(e => {
            return new Event(e);
        });
        CalendarDataService.debounce_sync(this);
    }
}
