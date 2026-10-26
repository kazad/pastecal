// ToastNotification Component
// Displays toast messages with success/error/info types

const ToastNotification = {
    // Screen readers hear a toast through the page's one live region (Utils.announce, in display()): a region of its
    // own here would say every message twice, and copy and the save status use the same one.
    template: /* html */ `
        <div>
        <transition 
            enter-active-class="transform ease-out duration-300 transition"
            enter-from-class="translate-y-2 opacity-0 sm:translate-y-0 sm:translate-x-2"
            enter-to-class="translate-y-0 opacity-100 sm:translate-x-0"
            leave-active-class="transition ease-in duration-100"
            leave-from-class="opacity-100"
            leave-to-class="opacity-0">
            <div v-if="show" class="pc-toast-wrap fixed bottom-4 left-1/2 transform -translate-x-1/2 z-[100] w-full max-w-md px-4 flex justify-center pointer-events-none"
                :style="at" @mouseenter="hovered = true" @mouseleave="hovered = false; resumeTimer()"
                @focusin="focused = true" @focusout="onFocusOut">
                <!-- One row, like Gmail's snackbar: the message, the action beside it, close. An icon only
                     for errors, where it carries meaning. -->
                <div class="pc-toast" :class="'pc-toast--' + type">
                    <svg v-if="type === 'error'" class="pc-toast-ico" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <!-- An event's name in quotes stays on one line, ending in … (Deleted "Quarterly plan…"). -->
                    <p v-if="named" class="pc-toast-msg pc-toast-named"><span>{{ named[0] }}</span><span class="pc-toast-name">{{ named[1] }}</span><span>{{ named[2] }}</span></p>
                    <p v-else class="pc-toast-msg">{{ message }}</p>
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
            expired: false,
            at: null   // where it sits while an event card is open (place)
        }
    },
    computed: {
        /** [before, name, after] for a message that ends with a quoted name: Deleted "Practice". */
        named() {
            const m = /^([^"“”]{1,40}["“])([^"“”]+)(["”][.!]?)$/.exec(this.message || '');
            return m ? [m[1], m[2], m[3]] : null;
        }
    },
    mounted() {
        this._onCard = () => { if (this.show) this.$nextTick(() => this.place()); };
        window.addEventListener('nk-card-moved', this._onCard);
    },
    beforeUnmount() { clearInterval(this.placeTimer); window.removeEventListener('nk-card-moved', this._onCard); },
    methods: {
        /**
         * Never over the controls of what is open: the event card (nativecal EventCard: a sheet along a phone's bottom,
         * or a card beside its event) or any dialog (the ? sheet's Done sat under it in a short window; it used to look
         * for the card alone). At the bottom as usual, else at the top, else beside the card or dialog, else where it
         * covers the least. Checked when the card says it moved (EventCard 'nk-card-moved') and every 150 ms while it shows.
         */
        place() {
            const wrap = this.$el && this.$el.querySelector ? this.$el.querySelector('.pc-toast-wrap') : null;
            // What it must not cover: the event card, and any dialog (pastecal's, quick add, Syncfusion's editor and popup).
            const open = [...document.querySelectorAll('.nk-card, [aria-modal="true"], .pc-modal-panel, .pc-qa-dialog, .e-schedule-dialog.e-popup-open, .e-quick-popup-wrapper.e-popup-open')].filter((e) => e.getClientRects().length && !e.contains(wrap));
            const card = open[open.length - 1];
            if (!wrap || !card) { if (this.at) this.at = null; return; }
            const t = wrap.querySelector('.pc-toast');
            if (!t) return;
            const r = t.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight, w = r.width, h = r.height, gap = 12;
            // Where the page puts it (centered, or beside the side panel), from the layout: it may be mid-slide.
            if (!this.at || !this.at.left) this._x = wrap.offsetLeft - w / 2;
            const c = card.getBoundingClientRect(), low = H - 16 - h;
            // The controls as seen: a card or dialog that scrolls inside clips them to its own box.
            const controls = open.flatMap((o) => { const oc = o.getBoundingClientRect(); return [...o.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')].map((e) => e.getBoundingClientRect())
                .map((b) => ({ left: Math.max(b.left, oc.left), right: Math.min(b.right, oc.right), top: Math.max(b.top, oc.top), bottom: Math.min(b.bottom, oc.bottom) })); })
                .filter((b) => b.right > b.left && b.bottom > b.top);
            const covers = (x, y, ww) => controls.reduce((sum, b) => sum
                + Math.max(0, Math.min(x + ww, b.right) - Math.max(x, b.left)) * Math.max(0, Math.min(y + h, b.bottom) - Math.max(y, b.top)), 0);
            const spots = [{ x: this._x, y: low, w, style: null }, { x: this._x, y: gap, w, style: { top: `${gap}px`, bottom: 'auto' } }];
            // Beside the card (the wrap has 16px of padding each side).
            const right = W - gap - c.right - gap, left = c.left - 2 * gap;
            if (right >= 200) spots.push({ x: c.right + gap, y: low, w: Math.min(w, right), style: { left: `${c.right + gap - 16}px`, width: `${Math.min(w, right) + 32}px`, transform: 'none' } });
            if (left >= 200) spots.push({ x: gap, y: low, w: Math.min(w, left), style: { left: `${gap - 16}px`, width: `${Math.min(w, left) + 32}px`, transform: 'none' } });
            let best = spots[0], least = Infinity;
            for (const s of spots) {
                const o = covers(s.x, s.y, s.w);
                if (o < least) { least = o; best = s; }
                if (!o) break;
            }
            if (JSON.stringify(best.style) !== JSON.stringify(this.at)) this.at = best.style;
        },
        /**
         * @param options.actionLabel  text for an inline action button, e.g. "Undo"
         * @param options.action       called when it is pressed
         * @param options.duration     ms before auto-hide; an actionable toast stays
         *                             longer, since 3s is not enough to read a message
         *                             AND decide to act on it.
         */
        display(message, type = 'info', options = {}) {
            this.message = message;
            try { if (window.Utils && typeof Utils.announce === 'function') Utils.announce(message); } catch (e) { /* never in the way of the toast */ }
            this.type = type;
            this.actionLabel = options.actionLabel || '';
            this.action = options.action || null;
            this.show = true;
            this.expired = false;
            clearInterval(this.placeTimer);
            this.$nextTick(() => this.place());
            this.placeTimer = setInterval(() => this.place(), 150);
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
            clearInterval(this.placeTimer);
            this.at = null;
            this.hovered = false;
            this.focused = false;
            this.expired = false;
            this.actionLabel = '';
            this.action = null;
        }
    }
};
