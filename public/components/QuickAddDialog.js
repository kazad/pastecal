// QuickAddDialog Component
// Single source of truth for parsing/creating events with natural language

const QuickAddDialog = {
    template: /* html */ `
        <div v-if="dialogVisible" 
                 class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div class="bg-1 rounded-lg shadow-xl p-4 sm:p-6 w-full max-w-2xl mx-4 max-h-[100dvh] overflow-y-auto">
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

                            <!-- Date and time sit side by side from sm up and stack below it.
                                 They used to be fixed w-44 + w-32 shrink-0, which with the label
                                 and the dialog's padding is wider than a 375px phone. Inputs are
                                 min-w-0 so the row can never push the dialog past the viewport. -->
                            <div class="flex items-start sm:items-center gap-2">
                                <label for="qa-start-date" class="w-14 shrink-0 text-sm opacity-70 pt-2 sm:pt-0">Start</label>
                                <div class="flex-1 min-w-0 flex flex-col sm:flex-row gap-2">
                                    <input id="qa-start-date"
                                           type="date"
                                           :value="fields.startDate"
                                           @input="editStart('Date', $event.target.value)"
                                           aria-label="Start date"
                                           class="w-full min-w-0 sm:w-44 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                                    <input type="time"
                                           :value="fields.startTime"
                                           @input="editStart('Time', $event.target.value)"
                                           aria-label="Start time"
                                           class="w-full min-w-0 sm:w-32 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                                </div>
                            </div>

                            <div class="flex items-start sm:items-center gap-2">
                                <label for="qa-end-date" class="w-14 shrink-0 text-sm opacity-70 pt-2 sm:pt-0">End</label>
                                <div class="flex-1 min-w-0 flex flex-col sm:flex-row gap-2">
                                    <input id="qa-end-date"
                                           type="date"
                                           :value="fields.endDate"
                                           @input="editEnd('Date', $event.target.value)"
                                           aria-label="End date"
                                           class="w-full min-w-0 sm:w-44 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                                    <input type="time"
                                           :value="fields.endTime"
                                           @input="editEnd('Time', $event.target.value)"
                                           aria-label="End time"
                                           class="w-full min-w-0 sm:w-32 p-2 bg-1 border border-color-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                                </div>
                            </div>

                            <p v-if="isAllDay" class="text-sm opacity-70">All day</p>
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
        },
        // False on a read-only (/view/) calendar. Every way of opening the dialog
        // (shortcut, menu item, button) goes through showDialog(), so refusing there
        // is the one gate; the parent's handleQuickAddEvent refuses the write too.
        canEdit: {
            type: Boolean,
            default: true
        }
    },
    data() {
        return {
            dialogVisible: false,
            description: '',
            fields: { subject: '', startDate: '', startTime: '', endDate: '', endTime: '' },
            // A field is pinned once the user edits it directly; re-parsing skips pinned fields.
            pinned: { subject: false, start: false, end: false },
            // The length of the last timed version of this event, kept so that briefly
            // clearing a time (backspacing the hour to retype it) and setting it again
            // restores the event's length instead of collapsing it to the 1h default.
            lastTimedDurationMs: null,
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
        // Dates with no time on either end ("vacation dec 11 - dec 15") are all-day.
        isAllDay() {
            return !!this.fields.startDate && !this.fields.startTime && !this.fields.endTime;
        },
        // All-day events are stored as local midnight of their date, end exclusive (the
        // legacy format, see CalDate.instantDate); the End date input shows the last day.
        startDateTime() {
            if (this.isAllDay) return this.toLocalDate(this.fields.startDate, 0);
            return this.toISO(this.fields.startDate, this.fields.startTime);
        },
        endDateTime() {
            if (this.isAllDay) return this.toLocalDate(this.fields.endDate || this.fields.startDate, 1);
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
            if (!this.canEdit) return;
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
            this.lastTimedDurationMs = null;
        },
        parseDescription() {
            const parsed = Utils.parseHumanWrittenCalendar(this.description) || {};
            // Blank description: clear whatever the parser was driving, leave hand-edits alone.
            const empty = !this.description.trim();

            if (!this.pinned.subject) {
                this.fields.subject = empty ? '' : (parsed.subject || '');
            }
            const allDay = !empty && !!parsed.isAllDay;
            if (!this.pinned.start) {
                this.setDateTime('start', empty ? null : parsed.startDateTime, allDay);
            }
            if (!this.pinned.end) {
                let end = empty ? null : parsed.endDateTime;
                // The parser's all-day end is exclusive; show the last day instead.
                if (allDay && end) {
                    const d = new Date(end);
                    d.setDate(d.getDate() - 1);
                    end = d.toISOString();
                }
                this.setDateTime('end', end, allDay);
            }
        },
        // Split an ISO string into the local date/time strings the inputs expect.
        // dateOnly leaves the time blank, which is what marks the event all-day.
        setDateTime(which, isoString, dateOnly) {
            const d = isoString ? new Date(isoString) : null;
            const valid = d && !isNaN(d.getTime());
            const pad = (n) => String(n).padStart(2, '0');
            this.fields[which + 'Date'] = valid
                ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
                : '';
            this.fields[which + 'Time'] = valid && !dateOnly
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
        // "YYYY-MM-DD" + offset days -> local midnight as an ISO string, or null.
        toLocalDate(dateStr, offsetDays) {
            if (!dateStr) return null;
            const [y, m, d] = dateStr.split('-').map(Number);
            const dt = new Date(y, (m || 1) - 1, (d || 1) + offsetDays);
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
        // The event is modelled as START + DURATION, not two independent instants.
        //
        // The fields used to be four unrelated v-models, so moving the start of
        // "lunch tomorrow 2pm for 1 hour" to a day later left the parsed end where it
        // was (a 25-hour event, or an end before the start that blocks Create), and
        // clearing the start time silently meant 00:00, turning 14:00-15:00 into
        // 00:00-15:00. Two rules close that:
        //
        //  1. Moving the start moves an end the user hasn't edited by the same amount,
        //     so the length is kept. A hand-edited (pinned) end stays where it was put.
        //  2. An event is either all-day (no time on either end) or timed (a time on
        //     both). Clearing either time makes BOTH ends all-day; setting a time on
        //     one end of an all-day event gives the other end one too, using the
        //     event's last timed length (or the app's 1h default).
        editStart(part, value) {
            const f = this.fields;
            const wasAllDay = this.isAllDay;
            const oldStartDate = f.startDate;
            const oldStart = this.startDateTime;
            const oldEnd = this.endDateTime;
            this.rememberDuration(oldStart, oldEnd, wasAllDay);

            f['start' + part] = value;
            this.pin('start');

            if (part === 'Time') {
                if (!value) { f.endTime = ''; return; }
                if (!f.endTime) {
                    const anchor = this.toISO(f.startDate || f.endDate, value);
                    this.setDateTime('end', this.offset(anchor, this.timedDuration()), false);
                    return;
                }
            }
            if (this.pinned.end || !f.endDate) return;

            if (wasAllDay && this.isAllDay) {
                // All-day: move the last day by the same number of whole days.
                const days = this.dayDiff(oldStartDate, f.startDate);
                if (days !== null) f.endDate = this.addDays(f.endDate, days);
                return;
            }
            const newStart = this.startDateTime;
            if (oldStart && oldEnd && newStart) {
                const delta = new Date(newStart) - new Date(oldStart);
                this.setDateTime('end', this.offset(oldEnd, delta), false);
            }
        },
        editEnd(part, value) {
            const f = this.fields;
            this.rememberDuration(this.startDateTime, this.endDateTime, this.isAllDay);
            f['end' + part] = value;
            this.pin('end');
            if (part !== 'Time') return;
            if (!value) { f.startTime = ''; return; }
            if (!f.startTime) {
                const anchor = this.toISO(f.endDate || f.startDate, value);
                this.setDateTime('start', this.offset(anchor, -this.timedDuration()), false);
            }
        },
        rememberDuration(startIso, endIso, allDay) {
            if (allDay || !startIso || !endIso) return;
            const ms = new Date(endIso) - new Date(startIso);
            if (ms > 0) this.lastTimedDurationMs = ms;
        },
        timedDuration() {
            return this.lastTimedDurationMs || 3600000;
        },
        offset(iso, ms) {
            if (!iso) return null;
            const t = new Date(iso).getTime();
            return isNaN(t) ? null : new Date(t + ms).toISOString();
        },
        // Whole calendar days from one "YYYY-MM-DD" to another, or null.
        dayDiff(fromStr, toStr) {
            const utc = (s) => {
                if (!s) return NaN;
                const [y, m, d] = s.split('-').map(Number);
                return Date.UTC(y, (m || 1) - 1, d || 1);
            };
            const diff = (utc(toStr) - utc(fromStr)) / 86400000;
            return isNaN(diff) ? null : Math.round(diff);
        },
        addDays(dateStr, days) {
            const [y, m, d] = dateStr.split('-').map(Number);
            return new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + days)).toISOString().slice(0, 10);
        },
        createEvent() {
            if (!this.canEdit || !this.isValidEvent) return;
            // Deliberately not counted here. handleQuickAddEvent() in app.js owns
            // the event_added call: it has the calendar, so the count bucket is
            // right, and it runs through track() so a throwing helper can't stop
            // hideDialog() below and strand the dialog open with the event lost.
            this.$emit('event-created', {
                subject: this.fields.subject.trim(),
                startDateTime: this.startDateTime,
                endDateTime: this.effectiveEndDateTime,
                isAllDay: this.isAllDay
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
            // Cmd/Ctrl+E is owned by the app's _quickAddShortcutHandler. This used to
            // register a second copy of it, so one keypress opened the dialog twice
            // over, through a path that skipped every check the app makes.

            // Close the dialog when Escape is pressed
            if (event.key === 'Escape' && this.dialogVisible) {
                this.hideDialog();
            }
        }
    }
};
