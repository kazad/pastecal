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
    const MONTH_ROW_PX = 100;           // fixed month row height, like Syncfusion
    const BAR_PX = 20, BAR_GAP = 2, DATE_HEADER_PX = 26;
    const VIEWS = ['Day', 'Week', 'Month', '3 Months', 'Year', 'Agenda'];
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
    // The stored instant -> the calendar day it stands for (see header).
    const allDayDate = (v) => { const r = new Date(new Date(v).getTime() + 12 * 3600000); return new Date(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate()); };
    const toFloating = (d) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
    const fromFloating = (u) => new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
    const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    // ---- events -> occurrences ---------------------------------------------------------
    function isLong(o) { return o.allDay || (o.end - o.start) >= DAY_MS; }

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
            if (ev.recurrencerule && !ev.recurrenceID && RR.RRule) {
                const excluded = new Set(String(ev.recurrenceException || '').split(',').map(s => s.trim()).filter(Boolean)
                    .map(s => s.replace(/(\d{8}T\d{4})\d{2}Z?$/, '$1')));  // compare to the minute
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
                    for (const f of rule.between(from, to, true)) {
                        const s = fromFloating(f);
                        const stamp = utcStamp(allDay ? s : s).replace(/(\d{8}T\d{4})\d{2}Z$/, '$1');
                        if (excluded.has(stamp) || excluded.has(stamp.slice(0, 8))) continue;
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

    return {
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
        },
        emits: ['update:events', 'event-click', 'event-create', 'view-change'],
        data() {
            return {
                view: VIEWS.includes(this.initialView) ? this.initialView : 'Month',
                date: startOfDay(new Date()),
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
                    : ['#3f51b5', '#e3165b', '#ff6652', '#4caf50', '#ff9800', '#03a9f4', '#9e9e9e', '#27282f'];
            },
            first() { return Number(this.firstDayOfWeek) || 0; },
            weekdayOrder() { return [0, 1, 2, 3, 4, 5, 6].map(i => (i + this.first) % 7); },
            title() {
                const d = this.date, M = MONTHS[d.getMonth()];
                if (this.view === 'Day') return `${M} ${d.getDate()}, ${d.getFullYear()}`;
                if (this.view === 'Week' || this.view === 'Agenda') {
                    const s = this.view === 'Week' ? startOfWeek(d, this.first) : d; const e = addDays(s, 6);
                    if (s.getFullYear() !== e.getFullYear()) return `${MONTHS[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()} - ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
                    if (s.getMonth() !== e.getMonth()) return `${MONTHS[s.getMonth()]} ${s.getDate()} - ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
                    return `${MONTHS[s.getMonth()]} ${s.getDate()} - ${e.getDate()}, ${e.getFullYear()}`;
                }
                if (this.view === '3 Months') {
                    const e = addMonths(d, 2);
                    return e.getFullYear() === d.getFullYear() ? `${M} - ${MONTHS[e.getMonth()]} ${e.getFullYear()}` : `${M} ${d.getFullYear()} - ${MONTHS[e.getMonth()]} ${e.getFullYear()}`;
                }
                if (this.view === 'Year') return String(d.getFullYear());
                return `${M} ${d.getFullYear()}`;
            },
            // ---- month / 3 months --------------------------------------------------------
            monthWeeks() {
                if (this.view !== 'Month' && this.view !== '3 Months') return [];
                const m0 = new Date(this.date.getFullYear(), this.date.getMonth(), 1);
                const mEnd = addMonths(m0, this.view === 'Month' ? 1 : 3);
                const weeks = [];
                for (let ws = startOfWeek(m0, this.first); ws < mEnd; ws = addDays(ws, 7)) {
                    const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i));
                    const occs = occurrencesBetween(this.events, ws, addDays(ws, 7));
                    const bars = layoutWeekBars(occs, ws, 7);
                    const maxLanes = Math.floor((MONTH_ROW_PX - DATE_HEADER_PX - 16) / (BAR_PX + BAR_GAP));
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
                const occs = occurrencesBetween(this.events, s, e);
                const allDayBars = layoutWeekBars(occs.filter(isLong), s, days.length);
                const timed = days.map(day => {
                    const dayEnd = addDays(day, 1); const items = [];
                    for (const o of occs) {
                        if (isLong(o) || o.end <= day || o.start >= dayEnd) continue;
                        const a = Math.max(o.start, day), b = Math.min(o.end, dayEnd);
                        const top = ((a - day) / 3600000 - this.firstHour) * HOUR_PX;
                        const height = Math.max(((b - a) / 3600000) * HOUR_PX, 18);
                        if (top + height <= 0) continue;
                        items.push({ occ: o, top: Math.max(top, 0), height: top < 0 ? height + top : height });
                    }
                    return layoutDayColumns(items);
                });
                return { allDay: allDayBars, timed, allDayLanes: allDayBars.reduce((m, b) => Math.max(m, b.lane + 1), 0) };
            },
            nowTop() { return ((this.now - startOfDay(this.now)) / 3600000 - this.firstHour) * HOUR_PX; },
            // ---- year --------------------------------------------------------------------
            yearMonths() {
                if (this.view !== 'Year') return [];
                const y = this.date.getFullYear();
                const occs = occurrencesBetween(this.events, new Date(y, 0, 1), new Date(y + 1, 0, 8));
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
                const occs = occurrencesBetween(this.events, s, e);
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
        },
        mounted() {
            this._tick = setInterval(() => { this.now = new Date(); }, 60000);
            this._onResize = () => { this.isPhone = window.innerWidth < 768; };
            window.addEventListener('resize', this._onResize);
            this._onMove = (e) => this.onDragMove(e);
            this._onUp = (e) => this.onDragEnd(e);
            window.addEventListener('mousemove', this._onMove);
            window.addEventListener('mouseup', this._onUp);
            this._onDocClick = (e) => { if (this.pickerOpen && !e.target.closest('.nc-picker, .nc-title')) this.pickerOpen = false; };
            document.addEventListener('mousedown', this._onDocClick);
            this.$nextTick(() => this.scrollToWorkHours());
        },
        beforeUnmount() {
            clearInterval(this._tick);
            window.removeEventListener('resize', this._onResize);
            window.removeEventListener('mousemove', this._onMove);
            window.removeEventListener('mouseup', this._onUp);
            document.removeEventListener('mousedown', this._onDocClick);
        },
        methods: {
            // ---- navigation --------------------------------------------------------------
            setView(v) { this.view = v; this.pickerOpen = false; this.$nextTick(() => this.scrollToWorkHours()); },
            step(dir) {
                const d = this.date;
                if (this.view === 'Day') this.date = addDays(d, dir);
                else if (this.view === 'Week' || this.view === 'Agenda') this.date = addDays(d, 7 * dir);
                else if (this.view === 'Month') this.date = new Date(d.getFullYear(), d.getMonth() + dir, Math.min(d.getDate(), 28));
                else if (this.view === '3 Months') this.date = new Date(d.getFullYear(), d.getMonth() + 3 * dir, 1);
                else if (this.view === 'Year') this.date = new Date(d.getFullYear() + dir, d.getMonth(), 1);
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
            time(d) { const t = fmtTime(d, this.timeFormat); return this.v2 && this.timeFormat !== '24' ? t.replace(/^0/, '') : t; },
            hourLabel(h) {
                if (this.v2 && this.timeFormat !== '24') return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
                return fmtTime(new Date(2000, 0, 1, h), this.timeFormat);
            },
            earlyLabel() { const h = parseInt(this.startHour, 10); return this.timeFormat === '24' ? `00-${pad(h - 1)}` : `12-${(h - 1) % 12 || 12} AM`; },
            // People plan by color ("the orange ones are soccer"), so events stay blocks of
            // color in both looks. v1: solid with white text, as Syncfusion. v2: all-day and
            // multi-day bars solid with black or white text per color (white on orange or
            // sky blue is 2.2-2.6:1); timed events a tinted block with a solid colored edge
            // and dark text (the .tint class).
            paint(type, tint) {
                const c = this.color(type);
                if (!this.v2) return { background: c };
                return tint ? { '--c': c } : { background: c, color: NcUx.textOn(c) };
            },
            isTint(b) { return this.v2 && !(b.occ.allDay || this.isMultiDayTimed(b.occ)); },
            barStyle(b) {
                return { left: `calc(${(b.col / 7) * 100}% + 2px)`, width: `calc(${(b.span / 7) * 100}% - 4px)`,
                    top: `${DATE_HEADER_PX + b.lane * (BAR_PX + BAR_GAP)}px`, ...this.paint(b.occ.type, this.isTint(b)) };
            },
            gridBarStyle(b, cols) {
                return { left: `calc(${(b.col / cols) * 100}% + 2px)`, width: `calc(${(b.span / cols) * 100}% - 4px)`,
                    top: `${4 + b.lane * (BAR_PX + BAR_GAP)}px`, ...this.paint(b.occ.type) };
            },
            timedStyle(it) {
                const w = 100 / it.cols;
                const dragging = this.drag && this.drag.moved && this.drag.key === it.occ.key;
                return { top: `${dragging ? this.drag.top : it.top}px`, height: `${dragging ? this.drag.height : it.height}px`,
                    left: `calc(${it.col * w}% + 1px)`, width: `calc(${w}% - 3px)`,
                    ...this.paint(it.occ.type, true),
                    opacity: dragging ? 0.85 : 1, zIndex: dragging ? 5 : 1 };
            },
            // Crosses midnight at all -- Syncfusion draws even a 10pm-2am flight as a
            // spanning bar with a time at each end.
            isMultiDayTimed(o) { return !o.allDay && dayIndex(o.start) !== dayIndex(new Date(o.end.getTime() - 1)); },
            // ---- clicks ------------------------------------------------------------------
            clickEvent(occ, jsEvent) {
                if (this.drag && this.drag.moved) return;
                this.selectedCell = null;
                this.$emit('event-click', { event: occ.event, occurrence: { start: occ.start, end: occ.end, recurring: occ.recurring }, jsEvent });
            },
            clickCell(day, jsEvent, hour, full) {
                if (this.readOnly) return;
                this.selectedCell = (hour === undefined ? 'd' : 'h' + hour) + day.getTime();
                let start, end, isAllDay;
                if (hour === undefined) { start = startOfDay(day); end = addDays(start, 1); isAllDay = true; }
                else {
                    // v1: Syncfusion's 30-minute slot. v2: an hour, the length most events are.
                    start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(hour), (hour % 1) * 60);
                    end = new Date(start.getTime() + (this.v2 ? 3600000 : 1800000)); isAllDay = false;
                }
                // Same storage as Syncfusion: all-day is LOCAL midnight, end exclusive.
                this.$emit('event-create', { start: start.toISOString(), end: end.toISOString(), isAllDay, event: jsEvent, full: !!full });
            },
            clickSlot(day, jsEvent, full) {
                if (this._afterCreateDrag) return;   // the click that ends a drag-to-create
                const rect = jsEvent.currentTarget.getBoundingClientRect();
                const hour = this.firstHour + Math.floor(((jsEvent.clientY - rect.top) / HOUR_PX) * 2) / 2;
                this.clickCell(day, jsEvent, hour, full);
            },
            // ---- drag to create (v2; Week/Day, mouse) --------------------------------------
            // Press on an empty slot and drag: the range becomes the new event's start and
            // end in one gesture, snapped to 15 minutes (Google, Apple). A press without a
            // drag stays an ordinary click.
            startCreate(e, day) {
                if (!this.v2 || this.readOnly || this.isPhone || e.button !== 0 || e.target.closest('.nc-timed')) return;
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
            // ---- drag & resize (mouse; timed and month) ------------------------------------
            startDrag(e, occ, mode, extra) {
                if (this.readOnly || this.isPhone || e.button !== 0 || occ.recurring) return;
                this.drag = { key: occ.key, occ, mode, x0: e.clientX, y0: e.clientY, moved: false, ...extra };
            },
            onDragMove(e) {
                const d = this.drag; if (!d) return;
                if (!d.moved && Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 5) return;
                d.moved = true;
                if (d.mode === 'create') {
                    const q = HOUR_PX / 4, y = Math.max(0, Math.round((e.clientY - d.rectTop) / q) * q);
                    d.top = Math.min(d.top0, y); d.height = Math.max(q, Math.abs(y - d.top0));
                    return;
                }
                if (d.mode === 'month') {
                    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-day]');
                    if (cell) d.targetDay = new Date(Number(cell.dataset.day));
                } else {
                    const dy = Math.round((e.clientY - d.y0) / (HOUR_PX / 2)) * (HOUR_PX / 2);
                    if (d.mode === 'move') {
                        d.top = d.top0 + dy;
                        const col = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-day]');
                        if (col) d.targetDay = new Date(Number(col.dataset.day));
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
                const ev = d.occ.event; let start = new Date(d.occ.start), end = new Date(d.occ.end);
                if (d.mode === 'month') {
                    if (!d.targetDay) return;
                    const shift = dayIndex(d.targetDay) - dayIndex(start); if (!shift) return;
                    start = addDays(start, shift); end = addDays(end, shift);
                } else if (d.mode === 'move') {
                    const minutes = ((d.top - d.top0) / HOUR_PX) * 60;
                    const shift = d.targetDay ? dayIndex(d.targetDay) - dayIndex(start) : 0;
                    start = new Date(addDays(start, shift).getTime() + minutes * 60000); end = new Date(addDays(end, shift).getTime() + minutes * 60000);
                } else {
                    end = new Date(start.getTime() + (d.height / HOUR_PX) * 3600000);
                }
                if (start.getTime() === d.occ.start.getTime() && end.getTime() === d.occ.end.getTime()) return;
                const next = this.events.map(x => x === ev ? { ...x, start: start.toISOString(), end: end.toISOString() } : x);
                this.$emit('update:events', next);
            },
        },
        template: /* html */ `
<div class="nc" :class="{ 'nc-phone': isPhone, 'nc-v2': v2 }">
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
        <div class="nc-picker-foot"><button class="nc-link" @click="goToday">{{ v2 ? 'Today' : 'TODAY' }}</button></div>
      </div>
    </div>
    <!-- Phone: the view buttons do not fit, so they live behind a "more" menu, as in Syncfusion. -->
    <div v-if="isPhone" class="nc-phone-views">
      <button class="nc-icon-btn" aria-label="Change view" data-testid="view-menu" @click="viewMenu = !viewMenu">
        <nc-icon name="ellipsis-vertical" :size="20"></nc-icon></button>
      <div v-if="viewMenu" class="nc-view-menu">
        <button v-for="v in ['Day','Week','Month','3 Months','Year','Agenda']" :key="v" :class="{ on: view === v }"
          :data-testid="'view-' + v.replace(' ', '')" @click="setView(v); viewMenu = false">{{ v }}</button>
      </div>
    </div>
    <div class="nc-views" role="tablist">
      <button v-for="v in ['Day','Week','Month','3 Months','Year','Agenda']" :key="v" role="tab" :aria-selected="view === v"
        :class="{ on: view === v }" :data-testid="'view-' + v.replace(' ', '')" @click="setView(v)">{{ v2 ? v : v.toUpperCase() }}</button>
    </div>
  </div>

  <!-- Month & 3 Months -->
  <div v-if="view === 'Month' || view === '3 Months'" class="nc-month" data-testid="month-view-grid">
    <div class="nc-month-head">
      <div v-for="i in weekdayOrder" :key="i" class="nc-weekday"
        :class="{ today: now.getDay() === i && monthWeeks.some(w => w.days.some(d => isToday(d))) }">{{ weekdayName(i, v2 && isPhone) }}</div>
    </div>
    <div class="nc-month-body">
      <div v-for="w in monthWeeks" :key="w.key" class="nc-week-row">
        <div v-for="(d, c) in w.days" :key="c" class="nc-cell" :data-day="d.getTime()"
          :class="{ out: !w.inMonth(d), weekend: isWeekend(d), selected: selectedCell === 'd' + d.getTime() }"
          @click="clickCell(d, $event)" @dblclick="clickCell(d, $event, undefined, true)">
          <span class="nc-date" :class="{ today: isToday(d), first: d.getDate() === 1 }" @click.stop="openDay(d)">{{ dayLabel(d) }}</span>
          <button v-if="w.hidden[c]" class="nc-more" data-testid="more-events" @click.stop="openDay(d)">+{{ w.hidden[c] }}<span class="nc-more-word"> more</span></button>
        </div>
        <div v-for="b in w.bars" :key="b.occ.key + w.key" class="nc-bar" :style="barStyle(b)"
          :class="{ long: b.occ.allDay || isMultiDayTimed(b.occ), tint: isTint(b), 'clip-l': b.clippedLeft, 'clip-r': b.clippedRight }"
          :data-testid="'event-' + b.occ.event.id" :title="b.occ.title"
          @mousedown="startDrag($event, b.occ, 'month')" @click.stop="clickEvent(b.occ, $event)">
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
          <div v-for="d in gridDays" :key="d.getTime()" class="nc-allday-cell" :data-day="d.getTime()" @click="clickCell(d, $event)" @dblclick="clickCell(d, $event, undefined, true)"></div>
          <div v-for="b in gridLayout.allDay" :key="b.occ.key" class="nc-bar long" :style="gridBarStyle(b, gridDays.length)"
            :data-testid="'event-' + b.occ.event.id" @click.stop="clickEvent(b.occ, $event)">
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
          <div v-if="gridDays.some(isToday) && nowTop >= 0" class="nc-now-label" :style="{ top: nowTop + 'px' }">{{ time(now) }}</div>
        </div>
        <div class="nc-grid-cols">
          <div v-for="(d, i) in gridDays" :key="d.getTime()" class="nc-col" :data-day="d.getTime()"
            :class="{ weekend: isWeekend(d) && gridDays.length > 1 }"
            @mousedown="startCreate($event, d)" @click="clickSlot(d, $event)" @dblclick="clickSlot(d, $event, true)">
            <div v-for="h in hours" :key="h" class="nc-slot"></div>
            <div v-if="drag && drag.mode === 'create' && drag.moved && drag.day.getTime() === d.getTime()" class="nc-create-preview"
              data-testid="create-preview" :style="{ top: drag.top + 'px', height: drag.height + 'px' }">{{ createLabel() }}</div>
            <div v-for="it in gridLayout.timed[i]" :key="it.occ.key" class="nc-timed" :style="timedStyle(it)"
              :data-testid="'event-' + it.occ.event.id"
              @mousedown="startDrag($event, it.occ, 'move', { top0: it.top, top: it.top, height: it.height })" @click.stop="clickEvent(it.occ, $event)">
              <div class="nc-timed-title">{{ it.occ.title }} <nc-icon v-if="it.occ.recurring" class="nc-recur" name="repeat" :size="11" :stroke-width="2.5"></nc-icon></div>
              <div v-if="it.height > 34" class="nc-timed-time">{{ time(it.occ.start) }} - {{ time(it.occ.end) }}</div>
              <div class="nc-resize" @mousedown.stop="startDrag($event, it.occ, 'resize', { height0: it.height, height: it.height, top: it.top, top0: it.top })"></div>
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
          :data-testid="'event-' + it.occ.event.id" @click="clickEvent(it.occ, $event)">
          <div class="t">{{ it.occ.title }} <nc-icon v-if="it.occ.recurring" class="nc-recur dark" name="repeat" :size="11" :stroke-width="2.5"></nc-icon></div>
          <div class="w">{{ it.when }}</div>
        </div>
      </div>
    </div>
  </div>
</div>`,
    };
})();

if (typeof window !== 'undefined') window.NativeCalendar = NativeCalendar;
