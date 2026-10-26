/**
 * The event editor, laid out like Syncfusion's "New Event / Edit Event" dialog so it
 * is familiar: Title with the color button beside it, Start and End side by side,
 * All day, Repeat (which opens "Repeat every N ...", the weekday toggles, the monthly
 * and yearly choices, and an end rule), Description, then DELETE on the left and
 * SAVE / CANCEL on the right.
 *
 * Writes exactly what the Syncfusion app writes, because both apps edit the same
 * calendars:
 *   - all-day: edited in the display shape (local midnight .. local 23:59:59.999 of the last
 *     day); the app turns it into the stored form
 *   - repeat rules in Syncfusion's own form and key order: "FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;",
 *     "FREQ=MONTHLY;BYMONTHDAY=16;INTERVAL=1;", "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3;INTERVAL=1;",
 *     "FREQ=YEARLY;BYMONTHDAY=16;BYMONTH=10;INTERVAL=1;" (or BYDAY+BYSETPOS+BYMONTH), then
 *     UNTIL (a UTC stamp) or COUNT. A rule part the form does not show is carried over, and a
 *     rule whose inputs were not touched is saved verbatim.
 *   - times as ISO strings
 * The Timezone checkbox Syncfusion shows is left out on purpose: the app never
 * stores a timezone, so it would be a control that does nothing.
 *
 * appLook (the main app's edit links): its words in sentence case, its buttons, the color
 * named by its label, and the dialog as a sheet on a phone.
 */
const EventEditor = (() => {
    const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    // The parts of a rule this form edits; any other part is kept as it was.
    const OWN = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'UNTIL', 'COUNT'];
    // A stored all-day instant -> the local date it stands for: the display shape (local midnight, or local
    // 23:59:59.999 of the day before an end) as local dates, anything else to the nearest UTC midnight.
    const allDayDate = (v) => {
        const d = new Date(v);
        if (isNaN(d)) return d;
        if (!d.getHours() && !d.getMinutes() && !d.getSeconds() && !d.getMilliseconds()) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (d.getHours() === 23 && d.getMinutes() === 59 && d.getSeconds() === 59 && d.getMilliseconds() === 999) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        const r = new Date(d.getTime() + 43200000); return new Date(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate());
    };

    return {
        props: {
            event: Object,
            visible: Boolean,
            colors: { type: Array, default: () => [] },
            labels: { type: Array, default: () => [] },
            timeFormat: { type: String, default: '12' },
            appLook: { type: Boolean, default: false },
        },
        emits: ['save', 'delete', 'update:visible', 'color'],
        data() {
            return {
                title: '', type: 1, description: '', isAllDay: false,
                startDate: '', startTime: '09:00', endDate: '', endTime: '10:00',
                freq: '', interval: 1, byDay: [], endMode: 'never', until: '', count: 10,
                // Monthly / yearly: on day N of the month, or on the Nth (or last) weekday; yearly also picks the month.
                monthMode: 'day', monthDay: 1, setPos: 1, posDay: 1, month: 1,
                colorMenu: false, menuStyle: null, error: '',
                v2: typeof NcUx !== 'undefined' && NcUx.v2(),
            };
        },
        computed: {
            isNew() { return !this.event || !this.event.id; },
            // One occurrence of a series (a fresh "Edit Event" or an already-edited copy):
            // no Repeat controls, as in Syncfusion -- the series owns the rule.
            isOccurrence() { return !!(this.event && (this.event._occurrenceOf || this.event.recurrenceID)); },
            palette() { return this.colors.length ? this.colors : ['#3f51b5', '#e3165b', '#d0442f', '#2e7d32', '#ff9800', '#03a9f4', '#757575', '#27282f']; },
            currentColor() { return this.palette[(this.type - 1) % this.palette.length]; },
            // The start as one number, for "end follows start". Uses the time field even
            // when All day hides it, so toggling All day never counts as moving the start.
            startStamp() { return new Date(`${this.startDate}T${this.startTime || '00:00'}`).getTime(); },
            unit() { return { DAILY: 'Day(s)', WEEKLY: 'Week(s)', MONTHLY: 'Month(s)', YEARLY: 'Year(s)' }[this.freq] || ''; },
            // Sentence case (v2 and the main app) or Syncfusion's capitals (v1).
            plain() { return this.v2 || this.appLook; },
            dayNames() { return DAY_NAMES; },
            monthNames() { return MONTH_NAMES; },
            positions() { return [[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], [-1, 'Last']]; },
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
            // v2 and the main app: move the start and the end moves with it, keeping the length (Google,
            // Apple, and Syncfusion's own dialog). v1 leaves the end alone.
            startStamp(now) {
                const was = this._lastStart; this._lastStart = now;
                if (!this.plain || isNaN(now) || isNaN(was) || now === was || was === undefined) return;
                const end = new Date(new Date(`${this.endDate}T${this.endTime || '00:00'}`).getTime() + (now - was));
                if (isNaN(end)) return;
                this.endDate = this.dateStr(end); this.endTime = this.timeStr(end);
            },
            isAllDay(now, was) {
                if (now && !was && this.endDate < this.startDate) this.endDate = this.startDate;
            },
            // Picking a repeat starts from the event's own date, as Syncfusion does (weekly on its weekday, monthly
            // on its day of the month, yearly in its month).
            freq(now, was) { if (now && now !== was && !this._loading) this.defaultsFromStart(); },
        },
        methods: {
            pad(n) { return String(n).padStart(2, '0'); },
            dateStr(d) { return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`; },
            timeStr(d) { return `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}`; },
            startDay() { const [y, m, d] = String(this.startDate).split('-').map(Number); const s = new Date(y, (m || 1) - 1, d || 1); return isNaN(s) ? new Date() : s; },
            defaultsFromStart() {
                const s = this.startDay();
                if (!this.byDay.length) this.byDay = [s.getDay()];
                this.monthDay = s.getDate(); this.posDay = s.getDay(); this.month = s.getMonth() + 1;
                this.setPos = Math.ceil(s.getDate() / 7) > 4 ? -1 : Math.ceil(s.getDate() / 7);
            },
            load() {
                this._loading = true;
                const e = this.event || {};
                this.title = e.title || ''; this.type = Number(e.type) || 1; this.description = e.description || '';
                this.isAllDay = !!e.isAllDay; this.error = ''; this.colorMenu = false;
                let s = e.start ? new Date(e.start) : new Date(); let en = e.end ? new Date(e.end) : new Date(s.getTime() + 3600000);
                if (this.isAllDay) {
                    // The days it covers, with the end shown INCLUSIVELY, as Syncfusion's dialog does.
                    s = allDayDate(s); en = allDayDate(en); if (en > s) en = new Date(en.getFullYear(), en.getMonth(), en.getDate() - 1);
                }
                this.startDate = this.dateStr(s); this.startTime = this.timeStr(s);
                this.endDate = this.dateStr(en); this.endTime = this.timeStr(en);
                this.parseRule(e.recurrencerule, s);
                // The date an UNTIL names, not the local date of its instant (see Event.ruleUntilDate);
                // and the rule as loaded, so saving with the repeat inputs untouched keeps it verbatim.
                if (this.until && typeof Event !== 'undefined' && typeof Event.ruleUntilDate === 'function') {
                    this.until = Event.ruleUntilDate(e.recurrencerule, this.isAllDay) || this.until;
                }
                this._loaded = { rule: e.recurrencerule || '', sig: this.ruleSig() };
                this._lastStart = this.startStamp;   // loading an event is not "moving the start"
                this.$nextTick(() => { this._loading = false; });
            },
            parseRule(rule, start) {
                this.freq = ''; this.interval = 1; this.byDay = [start.getDay()]; this.endMode = 'never'; this.until = ''; this.count = 10;
                this.monthMode = 'day'; this.monthDay = start.getDate(); this.posDay = start.getDay(); this.month = start.getMonth() + 1;
                this.setPos = Math.ceil(start.getDate() / 7) > 4 ? -1 : Math.ceil(start.getDate() / 7);
                this._extra = [];
                if (!rule) return;
                const list = String(rule).replace(/^RRULE:/i, '').split(';').filter(p => p.includes('=')).map(p => [p.slice(0, p.indexOf('=')).toUpperCase(), p.slice(p.indexOf('=') + 1)]);
                const parts = Object.fromEntries(list);
                this._extra = list.filter(([k]) => !OWN.includes(k)).map(([k, v]) => `${k}=${v}`);
                this.freq = parts.FREQ || '';
                this.interval = parseInt(parts.INTERVAL, 10) || 1;
                const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
                if (parts.BYDAY) {
                    this.byDay = parts.BYDAY.split(',').map(d => map[d.replace(/^[+-]?\d+/, '')]).filter(n => n !== undefined);
                    if (!this.byDay.length) this.byDay = [start.getDay()];
                }
                if (this.freq === 'MONTHLY' || this.freq === 'YEARLY') {
                    if (parts.BYMONTH) this.month = parseInt(parts.BYMONTH, 10) || this.month;
                    const lead = parts.BYDAY && /^([+-]?\d+)(\w\w)$/.exec(parts.BYDAY.split(',')[0]);
                    if (parts.BYDAY && (parts.BYSETPOS || lead)) {
                        this.monthMode = 'weekday';
                        this.setPos = parseInt(parts.BYSETPOS || lead[1], 10) || 1;
                        this.posDay = map[(lead ? lead[2] : parts.BYDAY.split(',')[0])] ?? this.posDay;
                    } else if (parts.BYMONTHDAY) this.monthDay = parseInt(parts.BYMONTHDAY, 10) || this.monthDay;
                }
                if (parts.UNTIL) {
                    // A UTC stamp: show the LOCAL day it falls on.
                    const u = parts.UNTIL, t = /T(\d{2})(\d{2})(\d{2})/.exec(u) || [0, '00', '00', '00'];
                    const at = new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +t[1], +t[2], +t[3]));
                    this.endMode = 'until'; this.until = /Z$/.test(u) ? this.dateStr(at) : `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
                }
                else if (parts.COUNT) { this.endMode = 'count'; this.count = parseInt(parts.COUNT, 10) || 1; }
            },
            ruleSig() {
                const monthly = this.freq === 'MONTHLY' || this.freq === 'YEARLY';
                return JSON.stringify([this.freq, Number(this.interval), this.freq === 'WEEKLY' ? [...this.byDay].sort() : null,
                    monthly ? [this.monthMode, Number(this.monthDay), Number(this.setPos), Number(this.posDay)] : null,
                    this.freq === 'YEARLY' ? Number(this.month) : null, this.endMode, this.until, Number(this.count)]);
            },
            toggleDay(d) {
                const i = this.byDay.indexOf(d);
                if (i >= 0) { if (this.byDay.length > 1) this.byDay.splice(i, 1); } else this.byDay.push(d);
            },
            buildRule() {
                if (!this.freq) return '';
                // Untouched inputs: keep the stored rule as it was (its BYDAY, UNTIL format and all).
                if (this._loaded && this._loaded.rule && this._loaded.sig === this.ruleSig()) return this._loaded.rule;
                let r = `FREQ=${this.freq};`;
                if (this.freq === 'WEEKLY') r += `BYDAY=${[...this.byDay].sort().map(d => DAYS[d]).join(',')};`;
                if (this.freq === 'MONTHLY' || this.freq === 'YEARLY') {
                    r += this.monthMode === 'weekday' ? `BYDAY=${DAYS[this.posDay]};BYSETPOS=${this.setPos};`
                        : `BYMONTHDAY=${Math.min(31, Math.max(1, parseInt(this.monthDay, 10) || 1))};`;
                    if (this.freq === 'YEARLY') r += `BYMONTH=${this.month};`;
                }
                r += `INTERVAL=${Math.max(1, parseInt(this.interval, 10) || 1)};`;
                for (const p of this._extra || []) r += `${p};`;
                if (this.endMode === 'until' && this.until) {
                    const [y, m, d] = this.until.split('-').map(Number);
                    // All-day: the grid's format (Event.ruleUntilStamp); timed: end of that day, UTC.
                    const grid = this.isAllDay && typeof Event !== 'undefined' && typeof Event.ruleUntilStamp === 'function' ? Event.ruleUntilStamp(this.until, true) : null;
                    r += grid ? `UNTIL=${grid};` : `UNTIL=${new Date(y, m - 1, d, 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')};`;
                } else if (this.endMode === 'count') r += `COUNT=${Math.max(1, parseInt(this.count, 10) || 1)};`;
                return r;
            },
            save() {
                const [sy, sm, sd] = this.startDate.split('-').map(Number);
                const [ey, em, ed] = this.endDate.split('-').map(Number);
                let start, end;
                if (this.isAllDay) {
                    start = new Date(sy, sm - 1, sd);
                    // Display shape, as the grid emits it: local 23:59:59.999 of the LAST day. The app turns it into
                    // the stored form; an exclusive end here would be read as the last day and store a day too long.
                    end = new Date(ey, em - 1, ed, 23, 59, 59, 999);
                } else {
                    const [sh, smin] = this.startTime.split(':').map(Number), [eh, emin] = this.endTime.split(':').map(Number);
                    start = new Date(sy, sm - 1, sd, sh, smin); end = new Date(ey, em - 1, ed, eh, emin);
                }
                if (isNaN(start) || isNaN(end)) { this.error = 'Please enter a valid start and end.'; return; }
                if (end <= start) { this.error = 'The end must be after the start.'; return; }
                const rule = this.isOccurrence ? (this.event.recurrencerule || '') : this.buildRule();
                // Syncfusion's own checks on a repeat (its recurrenceValidation): an end date before the start, and an
                // event longer than the gap between its repeats.
                if (!this.isOccurrence && this.freq) {
                    if (this.endMode === 'until' && this.until && this.until < this.startDate) { this.error = 'The recurrence pattern is not valid.'; return; }
                    const every = Math.max(1, parseInt(this.interval, 10) || 1);
                    const gap = { DAILY: 1, WEEKLY: 7 }[this.freq];
                    if (gap && (end - start) / 86400000 > gap * every + (this.isAllDay ? 0.001 : 0)) {
                        this.error = 'The duration of the event must be shorter than how frequently it occurs. Shorten the duration, or change the repeat.';
                        return;
                    }
                }
                this.$emit('save', {
                    ...(this.event || {}),
                    title: this.title.trim() || '(No title)', type: this.type, description: this.description,
                    isAllDay: this.isAllDay, start: start.toISOString(), end: end.toISOString(),
                    recurrencerule: rule,
                });
            },
            close() { this.$emit('update:visible', false); },
            pickColor(i) { this.type = i + 1; this.colorMenu = false; this.$emit('color', i + 1); },
            // v2 says "Category" (the word Settings uses: "+ Add category"); v1 and the main app keep "Type".
            label(i) {
                const l = this.labels[i];
                // The defaults are STORED as "Type 1".."Type 8"; v2 shows an unrenamed one as
                // "Category N". Names people chose ("Soccer") are shown as they are.
                if (this.v2 && (!l || /^Type \d+$/.test(l))) return 'Category ' + (i + 1);
                return l || ('Type ' + (i + 1));
            },
            // v2 and the main app: the menu is placed against the window, so the editor's scrolling body cannot
            // clip it; it opens downward if it fits, else upward, and scrolls if it must.
            toggleColorMenu(e) {
                this.colorMenu = !this.colorMenu;
                if (!this.colorMenu || !this.plain) return;
                const r = e.currentTarget.getBoundingClientRect(), want = 44 + this.palette.length * 36;
                const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
                const down = below >= Math.min(want, 240) || below >= above;
                const room = Math.max(160, down ? below : above);
                this.menuStyle = { position: 'fixed', left: r.left + 'px', width: Math.max(r.width, 220) + 'px', maxHeight: Math.min(want, room) + 'px',
                    ...(down ? { top: (r.bottom + 4) + 'px' } : { bottom: (window.innerHeight - r.top + 4) + 'px' }) };
            },
        },
        template: /* html */ `
<div v-if="visible" class="ne-overlay" :class="{ 'ne-app': appLook }" @mousedown.self="close">
  <div class="ne-dialog" role="dialog" aria-modal="true" :aria-label="plain ? (isNew ? 'New event' : 'Edit event') : (isNew ? 'New Event' : 'Edit Event')" data-testid="event-editor"
    @keydown.esc.stop.prevent="colorMenu ? (colorMenu = false) : close()">
    <div class="ne-head">
      <h2>{{ plain ? (isNew ? 'New event' : 'Edit event') : (isNew ? 'New Event' : 'Edit Event') }}</h2>
      <button class="ne-x" aria-label="Close" data-testid="editor-close" @click="close"><nc-icon name="x" :size="20"></nc-icon></button>
    </div>
    <div class="ne-body">
      <div class="ne-row ne-title-row">
        <label class="ne-field ne-grow"><span>Title</span>
          <input ref="title" class="pc-field" v-model="title" data-testid="editor-title" :placeholder="appLook ? 'Add title' : null" @keydown.enter.prevent="save"></label>
        <div v-if="!plain" class="ne-color">
          <button class="ne-color-btn" :style="{ background: currentColor }" aria-label="Color" data-testid="editor-color" @click="colorMenu = !colorMenu"><nc-icon name="chevron-down" :size="16" :stroke-width="2.5"></nc-icon></button>
          <div v-if="colorMenu" class="ne-color-menu">
            <button v-for="(c, i) in palette" :key="i" :data-testid="'editor-color-' + (i + 1)" @click="pickColor(i)">
              <span class="sw" :style="{ background: c }"></span>{{ labels[i] || ('Type ' + (i + 1)) }}</button>
            <div class="ne-color-hint">Customize labels in Settings</div>
          </div>
        </div>
      </div>
      <!-- v2 and the main app: the color as a labeled dropdown. The labels ("Soccer", "Practice") are the
           information, so the closed button names the current one and the open menu names them all. -->
      <div v-if="plain" class="ne-field ne-colorfield"><span>{{ v2 ? 'Category' : 'Color' }}</span>
        <div class="ne-color">
          <button type="button" class="ne-color2" aria-haspopup="listbox" :aria-expanded="colorMenu" data-testid="editor-color" @click="toggleColorMenu">
            <span class="sw" :style="{ background: currentColor }"></span>
            <span class="ne-color2-label" data-testid="editor-color-label">{{ label(type - 1) }}</span>
            <nc-icon name="chevron-down" :size="16"></nc-icon></button>
          <div v-if="colorMenu" class="ne-color-menu ne-color-menu2" :style="menuStyle" role="listbox" :aria-label="v2 ? 'Category' : 'Color'">
            <button v-for="(c, i) in palette" :key="i" type="button" role="option" :aria-selected="type === i + 1"
              :data-testid="'editor-color-' + (i + 1)" @click="pickColor(i)">
              <span class="sw" :style="{ background: c }"></span><span class="lbl">{{ label(i) }}</span>
              <nc-icon v-if="type === i + 1" class="ck" name="check" :size="16" :stroke-width="2.5"></nc-icon></button>
            <div class="ne-color-hint">{{ v2 ? 'Edit categories in Settings' : 'Name these colors in Settings' }}</div>
          </div>
        </div>
      </div>
      <div class="ne-row ne-when">
        <label class="ne-field ne-grow"><span>Start</span>
          <div class="ne-dt"><input type="date" class="pc-field" v-model="startDate" data-testid="editor-start-date"><input v-if="!isAllDay" type="time" class="pc-field" v-model="startTime" data-testid="editor-start-time"></div></label>
        <label class="ne-field ne-grow"><span>End</span>
          <div class="ne-dt"><input type="date" class="pc-field" v-model="endDate" data-testid="editor-end-date"><input v-if="!isAllDay" type="time" class="pc-field" v-model="endTime" data-testid="editor-end-time"></div></label>
      </div>
      <label class="ne-check"><input type="checkbox" v-model="isAllDay" data-testid="editor-allday"> All day</label>
      <!-- v1: Syncfusion's two columns -- Repeat | Repeat every, then Repeat On | End.
           v2 and the main app: the options stacked under Repeat. Same fields. -->
      <div v-if="!isOccurrence" class="ne-rep">
        <label class="ne-field ne-rep-freq"><span>Repeat</span>
          <select class="pc-field" v-model="freq" data-testid="editor-repeat">
            <option value="">Never</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option><option value="YEARLY">Yearly</option></select></label>
        <div v-if="freq" class="ne-repeat" data-testid="editor-repeat-options">
          <label class="ne-field ne-rep-every"><span>Repeat every</span>
            <div class="ne-inline"><input type="number" min="1" v-model="interval" class="pc-field ne-num" data-testid="editor-interval"> {{ unit }}</div></label>
          <div v-if="freq === 'WEEKLY'" class="ne-field ne-rep-on"><span>{{ plain ? 'Repeat on' : 'Repeat On' }}</span>
            <div class="ne-days">
              <button v-for="(n, d) in ['S','M','T','W','T','F','S']" :key="d" type="button" :class="{ on: byDay.includes(d) }" :aria-pressed="byDay.includes(d)"
                :aria-label="dayNames[d]" :data-testid="'editor-day-' + d" @click="toggleDay(d)">{{ n }}</button></div></div>
          <div v-if="freq === 'MONTHLY' || freq === 'YEARLY'" class="ne-field ne-rep-month" data-testid="editor-month-options"><span>{{ freq === 'YEARLY' ? 'On' : (plain ? 'Repeat on' : 'Repeat On') }}</span>
            <label v-if="freq === 'YEARLY'" class="ne-inline ne-month-pick"><select class="pc-field" v-model.number="month" data-testid="editor-month" aria-label="Month">
              <option v-for="(n, i) in monthNames" :key="i" :value="i + 1">{{ n }}</option></select></label>
            <label class="ne-radio"><input type="radio" value="day" v-model="monthMode" data-testid="editor-month-by-day"> Day
              <input type="number" min="1" max="31" v-model.number="monthDay" class="pc-field ne-num" data-testid="editor-month-day" aria-label="Day of the month" @focus="monthMode = 'day'"></label>
            <label class="ne-radio"><input type="radio" value="weekday" v-model="monthMode" data-testid="editor-month-by-weekday">
              <select class="pc-field" v-model.number="setPos" data-testid="editor-setpos" aria-label="Which week" @focus="monthMode = 'weekday'">
                <option v-for="p in positions" :key="p[0]" :value="p[0]">{{ p[1] }}</option></select>
              <select class="pc-field" v-model.number="posDay" data-testid="editor-posday" aria-label="Weekday" @focus="monthMode = 'weekday'">
                <option v-for="(n, i) in dayNames" :key="i" :value="i">{{ n }}</option></select></label>
          </div>
          <div class="ne-rep-end">
            <label class="ne-field"><span>End</span>
              <select class="pc-field" v-model="endMode" data-testid="editor-end-mode"><option value="never">Never</option><option value="until">Until</option><option value="count">Count</option></select></label>
            <label v-if="endMode === 'until'" class="ne-field"><span>Until</span><input type="date" class="pc-field" v-model="until" data-testid="editor-until"></label>
            <label v-if="endMode === 'count'" class="ne-field"><span>Occurrences</span><input type="number" min="1" v-model="count" class="pc-field ne-num" data-testid="editor-count"></label>
          </div>
        </div>
      </div>
      <label class="ne-field"><span>Description</span>
        <textarea v-model="description" rows="3" data-testid="editor-description"></textarea></label>
      <p v-if="error" class="ne-error" role="alert" data-testid="editor-error">{{ error }}</p>
    </div>
    <div class="ne-foot">
      <template v-if="appLook">
        <button v-if="!isNew" type="button" class="pc-btn pc-btn--ghost ne-delete" data-testid="editor-delete" @click="$emit('delete', event)">Delete</button>
        <span class="ne-spacer"></span>
        <button type="button" class="pc-btn pc-btn--secondary" data-testid="editor-cancel" @click="close">Cancel</button>
        <button type="button" class="pc-btn pc-btn--primary" data-testid="editor-save" @click="save">Save</button>
      </template>
      <template v-else-if="v2">
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
})();
if (typeof window !== 'undefined') window.EventEditor = EventEditor;
