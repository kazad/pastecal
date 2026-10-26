/**
 * CalendarView -- what the app asks of the calendar on screen, whichever one draws it (docs/native-inventory.md).
 *
 * Two implementations: Syncfusion's Schedule (the classic calendar, built in app.js mountSyncfusion) and
 * pastecal's own NativeCalendar (nativecal/components/NativeCalendar.js, mounted by the app's template on a
 * native view link). Neutral shapes only: stored events go in, occurrences come out as
 * { event, start, end, allDay, title, type } (Dates). Never Syncfusion's records (Subject, StartTime...).
 *
 *   kind                        'syncfusion' | 'native'
 *   currentView()               'Day' | 'Week' | 'Month' | the custom view's name ('3 Months') | 'Year' | 'Agenda'
 *   selectedDate()              the Date the view is anchored on
 *   visibleRange()              { start, end } epoch ms of the dates on screen (end exclusive), or null
 *   goTo({ date, view })        show a date and/or a view
 *   occurrences(start, end)     what the grid draws in [start, end): shown events only (color filter), repeats
 *                               expanded, skipped and edited occurrences applied
 *   occursInRange(event, range) does this stored event put an occurrence in range? true / false, or null when
 *                               the calendar cannot tell (the caller estimates)
 *   render()                    the events or the color filter changed
 *   refreshLayout()             the container changed size
 *   setReadOnly(on), closePopups(), openEditor(event)
 */
(function (root) {
    'use strict';

    // Stored events -> what NativeCalendar draws. All-day events in the display shape (Event.allDayDisplayRange:
    // the viewer's local midnight of the first day .. local 23:59:59.999 of the last), and an all-day series'
    // UNTIL and skipped dates at the viewer's local midnight too, as Syncfusion is given them
    // (ScheduleAdapter.toView): a skipped date written in Tokyo is skipped in Los Angeles.
    function displayEvents(events) {
        const E = typeof Event === 'function' ? Event : null;   // models/Event.js (a global class, not a window property)
        const mapped = !!E && typeof E.allDayDisplayRange === 'function';
        return (events || []).filter(Boolean).map((e) => (e.isAllDay && mapped ? {
            ...e, ...E.allDayDisplayRange(e),
            recurrencerule: E.allDayRuleToLocal(e.recurrencerule),
            recurrenceException: E.allDayExceptionsToLocal(e.recurrenceException),
        } : e));
    }

    // The stored event an occurrence belongs to (the grid may hold a display copy or its own record of it).
    const stored = (vm, id, recurrenceID) => (vm.calendar.events || []).find((e) => e && String(e.id) === String(id)
        && String(e.recurrenceID ?? '') === String(recurrenceID ?? '')) || null;

    /** pastecal's own calendar. vm: the app; component(): the mounted <native-calendar>, or null before it mounts. */
    function native(vm, component) {
        const expand = (events, start, end) => {
            const NC = root.NativeCalendar;
            if (!NC || typeof NC.occurrencesBetween !== 'function') return [];
            return NC.occurrencesBetween(displayEvents(events), new Date(start), new Date(end));
        };
        return {
            kind: 'native',
            currentView() {
                const c = component();
                if (!c) return 'Month';
                return c.view === 'Custom' ? c.customLabel : c.view;
            },
            selectedDate() { const c = component(); return c ? new Date(c.date) : new Date(); },
            visibleRange() { const c = component(); return c ? c.visibleRange() : null; },
            goTo({ date, view } = {}) {
                const c = component();
                if (!c) return;
                if (date) c.date = new Date(new Date(date).getFullYear(), new Date(date).getMonth(), new Date(date).getDate());
                if (view) c.setView(view);
            },
            occurrences(start, end) {
                return expand((vm.calendar.events || []).filter((e) => vm.isEventVisible(e)), start, end).map((o) => ({
                    event: stored(vm, o.event.id, o.event.recurrenceID) || o.event, start: o.start, end: o.end, allDay: !!o.allDay, title: o.title, type: o.type,
                }));
            },
            occursInRange(event, range) { return expand([event], range.start, range.end).length > 0; },
            render() { /* reactive: the grid reads calendar.events and the color filter as props */ },
            refreshLayout() { if (typeof vm.fitNativeMonthRows === 'function') vm.$nextTick(() => vm.fitNativeMonthRows()); },
            setReadOnly() { /* the read-only prop follows isReadOnly */ },
            closePopups() {
                vm.nativePopover = null;
                vm.nativeQuick = null;
                vm.nativeAsk = null;
                vm.nativeCard = null;
                if (vm.nativeEditor && typeof vm.closeNativeEditor === 'function') vm.closeNativeEditor();
            },
            // A search result's Edit: the event itself, a repeating one as the whole series (as classic opens it).
            openEditor(event) {
                if (typeof vm.openNativeCard === 'function' && typeof root.EventCard !== 'undefined') vm.openNativeCard({ event }, true);
                else if (typeof vm.nativeEditEvent === 'function') vm.nativeEditEvent(event, null);
            },
        };
    }

    /** Syncfusion's Schedule, as app.js mountSyncfusion builds it. The bodies are what app.js did inline before. */
    function syncfusion(sch, vm) {
        return {
            kind: 'syncfusion',
            currentView() { return sch.currentView; },
            selectedDate() { return new Date(sch.selectedDate || Date.now()); },
            visibleRange() {
                // Syncfusion exposes it as getCurrentViewDates(); null means the count degrades to "all events".
                const dates = typeof sch.getCurrentViewDates === 'function' ? sch.getCurrentViewDates() : null;
                if (!dates || !dates.length) return null;
                const first = new Date(dates[0]).getTime();
                const last = new Date(dates[dates.length - 1]).getTime();
                if (isNaN(first) || isNaN(last)) return null;
                return { start: first, end: last + 86400000 }; // through the end of the last day
            },
            goTo({ date, view } = {}) {
                if (date) sch.selectedDate = new Date(date);
                if (view) sch.currentView = view;
            },
            occurrences(start, end) {
                // getEvents expands repeats from the (color-filtered) dataSource the grid draws.
                return (sch.getEvents(new Date(start), new Date(end), true) || []).map((e) => ({
                    event: stored(vm, e.Id, e.RecurrenceID) || stored(vm, e.Id, null) || stored(vm, e.RecurrenceID, null)
                        || (e._zonedOf != null ? stored(vm, e._zonedOf, null) : null),   // (an occurrence of a zoned series: ScheduleAdapter.toView)
                    start: new Date(e.StartTime), end: new Date(e.EndTime), allDay: !!e.IsAllDay, title: e.Subject || '(No title)', type: e.Type,
                }));
            },
            occursInRange(event, range) {
                // The live scheduler cannot answer this (hidden events are filtered out of its dataSource), so the
                // rule is expanded in isolation, from the same values the grid is given (ScheduleAdapter.toView):
                // an all-day series' start, UNTIL and skipped dates at the viewer's local midnight.
                const E = typeof Event === 'function' ? Event : null;   // models/Event.js (a global class, not a window property)
                if (typeof ej === 'undefined' || typeof ej.schedule.generate !== 'function') return null;
                const allDay = !!event.isAllDay;
                const ms = (v) => { const d = allDay ? E.allDayToLocal(v) : new Date(v); return d ? d.getTime() : NaN; };
                const start = ms(event.start);
                if (isNaN(start)) return true;
                const end = ms(event.end);
                const duration = isNaN(end) ? 0 : Math.max(0, end - start);
                const rule = String((allDay ? E.allDayRuleToLocal(event.recurrencerule) : event.recurrencerule) || '');
                const exceptions = (allDay ? E.allDayExceptionsToLocal(event.recurrenceException) : event.recurrenceException) || null;
                try {
                    // Same call the scheduler makes when it renders a view: begin one event length before the
                    // window, so an occurrence spilling in from the day before is caught, and cap the walk at
                    // the window's length in days.
                    const viewDate = new Date(range.start - duration);
                    const days = Math.ceil((range.end - viewDate.getTime()) / 864e5) + 1;
                    const firstDay = parseInt(vm.globalSettings && vm.globalSettings.firstDayOfWeek) || 0;
                    const dates = ej.schedule.generate(new Date(start), rule, exceptions, firstDay, days, viewDate);
                    return dates.some((d) => vm.spansRange(d, d + duration, range));
                } catch (err) {
                    return null;   // the caller estimates: over-reporting is safer than not counting
                }
            },
            render() {
                // Hand the scheduler only the events the color filter admits (one predicate, isEventVisible: #41).
                sch.setProperties({
                    eventSettings: {
                        dataSource: vm.syncFusionEvents.filter((e) => vm.isEventVisible(e)),
                        query: new ej.data.Query(),
                    },
                });
                sch.dataBind();
            },
            refreshLayout() { try { sch.refreshLayout(); } catch (e) { /* not rendered yet */ } },
            setReadOnly(on) { sch.readonly = !!on; },
            closePopups() {
                if (typeof sch.closeEditor === 'function') sch.closeEditor();
                if (typeof sch.closeQuickInfoPopup === 'function') sch.closeQuickInfoPopup();
            },
            openEditor(event) {
                const data = (sch.eventsData || []).find((e) => String(e.Id) === String(event.id) && !e.RecurrenceID);
                if (data) sch.openEditor(data, data.RecurrenceRule ? 'EditSeries' : 'Save');
            },
        };
    }

    // ---- Editing on the native calendar: its dates in the shapes classic's grid records carry (app.js nativeAction).
    // A repeat rule for a series moved from `from` to `to` (dragging "all events" to another day): the weekdays,
    // day of the month and month it names move with it. Anything else, and a move within the same day, keeps it.
    // (Read in the series' zone, `zone`: its own, or none for this browser's. Its weekdays are that zone's.)
    const EZ = () => root.EventZone || (typeof require === 'function' ? require('./EventZone.js') : null);
    function shiftRule(rule, from, to, zone = null) {
        const z = EZ().validZone(zone) || EZ().localZone();
        const a = EZ().floating(new Date(from).getTime(), z), b = EZ().floating(new Date(to).getTime(), z);
        const days = Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 864e5);
        if (!rule || !days) return rule;
        const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
        const parts = String(rule).split(';');
        const get = (k) => { const p = parts.find((x) => x.toUpperCase().startsWith(k + '=')); return p ? p.slice(k.length + 1) : null; };
        const set = (k, v) => { const i = parts.findIndex((x) => x.toUpperCase().startsWith(k + '=')); if (i >= 0) parts[i] = `${k}=${v}`; };
        const freq = (get('FREQ') || '').toUpperCase();
        const byDay = get('BYDAY');
        if (byDay) {
            const shifted = byDay.split(',').map((d) => {
                const m = /^([+-]?\d*)(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim());
                return m ? m[1] + DAYS[(DAYS.indexOf(m[2].toUpperCase()) + days % 7 + 7) % 7] : d;
            });
            set('BYDAY', shifted.join(','));
            // "The 2nd Tuesday" dragged to another week: the position of the new date in its month.
            if (get('BYSETPOS') && (freq === 'MONTHLY' || freq === 'YEARLY')) set('BYSETPOS', Math.ceil(b.getUTCDate() / 7) > 4 ? -1 : Math.ceil(b.getUTCDate() / 7));
        }
        if (get('BYMONTHDAY') && (freq === 'MONTHLY' || freq === 'YEARLY')) set('BYMONTHDAY', b.getUTCDate());
        if (get('BYMONTH') && freq === 'YEARLY') set('BYMONTH', b.getUTCMonth() + 1);
        // The end date moves with it (Tuesdays until Oct 27 dragged to Thursdays run until Oct 29), by whole days:
        // UNTIL is read as a day (through its end), so moving it by the minutes too could add an occurrence.
        const until = get('UNTIL');
        const m = until && /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(until);
        if (m) {
            const p = (k) => String(k).padStart(2, '0');
            if (!m[4]) {
                const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
                set('UNTIL', `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`);
            } else if (m[7]) {
                const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
                d.setDate(d.getDate() + days);
                set('UNTIL', d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));
            } else {
                // A floating UNTIL is a wall clock: moved as one (never through a local Date, which bends at DST).
                const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days, +m[4], +m[5], +m[6]));
                set('UNTIL', `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`);
            }
        }
        return parts.join(';');
    }
    // An end as classic's grid records carry it: an all-day end is the next local midnight (exclusive). The native grid
    // and editor send the last day's 23:59:59.999 (their display shape); that end stored as is would lose the last day.
    function endOf(end, allDay) {
        const d = new Date(end);
        if (!allDay || isNaN(d.getTime())) return d;
        if (d.getHours() || d.getMinutes() || d.getSeconds() || d.getMilliseconds()) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        return d;
    }
    // Moving `from` to `to` as wall-clock days and minutes in the series' zone (none: this browser's), applied to another
    // time (a series moved with one occurrence): across a DST change the clock time stays the same (EventZone.shiftBy).
    function shiftBy(from, to, zone = null) { return EZ().shiftBy(from, to, zone); }

    const CalendarView = { native, syncfusion, displayEvents, edits: { endOf, shiftBy, shiftRule } };
    if (typeof module !== 'undefined' && module.exports) module.exports = CalendarView;
    else root.CalendarView = CalendarView;
})(typeof window !== 'undefined' ? window : globalThis);
