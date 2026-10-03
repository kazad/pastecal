// SharePanel -- every link to this calendar, safest first. Shared by both apps.
//
// The old "Sharing & Security" grid opened on the EDIT link, styled exactly like the
// view link beside it, and offered a "Feed URL (full access)" -- a subscription URL that
// is the edit link with .ics on the end, so pasting it into a calendar app or a group chat
// handed out write access. "Current view" was built from the edit link too. The link
// that grants edit access is the one thing here that cannot be taken back, so:
//   - the view-only link comes first and is the primary action;
//   - the edit link comes last, styled as a warning, and says what it grants;
//   - every other link (current view, subscriptions) is built from the view-only link;
//   - there is no edit feed at all.
// A /view/ visitor sees the same panel minus the edit link.
//
// Customizing the view-only link REPLACES it (createPublicLink retires the old one):
// the old link used to stay live forever as a frozen copy nobody could list or revoke.
// The form says so before anyone confirms.
const SharePanel = {
    name: 'SharePanel',
    // The app registers its components locally, so a child has to name its own.
    components: { icon: typeof Icon !== 'undefined' ? Icon : {} },
    props: {
        calendar: { type: Object, required: true },
        mode: { type: String, required: true },          // CalendarFlow page mode
        currentViewUrl: { type: String, default: '' },  // built from the view-only link
    },
    emits: ['toast'],
    data() {
        return {
            customizing: false,
            customSlug: '',
            customError: '',
            customBusy: false,
            copied: '',   // which link last copied, for the button's own feedback
            copiedTimer: null,
        };
    },
    computed: {
        canEdit() { return this.mode === 'editable'; },
        viewSlug() {
            return SlugManager.getReadOnlySlug(this.calendar)
                || (this.mode === 'view' ? SlugManager._slugFromLocation() : null);
        },
        viewURL() { return this.viewSlug ? `${window.location.origin}/view/${this.viewSlug}` : null; },
        viewICS() { return this.viewSlug ? `${window.location.origin}/view/${this.viewSlug}.ics` : null; },
        // Owner-only, and null anywhere else so a forgotten v-if can never leak it.
        editURL() { return this.canEdit && this.calendar.id ? `${window.location.origin}/${this.calendar.id}` : null; },
        webcalURL() { return this.viewICS ? this.viewICS.replace(/^https?:\/\//, 'webcal://') : null; },
        googleURL() {
            return this.webcalURL ? 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(this.webcalURL) : null;
        },
        outlookURL() {
            return this.viewICS ? 'https://outlook.live.com/calendar/0/addfromweb?url='
                + encodeURIComponent(this.viewICS) + '&name=' + encodeURIComponent(this.calendar.title || 'PasteCal') : null;
        },
        customCheck() {
            return SlugRules.check(this.customSlug);
        },
        customMessage() {
            if (this.customError) return this.customError;
            return this.customSlug && !this.customCheck.ok ? this.customCheck.message : '';
        },
        // A live example (today, this link) rather than a fixed 2024 date.
        exampleParams() {
            const d = new Date();
            const ymd = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
            return "?date=" + ymd + "&view=week";
        },
        canNativeShare() { return typeof navigator !== 'undefined' && !!navigator.share; },
    },
    beforeUnmount() { clearTimeout(this.copiedTimer); },
    methods: {
        track(method) {
            try { if (window.Analytics) window.Analytics.calendarShared(method); } catch (e) { /* observational */ }
        },
        async copy(url, kind, method) {
            if (!url) { this.$emit('toast', 'Nothing to copy yet', 'error'); return; }
            this.track(method);
            let ok = false;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(url);
                    ok = true;
                }
            } catch (e) { /* fall through to the legacy path */ }
            if (!ok) {
                try {
                    const el = document.createElement('textarea');
                    el.value = url;
                    el.setAttribute('readonly', '');
                    el.style.position = 'fixed';
                    el.style.opacity = '0';
                    document.body.appendChild(el);
                    el.select();
                    ok = document.execCommand('copy');
                    document.body.removeChild(el);
                } catch (e) { ok = false; }
            }
            if (!ok) { this.$emit('toast', 'Could not copy the link', 'error'); return; }
            this.copied = kind;
            clearTimeout(this.copiedTimer);
            this.copiedTimer = setTimeout(() => { this.copied = ''; }, 1600);
            this.$emit('toast', CalendarFlow.copyToast(kind), kind === 'edit' ? 'info' : 'success');
        },
        nativeShare(url, title) {
            if (!url || !navigator.share) return;
            navigator.share({ title, url }).then(() => this.track('native')).catch(() => {});
        },
        onCustomInput(e) {
            const slug = SlugRules.slugify(e.target.value);
            this.customSlug = slug;
            if (e.target.value !== slug) e.target.value = slug;
            this.customError = '';
        },
        toggleCustomize() {
            this.customizing = !this.customizing;
            this.customSlug = '';
            this.customError = '';
        },
        async saveCustom() {
            const slug = SlugRules.slugify(this.customSlug, { final: true });
            this.customSlug = slug;
            if (!this.customCheck.ok) { this.customError = this.customCheck.message; return; }
            if (slug === this.viewSlug) { this.customError = 'That is already the link.'; return; }
            this.customBusy = true;
            try {
                await SlugManager.customizeReadOnlyLink(this.calendar, slug);
                this.customizing = false;
                this.customSlug = '';
                this.$emit('toast', `View-only link is now pastecal.com/view/${slug}`, 'success');
            } catch (error) {
                this.customError = (error && error.code && /already-exists/.test(error.code))
                    ? `pastecal.com/view/${slug} is taken. Try another name.`
                    : (error && error.message) || 'Could not change the link. Please try again.';
            } finally {
                this.customBusy = false;
            }
        },
    },
    template: /* html */ `
        <div class="p-2.5 text-sm w-full" data-testid="share-panel">
            <h2 class="text-lg font-bold mb-4">Share</h2>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

                <!-- View-only link: first, and the primary action. -->
                <section class="bg-1 p-4 rounded-lg shadow-sm pc-card-primary" data-testid="share-view-card">
                    <h3 class="font-semibold mb-1 flex items-center gap-2">
                        <span>View-only link</span>
                        <span v-if="canEdit" class="pc-chip">Recommended</span>
                    </h3>
                    <p class="text-xs text-color-1 mb-3">
                        People with this link can see events and subscribe, but can't change anything.
                    </p>
                    <div v-if="viewURL" class="flex gap-2">
                        <input type="text" :value="viewURL" readonly aria-label="View-only link"
                            class="flex-1 min-w-0 p-2 border border-color-default rounded bg-disabled text-sm"
                            @focus="$event.target.select()" data-testid="share-view-url">
                        <button type="button" @click="copy(viewURL, 'view', 'copy')" class="pc-btn pc-btn-primary"
                            data-testid="share-copy-view">
                            <icon :name="copied === 'view' ? 'check' : 'copy'" class="h-4 w-4"></icon>
                            <span>{{ copied === 'view' ? 'Copied' : 'Copy' }}</span>
                        </button>
                        <button v-if="canNativeShare" type="button" @click="nativeShare(viewURL, calendar.title || 'Calendar')"
                            class="pc-btn pc-btn-secondary" aria-label="Share view-only link">
                            <icon name="share" class="h-4 w-4"></icon>
                        </button>
                    </div>
                    <p v-else class="text-xs text-color-1 italic" data-testid="share-view-pending">Creating the view-only link...</p>

                    <div v-if="canEdit && viewURL" class="mt-3">
                        <button type="button" @click="toggleCustomize" class="text-xs hover:underline" style="color: var(--link);"
                            :aria-expanded="customizing ? 'true' : 'false'">
                            {{ customizing ? 'Cancel' : 'Change link name' }}
                        </button>
                        <form v-if="customizing" class="mt-2" @submit.prevent="saveCustom" novalidate>
                            <label for="share-custom-slug" class="block text-xs font-medium text-color-2 mb-1">New name</label>
                            <div class="pc-input-group" :class="{ 'pc-input-group-invalid': customMessage }">
                                <span class="pc-input-prefix">/view/</span>
                                <input id="share-custom-slug" type="text" :value="customSlug" @input="onCustomInput"
                                    class="pc-input" placeholder="team-schedule" autocomplete="off" autocapitalize="none"
                                    spellcheck="false" :aria-invalid="customMessage ? 'true' : 'false'"
                                    aria-describedby="share-custom-help" data-testid="share-custom-slug">
                            </div>
                            <p id="share-custom-help" class="text-xs mt-1" aria-live="polite"
                                :class="customMessage ? 'pc-text-danger font-medium' : 'text-color-1'">
                                {{ customMessage || ('pastecal.com/view/' + viewSlug + ' will stop working.') }}
                            </p>
                            <button type="submit" :disabled="customBusy || !customSlug" class="pc-btn pc-btn-secondary pc-btn-sm mt-2"
                                data-testid="share-custom-save">
                                {{ customBusy ? 'Saving...' : 'Replace link' }}
                            </button>
                        </form>
                    </div>
                </section>

                <!-- Subscribe: always the view-only feed, so subscribing never spreads edit access. -->
                <section class="bg-1 p-4 rounded-lg shadow-sm border border-color-default">
                    <h3 class="font-semibold mb-1">On your phone</h3>
                    <p class="text-xs text-color-1 mb-3">
                        Subscribe once and new events appear automatically. Nothing to install.
                    </p>
                    <template v-if="webcalURL">
                        <a :href="webcalURL" @click="track('subscribe')" data-testid="subscribe-webcal"
                            class="block w-full text-center px-4 py-2.5 mb-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors no-underline">
                            Subscribe to this calendar
                            <span class="block text-xs font-normal opacity-90">Opens your default calendar app</span>
                        </a>
                        <!-- webcal:// does nothing when no app handles it: these are load-bearing. -->
                        <div class="flex gap-2 mb-3">
                            <a :href="googleURL" target="_blank" rel="noopener" @click="track('subscribe_google')"
                                data-testid="subscribe-google"
                                class="flex-1 text-center px-2 py-1.5 text-xs font-semibold rounded border border-color-default text-color-1 hover:border-blue-500 hover:text-blue-500 transition-colors no-underline">Google</a>
                            <a :href="outlookURL" target="_blank" rel="noopener" @click="track('subscribe_outlook')"
                                data-testid="subscribe-outlook"
                                class="flex-1 text-center px-2 py-1.5 text-xs font-semibold rounded border border-color-default text-color-1 hover:border-blue-500 hover:text-blue-500 transition-colors no-underline">Outlook</a>
                            <a :href="webcalURL" @click="track('subscribe_apple')" data-testid="subscribe-apple"
                                class="flex-1 text-center px-2 py-1.5 text-xs font-semibold rounded border border-color-default text-color-1 hover:border-blue-500 hover:text-blue-500 transition-colors no-underline">Apple</a>
                        </div>
                        <label for="share-feed-url" class="block text-xs font-medium text-color-2 mb-1">Feed URL (view only)</label>
                        <div class="flex gap-2">
                            <input id="share-feed-url" type="text" :value="viewICS" readonly
                                class="flex-1 min-w-0 p-2 border border-color-default rounded bg-disabled text-sm"
                                @focus="$event.target.select()">
                            <button type="button" @click="copy(viewICS, 'feed', 'ics')" class="pc-btn pc-btn-secondary">
                                <icon :name="copied === 'feed' ? 'check' : 'copy'" class="h-4 w-4"></icon>
                                <span>{{ copied === 'feed' ? 'Copied' : 'Copy' }}</span>
                            </button>
                        </div>
                    </template>
                    <p v-else class="text-xs text-color-1 italic">Available once the view-only link is ready.</p>
                </section>

                <!-- This date and view, as a view-only link. -->
                <section class="bg-1 p-4 rounded-lg shadow-sm border border-color-default">
                    <h3 class="font-semibold mb-1">Link to this view</h3>
                    <p class="text-xs text-color-1 mb-3">
                        Opens the dates and view on screen now, view only. Or add
                        <code class="bg-disabled px-1 py-0.5 rounded text-xs">{{ exampleParams }}</code>
                        to any link.
                    </p>
                    <div v-if="currentViewUrl" class="flex gap-2">
                        <input type="text" :value="currentViewUrl" readonly aria-label="Link to this view"
                            class="flex-1 min-w-0 p-2 border border-color-default rounded bg-disabled text-sm"
                            @focus="$event.target.select()">
                        <button type="button" @click="copy(currentViewUrl, 'current', 'copy')" class="pc-btn pc-btn-secondary">
                            <icon :name="copied === 'current' ? 'check' : 'copy'" class="h-4 w-4"></icon>
                            <span>{{ copied === 'current' ? 'Copied' : 'Copy' }}</span>
                        </button>
                    </div>
                    <p v-else class="text-xs text-color-1 italic">Available once the view-only link is ready.</p>
                </section>

                <!-- Edit link: last, and a warning. -->
                <section v-if="canEdit && editURL" class="p-4 rounded-lg shadow-sm pc-card-warning" data-testid="share-edit-card">
                    <h3 class="font-semibold mb-1 pc-text-warning">Edit link</h3>
                    <p class="text-xs mb-3 pc-text-warning font-medium" data-testid="share-edit-warning">
                        Anyone with this link can change or delete events. Share it only with people you trust to edit.
                    </p>
                    <div class="flex gap-2">
                        <input type="text" :value="editURL" readonly aria-label="Edit link"
                            class="flex-1 min-w-0 p-2 border border-color-default rounded bg-1 text-sm"
                            @focus="$event.target.select()" data-testid="share-edit-url">
                        <button type="button" @click="copy(editURL, 'edit', 'copy')" class="pc-btn pc-btn-secondary"
                            data-testid="share-copy-edit">
                            <icon :name="copied === 'edit' ? 'check' : 'copy'" class="h-4 w-4"></icon>
                            <span>{{ copied === 'edit' ? 'Copied' : 'Copy' }}</span>
                        </button>
                    </div>
                </section>
            </div>
        </div>
    `,
};

if (typeof window !== 'undefined') window.SharePanel = SharePanel;
