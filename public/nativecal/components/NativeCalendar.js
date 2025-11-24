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
                <!-- Date Range -->
                <div class="text-xl font-medium text-color-2" data-testid="current-date-range">{{ currentTitle }}</div>
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
    props: ['currentTitle', 'currentView', 'views'],
    emits: ['prev', 'next', 'today', 'change-view']
};

const MonthView = {
    template: /* html */ `
        <div class="h-full flex flex-col overflow-y-auto bg-1">
            <div class="grid grid-cols-7 border-b border-color-default bg-2">
                <div v-for="day in weekDays" :key="day" class="py-2 text-center text-sm font-semibold text-color-1 uppercase tracking-wide">
                    {{ day }}
                </div>
            </div>
            <div class="calendar-grid flex-1" data-testid="month-view-grid">
                <div v-for="(cell, idx) in cells" :key="idx" 
                     class="calendar-cell relative group hover:bg-gray-50 dark:hover:bg-gray-800 flex flex-col gap-1 cursor-pointer"
                     :class="{'bg-disabled opacity-50': !cell.isCurrentMonth, 'bg-blue-50 dark:bg-blue-900': isToday(cell.date)}"
                     :data-date="cell.date.toISOString()"
                     :data-testid="'month-cell-' + idx"
                     @click="$emit('create-event', cell.date, $event)">
                    
                    <span class="text-xs font-medium p-1 ml-auto rounded-full w-7 h-7 flex items-center justify-center"
                          :class="isToday(cell.date) ? 'bg-blue-600 text-white' : 'text-color-2'">
                        {{ cell.dayNumber }}
                    </span>
                    
                    <!-- Ghost Event for Month View -->
                    <div v-if="creatingEvent && creatingEvent.isAllDay && isSameDay(cell.date, new Date(creatingEvent.start))"
                         class="px-1.5 py-0.5 text-xs rounded border-2 border-dashed border-gray-400 bg-2 text-color-1 font-medium select-none mb-1">
                         New Event
                    </div>

                    <div v-for="event in getEventsForDate(cell.date)" :key="event.id"
                         class="px-1.5 py-0.5 text-xs rounded truncate cursor-pointer shadow-sm border-l-2 hover:brightness-95 transition-all select-none"
                         :class="{'is-dragging': dragState.eventId === event.id}"
                         :style="getEventStyle(event)"
                         :data-testid="'event-' + event.id"
                         @mousedown.stop="$emit('start-drag', event, $event, 'month-move')"
                         @click.stop="$emit('select-event', event, $event)">
                         <span v-if="event.isRecurringInstance">↻ </span>
                        {{ event.title }}
                    </div>
                </div>
            </div>
        </div>
    `,
    props: ['cells', 'weekDays', 'dragState', 'getEventsForDate', 'getEventStyle', 'isToday', 'creatingEvent'],
    emits: ['create-event', 'start-drag', 'select-event'],
    setup() {
        const df = window.dateFns;
        const isSameDay = (d1, d2) => df.isSameDay(d1, d2);
        return { isSameDay };
    }
};

const TimeGridView = {
    template: /* html */ `
        <div class="h-full flex flex-col bg-1">
            <div class="border-b border-color-default bg-1 flex-shrink-0 grid"
                 :style="{ gridTemplateColumns: '60px repeat(' + visibleDates.length + ', 1fr)' }">
                <div class="border-r border-color-default p-2"></div>
                <div v-for="(date, idx) in visibleDates" :key="idx" 
                     class="p-2 text-center border-r border-color-default">
                    <div class="text-xs font-semibold text-color-1 uppercase">{{ weekDays[date.getDay()] }}</div>
                    <div class="text-xl font-light w-8 h-8 mx-auto rounded-full flex items-center justify-center text-color-2" 
                         :class="{'bg-blue-600 text-white font-bold': isToday(date)}">
                        {{ date.getDate() }}
                    </div>
                </div>
            </div>

            <div class="flex-1 overflow-y-auto relative bg-1" ref="timeScroll">
                <div class="time-grid relative"
                     :style="{ gridTemplateColumns: '60px repeat(' + visibleDates.length + ', 1fr)' }">
                    
                    <div class="flex flex-col text-xs text-color-1 text-right pr-2 pt-[-0.5rem] bg-1 sticky left-0 z-10 border-r border-color-default">
                        <div v-for="h in 24" :key="h" class="h-[50px] -mt-2.5 bg-1 select-none">
                            {{ formatTimeLabel(h-1) }}
                        </div>
                    </div>
                    
                    <div v-for="(date, idx) in visibleDates" :key="idx" 
                         class="time-col relative"
                         :data-date="date.toISOString()"
                         @click="$emit('create-time-event', date, $event)">
                        
                        <div v-for="h in 24" :key="h" class="hour-row pointer-events-none"></div>
                        
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
                                <div class="opacity-75 text-[10px] pointer-events-none">{{ formatTime(event.start) }} - {{ formatTime(event.end) }}</div>
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
        'currentView', 'visibleDates', 'weekDays', 'isToday', 
        'currentTimeTop', 'dragState', 'selectedEventId', 'eventCursor',
        'getEventsWithLayout', 'getEventStyle', 'getWeekEventPosition', 'getGhostStyle', 'formatTime', 'isSameDay', 'timeFormat',
        'creatingEvent'
    ],
    emits: ['create-time-event', 'start-drag', 'select-event'],
    methods: {
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
            
            const top = (startMinutes / 60) * 50;
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
        'time-grid-view': TimeGridView
    },
    template: /* html */ `
        <div class="flex flex-col h-full w-full bg-1">
            <calendar-toolbar
                :current-title="currentTitle"
                :current-view="currentView"
                :views="views"
                @prev="prev"
                @next="next"
                @today="today"
                @change-view="changeView">
            </calendar-toolbar>

            <div class="flex-1 overflow-hidden relative">
                <month-view v-if="currentView === 'Month'"
                    :cells="monthCells"
                    :week-days="weekDays"
                    :drag-state="dragState"
                    :get-events-for-date="getEventsForDate"
                    :get-event-style="getEventStyle"
                    :is-today="isToday"
                    :creating-event="creatingEvent"
                    @create-event="createMonthEvent"
                    @start-drag="startDrag"
                    @select-event="selectEvent">
                </month-view>

                <time-grid-view v-if="currentView === 'Week' || currentView === 'Day'"
                    :current-view="currentView"
                    :visible-dates="visibleDates"
                    :week-days="weekDays"
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
                
                <!-- Drag Ghost -->
                <div v-if="dragState.isDragging && dragState.action === 'month-move' && dragState.ghostEvent" 
                     class="drag-ghost px-2 py-1 text-xs rounded text-white font-bold truncate w-32 pointer-events-none"
                     :style="[getEventStyle(dragState.ghostEvent), { left: dragState.mouseX + 'px', top: dragState.mouseY + 'px' }]">
                    {{ dragState.ghostEvent.title }}
                </div>
            </div>
        </div>
    `,
    props: ['events', 'timeFormat', 'creatingEvent'],
    emits: ['update:events', 'event-click', 'event-create'],
    /**
     * @param {NativeCalendarProps} props
     * @param {Object} context
     * @param {(event: string, ...args: any[]) => void} context.emit
     */
    setup(props, { emit }) {
        const { ref, computed, onMounted, onUnmounted, watch } = Vue;
        
        const currentView = ref('Month');
        const views = ['Day', 'Week', 'Month']; 
        const currentDate = ref(new Date());
        const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const selectedEventId = ref(null);
        
        const colors = ["#3f51b5", "#e3165b", "#ff6652", "#4caf50", "#ff9800", "#03a9f4", "#9e9e9e", "#27282f"];

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
            return df.format(currentDate.value, 'MMMM yyyy');
        });

        const isToday = (date) => df.isSameDay(date, new Date());
        const isSameDay = (d1, d2) => df.isSameDay(d1, d2);

        // Navigation
        const changeView = (view) => currentView.value = view;
        const prev = () => {
            if (currentView.value === 'Month') currentDate.value = df.subMonths(currentDate.value, 1);
            else if (currentView.value === 'Week') currentDate.value = df.subWeeks(currentDate.value, 1);
            else currentDate.value = df.subDays(currentDate.value, 1);
        };
        const next = () => {
            if (currentView.value === 'Month') currentDate.value = df.addMonths(currentDate.value, 1);
            else if (currentView.value === 'Week') currentDate.value = df.addWeeks(currentDate.value, 1);
            else currentDate.value = df.addDays(currentDate.value, 1);
        };
        const today = () => currentDate.value = new Date();

        // Grid Logic
        const monthCells = computed(() => {
            const start = df.startOfMonth(currentDate.value);
            const end = df.endOfMonth(currentDate.value);
            const days = df.eachDayOfInterval({ start, end });
            const startDay = df.getDay(start);
            const prevMonthDays = [];
            for(let i = 0; i < startDay; i++) {
                prevMonthDays.unshift({
                    date: df.subDays(start, i + 1),
                    dayNumber: df.getDate(df.subDays(start, i + 1)),
                    isCurrentMonth: false
                });
            }
            const currentMonthDays = days.map(d => ({ date: d, dayNumber: df.getDate(d), isCurrentMonth: true }));
            const totalCells = 42; 
            const remaining = totalCells - (prevMonthDays.length + currentMonthDays.length);
            const nextMonthDays = [];
            for(let i = 1; i <= remaining; i++) {
                nextMonthDays.push({
                    date: df.addDays(end, i),
                    dayNumber: df.getDate(df.addDays(end, i)),
                    isCurrentMonth: false
                });
            }
            return [...prevMonthDays, ...currentMonthDays, ...nextMonthDays];
        });

        const visibleDates = computed(() => {
            if (currentView.value === 'Day') return [currentDate.value];
            const start = df.startOfWeek(currentDate.value);
            return Array.from({ length: 7 }, (_, i) => df.addDays(start, i));
        });

        // Recurrence Expansion Logic
        const processedEvents = computed(() => {
            const results = [];
            
            // 1. Determine range (generous padding to avoid edge cases)
            let rangeStart, rangeEnd;
            if (currentView.value === 'Month') {
                 const start = df.startOfMonth(currentDate.value);
                 rangeStart = df.subWeeks(start, 1);
                 rangeEnd = df.addWeeks(df.endOfMonth(currentDate.value), 1);
            } else {
                // Week/Day
                const visible = visibleDates.value;
                rangeStart = df.subDays(visible[0], 1);
                rangeEnd = df.addDays(visible[visible.length - 1], 1);
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
                        
                        const rule = new RRule(options);
                        
                        const dates = rule.between(rangeStart, rangeEnd, true);
                        
                        const duration = event.end - event.start;
                        
                        dates.forEach(date => {
                             // Virtual event
                             const start = date.getTime();
                             const end = start + duration;
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
        const getEventsForDate = (date) => {
            return processedEvents.value.filter(e => df.isSameDay(new Date(e.start), date));
        };

        const getEventsWithLayout = (date) => {
            const dayEvents = getEventsForDate(date).map(e => ({...e}));
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

        const getEventStyle = (event, isWeekView = false) => {
            const color = colors[(event.type - 1) % colors.length];
            if (isWeekView) return { borderLeftColor: color, backgroundColor: color + '20', color: color, ...event.style };
            return { backgroundColor: color, color: 'white' };
        };

        const getWeekEventPosition = (event) => {
            const start = new Date(event.start);
            const end = new Date(event.end);
            const startMinutes = start.getHours() * 60 + start.getMinutes();
            const endMinutes = end.getHours() * 60 + end.getMinutes();
            const top = (startMinutes / 60) * 50;
            const height = Math.max(((endMinutes - startMinutes) / 60) * 50, 20);
            return { top: top + 'px', height: height + 'px' };
        };

        const getGhostStyle = () => {
            const start = new Date(dragState.value.originalStart);
            const end = new Date(dragState.value.originalEnd);
            const startMinutes = start.getHours() * 60 + start.getMinutes();
            const endMinutes = end.getHours() * 60 + end.getMinutes();
            const top = (startMinutes / 60) * 50;
            const height = Math.max(((endMinutes - startMinutes) / 60) * 50, 20);
            return { top: top + 'px', height: height + 'px', width: '80%', left: '0%' };
        };

        // Interaction Emitters
        const createMonthEvent = (date, evt) => {
            const start = df.startOfDay(date);
            const end = df.endOfDay(date);
            emit('event-create', { start: start.getTime(), end: end.getTime(), isAllDay: true, event: evt });
        };

        const createTimeEvent = (date, event) => {
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
            const now = new Date();
            currentTimeTop.value = ((now.getHours() * 60 + now.getMinutes()) / 60) * 50;
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
            currentView, views, currentTitle, weekDays, monthCells, visibleDates,
            prev, next, today, changeView,
            getEventsForDate, getEventsWithLayout, getEventStyle, getWeekEventPosition, getGhostStyle, formatTime,
            createMonthEvent, createTimeEvent, startDrag, selectEvent,
            dragState, eventCursor, currentTimeTop, selectedEventId, isToday, isSameDay
        };
    }
};
