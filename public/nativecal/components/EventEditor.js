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
                                <select v-model="recurrenceFreq" data-testid="editor-repeat" class="w-full p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2">
                                    <option value="">Does not repeat</option>
                                    <option value="DAILY">Daily</option>
                                    <option value="WEEKLY">Weekly</option>
                                    <option value="MONTHLY">Monthly</option>
                                    <option value="YEARLY">Yearly</option>
                                </select>
                            </div>
                        </div>
                        <div class="flex gap-4" v-if="recurrenceFreq">
                            <div class="w-1/3">
                                <label class="block text-xs font-medium text-color-1 uppercase mb-1">Every</label>
                                <div class="flex items-center">
                                    <input type="number" v-model="recurrenceInterval" min="1" class="w-16 p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2 mr-2">
                                    <span class="text-sm text-color-2 lowercase">{{ getFreqLabel() }}</span>
                                </div>
                            </div>
                            <div class="flex-1">
                                <label class="block text-xs font-medium text-color-1 uppercase mb-1">Until (Optional)</label>
                                <input type="date" v-model="recurrenceUntil" class="w-full p-2 border border-color-default rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none bg-1 text-color-2">
                            </div>
                        </div>
                    </div>

                    <div class="mb-4">
                        <label class="block text-xs font-medium text-color-1 uppercase mb-1">Color</label>
                        <div class="flex gap-2 flex-wrap">
                            <button v-for="(color, idx) in colors" :key="idx"
                                    type="button"
                                    @click="localEvent.type = idx + 1"
                                    class="w-6 h-6 rounded-full transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-gray-400"
                                    :class="{'ring-2 ring-offset-1 ring-black': localEvent.type === idx + 1}"
                                    :style="{ backgroundColor: color }">
                            </button>
                        </div>
                    </div>

                    <div class="mb-2">
                        <label class="block text-xs font-medium text-color-1 uppercase mb-1">Description</label>
                        <textarea v-model="localEvent.description" rows="3" placeholder="Add description"
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
                    }
                } else {
                    // Fallback regex parsing
                    const freqMatch = rule.match(/FREQ=([A-Z]+)/);
                    if (freqMatch) recurrenceFreq.value = freqMatch[1];
                    
                    const intervalMatch = rule.match(/INTERVAL=([0-9]+)/);
                    if (intervalMatch) recurrenceInterval.value = parseInt(intervalMatch[1]);

                    const untilMatch = rule.match(/UNTIL=([0-9TZ]+)/);
                    if (untilMatch) {
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

                if (recurrenceUntil.value) {
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
            getFreqLabel,
            save,
            close,
            deleteEvent
        };
    }
};