// ToastNotification Component
// Displays toast messages with success/error/info types

const ToastNotification = {
    // The live region is always in the DOM, so screen readers are already watching it
    // when a message appears -- a region inserted together with its text is often not
    // announced at all.
    template: /* html */ `
        <div aria-live="polite" aria-atomic="true">
        <transition 
            enter-active-class="transform ease-out duration-300 transition"
            enter-from-class="translate-y-2 opacity-0 sm:translate-y-0 sm:translate-x-2"
            enter-to-class="translate-y-0 opacity-100 sm:translate-x-0"
            leave-active-class="transition ease-in duration-100"
            leave-from-class="opacity-100"
            leave-to-class="opacity-0">
            <div v-if="show" class="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-[100] w-full max-w-md px-4 flex justify-center pointer-events-none"
                @mouseenter="hovered = true" @mouseleave="hovered = false; resumeTimer()"
                @focusin="focused = true" @focusout="onFocusOut">
                <!-- One row, like Gmail's snackbar: the message, the action beside it, close. An icon only
                     for errors, where it carries meaning. -->
                <div class="pc-toast" :class="'pc-toast--' + type" role="status">
                    <svg v-if="type === 'error'" class="pc-toast-ico" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p class="pc-toast-msg">{{ message }}</p>
                    <!-- Optional action, e.g. "Undo" right after a delete. -->
                    <button v-if="actionLabel" type="button" @click="runAction" class="pc-toast-act">{{ actionLabel }}</button>
                    <button type="button" @click="hide" class="pc-toast-x" aria-label="Close">
                        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                    </button>
                </div>
            </div>
                        </div>
                    </div>
                </div>
            </div>
        </transition>
        </div>
    `,
    data() {
        return {
            show: false,
            message: '',
            type: 'info',
            timer: null,
            actionLabel: '',
            action: null,
            // Auto-hide waits while the pointer or keyboard focus is on the toast: an
            // Undo that vanishes as someone reaches for it is worse than none.
            hovered: false,
            focused: false,
            expired: false
        }
    },
    methods: {
        /**
         * @param options.actionLabel  text for an inline action button, e.g. "Undo"
         * @param options.action       called when it is pressed
         * @param options.duration     ms before auto-hide; an actionable toast stays
         *                             longer, since 3s is not enough to read a message
         *                             AND decide to act on it.
         */
        display(message, type = 'info', options = {}) {
            this.message = message;
            this.type = type;
            this.actionLabel = options.actionLabel || '';
            this.action = options.action || null;
            this.show = true;
            this.expired = false;
            this.scheduleHide(options.duration || (this.actionLabel ? 8000 : 3000));
        },
        scheduleHide(ms) {
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                this.timer = null;
                if (this.hovered || this.focused) {
                    this.expired = true;   // hide once they move away
                    return;
                }
                this.hide();
            }, ms);
        },
        // Give a moment after the pointer or focus leaves, rather than vanishing instantly.
        resumeTimer() {
            if (this.show && this.expired && !this.hovered && !this.focused) this.scheduleHide(2000);
        },
        onFocusOut(e) {
            if (e.currentTarget && e.currentTarget.contains(e.relatedTarget)) return;
            this.focused = false;
            this.resumeTimer();
        },
        runAction() {
            const fn = this.action;
            this.hide();
            if (typeof fn === 'function') fn();
        },
        hide() {
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            this.show = false;
            this.hovered = false;
            this.focused = false;
            this.expired = false;
            this.actionLabel = '';
            this.action = null;
        }
    }
};
