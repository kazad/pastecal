// WelcomeDock Component
// First-run explainer for people who land on the homepage with no idea what
// PasteCal is. Copy is condensed from the help panel in index.html so there's
// one voice; "See how it works" opens that panel rather than repeating it.
//
// Deliberately undemanding: it never blocks the calendar, fades itself out
// after a timeout, and once dismissed it stays gone for good.

const WelcomeDock = {
    template: /* html */ `
        <div v-if="visible" data-testid="welcome-dock"
            class="welcome-dock bg-1 border border-color-default"
            :class="{ 'welcome-dock--leaving': leaving }"
            @mouseenter="pause" @mouseleave="resume"
            @focusin="pause" @focusout="resume">

            <div class="flex items-start gap-2">
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-bold text-color-2 mb-1">Shared calendars that just work</p>
                    <p class="text-xs text-color-1 leading-relaxed">
                        No logins. No installs. Add events, then pick a link like
                        <code class="welcome-dock__url bg-disabled">pastecal.com/summer-trip</code>
                        and everyone with it can view and edit.
                    </p>

                    <div class="flex items-center gap-1 mt-3">
                        <button type="button" @click="dismiss"
                            data-testid="welcome-dock-dismiss"
                            class="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors">
                            Got it
                        </button>
                        <button type="button" @click="showHelp"
                            data-testid="welcome-dock-help"
                            class="px-3 py-1.5 text-xs font-semibold text-color-1 hover:text-theme-strong rounded transition-colors">
                            See how it works
                        </button>
                    </div>
                </div>

                <button type="button" @click="dismiss" aria-label="Dismiss welcome message"
                    class="text-color-1 hover:text-theme-strong leading-none px-1 rounded transition-colors">
                    &times;
                </button>
            </div>

            <span class="welcome-dock__progress" :style="{ animationDuration: timeout + 'ms' }"></span>
        </div>
    `,

    emits: ['dismissed', 'show-help'],

    data() {
        return {
            visible: false,
            leaving: false,
            timeout: 12000,
            timer: null,
            remaining: 12000,
            startedAt: 0,
            // The 600ms reveal delay below.
            revealTimer: null,
            // Set by the first close for any reason (interaction, timeout, dismiss,
            // unmount). It is the one answer to "should this dock still appear?".
            // close() used to key off `visible`, which is false during the reveal
            // delay -- so a click or keypress in that window was dropped and the
            // dock appeared anyway over someone already using the calendar.
            done: false,
        };
    },

    mounted() {
        // Let the calendar paint before anything appears over it. The whole
        // pitch is that the product loads instantly; showing this first would
        // undercut the one thing we're claiming.
        this.revealTimer = setTimeout(() => {
            this.revealTimer = null;
            if (this.done) return;
            this.visible = true;
            this.startTimer();
        }, 600);

        // Someone who starts using the calendar has answered their own
        // question. Get out of their way.
        document.addEventListener('pointerdown', this.onFirstInteraction, true);
        document.addEventListener('keydown', this.onFirstInteraction, true);
    },

    beforeUnmount() {
        // A dock unmounted before its reveal must not flip `visible` on a dead
        // component or start a fade timer nothing will clear.
        this.done = true;
        if (this.revealTimer) clearTimeout(this.revealTimer);
        this.revealTimer = null;
        this.clearTimer();
        document.removeEventListener('pointerdown', this.onFirstInteraction, true);
        document.removeEventListener('keydown', this.onFirstInteraction, true);
    },

    methods: {
        startTimer() {
            this.startedAt = Date.now();
            this.timer = setTimeout(this.fade, this.remaining);
        },

        clearTimer() {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
        },

        pause() {
            if (!this.timer) return;
            this.clearTimer();
            this.remaining -= (Date.now() - this.startedAt);
        },

        resume() {
            if (this.done || this.timer || !this.visible) return;
            if (this.remaining <= 0) return this.fade();
            this.startTimer();
        },

        onFirstInteraction(e) {
            // Clicking inside the dock is not "getting on with it".
            if (this.$el && this.$el.contains && this.$el.contains(e.target)) return;
            this.fade();
        },

        // Timed out or user moved on: hide it, and don't show it again.
        fade() {
            this.close();
        },

        // Explicit dismissal. Same persistence, but worth keeping separate so
        // analytics can tell the two apart later if we care.
        dismiss() {
            this.close();
        },

        showHelp() {
            this.$emit('show-help');
            this.close();
        },

        close() {
            if (this.done) return;
            this.done = true;
            if (this.revealTimer) clearTimeout(this.revealTimer);
            this.revealTimer = null;
            this.clearTimer();
            document.removeEventListener('pointerdown', this.onFirstInteraction, true);
            document.removeEventListener('keydown', this.onFirstInteraction, true);
            // Closed before it was ever shown: the person got on with the calendar
            // during the reveal delay. Same outcome as moving on after it appeared.
            if (!this.visible) {
                this.$emit('dismissed');
                return;
            }
            this.leaving = true;
            setTimeout(() => {
                this.visible = false;
                this.$emit('dismissed');
            }, 300);
        },
    },
};
