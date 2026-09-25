/**
 * The event editor, laid out like Syncfusion's "New Event / Edit Event" dialog so it
 * is familiar: Title with the color button beside it, Start and End side by side,
 * All day, Repeat (which opens "Repeat every N ...", the weekday toggles and an end
 * rule), Description, then DELETE on the left and SAVE / CANCEL on the right.
 *
 * Writes exactly what the Syncfusion app writes, because both apps edit the same
 * calendars:
 *   - all-day: LOCAL midnight, end exclusive (the day after the last day)
 *   - repeat rules: "FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;" -- Syncfusion's own form,
 *     UNTIL as a UTC stamp, COUNT as a number
 *   - times as ISO strings
 * The Timezone checkbox Syncfusion shows is left out on purpose: the app never
 * stores a timezone, so it would be a control that does nothing.
 */
const EventEditor = {
    props: {
        event: Object,
        visible: Boolean,
        colors: { type: Array, default: () => [] },
        labels: { type: Array, default: () => [] },
        timeFormat: { type: String, default: '12' },
    },
    emits: ['save', 'delete', 'update:visible'],
    data() {
        return {
            title: '', type: 1, description: '', isAllDay: false,
            startDate: '', startTime: '09:00', endDate: '', endTime: '10:00',
            freq: '', interval: 1, byDay: [], endMode: 'never', until: '', count: 10,
            colorMenu: false, error: '',
        };
    },
    computed: {
        isNew() { return !this.event || !this.event.id; },
        // One occurrence of a series (a fresh "Edit Event" or an already-edited copy):
        // no Repeat controls, as in Syncfusion -- the series owns the rule.
        isOccurrence() { return !!(this.event && (this.event._occurrenceOf || this.event.recurrenceID)); },
        palette() { return this.colors.length ? this.colors : ['#3f51b5', '#e3165b', '#ff6652', '#4caf50', '#ff9800', '#03a9f4', '#9e9e9e', '#27282f']; },
        currentColor() { return this.palette[(this.type - 1) % this.palette.length]; },
        unit() { return { DAILY: 'Day(s)', WEEKLY: 'Week(s)', MONTHLY: 'Month(s)', YEARLY: 'Year(s)' }[this.freq] || ''; },
    },
    watch: {
        event: { handler() { this.load(); }, immediate: true },
        visible(v) { if (v) this.$nextTick(() => this.$refs.title && this.$refs.title.focus()); },
        isAllDay(now, was) {
            if (now && !was && this.endDate < this.startDate) this.endDate = this.startDate;
        },
    },
    methods: {
        pad(n) { return String(n).padStart(2, '0'); },
        dateStr(d) { return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`; },
        timeStr(d) { return `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}`; },
        load() {
            const e = this.event || {};
            this.title = e.title || ''; this.type = Number(e.type) || 1; this.description = e.description || '';
            this.isAllDay = !!e.isAllDay; this.error = ''; this.colorMenu = false;
            let s = e.start ? new Date(e.start) : new Date(); let en = e.end ? new Date(e.end) : new Date(s.getTime() + 3600000);
            if (this.isAllDay) {
                // Read the stored instant as the day it stands for (nearest midnight), and
                // show the end INCLUSIVELY, as Syncfusion's dialog does.
                const day = (v) => { const r = new Date(new Date(v).getTime() + 43200000); return new Date(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate()); };
                s = day(s); en = day(en); if (en > s) en = new Date(en.getFullYear(), en.getMonth(), en.getDate() - 1);
            }
            this.startDate = this.dateStr(s); this.startTime = this.timeStr(s);
            this.endDate = this.dateStr(en); this.endTime = this.timeStr(en);
            this.parseRule(e.recurrencerule, s);
        },
        parseRule(rule, start) {
            this.freq = ''; this.interval = 1; this.byDay = [start.getDay()]; this.endMode = 'never'; this.until = ''; this.count = 10;
            if (!rule) return;
            const parts = Object.fromEntries(String(rule).replace(/^RRULE:/i, '').split(';').filter(p => p.includes('=')).map(p => p.split('=')));
            this.freq = parts.FREQ || '';
            this.interval = parseInt(parts.INTERVAL, 10) || 1;
            if (parts.BYDAY) {
                const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
                this.byDay = parts.BYDAY.split(',').map(d => map[d.replace(/^[+-]?\d+/, '')]).filter(n => n !== undefined);
            }
            if (parts.UNTIL) { const u = parts.UNTIL; this.endMode = 'until'; this.until = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`; }
            else if (parts.COUNT) { this.endMode = 'count'; this.count = parseInt(parts.COUNT, 10) || 1; }
        },
        toggleDay(d) {
            const i = this.byDay.indexOf(d);
            if (i >= 0) { if (this.byDay.length > 1) this.byDay.splice(i, 1); } else this.byDay.push(d);
        },
        buildRule() {
            if (!this.freq) return '';
            let r = `FREQ=${this.freq};`;
            if (this.freq === 'WEEKLY') r += `BYDAY=${[...this.byDay].sort().map(d => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d]).join(',')};`;
            r += `INTERVAL=${Math.max(1, parseInt(this.interval, 10) || 1)};`;
            if (this.endMode === 'until' && this.until) {
                const [y, m, d] = this.until.split('-').map(Number);
                r += `UNTIL=${new Date(y, m - 1, d, 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')};`;
            } else if (this.endMode === 'count') r += `COUNT=${Math.max(1, parseInt(this.count, 10) || 1)};`;
            return r;
        },
        save() {
            const [sy, sm, sd] = this.startDate.split('-').map(Number);
            const [ey, em, ed] = this.endDate.split('-').map(Number);
            let start, end;
            if (this.isAllDay) {
                start = new Date(sy, sm - 1, sd);
                end = new Date(ey, em - 1, ed + 1);          // exclusive, local midnight
            } else {
                const [sh, smin] = this.startTime.split(':').map(Number), [eh, emin] = this.endTime.split(':').map(Number);
                start = new Date(sy, sm - 1, sd, sh, smin); end = new Date(ey, em - 1, ed, eh, emin);
            }
            if (isNaN(start) || isNaN(end)) { this.error = 'Please enter a valid start and end.'; return; }
            if (end <= start) { this.error = 'The end must be after the start.'; return; }
            this.$emit('save', {
                ...(this.event || {}),
                title: this.title.trim() || '(No title)', type: this.type, description: this.description,
                isAllDay: this.isAllDay, start: start.toISOString(), end: end.toISOString(),
                recurrencerule: this.isOccurrence ? (this.event.recurrencerule || '') : this.buildRule(),
            });
        },
        close() { this.$emit('update:visible', false); },
        pickColor(i) { this.type = i + 1; this.colorMenu = false; },
    },
    template: /* html */ `
<div v-if="visible" class="ne-overlay" @mousedown.self="close">
  <div class="ne-dialog" role="dialog" aria-modal="true" :aria-label="isNew ? 'New Event' : 'Edit Event'" data-testid="event-editor">
    <div class="ne-head">
      <h2>{{ isNew ? 'New Event' : 'Edit Event' }}</h2>
      <button class="ne-x" aria-label="Close" data-testid="editor-close" @click="close">✕</button>
    </div>
    <div class="ne-body">
      <div class="ne-row ne-title-row">
        <label class="ne-field ne-grow"><span>Title</span>
          <input ref="title" v-model="title" data-testid="editor-title" @keydown.enter.prevent="save"></label>
        <div class="ne-color">
          <button class="ne-color-btn" :style="{ background: currentColor }" aria-label="Color" data-testid="editor-color" @click="colorMenu = !colorMenu">▾</button>
          <div v-if="colorMenu" class="ne-color-menu">
            <button v-for="(c, i) in palette" :key="i" :data-testid="'editor-color-' + (i + 1)" @click="pickColor(i)">
              <span class="sw" :style="{ background: c }"></span>{{ labels[i] || ('Type ' + (i + 1)) }}</button>
            <div class="ne-color-hint">Customize labels in Settings</div>
          </div>
        </div>
      </div>
      <div class="ne-row">
        <label class="ne-field ne-grow"><span>Start</span>
          <div class="ne-dt"><input type="date" v-model="startDate" data-testid="editor-start-date"><input v-if="!isAllDay" type="time" v-model="startTime" data-testid="editor-start-time"></div></label>
        <label class="ne-field ne-grow"><span>End</span>
          <div class="ne-dt"><input type="date" v-model="endDate" data-testid="editor-end-date"><input v-if="!isAllDay" type="time" v-model="endTime" data-testid="editor-end-time"></div></label>
      </div>
      <label class="ne-check"><input type="checkbox" v-model="isAllDay" data-testid="editor-allday"> All day</label>
      <label v-if="!isOccurrence" class="ne-field ne-half"><span>Repeat</span>
        <select v-model="freq" data-testid="editor-repeat">
          <option value="">Never</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option><option value="YEARLY">Yearly</option></select></label>
      <div v-if="freq && !isOccurrence" class="ne-repeat" data-testid="editor-repeat-options">
        <div class="ne-row">
          <label class="ne-field"><span>Repeat every</span>
            <div class="ne-inline"><input type="number" min="1" v-model="interval" class="ne-num"> {{ unit }}</div></label>
        </div>
        <div v-if="freq === 'WEEKLY'" class="ne-field"><span>Repeat On</span>
          <div class="ne-days">
            <button v-for="(n, d) in ['S','M','T','W','T','F','S']" :key="d" :class="{ on: byDay.includes(d) }" @click="toggleDay(d)">{{ n }}</button></div></div>
        <div class="ne-row">
          <label class="ne-field ne-half"><span>End</span>
            <select v-model="endMode"><option value="never">Never</option><option value="until">Until</option><option value="count">Count</option></select></label>
          <label v-if="endMode === 'until'" class="ne-field ne-half"><span>&nbsp;</span><input type="date" v-model="until"></label>
          <label v-if="endMode === 'count'" class="ne-field ne-half"><span>&nbsp;</span><input type="number" min="1" v-model="count" class="ne-num"></label>
        </div>
      </div>
      <label class="ne-field"><span>Description</span>
        <textarea v-model="description" rows="3" data-testid="editor-description"></textarea></label>
      <p v-if="error" class="ne-error">{{ error }}</p>
    </div>
    <div class="ne-foot">
      <button v-if="!isNew" class="ne-btn" data-testid="editor-delete" @click="$emit('delete', event.id)">DELETE</button>
      <span class="ne-spacer"></span>
      <button class="ne-btn primary" data-testid="editor-save" @click="save">SAVE</button>
      <button class="ne-btn" data-testid="editor-cancel" @click="close">CANCEL</button>
    </div>
  </div>
</div>`,
};
if (typeof window !== 'undefined') window.EventEditor = EventEditor;
