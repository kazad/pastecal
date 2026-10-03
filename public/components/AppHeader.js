// AppHeader -- the ONE header, for every width and both apps (Syncfusion and nativecal).
//
// Why one: there used to be two hand-maintained header trees in each index.html, a phone
// one and a desktop one, each choosing its controls with its own booleans. They drifted:
// the phone tree showed the Claim bar on /view/ links (it tested !isExisting, which the
// read-only path never sets), so a viewer could "claim" -- copy into an editable calendar
// -- someone else's calendar, and it hid the share button there. Every control below now
// reads ONE value, app.pageMode ('loading' | 'new' | 'editable' | 'view', from
// CalendarFlow), and the layout differences are CSS breakpoints, not separate markup.
//
// The header is a view of the app's state: it reads and calls the root component (the app
// owns the calendar, panels and dialogs), so there is no prop plumbing to drift either.
// Uses on the root: pageMode, calendar, editTitle, isLoading, recentCalendars,
// showRecents, showMobileMenu, headerLink, slugMessage, claimBusy, viewLoadProblem,
// justCreated, lastEditLabel/lastEditExact (optional), and the toggle*/claim methods.
const AppHeader = {
    name: 'AppHeader',
    components: {
        'calendar-title': CalendarTitle,
        'navigation-dropdown': NavigationDropdown,
        'quick-add-button': QuickAddButton,
        'icon': Icon,
    },
    directives: { 'click-outside': clickOutside },
    data() {
        return {
            narrow: false,
            copied: false,
            copiedTimer: null,
        };
    },
    computed: {
        app() { return this.$root; },
        mode() { return this.app.pageMode; },
        canEdit() { return this.mode === 'new' || this.mode === 'editable'; },
    },
    mounted() {
        // One header at every width; only the title's type size needs to know which.
        this._mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 767px)') : null;
        const sync = () => { this.narrow = !!(this._mq && this._mq.matches); };
        sync();
        if (this._mq) {
            this._onMq = sync;
            if (this._mq.addEventListener) this._mq.addEventListener('change', sync);
            else if (this._mq.addListener) this._mq.addListener(sync);
        }
    },
    beforeUnmount() {
        clearTimeout(this.copiedTimer);
        if (this._mq && this._onMq) {
            if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
            else if (this._mq.removeListener) this._mq.removeListener(this._onMq);
        }
    },
    methods: {
        quickAdd() {
            const d = this.app.$refs && this.app.$refs.quickAddDialog;
            if (d && typeof d.showDialog === 'function') d.showDialog();
        },
        /**
         * The pill copies exactly the link it shows (CalendarFlow headerLink): the
         * view-only link whenever one exists. Tagged 'pill' so this path stays separable
         * from the share panel's own copy buttons in analytics.
         */
        async copyHeaderLink() {
            const link = this.app.headerLink;
            if (!link || !link.name) return;
            const url = `${window.location.origin}/${link.kind === 'view' ? 'view/' : ''}${link.name}`;
            try { if (window.Analytics) window.Analytics.calendarShared('pill'); } catch (e) { /* observational */ }
            let ok = false;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(url);
                    ok = true;
                }
            } catch (e) { /* legacy path below */ }
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
            if (!ok) { this.app.showToast('Could not copy the link', 'error'); return; }
            this.copied = true;
            clearTimeout(this.copiedTimer);
            this.copiedTimer = setTimeout(() => { this.copied = false; }, 1600);
            this.app.showToast(CalendarFlow.copyToast(link.kind), link.kind === 'view' ? 'success' : 'info');
        },
        openShareFromNotice() {
            this.app.justCreated = false;
            if (!this.app.showShare) this.app.toggleShare();
        },
    },
    template: /* html */ `
        <header class="mb-2 md:mb-0 pb-1 md:pb-3 pt-2 md:pt-0 text-sm" data-testid="app-header" :data-mode="mode">
            <div class="flex flex-wrap md:flex-nowrap items-center justify-between gap-x-2 gap-y-2">

                <!-- Logo, recents, and (wide screens) the tool buttons -->
                <div class="flex items-center gap-1 flex-shrink-0 md:flex-1 min-w-0">
                    <div class="relative z-40" v-click-outside="app.closeRecents"
                        @mouseenter="app.handleDropdownMouseEnter" @mouseleave="app.handleDropdownMouseLeave"
                        @keydown.esc="app.closeRecents()">
                        <button type="button" @click.stop="narrow ? app.toggleRecents() : app.openRecents()"
                            class="flex items-center gap-1.5 group" aria-haspopup="true"
                            :aria-expanded="app.showRecents ? 'true' : 'false'" aria-label="PasteCal: recent calendars"
                            data-testid="recents-button">
                            <img class="h-8 w-8 flex-shrink-0 dark:brightness-150" src="/img/pastecal.logo.svg" alt="">
                            <span class="flex flex-col items-start">
                                <span class="text-blue-500 font-medium text-sm group-hover:text-blue-600 transition-colors">pastecal</span>
                                <span class="text-color-1 hidden lg:block -mt-0.5 text-[10px]">no-login shared calendar</span>
                            </span>
                            <icon name="chevronDown" viewBox="0 0 16 16" fill="currentColor" class="w-3 h-3 text-color-1"></icon>
                        </button>
                        <navigation-dropdown v-if="app.showRecents" :recent-calendars="app.recentCalendars"
                            @go-homepage="app.goToHomepage" @toggle-pin="app.togglePin" @remove-recent="app.removeRecent">
                        </navigation-dropdown>
                    </div>

                    <div class="hidden md:flex items-center gap-0.5 ml-1">
                        <button type="button" @click="app.toggleHelp()" aria-label="Show help" title="Help"
                            class="text-color-1 hover:text-blue-500 p-1.5 rounded-full transition-colors">
                            <icon name="help" class="w-5 h-5"></icon>
                        </button>
                        <button type="button" @click="app.toggleSearch()" aria-label="Search events" title="Search events"
                            data-testid="search-button-desktop"
                            class="text-color-1 hover:text-blue-500 p-1.5 rounded-full transition-colors">
                            <icon name="search" class="w-5 h-5"></icon>
                        </button>
                        <button type="button" @click="app.toggleSettings()" aria-label="Settings" title="Settings"
                            data-testid="settings-button-desktop"
                            class="text-color-1 hover:text-blue-500 p-1.5 rounded-full transition-colors">
                            <icon name="settings" class="w-5 h-5"></icon>
                        </button>
                        <quick-add-button v-if="canEdit" class="block" @open="quickAdd"
                            aria-label="Quick add event"></quick-add-button>
                    </div>
                </div>

                <!-- Title and notes -->
                <div class="flex flex-1 items-center justify-center gap-1 min-w-0" data-testid="desktop-title-area">
                    <calendar-title v-if="mode !== 'loading'" :title="app.calendar.title" :is-editing="app.editTitle"
                        :is-read-only="mode === 'view'" :mode="narrow ? 'mobile' : 'desktop'"
                        class="min-w-0 max-w-[60vw] md:max-w-xs overflow-hidden"
                        :title-attr="mode === 'view' ? '' : 'Click to edit title'"
                        @update:title="app.calendar.title = $event" @click="app.editTitle = true"
                        @blur="app.editTitle = false" @enter="app.setTitle()">
                    </calendar-title>
                    <button v-if="!app.editTitle && mode !== 'loading'" type="button" @click="app.toggleNotes()"
                        aria-label="Toggle notes" title="Notes"
                        class="text-color-1 hover:text-blue-500 p-1 rounded-full transition-colors flex items-center flex-shrink-0">
                        <icon name="notes" class="w-5 h-5"></icon>
                        <span class="ml-0.5 text-xs hidden lg:inline">Notes</span>
                    </button>
                </div>

                <!-- Right: what this page IS (loading / view only / the link) and phone menus -->
                <div class="flex items-center justify-end gap-1 flex-shrink-0 md:flex-1 min-w-0 text-xs">
                    <button v-if="mode === 'editable' && app.lastEditLabel" type="button" @click="app.openRecentChanges()"
                        data-testid="last-edit-link" :title="'Calendar edited ' + (app.lastEditExact || '')"
                        class="text-color-1 hover:text-blue-500 text-xs whitespace-nowrap mr-2 transition-colors hidden lg:inline-flex items-center">
                        {{ app.lastEditLabel }}
                    </button>

                    <span v-if="mode === 'loading'" class="pc-chip text-color-1" role="status">Loading...</span>

                    <button v-if="mode === 'view'" type="button" @click="app.toggleShare()" class="pc-chip hover:border-blue-500"
                        data-testid="share-pill-readonly" aria-label="View only. Open sharing and subscribe options"
                        title="You can see this calendar but not change it. Click to subscribe or share.">
                        <icon name="share" class="w-4 h-4"></icon> View only
                    </button>

                    <!-- Editable, wide screens: copy the link it shows; chevron opens the rest. -->
                    <div v-if="mode === 'editable'" role="button" tabindex="0"
                        class="relative hidden md:flex items-center bg-1 border border-color-default rounded-full p-1 pl-3 pr-3 shadow-sm hover:border-blue-500 hover:bg-[var(--bg-interactive-hover)] cursor-pointer transition-all group select-none min-w-0"
                        @click="copyHeaderLink" @keyup.enter="copyHeaderLink" @keyup.space="copyHeaderLink"
                        :aria-label="copied ? 'Link copied' : (app.headerLink.kind === 'view' ? 'Copy view-only link' : 'Copy edit link')"
                        :title="app.headerLink.kind === 'view' ? 'Copies the view-only link' : 'Copies the edit link: anyone with it can change events'"
                        data-testid="share-pill-existing">
                        <span class="transition-colors flex-shrink-0 p-1 rounded-full mr-1"
                            :class="copied ? 'text-green-600' : 'text-color-1 group-hover:text-blue-500'">
                            <icon :name="copied ? 'check' : 'copy'" class="w-5 h-5"></icon>
                        </span>
                        <span v-if="copied" class="text-green-600 text-xs font-bold whitespace-nowrap"
                            data-testid="share-pill-copied">Link copied</span>
                        <span v-else class="text-color-1 text-xs truncate max-w-[150px] md:max-w-xs" data-testid="share-pill-url">
                            {{ app.headerLink.prefix }}<span class="font-bold text-color-2">{{ app.headerLink.name }}</span>
                        </span>
                        <button type="button" @click.stop="app.toggleShare()" aria-label="More sharing options"
                            data-testid="share-pill-more"
                            class="flex items-center flex-shrink-0 ml-2 pl-2 border-l border-color-default text-color-1 hover:text-blue-500 transition-colors">
                            <icon name="chevronDown" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5"></icon>
                        </button>
                    </div>

                    <!-- Phones: share is one icon (the URL would not fit). -->
                    <button v-if="mode === 'editable'" type="button" @click="app.toggleShare()" aria-label="Share calendar"
                        data-testid="share-button-mobile" class="md:hidden p-1 text-color-1 hover:text-blue-500">
                        <icon name="share" class="w-5 h-5"></icon>
                    </button>

                    <div class="relative z-40 md:hidden" v-click-outside="() => app.showMobileMenu = false">
                        <button type="button" @click.stop="app.showMobileMenu = !app.showMobileMenu" aria-label="Open menu"
                            :aria-expanded="app.showMobileMenu ? 'true' : 'false'" class="p-1 text-color-1 hover:text-blue-500">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24"
                                stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round"
                                    d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
                            </svg>
                        </button>
                        <div v-if="app.showMobileMenu"
                            class="absolute right-0 top-full mt-2 w-48 bg-1 rounded-lg shadow-xl border border-color-default py-1 text-sm text-color-2 z-50">
                            <button type="button" @click="app.showMobileMenu = false; app.toggleSearch()" data-testid="search-button-mobile"
                                class="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <icon name="search" class="w-5 h-5"></icon> Search
                            </button>
                            <button v-if="canEdit" type="button" @click="app.showMobileMenu = false; quickAdd()"
                                class="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <span class="text-lg leading-none font-bold text-blue-500">+</span> Quick Add Event
                            </button>
                            <button v-if="mode === 'view'" type="button" @click="app.showMobileMenu = false; app.toggleShare()"
                                class="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <icon name="share" class="w-5 h-5"></icon> Share &amp; subscribe
                            </button>
                            <button type="button" @click="app.showMobileMenu = false; app.toggleSettings()" data-testid="settings-button-mobile"
                                class="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <icon name="settings" class="w-5 h-5"></icon> Settings
                            </button>
                            <button type="button" @click="app.showMobileMenu = false; app.toggleHelp()"
                                class="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <icon name="help" class="w-5 h-5"></icon> Help
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Claim: only for an unsaved draft. Its own row on phones, the right end on wide screens. -->
                <div v-if="mode === 'new'" class="basis-full md:basis-auto order-last md:order-none flex flex-col md:items-end min-w-0"
                    data-testid="claim-bar">
                    <form class="flex items-center bg-1 border border-color-default rounded-lg md:rounded-full p-1.5 md:p-1 md:pl-3 shadow-sm focus-within:border-blue-500 transition-all min-w-0"
                        :class="{ 'pc-input-group-invalid': app.slugMessage }" @submit.prevent="app.startClaim()" novalidate>
                        <label for="slug" class="text-color-1 text-sm font-medium flex-shrink-0 pl-1 md:pl-0">pastecal.com/</label>
                        <input id="slug" type="text" :value="app.calendar.id" @input="app.onSlugInput($event)"
                            class="flex-1 md:flex-none bg-transparent border-none focus:ring-0 p-1 md:p-0 text-sm font-bold text-color-2 w-auto md:w-40 min-w-0 focus:outline-none"
                            placeholder="your-name" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="60"
                            :aria-invalid="app.slugMessage ? 'true' : 'false'" aria-describedby="slug-message">
                        <button type="submit" :disabled="app.claimBusy"
                            class="ml-1 px-3 py-1.5 text-white bg-blue-600 font-bold rounded-md md:rounded-full text-xs hover:bg-blue-700 transition-colors flex-shrink-0 shadow-sm disabled:opacity-60">
                            <span class="hidden sm:inline">Claim URL</span><span class="sm:hidden">Claim</span>
                        </button>
                    </form>
                    <p id="slug-message" class="text-xs mt-1 px-1" aria-live="polite"
                        :class="app.slugMessage ? 'pc-text-danger font-medium' : 'sr-only'" data-testid="slug-message">
                        {{ app.slugMessage || 'Anyone with the link can view and edit.' }}
                    </p>
                </div>
            </div>

            <!-- What this page is, in words: shown under the header at every width. -->
            <div v-if="mode === 'view' && app.viewLoadProblem" role="alert" data-testid="view-problem"
                class="mt-2 px-3 py-3 rounded-sm border border-color-default bg-2 text-sm">
                <p class="font-semibold text-color-2">{{ app.viewLoadProblem.title }}</p>
                <p class="text-color-1 mt-0.5">{{ app.viewLoadProblem.message }}</p>
                <p class="mt-2"><a href="/" class="font-medium hover:underline" style="color: var(--link);">Make your own calendar</a></p>
            </div>
            <p v-else-if="mode === 'view'" class="mt-1 text-xs text-color-1" data-testid="view-only-banner">
                <strong class="text-color-2">View only</strong> &mdash; ask the owner for the edit link to make changes.
            </p>

            <div v-if="mode === 'editable' && app.justCreated" role="status" data-testid="created-notice"
                class="mt-2 px-3 py-2 rounded-sm border border-color-default bg-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="text-color-2"><strong>Calendar created.</strong> Next, share it with your group.</span>
                <button type="button" @click="openShareFromNotice" class="pc-btn pc-btn-primary pc-btn-sm"
                    data-testid="created-share">Share this calendar</button>
                <button type="button" @click="app.justCreated = false" aria-label="Dismiss"
                    class="ml-auto text-color-1 hover:text-blue-500 p-1">
                    <icon name="close" class="w-4 h-4"></icon>
                </button>
            </div>
        </header>
    `,
};

if (typeof window !== 'undefined') window.AppHeader = AppHeader;
