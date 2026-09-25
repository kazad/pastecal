/**
 * Quick create, laid out like Syncfusion's cell popup: a large "Add title" field, the
 * date line with its icon, and MORE DETAILS / SAVE. Enter saves; Escape closes.
 */
const QuickCreatePopover = {
    props: {
        visible: Boolean,
        start: [String, Number],
        end: [String, Number],
        isAllDay: Boolean,
        top: Number,
        left: Number,
        timeFormat: { type: String, default: '12' },
    },
    emits: ['save', 'more-details', 'close'],
    data() { return { localTitle: '' }; },
    watch: {
        visible: {
            handler(v) { if (v) { this.localTitle = ''; this.$nextTick(() => this.$refs.titleInput && this.$refs.titleInput.focus()); } },
            immediate: true,
        },
    },
    computed: {
        when() {
            const s = new Date(this.start), e = new Date(this.end);
            if (isNaN(s) || isNaN(e)) return '';
            const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const pad = (n) => String(n).padStart(2, '0');
            const d = (x) => `${M[x.getMonth()]} ${x.getDate()}, ${x.getFullYear()}`;
            const t = (x) => this.timeFormat === '24' ? `${pad(x.getHours())}:${pad(x.getMinutes())}`
                : `${pad(x.getHours() % 12 || 12)}:${pad(x.getMinutes())} ${x.getHours() < 12 ? 'AM' : 'PM'}`;
            if (this.isAllDay) {
                const last = new Date(e.getTime() - 86400000);
                return last.toDateString() !== s.toDateString() && last > s ? `${d(s)} - ${d(last)} (All day)` : `${d(s)} (All day)`;
            }
            return s.toDateString() === e.toDateString() ? `${d(s)} (${t(s)} - ${t(e)})` : `${d(s)} (${t(s)}) - ${d(e)} (${t(e)})`;
        },
    },
    methods: {
        save() { this.$emit('save', this.localTitle.trim()); },
    },
    template: /* html */ `
<div v-if="visible" class="nq" data-testid="quick-create" :style="{ top: top + 'px', left: left + 'px' }">
  <button class="nq-x" aria-label="Close" data-testid="quick-create-close" @click="$emit('close')"><nc-icon name="x" :size="18"></nc-icon></button>
  <input ref="titleInput" v-model="localTitle" class="nq-title" placeholder="Add title" data-testid="quick-create-title"
    @keydown.enter.prevent="save" @keydown.esc.prevent="$emit('close')">
  <div class="nq-line"><nc-icon class="np-glyph" name="calendar-clock"></nc-icon>{{ when }}</div>
  <div class="nq-foot">
    <button class="ne-btn" data-testid="quick-create-more" @click="$emit('more-details', localTitle.trim())">MORE DETAILS</button>
    <button class="ne-btn primary" data-testid="quick-create-save" @click="save">SAVE</button>
  </div>
</div>`,
};
if (typeof window !== 'undefined') window.QuickCreatePopover = QuickCreatePopover;
