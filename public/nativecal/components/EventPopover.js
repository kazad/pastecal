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
                : `${pad(d.getHours() % 12 || 12)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
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
  <div class="np-head" :style="{ background: headerColor }" data-testid="popover-header">
    <div class="np-icons">
      <button v-if="!readOnly" class="np-icon" title="Edit" aria-label="Edit" data-testid="popover-edit" @click="$emit('edit', event)">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>
      <button v-if="!readOnly" class="np-icon" title="Delete" aria-label="Delete" data-testid="popover-delete" @click="$emit('delete', event.id)">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
      <button class="np-icon" title="Close" aria-label="Close" data-testid="popover-close" @click="$emit('close')">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>
    <div class="np-title" data-testid="popover-title">{{ event.title || '(No title)' }}</div>
  </div>
  <div class="np-body">
    <div class="np-line"><svg class="np-glyph" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7v-2H5V10h14v2h2V6a2 2 0 0 0-2-2zm-2 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm1.6 5.9-2.1-1.3V16h1v2.1l1.6.9-.5.9z"/></svg><span>{{ when }}<span v-if="repeats" class="np-sub" data-testid="popover-repeats">{{ repeats }}</span></span></div>
    <div v-if="event.description" class="np-line"><svg class="np-glyph" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 3h-4.18A3 3 0 0 0 12 1a3 3 0 0 0-2.82 2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
      <span class="np-desc" data-testid="popover-description" v-html="linkified"></span></div>
  </div>
</div>`,
};
if (typeof window !== 'undefined') window.EventPopover = EventPopover;
