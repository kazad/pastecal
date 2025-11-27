const QuickCreatePopover = {
    template: /* html */ `
        <div v-if="visible" 
             class="fixed z-50 bg-1 rounded-lg shadow-xl border border-color-default w-80 overflow-hidden"
             :style="{ top: top + 'px', left: left + 'px' }"
             @click.stop>
             
             <!-- Close Button (positioned absolutely) -->
             <button @click="$emit('close')" data-testid="quick-create-close" 
                     class="absolute top-2 right-2 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors z-10" 
                     title="Close">
                 <icon name="close" class="w-5 h-5" stroke-width="2"></icon>
             </button>

             <!-- Header -->
             <div class="bg-blue-600 px-4 py-3 flex justify-between items-center text-white">
                <h3 class="font-bold text-lg">New Event</h3>
             </div>

             <!-- Body -->
             <div class="p-4 bg-1">
                 <div class="mb-4">
                    <input type="text" 
                           ref="titleInput"
                           v-model="localTitle"
                           @keyup.enter="save"
                           placeholder="Event title" 
                           data-testid="quick-create-title"
                           class="w-full px-3 py-2 border border-color-default rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-color-2 placeholder-gray-400 bg-1">
                 </div>
                 
                 <div class="flex items-center gap-2 mb-4 text-sm text-color-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-color-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>{{ formatTimeRange(start, end) }}</span>
                 </div>

                 <div class="flex justify-end gap-2">
                    <button @click="$emit('more-details', localTitle)" data-testid="quick-create-more-details" class="px-3 py-1.5 text-sm font-medium text-color-2 hover:bg-2 rounded-md transition-colors">
                        More Details
                    </button>
                    <button @click="save" data-testid="quick-create-save" class="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors shadow-sm">
                        Save
                    </button>
                 </div>
             </div>
        </div>
    `,
    props: {
        visible: Boolean,
        start: Number,
        end: Number,
        isAllDay: Boolean,
        top: Number,
        left: Number,
        timeFormat: { type: String, default: '12' }
    },
    emits: ['close', 'save', 'more-details'],
    data() {
        return {
            localTitle: ''
        }
    },
    watch: {
        visible(val) {
            if (val) {
                this.localTitle = '';
                this.$nextTick(() => {
                    if (this.$refs.titleInput) this.$refs.titleInput.focus();
                });
            }
        }
    },
    setup(props, { emit }) {
        const df = window.dateFns;

        const formatTimeRange = (start, end) => {
            const s = new Date(start);
            const e = new Date(end);
            
            if (isNaN(s.getTime()) || isNaN(e.getTime())) return '';
            
            if (props.isAllDay) {
                return df.format(s, 'MMMM d, yyyy') + ' (All Day)';
            }
            
            const fmt = props.timeFormat === '12' ? 'h:mm a' : 'HH:mm';
            
            // If same day
            if (df.isSameDay(s, e)) {
                return `${df.format(s, 'MMM d, ' + fmt)} - ${df.format(e, fmt)}`;
            }
            return `${df.format(s, 'MMM d, ' + fmt)} - ${df.format(e, 'MMM d, ' + fmt)}`;
        };

        return { formatTimeRange };
    },
    methods: {
        save() {
            if (!this.localTitle.trim()) {
                this.localTitle = 'New Event'; // Default title if empty? Or block? 
                // Original requirement: [shows details for the default event time:1 hour duration [more details][save]]
                // Let's allow saving with default or empty title (which usually defaults to (No Title))
            }
            this.$emit('save', this.localTitle);
        }
    }
};
