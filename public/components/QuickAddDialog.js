// QuickAddDialog Component
// Single source of truth for parsing/creating events with natural language

const QuickAddDialog = {
    template: /* html */ `
        <div v-if="dialogVisible" 
                 class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div class="pc-qa-dialog bg-1 rounded-lg shadow-xl p-6 w-full max-w-2xl mx-4">
                    <h3 class="text-lg font-semibold mb-4">Add event by typing</h3>
                    <form @submit.prevent="createEvent">
                        <div class="flex items-baseline gap-2 mb-1.5">
                            <span class="pc-qa-step">1</span>
                            <label for="qa-description" class="text-sm font-medium">Describe the event</label>
                        </div>
                        <textarea id="qa-description"
                                 v-model="description"
                                 aria-label="Event description"
                                 placeholder="Meet John tomorrow 2pm for 1 hour"
                                 rows="2"
                                 @keydown.enter.prevent="handleEnter"
                                 class="pc-field mb-2">
                        </textarea>
                        <!-- Examples belong to step 1: they show what you can type. -->
                        <div class="pc-qa-examples">
                            <span class="pc-qa-try">Try</span>
                            <button type="button"
                                    v-for="ex in examples"
                                    :key="ex"
                                    @click="useExample(ex)"
                                    :title="'Use: ' + ex"
                                    class="pc-chip pc-chip--soft">{{ ex }}</button>
                        </div>

                        <div class="flex items-baseline gap-2 mb-1.5">
                            <span class="pc-qa-step">2</span>
                            <label class="text-sm font-medium">Check the details</label>
                        </div>

                        <div class="pc-qa-fields rounded mb-6 flex flex-col gap-3 pl-7">
                            <div class="flex items-center gap-2">
                                <label for="qa-subject" class="w-14 shrink-0 text-sm opacity-70">Subject</label>
                                <input id="qa-subject"
                                       type="text"
                                       v-model="fields.subject"
                                       @input="pin('subject')"
                                       placeholder="Untitled event"
                                       class="flex-1 min-w-0 pc-field">
                            </div>

                            <div class="flex items-center gap-2">
                                <label for="qa-start-date" class="w-14 shrink-0 text-sm opacity-70">Start</label>
                                <input id="qa-start-date"
                                       type="date"
                                       v-model="fields.startDate"
                                       @input="pin('start')"
                                       aria-label="Start date"
                                       class="pc-qa-date w-44 shrink-0 pc-field">
                                <input type="time"
                                       v-model="fields.startTime"
                                       @input="pin('start'); timesCleared()"
                                       :disabled="isAllDay"
                                       aria-label="Start time"
                                       class="pc-qa-time w-32 shrink-0 pc-field">
                            </div>

                            <div class="flex items-center gap-2">
                                <label for="qa-end-date" class="w-14 shrink-0 text-sm opacity-70">End</label>
                                <input id="qa-end-date"
                                       type="date"
                                       v-model="fields.endDate"
                                       @input="pin('end')"
                                       aria-label="End date"
                                       class="pc-qa-date w-44 shrink-0 pc-field">
                                <input type="time"
                                       v-model="fields.endTime"
                                       @input="pin('end'); timesCleared()"
                                       :disabled="isAllDay"
                                       aria-label="End time"
                                       class="pc-qa-time w-32 shrink-0 pc-field">
                            </div>

                            <!-- All day: a switch under the dates, aligned with the inputs. The time
                                 inputs stay in place (blank, disabled) while it is on, so turning it
                                 on or off never changes the dialog's height. -->
                            <div class="flex items-center gap-2">
                                <span class="w-14 shrink-0" aria-hidden="true"></span>
                                <label class="pc-switch pc-qa-switch">
                                    <input type="checkbox" role="switch" data-testid="qa-all-day"
                                           :checked="isAllDay" :aria-checked="isAllDay ? 'true' : 'false'"
                                           @change="setAllDay($event.target.checked)">
                                    <span class="pc-switch-track" aria-hidden="true"></span>
                                    <span>All day</span>
                                </label>
                            </div>

                            <!-- Color. This dialog used to have none, so an event made here
                                 could only ever be the first color -- one of the two creation
                                 paths reported in #32 as "impossible to change colors". -->
                            <!-- A color the calendar has named ("Practice", "Game") shows as a chip
                                 with its name, like the search filter's, so people pick the type and
                                 not just a hue. Unnamed colors stay plain swatches. -->
                            <div v-if="colors.length" class="flex items-center gap-2">
                                <span class="w-14 shrink-0 text-sm opacity-70">{{ anyNamed ? 'Type' : 'Color' }}</span>
                                <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" :aria-label="anyNamed ? 'Event type' : 'Event color'">
                                    <template v-for="(c, i) in colors" :key="i">
                                        <button v-if="named[i]" type="button"
                                                role="radio" :aria-checked="type === i + 1"
                                                :aria-label="labels[i] || ('Type ' + (i + 1))"
                                                :title="labels[i] || ('Type ' + (i + 1))"
                                                :data-testid="'qa-color-' + (i + 1)"
                                                @click="type = i + 1"
                                                class="pc-chip pc-chip--dot pc-qa-type" :class="{ 'is-selected': type === i + 1 }"
                                                :style="{ '--dot': c }">{{ labels[i] }}</button>
                                        <button v-else type="button"
                                                role="radio" :aria-checked="type === i + 1"
                                                :aria-label="labels[i] || ('Type ' + (i + 1))"
                                                :title="labels[i] || ('Type ' + (i + 1))"
                                                :data-testid="'qa-color-' + (i + 1)"
                                                @click="type = i + 1"
                                                class="w-6 h-6 rounded-full transition-transform"
                                                :class="type === i + 1 ? 'ring-2 ring-offset-2 ring-theme-primary scale-110' : 'hover:scale-110'"
                                                :style="{ backgroundColor: c }"></button>
                                    </template>
                                </div>
                            </div>

                            <p v-if="endBeforeStart" class="text-sm text-red-500">End is before start.</p>
                            <!-- Say WHY Create is disabled. A greyed-out button with no reason
                                 is what #32 reported as "no way to save once you've written a
                                 description": the text had no date the parser could read, the
                                 date fields stayed empty, and nothing on screen said so. -->
                            <p v-else-if="fields.subject.trim() && !startDateTime"
                               data-testid="qa-needs-date" class="text-sm text-amber-600">
                                Add a date — type one (e.g. "tomorrow 2pm") or pick it under Start.
                            </p>
                        </div>

                        <div class="flex justify-end gap-2">
                            <button type="button"
                                    @click="hideDialog"
                                    class="pc-btn">
                                Cancel
                            </button>
                            <button type="submit"
                                    :disabled="!isValidEvent"
                                    class="pc-btn pc-btn--primary">
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
        // The calendar's palette and labels, so the swatches match the grid and the
        // categories a calendar has added (up to 16) are all offered.
        colors: { type: Array, default: () => [] },
        labels: { type: Array, default: () => [] },
        // Per color: true when the calendar gave it a name of its own (app.js hasTypeLabel).
        // `labels` alone can't tell: an unnamed color is labeled with its color's name.
        named: { type: Array, default: () => [] }
    },
    data() {
        return {
            dialogVisible: false,
            description: '',
            fields: { subject: '', startDate: '', startTime: '', endDate: '', endTime: '' },
            type: 1,
            // All day is a switch the parser drives ("vacation dec 11 - dec 15") until it's flipped by hand.
            allDay: false,
            // The times from before All day went on, put back when it goes off.
            savedTimes: null,
            // A field is pinned once the user edits it directly; re-parsing skips pinned fields.
            pinned: { subject: false, start: false, end: false, allDay: false },
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
        // The All day switch: set by the parser for dates with no time ("vacation dec 11 - dec 15"),
        // or by hand.
        isAllDay() {
            return this.allDay;
        },
        anyNamed() {
            return this.colors.some((_, i) => !!this.named[i]);
        },
        // All-day events are stored as local midnight of their date, end exclusive (the
        // legacy format, see Event.allDayDateUTC); the End date input shows the last day.
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
            this.pinned = { subject: false, start: false, end: false, allDay: false };
            this.type = 1;
            this.allDay = false;
            this.savedTimes = null;
        },
        // The All day switch, flipped by hand. On: the times blank out (kept to restore) and the
        // inputs disable. Off: the earlier times come back, or 9 to 10 if there were none.
        setAllDay(on) {
            this.pinned.allDay = true;
            if (on === this.allDay) return;
            this.allDay = on;
            if (on) {
                this.savedTimes = { start: this.fields.startTime, end: this.fields.endTime, endDate: this.fields.endDate };
                this.fields.startTime = '';
                this.fields.endTime = '';
                if (this.fields.startDate && !this.fields.endDate) this.fields.endDate = this.fields.startDate;
            } else {
                const saved = this.savedTimes;
                if (saved && saved.start) {
                    this.fields.startTime = saved.start;
                    this.fields.endTime = saved.end;
                    if (!saved.endDate) this.fields.endDate = '';   // filled in only for All day
                } else {
                    this.fields.startTime = '09:00';
                    this.fields.endTime = '10:00';
                }
                this.savedTimes = null;
            }
        },
        parseDescription() {
            const parsed = Utils.parseHumanWrittenCalendar(this.description) || {};
            // Blank description: clear whatever the parser was driving, leave hand-edits alone.
            const empty = !this.description.trim();

            if (!this.pinned.subject) {
                this.fields.subject = empty ? '' : (parsed.subject || '');
            }
            const parsedAllDay = !empty && !!parsed.isAllDay;
            if (!this.pinned.allDay) this.allDay = parsedAllDay;
            const allDay = this.allDay;
            const dateOnly = allDay || parsedAllDay;
            if (!this.pinned.start) {
                this.setDateTime('start', empty ? null : parsed.startDateTime, dateOnly);
            }
            if (!this.pinned.end) {
                let end = empty ? null : parsed.endDateTime;
                // The parser's all-day end is exclusive; show the last day instead.
                if (parsedAllDay && end) {
                    const d = new Date(end);
                    d.setDate(d.getDate() - 1);
                    end = d.toISOString();
                }
                this.setDateTime('end', end, dateOnly);
            }
            // Dates with no time while All day is switched off by hand: a 9-to-10 slot on them.
            if (parsedAllDay && !allDay) {
                if (!this.pinned.start && !this.fields.startTime) this.fields.startTime = '09:00';
                if (!this.pinned.end && !this.fields.endTime) this.fields.endTime = '10:00';
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
            this.pinned = { subject: false, start: false, end: false, allDay: false };
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
        // Both times blanked by hand: that's an all-day event, as it always was. Turn the switch on.
        timesCleared() {
            if (this.fields.startDate && !this.fields.startTime && !this.fields.endTime && !this.allDay) {
                this.pinned.allDay = true;
                this.allDay = true;
                this.savedTimes = null;
                if (!this.fields.endDate) this.fields.endDate = this.fields.startDate;
            }
        },
        createEvent() {
            if (!this.isValidEvent) return;
            // Deliberately not counted here. handleQuickAddEvent() in app.js owns
            // the event_added call: it has the calendar, so the count bucket is
            // right, and it runs through track() so a throwing helper can't stop
            // hideDialog() below and strand the dialog open with the event lost.
            this.$emit('event-created', {
                subject: this.fields.subject.trim(),
                type: this.type,
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
