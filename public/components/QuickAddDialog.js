// QuickAddDialog Component
// Single source of truth for parsing/creating events with natural language

const QuickAddDialog = {
    template: /* html */ `
        <div v-if="dialogVisible" 
                 class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div class="bg-1 rounded-lg shadow-xl p-6 w-full max-w-2xl mx-4">
                    <h3 class="text-lg font-semibold mb-4">Add Event by Typing</h3>
                    <form @submit.prevent="createEvent">
                        <div class="flex items-baseline gap-2 mb-1.5">
                            <span class="flex items-center justify-center shrink-0 h-5 w-5 rounded-full bg-blue-600 text-white text-xs font-bold">1</span>
                            <label for="qa-description" class="text-sm font-medium">Describe the event</label>
                        </div>
                        <textarea id="qa-description"
                                 v-model="description"
                                 aria-label="Event description"
                                 placeholder="Meet John tomorrow 2pm for 1 hour"
                                 rows="2"
                                 @keydown.enter.prevent="handleEnter"
                                 class="w-full p-2 bg-1 border border-color-default rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500">
                        </textarea>

                        <div class="flex items-baseline gap-2 mb-1.5">
                            <span class="flex items-center justify-center shrink-0 h-5 w-5 rounded-full bg-blue-600 text-white text-xs font-bold">2</span>
                            <label class="text-sm font-medium">Check the details</label>
                        </div>

                        <div class="rounded mb-4 flex flex-col gap-2 pl-7">
                            <div class="flex items-center gap-2">
                                <label for="qa-subject" class="w-14 shrink-0 text-sm opacity-70">Subject</label>
                                <input id="qa-subject"
                                       type="text"
                                       v-model="fields.subject"
                                       @input="pin('subject')"
                                       placeholder="Untitled Event"
                                       class="flex-1 min-w-0 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                            </div>

                            <div class="flex items-center gap-2">
                                <label for="qa-start-date" class="w-14 shrink-0 text-sm opacity-70">Start</label>
                                <input id="qa-start-date"
                                       type="date"
                                       v-model="fields.startDate"
                                       @input="pin('start')"
                                       aria-label="Start date"
                                       class="w-44 shrink-0 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <input type="time"
                                       v-model="fields.startTime"
                                       @input="pin('start')"
                                       aria-label="Start time"
                                       class="w-32 shrink-0 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                            </div>

                            <div class="flex items-center gap-2">
                                <label for="qa-end-date" class="w-14 shrink-0 text-sm opacity-70">End</label>
                                <input id="qa-end-date"
                                       type="date"
                                       v-model="fields.endDate"
                                       @input="pin('end')"
                                       aria-label="End date"
                                       class="w-44 shrink-0 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <input type="time"
                                       v-model="fields.endTime"
                                       @input="pin('end')"
                                       aria-label="End time"
                                       class="w-32 shrink-0 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                            </div>

                            <p v-if="endBeforeStart" class="text-sm text-red-500">End is before start.</p>
                        </div>

                        <div class="mb-4 text-sm">
                            <div class="text-xs text-color-1 mb-1.5">Examples</div>
                            <div class="flex flex-wrap gap-1.5">
                                <button type="button"
                                        v-for="ex in examples"
                                        :key="ex"
                                        @click="useExample(ex)"
                                        :title="'Use: ' + ex"
                                        class="text-left px-2.5 py-1 rounded-full border border-color-default text-color-2 font-mono text-xs hover:border-blue-500 hover:bg-[var(--bg-interactive-hover)] transition-colors">{{ ex }}</button>
                            </div>
                        </div>

                        <div class="flex justify-end gap-2">
                            <button type="button"
                                    @click="hideDialog"
                                    class="py-2.5 px-4 border border-color-default text-color-2 font-bold rounded-lg text-sm hover:bg-[var(--bg-interactive-hover)] transition-colors">
                                Cancel
                            </button>
                            <button type="submit"
                                    :disabled="!isValidEvent"
                                    class="py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg text-sm shadow-md transition-colors disabled:opacity-50 disabled:hover:bg-blue-600">
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
            fields: { subject: '', startDate: '', startTime: '', endDate: '', endTime: '' },
            // A field is pinned once the user edits it directly; re-parsing skips pinned fields.
            pinned: { subject: false, start: false, end: false },
            // Each shows off a distinct capability: duration, explicit range,
            // numeric date, month-name date, multi-day span.
            examples: [
                'lunch tomorrow 2pm for 1 hour',
                'birthday party Sat 7pm to 11pm',
                'appointment 9/15 at 2:30pm',
                'workout 3pm May 20 for 90 minutes',
                'vacation dec 11 - dec 15'
            ]
        };
    },
    computed: {
        startDateTime() {
            return this.toISO(this.fields.startDate, this.fields.startTime);
        },
        endDateTime() {
            return this.toISO(this.fields.endDate, this.fields.endTime);
        },
        endBeforeStart() {
            return !!(this.startDateTime && this.endDateTime &&
                new Date(this.endDateTime) < new Date(this.startDateTime));
        },
        isValidEvent() {
            return !!(this.fields.subject.trim() && this.startDateTime && !this.endBeforeStart);
        },
        // What actually gets saved. The parser returns a null end for anything without a
        // duration ("standup tomorrow 9am"), and an event with no end is discarded at the
        // write boundary -- it would sit on the grid looking saved until the next reload
        // and then be gone. Default to an hour rather than letting that happen.
        effectiveEndDateTime() {
            if (this.endDateTime) return this.endDateTime;
            if (!this.startDateTime) return null;
            const ms = new Date(this.startDateTime).getTime();
            return isNaN(ms) ? null : new Date(ms + 3600000).toISOString();
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
            this.fields = { subject: '', startDate: '', startTime: '', endDate: '', endTime: '' };
            this.pinned = { subject: false, start: false, end: false };
        },
        parseDescription() {
            const parsed = Utils.parseHumanWrittenCalendar(this.description) || {};
            // Blank description: clear whatever the parser was driving, leave hand-edits alone.
            const empty = !this.description.trim();

            if (!this.pinned.subject) {
                this.fields.subject = empty ? '' : (parsed.subject || '');
            }
            if (!this.pinned.start) {
                this.setDateTime('start', empty ? null : parsed.startDateTime);
            }
            if (!this.pinned.end) {
                this.setDateTime('end', empty ? null : parsed.endDateTime);
            }
        },
        // Split an ISO string into the local date/time strings the inputs expect.
        setDateTime(which, isoString) {
            const d = isoString ? new Date(isoString) : null;
            const valid = d && !isNaN(d.getTime());
            const pad = (n) => String(n).padStart(2, '0');
            this.fields[which + 'Date'] = valid
                ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
                : '';
            this.fields[which + 'Time'] = valid
                ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
                : '';
        },
        // Combine the date/time inputs back into an ISO string, interpreted as local time.
        toISO(dateStr, timeStr) {
            if (!dateStr) return null;
            const [y, m, d] = dateStr.split('-').map(Number);
            const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
            const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
            return isNaN(dt.getTime()) ? null : dt.toISOString();
        },
        useExample(text) {
            // Start clean so the example parses into every field, not just unpinned ones.
            this.pinned = { subject: false, start: false, end: false };
            this.description = text;
            this.$nextTick(() => {
                const ta = this.$el.querySelector('textarea');
                if (ta) {
                    ta.focus();
                    ta.setSelectionRange(text.length, text.length);
                }
            });
        },
        pin(field) {
            this.pinned[field] = true;
        },
        createEvent() {
            if (!this.isValidEvent) return;
            // Deliberately not counted here. handleQuickAddEvent() in app.js owns
            // the event_added call: it has the calendar, so the count bucket is
            // right, and it runs through track() so a throwing helper can't stop
            // hideDialog() below and strand the dialog open with the event lost.
            this.$emit('event-created', {
                subject: this.fields.subject.trim(),
                startDateTime: this.startDateTime,
                endDateTime: this.effectiveEndDateTime
            });
            this.hideDialog();
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
