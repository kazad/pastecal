/**
 * The event popup, laid out like Syncfusion's quick-info popup: a header in the
 * event's color with edit / delete / close icons top-right and the title below, then
 * the date line and the description. Shows the OCCURRENCE that was clicked -- for a
 * repeating event that is this week's date, not the date the series started.
 */
const EventPopover = {
    props: {
        event: Object,
        occurrence: { type: Object, default: null },
        visible: Boolean,
        top: Number,
        left: Number,
        timeFormat: { type: String, default: '12' },
        colors: { type: Array, default: () => [] },
        readOnly: { type: Boolean, default: false },
    },
    emits: ['close', 'edit', 'delete'],
    data() { return { v2: typeof NcUx !== 'undefined' && NcUx.v2() }; },
    computed: {
        headerColor() {
            const p = this.colors.length ? this.colors : ['#3f51b5'];
            return p[((Number(this.event?.type) || 1) - 1) % p.length] || p[0];
        },
        when() {
            const e = this.event; if (!e) return '';
            const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            let s = new Date(this.occurrence?.start || e.start), en = new Date(this.occurrence?.end || e.end);
            const fmtD = (d) => `${M[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
            const pad = (n) => String(n).padStart(2, '0');
            const fmtT = (d) => this.timeFormat === '24' ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
                : `${this.v2 ? (d.getHours() % 12 || 12) : pad(d.getHours() % 12 || 12)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
            if (e.isAllDay) {
                const day = (v) => { const r = new Date(new Date(v).getTime() + 43200000); return new Date(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate()); };
                s = this.occurrence ? new Date(this.occurrence.start) : day(e.start);
                const last = new Date((this.occurrence ? new Date(this.occurrence.end) : day(e.end)).getTime() - 86400000);
                return last > s ? `${fmtD(s)} - ${fmtD(last)} (All day)` : `${fmtD(s)} (All day)`;
            }
            const sameDay = s.toDateString() === en.toDateString();
            return sameDay ? `${fmtD(s)} (${fmtT(s)} - ${fmtT(en)})` : `${fmtD(s)} (${fmtT(s)}) - ${fmtD(en)} (${fmtT(en)})`;
        },
        repeats() {
            const r = this.event?.recurrencerule; if (!r || this.event.recurrenceID) return '';
            const f = (r.match(/FREQ=(\w+)/) || [])[1], n = parseInt((r.match(/INTERVAL=(\d+)/) || [])[1] || '1', 10);
            const days = (r.match(/BYDAY=([\w,]+)/) || [])[1];
            const names = { SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday' };
            const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[f] || 'time';
            let s = n > 1 ? `Repeats every ${n} ${unit}s` : `Repeats every ${unit}`;
            if (f === 'WEEKLY' && days) s += ' on ' + days.split(',').map(d => names[d.replace(/^[+-]?\d+/, '')]).filter(Boolean).join(', ');
            return s;
        },
        linkified() {
            const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            return esc(this.event?.description || '').replace(/(https?:\/\/[^\s<]+?)([).,!?;:]*(?=\s|$))/g,
                '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>$2');
        },
    },
    template: /* html */ `
<div v-if="visible && event" class="np" data-testid="event-popover" :style="{ top: top + 'px', left: left + 'px' }">
  <!-- v2: a plain card with a color square beside the title (Google), so a light
       event color never puts white text on a pale header. -->
  <template v-if="v2">
    <div class="np2-bar">
      <button v-if="!readOnly" class="np2-icon" title="Edit" aria-label="Edit" data-testid="popover-edit" @click="$emit('edit', event)"><nc-icon name="pencil" :size="18"></nc-icon></button>
      <button v-if="!readOnly" class="np2-icon" title="Delete" aria-label="Delete" data-testid="popover-delete" @click="$emit('delete', event.id)"><nc-icon name="trash-2" :size="18"></nc-icon></button>
      <button class="np2-icon" title="Close" aria-label="Close" data-testid="popover-close" @click="$emit('close')"><nc-icon name="x" :size="20"></nc-icon></button>
    </div>
    <div class="np2-titlerow"><span class="np2-swatch" data-testid="popover-swatch" :style="{ background: headerColor }"></span>
      <div class="np2-title" data-testid="popover-title">{{ event.title || '(No title)' }}</div></div>
  </template>
  <div v-else class="np-head" :style="{ background: headerColor }" data-testid="popover-header">
    <div class="np-icons">
      <button v-if="!readOnly" class="np-icon" title="Edit" aria-label="Edit" data-testid="popover-edit" @click="$emit('edit', event)">
        <nc-icon name="pencil" :size="16"></nc-icon></button>
      <button v-if="!readOnly" class="np-icon" title="Delete" aria-label="Delete" data-testid="popover-delete" @click="$emit('delete', event.id)">
        <nc-icon name="trash-2" :size="16"></nc-icon></button>
      <button class="np-icon" title="Close" aria-label="Close" data-testid="popover-close" @click="$emit('close')">
        <nc-icon name="x" :size="18"></nc-icon></button>
    </div>
    <div class="np-title" data-testid="popover-title">{{ event.title || '(No title)' }}</div>
  </div>
  <div class="np-body">
    <div class="np-line"><nc-icon class="np-glyph" name="calendar-clock"></nc-icon><span>{{ when }}<span v-if="repeats" class="np-sub" data-testid="popover-repeats">{{ repeats }}</span></span></div>
    <div v-if="event.description" class="np-line"><nc-icon class="np-glyph" name="text-align-start"></nc-icon>
      <span class="np-desc" data-testid="popover-description" v-html="linkified"></span></div>
  </div>
</div>`,
};
if (typeof window !== 'undefined') window.EventPopover = EventPopover;
