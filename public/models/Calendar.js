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

    // What Syncfusion draws. The mapping (and every Syncfusion quirk it absorbs) lives in
    // ScheduleAdapter, the one boundary between Syncfusion and our events.
    getSyncFusionEvents() {
        return ScheduleAdapter.toView(this.events);
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
