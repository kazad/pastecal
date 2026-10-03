// ClaimDialog -- "Name your calendar": a title and a link, before a draft is saved.
//
// Shared by the Syncfusion app and nativecal. It was unreachable for months: app.js
// defined create() twice, and the second definition (the one that saves) silently
// replaced the first (the one that opens this dialog). It now has its own entry point
// (CalendarFlow.mixin.openClaimDialog / startClaim) and a title field, so claimed
// calendars stop arriving in recents and subscribers' calendar apps as "New Calendar".
//
// The link field slugifies as it is typed (spaces become hyphens, capitals drop) and says
// what is wrong inline; the server's answer ("taken", a refused write) lands in the same
// place, and the dialog stays open and usable after any failure.
const ClaimDialog = {
    name: 'ClaimDialog',
    props: {
        open: { type: Boolean, default: false },
        slug: { type: String, default: '' },
        message: { type: String, default: '' },   // inline problem with the link, or ''
        busy: { type: Boolean, default: false },
        initialTitle: { type: String, default: '' },
    },
    emits: ['slug-input', 'randomize', 'submit', 'close'],
    data() {
        return { title: '', opener: null };
    },
    watch: {
        open: {
            immediate: true,
            handler(isOpen) {
                if (isOpen) {
                    this.opener = typeof document !== 'undefined' ? document.activeElement : null;
                    this.title = this.initialTitle && this.initialTitle !== 'New Calendar' ? this.initialTitle : '';
                    this.$nextTick(() => this.$refs.title && this.$refs.title.focus());
                } else if (this.opener && typeof this.opener.focus === 'function') {
                    // Back where they were, so keyboard users are not dropped at the top.
                    const el = this.opener;
                    this.opener = null;
                    this.$nextTick(() => { try { el.focus(); } catch (e) { /* gone */ } });
                }
            },
        },
    },
    methods: {
        submit() {
            if (this.busy) return;
            this.$emit('submit', { title: this.title.trim() });
        },
    },
    template: /* html */ `
        <div v-if="open" class="pc-modal" @click.self="$emit('close')" @keydown.esc.stop="$emit('close')"
            data-testid="claim-dialog">
            <form class="pc-modal-panel" role="dialog" aria-modal="true" aria-labelledby="claim-dialog-title"
                @submit.prevent="submit" novalidate>
                <button type="button" @click="$emit('close')" aria-label="Close"
                    class="absolute top-4 right-4 text-color-1 hover:text-theme-strong transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <path fill-rule="evenodd" clip-rule="evenodd"
                            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
                    </svg>
                </button>

                <h3 id="claim-dialog-title" class="text-lg font-bold text-color-2 mb-1 text-center">Name your calendar</h3>
                <p class="text-sm text-color-1 mb-5 text-center">
                    Anyone with the link can view and edit it, so share it only with your group.
                </p>

                <label for="claim-title" class="block text-sm font-medium text-color-2 mb-1">Title</label>
                <input id="claim-title" ref="title" type="text" v-model="title" maxlength="120"
                    class="pc-input w-full mb-4" placeholder="e.g. Soccer team schedule" autocomplete="off"
                    data-testid="claim-title">

                <label for="claim-slug" class="block text-sm font-medium text-color-2 mb-1">Link</label>
                <div class="pc-input-group" :class="{ 'pc-input-group-invalid': message }">
                    <span class="pc-input-prefix">pastecal.com/</span>
                    <input id="claim-slug" type="text" :value="slug" maxlength="60"
                        class="pc-input" placeholder="my-calendar" autocomplete="off" autocapitalize="none"
                        spellcheck="false" :aria-invalid="message ? 'true' : 'false'"
                        aria-describedby="claim-slug-help"
                        @input="$emit('slug-input', $event)" data-testid="claim-slug">
                    <button type="button" class="px-2 text-xs text-color-1 hover:text-blue-500 whitespace-nowrap"
                        @click="$emit('randomize')" title="Use a random, hard-to-guess link">Random</button>
                </div>
                <p id="claim-slug-help" class="text-xs mt-2 min-h-[1rem]" aria-live="polite"
                    :class="message ? 'pc-text-danger font-medium' : 'text-color-1'" data-testid="claim-message">
                    {{ message || 'Lowercase letters, numbers and hyphens. A random link is harder to guess.' }}
                </p>

                <button type="submit" :disabled="busy" class="pc-btn pc-btn-primary w-full shadow-md mt-4"
                    data-testid="claim-submit">
                    <span>{{ busy ? 'Creating...' : 'Create calendar' }}</span>
                </button>
            </form>
        </div>
    `,
};

if (typeof window !== 'undefined') window.ClaimDialog = ClaimDialog;
