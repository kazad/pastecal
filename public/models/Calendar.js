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

    // Stored all-day instant -> the viewer's LOCAL midnight of its calendar date.
    // Converting the stored instant directly showed Tokyo's Oct 2 holiday on Oct 1 in LA;
    // see Event.allDayDateUTC for how the date is derived.
    static allDayToLocal(value) {
        return Event.allDayToLocal(value);
    }

    getSyncFusionEvents() {
        const byId = new Map(this.events.filter(e => e && e.recurrencerule).map(e => [e.id, e]));
        return this.events.map(e => {
            const allDay = !!e.isAllDay;
            const toDate = allDay ? Calendar.allDayToLocal : Calendar.toDateOrNull;
            // An all-day series' EXDATEs and UNTIL are dates too, and must land on the
            // same local date as its start (see Event.allDayStampToLocal). An edited
            // occurrence's exception names a slot in its PARENT's grid, so the parent's
            // shape decides (as in ICSService.assignOccurrences).
            const parent = e.recurrenceID ? byId.get(e.recurrenceID) : null;
            const allDaySeries = parent ? !!parent.isAllDay : allDay;
            return {
                Id: e.id,
                Subject: e.title,
                StartTime: toDate(e.start),
                EndTime: toDate(e.end),
                // What the record was built from, so Event can keep each value verbatim
                // when its meaning is unchanged (see Event's constructor).
                _storedStart: e.start,
                _storedEnd: e.end,
                _allDaySeries: allDaySeries,
                ...(allDaySeries ? { _storedRule: e.recurrencerule, _storedException: e.recurrenceException } : {}),
                Description: e.description,
                RecurrenceRule: allDaySeries ? Event.allDayRuleToLocal(e.recurrencerule) : e.recurrencerule,
                Type: parseInt(e.type || 1),
                IsAllDay: allDay,
                Recurrence: e.repeat,
                RecurrenceID: e.recurrenceID,
                RecurrenceException: allDaySeries
                    ? Event.allDayExceptionsToLocal(e.recurrenceException) : e.recurrenceException
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
