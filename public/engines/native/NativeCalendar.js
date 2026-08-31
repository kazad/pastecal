const df = window.dateFns;

// ----------------------------------------------------------------
// Sub-Components
// ----------------------------------------------------------------

const CalendarToolbar = {
    template: /* html */ `
        <div class="flex justify-between items-center p-3 border-b border-color-default bg-1 flex-shrink-0">
            <div class="flex items-center gap-4">
                <!-- Date Nav -->
                <div class="flex items-center bg-2 rounded-lg p-0.5">
                    <button @click="$emit('prev')" data-testid="nav-prev" class="px-2 hover:bg-1 rounded-md h-7 flex items-center text-color-1 text-lg leading-none mb-0.5">&lsaquo;</button>
                    <button @click="$emit('today')" data-testid="nav-today" class="px-3 text-xs font-bold hover:bg-1 rounded-md h-7 text-color-2 uppercase tracking-wide">Today</button>
                    <button @click="$emit('next')" data-testid="nav-next" class="px-2 hover:bg-1 rounded-md h-7 flex items-center text-color-1 text-lg leading-none mb-0.5">&rsaquo;</button>
                </div>
                <!-- Date Range. Clicking it opens a date picker, the way Syncfusion's
                     title caret does -- without it there was no way to reach a distant
                     month except by paging one step at a time. -->
                <div class="relative">
                    <button type="button" class="toolbar-title text-xl font-medium text-color-2"
                            data-testid="current-date-range"
                            :aria-expanded="pickerOpen ? 'true' : 'false'"
                            @click="pickerOpen = !pickerOpen">
                        {{ currentTitle }}
                        <span class="toolbar-caret" aria-hidden="true">&#9662;</span>
                    </button>
                    <div v-if="pickerOpen" class="toolbar-picker" v-click-outside="closePicker">
                        <input type="date" ref="picker" :value="pickerValue"
                               data-testid="toolbar-date-picker"
                               @change="pickDate($event.target.value)">
                    </div>
                </div>
            </div>

            <!-- View Switcher -->
            <div class="flex bg-2 rounded-lg p-0.5">
                <button v-for="view in views" 
                    :key="view"
                    @click="$emit('change-view', view)"
                    :data-testid="'view-' + view.toLowerCase()"
                    :class="['px-3 py-1 rounded-md text-xs font-medium transition-all', currentView === view ? 'bg-1 text-blue-600 shadow-sm' : 'text-color-1 hover:text-color-2']">
                    {{ view }}
                </button>
            </div>
        </div>
    `,
    props: ['currentTitle', 'currentView', 'views', 'selectedDate'],
    emits: ['prev', 'next', 'today', 'change-view', 'pick-date'],
    data() {
        return { pickerOpen: false };
    },
    computed: {
        pickerValue() {
            const d = this.selectedDate ? new Date(this.selectedDate) : new Date();
            if (isNaN(d.getTime())) return '';
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }
    },
    methods: {
        closePicker() { this.pickerOpen = false; },
        pickDate(value) {
            if (!value) return;
            // Parse as local midnight; `new Date('2026-03-15')` is UTC and lands on
            // the previous day for anyone west of Greenwich.
            const [y, m, d] = value.split('-').map(Number);
            this.$emit('pick-date', new Date(y, m - 1, d));
            this.pickerOpen = false;
        }
    }
};

// Month (and the custom "N Months" / "N Weeks" view, which is the same grid over
// a longer range).
//
// Laid out as week rows rather than 42 independent cells, because an event that
// spans days has to be able to draw across them. Each row stacks two layers: the
// day cells, which take the clicks, and a bars layer on top positioned with
// `grid-column: start / span n`. The previous per-cell version filtered events
// with isSameDay(event.start, date), so a four-day event appeared only on its
// first day and was invisible on the other three.
const MonthView = {
    template: /* html */ `
        <div class="native-fill flex flex-col overflow-y-auto bg-1">
            <div class="grid grid-cols-7 border-b border-color-default bg-2">
                <div v-for="day in weekDays" :key="day" class="py-2 text-center text-sm font-semibold text-color-1 uppercase tracking-wide">
                    {{ day }}
                </div>
            </div>
            <div class="calendar-grid flex-1" data-testid="month-view-grid">
                <div v-for="row in rows" :key="row.key" class="month-row" :class="{ 'has-more': row.hasMore }">
                    <div class="month-row-cells">
                        <div v-for="(cell, idx) in row.days" :key="idx"
                             class="calendar-cell"
                             :class="{'is-outside': !cell.inRange, 'is-today': isToday(cell.date)}"
                             :data-date="cell.date.toISOString()"
                             :data-testid="'month-cell-' + cell.index"
                             @click="$emit('create-event', cell.date, $event)">
                            <span class="day-number"
                                  :class="[isToday(cell.date) ? 'is-today-number' : '', cell.isMonthStart ? 'month-start' : '']">
                                {{ cell.label }}
                            </span>
                            <button v-if="cell.hiddenCount" type="button" class="month-more"
                                    :data-testid="'month-more-' + cell.index"
                                    @click.stop="$emit('show-day', cell.date)">
                                +{{ cell.hiddenCount }} more
                            </button>
                        </div>
                    </div>

                    <div class="month-row-bars">
                        <!-- Ghost bar while a quick-create popover is open on this day -->
                        <div v-if="row.ghost"
                             class="month-bar is-ghost"
                             :style="{ gridColumn: (row.ghost.startCol + 1) + ' / span ' + row.ghost.span, gridRow: row.ghost.lane + 1 }">
                            New Event
                        </div>
                        <div v-for="bar in row.bars" :key="bar.key"
                             class="month-bar"
                             :class="{
                                 'is-dragging': dragState.eventId === bar.event.id,
                                 'continues-left': bar.continuesLeft,
                                 'continues-right': bar.continuesRight
                             }"
                             :style="[getEventStyle(bar.event), { gridColumn: (bar.startCol + 1) + ' / span ' + bar.span, gridRow: bar.lane + 1 }]"
                             :data-testid="'event-' + bar.event.id"
                             :title="bar.event.title"
                             @mousedown.stop="$emit('start-drag', bar.event, $event, 'month-move')"
                             @click.stop="$emit('select-event', bar.event, $event)">
                            <span v-if="bar.event.isRecurringInstance">&#8635; </span>
                            <span v-if="bar.showTime" class="month-bar-time">{{ bar.timeLabel }}</span>
                            {{ bar.event.title }}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `,
    props: ['rows', 'weekDays', 'dragState', 'getEventStyle', 'isToday'],
    emits: ['create-event', 'start-drag', 'select-event', 'show-day']
};

const TimeGridView = {
    template: /* html */ `
        <div class="native-fill flex flex-col bg-1">
            <div class="border-b border-color-default bg-1 flex-shrink-0 grid"
                 :style="{ gridTemplateColumns: '60px repeat(' + visibleDates.length + ', 1fr)' }">
                <div class="border-r border-color-default p-2"></div>
                <div v-for="(date, idx) in visibleDates" :key="idx" 
                     class="p-2 text-center border-r border-color-default">
                    <div class="text-xs font-semibold text-color-1 uppercase">{{ dayNames[date.getDay()] }}</div>
                    <div class="text-xl font-light w-8 h-8 mx-auto rounded-full flex items-center justify-center text-color-2" 
                         :class="{'bg-blue-600 text-white font-bold': isToday(date)}">
                        {{ date.getDate() }}
                    </div>
                </div>
            </div>

            <!-- All-day lane. Anything that covers a whole day, or more than one,
                 belongs here rather than as a midnight-to-midnight block in the
                 grid below. -->
            <div class="all-day-lane border-b border-color-default bg-1 flex-shrink-0 grid"
                 data-testid="all-day-lane"
                 :style="{ gridTemplateColumns: '60px repeat(' + visibleDates.length + ', 1fr)' }">
                <div class="all-day-label border-r border-color-default">All day</div>
                <div class="all-day-bars"
                     :style="{ gridColumn: '2 / span ' + visibleDates.length,
                               gridTemplateColumns: 'repeat(' + visibleDates.length + ', 1fr)',
                               minHeight: (Math.max(allDay.lanes, 1) * 22) + 'px' }">
                    <div v-for="bar in allDay.bars" :key="bar.key"
                         class="month-bar"
                         :class="{ 'continues-left': bar.continuesLeft, 'continues-right': bar.continuesRight }"
                         :style="[getEventStyle(bar.event), { gridColumn: (bar.startCol + 1) + ' / span ' + bar.span, gridRow: bar.lane + 1 }]"
                         :data-testid="'event-' + bar.event.id"
                         :title="bar.event.title"
                         @click.stop="$emit('select-event', bar.event, $event)">
                        {{ bar.event.title }}
                    </div>
                </div>
            </div>

            <div class="flex-1 overflow-y-auto relative bg-1" ref="timeScroll">
                <div class="time-grid relative"
                     :style="{ gridTemplateColumns: '60px repeat(' + visibleDates.length + ', 1fr)' }">
                    
                    <!-- Hour labels. The negative offset belongs to the column, not
                         to each label: applied per-label it also shortens the stride
                         to 40px, so the labels drifted an hour out of step with the
                         50px rows they name after a dozen hours. -->
                    <div class="time-labels flex flex-col text-xs text-color-1 text-right pr-2 bg-1 sticky left-0 z-10 border-r border-color-default">
                        <div v-for="h in hours" :key="h" class="h-[50px] bg-1 select-none">
                            {{ formatTimeLabel(h) }}
                        </div>
                    </div>
                    
                    <div v-for="(date, idx) in visibleDates" :key="idx" 
                         class="time-col relative"
                         :data-date="date.toISOString()"
                         @click="$emit('create-time-event', date, $event)">
                        
                        <div v-for="h in hours" :key="h" class="hour-row pointer-events-none"></div>
                        
                        <div v-if="isToday(date)" class="absolute w-full h-0.5 bg-red-500 z-30 pointer-events-none flex items-center"
                             :style="{ top: currentTimeTop + 'px' }">
                             <div class="w-2 h-2 bg-red-500 rounded-full -ml-1"></div>
                        </div>

                        <div v-if="dragState.isDragging && isSameDay(date, new Date(dragState.originalStart)) && dragState.action === 'time-move'"
                             class="absolute inset-x-1 rounded border-2 border-gray-400 border-dashed bg-2 opacity-60 pointer-events-none z-0"
                             :style="getGhostStyle()">
                        </div>
                        
                        <!-- Ghost Event for Time View -->
                        <div v-if="creatingEvent && !creatingEvent.isAllDay && isSameDay(date, new Date(creatingEvent.start))"
                             class="absolute inset-x-1 rounded border-2 border-dashed border-gray-400 bg-2 opacity-70 pointer-events-none z-20 flex items-center justify-center"
                             :style="getCreatingEventStyle(creatingEvent)">
                             <div class="text-xs text-color-1 font-medium">New Event</div>
                        </div>

                        <div v-for="event in getEventsWithLayout(date)" :key="event.id" 
                             class="event-card absolute p-1 text-xs inset-x-1 rounded overflow-hidden border-l-4"
                             :class="{
                                 'dragging-active': dragState.eventId === event.id && dragState.isDragging, 
                                 'dragging-move-active': dragState.eventId === event.id && dragState.isDragging && dragState.action === 'time-move',
                                 'ring-2 ring-offset-1 ring-black': selectedEventId === event.id
                             }"
                             :style="[getEventStyle(event, true), getWeekEventPosition(event), { cursor: eventCursor }]"
                             :data-testid="'event-' + event.id"
                             @mousedown.stop="$emit('start-drag', event, $event, 'time-move')"
                             @click.stop="$emit('select-event', event, $event)">
                            <div class="event-text-content">
                                <div class="font-bold leading-tight pointer-events-none"><span v-if="event.isRecurringInstance">↻ </span>{{ event.title }}</div>
                                <!-- Only when the block is tall enough for a second line; a
                                     30-minute event was rendering its time half-clipped. -->
                                <div v-if="isTall(event)" class="opacity-75 text-[10px] pointer-events-none">{{ formatTime(event.start) }} - {{ formatTime(event.end) }}</div>
                            </div>
                            <div class="resize-handle absolute bottom-0 inset-x-0 h-2 z-20"
                                 @mousedown.stop="$emit('start-drag', event, $event, 'resize')"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `,
    props: [
        'currentView', 'visibleDates', 'dayNames', 'isToday',
        'currentTimeTop', 'dragState', 'selectedEventId', 'eventCursor',
        'getEventsWithLayout', 'getEventStyle', 'getWeekEventPosition', 'getGhostStyle', 'formatTime', 'isSameDay', 'timeFormat',
        'creatingEvent', 'hours', 'startHourNum', 'allDay'
    ],
    emits: ['create-time-event', 'start-drag', 'select-event'],
    methods: {
        isTall(event) {
            const style = this.getWeekEventPosition(event);
            return parseFloat(style.height) >= 34;
        },
        formatTimeLabel(hours) {
            const date = new Date();
            date.setHours(hours, 0, 0, 0);
            return this.formatTime(date.getTime());
        },
        getCreatingEventStyle(evt) {
            const start = new Date(evt.start);
            const end = new Date(evt.end);
            const startMinutes = start.getHours() * 60 + start.getMinutes();
            const endMinutes = end.getHours() * 60 + end.getMinutes();
            // Ensure ghost has at least minimal height
            const diffMinutes = Math.max(endMinutes - startMinutes, 30);

            // Offset by the grid's first hour, the same as real events.
            const top = (startMinutes / 60 - this.startHourNum) * 50;
            const height = (diffMinutes / 60) * 50;
            return { top: top + 'px', height: height + 'px' };
        }
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
                                <span v-for="day in month.weekLabels" :key="day" class="text-center uppercase tracking-wide">{{ day }}</span>
                            </div>
                            <div class="grid grid-cols-7 gap-1 text-[10px]">
                                <button v-for="day in month.previewDays" :key="day.key" type="button"
                                      class="year-day rounded text-center"
                                      :class="day.isToday ? 'bg-blue-600 text-white font-bold' : (day.isCurrentMonth ? 'text-color-2' : 'text-color-1 opacity-40')"
                                      :data-testid="'year-day-' + day.key"
                                      @click.stop="$emit('jump-to-day', day.date)">
                                    <span>{{ day.label }}</span>
                                    <span class="year-dots">
                                        <i v-for="(c, ci) in day.dotColors" :key="ci" :style="{ backgroundColor: c }"></i>
                                    </span>
                                </button>
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
            emits: ['jump-to-month', 'jump-to-day']
        },
        'agenda-view': {
            template: /* html */ `
                <div class="h-full overflow-auto bg-1 p-4 space-y-3">
                    <div v-if="!agenda.length" class="rounded-xl border border-color-default bg-2 p-6 text-center text-color-1">
                        No upcoming events in this window.
                    </div>
                    <div v-for="section in agenda" :key="section.key" class="rounded-xl border border-color-default bg-2 shadow-sm overflow-hidden">
                        <div class="px-4 py-3 flex items-center justify-between border-b border-color-default">
                            <div>
                                <p class="text-[11px] uppercase tracking-wide text-color-1">{{ section.weekday }}</p>
                                <p class="text-lg font-bold text-color-2">{{ section.label }}</p>
                            </div>
                            <span class="text-[11px] px-3 py-1 rounded-full bg-1 text-color-1 border border-color-default">{{ section.events.length }} items</span>
                        </div>
                        <div class="divide-y divide-color-default">
                            <div v-for="evt in section.events" :key="evt.id" class="px-4 py-3 flex items-center gap-3">
                                <span class="w-2 h-2 rounded-full" :style="{ backgroundColor: evt.color }"></span>
                                <div class="flex-1">
                                    <p class="text-sm font-semibold text-color-2">{{ evt.title }}</p>
                                    <p class="text-xs text-color-1">{{ evt.timeLabel }}</p>
                                </div>
                                <span v-if="evt.isAllDay" class="text-[11px] px-2 py-1 rounded-full bg-1 border border-color-default text-color-1">All day</span>
                            </div>
                        </div>
                    </div>
                </div>
            `,
            props: ['agenda']
        }
    },
    template: /* html */ `
        <div class="native-fill flex flex-col w-full bg-1">
            <calendar-toolbar
                :current-title="currentTitle"
                :current-view="currentView"
                :views="views"
                :selected-date="selectedDate"
                @prev="prev"
                @next="next"
                @today="today"
                @pick-date="goToDate"
                @change-view="changeView">
            </calendar-toolbar>

            <div class="flex-1 min-h-0 overflow-hidden relative flex flex-col">
                <month-view v-if="isGridView"
                    :rows="monthRows"
                    :week-days="weekDays"
                    :drag-state="dragState"
                    :get-event-style="getEventStyle"
                    :is-today="isToday"
                    @create-event="createMonthEvent"
                    @start-drag="startDrag"
                    @select-event="selectEvent"
                    @show-day="showDay">
                </month-view>

                <time-grid-view v-if="currentView === 'Week' || currentView === 'Day'"
                    :current-view="currentView"
                    :visible-dates="visibleDates"
                    :day-names="dayNames"
                    :hours="hours"
                    :start-hour-num="startHourNum"
                    :all-day="allDayRows"
                    :is-today="isToday"
                    :current-time-top="currentTimeTop"
                    :drag-state="dragState"
                    :selected-event-id="selectedEventId"
                    :event-cursor="eventCursor"
                    :get-events-with-layout="getEventsWithLayout"
                    :get-event-style="getEventStyle"
                    :get-week-event-position="getWeekEventPosition"
                    :get-ghost-style="getGhostStyle"
                    :format-time="formatTime"
                    :is-same-day="isSameDay"
                    :time-format="timeFormat"
                    :creating-event="creatingEvent"
                    @create-time-event="createTimeEvent"
                    @start-drag="startDrag"
                    @select-event="selectEvent">
                </time-grid-view>
                
                <year-view v-if="currentView === 'Year'"
                    :months="yearMonths"
                    @jump-to-month="goToMonth"
                    @jump-to-day="showDay">
                </year-view>

                <agenda-view v-if="currentView === 'Agenda'"
                    :agenda="agendaSections">
                </agenda-view>
                
                <!-- Drag Ghost -->
                <div v-if="dragState.isDragging && dragState.action === 'month-move' && dragState.ghostEvent" 
                     class="drag-ghost px-2 py-1 text-xs rounded text-white font-bold truncate w-32 pointer-events-none"
                     :style="[getEventStyle(dragState.ghostEvent), { left: dragState.mouseX + 'px', top: dragState.mouseY + 'px' }]">
                    {{ dragState.ghostEvent.title }}
                </div>
            </div>
        </div>
    `,
    props: [
        'events', 'timeFormat', 'creatingEvent',
        // Controlled state. The shell owns the view and the date so that URL
        // params, the search panel's jump-to-event, and the saved default view
        // all have something to drive; the component asks for changes by
        // emitting rather than mutating its own copy.
        'currentView', 'selectedDate', 'views',
        // Settings. Every one of these used to be hardcoded here, which is why
        // the settings panel accepted input and changed nothing on screen.
        'startHour', 'firstDayOfWeek', 'colors', 'readOnly', 'allowDrag', 'allowResize',
    ],
    emits: [
        'update:events', 'event-click', 'event-create',
        'update:currentView', 'update:selectedDate',
    ],
    /**
     * @param {NativeCalendarProps} props
     * @param {Object} context
     * @param {(event: string, ...args: any[]) => void} context.emit
     */
    setup(props, { emit }) {
        const { ref, computed, onMounted, onUnmounted, watch } = Vue;
        
        // View and date are props, not local refs: writing to either asks the
        // shell to change it and the new value arrives back as a prop. Keeping
        // a private copy here is what made ?d= / ?v= and jumpToEvent impossible.
        const currentView = computed({
            get: () => props.currentView || 'Month',
            set: (v) => emit('update:currentView', v),
        });
        const currentDate = computed({
            get: () => (props.selectedDate ? new Date(props.selectedDate) : new Date()),
            set: (d) => emit('update:selectedDate', d),
        });
        const views = computed(() => (props.views && props.views.length)
            ? props.views
            : ['Day', 'Week', 'Month', 'Year', 'Agenda']);

        const BUILT_IN_VIEWS = ['Day', 'Week', 'Month', 'Year', 'Agenda'];
        // Views drawn as a month-style grid of week rows.
        const selectedEventId = ref(null);

        const DEFAULT_COLORS = ["#3f51b5", "#e3165b", "#ff6652", "#4caf50", "#ff9800", "#03a9f4", "#9e9e9e", "#27282f"];
        // The palette is per-calendar and editable in settings, so it has to come
        // from the shell rather than being frozen into the component.
        const colors = computed(() => (props.colors && props.colors.length) ? props.colors : DEFAULT_COLORS);

        // 0 = Sunday. date-fns takes this as weekStartsOn, and every grid that
        // slices a week has to agree with it.
        const weekStartsOn = computed(() => {
            const n = parseInt(props.firstDayOfWeek);
            return Number.isFinite(n) && n >= 0 && n <= 6 ? n : 0;
        });
        const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        // Column headers, rotated to start on the configured day.
        const weekDays = computed(() =>
            Array.from({ length: 7 }, (_, i) => DAY_NAMES[(i + weekStartsOn.value) % 7]));
        // Unrotated, for anywhere that indexes by Date#getDay().
        const dayNames = DAY_NAMES;

        // First hour shown in the vertical views. "Extended" calendars pass
        // '00:00'; the default is the 5am start the product has always had.
        const startHourNum = computed(() => {
            const raw = props.startHour;
            if (typeof raw !== 'string' || !raw.includes(':')) return 0;
            const h = parseInt(raw.split(':')[0]);
            return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 0;
        });
        const hours = computed(() =>
            Array.from({ length: 24 - startHourNum.value }, (_, i) => startHourNum.value + i));
        const HOUR_PX = 50;
        // Pixel offset of a timestamp within the vertical grid, measured from the
        // top of the first rendered hour rather than from midnight.
        const minutesToTop = (date) => {
            const d = new Date(date);
            return ((d.getHours() * 60 + d.getMinutes()) / 60 - startHourNum.value) * HOUR_PX;
        };

        // A read-only calendar must not be editable through the grid either. The
        // shell hides the chrome; without this the cells, drags and resize handles
        // stayed live and a view-only link was fully writable.
        const canEdit = computed(() => !props.readOnly);
        // Touch devices get no drag or resize: on a phone, scrolling the grid was
        // landing as an accidental move.
        const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
        const dragEnabled = computed(() => canEdit.value && props.allowDrag !== false && !isTouch);
        const resizeEnabled = computed(() => canEdit.value && props.allowResize !== false && !isTouch);

        // Drag State
        const dragState = ref({
            eventId: null,
            isDragging: false,
            wasDragging: false,
            startY: 0,
            originalStart: 0,
            originalEnd: 0,
            action: 'move',
            ghostEvent: null,
            mouseX: 0,
            mouseY: 0
        });

        const eventCursor = computed(() => {
            if (dragState.value.isDragging && dragState.value.eventId) {
                return dragState.value.action === 'resize' ? 'ns-resize' : 'grabbing';
            }
            return 'pointer';
        });

        // Date Logic
        const currentTitle = computed(() => {
            if (currentView.value === 'Day') return df.format(currentDate.value, 'MMMM d, yyyy');
            if (currentView.value === 'Week') {
                return rangeTitle(
                    df.startOfWeek(currentDate.value, { weekStartsOn: weekStartsOn.value }),
                    df.endOfWeek(currentDate.value, { weekStartsOn: weekStartsOn.value }));
            }
            if (currentView.value === 'Agenda') {
                const start = df.startOfWeek(currentDate.value, { weekStartsOn: weekStartsOn.value });
                return rangeTitle(start, df.addDays(start, 13));
            }
            if (currentView.value === 'Year') return df.format(currentDate.value, 'yyyy');
            // The custom view covers a range, so name the range -- "August 2026"
            // on a three-month grid says nothing about the other two.
            if (customStep.value) {
                const { start, end } = gridRange.value;
                const sameYear = df.getYear(start) === df.getYear(end);
                return sameYear
                    ? `${df.format(start, 'MMMM')} \u2013 ${df.format(end, 'MMMM yyyy')}`
                    : `${df.format(start, 'MMM yyyy')} \u2013 ${df.format(end, 'MMM yyyy')}`;
            }
            return df.format(currentDate.value, 'MMMM yyyy');
        });

        // "August 16 - 22, 2026", collapsing the month and year where they repeat,
        // which is how the Syncfusion toolbar has always phrased a range.
        const rangeTitle = (start, end) => {
            const year = df.format(end, 'yyyy');
            if (df.isSameMonth(start, end)) {
                return `${df.format(start, 'MMMM d')} - ${df.format(end, 'd')}, ${year}`;
            }
            if (df.getYear(start) === df.getYear(end)) {
                return `${df.format(start, 'MMMM d')} - ${df.format(end, 'MMMM d')}, ${year}`;
            }
            return `${df.format(start, 'MMMM d, yyyy')} - ${df.format(end, 'MMMM d, yyyy')}`;
        };

        const isToday = (date) => df.isSameDay(date, new Date());
        const isSameDay = (d1, d2) => df.isSameDay(d1, d2);

        // Navigation
        const changeView = (view) => {
            currentView.value = view;
            if (view === 'Week' || view === 'Agenda') {
                currentDate.value = df.startOfWeek(currentDate.value, { weekStartsOn: weekStartsOn.value });
            } else if (view === 'Year') {
                currentDate.value = df.startOfYear(currentDate.value);
            }
        };
        // Step size for prev/next in the custom view ("3 Months", "12 Weeks").
        const customStep = computed(() => {
            const v = views.value.find(name => name === currentView.value && !BUILT_IN_VIEWS.includes(name));
            if (!v) return null;
            const match = /^(\d+)\s+(Week|Weeks|Month|Months)$/i.exec(v);
            if (!match) return null;
            return { count: parseInt(match[1]), unit: /week/i.test(match[2]) ? 'weeks' : 'months' };
        });
        const step = (direction) => {
            const custom = customStep.value;
            if (custom) {
                currentDate.value = custom.unit === 'weeks'
                    ? df.addWeeks(currentDate.value, direction * custom.count)
                    : df.addMonths(currentDate.value, direction * custom.count);
                return;
            }
            if (currentView.value === 'Month') currentDate.value = df.addMonths(currentDate.value, direction);
            else if (currentView.value === 'Week') currentDate.value = df.addWeeks(currentDate.value, direction);
            else if (currentView.value === 'Year') currentDate.value = df.addYears(currentDate.value, direction);
            else if (currentView.value === 'Agenda') currentDate.value = df.addWeeks(currentDate.value, direction * 2);
            else currentDate.value = df.addDays(currentDate.value, direction);
        };
        const prev = () => step(-1);
        const next = () => step(1);

        // Month and the custom view share the week-row grid; a custom view
        // measured in weeks or months is just a longer span of the same thing.
        const isGridView = computed(() =>
            currentView.value === 'Month' || customStep.value !== null);
        const today = () => currentDate.value = new Date();
        // "+N more" jumps to the day so the hidden events are actually reachable.
        // Jump to a date from the toolbar picker, staying in the current view.
        const goToDate = (date) => { currentDate.value = date; };
        const showDay = (date) => {
            currentDate.value = df.startOfDay(date);
            currentView.value = 'Day';
        };
        const goToMonth = (date) => {
            currentDate.value = df.startOfMonth(date);
            currentView.value = 'Month';
        };

        // Grid Logic
        //
        // The month grid is built as week rows so that multi-day events can draw
        // across day boundaries. MAX_LANES caps how many bars a row shows before
        // the rest collapse into a "+N more" link, the same way Syncfusion does.
        const MAX_LANES = 3;

        // A day is "in range" (not greyed out) when it belongs to the period the
        // view is showing -- the current month, or the whole custom range.
        const gridRange = computed(() => {
            const custom = customStep.value;
            if (custom && custom.unit === 'weeks') {
                const start = df.startOfWeek(currentDate.value, { weekStartsOn: weekStartsOn.value });
                return { start, end: df.endOfDay(df.addDays(start, custom.count * 7 - 1)) };
            }
            if (custom) {
                const start = df.startOfMonth(currentDate.value);
                return { start, end: df.endOfMonth(df.addMonths(start, custom.count - 1)) };
            }
            return {
                start: df.startOfMonth(currentDate.value),
                end: df.endOfMonth(currentDate.value),
            };
        });

        // The last calendar day an event touches. An end that lands exactly on
        // midnight belongs to the day before -- otherwise every 5pm-to-midnight
        // event would draw a second, empty day.
        const lastDayOf = (event) => {
            const end = new Date(event.end);
            const startOfEnd = df.startOfDay(end);
            if (end.getTime() === startOfEnd.getTime() && end > new Date(event.start)) {
                return df.subDays(startOfEnd, 1);
            }
            return startOfEnd;
        };

        // Greedy lane packing: put each bar in the topmost lane where nothing it
        // overlaps already sits.
        const assignLanes = (segments) => {
            const lanes = [];
            segments.forEach(seg => {
                let lane = 0;
                while (true) {
                    const occupants = lanes[lane] || (lanes[lane] = []);
                    const clash = occupants.some(o =>
                        seg.startCol <= o.startCol + o.span - 1 && o.startCol <= seg.startCol + seg.span - 1);
                    if (!clash) { occupants.push(seg); seg.lane = lane; break; }
                    lane++;
                }
            });
        };

        // Clip one event to one week row, returning null when it does not reach
        // this row at all.
        const segmentFor = (event, rowStart, rowEnd, columns = 7) => {
            const first = df.startOfDay(new Date(event.start));
            const last = lastDayOf(event);
            if (last < rowStart || first > rowEnd) return null;
            const from = first < rowStart ? rowStart : first;
            const to = last > rowEnd ? rowEnd : last;
            const startCol = df.differenceInCalendarDays(from, rowStart);
            const span = df.differenceInCalendarDays(to, from) + 1;
            return {
                key: event.id + '@' + rowStart.getTime(),
                event,
                startCol,
                span: Math.max(1, Math.min(span, columns - startCol)),
                continuesLeft: first < rowStart,
                continuesRight: last > rowEnd,
                showTime: !event.isAllDay && span === 1,
                timeLabel: event.isAllDay ? '' : formatTime(event.start),
                lane: 0,
            };
        };

        const monthRows = computed(() => {
            const range = gridRange.value;
            const gridStart = df.startOfWeek(range.start, { weekStartsOn: weekStartsOn.value });
            const gridEnd = df.endOfWeek(range.end, { weekStartsOn: weekStartsOn.value });
            const events = processedEvents.value;
            const ghost = props.creatingEvent && props.creatingEvent.isAllDay ? props.creatingEvent : null;

            const rows = [];
            let cursor = gridStart;
            let index = 0;
            while (cursor <= gridEnd) {
                const rowStart = df.startOfDay(cursor);
                const rowEnd = df.startOfDay(df.addDays(cursor, 6));

                const segments = events
                    .map(e => segmentFor(e, rowStart, rowEnd))
                    .filter(Boolean)
                    .sort((a, b) => a.startCol - b.startCol || b.span - a.span
                        || new Date(a.event.start) - new Date(b.event.start));
                assignLanes(segments);

                // Anything past the cap becomes a per-day "+N more" count. When
                // there is an overflow the last lane is given up to make room for
                // that line, so it never lands on top of a bar.
                const overflows = segments.some(seg => seg.lane >= MAX_LANES);
                const visibleLanes = overflows ? MAX_LANES - 1 : MAX_LANES;
                const hidden = new Array(7).fill(0);
                segments.forEach(seg => {
                    if (seg.lane < visibleLanes) return;
                    for (let c = seg.startCol; c < seg.startCol + seg.span; c++) hidden[c]++;
                });

                const days = Array.from({ length: 7 }, (_, i) => {
                    const date = df.addDays(rowStart, i);
                    const isMonthStart = df.getDate(date) === 1;
                    return {
                        date,
                        index: index++,
                        dayNumber: df.getDate(date),
                        // Syncfusion labels the 1st of a month "Aug 1" so month
                        // boundaries stay findable in a long scroll.
                        label: isMonthStart ? df.format(date, 'MMM d') : String(df.getDate(date)),
                        isMonthStart,
                        inRange: date >= df.startOfDay(range.start) && date <= range.end,
                        hiddenCount: hidden[i],
                    };
                });

                rows.push({
                    key: rowStart.toISOString(),
                    days,
                    bars: segments.filter(seg => seg.lane < visibleLanes),
                    hasMore: overflows,
                    ghost: ghost ? (() => {
                        const seg = segmentFor({ id: '__ghost', start: ghost.start, end: ghost.end, isAllDay: true }, rowStart, rowEnd);
                        if (seg) seg.lane = Math.min(visibleLanes - 1, segments.length ? Math.max(...segments.map(x => x.lane)) + 1 : 0);
                        return seg;
                    })() : null,
                });
                cursor = df.addDays(cursor, 7);
            }
            return rows;
        });

        const visibleDates = computed(() => {
            if (currentView.value === 'Day') return [currentDate.value];
            if (currentView.value === 'Week') {
                const start = df.startOfWeek(currentDate.value, { weekStartsOn: weekStartsOn.value });
                return Array.from({ length: 7 }, (_, i) => df.addDays(start, i));
            }
            if (currentView.value === 'Agenda') {
                const start = df.startOfWeek(currentDate.value, { weekStartsOn: weekStartsOn.value });
                return Array.from({ length: 14 }, (_, i) => df.addDays(start, i));
            }
            return [];
        });

        // Recurrence Expansion Logic
        const processedEvents = computed(() => {
            const results = [];
            
            // 1. Determine range (generous padding to avoid edge cases)
            let rangeStart, rangeEnd;
            if (isGridView.value) {
                 // Covers Month and the custom "N Months" / "N Weeks" view, which
                 // draw the same grid over a longer span.
                 rangeStart = df.subWeeks(gridRange.value.start, 1);
                 rangeEnd = df.addWeeks(gridRange.value.end, 1);
            } else if (currentView.value === 'Year') {
                 const start = df.startOfYear(currentDate.value);
                 rangeStart = df.subMonths(start, 1);
                 rangeEnd = df.addMonths(df.endOfYear(currentDate.value), 1);
            } else {
                const visible = visibleDates.value;
                if (visible.length) {
                    rangeStart = df.subDays(visible[0], 1);
                    rangeEnd = df.addDays(visible[visible.length - 1], 1);
                } else {
                    rangeStart = df.subMonths(currentDate.value, 1);
                    rangeEnd = df.addMonths(currentDate.value, 1);
                }
            }
            
            // console.log('[NativeCalendar] processedEvents computing. Total events:', props.events?.length);

            (props.events || []).forEach(event => {
                if (!event.recurrencerule) {
                    results.push(event);
                    return;
                }
                
                // console.log('[NativeCalendar] Found recurring event:', event.title, event.recurrencerule);

                if (window.rrule) {
                    try {
                        // Ensure we're accessing the library correctly
                        // rrule library exports might vary (rrule.RRule or just RRule global)
                        const RRule = window.rrule.RRule || window.RRule;
                        const rrulestr = window.rrule.rrulestr || window.rrulestr;
                        
                        if (!RRule || !rrulestr) {
                            console.error('[NativeCalendar] RRule library not found correctly', { RRule: !!RRule, rrulestr: !!rrulestr });
                            results.push(event);
                            return;
                        }

                        // "FREQ=WEEKLY;UNTIL=..."
                        // Handle cases where RRULE: might already be present or not
                        let ruleString = event.recurrencerule;
                        
                        // Clean up potentially trailing semicolons or whitespace and empty segments
                        ruleString = ruleString.split(';').filter(part => part.trim() !== '').join(';');
                        
                        ruleString = ruleString.startsWith("RRULE:") 
                            ? ruleString 
                            : "RRULE:" + ruleString;
                            
                        const options = rrulestr(ruleString).options;
                        options.dtstart = new Date(event.start);

                        // A rule string with no DTSTART makes rrule fill byhour/
                        // byminute/bysecond from the current clock, and those survive
                        // replacing dtstart -- so every occurrence rendered at whatever
                        // time the page happened to load rather than the event's own
                        // time. Clearing them lets rrule re-derive the time of day from
                        // dtstart, which is what we actually want. Anything the rule
                        // asked for explicitly is left alone.
                        if (!/BYHOUR=/i.test(ruleString)) options.byhour = null;
                        if (!/BYMINUTE=/i.test(ruleString)) options.byminute = null;
                        if (!/BYSECOND=/i.test(ruleString)) options.bysecond = null;

                        
                        const rule = new RRule(options);
                        
                        const dates = rule.between(rangeStart, rangeEnd, true);
                        
                        // start/end are ISO strings on the stored model (and numbers
                        // once a drag has touched them), so subtracting them raw gave
                        // NaN -- every expanded instance got end: NaN, which made its
                        // month bar span NaN columns and its week block have no height.
                        const duration = new Date(event.end).getTime() - new Date(event.start).getTime();
                        
                        dates.forEach(date => {
                             // Virtual event
                             const start = date.getTime();
                             const end = start + (Number.isFinite(duration) && duration > 0 ? duration : 60 * 60 * 1000);
                             results.push({
                                 ...event,
                                 start,
                                 end,
                                 id: event.id + '_' + start,
                                 originalEventId: event.id,
                                 isRecurringInstance: true
                             });
                        });
                    } catch (e) {
                        console.warn("[NativeCalendar] Recurrence error for event", event.title, e);
                        results.push(event);
                    }
                } else {
                    results.push(event);
                }
            });
            
            return results;
        });

        // Event Logic
        //
        // Overlap, not start-day equality: an event that runs 10-13 Aug belongs to
        // all four days, not just the 10th.
        const occursOn = (event, date) => {
            const day = df.startOfDay(date);
            return df.startOfDay(new Date(event.start)) <= day && lastDayOf(event) >= day;
        };
        const getEventsForDate = (date) => processedEvents.value.filter(e => occursOn(e, date));

        // The vertical views split their events in two: all-day and multi-day
        // events go in the lane above the grid, timed ones are positioned in it.
        // Without the split, an all-day event was drawn as a midnight-to-midnight
        // block that buried a whole day's real appointments.
        const spansWholeDay = (event) => {
            if (event.isAllDay) return true;
            return !df.isSameDay(new Date(event.start), lastDayOf(event));
        };
        const getTimedEventsForDate = (date) =>
            getEventsForDate(date).filter(e => !spansWholeDay(e));

        // All-day lane for the visible range, laid out with the same clipping and
        // lane packing the month rows use.
        const allDayRows = computed(() => {
            const dates = visibleDates.value;
            if (!dates.length) return { lanes: 0, bars: [] };
            const rowStart = df.startOfDay(dates[0]);
            const rowEnd = df.startOfDay(dates[dates.length - 1]);
            const segments = processedEvents.value
                .filter(spansWholeDay)
                .map(e => segmentFor(e, rowStart, rowEnd, dates.length))
                .filter(Boolean)
                .sort((a, b) => a.startCol - b.startCol || b.span - a.span);
            assignLanes(segments);
            const lanes = segments.reduce((max, seg) => Math.max(max, seg.lane + 1), 0);
            return { lanes, bars: segments };
        });

        const getEventsWithLayout = (date) => {
            const dayEvents = getTimedEventsForDate(date).map(e => ({...e}));
            if (dayEvents.length === 0) return [];
            dayEvents.sort((a, b) => a.start - b.start || b.end - a.end);
            const columns = [];
            dayEvents.forEach(ev => {
                let placed = false;
                for (let i = 0; i < columns.length; i++) {
                    const col = columns[i];
                    const hasOverlap = col.some(existing => Math.max(existing.start, ev.start) < Math.min(existing.end, ev.end));
                    if (!hasOverlap) {
                        col.push(ev);
                        ev.colIndex = i;
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    columns.push([ev]);
                    ev.colIndex = columns.length - 1;
                }
            });
            dayEvents.forEach(ev => {
                const widthPercent = 100 / columns.length;
                ev.style = { left: (ev.colIndex * widthPercent) + '%', width: (widthPercent * 0.8) + '%' };
            });
            return dayEvents;
        };

        const formatTime = (timestamp) => {
            const d = new Date(timestamp);
            if (isNaN(d.getTime())) return '';
            if (props.timeFormat === '12') return df.format(d, 'h:mm a');
            return df.format(d, 'HH:mm');
        };

        const yearMonths = computed(() => {
            const startOfYear = df.startOfYear(currentDate.value);
            const today = new Date();
            return Array.from({ length: 12 }, (_, i) => {
                const monthDate = df.addMonths(startOfYear, i);
                const start = df.startOfMonth(monthDate);
                const monthEnd = df.endOfMonth(monthDate);
                const monthEvents = processedEvents.value.filter(ev =>
                    new Date(ev.start) <= df.endOfDay(monthEnd) && lastDayOf(ev) >= start);

                // A whole month, aligned to the configured first day of the week --
                // the old version showed a fixed 14-day strip from the 1st, which is
                // not a calendar and hid the second half of every month.
                const gridStart = df.startOfWeek(start, { weekStartsOn: weekStartsOn.value });
                const gridEnd = df.endOfWeek(monthEnd, { weekStartsOn: weekStartsOn.value });
                const dayCount = df.differenceInCalendarDays(gridEnd, gridStart) + 1;
                const previewDays = Array.from({ length: dayCount }, (_, idx) => {
                    const dayDate = df.addDays(gridStart, idx);
                    const onDay = monthEvents.filter(ev => occursOn(ev, dayDate));
                    // Up to three dots, one per distinct type, as Syncfusion does.
                    const dotColors = [...new Set(onDay.map(ev => ev.type || 1))]
                        .slice(0, 3)
                        .map(type => colorFor({ type }));
                    return {
                        key: df.format(dayDate, 'yyyy-MM-dd'),
                        date: dayDate,
                        label: df.getDate(dayDate),
                        isCurrentMonth: df.isSameMonth(dayDate, monthDate),
                        isToday: df.isSameDay(dayDate, today),
                        dotColors,
                    };
                });
                const topColors = [...new Set(monthEvents.map(ev => ev.type || 1))]
                    .slice(0, 4)
                    .map(type => colorFor({ type }));
                return {
                    key: df.format(monthDate, 'yyyy-MM'),
                    date: start,
                    label: df.format(monthDate, 'MMMM'),
                    year: df.format(monthDate, 'yyyy'),
                    previewDays,
                    topColors,
                    weekLabels: weekDays.value.map(d => d.charAt(0)),
                    count: monthEvents.length,
                    isCurrent: df.isSameMonth(monthDate, today)
                };
            });
        });

        const agendaSections = computed(() => {
            const dates = visibleDates.value;
            const start = dates.length ? dates[0] : df.startOfWeek(currentDate.value, { weekStartsOn: weekStartsOn.value });
            const end = dates.length ? dates[dates.length - 1] : df.addDays(start, 13);
            const rangeStart = df.startOfDay(start);
            const rangeEnd = df.endOfDay(end);
            const items = processedEvents.value
                // Overlap, so a multi-day event still appears while it is running
                // rather than only on the day it began.
                .filter(ev => new Date(ev.start) <= rangeEnd && lastDayOf(ev) >= rangeStart)
                // start is an ISO string on the stored model, so subtracting the raw
                // values gave NaN and left the list in insertion order -- the agenda
                // was not chronological at all.
                .sort((a, b) => new Date(a.start) - new Date(b.start))
                .map(ev => ({
                    ...ev,
                    color: colorFor(ev),
                    timeLabel: ev.isAllDay ? 'All day' : `${formatTime(ev.start)} - ${formatTime(ev.end)}`,
                    dateObj: new Date(ev.start)
                }));

            const grouped = [];
            items.forEach(ev => {
                const key = df.format(ev.dateObj, 'yyyy-MM-dd');
                let bucket = grouped.find(g => g.key === key);
                if (!bucket) {
                    bucket = {
                        key,
                        label: df.format(ev.dateObj, 'MMMM d'),
                        weekday: df.format(ev.dateObj, 'EEEE'),
                        events: []
                    };
                    grouped.push(bucket);
                }
                bucket.events.push(ev);
            });

            return grouped;
        });

        // colors is a computed, so it has to be unwrapped -- doing it in one
        // helper keeps every caller from having to remember .value.
        const colorFor = (event) => {
            const palette = colors.value;
            return palette[((event.type || 1) - 1) % palette.length];
        };

        const getEventStyle = (event, isWeekView = false) => {
            const color = colorFor(event);
            if (isWeekView) return { borderLeftColor: color, backgroundColor: color + '20', color: color, ...event.style };
            return { backgroundColor: color, color: 'white' };
        };

        // Heights are measured from the first rendered hour, so a grid that starts
        // at 05:00 does not push every event 250px too low.
        const spanStyle = (startMs, endMs) => {
            const top = minutesToTop(startMs);
            const bottom = minutesToTop(endMs);
            return { top: top + 'px', height: Math.max(bottom - top, 20) + 'px' };
        };

        const getWeekEventPosition = (event) => spanStyle(event.start, event.end);

        const getGhostStyle = () => ({
            ...spanStyle(dragState.value.originalStart, dragState.value.originalEnd),
            width: '80%', left: '0%',
        });

        // Interaction Emitters
        const createMonthEvent = (date, evt) => {
            if (!canEdit.value) return;
            const start = df.startOfDay(date);
            const end = df.endOfDay(date);
            emit('event-create', { start: start.getTime(), end: end.getTime(), isAllDay: true, event: evt });
        };

        const createTimeEvent = (date, event) => {
            if (!canEdit.value) return;
            if (dragState.value.isDragging || dragState.value.wasDragging) return;
            if (event.target.closest('.event-card')) return;
            
            const rect = event.currentTarget.getBoundingClientRect();
            const y = event.clientY - rect.top;
            const hoursFloat = y / 50;
            const hours = Math.floor(hoursFloat);
            const start = df.set(date, { hours: hours, minutes: 0 });
            const end = df.addMinutes(start, 60);
            emit('event-create', { start: start.getTime(), end: end.getTime(), isAllDay: false, event: event });
        };

        const selectEvent = (event, e) => {
            if (dragState.value.isDragging || dragState.value.wasDragging) return;
            
            // Logic to handle recurring instances selection
            if (event.isRecurringInstance && event.originalEventId) {
                 const original = props.events.find(ev => ev.id === event.originalEventId);
                 if (original) {
                     selectedEventId.value = original.id;
                     emit('event-click', { event: original, jsEvent: e });
                     return;
                 }
            }
            
            selectedEventId.value = event.id;
            emit('event-click', { event, jsEvent: e });
        };

        // Drag Logic (Simplified forwarding)
        // In a real app, we might emit 'event-update' here
        const startDrag = (event, e, action) => {
            if (e.button !== 0) return;
            if (action === 'resize' ? !resizeEnabled.value : !dragEnabled.value) return;
            
            if (event.isRecurringInstance) {
                // Disable drag for recurring for now
                return;
            }
            
            dragState.value = {
                eventId: event.id,
                isDragging: false,
                wasDragging: false,
                startY: e.clientY,
                originalStart: event.start,
                originalEnd: event.end,
                action: action,
                ghostEvent: event,
                mouseX: e.clientX,
                mouseY: e.clientY
            };
        };

        const onDrag = (e) => {
            if (!dragState.value.eventId) return;
            if (!dragState.value.isDragging) {
                const deltaY = Math.abs(e.clientY - dragState.value.startY);
                const deltaX = Math.abs(e.clientX - dragState.value.mouseX);
                if (deltaY > 5 || deltaX > 5) {
                    dragState.value.isDragging = true;
                }
                else return;
            }
            dragState.value.mouseX = e.clientX;
            dragState.value.mouseY = e.clientY;
            
            // ...
            // Logic unchanged
            
            const event = props.events.find(ev => ev.id === dragState.value.eventId);
            if (event && dragState.value.action === 'time-move') {
                 // ...
                 const deltaPixels = e.clientY - dragState.value.startY;
                 const deltaMinutes = Math.round((deltaPixels / 50) * 60 / 30) * 30;
                 const duration = dragState.value.originalEnd - dragState.value.originalStart;
                 const newStartTime = df.addMinutes(dragState.value.originalStart, deltaMinutes);
                 
                 event.start = newStartTime.getTime();
                 event.end = new Date(newStartTime.getTime() + duration).getTime();
            }
        };

        const stopDrag = (e) => {
            if (!dragState.value.eventId) return;
            if (dragState.value.isDragging) {
                const event = props.events.find(ev => ev.id === dragState.value.eventId);
                if (event) emit('update:events', [...props.events]); 
            }
            const wasDragging = dragState.value.isDragging;
            dragState.value = { eventId: null, isDragging: false, wasDragging, action: 'move' };
            // console.log('[NativeCalendar] stopDrag, wasDragging:', wasDragging);
            setTimeout(() => dragState.value.wasDragging = false, 50);
        };

        // Time Indicator
        const currentTimeTop = ref(0);
        const updateTimeIndicator = () => {
            currentTimeTop.value = minutesToTop(new Date());
        };
        
        onMounted(() => {
            window.addEventListener('mousemove', onDrag);
            window.addEventListener('mouseup', stopDrag);
            setInterval(updateTimeIndicator, 60000);
            updateTimeIndicator();
        });
        onUnmounted(() => {
            window.removeEventListener('mousemove', onDrag);
            window.removeEventListener('mouseup', stopDrag);
        });

        return {
            currentView, views, currentTitle, weekDays, dayNames, monthRows, visibleDates,
            yearMonths, agendaSections, isGridView, hours, startHourNum, allDayRows,
            prev, next, today, changeView, goToMonth, showDay, goToDate,
            selectedDate: computed(() => currentDate.value),
            getEventsForDate, getEventsWithLayout, getEventStyle, getWeekEventPosition, getGhostStyle, formatTime,
            createMonthEvent, createTimeEvent, startDrag, selectEvent,
            dragState, eventCursor, currentTimeTop, selectedEventId, isToday, isSameDay
        };
    }
};
