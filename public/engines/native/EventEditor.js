const EventEditor = {
    template: /* html */ `
        <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" @click.self="close">
            <div class="bg-1 rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[90vh]">
                <!-- Header -->
                <div class="px-4 py-3 border-b border-color-default flex justify-between items-center bg-2">
                    <h3 class="font-bold text-color-2">{{ isNew ? 'New Event' : 'Edit Event' }}</h3>
                    <button @click="close" data-testid="editor-close" class="text-color-1 hover:text-color-2 transition-colors">
                        <icon name="close" class="w-5 h-5"></icon>
                    </button>
                </div>

                <!-- Body -->
                <div class="p-4 overflow-y-auto flex-1 bg-1">
                    <div class="mb-4">
                        <input v-model="localEvent.title" type="text" placeholder="Add title" 
                               data-testid="editor-title"
                               class="w-full text-xl font-semibold border-b-2 border-color-default focus:border-blue-500 focus:outline-none pb-1 placeholder-gray-400 bg-1 text-color-2"
                               ref="titleInput">
                    </div>

                    <div class="grid grid-cols-2 gap-4 mb-4">
                        <div class="col-span-2 flex items-center mb-2">
                            <input type="checkbox" id="isAllDay" v-model="localEvent.isAllDay" class="mr-2 accent-blue-600">
                            <label for="isAllDay" class="text-sm text-color-2">All Day</label>
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-color-1 uppercase mb-1">Start</label>
                            <!-- Separate inputs to avoid type mismatch warnings -->
                            <input v-if="localEvent.isAllDay" type="date" v-model="formattedStart" 
                                   class="w-full p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2">
                            <input v-else type="datetime-local" v-model="formattedStart" 
                                   class="w-full p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2">
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-color-1 uppercase mb-1">End</label>
                            <input v-if="localEvent.isAllDay" type="date" v-model="formattedEnd" 
                                   class="w-full p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2">
                            <input v-else type="datetime-local" v-model="formattedEnd" 
                                   class="w-full p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2">
                        </div>
                    </div>

                    <!-- Recurrence -->
                    <div class="mb-4">
                         <div class="flex gap-4 mb-2">
                            <div class="flex-1">
                                <label class="block text-xs font-medium text-color-1 uppercase mb-1">Repeat</label>
                                <select v-model="recurrenceFreq" @change="touchRecurrence" data-testid="editor-repeat" class="w-full p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2">
                                    <option value="">Does not repeat</option>
                                    <option value="DAILY">Daily</option>
                                    <option value="WEEKLY">Weekly</option>
                                    <option value="MONTHLY">Monthly</option>
                                    <option value="YEARLY">Yearly</option>
                                </select>
                            </div>
                        </div>
                        <div v-if="recurrenceFreq" class="space-y-3">
                            <div class="w-1/3">
                                <label class="block text-xs font-medium text-color-1 uppercase mb-1">Every</label>
                                <div class="flex items-center">
                                    <input type="number" v-model="recurrenceInterval" min="1" @change="touchRecurrence"
                                           data-testid="editor-repeat-interval"
                                           class="w-16 p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2 mr-2">
                                    <span class="text-sm text-color-2 lowercase">{{ getFreqLabel() }}</span>
                                </div>
                            </div>

                            <!-- Which days a weekly rule fires on -->
                            <div v-if="recurrenceFreq === 'WEEKLY'">
                                <label class="block text-xs font-medium text-color-1 uppercase mb-1">On</label>
                                <div class="flex gap-1" data-testid="editor-repeat-byday">
                                    <button v-for="day in weekdays" :key="day.code" type="button"
                                            @click="toggleByDay(day.code)"
                                            :aria-pressed="recurrenceByDay.includes(day.code) ? 'true' : 'false'"
                                            :data-testid="'editor-byday-' + day.code"
                                            class="w-8 h-8 rounded-full text-xs font-semibold border border-color-default transition-colors"
                                            :class="recurrenceByDay.includes(day.code) ? 'bg-blue-600 text-white border-blue-600' : 'bg-1 text-color-2 hover:bg-2'">
                                        {{ day.label }}
                                    </button>
                                </div>
                            </div>

                            <!-- Monthly rules repeat on a date or on a weekday position -->
                            <div v-if="recurrenceFreq === 'MONTHLY'">
                                <label class="block text-xs font-medium text-color-1 uppercase mb-1">Repeats on</label>
                                <div class="flex flex-col gap-1 text-sm text-color-2">
                                    <label class="flex items-center gap-2">
                                        <input type="radio" value="date" v-model="monthlyMode" @change="touchRecurrence"
                                               data-testid="editor-monthly-date" class="accent-blue-600">
                                        day {{ monthlyDayOfMonth }} of the month
                                    </label>
                                    <label class="flex items-center gap-2">
                                        <input type="radio" value="weekday" v-model="monthlyMode" @change="touchRecurrence"
                                               data-testid="editor-monthly-weekday" class="accent-blue-600">
                                        the {{ monthlyPosition.label }}
                                    </label>
                                </div>
                            </div>

                            <!-- Ends -->
                            <div>
                                <label class="block text-xs font-medium text-color-1 uppercase mb-1">Ends</label>
                                <div class="flex flex-col gap-1 text-sm text-color-2">
                                    <label class="flex items-center gap-2">
                                        <input type="radio" value="never" v-model="recurrenceEnd" @change="touchRecurrence"
                                               data-testid="editor-ends-never" class="accent-blue-600">
                                        Never
                                    </label>
                                    <label class="flex items-center gap-2">
                                        <input type="radio" value="until" v-model="recurrenceEnd" @change="touchRecurrence"
                                               data-testid="editor-ends-until" class="accent-blue-600">
                                        On
                                        <input type="date" v-model="recurrenceUntil" @change="touchRecurrence"
                                               :disabled="recurrenceEnd !== 'until'"
                                               data-testid="editor-repeat-until"
                                               class="flex-1 p-1 border border-color-default rounded text-sm bg-1 text-color-2 disabled:opacity-50">
                                    </label>
                                    <label class="flex items-center gap-2">
                                        <input type="radio" value="count" v-model="recurrenceEnd" @change="touchRecurrence"
                                               data-testid="editor-ends-count" class="accent-blue-600">
                                        After
                                        <input type="number" min="1" v-model.number="recurrenceCount" @change="touchRecurrence"
                                               :disabled="recurrenceEnd !== 'count'"
                                               data-testid="editor-repeat-count"
                                               class="w-20 p-1 border border-color-default rounded text-sm bg-1 text-color-2 disabled:opacity-50">
                                        occurrences
                                    </label>
                                </div>
                            </div>
                        </div>

                        <!-- A rule using parts this editor cannot show. Saving keeps it
                             as-is unless a recurrence control is actually touched. -->
                        <p v-if="unsupportedRule" data-testid="editor-repeat-advanced"
                           class="mt-2 text-xs text-color-1 italic">
                            This event uses an advanced repeat rule. It is kept as-is unless you change something here.
                        </p>
                    </div>

                    <div class="mb-4">
                        <label class="block text-xs font-medium text-color-1 uppercase mb-1">
                            Type
                            <span class="normal-case font-normal text-color-2" data-testid="editor-type-label">
                                &middot; {{ typeLabelFor((localEvent.type || 1) - 1) }}
                            </span>
                        </label>
                        <div class="flex gap-2 flex-wrap">
                            <button v-for="(color, idx) in colors" :key="idx"
                                    type="button"
                                    @click="localEvent.type = idx + 1"
                                    :title="typeLabelFor(idx)"
                                    :aria-label="typeLabelFor(idx)"
                                    :data-testid="'editor-type-' + (idx + 1)"
                                    class="w-6 h-6 rounded-full transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-gray-400"
                                    :class="{'ring-2 ring-offset-1 ring-black': localEvent.type === idx + 1}"
                                    :style="{ backgroundColor: color }">
                            </button>
                        </div>
                    </div>

                    <div class="mb-2">
                        <label class="block text-xs font-medium text-color-1 uppercase mb-1">Description</label>
                        <textarea v-model="localEvent.description" rows="3" placeholder="Add description"
                                  data-testid="editor-description"
                                  class="w-full p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none resize-none bg-1 text-color-2"></textarea>
                    </div>
                </div>

                <!-- Footer -->
                <div class="px-4 py-3 border-t border-color-default bg-2 flex justify-between items-center">
                    <button v-if="!isNew" @click="deleteEvent" data-testid="editor-delete" class="text-red-500 hover:text-red-700 text-sm font-medium px-3 py-2 rounded hover:bg-red-50 transition-colors">
                        Delete
                    </button>
                    <div v-else></div> <!-- Spacer -->
                    
                    <div class="flex gap-2">
                        <button @click="close" data-testid="editor-cancel" class="px-4 py-2 text-sm font-medium text-color-2 hover:bg-1 rounded transition-colors">Cancel</button>
                        <button @click="save" data-testid="editor-save" class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded shadow-sm transition-colors">Save</button>
                    </div>
                </div>
            </div>
        </div>
    `,
    props: {
        event: Object,
        visible: Boolean,
        colors: {
            type: Array,
            default: () => ["#3f51b5", "#e3165b", "#ff6652", "#4caf50", "#ff9800", "#03a9f4", "#9e9e9e", "#27282f"]
        },
        // The user's own names for the eight types. Syncfusion's editor shows these
        // in its dropdown; unlabelled swatches lose them exactly where they matter.
        typeLabels: {
            type: Array,
            default: () => []
        }
    },
    emits: ['update:visible', 'save', 'delete'],
    /**
     * @param {EventEditorProps} props
     * @param {Object} context
     * @param {(event: string, ...args: any[]) => void} context.emit
     */
    setup(props, { emit }) {
        const { ref, watch, computed, nextTick } = Vue;
        const df = window.dateFns;

        const localEvent = ref({ ...props.event });
        const titleInput = ref(null);
        const recurrenceFreq = ref('');
        const recurrenceInterval = ref(1);
        const recurrenceUntil = ref('');
        // Which weekdays a weekly rule fires on (BYDAY).
        const recurrenceByDay = ref([]);
        // Monthly rules repeat either on a date ("the 14th") or on a weekday
        // position ("the third Tuesday", BYDAY + BYSETPOS).
        const monthlyMode = ref('date');
        // How the rule ends: never, on a date (UNTIL), or after N (COUNT).
        const recurrenceEnd = ref('never');
        const recurrenceCount = ref(10);

        const WEEKDAYS = [
            { code: 'SU', label: 'S' }, { code: 'MO', label: 'M' }, { code: 'TU', label: 'T' },
            { code: 'WE', label: 'W' }, { code: 'TH', label: 'T' }, { code: 'FR', label: 'F' },
            { code: 'SA', label: 'S' },
        ];

        // The rule exactly as it arrived. If the user never touches a recurrence
        // control, this is what gets saved back -- see the note on recurrenceDirty.
        const originalRule = ref('');
        const recurrenceDirty = ref(false);
        const touchRecurrence = () => { recurrenceDirty.value = true; };

        // Parts of RRULE this editor can represent. A rule using anything else
        // (BYMONTHDAY lists, BYWEEKNO, BYYEARDAY...) would be silently rewritten
        // into something simpler on save, so instead we keep it untouched and say
        // so. Syncfusion's editor writes BYDAY, BYSETPOS and COUNT, so rules
        // created there round-trip; rules from an imported ICS may not.
        const SUPPORTED_PARTS = ['FREQ', 'INTERVAL', 'BYDAY', 'BYSETPOS', 'COUNT', 'UNTIL', 'WKST'];
        const unsupportedRule = computed(() => {
            const rule = originalRule.value;
            if (!rule) return false;
            return rule.split(';').some(part => {
                const key = part.split('=')[0].trim().toUpperCase().replace(/^RRULE:/, '');
                return key && !SUPPORTED_PARTS.includes(key);
            });
        });

        const toggleByDay = (code) => {
            touchRecurrence();
            const list = recurrenceByDay.value;
            recurrenceByDay.value = list.includes(code)
                ? list.filter(d => d !== code)
                : [...list, code];
        };

        // "the third Tuesday" for whatever day the event starts on. -1 is the last
        // such weekday of the month, which is how a 5th-week start reads.
        const monthlyDayOfMonth = computed(() => {
            const start = new Date(localEvent.value.start || Date.now());
            return isNaN(start.getTime()) ? 1 : start.getDate();
        });

        // Falls back to "Type N" when the calendar has not renamed its types.
        const typeLabelFor = (index) => {
            const labels = props.typeLabels || [];
            return labels[index] || `Type ${index + 1}`;
        };

        const monthlyPosition = computed(() => {
            const start = new Date(localEvent.value.start || Date.now());
            if (isNaN(start.getTime())) return { day: 'MO', pos: 1, label: '' };
            const day = WEEKDAYS[start.getDay()].code;
            const nth = Math.ceil(start.getDate() / 7);
            const pos = nth > 4 ? -1 : nth;
            const names = ['first', 'second', 'third', 'fourth'];
            const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][start.getDay()];
            return { day, pos, label: `${pos === -1 ? 'last' : names[pos - 1]} ${dayName}` };
        });

        const isNew = computed(() => !props.event?.id || props.event.id.toString().startsWith('temp_'));

        // Format helpers
        const pad = (n) => n.toString().padStart(2, '0');
        
        const toDateTimeStr = (ts) => {
            if (!ts) return '';
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '';
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };

        const toDateStr = (ts) => {
            if (!ts) return '';
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '';
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
        };

        const formattedStart = ref('');
        const formattedEnd = ref('');

        const updateFormattedDates = () => {
             const start = localEvent.value.start;
             const end = localEvent.value.end;
             if (localEvent.value.isAllDay) {
                 formattedStart.value = toDateStr(start);
                 formattedEnd.value = toDateStr(end);
             } else {
                 formattedStart.value = toDateTimeStr(start);
                 formattedEnd.value = toDateTimeStr(end);
             }
        };

        const getFreqLabel = () => {
            if (!recurrenceFreq.value) return '';
            const labels = {
                'DAILY': 'Day(s)',
                'WEEKLY': 'Week(s)',
                'MONTHLY': 'Month(s)',
                'YEARLY': 'Year(s)'
            };
            return labels[recurrenceFreq.value] || '';
        };

        const parseRecurrence = (rule) => {
            originalRule.value = rule || '';
            recurrenceDirty.value = false;
            recurrenceFreq.value = '';
            recurrenceInterval.value = 1;
            recurrenceUntil.value = '';
            recurrenceByDay.value = [];
            recurrenceCount.value = 10;
            recurrenceEnd.value = 'never';
            monthlyMode.value = 'date';
            recurrenceFreq.value = '';
            recurrenceUntil.value = '';
            recurrenceInterval.value = 1;
            
            if (!rule || typeof rule !== 'string') return;
            
            // Sanitize: remove empty segments or double semicolons
            rule = rule.split(';').filter(part => part.trim() !== '').join(';');
            if (!rule) return;

            try {
                // Simple manual parsing to avoid full RRule overhead if possible, 
                // but since we loaded rrule, we could use it.
                // However, rrule.js parsing to options object is rrule.rrulestr(rule).options
                if (window.rrule && window.rrule.rrulestr) {
                    // Note: rrulestr might need dtstart if it's a complete set, but for single rule string it's fine.
                    // Actually, rrulestr parses the string into an RRule object.
                    const rruleObj = window.rrule.rrulestr("RRULE:" + rule); // Prefix with RRULE: if missing?
                    // Usually rule is just "FREQ=WEEKLY;..."
                    // If rrule library is present:
                    const options = rruleObj.options;
                    
                    const freqs = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'];
                    if (options.freq !== undefined && freqs[options.freq]) {
                        recurrenceFreq.value = freqs[options.freq];
                    }
                    
                    if (options.interval) {
                        recurrenceInterval.value = options.interval;
                    }

                    if (options.until) {
                        recurrenceUntil.value = toDateStr(options.until.getTime());
                        recurrenceEnd.value = 'until';
                    }
                    if (options.count) {
                        recurrenceCount.value = options.count;
                        recurrenceEnd.value = 'count';
                    }
                    if (options.byweekday && options.byweekday.length) {
                        // rrule reports weekdays as 0=Monday; RRULE codes start at Sunday.
                        const CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
                        recurrenceByDay.value = options.byweekday
                            .map(d => CODES[typeof d === 'number' ? d : d.weekday])
                            .filter(Boolean);
                    }
                    if (options.bysetpos && options.bysetpos.length) {
                        monthlyMode.value = 'weekday';
                    }
                } else {
                    // Fallback regex parsing
                    const freqMatch = rule.match(/FREQ=([A-Z]+)/);
                    if (freqMatch) recurrenceFreq.value = freqMatch[1];
                    
                    const intervalMatch = rule.match(/INTERVAL=([0-9]+)/);
                    if (intervalMatch) recurrenceInterval.value = parseInt(intervalMatch[1]);

                    const byDayMatch = rule.match(/BYDAY=([A-Z0-9,+-]+)/);
                    if (byDayMatch) {
                        const entries = byDayMatch[1].split(',');
                        // "3TU" is the other way to write "third Tuesday", without a
                        // separate BYSETPOS -- the digits are the position.
                        if (entries.some(d => /\d/.test(d))) monthlyMode.value = 'weekday';
                        recurrenceByDay.value = entries
                            .map(d => d.replace(/[^A-Z]/g, ''))
                            .filter(Boolean);
                    }
                    if (/BYSETPOS=/.test(rule)) monthlyMode.value = 'weekday';

                    const countMatch = rule.match(/COUNT=([0-9]+)/);
                    if (countMatch) {
                        recurrenceCount.value = parseInt(countMatch[1]);
                        recurrenceEnd.value = 'count';
                    }

                    const untilMatch = rule.match(/UNTIL=([0-9TZ]+)/);
                    if (untilMatch) {
                        recurrenceEnd.value = 'until';
                        // Parse basic ISO basic format 20250501T000000Z or 20250501
                        const u = untilMatch[1];
                        const y = u.substring(0,4), m = u.substring(4,6), d = u.substring(6,8);
                        recurrenceUntil.value = `${y}-${m}-${d}`;
                    }
                }
            } catch (e) {
                console.warn("Failed to parse recurrence rule", e);
            }
        };

        watch(() => props.event, (newVal) => {
            if (newVal) {
                localEvent.value = { ...newVal, type: newVal.type || 1, isAllDay: !!newVal.isAllDay };
                updateFormattedDates();
                parseRecurrence(newVal.recurrencerule);
            }
        }, { deep: true, immediate: true });

        watch(() => localEvent.value.isAllDay, (newVal, oldVal) => {
            if (newVal === oldVal) return;
            
            let currentStart, currentEnd;
            
            if (oldVal) { 
                // Was AllDay (Date string), switching to Time (DateTime string)
                // Treat Date string as local midnight
                currentStart = new Date(formattedStart.value + 'T00:00').getTime();
                currentEnd = new Date(formattedEnd.value + 'T00:00').getTime();
            } else {
                // Was Time (DateTime string), switching to AllDay (Date string)
                currentStart = new Date(formattedStart.value).getTime();
                currentEnd = new Date(formattedEnd.value).getTime();
            }
            
            if (!isNaN(currentStart)) localEvent.value.start = currentStart;
            if (!isNaN(currentEnd)) localEvent.value.end = currentEnd;
            
            updateFormattedDates();
        });

        watch(() => props.visible, (val) => {
            if (val) {
                nextTick(() => {
                    if (titleInput.value) titleInput.value.focus();
                });
            }
        });

        const save = () => {
            let startTs, endTs;
            
            if (localEvent.value.isAllDay) {
                startTs = new Date(formattedStart.value + 'T00:00').getTime();
                endTs = new Date(formattedEnd.value + 'T23:59:59.999').getTime();
            } else {
                startTs = new Date(formattedStart.value).getTime();
                endTs = new Date(formattedEnd.value).getTime();
            }
            
            if (isNaN(startTs) || isNaN(endTs)) {
                alert("Invalid dates");
                return;
            }

            if (endTs <= startTs) {
                alert("End time must be after start time");
                return;
            }

            // Build Recurrence Rule
            let rruleStr = "";
            if (recurrenceFreq.value) {
                rruleStr = `FREQ=${recurrenceFreq.value}`;
                
                if (recurrenceInterval.value && recurrenceInterval.value > 1) {
                    rruleStr += `;INTERVAL=${recurrenceInterval.value}`;
                }

                if (recurrenceFreq.value === 'WEEKLY' && recurrenceByDay.value.length) {
                    rruleStr += `;BYDAY=${recurrenceByDay.value.join(',')}`;
                }

                // "the third Tuesday" -- written the way Syncfusion writes it, so
                // rules survive a round trip between the two editors.
                if (recurrenceFreq.value === 'MONTHLY' && monthlyMode.value === 'weekday') {
                    rruleStr += `;BYDAY=${monthlyPosition.value.day};BYSETPOS=${monthlyPosition.value.pos}`;
                }

                if (recurrenceEnd.value === 'count' && recurrenceCount.value > 0) {
                    rruleStr += `;COUNT=${recurrenceCount.value}`;
                }

                if (recurrenceEnd.value === 'until' && recurrenceUntil.value) {
                    // Format to YYYYMMDDTHHMMSSZ or local
                    // Since we use local dates for start/end, let's use floating UNTIL (no Z)
                    // matching the start time.
                    const uDate = new Date(recurrenceUntil.value + 'T23:59:59'); // inclusive end of that day
                    const y = uDate.getFullYear();
                    const m = pad(uDate.getMonth() + 1);
                    const d = pad(uDate.getDate());
                    // T235959 to include the whole day
                    rruleStr += `;UNTIL=${y}${m}${d}T235959`; 
                }
            }

            // A rule this editor cannot fully represent must not be rewritten just
            // because the event was opened and saved. Only replace it when a
            // recurrence control was actually used.
            if (!recurrenceDirty.value && originalRule.value) {
                rruleStr = originalRule.value;
            }

            emit('save', {
                ...localEvent.value,
                start: startTs,
                end: endTs,
                title: localEvent.value.title || '(No Title)',
                recurrencerule: rruleStr
            });
        };

        const close = () => {
            emit('update:visible', false);
        };

        const deleteEvent = () => {
            if (confirm("Are you sure you want to delete this event?")) {
                emit('delete', localEvent.value.id);
            }
        };

        return {
            localEvent,
            isNew,
            formattedStart,
            formattedEnd,
            titleInput,
            recurrenceFreq,
            recurrenceInterval,
            recurrenceUntil,
            recurrenceByDay,
            recurrenceEnd,
            recurrenceCount,
            monthlyMode,
            monthlyPosition,
            monthlyDayOfMonth,
            weekdays: WEEKDAYS,
            toggleByDay,
            touchRecurrence,
            unsupportedRule,
            typeLabelFor,
            getFreqLabel,
            save,
            close,
            deleteEvent
        };
    }
};