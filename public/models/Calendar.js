// Calendar Model Class
// Manages calendar data and events

class Calendar {
    constructor(id, title, events, options) {
        this.id = id;
        this.title = title || "";
        this.events = events || [];
        this.options = options || {};
    }

    getSyncFusionEvents() {
        return this.events.map(e => {
            return {
                Id: e.id,
                Subject: e.title,
                StartTime: e.start,
                EndTime: e.end,
                Description: e.description,
                RecurrenceRule: e.recurrencerule,
                Type: parseInt(e.type || 1),

                //                        IsAllDay: e.allday,
                Recurrence: e.repeat,
                RecurrenceID: e.recurrenceID,
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
