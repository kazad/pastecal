// QuickAddDialog Component
// Single source of truth for parsing/creating events with natural language

const QuickAddDialog = {
    template: /* html */ `
        <div v-if="dialogVisible" 
                 class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div class="bg-1 rounded-lg p-6 w-[80%] max-w-[500px]">
                    <h3 class="text-lg font-semibold mb-4">Add Event by Typing</h3>
                    <form @submit.prevent="createEvent">
                        <textarea v-model="description"
                                 aria-label="Event description"
                                 placeholder="Describe event here (e.g., 'Meet John tomorrow 2pm'). Hit Enter to create."
                                 rows="3"
                                 @keydown.enter.prevent="handleEnter"
                                 class="w-full p-2 border border-color-default rounded mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500">
                        </textarea>

                        <div class="bg-1 rounded p-4 mb-4">
                            <p><strong>Subject:</strong> {{ parsedEvent?.subject }}</p>
                            <p><strong>Start:</strong> {{ formatDate(parsedEvent?.startDateTime) }}</p>
                            <p><strong>End:</strong> {{ formatDate(parsedEvent?.endDateTime) }}</p>
                        </div>

                        <pre class="bg-1 p-4 rounded mb-4 text-sm whitespace-pre">
Examples: 

lunch tomorrow 2pm for 1 hour
appointment 9/15 at 2:30pm
birthday party Sat 7pm to 11pm
workout 3pm May 20 for 90 minutes
vacation dec 11 - dec 15
</pre>

                        <div class="flex justify-end gap-2">
                            <button type="button" 
                                    @click="hideDialog"
                                    class="px-4 py-2 border border-color-default rounded hover:bg-[var(--bg-interactive-hover)]">
                                Cancel
                            </button>
                            <button type="submit" 
                                    :disabled="!isValidEvent"
                                    class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50">
                                Create
                            </button>
                        </div>
                    </form>
                </div>
            </div>
    `,
    props: {
        mode: {
            type: String,
            default: 'desktop'
        }
    },
    data() {
        return {
            dialogVisible: false,
            description: '',
            parsedEvent: null
        };
    },
    computed: {
        isValidEvent() {
            return this.parsedEvent &&
                this.parsedEvent.subject &&
                this.parsedEvent.startDateTime &&
                !isNaN(new Date(this.parsedEvent.startDateTime).getTime());
        }
    },
    watch: {
        description() {
            this.parseDescription();
        }
    },
    mounted() {
        // Listen globally so ESC closes the dialog wherever focus is
        window.addEventListener('keydown', this.handleKeydown);
    },
    beforeUnmount() {
        window.removeEventListener('keydown', this.handleKeydown);
    },
    methods: {
        showDialog() {
            this.dialogVisible = true;
            this.$nextTick(() => {
                const ta = this.$el.querySelector('textarea');
                if (ta) ta.focus();
            });
        },
        hideDialog() {
            this.dialogVisible = false;
            this.description = '';
            this.parsedEvent = null;
        },
        parseDescription() {
            this.parsedEvent = Utils.parseHumanWrittenCalendar(this.description);
        },
        createEvent() {
            if (this.parsedEvent) {
                this.$emit('event-created', this.parsedEvent);
                this.hideDialog();
            }
        },
        formatDate(dateString) {
            if (!dateString) return '';
            const options = { weekday: 'short', month: 'short', year: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true };
            return new Date(dateString).toLocaleString(undefined, options);
        },
        handleEnter(event) {
            // If Shift key is not pressed, submit the form
            if (!event.shiftKey) {
                this.createEvent();
            }
        }
        ,
        handleKeydown(event) {
            // Support showing dialog via Cmd/Ctrl+E (kept parity with module version)
            if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
                event.preventDefault();
                this.showDialog();
            }

            // Close the dialog when Escape is pressed
            if (event.key === 'Escape' && this.dialogVisible) {
                this.hideDialog();
            }
        }
    }
};
