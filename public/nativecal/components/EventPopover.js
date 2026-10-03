const EventPopover = {
    template: /* html */ `
        <div v-if="visible"
             class="fixed z-40 bg-1 rounded-lg shadow-xl border border-color-default flex flex-col"
             :class="isLongDescription ? 'w-[480px] max-w-[calc(100vw-20px)]' : 'w-80'"
             :style="{ top: top + 'px', left: left + 'px', maxHeight: 'calc(100vh - 20px)' }">
             
             <!-- Close Button (positioned absolutely) -->
             <button @click="$emit('close')" data-testid="popover-close" 
                     class="absolute top-2 right-2 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors z-10" 
                     title="Close">
                 <icon name="close" class="w-5 h-5" stroke-width="2"></icon>
             </button>

             <!-- Header -->
             <div class="bg-blue-600 px-4 py-3 flex justify-between items-start text-white shrink-0 rounded-t-lg">
                <h3 class="font-bold text-lg truncate flex-1 mr-2" data-testid="popover-title">{{ title }}</h3>
                <div class="flex items-center gap-1">
                    <button @click="startEdit" data-testid="popover-edit" class="p-1 hover:bg-blue-700 rounded transition-colors" title="Edit">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                    <button @click="asking = 'delete'" data-testid="popover-delete" class="p-1 hover:bg-blue-700 rounded transition-colors" title="Delete">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                </div>
             </div>

             <!-- Which occurrences: asked before a delete (always) and before an edit of
                  one occurrence of a series. One click on the trash used to delete every
                  occurrence of a series, with no question and no way back. -->
             <div v-if="asking" class="px-4 py-3 border-b border-color-default bg-2" data-testid="popover-ask" role="group"
                  :aria-label="asking === 'delete' ? 'Delete which events' : 'Edit which events'">
                 <div class="text-sm font-medium text-color-2 mb-2">
                     {{ asking === 'delete' ? (isOccurrence ? 'Delete which events?' : 'Delete "' + title + '"?') : 'Edit which events?' }}
                 </div>
                 <div class="flex flex-wrap gap-2">
                     <template v-if="isOccurrence">
                         <button v-for="opt in scopes" :key="opt.scope" @click="choose(opt.scope)"
                                 :data-testid="'popover-' + asking + '-' + opt.scope"
                                 class="px-2.5 py-1 text-xs font-medium rounded-md border border-color-default text-color-2 hover:bg-1">{{ opt.label }}</button>
                     </template>
                     <button v-else @click="choose('all')" data-testid="popover-delete-confirm"
                             class="px-2.5 py-1 text-xs font-medium rounded-md bg-red-600 text-white hover:bg-red-700">Delete</button>
                     <button @click="asking = null" data-testid="popover-ask-cancel"
                             class="px-2.5 py-1 text-xs font-medium rounded-md text-color-1 hover:bg-1">Cancel</button>
                 </div>
             </div>

             <!-- Body -->
             <div class="p-4 bg-1 overflow-y-auto">
                 <div class="flex items-start gap-3 mb-2">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-color-1 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    <div class="text-sm text-color-2">
                        <div class="font-medium" data-testid="popover-date">{{ formatDate(event.start) }}</div>
                        <div class="text-color-1">
                            <template v-if="event.isAllDay">All day</template>
                            <template v-else>{{ formatTime(event.start) }} - {{ formatTime(event.end) }}</template>
                        </div>
                    </div>
                 </div>

                 <div v-if="event.isRecurringInstance || event.recurrencerule" class="flex items-start gap-3 mb-2 text-sm text-blue-600 font-medium">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    <div>Recurring Event</div>
                 </div>

                 <div v-if="event.description" class="flex items-start gap-3 mt-3 pt-3 border-t border-color-default">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-color-1 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" /></svg>
                    <div data-testid="popover-description" class="text-sm text-color-1 whitespace-pre-wrap" v-html="linkifiedDescription"></div>
                 </div>
             </div>
        </div>
    `,
    props: {
        event: Object,
        visible: Boolean,
        top: Number,
        left: Number,
        timeFormat: { type: String, default: '12' }
    },
    emits: ['close', 'edit', 'delete'],
    setup(props, { emit }) {
        const { computed, ref } = Vue;

        // One occurrence of a series (NativeCalendar passes which one): the actions ask
        // which occurrences they apply to.
        const isOccurrence = computed(() => !!props.event && props.event.occurrenceStart !== undefined
            && !!props.event.recurrencerule && !props.event.recurrenceID);
        const title = computed(() => UndoService.eventName(props.event));
        const asking = ref(null);   // 'delete' | 'edit' | null
        const scopes = [
            { scope: 'this', label: 'This event' },
            { scope: 'following', label: 'This and following' },
            { scope: 'all', label: 'All events' },
        ];
        const startEdit = () => {
            if (isOccurrence.value) asking.value = 'edit';
            else emit('edit', props.event, 'all');
        };
        const choose = (scope) => {
            const what = asking.value;
            asking.value = null;
            if (what === 'delete') emit('delete', { event: props.event, scope });
            else emit('edit', props.event, scope);
        };
        const df = window.dateFns;

        const formatDate = (ts) => df.format(new Date(ts), 'MMMM d, yyyy');
        const formatTime = (ts) => {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '';
            return props.timeFormat === '12' ? df.format(d, 'h:mm a') : df.format(d, 'HH:mm');
        };

        // Widen the popup for long descriptions -- narrow-column wrapping makes a
        // multi-paragraph description feel cramped. Short descriptions stay at the
        // original compact width so a quick one-liner doesn't get an oversized card.
        const LONG_DESCRIPTION_THRESHOLD = 140;
        const isLongDescription = computed(() =>
            (props.event?.description?.length || 0) > LONG_DESCRIPTION_THRESHOLD);

        const linkifiedDescription = computed(() =>
            Linkify.toHtml(props.event?.description || '', { linkClass: 'text-blue-600 hover:underline' }));

        return { formatDate, formatTime, linkifiedDescription, isLongDescription,
            isOccurrence, title, asking, scopes, startEdit, choose };
    }
};