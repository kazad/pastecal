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
            colorMenu: false, menuStyle: null, error: '',
            v2: typeof NcUx !== 'undefined' && NcUx.v2(),
        };
    },
    computed: {
        isNew() { return !this.event || !this.event.id; },
        // One occurrence of a series (a fresh "Edit Event" or an already-edited copy):
        // no Repeat controls, as in Syncfusion -- the series owns the rule.
        isOccurrence() { return !!(this.event && (this.event._occurrenceOf || this.event.recurrenceID)); },
        palette() { return this.colors.length ? this.colors : ['#3f51b5', '#e3165b', '#ff6652', '#4caf50', '#ff9800', '#03a9f4', '#9e9e9e', '#27282f']; },
        currentColor() { return this.palette[(this.type - 1) % this.palette.length]; },
        // The start as one number, for "end follows start". Uses the time field even
        // when All day hides it, so toggling All day never counts as moving the start.
        startStamp() { return new Date(`${this.startDate}T${this.startTime || '00:00'}`).getTime(); },
        unit() { return { DAILY: 'Day(s)', WEEKLY: 'Week(s)', MONTHLY: 'Month(s)', YEARLY: 'Year(s)' }[this.freq] || ''; },
    },
    mounted() {
        // A click anywhere outside the color menu closes it.
        this._onDown = (e) => { if (this.colorMenu && !e.target.closest('.ne-color')) this.colorMenu = false; };
        document.addEventListener('mousedown', this._onDown);
    },
    beforeUnmount() { document.removeEventListener('mousedown', this._onDown); },
    watch: {
        event: { handler() { this.load(); }, immediate: true },
        visible(v) { if (v) this.$nextTick(() => this.$refs.title && this.$refs.title.focus()); },
        // v2: move the start and the end moves with it, keeping the length (Google,
        // Apple). v1 leaves the end alone, as Syncfusion does.
        startStamp(now) {
            const was = this._lastStart; this._lastStart = now;
            if (!this.v2 || isNaN(now) || isNaN(was) || now === was || was === undefined) return;
            const end = new Date(new Date(`${this.endDate}T${this.endTime || '00:00'}`).getTime() + (now - was));
            if (isNaN(end)) return;
            this.endDate = this.dateStr(end); this.endTime = this.timeStr(end);
        },
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
            this._lastStart = this.startStamp;   // loading an event is not "moving the start"
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
            if (parts.UNTIL) {
                // A UTC stamp: show the LOCAL day it falls on.
                const u = parts.UNTIL, t = /T(\d{2})(\d{2})(\d{2})/.exec(u) || [0, '00', '00', '00'];
                const at = new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +t[1], +t[2], +t[3]));
                this.endMode = 'until'; this.until = /Z$/.test(u) ? this.dateStr(at) : `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
            }
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
        // v2 says "Category" (the word Settings uses: "+ Add category"); v1 keeps Syncfusion's "Type".
        label(i) {
            const l = this.labels[i];
            // The defaults are STORED as "Type 1".."Type 8"; v2 shows an unrenamed one as
            // "Category N". Names people chose ("Soccer") are shown as they are.
            if (this.v2 && (!l || /^Type \d+$/.test(l))) return 'Category ' + (i + 1);
            return l || ('Type ' + (i + 1));
        },
        // v2: the menu is placed against the window, so the editor's scrolling body cannot
        // clip it; it opens downward if it fits, else upward, and scrolls if it must.
        toggleColorMenu(e) {
            this.colorMenu = !this.colorMenu;
            if (!this.colorMenu || !this.v2) return;
            const r = e.currentTarget.getBoundingClientRect(), want = 44 + this.palette.length * 36;
            const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
            const down = below >= Math.min(want, 240) || below >= above;
            const room = Math.max(160, down ? below : above);
            this.menuStyle = { position: 'fixed', left: r.left + 'px', width: Math.max(r.width, 220) + 'px', maxHeight: Math.min(want, room) + 'px',
                ...(down ? { top: (r.bottom + 4) + 'px' } : { bottom: (window.innerHeight - r.top + 4) + 'px' }) };
        },
    },
    template: /* html */ `
<div v-if="visible" class="ne-overlay" @mousedown.self="close">
  <div class="ne-dialog" role="dialog" aria-modal="true" :aria-label="isNew ? 'New Event' : 'Edit Event'" data-testid="event-editor">
    <div class="ne-head">
      <h2>{{ v2 ? (isNew ? 'New event' : 'Edit event') : (isNew ? 'New Event' : 'Edit Event') }}</h2>
      <button class="ne-x" aria-label="Close" data-testid="editor-close" @click="close"><nc-icon name="x" :size="20"></nc-icon></button>
    </div>
    <div class="ne-body">
      <div class="ne-row ne-title-row">
        <label class="ne-field ne-grow"><span>Title</span>
          <input ref="title" v-model="title" data-testid="editor-title" @keydown.enter.prevent="save"></label>
        <div v-if="!v2" class="ne-color">
          <button class="ne-color-btn" :style="{ background: currentColor }" aria-label="Color" data-testid="editor-color" @click="colorMenu = !colorMenu"><nc-icon name="chevron-down" :size="16" :stroke-width="2.5"></nc-icon></button>
          <div v-if="colorMenu" class="ne-color-menu">
            <button v-for="(c, i) in palette" :key="i" :data-testid="'editor-color-' + (i + 1)" @click="pickColor(i)">
              <span class="sw" :style="{ background: c }"></span>{{ labels[i] || ('Type ' + (i + 1)) }}</button>
            <div class="ne-color-hint">Customize labels in Settings</div>
          </div>
        </div>
      </div>
      <!-- v2: the color as a labeled dropdown. The labels ("Soccer", "Practice") are the
           information, so the closed button names the current one and the open menu names
           them all -- swatches alone hid every label behind a click. -->
      <div v-if="v2" class="ne-field ne-colorfield"><span>Category</span>
        <div class="ne-color">
          <button type="button" class="ne-color2" aria-haspopup="listbox" :aria-expanded="colorMenu" data-testid="editor-color" @click="toggleColorMenu">
            <span class="sw" :style="{ background: currentColor }"></span>
            <span class="ne-color2-label" data-testid="editor-color-label">{{ label(type - 1) }}</span>
            <nc-icon name="chevron-down" :size="16"></nc-icon></button>
          <div v-if="colorMenu" class="ne-color-menu ne-color-menu2" :style="menuStyle" role="listbox" aria-label="Category">
            <button v-for="(c, i) in palette" :key="i" type="button" role="option" :aria-selected="type === i + 1"
              :data-testid="'editor-color-' + (i + 1)" @click="pickColor(i)">
              <span class="sw" :style="{ background: c }"></span><span class="lbl">{{ label(i) }}</span>
              <nc-icon v-if="type === i + 1" class="ck" name="check" :size="16" :stroke-width="2.5"></nc-icon></button>
            <div class="ne-color-hint">Edit categories in Settings</div>
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
      <!-- v1: Syncfusion's two columns -- Repeat | Repeat every, then Repeat On | End.
           v2: the options stacked in a tinted panel under Repeat. Same fields. -->
      <div v-if="!isOccurrence" class="ne-rep">
        <label class="ne-field ne-rep-freq"><span>Repeat</span>
          <span class="ne-select"><select v-model="freq" data-testid="editor-repeat">
            <option value="">Never</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option><option value="YEARLY">Yearly</option></select></span></label>
        <div v-if="freq" class="ne-repeat" data-testid="editor-repeat-options">
          <label class="ne-field ne-rep-every"><span>Repeat every</span>
            <div class="ne-inline"><input type="number" min="1" v-model="interval" class="ne-num" data-testid="editor-interval"> {{ unit }}</div></label>
          <div v-if="freq === 'WEEKLY'" class="ne-field ne-rep-on"><span>Repeat On</span>
            <div class="ne-days">
              <button v-for="(n, d) in ['S','M','T','W','T','F','S']" :key="d" type="button" :class="{ on: byDay.includes(d) }" @click="toggleDay(d)">{{ n }}</button></div></div>
          <div class="ne-rep-end">
            <label class="ne-field"><span>End</span>
              <span class="ne-select"><select v-model="endMode" data-testid="editor-end-mode"><option value="never">Never</option><option value="until">Until</option><option value="count">Count</option></select></span></label>
            <label v-if="endMode === 'until'" class="ne-field"><span>Until</span><input type="date" v-model="until" data-testid="editor-until"></label>
            <label v-if="endMode === 'count'" class="ne-field"><span>Occurrences</span><input type="number" min="1" v-model="count" class="ne-num" data-testid="editor-count"></label>
          </div>
        </div>
      </div>
      <label class="ne-field"><span>Description</span>
        <textarea v-model="description" rows="3" data-testid="editor-description"></textarea></label>
      <p v-if="error" class="ne-error">{{ error }}</p>
    </div>
    <div class="ne-foot">
      <template v-if="v2">
        <button v-if="!isNew" class="ne-btn danger" data-testid="editor-delete" @click="$emit('delete', event.id)">Delete</button>
        <span class="ne-spacer"></span>
        <button class="ne-btn" data-testid="editor-cancel" @click="close">Cancel</button>
        <button class="ne-btn filled" data-testid="editor-save" @click="save">Save</button>
      </template>
      <template v-else>
        <button v-if="!isNew" class="ne-btn" data-testid="editor-delete" @click="$emit('delete', event.id)">DELETE</button>
        <span class="ne-spacer"></span>
        <button class="ne-btn primary" data-testid="editor-save" @click="save">SAVE</button>
        <button class="ne-btn" data-testid="editor-cancel" @click="close">CANCEL</button>
      </template>
    </div>
  </div>
</div>`,
};
if (typeof window !== 'undefined') window.EventEditor = EventEditor;
