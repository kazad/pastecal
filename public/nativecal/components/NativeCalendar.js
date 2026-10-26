/**
 * NativeCalendar -- pastecal's own calendar, laid out like the Syncfusion Schedule it
 * replaces, so people who use pastecal today find everything where they expect it:
 * the same toolbar (prev / next, title with chevron on the left, DAY WEEK MONTH 3 MONTHS YEAR AGENDA on
 * the right), the same month grid (full weekday names, date top-left, "Sep 1" on the
 * first, spanning bars, "+N more"), the same week/day time grid with an all-day row,
 * and the same Year and Agenda views. Reference screenshots: sync-*.png from the
 * NativeCal parity pass (Sep 2026).
 *
 * Data contract, unchanged from the prototype and shared with the Syncfusion app:
 *   props.events   stored events: { id, title, description, start, end (ISO), type,
 *                  isAllDay, recurrencerule, recurrenceID, recurrenceException }
 *   emits          'event-click'  { event, occurrence, jsEvent }
 *                  'event-create' { start, end, isAllDay, event: jsEvent, full }
 *                  'update:events' (new array) -- after a drag or resize
 *
 * All-day events are read the way the ICS feed reads them: the stored instant is
 * rounded to the NEAREST midnight, so both local-midnight values (what Syncfusion
 * writes) and UTC-midnight values land on the day the user picked, in any zone from
 * UTC-11 to UTC+12. The end is exclusive, as RFC 5545 and Syncfusion have it.
 *
 * Recurrence is expanded in "floating" local time (rrule sees local wall-clock fields
 * as if they were UTC), so a 9:00 weekly event stays at 9:00 across a DST change.
 * Deleted or edited occurrences are excluded via recurrenceException (EXDATE, UTC
 * stamps, comma-separated); an edited occurrence is its own row with recurrenceID.
 */
const NativeCalendar = (() => {
    const DAY_MS = 86400000;
    const HOUR_PX = 48;                 // Syncfusion: two 24px slots per hour
    // Hours on the clock face (0-24) of a time within one day; `dayEnd` (next midnight) reads as 24.
    const wallHours = (t, dayEnd) => (dayEnd && t >= dayEnd) ? 24 : t.getHours() + t.getMinutes() / 60 + t.getSeconds() / 3600;
    const MONTH_ROW_PX = 100;           // fixed month row height, like Syncfusion
    const BAR_PX = 20, BAR_GAP = 2, DATE_HEADER_PX = 26;
    // 'Custom' is Syncfusion's "N Months" / "N Weeks" view (customDuration / customUnit props).
    const VIEWS = ['Day', 'Week', 'Month', 'Custom', 'Year', 'Agenda'];
    // A view name from a setting or a link: 'week', 'Custom', '3 Months', '4 weeks', 'q', ...
    const normView = (v) => {
        const s = String(v || '').trim().toLowerCase();
        if (!s) return null;
        if (/^\d+\s*(week|month)s?$/.test(s) || s === 'custom' || s === 'c' || s === 'q' || s === 'quarter') return 'Custom';
        return { day: 'Day', d: 'Day', week: 'Week', w: 'Week', month: 'Month', m: 'Month', year: 'Year', y: 'Year', agenda: 'Agenda', a: 'Agenda' }[s] || null;
    };
    // 'YYYY-MM-DD' as a LOCAL date (new Date('2026-10-29') would be UTC midnight, the day before in the Americas).
    const parseDay = (v) => {
        if (!v) return null;
        if (v instanceof Date) return isNaN(v) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
        const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v));
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
        const d = new Date(v); return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
    };
    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    // ---- dates -------------------------------------------------------------------------
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
    const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const startOfWeek = (d, first) => { const s = startOfDay(d); return addDays(s, -((s.getDay() - first + 7) % 7)); };
    const dayIndex = (d) => Math.round((startOfDay(d) - new Date(1970, 0, 1)) / DAY_MS); // DST-proof day number
    const pad = (n) => String(n).padStart(2, '0');
    const fmtTime = (d, fmt) => {
        if (fmt === '24') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const h = d.getHours() % 12 || 12;
        return `${pad(h)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
    };
    // The stored instant -> the calendar day it stands for (see header). The display shape both apps hand in
    // (Event.allDayDisplayRange: local midnight of the first day .. local 23:59:59.999 of the last) is read as
    // local dates, so it lands right in every zone, UTC+13 too (where rounding put local midnight a day early).
    const allDayDate = (v) => {
        const d = new Date(v);
        if (!isNaN(d)) {
            const ms = d.getMilliseconds(), s = d.getSeconds(), m = d.getMinutes(), h = d.getHours();
            if (!h && !m && !s && !ms) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
            if (h === 23 && m === 59 && s === 59 && ms === 999) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        }
        const r = new Date(d.getTime() + 12 * 3600000); return new Date(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate());
    };
    const toFloating = (d) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
    const fromFloating = (u) => new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
    const ymdKey = (y, m, d) => `${y}${pad(m + 1)}${pad(d)}`;
    // The DATE an all-day series' skipped-date stamp names, as 'YYYYMMDD' (or null): the same reading as
    // Event.allDayStampDate and Syncfusion's (ScheduleAdapter.toView). Stamps are written as the WRITER's local
    // midnight ("20261012T150000Z" is Tokyo's Oct 13), so comparing them raw with this viewer's occurrence
    // instants brought a date skipped in Tokyo back in Los Angeles (finding D2). A floating stamp (no Z) is
    // already a wall-clock date. Rounding the instant to its date also reads a stamp the app has already
    // moved to this viewer's midnight (CalendarView.displayEvents), so both inputs give the same answer.
    const allDayStampKey = (s) => {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(String(s).trim());
        if (!m) return null;
        if (!m[4] || !m[7]) return m[1] + m[2] + m[3];
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        // floor((ms + 13h + 1s) / day): a writer's local midnight, from just east of UTC-11 to UTC+13 (models/Event.js)
        const d = new Date(Math.floor((ms + 13 * 3600000 + 1000) / DAY_MS) * DAY_MS);
        return ymdKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    };

    // The local day ('YYYYMMDD') a timed series' skipped-date stamp names in this browser: a UTC stamp at its local
    // instant, a floating one (no Z) or a bare date as written.
    const localStampDay = (s) => {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(String(s).trim());
        if (!m) return null;
        if (!m[4] || !m[7]) return m[1] + m[2] + m[3];
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
        return ymdKey(d.getFullYear(), d.getMonth(), d.getDate());
    };

    // ---- events -> occurrences ---------------------------------------------------------
    function isLong(o) { return o.allDay || (o.end - o.start) >= DAY_MS; }

    const MAX_OCCURRENCES = 2000;
    const warnedRules = new Set();
    function occurrencesBetween(events, rangeStart, rangeEnd) {
        const out = [];
        const RR = window.rrule || {};
        for (const ev of events || []) {
            if (!ev || !ev.start || !ev.end) continue;
            const allDay = !!ev.isAllDay;
            let start = allDay ? allDayDate(ev.start) : new Date(ev.start);
            let end = allDay ? allDayDate(ev.end) : new Date(ev.end);
            if (isNaN(start) || isNaN(end)) continue;
            if (allDay && end <= start) end = addDays(start, 1);
            const duration = end - start;
            const base = { event: ev, allDay, type: ev.type || 1, title: ev.title || '(No title)' };

            // An edited occurrence is its own row: recurrenceID points at the series and it
            // CARRIES A COPY of the series' rule (that is how Syncfusion stores it). Expanding
            // it would draw a second series; it is one event, at its own time.
            // A rule too big to expand (FREQ=SECONDLY was 3.6 million occurrences in a month: frozen,
            // then out of memory) is shown once, unrepeated, so the calendar loads and it can be deleted.
            const unsafe = ev.recurrencerule && window.EventStore && EventStore.unsafeRecurrence
                ? EventStore.unsafeRecurrence(ev.recurrencerule) : null;
            if (unsafe && !warnedRules.has(ev.id)) { warnedRules.add(ev.id); console.warn(`[pastecal] event ${ev.id}: ${unsafe}; shown once, not repeated`); }
            if (ev.recurrencerule && !ev.recurrenceID && RR.RRule && !unsafe) {
                const stamps = String(ev.recurrenceException || '').split(',').map(s => s.trim()).filter(Boolean);
                // Timed: the stamp's LOCAL date, as Syncfusion (classic) matches it: it parses each stamp and skips
                // the occurrence on that local day. To the minute, a date deleted in Los Angeles came back for a
                // viewer whose clocks don't change with it (Phoenix: an hour apart after Nov 1). All-day: the date
                // (see allDayStampKey).
                const excluded = new Set(allDay ? stamps.map(allDayStampKey).filter(Boolean) : stamps.map(localStampDay).filter(Boolean));
                let rule;
                try {
                    const clean = String(ev.recurrencerule).replace(/^RRULE:/i, '').split(';').filter(p => p.includes('=')).join(';');
                    const opts = RR.RRule.parseString(clean);
                    // UNTIL, read exactly as Syncfusion reads it: the UTC stamp names a LOCAL
                    // day, and the series runs through the end of that day (its parser sets
                    // 23:59:59). Moved into the floating frame the expansion runs in.
                    if (opts.until) { const u = opts.until; opts.until = toFloating(new Date(u.getFullYear(), u.getMonth(), u.getDate(), 23, 59, 59)); }
                    rule = new RR.RRule({ ...opts, dtstart: toFloating(start) });
                } catch (e) { rule = null; }
                if (rule) {
                    const from = toFloating(new Date(rangeStart.getTime() - duration)), to = toFloating(rangeEnd);
                    // At most MAX_OCCURRENCES per event per view (an HOURLY series is 8,760 a year).
                    for (const f of rule.between(from, to, true, (d, i) => i < MAX_OCCURRENCES)) {
                        const s = fromFloating(f);
                        if (excluded.has(ymdKey(s.getFullYear(), s.getMonth(), s.getDate()))) continue;
                        out.push({ ...base, start: s, end: new Date(s.getTime() + duration), recurring: true, key: `${ev.id}@${s.getTime()}` });
                    }
                    continue;
                }
            }
            if (end > rangeStart && start < rangeEnd) {
                out.push({ ...base, start, end, recurring: !!ev.recurrenceID, key: `${ev.id}|${ev.recurrenceID || ''}` });
            }
        }
        return out.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
    }

    // Place bars for one week row: [{occ, col, span, lane}], lanes first-fit.
    function layoutWeekBars(occs, weekStart, cols) {
        const bars = []; const laneEnds = [];
        const w0 = dayIndex(weekStart);
        for (const o of occs) {
            const lastDay = o.allDay ? dayIndex(o.end) - 1 : dayIndex(new Date(o.end.getTime() - 1));
            const s = Math.max(0, dayIndex(o.start) - w0), e = Math.min(cols - 1, lastDay - w0);
            if (e < 0 || s > cols - 1 || e < s) continue;
            let lane = 0; while (laneEnds[lane] !== undefined && laneEnds[lane] >= s) lane++;
            laneEnds[lane] = e;
            bars.push({ occ: o, col: s, span: e - s + 1, lane, clippedLeft: dayIndex(o.start) - w0 < 0, clippedRight: lastDay - w0 > cols - 1 });
        }
        return bars;
    }

    // Side-by-side columns for overlapping timed events in one day.
    function layoutDayColumns(items) {
        const groups = []; let group = [], groupEnd = -Infinity;
        for (const it of items.sort((a, b) => a.top - b.top || b.height - a.height)) {
            if (it.top >= groupEnd && group.length) { groups.push(group); group = []; }
            group.push(it); groupEnd = Math.max(groupEnd, it.top + it.height);
        }
        if (group.length) groups.push(group);
        for (const g of groups) {
            const colEnds = [];
            for (const it of g) { let c = 0; while (colEnds[c] !== undefined && colEnds[c] > it.top) c++; colEnds[c] = it.top + it.height; it.col = c; }
            for (const it of g) it.cols = colEnds.length;
        }
        return items;
    }

    const component = {
        name: 'NativeCalendar',
        props: {
            events: { type: Array, default: () => [] },
            timeFormat: { type: String, default: '12' },
            creatingEvent: { type: Object, default: null },
            colors: { type: Array, default: () => [] },
            firstDayOfWeek: { type: [Number, String], default: 0 },
            startHour: { type: String, default: '05:00' },
            readOnly: { type: Boolean, default: false },
            initialView: { type: String, default: 'Month' },
            // Color filter (the search panel's dots): color slots (0-based) whose events are hidden.
            hiddenSlots: { type: Array, default: () => [] },
            initialDate: { type: [String, Date], default: null },
            customDuration: { type: [Number, String], default: 3 },
            customUnit: { type: String, default: 'Months' },
            // The main app's view links: a click on a month day opens that day (there is nothing to create).
            openDayOnClick: { type: Boolean, default: false },
            // The main app's look (its calendar today): view names as written ("Month"), times without a leading
            // zero ("5:30 PM"), and event text dark or white by contrast with the event color (textOn).
            appLook: { type: Boolean, default: false },
            textOn: { type: Function, default: null },
            // Month rows taller than the 100px default (the main app fills a wide window with the month, as before).
            monthRowHeight: { type: Number, default: MONTH_ROW_PX },
            // The main app's edit links: drag to create in every look (a duration on the time grid, a run of days
            // on the month grid and the all-day row), drag and resize a repeating occurrence too (the app asks
            // "this event / all events"), long-press to drag on a touch screen. A drop goes out as 'event-move'
            // for the app to save, never as a rewritten list.
            appEdits: { type: Boolean, default: false },
            // The event being added while the quick box is open, { start, end, isAllDay, title } (display shape, as
            // 'event-create' sends it): drawn on the grid as a "New event" block whose label follows the title.
            draft: { type: Object, default: null },
        },
        // 'range-change' { view, date, start, end }: whenever the dates on screen change (view or navigation).
        // 'drag-start' { event, occurrence }: a drag or resize of an event began (appEdits).
        // 'event-move' { event, occurrence, start, end, allDay, mode }: an event was dropped or resized (appEdits).
        //     start/end are Dates; an all-day end is exclusive (the next local midnight).
        // 'event-open' { event, occurrence }: an event was double-clicked (appEdits: the app opens its editor, as classic does).
        emits: ['update:events', 'event-click', 'event-create', 'view-change', 'range-change', 'drag-start', 'event-move', 'event-open'],
        data() {
            return {
                view: normView(this.initialView) || 'Month',
                date: parseDay(this.initialDate) || startOfDay(new Date()),
                now: new Date(),
                pickerOpen: false, pickerYear: new Date().getFullYear(),
                showEarlyHours: false,
                viewMenu: false,
                selectedCell: null,
                drag: null,
                isPhone: typeof window !== 'undefined' && window.innerWidth < 768,
                v2: typeof NcUx !== 'undefined' && NcUx.v2(),
            };
        },
        computed: {
            palette() {
                return (this.colors && this.colors.length) ? this.colors
                    : ['#3f51b5', '#e3165b', '#d0442f', '#2e7d32', '#ff9800', '#03a9f4', '#757575', '#27282f'];
            },
            first() { return Number(this.firstDayOfWeek) || 0; },
            weekdayOrder() { return [0, 1, 2, 3, 4, 5, 6].map(i => (i + this.first) % 7); },
            views() { return VIEWS; },
            // What is drawn: the events minus the filtered-out colors. Drags still edit `events`,
            // so a hidden event is never dropped from the list the grid hands back.
            shownEvents() {
                let list = this.events;
                if (this.hiddenSlots.length) {
                    const n = this.palette.length;
                    const slot = (e) => { const t = parseInt(e.type || 1, 10); return Number.isFinite(t) && t >= 1 && t <= n ? t - 1 : 0; };
                    list = list.filter(e => !this.hiddenSlots.includes(slot(e)));
                }
                const d = this.draft;
                if (d && d.start && d.end) list = [...list, { id: '__draft', __draft: true, title: (d.title || '').trim() || 'New event',
                    start: d.start, end: d.end, isAllDay: !!d.isAllDay, type: d.type || 1 }];
                return list;
            },
            customN() { const n = parseInt(this.customDuration, 10); const max = this.customWeeks ? 52 : 24; return n >= 1 ? Math.min(n, max) : 3; },
            customWeeks() { return /^week/i.test(String(this.customUnit || '')); },
            customLabel() { return `${this.customN} ${this.customWeeks ? 'Week' : 'Month'}${this.customN === 1 ? '' : 's'}`; },
            // Changes whenever the dates on screen do (watched: 'range-change').
            rangeKey() { return `${this.view}|${this.date.getTime()}|${this.first}|${this.customN}|${this.customWeeks}`; },
            title() {
                const d = this.date, M = MONTHS[d.getMonth()];
                if (this.view === 'Day') return `${M} ${d.getDate()}, ${d.getFullYear()}`;
                if (this.view === 'Week' || this.view === 'Agenda') {
                    const s = this.view === 'Week' ? startOfWeek(d, this.first) : d; const e = addDays(s, 6);
                    if (s.getFullYear() !== e.getFullYear()) return `${MONTHS[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()} - ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
                    if (s.getMonth() !== e.getMonth()) return `${MONTHS[s.getMonth()]} ${s.getDate()} - ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
                    return `${MONTHS[s.getMonth()]} ${s.getDate()} - ${e.getDate()}, ${e.getFullYear()}`;
                }
                if (this.view === 'Custom' && this.customWeeks) {
                    const s = startOfWeek(d, this.first), e = addDays(s, 7 * this.customN - 1);
                    if (s.getFullYear() !== e.getFullYear()) return `${MONTHS[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()} - ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
                    return `${MONTHS[s.getMonth()]} ${s.getDate()} - ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
                }
                if (this.view === 'Custom') {
                    if (this.customN === 1) return `${M} ${d.getFullYear()}`;
                    const e = addMonths(d, this.customN - 1);
                    return e.getFullYear() === d.getFullYear() ? `${M} - ${MONTHS[e.getMonth()]} ${e.getFullYear()}` : `${M} ${d.getFullYear()} - ${MONTHS[e.getMonth()]} ${e.getFullYear()}`;
                }
                if (this.view === 'Year') return String(d.getFullYear());
                return `${M} ${d.getFullYear()}`;
            },
            // ---- month / 3 months --------------------------------------------------------
            monthWeeks() {
                if (this.view !== 'Month' && this.view !== 'Custom') return [];
                const byWeeks = this.view === 'Custom' && this.customWeeks;
                // N weeks: one continuous grid from the week holding the date. N months: whole months.
                const m0 = byWeeks ? startOfWeek(this.date, this.first) : new Date(this.date.getFullYear(), this.date.getMonth(), 1);
                const mEnd = byWeeks ? addDays(m0, 7 * this.customN) : addMonths(m0, this.view === 'Month' ? 1 : this.customN);
                const weeks = [];
                for (let ws = startOfWeek(m0, this.first); ws < mEnd; ws = addDays(ws, 7)) {
                    const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i));
                    const occs = occurrencesBetween(this.shownEvents, ws, addDays(ws, 7));
                    const bars = layoutWeekBars(occs, ws, 7);
                    const maxLanes = Math.floor((Math.max(MONTH_ROW_PX, this.monthRowHeight) - DATE_HEADER_PX - 16) / (BAR_PX + BAR_GAP));
                    const hidden = [0, 0, 0, 0, 0, 0, 0];
                    for (const b of bars) if (b.lane >= maxLanes) for (let c = b.col; c < b.col + b.span; c++) hidden[c]++;
                    weeks.push({ key: ws.getTime(), start: ws, days, bars: bars.filter(b => b.lane < maxLanes), hidden,
                        inMonth: (d) => this.view === 'Month' ? d.getMonth() === this.date.getMonth() : (d >= m0 && d < mEnd) });
                }
                return weeks;
            },
            // ---- week / day --------------------------------------------------------------
            gridDays() {
                if (this.view === 'Day') return [this.date];
                if (this.view === 'Week') { const s = startOfWeek(this.date, this.first); return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(s, i)); }
                return [];
            },
            firstHour() { const h = parseInt(this.startHour, 10); return this.showEarlyHours || isNaN(h) ? 0 : Math.max(0, Math.min(h, 12)); },
            hours() { const r = []; for (let h = this.firstHour; h < 24; h++) r.push(h); return r; },
            gridLayout() {
                const days = this.gridDays; if (!days.length) return { allDay: [], timed: [], allDayLanes: 0 };
                const s = days[0], e = addDays(days[days.length - 1], 1);
                const occs = occurrencesBetween(this.shownEvents, s, e);
                const allDayBars = layoutWeekBars(occs.filter(isLong), s, days.length);
                const timed = days.map(day => {
                    const dayEnd = addDays(day, 1); const items = [];
                    for (const o of occs) {
                        if (isLong(o) || o.end <= day || o.start >= dayEnd) continue;
                        // Wall-clock hours, not elapsed time since midnight: on a DST day midnight to
                        // 10:00 is 9 or 11 hours, and the event would sit an hour off its label.
                        const a = wallHours(new Date(Math.max(o.start, day)), dayEnd), b = wallHours(new Date(Math.min(o.end, dayEnd)), dayEnd);
                        const top = (a - this.firstHour) * HOUR_PX;
                        const height = Math.max((b - a) * HOUR_PX, 18);
                        if (top + height <= 0) continue;
                        items.push({ occ: o, top: Math.max(top, 0), height: top < 0 ? height + top : height });
                    }
                    return layoutDayColumns(items);
                });
                return { allDay: allDayBars, timed, allDayLanes: allDayBars.reduce((m, b) => Math.max(m, b.lane + 1), 0) };
            },
            nowTop() { return (wallHours(this.now) - this.firstHour) * HOUR_PX; },
            // ---- year --------------------------------------------------------------------
            yearMonths() {
                if (this.view !== 'Year') return [];
                const y = this.date.getFullYear();
                const occs = occurrencesBetween(this.shownEvents, new Date(y, 0, 1), new Date(y + 1, 0, 8));
                const marks = new Map();
                for (const o of occs) {
                    const last = o.allDay ? addDays(o.end, -1) : new Date(o.end.getTime() - 1);
                    for (let d = startOfDay(o.start); d <= last && marks.size < 5000; d = addDays(d, 1)) if (!marks.has(dayIndex(d))) marks.set(dayIndex(d), this.color(o.type));
                }
                return MONTHS.map((name, m) => {
                    const first = new Date(y, m, 1); const ws = startOfWeek(first, this.first);
                    const cells = []; for (let i = 0; i < 42; i++) { const d = addDays(ws, i); cells.push({ d, key: i, out: d.getMonth() !== m, mark: marks.get(dayIndex(d)) }); }
                    return { name: `${name} ${y}`, cells };
                });
            },
            // ---- agenda ------------------------------------------------------------------
            agendaDays() {
                if (this.view !== 'Agenda') return [];
                const s = this.date, e = addDays(s, 7);
                const occs = occurrencesBetween(this.shownEvents, s, e);
                const days = [];
                for (let d = s; d < e; d = addDays(d, 1)) {
                    const next = addDays(d, 1);
                    const items = occs.filter(o => {
                        const last = o.allDay ? addDays(o.end, -1) : new Date(o.end.getTime() - 1);
                        return startOfDay(o.start) <= d && d <= startOfDay(last);
                    }).map(o => {
                        const total = dayIndex(o.allDay ? addDays(o.end, -1) : new Date(o.end.getTime() - 1)) - dayIndex(o.start) + 1;
                        const nth = dayIndex(d) - dayIndex(o.start) + 1;
                        let when;
                        if (o.allDay) when = total > 1 ? `All day (Day ${nth}/${total})` : 'All day';
                        else if (total > 1) {
                            const a = nth === 1 ? o.start : d, b = nth === total ? o.end : next;
                            when = `${this.time(a)} - ${this.time(b)} (Day ${nth}/${total})`;
                        } else when = `${this.time(o.start)} - ${this.time(o.end)}`;
                        return { occ: o, when, key: o.key + '#' + d.getTime() };
                    });
                    if (items.length) days.push({ d, items, key: d.getTime() });
                }
                return days;
            },
        },
        watch: {
            view(v) { this.$emit('view-change', { view: v, date: this.date }); },
            rangeKey() { this.$emit('range-change', { view: this.view, date: this.date, ...this.visibleRange() }); },
            // The app's default view (settings, or the calendar's own default once it has loaded).
            initialView(v) { const n = normView(v); if (n && n !== this.view) this.setView(n); },
            initialDate(v) { const d = parseDay(v); if (d) this.date = d; },
            appEdits(on) { if (this._touchOn) this._touchOn(on && !this.readOnly); },
            readOnly(ro) { if (this._touchOn) this._touchOn(this.appEdits && !ro); if (ro) this.drag = null; },
        },
        mounted() {
            this._tick = setInterval(() => { this.now = new Date(); }, 60000);
            this._onResize = () => { this.isPhone = window.innerWidth < 768; };
            window.addEventListener('resize', this._onResize);
            this._onMove = (e) => this.onDragMove(e);
            this._onUp = (e) => this.onDragEnd(e);
            window.addEventListener('mousemove', this._onMove);
            window.addEventListener('mouseup', this._onUp);
            // Touch: a long press lifts an event (appEdits); moving the finger first is a scroll and cancels it.
            // Only a lifted drag stops the page from scrolling, so the touchmove listener cannot be passive: it is
            // added only where events can be dragged (never on a view link, where it would hold up every scroll),
            // and on the calendar itself (a touch's events go to where it started, even once the finger leaves).
            this._onTouchMove = (e) => this.onTouchMove(e);
            this._onTouchEnd = (e) => this.onTouchEnd(e);
            this._touchOn = (on) => {
                const el = this.$el;
                if (!el || !!this._touching === on) return;
                this._touching = on;
                const how = on ? 'addEventListener' : 'removeEventListener';
                el[how]('touchmove', this._onTouchMove, { passive: false });
                el[how]('touchend', this._onTouchEnd);
                el[how]('touchcancel', this._onTouchEnd);
            };
            this._touchOn(this.appEdits && !this.readOnly);
            // Escape drops a drag where it started (and the click that ends it does nothing).
            this._onKey = (e) => { if (e.key === 'Escape' && this.drag) { e.stopPropagation(); e.preventDefault(); this.cancelDrag(); } };
            window.addEventListener('keydown', this._onKey, true);
            this._onDocClick = (e) => { if (this.pickerOpen && !e.target.closest('.nc-picker, .nc-title')) this.pickerOpen = false; };
            document.addEventListener('mousedown', this._onDocClick);
            this.$nextTick(() => this.scrollToWorkHours());
            this.$emit('range-change', { view: this.view, date: this.date, ...this.visibleRange() });
        },
        beforeUnmount() {
            clearInterval(this._tick);
            window.removeEventListener('resize', this._onResize);
            window.removeEventListener('mousemove', this._onMove);
            window.removeEventListener('mouseup', this._onUp);
            this._touchOn(false);
            window.removeEventListener('keydown', this._onKey, true);
            clearTimeout(this._press);
            document.removeEventListener('mousedown', this._onDocClick);
        },
        methods: {
            // ---- navigation --------------------------------------------------------------
            setView(v) { this.view = normView(v) || v; this.pickerOpen = false; this.$nextTick(() => this.scrollToWorkHours()); },
            step(dir) {
                const d = this.date;
                if (this.view === 'Day') this.date = addDays(d, dir);
                else if (this.view === 'Week' || this.view === 'Agenda') this.date = addDays(d, 7 * dir);
                else if (this.view === 'Month') this.date = new Date(d.getFullYear(), d.getMonth() + dir, Math.min(d.getDate(), 28));
                else if (this.view === 'Custom' && this.customWeeks) this.date = addDays(d, 7 * this.customN * dir);
                else if (this.view === 'Custom') this.date = new Date(d.getFullYear(), d.getMonth() + this.customN * dir, 1);
                else if (this.view === 'Year') this.date = new Date(d.getFullYear() + dir, d.getMonth(), 1);
            },
            // What a screen reader says for an event, as the main app's grid does:
            // "Team standup, Monday, October 12, 9:00 AM to 10:00 AM" (dates in the browser's language).
            ariaLabel(o) {
                const day = (d) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
                const title = o.title || '(No title)';
                if (o.allDay) {
                    const last = addDays(o.end, -1);
                    return dayIndex(last) > dayIndex(o.start) ? `${title}, ${day(o.start)} to ${day(last)}, all day` : `${title}, ${day(o.start)}, all day`;
                }
                const sameDay = dayIndex(o.start) === dayIndex(new Date(o.end.getTime() - 1));
                return sameDay ? `${title}, ${day(o.start)}, ${this.time(o.start)} to ${this.time(o.end)}`
                    : `${title}, ${day(o.start)} ${this.time(o.start)} to ${day(o.end)} ${this.time(o.end)}`;
            },
            viewLabel(v) { return v === 'Custom' ? this.customLabel : v; },
            // The dates on screen, epoch ms, end exclusive: whole weeks for the month grids.
            visibleRange() {
                const d = this.date, v = this.view;
                let s, e;
                if (v === 'Day') { s = startOfDay(d); e = addDays(s, 1); }
                else if (v === 'Week') { s = startOfWeek(d, this.first); e = addDays(s, 7); }
                else if (v === 'Agenda') { s = startOfDay(d); e = addDays(s, 7); }
                else if (v === 'Year') { s = new Date(d.getFullYear(), 0, 1); e = new Date(d.getFullYear() + 1, 0, 1); }
                else {
                    const byWeeks = v === 'Custom' && this.customWeeks;
                    const m0 = byWeeks ? startOfWeek(d, this.first) : new Date(d.getFullYear(), d.getMonth(), 1);
                    const mEnd = byWeeks ? addDays(m0, 7 * this.customN) : addMonths(m0, v === 'Month' ? 1 : this.customN);
                    s = startOfWeek(m0, this.first); e = s;
                    while (e < mEnd) e = addDays(e, 7);
                }
                return { start: s.getTime(), end: e.getTime() };
            },
            goToday() { this.date = startOfDay(new Date()); this.pickerOpen = false; },
            togglePicker() { this.pickerOpen = !this.pickerOpen; this.pickerYear = this.date.getFullYear(); },
            pickMonth(m) { this.date = new Date(this.pickerYear, m, 1); this.pickerOpen = false; },
            openDay(d) { this.date = startOfDay(d); this.setView('Day'); },
            scrollToWorkHours() {
                const el = this.$refs.timeScroll; if (!el) return;
                // Open at the configured start hour, as Syncfusion does.
                el.scrollTop = 0;
            },
            // ---- rendering helpers -------------------------------------------------------
            color(type) { const p = this.palette; return p[((Number(type) || 1) - 1) % p.length] || p[0]; },
            isToday(d) { return sameDay(d, this.now); },
            isWeekend(d) { return d.getDay() === 0 || d.getDay() === 6; },
            dayLabel(d, inMonth) { return d.getDate() === 1 ? `${MONTHS[d.getMonth()].slice(0, 3)} 1` : String(d.getDate()); },
            weekdayName(i, short) { const n = WEEKDAYS[i]; return short ? n.slice(0, 3) : n; },
            // v2 drops the leading zero ("9:00 AM", and "5 AM" on the hour gutter).
            time(d) { const t = fmtTime(d, this.timeFormat); return (this.v2 || this.appLook) && this.timeFormat !== '24' ? t.replace(/^0/, '') : t; },
            nowLabel() { const t = this.time(this.now); return this.appLook && this.isPhone && this.timeFormat !== '24' ? t.replace(/ ([AP])M$/, (m, x) => x.toLowerCase()) : t; },
            hourLabel(h) {
                // The main app on a phone: compact labels ("5a", "12p", or "17"), as its classic grid draws them there.
                if (this.appLook && this.isPhone) return this.timeFormat === '24' ? String(h) : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
                if (this.v2 && this.timeFormat !== '24') return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
                if (this.appLook && this.timeFormat !== '24') return fmtTime(new Date(2000, 0, 1, h), this.timeFormat).replace(/^0/, '');
                return fmtTime(new Date(2000, 0, 1, h), this.timeFormat);
            },
            // The main app (textOn): its calendar paints event text dark or white by contrast with the event
            // color (ScheduleAdapter.onColor), so a category looks the same here as there. Nothing otherwise.
            ink(type) { return this.textOn && !this.v2 ? { color: this.textOn(this.color(type)) } : null; },
            earlyLabel() { if (this.appLook) return 'Earlier'; const h = parseInt(this.startHour, 10); return this.timeFormat === '24' ? `00-${pad(h - 1)}` : `12-${(h - 1) % 12 || 12} AM`; },
            // People plan by color ("the orange ones are soccer"), so events are blocks of
            // their color with WHITE text, exactly as in the main app -- a category must look
            // the same in both (Sep 26: picking black text for contrast made coral events
            // look unlike the main app's). v2 light mode draws timed events as a pale tint
            // with dark text instead (the .tint class), where white would be unreadable.
            paint(type, tint) {
                const c = this.color(type);
                if (!this.v2) return { background: c };
                return tint ? { '--c': c, '--on': '#fff' } : { background: c, color: '#fff' };
            },
            isTint(b) { return this.v2 && !(b.occ.allDay || this.isMultiDayTimed(b.occ)); },
            barStyle(b) {
                return { left: `calc(${(b.col / 7) * 100}% + 2px)`, width: `calc(${(b.span / 7) * 100}% - 4px)`,
                    top: `${DATE_HEADER_PX + b.lane * (BAR_PX + BAR_GAP)}px`, ...this.paint(b.occ.type, this.isTint(b)), ...this.ink(b.occ.type) };
            },
            gridBarStyle(b, cols) {
                return { left: `calc(${(b.col / cols) * 100}% + 2px)`, width: `calc(${(b.span / cols) * 100}% - 4px)`,
                    top: `${4 + b.lane * (BAR_PX + BAR_GAP)}px`, ...this.paint(b.occ.type), ...this.ink(b.occ.type) };
            },
            timedStyle(it) {
                const w = 100 / it.cols;
                const dragging = this.drag && this.drag.moved && this.drag.key === it.occ.key;
                return { top: `${dragging ? this.drag.top : it.top}px`, height: `${dragging ? this.drag.height : it.height}px`,
                    left: `calc(${it.col * w}% + 1px)`, width: `calc(${w}% - 3px)`,
                    ...this.paint(it.occ.type, true), ...this.ink(it.occ.type),
                    opacity: dragging ? 0.85 : 1, zIndex: dragging ? 5 : 1 };
            },
            // Crosses midnight at all -- Syncfusion draws even a 10pm-2am flight as a
            // spanning bar with a time at each end.
            isMultiDayTimed(o) { return !o.allDay && dayIndex(o.start) !== dayIndex(new Date(o.end.getTime() - 1)); },
            // The test id of an event on the grid; the "New event" block has its own.
            tid(o) { return o.event.__draft ? 'draft-block' : 'event-' + o.event.id; },
            // The day cell under a point (the month grid's, the all-day row's or a time column: `sel`), by geometry,
            // since an event bar can sit over the cell.
            dayAt(x, y, sel) {
                for (const c of this.$el.querySelectorAll(sel)) {
                    const r = c.getBoundingClientRect();
                    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return new Date(Number(c.dataset.day));
                }
                return null;
            },
            // A run of days being dragged out for a new all-day event (month grid, all-day row).
            inDayRun(d) {
                const g = this.drag;
                if (!g || g.mode !== 'days' || !g.moved) return false;
                const a = Math.min(g.day0.getTime(), g.day1.getTime()), b = Math.max(g.day0.getTime(), g.day1.getTime());
                return d.getTime() >= a && d.getTime() <= b;
            },
            isDropDay(d) { const g = this.drag; return !!(g && g.mode === 'month' && g.moved && g.targetDay && sameDay(g.targetDay, d)); },
            isLifted(o) { const g = this.drag; return !!(g && g.moved && g.key === o.key); },
            // ---- clicks ------------------------------------------------------------------
            clickEvent(occ, jsEvent) {
                if ((this.drag && this.drag.moved) || this._swallowClick || occ.event.__draft) return;
                this.selectedCell = null;
                this.$emit('event-click', { event: occ.event, occurrence: { start: occ.start, end: occ.end, recurring: occ.recurring }, jsEvent });
            },
            openEvent(occ) {
                if (!this.appEdits || this.readOnly || occ.event.__draft || this._swallowClick) return;
                this.$emit('event-open', { event: occ.event, occurrence: { start: occ.start, end: occ.end, recurring: occ.recurring } });
            },
            clickCell(day, jsEvent, hour, full) {
                if (this._swallowClick || this._afterCreateDrag) return;
                if (this.readOnly && this.openDayOnClick && hour === undefined && (this.view === 'Month' || this.view === 'Custom')) { this.openDay(day); return; }
                if (this.readOnly) return;
                this.selectedCell = (hour === undefined ? 'd' : 'h' + hour) + day.getTime();
                let start, end, isAllDay;
                if (hour === undefined) { start = startOfDay(day); end = new Date(addDays(start, 1).getTime() - 1); isAllDay = true; }   // display shape: through 23:59:59.999 (app.js toStoredEvent stores it)
                else {
                    // v1: Syncfusion's 30-minute slot. v2: an hour, the length most events are.
                    start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(hour), (hour % 1) * 60);
                    end = new Date(start.getTime() + (this.v2 || this.appEdits ? 3600000 : 1800000)); isAllDay = false;
                }
                // Same storage as Syncfusion: all-day is LOCAL midnight, end exclusive.
                this.$emit('event-create', { start: start.toISOString(), end: end.toISOString(), isAllDay, event: jsEvent, full: !!full });
            },
            clickSlot(day, jsEvent, full) {
                if (this._afterCreateDrag || this._swallowClick) return;   // the click that ends a drag-to-create (or an Escaped drag)
                const rect = jsEvent.currentTarget.getBoundingClientRect();
                const hour = this.firstHour + Math.floor(((jsEvent.clientY - rect.top) / HOUR_PX) * 2) / 2;
                this.clickCell(day, jsEvent, hour, full);
            },
            // ---- drag to create (v2; Week/Day, mouse) --------------------------------------
            // Press on an empty slot and drag: the range becomes the new event's start and
            // end in one gesture, snapped to 15 minutes (Google, Apple). A press without a
            // drag stays an ordinary click.
            startCreate(e, day) {
                if (!(this.v2 || this.appEdits) || this.readOnly || this.isPhone || e.button !== 0 || e.target.closest('.nc-timed')) return;
                const rect = e.currentTarget.getBoundingClientRect(), q = HOUR_PX / 4;
                const y = Math.max(0, Math.floor((e.clientY - rect.top) / q) * q);
                this.drag = { mode: 'create', day, x0: e.clientX, y0: e.clientY, rectTop: rect.top, top0: y, top: y, height: q, moved: false };
            },
            createRange(d) {
                const mins = (px) => this.firstHour * 60 + Math.round(px / HOUR_PX * 60);
                const at = (m) => new Date(d.day.getFullYear(), d.day.getMonth(), d.day.getDate(), 0, m);
                return { start: at(mins(d.top)), end: at(mins(d.top + d.height)) };
            },
            createLabel() { const r = this.createRange(this.drag); return `${this.time(r.start)} - ${this.time(r.end)}`; },
            // Month grid and all-day row (appEdits): press on a day and drag across others for a multi-day all-day event.
            startDayCreate(e, day) {
                if (!this.appEdits || this.readOnly || this.isPhone || e.button !== 0 || e.target.closest('.nc-bar, .nc-date, .nc-more')) return;
                const sel = e.currentTarget.classList.contains('nc-allday-cell') ? '.nc-allday-cell' : '.nc-cell';
                this.drag = { mode: 'days', day0: day, day1: day, sel, x0: e.clientX, y0: e.clientY, moved: false };
            },
            // A long press on an event lifts it (appEdits): no context menu over it.
            onContextMenu(e) {
                if (this.appEdits && !this.readOnly && (this.drag || this._press || (e.target.closest && e.target.closest('.nc-timed, .nc-bar')))) e.preventDefault();
            },
            cancelDrag() {
                this.drag = null;
                clearTimeout(this._press); this._press = null;
                // The mouse button (or finger) is still down: its click must not open the quick box or a popup.
                this._swallowClick = true;
                setTimeout(() => { this._swallowClick = false; }, 400);
            },
            // ---- touch: long-press to drag (appEdits) ----------------------------------------
            touchStart(e, occ, mode, extra) {
                if (!this.appEdits || this.readOnly || occ.event.__draft || !e.touches || e.touches.length !== 1) return;
                const t = e.touches[0];
                clearTimeout(this._press);
                this._pressAt = { x: t.clientX, y: t.clientY };
                this._press = setTimeout(() => {
                    this._press = null;
                    this.drag = { key: occ.key, occ, mode, x0: t.clientX, y0: t.clientY, moved: false, touch: true, ...extra };
                    try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) { /* no haptics */ }
                }, 450);
            },
            onTouchMove(e) {
                const t = e.touches && e.touches[0];
                if (!t) return;
                // Moving before the press is long enough means scrolling: never lift the event then.
                if (this._press && Math.abs(t.clientX - this._pressAt.x) + Math.abs(t.clientY - this._pressAt.y) > 10) { clearTimeout(this._press); this._press = null; }
                if (this.drag && this.drag.touch) { if (e.cancelable) e.preventDefault(); this.onDragMove({ clientX: t.clientX, clientY: t.clientY }); }
            },
            onTouchEnd(e) {
                clearTimeout(this._press); this._press = null;
                const d = this.drag;
                if (!d || !d.touch) return;
                const t = (e.changedTouches && e.changedTouches[0]) || { clientX: d.x0, clientY: d.y0 };
                if (d.moved) { this._swallowClick = true; setTimeout(() => { this._swallowClick = false; }, 400); if (e.cancelable) e.preventDefault(); }
                this.onDragEnd({ clientX: t.clientX, clientY: t.clientY });
            },
            // ---- drag & resize (mouse; timed and month) ------------------------------------
            startDrag(e, occ, mode, extra) {
                if (this.readOnly || this.isPhone || e.button !== 0 || occ.event.__draft) return;
                // A repeating occurrence (or an edited one) only where the app asks "this event / all events".
                if (occ.recurring && !this.appEdits) return;
                this.drag = { key: occ.key, occ, mode, x0: e.clientX, y0: e.clientY, moved: false, ...extra };
            },
            onDragMove(e) {
                const d = this.drag; if (!d) return;
                if (!d.moved && Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 5) return;
                if (!d.moved && d.occ && this.appEdits) this.$emit('drag-start', { event: d.occ.event, occurrence: d.occ });
                d.moved = true;
                if (d.mode === 'create') {
                    const q = HOUR_PX / 4, y = Math.max(0, Math.round((e.clientY - d.rectTop) / q) * q);
                    d.top = Math.min(d.top0, y); d.height = Math.max(q, Math.abs(y - d.top0));
                    return;
                }
                if (d.mode === 'days') {
                    const day = this.dayAt(e.clientX, e.clientY, d.sel);
                    if (day) d.day1 = day;
                    return;
                }
                if (d.mode === 'month') {
                    const day = this.dayAt(e.clientX, e.clientY, '.nc-cell[data-day], .nc-allday-cell[data-day]');
                    if (day) d.targetDay = day;
                } else {
                    const dy = Math.round((e.clientY - d.y0) / (HOUR_PX / 2)) * (HOUR_PX / 2);
                    if (d.mode === 'move') {
                        d.top = d.top0 + dy;
                        const day = this.dayAt(e.clientX, e.clientY, '.nc-col[data-day]');
                        if (day) d.targetDay = day;
                    } else if (d.mode === 'resize-top') {
                        d.top = Math.min(d.top0 + dy, d.top0 + d.height0 - HOUR_PX / 2);
                        d.height = d.height0 - (d.top - d.top0);
                    } else d.height = Math.max(HOUR_PX / 2, d.height0 + dy);
                }
            },
            onDragEnd(e) {
                const d = this.drag; if (!d) return;
                setTimeout(() => { this.drag = null; }, 0);
                if (!d.moved) return;
                if (d.mode === 'create') {
                    this._afterCreateDrag = true; setTimeout(() => { this._afterCreateDrag = false; }, 0);
                    const r = this.createRange(d);
                    this.$emit('event-create', { start: r.start.toISOString(), end: r.end.toISOString(), isAllDay: false, event: e, full: false });
                    return;
                }
                if (d.mode === 'days') {
                    this._afterCreateDrag = true; setTimeout(() => { this._afterCreateDrag = false; }, 0);
                    const a = d.day0 <= d.day1 ? d.day0 : d.day1, b = d.day0 <= d.day1 ? d.day1 : d.day0;
                    const start = startOfDay(a), end = new Date(addDays(startOfDay(b), 1).getTime() - 1);   // display shape, as clickCell sends it
                    this.$emit('event-create', { start: start.toISOString(), end: end.toISOString(), isAllDay: true, event: e, full: false });
                    return;
                }
                const ev = d.occ.event; let start = new Date(d.occ.start), end = new Date(d.occ.end);
                if (d.mode === 'month') {
                    if (!d.targetDay) return;
                    const shift = dayIndex(d.targetDay) - dayIndex(start); if (!shift) return;
                    start = addDays(start, shift); end = addDays(end, shift);
                } else if (d.mode === 'move') {
                    const minutes = ((d.top - d.top0) / HOUR_PX) * 60;
                    const shift = d.targetDay ? dayIndex(d.targetDay) - dayIndex(start) : 0;
                    // The grid is drawn in wall-clock hours, so a drag moves the clock time (DST-safe).
                    const wall = (t) => { const x = addDays(t, shift); x.setMinutes(x.getMinutes() + Math.round(minutes)); return x; };
                    start = wall(start); end = wall(end);
                } else if (d.mode === 'resize-top') {
                    start = new Date(start); start.setMinutes(start.getMinutes() + Math.round(((d.top - d.top0) / HOUR_PX) * 60));
                } else {
                    // By how much the bottom edge moved (an event starting above the first hour shown is drawn clipped).
                    end = new Date(end); end.setMinutes(end.getMinutes() + Math.round(((d.height - d.height0) / HOUR_PX) * 60));
                }
                if (start.getTime() === d.occ.start.getTime() && end.getTime() === d.occ.end.getTime()) return;
                if (this.appEdits) {
                    this.$emit('event-move', { event: ev, occurrence: d.occ, start, end, allDay: !!d.occ.allDay, mode: d.mode });
                    return;
                }
                // An all-day end goes out in the display shape (through 23:59:59.999 of the last day), the
                // one app.js toStoredEvent expects; the grid itself works with the exclusive end above.
                const out = d.occ.allDay ? new Date(end.getTime() - 1) : end;
                // The row to change: the very object the drag started on, or -- if the list was rebuilt
                // meanwhile (an all-day event is shown as a fresh copy each time, and a server snapshot can
                // land mid-drag) -- the one row with the same id. Without this the drag was silently dropped.
                const same = (x) => x && ev && x.id === ev.id && (x.recurrenceID || '') === (ev.recurrenceID || '');
                const target = this.events.find(x => x === ev) || this.events.find(same);
                const next = this.events.map(x => x === target ? { ...x, start: start.toISOString(), end: out.toISOString() } : x);
                this.$emit('update:events', next);
            },
        },
        template: /* html */ `
<div class="nc" :class="{ 'nc-phone': isPhone, 'nc-v2': v2, 'nc-readonly': readOnly, 'nc-editable': appEdits && !readOnly, 'nc-dragging': !!(drag && drag.moved) }" @contextmenu="onContextMenu">
  <!-- Toolbar: prev / next, title with chevron | DAY WEEK MONTH 3 MONTHS YEAR AGENDA -->
  <div class="nc-toolbar">
    <div class="nc-toolbar-left">
      <button v-if="v2" class="nc-today-btn" data-testid="today" @click="goToday">Today</button>
      <button class="nc-icon-btn" data-testid="nav-prev" aria-label="Previous" @click="step(-1)">
        <nc-icon name="chevron-left" :size="20"></nc-icon></button>
      <button class="nc-icon-btn" data-testid="nav-next" aria-label="Next" @click="step(1)">
        <nc-icon name="chevron-right" :size="20"></nc-icon></button>
      <button class="nc-title" :class="{ open: pickerOpen }" data-testid="current-date-range" @click="togglePicker">
        {{ title }} <nc-icon class="nc-caret" name="chevron-down" :size="16"></nc-icon></button>
      <div v-if="pickerOpen" class="nc-picker" data-testid="date-picker">
        <div class="nc-picker-head"><span>{{ pickerYear }}</span>
          <span><button class="nc-icon-btn" aria-label="Previous year" @click="pickerYear--"><nc-icon name="chevron-up" :size="18"></nc-icon></button><button class="nc-icon-btn" aria-label="Next year" @click="pickerYear++"><nc-icon name="chevron-down" :size="18"></nc-icon></button></span></div>
        <div class="nc-picker-months">
          <button v-for="(m, i) in ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']" :key="m"
            :class="{ on: pickerYear === date.getFullYear() && i === date.getMonth() }" @click="pickMonth(i)">{{ m }}</button>
        </div>
        <div class="nc-picker-foot"><button class="nc-link" @click="goToday">{{ v2 || appLook ? 'Today' : 'TODAY' }}</button></div>
      </div>
    </div>
    <!-- Phone: the view buttons do not fit, so they live behind a "more" menu, as in Syncfusion. -->
    <div v-if="isPhone" class="nc-phone-views">
      <button class="nc-icon-btn" aria-label="Change view" data-testid="view-menu" @click="viewMenu = !viewMenu">
        <nc-icon name="ellipsis-vertical" :size="20"></nc-icon></button>
      <div v-if="viewMenu" class="nc-view-menu">
        <button v-for="v in views" :key="v" :class="{ on: view === v }"
          :data-testid="'view-' + viewLabel(v).replace(' ', '')" @click="setView(v); viewMenu = false">{{ viewLabel(v) }}</button>
      </div>
    </div>
    <div class="nc-views" role="tablist">
      <button v-for="v in views" :key="v" role="tab" :aria-selected="view === v"
        :class="{ on: view === v }" :data-testid="'view-' + viewLabel(v).replace(' ', '')" @click="setView(v)">{{ v2 || appLook ? viewLabel(v) : viewLabel(v).toUpperCase() }}</button>
    </div>
  </div>

  <!-- Month & N Months / N Weeks -->
  <div v-if="view === 'Month' || view === 'Custom'" class="nc-month" data-testid="month-view-grid">
    <div class="nc-month-head">
      <div v-for="i in weekdayOrder" :key="i" class="nc-weekday"
        :class="{ today: now.getDay() === i && monthWeeks.some(w => w.days.some(d => isToday(d))) }">{{ weekdayName(i, (v2 || appLook) && isPhone) }}</div>
    </div>
    <div class="nc-month-body">
      <div v-for="w in monthWeeks" :key="w.key" class="nc-week-row" :style="monthRowHeight > 100 ? { height: monthRowHeight + 'px' } : null">
        <div v-for="(d, c) in w.days" :key="c" class="nc-cell" :data-day="d.getTime()"
          :class="{ out: !w.inMonth(d), weekend: isWeekend(d), selected: selectedCell === 'd' + d.getTime(), creating: inDayRun(d), drop: isDropDay(d) }"
          @mousedown="startDayCreate($event, d)" @click="clickCell(d, $event)" @dblclick="clickCell(d, $event, undefined, true)">
          <span class="nc-date" :class="{ today: isToday(d), first: d.getDate() === 1 }" @click.stop="openDay(d)">{{ dayLabel(d) }}</span>
          <button v-if="w.hidden[c]" class="nc-more" data-testid="more-events" @click.stop="openDay(d)">+{{ w.hidden[c] }}<span class="nc-more-word"> more</span></button>
        </div>
        <div v-for="b in w.bars" :key="b.occ.key + w.key" class="nc-bar" :style="barStyle(b)"
          :class="{ long: b.occ.allDay || isMultiDayTimed(b.occ), tint: isTint(b), 'clip-l': b.clippedLeft, 'clip-r': b.clippedRight, 'nc-draft': b.occ.event.__draft, lifted: isLifted(b.occ) }"
          :data-testid="tid(b.occ)" :title="b.occ.title"
          @mousedown="startDrag($event, b.occ, 'month')" @touchstart="touchStart($event, b.occ, 'month')" @click.stop="clickEvent(b.occ, $event)" @dblclick.stop="openEvent(b.occ)" tabindex="0" role="button" :aria-label="ariaLabel(b.occ)" @keydown.enter.prevent="clickEvent(b.occ, $event)" @keydown.space.prevent="clickEvent(b.occ, $event)">
          <template v-if="b.occ.allDay || isMultiDayTimed(b.occ)">
            <span v-if="!b.occ.allDay && !b.clippedLeft" class="nc-bar-time">{{ time(b.occ.start) }}</span>
            <span class="nc-bar-title center">{{ b.occ.title }}</span>
            <span v-if="!b.occ.allDay && !b.clippedRight" class="nc-bar-time">{{ time(b.occ.end) }}</span>
          </template>
          <template v-else>
            <span class="nc-bar-time">{{ time(b.occ.start) }}</span><span class="nc-bar-title">{{ b.occ.title }}</span>
          </template>
          <nc-icon v-if="b.occ.recurring" class="nc-recur" name="repeat" :size="11" :stroke-width="2.5"></nc-icon>
        </div>
      </div>
    </div>
  </div>

  <!-- Week & Day -->
  <div v-else-if="view === 'Week' || view === 'Day'" class="nc-grid" data-testid="time-grid" :style="{ '--cols': gridDays.length }">
    <div class="nc-grid-head">
      <div class="nc-gutter-head">
        <button v-if="parseInt(startHour, 10) > 0" class="nc-early" data-testid="early-hours" @click="showEarlyHours = !showEarlyHours">{{ showEarlyHours ? 'Hide early' : earlyLabel() }}</button>
      </div>
      <div class="nc-grid-days">
        <div class="nc-grid-dayheads">
          <div v-for="d in gridDays" :key="d.getTime()" class="nc-dayhead" :class="{ today: isToday(d) }" @click="openDay(d)">
            <div class="nc-dayhead-name">{{ weekdayName(d.getDay(), true) }}</div><div class="nc-dayhead-num">{{ d.getDate() }}</div>
          </div>
        </div>
        <div class="nc-allday" :style="{ height: (8 + gridLayout.allDayLanes * (22)) + 'px' }">
          <div v-for="d in gridDays" :key="d.getTime()" class="nc-allday-cell" :data-day="d.getTime()" :class="{ creating: inDayRun(d), drop: isDropDay(d) }"
            @mousedown="startDayCreate($event, d)" @click="clickCell(d, $event)" @dblclick="clickCell(d, $event, undefined, true)"></div>
          <div v-for="b in gridLayout.allDay" :key="b.occ.key" class="nc-bar long" :style="gridBarStyle(b, gridDays.length)"
            :class="{ 'nc-draft': b.occ.event.__draft, lifted: isLifted(b.occ) }"
            :data-testid="tid(b.occ)" @mousedown="startDrag($event, b.occ, 'month')" @touchstart="touchStart($event, b.occ, 'month')" @click.stop="clickEvent(b.occ, $event)" @dblclick.stop="openEvent(b.occ)" tabindex="0" role="button" :aria-label="ariaLabel(b.occ)" @keydown.enter.prevent="clickEvent(b.occ, $event)" @keydown.space.prevent="clickEvent(b.occ, $event)">
            <span v-if="!b.occ.allDay && !b.clippedLeft" class="nc-bar-time">{{ time(b.occ.start) }}</span>
            <span class="nc-bar-title center">{{ b.occ.title }}</span>
            <span v-if="!b.occ.allDay && !b.clippedRight" class="nc-bar-time">{{ time(b.occ.end) }}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="nc-grid-scroll" ref="timeScroll">
      <div class="nc-grid-body" :style="{ height: hours.length * 48 + 'px' }">
        <div class="nc-gutter">
          <div v-for="h in hours" :key="h" class="nc-hour-label">{{ hourLabel(h) }}</div>
          <div v-if="gridDays.some(isToday) && nowTop >= 0" class="nc-now-label" :style="{ top: nowTop + 'px' }">{{ nowLabel() }}</div>
        </div>
        <div class="nc-grid-cols">
          <div v-for="(d, i) in gridDays" :key="d.getTime()" class="nc-col" :data-day="d.getTime()"
            :class="{ weekend: isWeekend(d) && gridDays.length > 1 }"
            @mousedown="startCreate($event, d)" @click="clickSlot(d, $event)" @dblclick="clickSlot(d, $event, true)">
            <div v-for="h in hours" :key="h" class="nc-slot"></div>
            <div v-if="drag && drag.mode === 'create' && drag.moved && drag.day.getTime() === d.getTime()" class="nc-create-preview"
              data-testid="create-preview" :style="{ top: drag.top + 'px', height: drag.height + 'px' }">{{ createLabel() }}</div>
            <div v-for="it in gridLayout.timed[i]" :key="it.occ.key" class="nc-timed" :style="timedStyle(it)"
              :class="{ 'nc-draft': it.occ.event.__draft, lifted: isLifted(it.occ) }" :data-testid="tid(it.occ)"
              @mousedown="startDrag($event, it.occ, 'move', { top0: it.top, top: it.top, height: it.height })"
              @touchstart="touchStart($event, it.occ, 'move', { top0: it.top, top: it.top, height: it.height })" @click.stop="clickEvent(it.occ, $event)" @dblclick.stop="openEvent(it.occ)" tabindex="0" role="button" :aria-label="ariaLabel(it.occ)" @keydown.enter.prevent="clickEvent(it.occ, $event)" @keydown.space.prevent="clickEvent(it.occ, $event)">
              <div class="nc-timed-title">{{ it.occ.title }} <nc-icon v-if="it.occ.recurring" class="nc-recur" name="repeat" :size="11" :stroke-width="2.5"></nc-icon></div>
              <div v-if="it.height > 34" class="nc-timed-time">{{ time(it.occ.start) }} - {{ time(it.occ.end) }}</div>
              <div class="nc-resize" data-testid="resize-bottom" @mousedown.stop="startDrag($event, it.occ, 'resize', { height0: it.height, height: it.height, top: it.top, top0: it.top })"></div>
              <div v-if="appEdits" class="nc-resize nc-resize-top" data-testid="resize-top" @mousedown.stop="startDrag($event, it.occ, 'resize-top', { height0: it.height, height: it.height, top: it.top, top0: it.top })"></div>
            </div>
            <div v-if="isToday(d) && nowTop >= 0" class="nc-now-line" :style="{ top: nowTop + 'px' }"></div>
          </div>
          <div v-if="gridDays.length > 1 && gridDays.some(isToday) && nowTop >= 0" class="nc-now-dotted" :style="{ top: nowTop + 'px' }"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Year -->
  <div v-else-if="view === 'Year'" class="nc-year" data-testid="year-view">
    <div v-for="m in yearMonths" :key="m.name" class="nc-mini">
      <div class="nc-mini-title">{{ m.name }}</div>
      <div class="nc-mini-grid">
        <div v-for="i in weekdayOrder" :key="'h' + i" class="nc-mini-wd">{{ weekdayName(i).charAt(0) }}</div>
        <button v-for="c in m.cells" :key="c.key" class="nc-mini-day" :class="{ out: c.out, today: isToday(c.d) }" @click="openDay(c.d)">
          {{ c.d.getDate() }}<span v-if="c.mark && !c.out" class="nc-mini-dot" :style="{ background: c.mark }"></span>
        </button>
      </div>
    </div>
  </div>

  <!-- Agenda -->
  <div v-else-if="view === 'Agenda'" class="nc-agenda" data-testid="agenda-view">
    <div v-if="!agendaDays.length" class="nc-agenda-empty">No events</div>
    <div v-for="day in agendaDays" :key="day.key" class="nc-agenda-day">
      <div class="nc-agenda-date" :class="{ today: isToday(day.d) }"><div class="n">{{ day.d.getDate() }}</div><div class="w">{{ weekdayName(day.d.getDay(), true) }}</div></div>
      <div class="nc-agenda-items">
        <div v-for="it in day.items" :key="it.key" class="nc-agenda-item" :style="{ borderLeftColor: color(it.occ.type) }"
          :data-testid="tid(it.occ)" @click="clickEvent(it.occ, $event)" tabindex="0" role="button" :aria-label="ariaLabel(it.occ)" @keydown.enter.prevent="clickEvent(it.occ, $event)" @keydown.space.prevent="clickEvent(it.occ, $event)">
          <div class="t">{{ it.occ.title }} <nc-icon v-if="it.occ.recurring" class="nc-recur dark" name="repeat" :size="11" :stroke-width="2.5"></nc-icon></div>
          <div class="w">{{ it.when }}</div>
        </div>
      </div>
    </div>
  </div>
</div>`,
    };
    // The same expansion the grid draws, for the app's other readers of "what is on these days" (print, the
    // hidden-events count): occurrencesBetween(events, rangeStart, rangeEnd) -> [{ event, start, end, allDay, ... }].
    component.occurrencesBetween = occurrencesBetween;
    component.allDayStampKey = allDayStampKey;   // (unit tests: test/unit/native-editing.test.js)
    return component;
})();

if (typeof window !== 'undefined') window.NativeCalendar = NativeCalendar;
