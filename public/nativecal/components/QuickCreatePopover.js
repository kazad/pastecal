/**
 * Quick create, laid out like Syncfusion's cell popup: a large "Add title" field, the
 * date line with its icon, and MORE DETAILS / SAVE. Enter saves; Escape closes.
 * 'title' follows the field as it is typed, so the grid can label the new event's block with it.
 * appLook (the main app's edit links): its words in sentence case and its buttons.
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
        appLook: { type: Boolean, default: false },
    },
    emits: ['save', 'more-details', 'close', 'title'],
    data() { return { localTitle: '', v2: typeof NcUx !== 'undefined' && NcUx.v2() }; },
    watch: {
        visible: {
            handler(v) { if (v) { this.localTitle = ''; this.$nextTick(() => this.$refs.titleInput && this.$refs.titleInput.focus()); } },
            immediate: true,
        },
        localTitle(t) { this.$emit('title', t); },
    },
    computed: {
        when() {
            const s = new Date(this.start), e = new Date(this.end);
            if (isNaN(s) || isNaN(e)) return '';
            const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const pad = (n) => String(n).padStart(2, '0');
            const d = (x) => `${M[x.getMonth()]} ${x.getDate()}, ${x.getFullYear()}`;
            const t = (x) => this.timeFormat === '24' ? `${pad(x.getHours())}:${pad(x.getMinutes())}`
                : `${this.v2 || this.appLook ? (x.getHours() % 12 || 12) : pad(x.getHours() % 12 || 12)}:${pad(x.getMinutes())} ${x.getHours() < 12 ? 'AM' : 'PM'}`;
            if (this.isAllDay) {
                // The end is the last day's 23:59:59.999 (display shape) or the next midnight: the day before it.
                const last = new Date(e.getTime() - 1); last.setHours(0, 0, 0, 0);
                return last.toDateString() !== s.toDateString() && last > s ? `${d(s)} - ${d(last)} (All day)` : `${d(s)} (All day)`;
            }
            return s.toDateString() === e.toDateString() ? `${d(s)} (${t(s)} - ${t(e)})` : `${d(s)} (${t(s)}) - ${d(e)} (${t(e)})`;
        },
    },
    methods: {
        save() { this.$emit('save', this.localTitle.trim()); },
    },
    template: /* html */ `
<div v-if="visible" class="nq" :class="{ 'nq-app': appLook }" data-testid="quick-create" role="dialog" aria-label="New event" :style="{ top: top + 'px', left: left + 'px' }">
  <button class="nq-x" aria-label="Close" data-testid="quick-create-close" @click="$emit('close')"><nc-icon name="x" :size="18"></nc-icon></button>
  <input ref="titleInput" v-model="localTitle" class="nq-title" placeholder="Add title" aria-label="Title" data-testid="quick-create-title"
    @keydown.enter.prevent="save" @keydown.esc.prevent.stop="$emit('close')">
  <div class="nq-line"><nc-icon class="np-glyph" name="calendar-clock"></nc-icon>{{ when }}</div>
  <div class="nq-foot">
    <template v-if="appLook">
      <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm" data-testid="quick-create-more" @click="$emit('more-details', localTitle.trim())">More details</button>
      <button type="button" class="pc-btn pc-btn--primary pc-btn--sm" data-testid="quick-create-save" @click="save">Save</button>
    </template>
    <template v-else>
      <button class="ne-btn" data-testid="quick-create-more" @click="$emit('more-details', localTitle.trim())">{{ v2 ? 'More options' : 'MORE DETAILS' }}</button>
      <button class="ne-btn primary" data-testid="quick-create-save" @click="save">{{ v2 ? 'Save' : 'SAVE' }}</button>
    </template>
  </div>
</div>`,
};
if (typeof window !== 'undefined') window.QuickCreatePopover = QuickCreatePopover;
