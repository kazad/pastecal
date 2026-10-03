const df = (typeof window !== 'undefined') ? window.dateFns : null;

// ----------------------------------------------------------------
// Layout (pure functions -- no Vue, no DOM, no date-fns)
// ----------------------------------------------------------------
//
// Everything that decides WHERE an event is drawn lives here, so it can be unit-tested in
// Node (test/unit/nativecal-layout.test.js) and so the month grid, the all-day row and the
// time grid cannot disagree about which days an event covers.
//
// Events reach the grid in nativecal's DISPLAY shape (app.js displayEvents, via
// Event.allDayDisplayRange / CalDate): an all-day event runs from local midnight of its
// first day to local 23:59:59.999 of its last. Day coverage below is "start < dayEnd and
// end > dayStart", so that shape, an exclusive-midnight end, and a timed event that ends
// exactly at midnight all land on the same days the main app and the ICS feed give them.
var NativeCalLayout = (function () {
    const HOUR = 3600 * 1000;
    const DAY = 24 * HOUR;

    // Epoch ms for anything the data might hold (number, ISO string, Date); NaN otherwise.
    function toMs(v) {
        if (typeof v === 'number') return v;
        if (v instanceof Date) return v.getTime();
        if (typeof v === 'string' && v.trim() !== '') {
            const n = Number(v);
            return isNaN(n) ? Date.parse(v) : n;
        }
        return NaN;
    }

    // { start, end } in ms, or null for an event that cannot be placed. A missing or
    // backwards end collapses to the start (drawn as a point, never as a negative box).
    function eventRange(e) {
        if (!e || typeof e !== 'object') return null;
        const start = toMs(e.start);
        if (!isFinite(start)) return null;
        let end = toMs(e.end);
        if (!isFinite(end) || end < start) end = start;
        return { start, end };
    }

    function startOfDay(ms) {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    // Calendar-day arithmetic (DST-safe: a day is not always 24h).
    function addDays(ms, n) {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
    }
    function dayKey(ms) {
        const d = new Date(ms);
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    // Whole days from a to b (both local midnights).
    function dayDiff(a, b) {
        return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
    }

    // First and last local day an event covers (midnights).
    function coveredDays(r) {
        const first = startOfDay(r.start);
        const last = r.end > r.start ? startOfDay(r.end - 1) : first;
        return { first, last: Math.max(first, last) };
    }

    // Drawn as a bar (month bars, the time grid's all-day row) rather than a box in a
    // time column: all-day events, and timed ones lasting a day or more (as Google and
    // Syncfusion do; a three-day conference is not a 72-hour column).
    function isBar(e, r) {
        r = r || eventRange(e);
        return !!(e && e.isAllDay) || (!!r && r.end - r.start >= DAY);
    }

    function overlapsRange(r, rangeStart, rangeEnd) {
        return r.start < rangeEnd && (r.end > rangeStart || (r.end === r.start && r.start >= rangeStart));
    }

    // day key -> events covering that day, for [rangeStart, rangeEnd). Built once per
    // (data, range) change; each cell then does one Map lookup instead of scanning every
    // event in the calendar (the old getEventsForDate: 42 cells x N events per render).
    function buildDayIndex(events, rangeStart, rangeEnd) {
        const index = new Map();
        for (const e of events || []) {
            const r = eventRange(e);
            if (!r || !overlapsRange(r, rangeStart, rangeEnd)) continue;
            const { first, last } = coveredDays(r);
            let day = Math.max(first, startOfDay(rangeStart));
            const stop = Math.min(last, startOfDay(rangeEnd - 1));
            for (let guard = 0; day <= stop && guard < 400; guard++) {
                const k = dayKey(day);
                let list = index.get(k);
                if (!list) index.set(k, list = []);
                list.push(e);
                day = addDays(day, 1);
            }
        }
        return index;
    }

    // Column packing for one day's timed events (the "Tetris" problem).
    //   items: [{ start, end, ... }] in ms (already clipped to the day).
    //   minDuration: the shortest an event is DRAWN (a 5-minute event still gets a
    //   readable box), so two boxes that touch on screen count as overlapping.
    // Events are grouped into clusters of transitively overlapping events; each cluster
    // gets its own column count, so a lone event beside an unrelated busy morning keeps
    // full width. Each event then widens rightwards over columns that are free for its
    // whole span. Returns [{ item, col, cols, span, left, width }] with left/width in
    // fractions of the day column.
    function layoutTimedDay(items, minDuration) {
        minDuration = minDuration || 0;
        const evs = (items || []).map((item) => ({
            item,
            s: item.start,
            e: Math.max(item.end, item.start + minDuration),
        })).sort((a, b) => a.s - b.s || b.e - a.e);

        const out = [];
        let cluster = [];
        let clusterEnd = -Infinity;
        const flush = () => {
            if (!cluster.length) return;
            const colEnds = [];
            const columns = [];
            for (const ev of cluster) {
                let c = colEnds.findIndex((end) => end <= ev.s);
                if (c === -1) { c = colEnds.length; colEnds.push(ev.e); columns.push([]); }
                else colEnds[c] = ev.e;
                columns[c].push(ev);
                ev.col = c;
            }
            const cols = columns.length;
            for (const ev of cluster) {
                let span = 1;
                for (let c = ev.col + 1; c < cols; c++) {
                    if (columns[c].some((o) => o.s < ev.e && o.e > ev.s)) break;
                    span++;
                }
                out.push({ item: ev.item, col: ev.col, cols, span, left: ev.col / cols, width: span / cols });
            }
            cluster = [];
            clusterEnd = -Infinity;
        };
        for (const ev of evs) {
            if (ev.s >= clusterEnd) flush();
            cluster.push(ev);
            clusterEnd = Math.max(clusterEnd, ev.e);
        }
        flush();
        return out;
    }

    // Bars for one row of consecutive days (a month week, or the time grid's all-day row).
    //   events:   candidates (anything not covering a row day is skipped)
    //   rowStart: local midnight of the row's first day; days: row length
    //   maxLanes: lanes that fit (Infinity for no cap)
    // Returns { bars: [{ event, startCol, span, lane, continuesBefore, continuesAfter }],
    //           more: [hidden count per day], lanes: lanes used by visible bars }.
    // When a day has more than fits, its last lane becomes "+N more"; a bar in that lane
    // that crosses such a day is hidden too (and counted on every day it covers), so a
    // bar never runs under a "+N more" label.
    function layoutBars(events, rowStart, days, maxLanes) {
        days = days || 7;
        if (!(maxLanes >= 1)) maxLanes = 1;
        const rowEnd = addDays(rowStart, days);
        const segs = [];
        const seen = new Set();
        for (const event of events || []) {
            if (seen.has(event)) continue;
            seen.add(event);
            const r = eventRange(event);
            if (!r || !overlapsRange(r, rowStart, rowEnd)) continue;
            const { first, last } = coveredDays(r);
            const startCol = Math.max(0, dayDiff(rowStart, first));
            const endCol = Math.min(days - 1, dayDiff(rowStart, last));
            if (endCol < startCol) continue;
            segs.push({
                event, r, startCol, span: endCol - startCol + 1,
                continuesBefore: first < rowStart,
                continuesAfter: last >= rowEnd,
                allDay: !!event.isAllDay,
            });
        }
        // Longest first so spans stay on low lanes; then all-day before timed; then time.
        segs.sort((a, b) => b.span - a.span || (b.allDay - a.allDay) || a.r.start - b.r.start
            || (b.r.end - b.r.start) - (a.r.end - a.r.start));

        const laneUse = []; // laneUse[lane][col] = true
        for (const s of segs) {
            let lane = 0;
            for (;; lane++) {
                const used = laneUse[lane] || (laneUse[lane] = []);
                let free = true;
                for (let c = s.startCol; c < s.startCol + s.span; c++) if (used[c]) { free = false; break; }
                if (free) {
                    for (let c = s.startCol; c < s.startCol + s.span; c++) used[c] = true;
                    break;
                }
            }
            s.lane = lane;
        }

        const covers = (s, c) => c >= s.startCol && c < s.startCol + s.span;
        const overflowing = new Array(days).fill(false);
        for (const s of segs) {
            if (s.lane >= maxLanes) for (let c = s.startCol; c < s.startCol + s.span; c++) overflowing[c] = true;
        }
        const more = new Array(days).fill(0);
        const bars = [];
        let lanes = 0;
        for (const s of segs) {
            let hidden = s.lane >= maxLanes;
            if (!hidden && s.lane === maxLanes - 1) {
                for (let c = s.startCol; c < s.startCol + s.span; c++) if (overflowing[c]) { hidden = true; break; }
            }
            if (hidden) {
                for (let c = 0; c < days; c++) if (covers(s, c)) more[c]++;
            } else {
                bars.push({ event: s.event, startCol: s.startCol, span: s.span, lane: s.lane,
                    continuesBefore: s.continuesBefore, continuesAfter: s.continuesAfter });
                lanes = Math.max(lanes, s.lane + 1);
            }
        }
        if (more.some((n) => n > 0)) lanes = maxLanes;
        return { bars, more, lanes };
    }

    // "9 AM", "9:30 AM", "13:05" -- no leading zeros, minutes only when they say something
    // (12-hour). 24-hour keeps its minutes: "9:00".
    function formatTime(ms, fmt, opts) {
        const d = new Date(ms);
        if (isNaN(d.getTime())) return '';
        const h = d.getHours();
        const m = String(d.getMinutes()).padStart(2, '0');
        if (fmt === '24') return h + ':' + m;
        const h12 = h % 12 === 0 ? 12 : h % 12;
        const ap = h < 12 ? 'AM' : 'PM';
        const hm = (opts && opts.compact && m === '00') ? String(h12) : h12 + ':' + m;
        return (opts && opts.noMeridiem) ? hm : hm + ' ' + ap;
    }
    // "9 – 10:30 AM", "11 AM – 1 PM", "9:00 – 17:30" (en dash).
    function formatRange(start, end, fmt) {
        const a = new Date(start), b = new Date(end);
        if (isNaN(a.getTime())) return '';
        if (isNaN(b.getTime()) || end <= start) return formatTime(start, fmt, { compact: true });
        if (fmt === '24') return formatTime(start, fmt) + ' – ' + formatTime(end, fmt);
        const sameHalf = (a.getHours() < 12) === (b.getHours() < 12) && b - a < DAY;
        return formatTime(start, fmt, { compact: true, noMeridiem: sameHalf }) + ' – ' + formatTime(end, fmt, { compact: true });
    }

    const COLORS = ['#3f51b5', '#e3165b', '#ff6652', '#4caf50', '#ff9800', '#03a9f4', '#9e9e9e', '#27282f'];
    // Stored `type` is a 1-based colour slot; anything else (0, -3, 1e9, "x") still gets a colour.
    function colorFor(type) {
        let n = parseInt(type, 10);
        if (!(n >= 1)) n = 1;
        return COLORS[(n - 1) % COLORS.length];
    }
    function titleOf(e) {
        const t = e && e.title;
        if (typeof t === 'string' && t.trim()) return t;
        if (typeof t === 'number') return String(t);
        return '(No title)';
    }

    return { HOUR, DAY, toMs, eventRange, startOfDay, addDays, dayKey, dayDiff, coveredDays, isBar,
        overlapsRange, buildDayIndex, layoutTimedDay, layoutBars, formatTime, formatRange,
        colorFor, titleOf, COLORS };
})();

// Phones get the list view: a 7-column grid at 375px is ~50px per day.
const NC_NARROW_QUERY = '(max-width: 639px)';
const NC_DATE_ROW = 26;   // px: date-number row of a month week
const NC_LANE = 20;       // px: one bar lane (month and all-day row)
const NC_MIN_DRAWN_MINUTES = 25; // shortest timed event box, in minutes of grid height

// Measured, never assumed: the hour height lives in CSS (--nc-hour-height, native.css),
// so labels, rows, events and pointer maths all read the same number.
function ncHourPx(colEl) {
    const h = colEl ? colEl.getBoundingClientRect().height / 24 : 0;
    return h > 0 ? h : 48;
}

// Day column/cell under the pointer (bars and cards sit above the cells).
function ncDateUnderPointer(x, y, selector) {
    if (typeof document === 'undefined' || !document.elementsFromPoint) return null;
    const el = document.elementsFromPoint(x, y).find((n) => n.matches && n.matches(selector));
    return el ? { el, date: new Date(el.getAttribute('data-date')) } : null;
}

// ----------------------------------------------------------------
// Sub-Components
// ----------------------------------------------------------------

const CalendarToolbar = {
    template: /* html */ `
        <div class="nc-toolbar border-b border-color-default bg-1 flex-shrink-0" data-testid="nc-toolbar">
            <div class="nc-toolbar-nav">
                <!-- Date Nav -->
                <div class="flex items-center bg-2 rounded-lg p-0.5 flex-shrink-0">
                    <button @click="$emit('prev')" data-testid="nav-prev" aria-label="Previous" class="px-2 hover:bg-1 rounded-md h-7 flex items-center text-color-1 text-lg leading-none mb-0.5">&lsaquo;</button>
                    <button @click="$emit('today')" data-testid="nav-today" class="px-3 text-xs font-bold hover:bg-1 rounded-md h-7 text-color-2 uppercase tracking-wide">Today</button>
                    <button @click="$emit('next')" data-testid="nav-next" aria-label="Next" class="px-2 hover:bg-1 rounded-md h-7 flex items-center text-color-1 text-lg leading-none mb-0.5">&rsaquo;</button>
                </div>
                <!-- Date Range -->
                <div class="nc-toolbar-title font-medium text-color-2" data-testid="current-date-range">{{ currentTitle }}</div>
            </div>

            <!-- View Switcher -->
            <div class="nc-view-switcher bg-2 rounded-lg p-0.5" data-testid="view-switcher" role="group" aria-label="View">
                <button v-for="view in views"
                    :key="view"
                    :aria-pressed="currentView === view"
                    @click="$emit('change-view', view)"
                    :data-testid="'view-' + view.toLowerCase()"
                    :class="['px-3 py-1 rounded-md text-xs font-medium transition-all', currentView === view ? 'bg-1 text-blue-600 shadow-sm' : 'text-color-1 hover:text-color-2']">
                    {{ view }}
                </button>
            </div>
        </div>
    `,
    props: ['currentTitle', 'currentView', 'views'],
    emits: ['prev', 'next', 'today', 'change-view']
};

const MonthView = {
    template: /* html */ `
        <div class="nc-month bg-1" data-testid="month-view" :class="{ 'nc-readonly': readOnly }">
            <div class="nc-month-head" data-testid="month-view-head">
                <div v-for="day in weekDays" :key="day" class="nc-month-head-cell text-color-1">{{ day }}</div>
            </div>
            <div class="nc-month-body calendar-grid" data-testid="month-view-grid" ref="body">
                <div v-for="(week, w) in weeks" :key="week.key" class="nc-week"
                     :style="{ gridTemplateRows: rowTemplate }" :data-testid="'month-week-' + w">
                    <div v-for="(cell, c) in week.cells" :key="cell.key"
                         class="calendar-cell nc-day"
                         :class="{ 'opacity-50 nc-day-outside': !cell.isCurrentMonth, 'nc-day-today': cell.isToday }"
                         :style="{ gridColumn: (c + 1) }"
                         :data-date="cell.date.toISOString()"
                         :data-testid="'month-cell-' + (w * 7 + c)"
                         @click="$emit('create-event', cell.date, $event)">
                        <span class="nc-day-num" :class="cell.isToday ? 'bg-blue-600 text-white' : 'text-color-2'">{{ cell.dayNumber }}</span>
                    </div>

                    <!-- Ghost for the event being created -->
                    <div v-if="ghostCol(week) !== -1"
                         class="nc-bar nc-ghost text-color-1"
                         :style="{ gridColumn: (ghostCol(week) + 1), gridRow: 2 }">New Event</div>

                    <div v-for="bar in week.layout.bars" :key="bar.key"
                         class="nc-bar"
                         :class="{ 'is-dragging': dragState.eventId === bar.event.id, 'nc-bar-cont-before': bar.continuesBefore, 'nc-bar-cont-after': bar.continuesAfter, 'nc-bar-timed': !bar.isBlock }"
                         :style="[barStyle(bar), { gridColumn: (bar.startCol + 1) + ' / span ' + bar.span, gridRow: bar.lane + 2 }]"
                         :data-testid="'event-' + bar.event.id"
                         :title="bar.tooltip"
                         @mousedown.stop="$emit('start-drag', bar.event, $event, 'month-move')"
                         @click.stop="$emit('select-event', bar.event, $event)">
                        <span v-if="!bar.isBlock" class="nc-dot" :style="{ backgroundColor: bar.color }"></span>
                        <span v-if="bar.time" class="nc-chip-time">{{ bar.time }}</span>
                        <span class="nc-chip-title"><span v-if="bar.event.isRecurringInstance" class="nc-recur">↻ </span>{{ bar.title }}</span>
                    </div>

                    <template v-for="(n, c) in week.layout.more" :key="'more' + c">
                        <button v-if="n > 0" type="button" class="nc-more text-color-1"
                                :style="{ gridColumn: (c + 1), gridRow: (maxLanes + 1) }"
                                :data-testid="'month-more-' + (w * 7 + c)"
                                @click.stop="$emit('show-day', week.cells[c].date)">+{{ n }}<span class="nc-more-word"> more</span></button>
                    </template>
                </div>
            </div>
        </div>
    `,
    props: ['weeks', 'weekDays', 'dragState', 'maxLanes', 'creatingEvent', 'readOnly', 'timeFormat'],
    emits: ['create-event', 'start-drag', 'select-event', 'show-day', 'resize-lanes'],
    computed: {
        rowTemplate() {
            return NC_DATE_ROW + 'px repeat(' + this.maxLanes + ', ' + NC_LANE + 'px) minmax(0, 1fr)';
        }
    },
    methods: {
        ghostCol(week) {
            const ev = this.creatingEvent;
            if (!ev || !ev.isAllDay) return -1;
            const key = NativeCalLayout.dayKey(NativeCalLayout.toMs(ev.start));
            return week.cells.findIndex((c) => c.key === key);
        },
        barStyle(bar) {
            return bar.isBlock
                ? { backgroundColor: bar.color, color: '#fff' }
                : { color: 'var(--fg, inherit)' };
        },
        measure() {
            const week = this.$refs.body && this.$refs.body.querySelector('.nc-week');
            if (!week) return;
            const h = week.getBoundingClientRect().height;
            // date row + lanes; the last lane doubles as "+N more" when a day overflows.
            const lanes = Math.max(1, Math.floor((h - NC_DATE_ROW - 2) / NC_LANE));
            this.$emit('resize-lanes', lanes);
        }
    },
    mounted() {
        this.measure();
        if (typeof ResizeObserver !== 'undefined') {
            this._ro = new ResizeObserver(() => this.measure());
            this._ro.observe(this.$refs.body);
        }
    },
    unmounted() {
        if (this._ro) this._ro.disconnect();
    }
};

const TimeGridView = {
    template: /* html */ `
        <div class="nc-timegrid bg-1" :class="{ 'nc-readonly': readOnly }" data-testid="time-grid">
            <div class="nc-tg-head border-b border-color-default bg-1" :style="{ gridTemplateColumns: cols }">
                <div class="nc-tg-gutter"></div>
                <div v-for="(date, idx) in visibleDates" :key="idx" class="nc-tg-head-cell" :data-testid="'time-head-' + idx">
                    <div class="text-xs font-semibold text-color-1 uppercase">{{ weekDays[date.getDay()] }}</div>
                    <div class="nc-tg-head-num text-color-2" :class="{'bg-blue-600 text-white font-bold': isToday(date)}">{{ date.getDate() }}</div>
                </div>
            </div>

            <!-- All-day / multi-day row: bars span the columns they cover -->
            <div class="nc-allday border-b border-color-default bg-1" data-testid="all-day-row"
                 :style="{ gridTemplateColumns: cols, gridTemplateRows: 'repeat(' + Math.max(1, allDay.lanes) + ', ' + laneHeight + 'px)' }">
                <div class="nc-tg-gutter nc-allday-label text-color-1" :style="{ gridRow: '1 / -1' }">all-day</div>
                <div v-for="(date, idx) in visibleDates" :key="'ad' + idx" class="nc-allday-cell"
                     :style="{ gridColumn: idx + 2, gridRow: '1 / -1' }"
                     :data-date="date.toISOString()"
                     @click="$emit('create-all-day', date, $event)"></div>
                <div v-for="bar in allDay.bars" :key="bar.key"
                     class="nc-bar"
                     :class="{ 'nc-bar-cont-before': bar.continuesBefore, 'nc-bar-cont-after': bar.continuesAfter }"
                     :style="{ gridColumn: (bar.startCol + 2) + ' / span ' + bar.span, gridRow: bar.lane + 1, backgroundColor: bar.color, color: '#fff' }"
                     :data-testid="'event-' + bar.event.id"
                     :title="bar.tooltip"
                     @click.stop="$emit('select-event', bar.event, $event)">
                    <span class="nc-chip-title"><span v-if="bar.event.isRecurringInstance" class="nc-recur">↻ </span>{{ bar.title }}</span>
                </div>
                <template v-for="(n, c) in allDay.more" :key="'admore' + c">
                    <button v-if="n > 0" type="button" class="nc-more text-color-1"
                            :style="{ gridColumn: c + 2, gridRow: allDay.lanes }"
                            @click.stop="$emit('show-day', visibleDates[c])">+{{ n }}<span class="nc-more-word"> more</span></button>
                </template>
            </div>

            <div class="nc-tg-scroll" ref="timeScroll">
                <div class="time-grid nc-tg-body" :style="{ gridTemplateColumns: cols }">
                    <div class="nc-tg-gutter nc-tg-labels text-color-1" data-testid="hour-labels">
                        <div v-for="h in 23" :key="h" class="nc-hour-label" :style="{ '--h': h }" :data-hour="h">
                            {{ formatHourLabel(h) }}
                        </div>
                    </div>

                    <div v-for="(date, idx) in visibleDates" :key="idx"
                         class="time-col"
                         :data-date="date.toISOString()"
                         :data-testid="'time-col-' + idx"
                         @click="$emit('create-time-event', date, $event)">

                        <div v-for="h in 24" :key="h" class="hour-row"></div>

                        <div v-if="isToday(date)" class="nc-now" :style="{ '--h': nowHours }">
                            <div class="nc-now-dot"></div>
                        </div>

                        <!-- Ghost for the event being created -->
                        <div v-if="creatingEvent && !creatingEvent.isAllDay && isSameDay(date, new Date(creatingEvent.start))"
                             class="nc-card-ghost text-color-1"
                             :style="ghostStyle(creatingEvent)">New Event</div>

                        <div v-for="box in timedLayout[idx]" :key="box.key"
                             class="event-card nc-card"
                             :class="{
                                 'dragging-active': dragState.eventId === box.event.id && dragState.isDragging,
                                 'dragging-move-active': dragState.eventId === box.event.id && dragState.isDragging && dragState.action === 'time-move',
                                 'nc-card-selected': selectedEventId === box.event.id,
                                 'nc-card-short': box.short
                             }"
                             :style="box.style"
                             :data-testid="'event-' + box.event.id"
                             :data-col="box.col" :data-cols="box.cols"
                             :title="box.tooltip"
                             @mousedown.stop="$emit('start-drag', box.event, $event, 'time-move')"
                             @click.stop="$emit('select-event', box.event, $event)">
                            <div class="nc-card-title"><span v-if="box.event.isRecurringInstance">↻ </span>{{ box.title }}</div>
                            <div class="nc-card-time">{{ box.time }}</div>
                            <div v-if="!readOnly && !box.event.isRecurringInstance && !box.clippedEnd" class="resize-handle"
                                 @mousedown.stop="$emit('start-drag', box.event, $event, 'resize')"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `,
    props: [
        'visibleDates', 'weekDays', 'isToday', 'nowHours', 'dragState', 'selectedEventId',
        'timedLayout', 'allDay', 'formatHourLabel', 'isSameDay', 'creatingEvent', 'readOnly'
    ],
    emits: ['create-time-event', 'create-all-day', 'start-drag', 'select-event', 'show-day'],
    computed: {
        cols() {
            return 'var(--nc-gutter) repeat(' + this.visibleDates.length + ', minmax(0, 1fr))';
        },
        laneHeight() { return NC_LANE + 2; }
    },
    methods: {
        ghostStyle(evt) {
            const s = new Date(evt.start), e = new Date(evt.end);
            const startH = s.getHours() + s.getMinutes() / 60;
            const durH = Math.max((e - s) / NativeCalLayout.HOUR, 0.5);
            return { '--top': startH, '--dur': Math.min(durH, 24 - startH) };
        }
    },
    mounted() {
        // Open on the working day, not on midnight.
        const el = this.$refs.timeScroll;
        const col = el && el.querySelector('.time-col');
        if (el) el.scrollTop = 7 * ncHourPx(col) - 12;
    }
};

// ----------------------------------------------------------------
// Main NativeCalendar Component
// ----------------------------------------------------------------

var NativeCalendar = {
    components: {
        'calendar-toolbar': CalendarToolbar,
        'month-view': MonthView,
        'time-grid-view': TimeGridView,
        'year-view': {
            template: /* html */ `
                <div class="h-full overflow-auto bg-1 p-4">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div v-for="month in months" :key="month.key"
                             class="rounded-xl border border-color-default bg-2 shadow-sm hover:shadow-md transition-all cursor-pointer p-3"
                             @click="$emit('jump-to-month', month.date)">
                            <div class="flex items-center justify-between mb-2">
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-color-1">{{ month.year }}</p>
                                    <p class="text-lg font-bold text-color-2">{{ month.label }}</p>
                                </div>
                                <span class="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                                      :class="month.isCurrent ? 'bg-blue-600 text-white' : 'bg-1 text-color-1 border border-color-default'">
                                    {{ month.count }} events
                                </span>
                            </div>
                            <div class="grid grid-cols-7 gap-1 text-[10px] text-color-1 mb-2">
                                <span v-for="(day, i) in month.weekLabels" :key="i" class="text-center uppercase tracking-wide">{{ day }}</span>
                            </div>
                            <div class="grid grid-cols-7 gap-1 text-[10px] leading-5">
                                <span v-for="day in month.previewDays" :key="day.key"
                                      class="rounded px-1 text-center"
                                      :class="day.isToday ? 'bg-blue-600 text-white font-bold' : (day.isCurrentMonth ? 'bg-1 text-color-2' : 'text-color-1 bg-transparent')">
                                    {{ day.label }}
                                </span>
                            </div>
                            <div class="flex gap-1 mt-3">
                                <span v-for="(color, idx) in month.topColors" :key="idx" class="w-2.5 h-2.5 rounded-full" :style="{ backgroundColor: color }"></span>
                                <span v-if="!month.topColors.length" class="text-xs text-color-1">No events yet</span>
                            </div>
                        </div>
                    </div>
                </div>
            `,
            props: ['months'],
            emits: ['jump-to-month']
        },
        'agenda-view': {
            template: /* html */ `
                <div class="h-full overflow-auto bg-1 p-2 sm:p-4 space-y-3" data-testid="agenda-view">
                    <div v-if="!agenda.length" class="rounded-xl border border-color-default bg-2 p-6 text-center text-color-1">
                        No events in these two weeks.
                    </div>
                    <div v-for="section in agenda" :key="section.key" class="rounded-xl border border-color-default bg-2 shadow-sm overflow-hidden">
                        <div class="px-4 py-3 flex items-center justify-between border-b border-color-default">
                            <div>
                                <p class="text-[11px] uppercase tracking-wide text-color-1">{{ section.weekday }}</p>
                                <p class="text-lg font-bold text-color-2">{{ section.label }}</p>
                            </div>
                            <span class="text-[11px] px-3 py-1 rounded-full bg-1 text-color-1 border border-color-default">{{ section.events.length }} {{ section.events.length === 1 ? 'item' : 'items' }}</span>
                        </div>
                        <div class="divide-y divide-color-default">
                            <div v-for="evt in section.events" :key="evt.key"
                                 class="px-4 py-3 flex items-center gap-3 cursor-pointer min-w-0"
                                 :data-testid="'agenda-event-' + evt.event.id"
                                 @click="$emit('select-event', evt.event, $event)">
                                <span class="w-2 h-2 rounded-full flex-shrink-0" :style="{ backgroundColor: evt.color }"></span>
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-semibold text-color-2 truncate">{{ evt.title }}</p>
                                    <p class="text-xs text-color-1">{{ evt.timeLabel }}</p>
                                </div>
                                <span v-if="evt.isAllDay" class="text-[11px] px-2 py-1 rounded-full bg-1 border border-color-default text-color-1 flex-shrink-0">All day</span>
                            </div>
                        </div>
                    </div>
                </div>
            `,
            props: ['agenda'],
            emits: ['select-event']
        }
    },
    template: /* html */ `
        <div class="nc-root flex flex-col w-full bg-1" ref="root" :style="rootStyle" :class="{ 'nc-readonly': readOnly }" data-testid="native-calendar">
            <calendar-toolbar
                :current-title="currentTitle"
                :current-view="currentView"
                :views="views"
                @prev="prev"
                @next="next"
                @today="today"
                @change-view="changeView">
            </calendar-toolbar>

            <div class="flex-1 overflow-hidden relative min-h-0">
                <month-view v-if="currentView === 'Month'"
                    :weeks="monthWeeks"
                    :week-days="weekDays"
                    :drag-state="dragState"
                    :max-lanes="monthLanes"
                    :creating-event="creatingEvent"
                    :read-only="readOnly"
                    @create-event="createMonthEvent"
                    @start-drag="startDrag"
                    @select-event="selectEvent"
                    @show-day="showDay"
                    @resize-lanes="monthLanes = $event">
                </month-view>

                <time-grid-view v-if="currentView === 'Week' || currentView === 'Day'"
                    :key="currentView"
                    :visible-dates="visibleDates"
                    :week-days="weekDays"
                    :is-today="isToday"
                    :now-hours="nowHours"
                    :drag-state="dragState"
                    :selected-event-id="selectedEventId"
                    :timed-layout="timedLayout"
                    :all-day="allDayLayout"
                    :format-hour-label="formatHourLabel"
                    :is-same-day="isSameDay"
                    :creating-event="creatingEvent"
                    :read-only="readOnly"
                    @create-time-event="createTimeEvent"
                    @create-all-day="createMonthEvent"
                    @start-drag="startDrag"
                    @select-event="selectEvent"
                    @show-day="showDay">
                </time-grid-view>

                <year-view v-if="currentView === 'Year'"
                    :months="yearMonths"
                    @jump-to-month="goToMonth">
                </year-view>

                <agenda-view v-if="currentView === 'Agenda'"
                    :agenda="agendaSections"
                    @select-event="selectEvent">
                </agenda-view>

                <!-- Drag Ghost -->
                <div v-if="dragState.isDragging && dragState.action === 'month-move' && dragState.ghostEvent"
                     class="drag-ghost px-2 py-1 text-xs rounded text-white font-bold truncate w-32 pointer-events-none"
                     :style="[getEventStyle(dragState.ghostEvent), { left: dragState.mouseX + 'px', top: dragState.mouseY + 'px' }]">
                    {{ titleOf(dragState.ghostEvent) }}
                </div>
            </div>
        </div>
    `,
    props: {
        events: { type: Array, default: () => [] },
        timeFormat: { type: String, default: '12' },
        creatingEvent: { type: Object, default: null },
        // A /view/ link: no create, drag or resize affordances; clicking an event still
        // shows it.
        readOnly: { type: Boolean, default: false },
        // Initial view; when omitted, phones get Agenda and everything else Month.
        initialView: { type: String, default: '' },
    },
    // navigate: the view or date changed -- the host closes anything anchored to the old
    // grid (the "New Event" popover, an event popover).
    emits: ['update:events', 'event-click', 'event-create', 'navigate'],
    /**
     * @param {NativeCalendarProps} props
     * @param {Object} context
     * @param {(event: string, ...args: any[]) => void} context.emit
     */
    setup(props, { emit }) {
        const { ref, computed, onMounted, onUnmounted, watch } = Vue;
        const L = NativeCalLayout;

        const views = ['Day', 'Week', 'Month', 'Year', 'Agenda'];
        const isNarrow = () => typeof window !== 'undefined' && window.matchMedia
            && window.matchMedia(NC_NARROW_QUERY).matches;
        const currentView = ref(views.includes(props.initialView) ? props.initialView
            : (isNarrow() ? 'Agenda' : 'Month'));
        const currentDate = ref(currentView.value === 'Agenda' ? df.startOfDay(new Date()) : new Date());
        const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const selectedEventId = ref(null);
        const monthLanes = ref(3);

        // Drag State
        const dragState = ref({
            eventId: null, isDragging: false, wasDragging: false, startY: 0,
            originalStart: 0, originalEnd: 0, action: 'move', ghostEvent: null,
            mouseX: 0, mouseY: 0, fromDate: null, hourPx: 48
        });

        // Date Logic
        const fmtDay = (d) => df.format(d, 'MMM d');
        const currentTitle = computed(() => {
            const d = currentDate.value;
            if (currentView.value === 'Day') return df.format(d, 'EEE, MMMM d, yyyy');
            if (currentView.value === 'Week') {
                const start = df.startOfWeek(d);
                return fmtDay(start) + ' – ' + fmtDay(df.endOfWeek(d)) + ', ' + df.format(df.endOfWeek(d), 'yyyy');
            }
            if (currentView.value === 'Agenda') return fmtDay(d) + ' – ' + fmtDay(df.addDays(d, 13));
            if (currentView.value === 'Year') return df.format(d, 'yyyy');
            return df.format(d, 'MMMM yyyy');
        });

        const isToday = (date) => df.isSameDay(date, new Date());
        const isSameDay = (d1, d2) => df.isSameDay(d1, d2);

        // Navigation
        const changeView = (view) => {
            if (view === 'Year') currentDate.value = df.startOfYear(currentDate.value);
            else if (view === 'Agenda') currentDate.value = df.startOfDay(currentDate.value);
            currentView.value = view;
        };
        const step = (dir) => {
            const d = currentDate.value, v = currentView.value;
            if (v === 'Month') currentDate.value = df.addMonths(df.startOfMonth(d), dir);
            else if (v === 'Week') currentDate.value = df.addWeeks(d, dir);
            else if (v === 'Year') currentDate.value = df.addYears(d, dir);
            else if (v === 'Agenda') currentDate.value = df.addDays(d, 14 * dir);
            else currentDate.value = df.addDays(d, dir);
        };
        const prev = () => step(-1);
        const next = () => step(1);
        const today = () => { currentDate.value = currentView.value === 'Agenda' ? df.startOfDay(new Date()) : new Date(); };
        const goToMonth = (date) => {
            currentDate.value = df.startOfMonth(date);
            currentView.value = 'Month';
        };
        const showDay = (date) => {
            currentDate.value = new Date(date);
            currentView.value = 'Day';
        };

        watch([currentView, currentDate], () => {
            selectedEventId.value = null;
            emit('navigate', { view: currentView.value, date: currentDate.value });
        });

        // Grid Logic
        const monthGridStart = computed(() => df.startOfWeek(df.startOfMonth(currentDate.value)));

        const visibleDates = computed(() => {
            if (currentView.value === 'Day') return [df.startOfDay(currentDate.value)];
            if (currentView.value === 'Week') {
                const start = df.startOfWeek(currentDate.value);
                return Array.from({ length: 7 }, (_, i) => df.addDays(start, i));
            }
            if (currentView.value === 'Agenda') {
                const start = df.startOfDay(currentDate.value);
                return Array.from({ length: 14 }, (_, i) => df.addDays(start, i));
            }
            return [];
        });

        // The instants this view can show: [start, end). Everything below is limited to it.
        const visibleRange = computed(() => {
            const v = currentView.value;
            if (v === 'Month') {
                const start = monthGridStart.value.getTime();
                return { start, end: L.addDays(start, 42) };
            }
            if (v === 'Year') {
                const start = df.startOfYear(currentDate.value).getTime();
                return { start, end: df.addYears(start, 1).getTime() };
            }
            const dates = visibleDates.value;
            const start = dates[0].getTime();
            return { start, end: L.addDays(start, dates.length) };
        });

        // Events in the visible range: series expanded, one-offs filtered (they used to pass
        // through whole, so every render touched every event the calendar ever had).
        const processedEvents = computed(() => {
            const { start, end } = visibleRange.value;
            // A day's padding each side so expansion near an edge (zones, long spans) is safe.
            const rangeStart = new Date(L.addDays(start, -1)), rangeEnd = new Date(L.addDays(end, 1));
            const results = [];
            for (const event of props.events || []) {
                if (!event || typeof event !== 'object') continue;
                // A row with a recurrenceID is one edited occurrence of its parent -- it carries
                // the parent's rule, but is drawn once, where it now is.
                if (event.recurrencerule && !event.recurrenceID && typeof window !== 'undefined' && window.rrule) {
                    try {
                        for (const occ of Event.expandOccurrences(event, rangeStart, rangeEnd, window.rrule)) {
                            const r = L.eventRange(occ);
                            if (r && L.overlapsRange(r, start, end)) results.push(occ);
                        }
                        continue;
                    } catch (e) {
                        console.warn('[NativeCalendar] Recurrence error for event', event.title, e);
                    }
                }
                const r = L.eventRange(event);
                if (r && L.overlapsRange(r, start, end)) results.push(event);
            }
            return results;
        });

        const dayIndex = computed(() => {
            const { start, end } = visibleRange.value;
            return L.buildDayIndex(processedEvents.value, start, end);
        });
        const getEventsForDate = (date) => dayIndex.value.get(L.dayKey(date.getTime())) || [];

        const formatTime = (ms) => L.formatTime(L.toMs(ms), props.timeFormat);
        const formatHourLabel = (h) => {
            const d = new Date(2000, 0, 1, h);
            return props.timeFormat === '24' ? h + ':00' : L.formatTime(d.getTime(), '12', { compact: true });
        };
        const titleOf = L.titleOf;
        const colorOf = (e) => L.colorFor(e && e.type);
        const tooltipOf = (e) => {
            const r = L.eventRange(e);
            if (!r) return titleOf(e);
            const when = e.isAllDay ? 'All day' : L.formatRange(r.start, r.end, props.timeFormat);
            return titleOf(e) + ' (' + when + ')';
        };
        const barKey = (e, suffix) => (e.id != null ? String(e.id) : '') + '@' + L.toMs(e.start) + (suffix || '');

        const decorateBar = (bar, rowKey) => {
            const e = bar.event;
            const r = L.eventRange(e);
            const isBlock = L.isBar(e, r) || bar.span > 1;
            return {
                ...bar,
                key: barKey(e, rowKey),
                isBlock,
                color: colorOf(e),
                title: titleOf(e),
                tooltip: tooltipOf(e),
                // Timed chips lead with their start time (only where the event starts).
                time: !isBlock && !bar.continuesBefore ? L.formatTime(r.start, props.timeFormat, { compact: true }) : '',
            };
        };

        // Month: 6 week rows, each with its bars laid out and capped to the lanes that fit.
        const monthWeeks = computed(() => {
            if (currentView.value !== 'Month') return [];
            const month = currentDate.value.getMonth();
            const lanes = monthLanes.value;
            const index = dayIndex.value;
            const now = new Date();
            const weeks = [];
            for (let w = 0; w < 6; w++) {
                const rowStart = L.addDays(monthGridStart.value.getTime(), w * 7);
                const cells = [];
                const candidates = [];
                for (let c = 0; c < 7; c++) {
                    const ms = L.addDays(rowStart, c);
                    const date = new Date(ms);
                    const key = L.dayKey(ms);
                    cells.push({ date, key, dayNumber: date.getDate(), isCurrentMonth: date.getMonth() === month,
                        isToday: df.isSameDay(date, now) });
                    const list = index.get(key);
                    if (list) candidates.push(...list);
                }
                const layout = L.layoutBars(candidates, rowStart, 7, lanes);
                layout.bars = layout.bars.map((b) => decorateBar(b, '#w' + w));
                weeks.push({ key: L.dayKey(rowStart), cells, layout });
            }
            return weeks;
        });

        // Time grid: bars (all-day, a day or longer) in the all-day row ...
        const allDayLayout = computed(() => {
            const dates = visibleDates.value;
            if (!(currentView.value === 'Week' || currentView.value === 'Day')) return { bars: [], more: [], lanes: 0 };
            const rowStart = dates[0].getTime();
            const candidates = [];
            for (const d of dates) for (const e of getEventsForDate(d)) if (L.isBar(e)) candidates.push(e);
            const layout = L.layoutBars(candidates, rowStart, dates.length, currentView.value === 'Day' ? Infinity : 3);
            layout.bars = layout.bars.map((b) => decorateBar(b, '#ad'));
            return layout;
        });

        // ... everything else as boxes in its day's column, clipped to the day, packed.
        const timedLayout = computed(() => {
            if (!(currentView.value === 'Week' || currentView.value === 'Day')) return [];
            return visibleDates.value.map((date) => {
                const dayStart = date.getTime(), dayEnd = L.addDays(dayStart, 1);
                const items = [];
                for (const e of getEventsForDate(date)) {
                    const r = L.eventRange(e);
                    if (!r || L.isBar(e, r)) continue;
                    items.push({ event: e, start: Math.max(r.start, dayStart), end: Math.min(r.end, dayEnd),
                        clippedStart: r.start < dayStart, clippedEnd: r.end > dayEnd, r });
                }
                return L.layoutTimedDay(items, NC_MIN_DRAWN_MINUTES * 60000).map((p) => {
                    const it = p.item;
                    const top = (it.start - dayStart) / L.HOUR;
                    const dur = Math.max((it.end - it.start) / L.HOUR, NC_MIN_DRAWN_MINUTES / 60);
                    const color = colorOf(it.event);
                    return {
                        event: it.event, col: p.col, cols: p.cols,
                        key: barKey(it.event, '#' + L.dayKey(dayStart)),
                        clippedEnd: it.clippedEnd,
                        short: (it.end - it.start) < 45 * 60000,
                        title: titleOf(it.event),
                        tooltip: tooltipOf(it.event),
                        time: L.formatRange(it.r.start, it.r.end, props.timeFormat),
                        style: {
                            '--top': top, '--dur': Math.min(dur, 24 - top),
                            '--left': p.left, '--width': p.width,
                            borderLeftColor: color, backgroundColor: color + '22', color: color,
                        },
                    };
                });
            });
        });

        const yearMonths = computed(() => {
            if (currentView.value !== 'Year') return [];
            const startOfYear = df.startOfYear(currentDate.value);
            const today = new Date();
            // One pass to bucket by month instead of 12 scans.
            const buckets = Array.from({ length: 12 }, () => []);
            const y = startOfYear.getFullYear();
            for (const ev of processedEvents.value) {
                const d = new Date(L.toMs(ev.start));
                if (d.getFullYear() === y) buckets[d.getMonth()].push(ev);
            }
            return Array.from({ length: 12 }, (_, i) => {
                const monthDate = df.addMonths(startOfYear, i);
                const start = df.startOfMonth(monthDate);
                const previewDays = Array.from({ length: 14 }, (_, idx) => {
                    const dayDate = df.addDays(start, idx);
                    return {
                        key: df.format(dayDate, 'yyyy-MM-dd'),
                        label: df.getDate(dayDate),
                        isCurrentMonth: df.isSameMonth(dayDate, monthDate),
                        isToday: df.isSameDay(dayDate, today)
                    };
                });
                const monthEvents = buckets[i];
                return {
                    key: df.format(monthDate, 'yyyy-MM'),
                    date: start,
                    label: df.format(monthDate, 'MMMM'),
                    year: df.format(monthDate, 'yyyy'),
                    previewDays,
                    topColors: monthEvents.slice(0, 4).map(colorOf),
                    weekLabels: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
                    count: monthEvents.length,
                    isCurrent: df.isSameMonth(monthDate, today)
                };
            });
        });

        // Agenda: every day in the window, each event under every day it covers.
        const agendaSections = computed(() => {
            if (currentView.value !== 'Agenda') return [];
            const sections = [];
            for (const date of visibleDates.value) {
                const dayStart = date.getTime();
                const list = getEventsForDate(date).slice().sort((a, b) =>
                    (!!b.isAllDay - !!a.isAllDay) || L.toMs(a.start) - L.toMs(b.start));
                if (!list.length) continue;
                sections.push({
                    key: L.dayKey(dayStart),
                    label: df.format(date, 'MMMM d'),
                    weekday: df.format(date, 'EEEE'),
                    events: list.map((ev) => {
                        const r = L.eventRange(ev);
                        let timeLabel;
                        const dayEnd = L.addDays(dayStart, 1);
                        const t = (ms) => L.formatTime(ms, props.timeFormat, { compact: true });
                        if (ev.isAllDay) timeLabel = 'All day';
                        else if (r.start < dayStart && r.end > dayEnd) timeLabel = 'All day (continues)';
                        else if (r.start < dayStart) timeLabel = 'Until ' + t(r.end);
                        else if (r.end > dayEnd) timeLabel = t(r.start) + ' – ' + df.format(r.end, 'MMM d') + ', ' + t(r.end);
                        else timeLabel = L.formatRange(r.start, r.end, props.timeFormat);
                        return { key: barKey(ev, '#' + dayStart), event: ev, title: titleOf(ev), color: colorOf(ev),
                            isAllDay: !!ev.isAllDay, timeLabel };
                    }),
                });
            }
            return sections;
        });

        const getEventStyle = (event) => ({ backgroundColor: colorOf(event), color: 'white' });

        // Interaction Emitters
        const createMonthEvent = (date, jsEvent) => {
            if (props.readOnly) return;
            if (dragState.value.isDragging || dragState.value.wasDragging) return;
            const start = df.startOfDay(date);
            const end = df.endOfDay(date);
            emit('event-create', { start: start.getTime(), end: end.getTime(), isAllDay: true, event: jsEvent });
        };

        const createTimeEvent = (date, event) => {
            if (props.readOnly) return;
            if (dragState.value.isDragging || dragState.value.wasDragging) return;
            if (event.target.closest('.event-card')) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const hourPx = ncHourPx(event.currentTarget);
            // Snap down to the half hour under the pointer.
            const minutes = Math.max(0, Math.min(23.5 * 60, Math.floor((event.clientY - rect.top) / hourPx * 2) * 30));
            const start = df.addMinutes(df.startOfDay(date), minutes);
            const end = df.addMinutes(start, 60);
            emit('event-create', { start: start.getTime(), end: end.getTime(), isAllDay: false, event });
        };

        const selectEvent = (event, e) => {
            if (dragState.value.isDragging || dragState.value.wasDragging) return;
            if (event.isRecurringInstance && event.originalEventId) {
                const original = (props.events || []).find(ev => ev && ev.id === event.originalEventId);
                if (original) {
                    selectedEventId.value = original.id;
                    emit('event-click', { event: original, jsEvent: e });
                    return;
                }
            }
            selectedEventId.value = event.id;
            emit('event-click', { event, jsEvent: e });
        };

        // Drag: move (month: by day; time grid: by half hour and across day columns) and
        // resize (bottom edge). Recurring occurrences and read-only grids do not drag.
        const startDrag = (event, e, action) => {
            if (e.button !== 0 || props.readOnly || event.isRecurringInstance) return;
            const sel = action === 'month-move' ? '.calendar-cell[data-date]' : '.time-col[data-date]';
            const under = ncDateUnderPointer(e.clientX, e.clientY, sel);
            dragState.value = {
                eventId: event.id, isDragging: false, wasDragging: false,
                startY: e.clientY, startX: e.clientX,
                originalStart: L.toMs(event.start), originalEnd: L.toMs(event.end),
                action, ghostEvent: event, mouseX: e.clientX, mouseY: e.clientY,
                fromDate: under ? under.date : null,
                hourPx: ncHourPx(under ? under.el : (e.target.closest && e.target.closest('.time-col'))),
            };
        };

        const findSource = () => (props.events || []).find(ev => ev && ev.id === dragState.value.eventId);

        const onDrag = (e) => {
            const st = dragState.value;
            if (!st.eventId) return;
            if (!st.isDragging) {
                if (Math.abs(e.clientY - st.startY) > 5 || Math.abs(e.clientX - st.startX) > 5) st.isDragging = true;
                else return;
            }
            st.mouseX = e.clientX;
            st.mouseY = e.clientY;
            const event = findSource();
            if (!event) return;
            const snap = (px) => Math.round((px / st.hourPx) * 2) * 30; // minutes, half-hour steps
            if (st.action === 'time-move') {
                const under = ncDateUnderPointer(e.clientX, e.clientY, '.time-col[data-date]');
                const dayShift = under && st.fromDate ? L.dayDiff(st.fromDate.getTime(), under.date.getTime()) : 0;
                const start = df.addMinutes(df.addDays(st.originalStart, dayShift), snap(e.clientY - st.startY)).getTime();
                event.start = start;
                event.end = start + (st.originalEnd - st.originalStart);
            } else if (st.action === 'resize') {
                const end = df.addMinutes(st.originalEnd, snap(e.clientY - st.startY)).getTime();
                event.end = Math.max(end, st.originalStart + 15 * 60000);
            }
        };

        const stopDrag = (e) => {
            const st = dragState.value;
            if (!st.eventId) return;
            let changed = st.isDragging && st.action !== 'month-move';
            if (st.isDragging && st.action === 'month-move' && st.fromDate) {
                const under = ncDateUnderPointer(e.clientX, e.clientY, '.calendar-cell[data-date]');
                const event = findSource();
                const shift = under ? L.dayDiff(st.fromDate.getTime(), under.date.getTime()) : 0;
                if (event && shift) {
                    event.start = df.addDays(st.originalStart, shift).getTime();
                    event.end = df.addDays(st.originalEnd, shift).getTime();
                    changed = true;
                }
            }
            if (changed && findSource()) emit('update:events', [...props.events]);
            const wasDragging = st.isDragging;
            dragState.value = { eventId: null, isDragging: false, wasDragging, action: 'move' };
            setTimeout(() => { dragState.value.wasDragging = false; }, 50);
        };

        // Time Indicator
        const nowHours = ref(0);
        const updateTimeIndicator = () => {
            const now = new Date();
            nowHours.value = now.getHours() + now.getMinutes() / 60;
        };

        // Phones: leave the 7-column grids for the list when the window narrows past the
        // breakpoint (rotation, split screen); the user's own later choice sticks.
        let mql = null;
        const onNarrow = (ev) => { if (ev.matches && (currentView.value === 'Month' || currentView.value === 'Week')) changeView('Agenda'); };

        // The page around the grid is not a fixed-height layout (#app grows with its
        // content), so "height: 100%" resolved to the content: the month stopped short of
        // the window and the week grid's 24 hours pushed the page into scrolling, taking the
        // day headers with it. The grid sizes itself to the rest of the window instead, and
        // scrolls inside.
        const root = ref(null);
        const fitHeight = ref(0);
        const fit = () => {
            const el = root.value;
            if (!el) return;
            const top = el.getBoundingClientRect().top + window.scrollY;
            fitHeight.value = Math.max(420, Math.floor(window.innerHeight - top - 8));
        };
        const rootStyle = computed(() => fitHeight.value ? { height: fitHeight.value + 'px' } : {});

        let timer = null;
        let fitTimer = null;
        onMounted(() => {
            fit();
            fitTimer = setTimeout(fit, 400); // after web fonts / late header content
            window.addEventListener('resize', fit);
            window.addEventListener('mousemove', onDrag);
            window.addEventListener('mouseup', stopDrag);
            timer = setInterval(updateTimeIndicator, 60000);
            updateTimeIndicator();
            if (window.matchMedia) {
                mql = window.matchMedia(NC_NARROW_QUERY);
                if (mql.addEventListener) mql.addEventListener('change', onNarrow);
            }
        });
        onUnmounted(() => {
            window.removeEventListener('mousemove', onDrag);
            window.removeEventListener('mouseup', stopDrag);
            clearInterval(timer);
            clearTimeout(fitTimer);
            window.removeEventListener('resize', fit);
            if (mql && mql.removeEventListener) mql.removeEventListener('change', onNarrow);
        });

        return {
            currentView, views, currentTitle, weekDays, monthWeeks, monthLanes, visibleDates,
            yearMonths, agendaSections, allDayLayout, timedLayout,
            prev, next, today, changeView, goToMonth, showDay,
            getEventsForDate, getEventStyle, formatTime, formatHourLabel, titleOf,
            createMonthEvent, createTimeEvent, startDrag, selectEvent,
            dragState, nowHours, selectedEventId, isToday, isSameDay, root, rootStyle
        };
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NativeCalLayout, NativeCalendar };
}
