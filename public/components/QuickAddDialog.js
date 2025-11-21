// QuickAddDialog Component
// Single source of truth for parsing/creating events with natural language

const QuickAddDialog = {
    template: '#quick-add-dialog-template',
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
