// CopyIcon and SettingsIcon already defined above, no need to redeclare

/**
 * Null-safe analytics. `track(fn)` runs `fn` against the Analytics module if it
 * loaded, and does nothing at all if it didn't.
 *
 * analytics.js is a separate <script>: a CDN hiccup, an ad blocker, or a corrupt
 * response leaves the global undefined, and a bare `Analytics.foo()` call site
 * then throws a ReferenceError that takes the whole calendar down with it. The
 * module promises internally that "a broken sink must not affect a single
 * calendar operation" -- this extends that promise to the module not existing.
 * See test/e2e/analytics-failsafe.spec.js.
 */
function track(fn) {
    try {
        if (typeof Analytics === 'undefined' || !Analytics) return;
        fn(Analytics);
    } catch (err) {
        /* observational only: never surface, never rethrow */
    }
}

// Report uncaught errors and rejected promises.
//
// Until now nothing did. A JS error that broke saving, rendering, or the editor was
// visible only in the user's own devtools, so the app could be failing for a whole
// class of browser and the first signal would be someone filing an issue -- which is
// exactly how #41 was found, months after it started.
//
// Registered at load rather than in mounted(), so an error thrown while the app is
// still starting up is caught too. Only the message and origin are sent; never a
// calendar's contents. Deliberately passive: these listeners do not preventDefault,
// so the browser still logs everything it would have.
(function installErrorReporting() {
    if (typeof window === 'undefined') return;

    const seen = new Set();   // one report per distinct failure, not one per repaint
    // Firebase errors embed database paths, and a path names the calendar: strip the key
    // after any of our roots so a slug never rides along to analytics.
    const scrub = (m) => String(m).replace(
        /\b(calendars(?:_readonly)?|history(?:_meta)?|slug_mappings|calendar_authors)([./])[^\s.\/'"]+/g, '$1$2<id>');
    const report = (kind, message, where) => {
        try {
            message = scrub(message);
            const key = kind + '|' + message + '|' + where;
            if (seen.has(key)) return;
            if (seen.size > 20) return;   // a storm is one signal, not a thousand hits
            seen.add(key);
            track(a => a.jsError(kind, message, where));
        } catch (err) { /* reporting must never become the failure */ }
    };

    // A browser can bring back an old saved copy of the page (a restored tab) and fetch today's
    // scripts for it, because the server ignores ?v=. The old page then lacks a script this code
    // needs ("LockBadge is not defined", "slugFromPath is not a function") and the calendar never
    // opens. Before the app has mounted, such an error reloads the page once, which fetches the
    // matching copy. At most once a minute per tab, so a real bug is reported instead of looping.
    const MISSING = /is not defined|Can't find variable|is not a function|is not a constructor|undefined is not an object/i;
    const reloadIfStale = (message, where, ours) => {
        try {
            if (!ours || window.__appMounted || !MISSING.test(String(message))) return;
            const last = Number(sessionStorage.getItem('pc-stale-reload') || 0);
            if (Date.now() - last < 60000) return;
            sessionStorage.setItem('pc-stale-reload', String(Date.now()));
            track(a => a.track('stale_page_reload', { where: String(where).slice(0, 120) }));
            setTimeout(() => location.reload(), 50);   // let the report leave first
        } catch (err) { /* no storage: never risk a reload loop */ }
    };

    window.addEventListener('error', (e) => {
        const where = e.filename
            ? `${String(e.filename).split('/').pop()}:${e.lineno || 0}`
            : 'unknown';
        const message = (e.error && e.error.message) || e.message;
        report('error', message, where);
        // Only our own files: an extension's content script failing must not reload the page.
        reloadIfStale(message, where, String(e.filename || '').startsWith(location.origin + '/'));
    });
    window.pcReportError = (err, where) => {
        const message = (err && err.message) || String(err);
        report('error', message, where);
        reloadIfStale(message, where, true);
    };

    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        report('unhandledrejection', (r && (r.message || r.code)) || String(r), 'promise');
    });
})();

// ============================================================
// "Add to my calendar" on a view link: opens its add page (/view/<id>/add), which picks this
// device's calendar app and says what happens next. Mounted in both headers.
// ============================================================
// A returning viewer (2nd visit to this view link, in this browser) gets one gentle hint to subscribe.
// It shows once: subscribing, opening the page from it, or dismissing it ends it for good.
const SUB_NUDGE = { visits: 'pc_view_visits', done: 'pc_sub_nudge_done' };
const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: no hint */ } };

const AddToCalendar = {
    props: { href: String, nudgeKey: String, target: { type: String, default: '_top' } },
    emits: ['pick'],
    data() { return { nudge: false }; },
    mounted() {
        const key = this.nudgeKey;
        if (!key) return;
        const visits = readJSON(SUB_NUDGE.visits, {});
        // The header renders this twice (desktop and phone rows): count the visit once per page load.
        if (!SUB_NUDGE.counted) { SUB_NUDGE.counted = true; visits[key] = (visits[key] || 0) + 1; writeJSON(SUB_NUDGE.visits, visits); }
        if (visits[key] >= 2 && !readJSON(SUB_NUDGE.done, []).includes(key)) {
            this.nudge = true;
            if (!SUB_NUDGE.shownLogged) { SUB_NUDGE.shownLogged = true; try { window.Analytics && Analytics.track('subscribe_nudge', { action: 'shown' }); } catch (e) {} }
        }
    },
    methods: {
        pick() { this.$emit('pick', 'subscribe_page'); this.endNudge('subscribed'); },
        fromNudge() { this.endNudge('opened'); this.$emit('pick', 'subscribe_page'); window.location.href = this.href; },
        endNudge(action) {
            if (!this.nudge) return;
            this.nudge = false;
            const done = readJSON(SUB_NUDGE.done, []);
            if (!done.includes(this.nudgeKey)) writeJSON(SUB_NUDGE.done, [...done, this.nudgeKey].slice(-200));
            try { window.Analytics && Analytics.track('subscribe_nudge', { action }); } catch (e) {}
        },
    },
    template: `
        <div class="pc-addcal">
            <a class="pc-btn pc-btn--sm pc-btn--pill pc-addcal-btn" data-testid="view-add-to-cal" aria-label="Add to my calendar" :href="href" :target="target" :rel="target === '_blank' ? 'noopener' : null" @click="pick">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v5M9.5 16.5h5"/></svg>
                <span class="pc-addcal-label">Add to my calendar</span>
            </a>
            <div v-if="nudge" class="pc-addcal-nudge" role="status" data-testid="subscribe-nudge">
                <button type="button" class="pc-addcal-nudge-text" @click.stop="fromNudge">Add it to your phone calendar. Updates show up on their own.</button>
                <button type="button" class="pc-addcal-nudge-x" aria-label="Dismiss" @click.stop="endNudge('dismissed')">&times;</button>
            </div>
        </div>`,
};

// ============================================================
// "Try the new calendar (beta)": a quiet item in the line under the calendar (edit links and view links, never
// embeds or the homepage). On the classic calendar it opts this browser in; on the new one it is a small pill
// with Send feedback and Back to classic, hidden for the rest of the session by its x. It lives inside the
// footer line, not floating over the page, so it can never cover events, the filter banner or a toast, and the
// month grid's fit-to-window math (fitMonthRows) already counts its height. The app does the switching.
// ============================================================
const CalSwitch = {
    props: { native: Boolean },
    emits: ['switch', 'feedback', 'hide'],
    template: `
        <button v-if="!native" type="button" class="pc-link pc-cal-try" data-testid="try-new-cal" @click="$emit('switch', 'native')">Try the new calendar (beta)</button>
        <span v-else class="pc-cal-pill" role="group" aria-label="New calendar (beta)" data-testid="new-cal-pill">
            <span class="pc-cal-pill-name" title="You're trying the new calendar">Beta</span>
            <span class="pc-cal-pill-dot" aria-hidden="true">·</span>
            <button type="button" class="pc-link" data-testid="new-cal-feedback" aria-label="Send feedback on the new calendar" @click="$emit('feedback')">Feedback</button>
            <span class="pc-cal-pill-dot" aria-hidden="true">·</span>
            <button type="button" class="pc-link" data-testid="back-to-classic" aria-label="Back to the classic calendar" @click="$emit('switch', 'classic')">Classic</button>
            <button type="button" class="pc-btn pc-btn--ghost pc-btn--icon pc-btn--xs pc-cal-pill-x" aria-label="Hide until next visit" title="Hide until next visit" data-testid="new-cal-pill-hide" @click="$emit('hide')">&times;</button>
        </span>`,
};

// ============================================================
// COMPONENT REGISTRY
// ============================================================
// IMPORTANT: All components used in templates must be registered here!
// If you add a new component, add it to this object.
// The key is the kebab-case name used in templates (e.g., <calendar-title>)
// The value is the component object defined above (e.g., CalendarTitle)
// ============================================================
const COMPONENT_REGISTRY = {
    'calendar-title': CalendarTitle,           // Mobile & desktop title component
    'navigation-dropdown': NavigationDropdown, // Recent calendars dropdown
    'custom-tooltip': Tooltip,                 // Tooltip wrapper
    'toast-notification': ToastNotification,   // Toast messages
    'quick-add-button': QuickAddButton,        // Quick Add trigger component (button/FAB)
    'quick-add-dialog': QuickAddDialog,        // Quick Add dialog (parsing & create)
    'icon': Icon,                              // Generic Icon component
    'copy-icon': CopyIcon,                     // Copy icon SVG
    'settings-icon': SettingsIcon,             // Settings icon SVG
    'help-icon': HelpIcon,                     // Help icon SVG
    'search-icon': SearchIcon,                 // Search icon SVG
    'share-icon': ShareIcon,                   // Share icon SVG
    'notes-icon': NotesIcon,                   // Notes icon SVG
    'chevron-down-icon': ChevronDownIcon,      // Chevron down icon SVG
    'close-icon': CloseIcon,                   // Close icon SVG
    'lock-badge': LockBadge,                   // Pro lock icon + popover beside the title
    'add-to-calendar': AddToCalendar,          // View link: subscribe menu in the header
    'cal-switch': CalSwitch,                   // Footer: "Try the new calendar (beta)" / the beta pill
    'pro-panel': ProPanel,                     // Share dialog: Lock this calendar / owner panel
    'pro-beta-join': ProBetaJoin,              // "Join the beta" while billing is off (Go Pro card, Stats)
    'pro-stats': ProStats,                     // Pro owner: views, visitors, followers, places
    'pro-history': ProHistory,                 // Pro owner: saved versions, preview, restore
    // pastecal's own calendar and its event popup: loaded only on a native page (index.html, window.pcNativeCal);
    // its editor and quick box only on a native edit link (window.pcNativeEdit).
    ...(typeof NativeCalendar !== 'undefined' ? { 'native-calendar': NativeCalendar, 'event-popover': EventPopover } : {}),
    ...(typeof EventCard !== 'undefined' ? { 'event-card': EventCard } : {}),
};

// A native view link's ?view= / ?date= (the classic calendar reads the same ones in mountSyncfusion):
// { view: 'Day' | 'Week' | 'Month' | 'Custom' | 'Year' | 'Agenda' | null, date: Date | null, dur, unit }.
function nativeLinkView() {
    const out = { view: null, date: null, dur: null, unit: null };
    try {
        const q = new URL(Utils.sanitizeUrl(window.location.href.toLowerCase())).searchParams;
        out.date = Utils.parseDate(q.get('d') || q.get('date'));
        const v = (q.get('v') || q.get('view') || '').toLowerCase();
        const views = { d: 'Day', day: 'Day', w: 'Week', week: 'Week', m: 'Month', month: 'Month', y: 'Year', year: 'Year', a: 'Agenda', agenda: 'Agenda' };
        if (views[v]) out.view = views[v];
        else if (v === '12w' || v === '12weeks') Object.assign(out, { view: 'Custom', dur: 12, unit: 'Weeks' });
        else if (v === 'q' || v === 'quarter') Object.assign(out, { view: 'Custom', dur: 3, unit: 'Months' });
        else if (v === 'c' || v === 'custom') {
            out.view = 'Custom';
            const dur = parseInt(q.get('dur') || q.get('duration'), 10), unit = /^week/.test(q.get('unit') || '') ? 'Weeks' : /^month/.test(q.get('unit') || '') ? 'Months' : null;
            if (dur >= 1 && unit && dur <= (unit === 'Weeks' ? 52 : 24)) Object.assign(out, { dur, unit });
        }
    } catch (e) { /* a bad link opens the default view */ }
    return out;
}

// ---- Helpers for editing on the native calendar (app.nativeAction and friends) ----------------------------------
// The temporary Id of "this event" on a repeating series: classic's EditOccurrence record, which the store turns
// into a new row (ScheduleAdapter.toCommand adds it only when no row has this Id).
const NATIVE_OCCURRENCE_ID = '__native_occurrence__';
const isBlankId = (v) => v === undefined || v === null || v === '';
// Classic's question (Syncfusion's seriesChangeAlert) before a change to a whole series with skipped or edited dates.
const NATIVE_SERIES_CHANGE = 'Do you want to cancel the changes made to specific instances of this series and match it to the whole series again?';
// Dates of an edit on the native calendar, in the shapes classic's records carry (services/CalendarView.js).
const { endOf: nativeEnd, shiftBy: nativeShift, shiftRule: nativeShiftRule } = CalendarView.edits;

const CAL_BASE = (typeof window !== 'undefined' && window.CAL_BASE) ? window.CAL_BASE : '/';
const stripBase = (path) => {
    const base = CAL_BASE.endsWith('/') ? CAL_BASE.slice(0, -1) : CAL_BASE;
    if (base && base !== '/' && path.startsWith(base)) {
        const stripped = path.slice(base.length);
        return stripped.startsWith('/') ? stripped : `/${stripped}`;
    }
    return path;
};

// The read-only name an @link page opens (pastecal.com/@handle/<name>; Worker: cloudflare/src/Names.js), or null.
// Only on an /@ address: anywhere else the meta would be a stray copy.
function atViewSlug() {
    if (!/^\/@/.test(stripBase(window.location.pathname))) return null;
    const m = document.querySelector('meta[name="pc-view"]');
    const v = m && m.getAttribute('content');
    return v && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null;
}

const CalendarVueApp = {
    components: COMPONENT_REGISTRY,
    directives: {
        'click-outside': clickOutside
    },
    data() {
        // Normalized for the case-insensitive lookup; null for the homepage or a bad path.
        // (On /view/<x> this is "view", on /@handle/<name> "@handle": never a calendar to open, and never the homepage.)
        let urlslug = SlugManager.slugFromPath(stripBase(window.location.pathname));
        if (urlslug) urlslug = SlugManager.normalizeSlug(urlslug);

        let id = urlslug ?? Utils.randomID(10);
        let cal = new Calendar(id, "New Calendar", []);

        // Define default colors
        const DEFAULT_COLORS = [
            "#3f51b5", "#e3165b", "#d0442f", "#2e7d32",
            "#ff9800", "#03a9f4", "#757575", "#27282f"
        ];

        // Colors offered for categories 9-16, in order. Picked to stay distinguishable
        // from the first eight and from each other at event-pill size -- a random color
        // for a new category would sooner or later land next to one already in use, and
        // two events the same color is exactly the problem categories exist to solve.
        // Chosen greedily to maximise the smallest perceptual gap against the first
        // eight AND each other -- an eyeballed set put #13 crimson 22 units from #2
        // crimson, close enough that two categories looked like one, which defeats the
        // point of having them. The worst pair here is 130 apart.
        // #11 is #00836f, not #00897b: text on #00897b was 4.3:1, under the 4.5:1 minimum.
        const EXTRA_COLORS = [
            "#827717", "#c0ca33", "#00836f", "#8e24aa",
            "#880e4f", "#bf360c", "#455a64", "#00bfa5"
        ];

        // Past sixteen the swatches stop being tellable apart at the size an event
        // renders, so the picker becomes the problem the categories were meant to fix.
        const MAX_COLORS = 16;

        // COLORS will be updated based on custom colors if available
        let COLORS = [...DEFAULT_COLORS];

        return {
            isReadOnly: false,
            // Pro lock, from the live snapshot (CloudCalendarService.onLockState). lockedOut =
            // locked (or paused after Pro ended) and this tab has no rights: the calendar is shown read-only.
            lock: { locked: false, pro: false, paused: false, canEdit: true, proSettings: null },
            // Inside someone else's page (an iframe) or asked to look like it (?embed).
            embedded: (() => { try { return window.self !== window.top || new URLSearchParams(location.search).has('embed'); } catch (e) { return true; } })(),
            // "Try the new calendar (beta)" (CalSwitch): which calendar draws this page (index.html decided), the
            // pill hidden for this session, and the feedback dialog ({ text, email, ... } while open).
            nativeCal: !!window.pcNativeCal,
            calPillHidden: (() => { try { return sessionStorage.getItem('pc_cal_pill_hidden') === '1'; } catch (e) { return false; } })(),
            calFeedback: null,
            proTrialUsed: false,
            proUnlimited: false,        // the signed-in person has Pro (id unlimited): the Upgrade card locks with one click
            proUnlimitedBusy: false,
            proUnlimitedFull: false,    // Pro with its 5 used: the card offers the owner's @name instead
            proHandle: '',
            editorLinkStored: '',       // the owner's last editor link made in this browser (Pro panel, localStorage): "Share to edit"
            shareNames: null,           // the owner's own links for this calendar ({handle, atName, shortNames}, /api/pro/status): Share leads with them
            proBilling: null,           // /api/pro/config: true = trial and checkout; false = "Join the beta"; null = not known yet (neither shows)
            homeTab: null,              // the homepage panel's tab when the visitor picked one ('recents' | 'guide')
            pausedOwner: false,         // this browser owns the paused (Pro ended) calendar it's looking at: offer the way back
            proTrialActive: false,      // this browser owns the calendar and it is on its free trial (trial_feature_used)
            proSurface: 'share',        // where the Pro offer was opened from: 'share' | 'stats' | 'lock' (trial_started)        // this calendar already had its one free trial (/api/pro/status), so the Go Pro card doesn't offer it
            lockedOut: false,
            lockKnown: false,   // a lock state has arrived for this calendar (the default above is a guess)
            viewRoute: false,   // /view/<slug>: read-only for its own reason, whatever the lock says
            // pastecal's own calendar draws this page instead of Syncfusion's (a view link with the flag on: index.html).
            nativeCal: !!window.pcNativeCal,
            nativeLink: window.pcNativeCal ? nativeLinkView() : null,
            nativePopover: null,      // the event popup on the native calendar: { event, occurrence, top, left }
            nativeRowHeight: 100,     // its month rows, taller on a wide window (fitNativeMonthRows)
            // A native edit link (index.html, window.pcNativeEdit): the quick box, the editor and the "this event /
            // all events" question. Each is null when closed.
            nativeEdit: !!window.pcNativeEdit,
            nativeQuick: null,        // { start, end, isAllDay, title, top, left }: the new event in the quick box
            nativeEditor: null,       // { event (what the form shows, frozen at open), mode, series, occurrence }
            nativeKeys: false,        // the ? keyboard shortcuts sheet (native edit links)
            nativeAsk: null,          // { title, message, options: [{ label, testid, action }], choice, ok, buttons }
            nativeCard: null,         // the event card (nativecal/components/EventCard.js): see openNativeCard
            isLoading: true, // set to false when calendar status is determined
            isExisting: false, // set by callback
            editTitle: false,
            calendar: cal,
            recentCalendars: [],
            syncFusionEvents: [],     // local copy, not synced
            urlslug: urlslug,
            debug: false,

            showRecents: false,
            hoverTimeout: null,
            // Drives the share pill's "Link copied" state. Reactive rather than a
            // DOM mutation so Vue owns the markup -- the older copyToClipboard()
            // rewrites innerHTML, which fights the template on a v-if'd element.
            shareCopied: false,
            shareCopiedTimer: null,
            showWelcome: false,
            showHelp: false,
            showNotes: false,
            embedNotes: false,        // an embed's Notes panel (index.html embed-bar)
            showShare: false,
            showSearch: false,
            showSettings: false,
            undoEntries: [],   // changes this calendar can undo (read from /history)
            showProStats: false,        // Pro owner dialogs (ProInsight.js)
            showProHistory: false,
            insightWhere: 'share_panel',    // which surface opened them, for analytics
            proOwner: false,            // this browser is signed in as the Pro calendar's owner
            showPlus: false,            // the side panel's Plus tab: what an upgrade adds, or the owner's plan, editors and billing
            plusAutoJoin: false,        // billing off and they pressed "Join the beta" elsewhere: the Plus tab opens on the email field
            proPlan: null,              // the lock's plan id (/api/pro/status), for planName: 'pro' is Plus
            pausedTrial: false,         // the paused calendar's ended plan was a trial (its owner's pill says 'Trial ended')
            upgradeNotice: null,        // {day, busy}: someone else upgraded it in the last 7 days and this browser may undo it
            showRecentChanges: false,   // the Activity tab of the side panel (id 'changes')
            showStatsInfo: false,       // the Stats tab when it can't show Pro stats: a draft, a free calendar, a non-owner
            freeStats: null,            // the Stats tab's free counts: {id, loading, error, none, unavailable, views, viewsPrev, followers}
            proOwnerChecked: false,     // /api/pro/status has answered for this lock, so "not the owner" is known
            notesEditing: false,        // Notes reads by default; Edit swaps in the textarea
            settingsScope: 'calendar',  // Settings: 'calendar' (everyone) or 'me' (this device)
            // The side panel docks beside the calendar only on wide screens (style.css, the
            // side panel block); narrower it floats over the calendar, so the grid keeps its width.
            sideWide: typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1100px)').matches,
            // When this browser last opened THIS calendar, captured before the visit is
            // recorded and so still pointing at the previous visit. It is what makes the
            // changes list answer "what happened while I was away" rather than only
            // "what can I undo". Null on a first visit, where nothing is "new".
            lastSeenAt: null,
            lastSeenKnown: false,       // lastSeenAt has been read for this visit
            proUpsell: false,           // the "Lock this calendar" line (see maybeShowProUpsell)
            lastEditLabel: '',          // "Edited 2d ago" in the header, or '' when unknown
            lastEditExact: '',          // the full timestamp, shown on hover
            lastEditedAt: null,         // server ms of the last real edit (/history_meta)
            serverTimeOffset: 0,        // server clock minus ours, from .info/serverTimeOffset


            currentViewURL: '',
            updateLinkTimer: null, // re-render share link

            searchQuery: '',
            searchResults: [],
            _pendingViewActivationHandler: null,
            _pendingViewActivationTimeout: null,

            // Settings
            globalSettings: {
                firstDayOfWeek: '0',
                timeFormat: '12',
                defaultView: 'Month',
                customViewDuration: 3,
                customViewUnit: 'Months',
                startHour: '05:00',
                darkMode: 'auto',
                dateFormat: 'auto' // 'auto' | 'us' | 'iso' | 'eu' — see resolveDateFormat()
            },
            localSettings: {
                typeLabels: Array(COLORS.length).fill().map((_, i) => `Type ${i + 1}`),
                colors: [...DEFAULT_COLORS]
            },

            // Store COLORS as a component property for consistent reference
            COLORS: COLORS,
            DEFAULT_COLORS: DEFAULT_COLORS,
            // What an unnamed category is called in the editor, the quick-add swatches,
            // Settings and the filter dots, while its color is still the default.
            EXTRA_COLORS: EXTRA_COLORS,
            MAX_COLORS: MAX_COLORS,
            colorFilters: COLORS.map(() => true), // allow all color types by default
            searchOpenId: null,   // the search result shown open, if any
            printFrom: null,      // 'share' while Share's Print button opens the dialog (counted in beforeprint)
            printMonth: null, printLink: '', printQr: '', printDate: '',   // the printed page's header and footer (preparePrint)
            FREE_CHANGES_DAYS: 30,   // how far back Recent changes reaches on a free calendar (visibleUndoEntries)
            // Bumped on every scheduler dataBound so hiddenEventCount, which reads the
            // visible date range off scheduleObj, recomputes when the view moves.
            viewTick: 0,
            // True while a server snapshot is being applied, so the calendar watcher can
            // tell "someone else changed this" from "the person here changed this" and
            // not publish the former back as if it were the latter.
            isApplyingRemote: false,
            // The events array as the last remote snapshot left it, so the watcher can tell
            // an untouched echo from an echo plus a real local edit.
            remoteAppliedSignature: null,
            // The event the Syncfusion editor dialog is currently showing. The dialog's DOM
            // and its type dropdown are reused across opens, so handlers built on the first
            // open read this rather than their own stale closure.

            // Store browser locale for display
            browserLocale: navigator.language || navigator.userLanguage || 'en-US',

            remoteSettingsApplied: false,

            // Read-only slug properties
            showReadOnlySlug: false,
            copiedKey: null,            // which Share link just copied (shows a check)
            showViewHelp: false,        // Share's "This view" explainer is open
            creatingReadOnly: false,    // Share's "Create read-only link" is waiting on the server
            readOnlySlugInput: '',

            // Rename
            newCalendarId: '',

            // Creation flow
            showClaimDialog: false,
            slugTaken: null,   // { slug, options: [free alternatives] } after a claim hits a taken name
            userHasEditedSlug: false,
            // Homepage flow: a tip on the grid until the first event of your own, then Share pulses once.
            userAddedEvent: false,
            sharePulse: false,
            // "Start from" on the homepage draft (utils/templates.js): the template whose events are on it
            // ({ id, date } of the month they were built for), a switch waiting for a yes, and the Save nudge.
            template: null,
            templateUndo: false,        // the template row's Undo, shown briefly after a switch that replaced edited events
            templateNudge: false,
            templateChips: CalendarTemplates.list(),
            // Phones fold the template chips behind one "Start from a template" toggle; opened stays opened this visit.
            templatesOpen: (() => { try { return sessionStorage.getItem('pc_tpl_open') === '1'; } catch (e) { return false; } })(),
            tourVariant: 'a',
            tplMore: false,           // the guide panel's template line: all templates shown
            TPL_FEATURED: ['family', 'team', 'out'],   // the three it starts with
            wideHome: (() => { try { return window.matchMedia('(min-width: 1100px)').matches; } catch (e) { return false; } })(),   // the homepage's guide panel shows (style.css)
            homeAsideHidden: (() => { try { return localStorage.getItem('pc_home_aside') === 'hidden'; } catch (e) { return false; } })(),

            // Mobile Menu
            showMobileMenu: false,
        }
    },

    computed: {
        // ---- The native calendar's props (a native view link). The classic calendar gets the same settings
        // imperatively (mountSyncfusion, applyGlobalSettings); these are reactive, so they need no re-apply.
        nativeEvents() { return this.nativeCal ? CalendarView.displayEvents(this.calendar.events) : []; },
        // Where a repeating event without its own zone repeats (EventZone.calendarZone), as the calendar feed writes it.
        calendarZone() { return typeof EventZone !== 'undefined' && EventZone.calendarZone ? EventZone.calendarZone(this.calendar) : null; },
        // The quick box's new event, drawn on the grid as the "New event" block (labelled with the title typed).
        // A new event in the card, drawn on the grid as the "New event" block (its label follows the title typed).
        nativeDraft() {
            const c = this.nativeCard;
            if (!c || !c.isNew) return null;
            const v = c.value, real = this.nativeCardInstants(v), end = v.isAllDay ? new Date(v.end.getFullYear(), v.end.getMonth(), v.end.getDate(), 23, 59, 59, 999) : real.end;
            return { start: new Date(real.start).toISOString(), end: new Date(end).toISOString(), isAllDay: !!v.isAllDay, title: v.title, type: v.type };
        },
        nativeView() { return this.nativeLink.view || this.calendar?.options?.defaultView || this.globalSettings.defaultView || 'Month'; },
        nativeCustomDuration() { return this.nativeLink.dur || this.calendar?.options?.customViewDuration || this.globalSettings.customViewDuration || 3; },
        nativeCustomUnit() { return this.nativeLink.unit || this.calendar?.options?.customViewUnit || this.globalSettings.customViewUnit || 'Months'; },
        nativeStartHour() { return this.calendar?.options?.extended ? '00:00' : (this.globalSettings.startHour || '05:00'); },
        // The color filter, as the color slots it hides (the same isEventVisible rule: filterSlotFor).
        hiddenColorSlots() { return this.COLORS.map((_, i) => i).filter(i => this.colorFilters[i] === false); },
        // "Week of Oct 18": what Share's "This view" link opens, read back from its own URL.
        viewLinkTag() {
            try {
                const u = new URL(this.currentViewURL, location.origin);
                const d = u.searchParams.get('date'), v = u.searchParams.get('view') || '';
                if (!d) return 'current view';
                const day = new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                const name = v === 'custom' ? `${u.searchParams.get('dur')} ${u.searchParams.get('unit')}` : v.charAt(0).toUpperCase() + v.slice(1);
                return `${name}, ${day}`;
            } catch (e) { return 'current view'; }
        },
        // ---- The side panel: Notes, Share, Activity, Stats, Settings (and Search, Help) ---------
        // One panel at a time, beside the calendar. The show* flags stay the source of truth
        // (the Escape key, analytics and history refreshes all read them); this names which is up.
        sideTab() {
            if (this.showRecentChanges) return 'changes';
            if (this.showProStats || this.showStatsInfo) return 'stats';
            if (this.showProHistory) return 'history';
            if (this.showNotes) return 'notes';
            if (this.showShare) return 'share';
            if (this.showSettings) return 'settings';
            if (this.showPlus) return 'plus';
            if (this.showSearch) return 'search';
            if (this.showHelp) return 'help';
            return null;
        },
        // Docked: the calendar narrows to make room instead of moving down.
        sideDocked() {
            return !!this.sideTab && this.sideWide;
        },
        // The tab row is for people who can change the calendar. Viewers see one thing at a
        // time under a plain title. Always the same five in the same order, so people learn
        // where things are: on a draft, Share, Activity and Stats say what they will hold once
        // it is saved. Plus: what an upgrade adds, or the owner's plan, editors and billing.
        // Settings is a gear at the end, so six fit a 400px column (and a phone) without scrolling.
        sideTabs() {
            if (this.isReadOnly) return [];
            return [
                { id: 'notes', label: 'Notes' },
                { id: 'share', label: 'Share' },
                { id: 'changes', label: 'Activity' },
                { id: 'stats', label: 'Stats' },
                { id: 'plus', label: 'Plus' },
                { id: 'settings', label: 'Settings', icon: 'settings' },
            ];
        },
        // The tab that reads as selected. History (every saved version) opens from Activity, so it stays lit.
        sideSelectedTab() {
            return this.sideTab === 'history' ? 'changes' : this.sideTab;
        },
        sideShowsTabs() {
            return this.sideTabs.some((t) => t.id === this.sideSelectedTab);
        },
        // Shown in the bar when there is no tab row, for the views without a heading of their own.
        sideTitle() {
            return { notes: 'About this calendar', search: 'Search', help: 'Help', settings: 'Settings', plus: planName(this.proPlan) }[this.sideTab] || '';
        },
        /** Why this tab can't edit a locked or paused calendar (toasts). */
        lockedOutMessage() { return this.lock.paused ? PRO_MESSAGES.paused : PRO_MESSAGES.lockedVisitor; },
        // Stats can show the real numbers: the owner of a Pro calendar (the server answers no one else).
        canSeeProStats() {
            return this.isExisting && this.lock.locked && this.proOwner;
        },
        // The free Stats tiles' comparison: "↑ 12%", "↓ 8%", "Same", or null with no earlier week to compare.
        freeStatsDelta() {
            const f = this.freeStats;
            const d = f && !f.loading && !f.error && !f.unavailable ? ProInsightMath.delta(f.views, f.viewsPrev) : null;
            return d && { dir: d.dir, text: d.dir === 'flat' ? d.text : (d.dir === 'up' ? '↑ ' : '↓ ') + d.text.slice(1) };
        },
        // A view link or locked calendar with notes opens with them pinned beside the grid.
        viewerNotesPinnable() {
            return !this.isLoading && this.isReadOnly && !!(this.calendar?.options?.notes || '').trim();
        },
        // Shown wherever the title is: the stored default "New Calendar" in sentence case.
        displayCalendarTitle() {
            return Calendar.displayTitle(this.calendar.title);
        },

        // Category names as shown: a label someone set, else "Type N" (see
        // typeLabelFor). Stored labels are never rewritten.
        displayTypeLabels() {
            return this.COLORS.map((_, i) => this.typeLabelFor(i));
        },
        // Which of those a calendar actually named ("Practice"); the rest show as "Type N".
        namedTypes() {
            return this.COLORS.map((_, i) => this.hasTypeLabel(i));
        },

        /**
         * The changes list, grouped by calendar day.
         *
         * One list serves two readers. The owner asks "what did I just do, and can I take
         * it back" -- reverse-chronological, with a Restore button. Someone who follows a
         * shared calendar asks "what changed since I last looked" -- and a flat list of
         * nine rows all reading "1d ago" cannot answer that.
         *
         * Day headings answer it without a second view: they turn a log into a diary, so
         * "Today" and "Yesterday" are readable at a glance, and the unseen count in the
         * heading says where to stop reading. The rows themselves are unchanged, so
         * nothing the owner relied on moves.
         */
        changesByDay() {
            const dayKey = (ms) => {
                const d = new Date(ms);
                return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            };
            const startOfDay = (ms) => {
                const d = new Date(ms);
                d.setHours(0, 0, 0, 0);
                return d.getTime();
            };
            const today = startOfDay(Date.now());
            const label = (ms) => {
                const days = Math.round((today - startOfDay(ms)) / 86400000);
                if (days <= 0) return 'Today';
                if (days === 1) return 'Yesterday';
                if (days < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' });
                return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            };

            const groups = [];
            for (const entry of this.visibleUndoEntries) {   // already newest-first
                const key = dayKey(entry.savedAt);
                let g = groups[groups.length - 1];
                if (!g || g.key !== key) {
                    g = { key, label: label(entry.savedAt), entries: [], unseen: 0 };
                    groups.push(g);
                }
                // A change is "new to you" only if it landed after your last visit AND
                // you have visited before -- on a first visit the whole history is new,
                // and flagging all of it says nothing.
                if (this.lastSeenAt && entry.savedAt > this.lastSeenAt) g.unseen += 1;
                g.entries.push(entry);
            }
            return groups;
        },

        /** How many changes landed since this browser last opened the calendar. */
        unseenChangeCount() {
            if (!this.lastSeenAt) return 0;
            return this.visibleUndoEntries.filter(e => e.savedAt > this.lastSeenAt).length;
        },

        /**
         * What Recent changes lists. A free calendar shows the last FREE_CHANGES_DAYS (30: a bad edit is often
         * noticed only when someone next checks, and "a month" reads calm where "7 days" reads like a timer); a Pro calendar shows
         * everything the room keeps (and its owner has History for the rest). Display only:
         * Cmd+Z still reads undoEntries, so nothing it could undo before goes missing.
         */
        visibleUndoEntries() {
            if (this.lock && this.lock.locked) return this.undoEntries;
            return ProInsightMath.withinDays(this.undoEntries, this.FREE_CHANGES_DAYS, this.serverNow());
        },

        /** This browser created the calendar (it's under "Your calendars"). */
        // "Make one like this" under a calendar this browser didn't make (an invitation, a view link).
        // Never on your own calendars, never in an embed (it has its own small credit), never while loading.
        /** A view link inside someone's page (an iframe, or ?embed): the one-line embed header instead of the site's. */
        /** Templates sit as one quiet line in the guide panel when it shows (wide screens); else above the calendar. */
        tplInAside() { return this.isHomepageCalendar && !this.isReadOnly && this.wideHome && !this.homeAsideHidden; },
        embedViewer() { return this.embedded && this.isReadOnly; },
        showMakeOwn() {
            return !this.isLoading && !this.embedded && !this.isMineCalendar && !this.isHomepageCalendar
                && (this.pageFooter === 'viewer' || this.pageFooter === 'editor');
        },
        isMineCalendar() {
            const id = String((this.calendar && this.calendar.id) || '').toLowerCase();
            return !!id && (this.recentCalendars || []).some(r => r && r.mine && String(r.id).toLowerCase() === id);
        },


        isAutogeneratedId() {
            const id = this.calendar?.id;
            if (!id) return false;
            // Check if ID is 8 characters (names made before Oct 2026) or 10 (since) and contains only chars from the random alphabet (1-9, A-Z excluding I,O)
            // Regex: ^[1-9a-hj-np-z]+$  (case insensitive)
            return /^([1-9a-hj-np-z]{8}|[1-9a-hj-np-z]{10})$/i.test(id);
        },
        hasCustomColors() {
            return this.COLORS.some((color, index) => color !== this.DEFAULT_COLORS[index]);
        },
        // How many events the color filter is hiding from the view on screen. Surfaced
        // next to the dots because a switched-off color is otherwise signalled only by a
        // dimmed dot: in #41 a calendar had exactly one event of its hidden type, so
        // filtering it read as the event being deleted rather than hidden.
        //
        // Scoped to the visible date range, not the whole calendar. Counting every stored
        // event made the number describe something the user cannot see -- one real calendar
        // has 2380 events of a single type, so hiding it announced "2380 events hidden"
        // while 66 disappeared from the week in front of them. The count has to answer
        // "where did the thing I was just looking at go".
        // What the banner says. Names the hidden category where there is one to name --
        // "Book/Movie Day events are hidden" tells someone who did not realise they
        // filtered both what happened and what to look for, which "a color filter is on"
        // does not. Falls back to the count, then to the bare fact that a filter is on,
        // because this must still say something true when the current view happens to
        // contain none of the hidden types.
        hiddenEventsMessage() {
            const hiddenLabels = [];
            for (let i = 0; i < this.COLORS.length; i++) {
                if (this.colorFilters[i] === false) hiddenLabels.push(this.typeLabelFor(i));
            }
            const n = this.hiddenEventCount;
            const named = hiddenLabels.length === 1 ? hiddenLabels[0] : null;

            if (n > 0) {
                return named
                    ? `${n} ${named} ${n === 1 ? 'event' : 'events'} hidden`
                    : `${n} ${n === 1 ? 'event' : 'events'} hidden by a filter`;
            }
            return named ? `${named} events hidden` : 'Some event types hidden';
        },

        // Is any color switched off? Distinct from hiddenEventCount, which is 0 whenever
        // the current view happens to contain none of the hidden types. Now that filters
        // persist past closing the panel, that state is reachable by simply paging to
        // another week -- and a filter that is on while nothing says so is exactly the
        // condition behind #41. The banner keys off this, so it is shown for as long as
        // the filter is on, and reports the count only when it has one to report.
        // The search panel's color filter: one chip per color some event uses, with how many use it.
        // A color switched off stays listed even if unused, so it can always be switched back on.
        filterChips() {
            const counts = this.COLORS.map(() => 0);
            for (const e of (this.calendar?.events || [])) {
                if (e && e.recurrenceID) continue;   // an edited occurrence is part of its series
                counts[this.filterSlotFor(e)]++;
            }
            return this.COLORS.map((color, idx) => ({ idx, color, count: counts[idx], label: this.typeLabelFor(idx) }))
                .filter(c => c.count > 0 || this.colorFilters[c.idx] === false);
        },

        // What the search panel lists: the matches for the words typed, or, with no words and a color
        // filter on, every event that filter shows. Hidden types are left out, as on the calendar.
        // Upcoming first (soonest at the top), then past (most recent first). A repeating event counts
        // as upcoming until its UNTIL date.
        searchList() {
            const q = (this.searchQuery || '').trim();
            const base = q ? this.searchResults : (this.isColorFilterActive ? (this.calendar?.events || []) : []);
            const now = Date.now();
            const shown = base.filter(e => e && this.colorFilters[this.filterSlotFor(e)] !== false);
            const endOf = (e) => {
                const rule = e.recurrencerule || e.RecurrenceRule || '';
                if (rule) {
                    const m = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rule);
                    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59) : Infinity;
                }
                return Date.parse(e.end || e.start) || 0;
            };
            const upcoming = shown.filter(e => endOf(e) >= now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
            const past = shown.filter(e => endOf(e) < now).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
            return { upcoming, past, count: upcoming.length + past.length };
        },

        isColorFilterActive() {
            return this.colorFilters.slice(0, this.COLORS.length).some(on => on === false);
        },

        hiddenEventCount() {
            this.viewTick; // dependency: recompute when the scheduler re-renders a new range
            const range = this.visibleDateRange();
            return this.calendar.events.filter(e => {
                if (this.isEventVisible(e)) return false;
                if (!range) return true;
                // All-day events are read the way the grid reads them (the viewer's local
                // midnight of the stored date, see Event.allDayToLocal); the raw stored
                // instant put the banner a day off from the grid in some time zones.
                const ms = (v) => {
                    const d = e.isAllDay ? Event.allDayToLocal(v) : new Date(v);
                    return d ? d.getTime() : NaN;
                };
                const start = ms(e.start);
                if (isNaN(start)) return true; // undateable: count it rather than hide the fact
                // A recurring event is one stored record but many occurrences, so the
                // stored start says only when the series began. Ask the scheduler which
                // occurrences actually fall in the window instead of guessing: a series
                // that finished last year starts before the window but puts nothing in it,
                // and counting it produced a banner reporting a hidden event the user
                // could never find.
                if (e.recurrencerule) return this.recurrenceOccursInRange(e, range);
                return this.spansRange(start, ms(e.end), range);
            }).length;
        },
        // An unset default view is undefined in saved calendars; the select's Auto option is null.
        calendarDefaultView: {
            get() { return this.calendar.options.defaultView ?? null; },
            set(v) { this.calendar.options.defaultView = v; }
        },
        calendarAutoViewLabel() {
            return 'Month'; // Could be dynamic based on screen size etc.
        },
        calendarCustomViewLabel() {
            return `${this.calendar.options.customViewDuration || 3} ${this.calendar.options.customViewUnit || 'Months'}`;
        },
        personalCustomViewLabel() {
            return `${this.globalSettings.customViewDuration} ${this.globalSettings.customViewUnit}`;
        },
        isValidEvent() {
            // Placeholder if needed for validation logic moved to computed
            return true;
        },
        displayReadOnlySlug() {
            if (this.calendar?.options?.publicViewId) return this.calendar.options.publicViewId;
            // fallback to URL parsing if calendar data isn't fully loaded or populated yet
                const parts = stripBase(window.location.pathname).split('/').filter(Boolean);
                if (parts[0] === 'view' && parts[1]) return parts[1];
                return '...';
            },
        // Readable intent-based computed properties
        isNewCalendar() {
            // User is on homepage creating a new calendar
            const result = !this.isExisting && !this.isReadOnly;
            console.log('[isNewCalendar]', result, '| isExisting:', this.isExisting, '| isReadOnly:', this.isReadOnly);
            return result;
        },
        hasCalendar() {
            // User is viewing any calendar (owned or read-only)
            return this.isExisting || this.isReadOnly;
        },
        canEdit() {
            // User has edit permissions (defensive boolean coercion)
            return !Boolean(this.isReadOnly);
        },
        // Who is looking, as a Clarity recording label: owner (signed-in Pro owner), viewer
        // (view link or a locked calendar), editor (can change it), new (the homepage calendar).
        recordingRole() {
            if (this.proOwner) return 'owner';
            if (this.isReadOnly) return 'viewer';
            return this.isHomepageCalendar ? 'new' : 'editor';
        },
        // Pro trims pastecal's branding from what visitors see (view links, embeds, a locked
        // calendar's read-only face) while the owner leaves proSettings.hideBranding on (the
        // default). It shrinks to the "Made with pastecal · Report" line, never to nothing:
        // removing that is a Teams feature. The owner's own editing UI keeps the branding.
        hideBranding() {
            if (!(this.isReadOnly && this.lock.pro)) return false;
            const p = this.lock.proSettings;
            return !p || p.hideBranding !== false;
        },
        // Which line sits under the calendar: 'viewer' (the free view link's one-line invitation),
        // 'pro' (trimmed to "Made with pastecal"), 'embed' (a tiny corner credit inside someone's
        // page), 'editor' (quiet links on an edit link), or '' (homepage draft, still loading).
        pageFooter() {
            if (this.isLoading) return '';
            // The paused calendar's owner isn't a visitor: no "make your own" pitch, just the hosted note.
            if (this.isReadOnly) return this.hideBranding || this.pausedOwner ? 'pro' : (this.embedded ? 'embed' : 'viewer');
            return this.isExisting ? 'editor' : '';
        },
        // The footer's "Try the new calendar (beta)" link or, on the new calendar, its pill (CalSwitch). Edit links
        // and view links (locked and Pro ones too); never an embed, the homepage (classic only for now) or a pill
        // hidden for this session.
        showCalSwitch() {
            if (this.embedded || this.isHomepageCalendar || this.lock.pro || !['viewer', 'editor'].includes(this.pageFooter)) return false;   // never on Pro calendars (owner's call)
            return !(this.nativeCal && this.calPillHidden);
        },
        // The footer's Report link (shown when branding is trimmed). The page's own path, so a view link
        // reports its view code and never reveals the edit name behind it.
        reportUrl() {
            return '/report?cal=' + encodeURIComponent(window.location.pathname.replace(/^\/+/, ''));
        },

        // Homepage calendar (no slug and not an existing saved calendar)
        // Returning visitors open on their calendars; the guide is one click away.
        // The phone's template toggle names the template in use, if any.
        templateLabel() {
            return this.template ? CalendarTemplates.label(this.template.id) : '';   // gallery-only templates have no chip
        },
        homePanel() { return this.homeTab || (this.homeRecents.length ? 'recents' : 'guide'); },
        isHomepageCalendar() {
            return !this.urlslug && !this.isExisting;
        },

        // The homepage panel's shortcut list for returning visitors: most recently opened first.
        homeRecents() {
            const time = (item) => Date.parse(item.lastVisited || item.createdAt || 0) || 0;
            return [...(this.recentCalendars || [])].sort((a, b) => time(b) - time(a)).slice(0, 6)
                .map(item => ({ ...item, ...RecentCalendars.display(item), ago: item.lastVisited ? 'Opened ' + this.describeAgo(Date.parse(item.lastVisited)) : '' }));
        },

        // Headline and lead for the homepage pitch. One version for now; a later test adds more,
        // keyed by experiment variant.
        tourCopy() {
            return { kicker: 'How pastecal works', title: 'Add events. Paste your link. Done.' };
        }
    },

    mounted() {
        try { window.matchMedia('(min-width: 1100px)').addEventListener('change', (e) => { this.wideHome = e.matches; }); } catch (e) { /* old browser: stays as loaded */ }
        // Load globalSettings from localStorage FIRST, before scheduleObj is constructed.
        // Syncfusion bakes some properties (e.g. timeFormat, firstDayOfWeek) into the initial
        // DOM render and doesn't reactively update them when set later — so settings must be
        // available for the pre-appendTo configuration block below, not just applied after.
        this.loadGlobalSettings();
        // Printing: fill the print header/footer first; the QR library loads once the page is idle, not before.
        window.addEventListener('beforeprint', () => {
            this.preparePrint();
            track(a => a.printed((this.printFrom || 'browser') + (this.isReadOnly ? '_view' : '_edit')));
            this.printFrom = null;
        });
        setTimeout(() => { try { if (typeof qrcode !== 'function') { const sc = document.createElement('script'); sc.src = '/vendor/qrcode-generator-1.4.4/qrcode.js'; sc.async = true; document.head.appendChild(sc); } } catch (e) { /* no QR, still prints */ } }, 4000);
        this.$nextTick(() => this.fitSlugBox());   // after the title font is in: see fitSlugBox
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.fitSlugBox());
        // Can Pro be bought yet? Decides between the trial/checkout and "Join the beta" everywhere Pro is offered.
        if (typeof ProBilling !== 'undefined') ProBilling.load().then((b) => { this.proBilling = b; });
        else this.proBilling = true;

        // Undo bookkeeping, deliberately non-reactive. (This tab's own undo stack is the
        // EventStore's.) _handledUndo and _undoneHistoryKeys let the /history fallback skip changes this session already
        // undid and the entries its own undos produced -- otherwise a second Cmd+Z just
        // re-applies the change the first one reversed.
        this._handledUndo = [];
        this._undoneHistoryKeys = new Set();

        // Initialize recents
        this.recentManager = new RecentCalendars();
        this.recentCalendars = this.recentManager.getAll();

        // Decide on the first-run welcome here, before this visit gets recorded
        // into recents -- otherwise every new visitor looks like a returning one.
        this.maybeShowWelcome();

        // Ensure calendar.options has proper defaults
        this.ensureCalendarOptionsDefaults();

        // Initialize local settings
        this.initializeLocalSettings();
        // We'll load and apply global settings after scheduleObj is initialized

                // readonly: pastecal.com/view/ID (supports alternative base paths via CAL_BASE)
                let path = stripBase(location.pathname);

                // pastecal.com/@handle/<name>: the Worker serves this page with the read-only name to open
                // (<meta name="pc-view">), so it opens exactly like /view/<that name> and the address stays.
                const atView = atViewSlug();
                if (path?.startsWith('/view/') || atView) {
                    // Read-only view mode
                    const requestedSlug = atView || path.split('/')[2];
            // Ensure explicit boolean normalization when setting read-only mode
            this.setIsReadOnly(true);
            this.viewRoute = true;

            // Always use lookupCalendar for consistent case-insensitive handling
            (async () => {
                try {
                    console.log('Looking up calendar for /view/ route:', requestedSlug);
                    const result = await CalendarDataService.lookupCalendar(requestedSlug);

                    // A Pro short name whose account was deleted: a neutral "This link has ended" page (the Worker's).
                    if (result.data.ended) { location.replace('/link-ended/' + encodeURIComponent(requestedSlug)); return; }
                    if (result.data.found && result.data.isReadOnly) {
                        // Found as read-only - subscribe with the actual slug
                        const actualSlug = result.data.actualSlug;
                        console.log('Found read-only calendar with slug:', actualSlug);

                        CalendarDataService.subscribe_readonly(actualSlug, (c, access) => {
                            if (access) this.lock = { locked: !!access.locked, pro: !!access.pro, canEdit: false, proSettings: access.proSettings || null };
                            this.applyRemoteCalendar(c);
                            this.ensureCalendarOptionsDefaults();
                            // Update custom view in schedule with calendar's settings
                            this.updateCustomViewInSchedule();
                            // Re-initialize local settings to load custom colors and labels
                            this.initializeLocalSettings();
                            // Add to recents when calendar loads, but mark as read-only
                            // The tab says which calendar this is (a short link's page is static: the server can't).
                            if (c.title) document.title = `${String(c.title).slice(0, 120)} · pastecal`;
                            if (c.title) {
                                // A read-only calendar you were linked to is a visit,
                                // not something you created.
                                this.recentManager.add(actualSlug, c.title, false, true);
                                this.recentCalendars = this.recentManager.getAll();
                            }

                            if (!this.remoteSettingsApplied) {
                                this.applyGlobalSettingsAfterRemote();
                                this.remoteSettingsApplied = true;
                            }
                            this.isLoading = false;
                        });
                    } else if (result.data.found && !result.data.isReadOnly) {
                        // Found as editable calendar - show message
                        this.isLoading = false;
                        alert('This calendar has no view-only link yet. Ask the owner to make one in Share.');
                    } else {
                        // Calendar doesn't exist at all
                        this.isLoading = false;
                        alert('Calendar not found. Check the link and try again.');
                    }
                } catch (error) {
                    console.error('Calendar lookup failed:', error);
                    this.isLoading = false;
                    alert('Couldn’t load this calendar. Check your connection and reload the page.');
                }
            })();
        } else if (this.urlslug) {
            // default: pastecal.com/ID
            CalendarDataService.findAndSubscribe(this.urlslug, (c) => {
                if (c) {
                    // Calendar found
                    console.log('[CalendarDataService] Calendar loaded from Firebase');
                    this.isExisting = true;
                    this.applyRemoteCalendar(c);
                    // "Edited N ago" in the header comes from a live listener on the
                    // server's lastEditedAt stamp, not from re-reading /history on every
                    // echo -- that downloaded the whole log just to compute one label.
                    this.watchLastEdited(this.calendar.id);
                    this.loadLastEdit();   // seed from the calendar's own stamp until the listener answers
                    console.log('[CalendarDataService] Calendar imported, defaultView:', this.calendar?.options?.defaultView);
                    this.ensureCalendarOptionsDefaults();
                    // Update custom view in schedule with calendar's settings
                    this.updateCustomViewInSchedule();
                    // Re-initialize local settings to load custom colors and labels
                    this.initializeLocalSettings();
                    // Add to recents when calendar loads.
                    //
                    // This callback is a live subscription: it re-fires on every
                    // remote edit, not just on load. add() bumps visitCount, so
                    // counting here unguarded would turn "visits" into "edits made
                    // by anyone while this tab was open" -- someone watching a busy
                    // calendar would rack up hundreds. Count the visit once per page
                    // load; later fires only refresh the title.
                    const firstLoad = !this.visitCounted;
                    // Just created on the homepage: open Share so the links are right there.
                    if (firstLoad) {
                        try {
                            if (sessionStorage.getItem('pastecal_open_share') === this.calendar.id) {
                                sessionStorage.removeItem('pastecal_open_share');
                                this.$nextTick(() => { if (!this.showShare) this.toggleShare(); });
                            }
                        } catch (e) { /* storage blocked: nothing to open */ }
                        // The logo menu's "Stats" for this calendar, clicked on another page.
                        const insight = typeof ProInsightIntent !== 'undefined' ? ProInsightIntent.take(this.calendar.id) : null;
                        if (insight) this.$nextTick(() => this.openInsight(insight, 'logo_menu'));
                        // A sign-in link opened in another browser carries the plan they were buying (?pro=).
                        // It continues to payment only right after that sign-in, never from a shared link.
                        try {
                            const q = new URLSearchParams(location.search), plan = q.get('pro');
                            // trial: the sign-in link already started it; the panel shows how it went (and retries, to explain a refusal).
                            // keep: the trial reminder's Keep Pro link: just open the panel.
                            if ((plan === 'year' || plan === 'month' || plan === 'trial' || plan === 'keep') && typeof ProIntent !== 'undefined') {
                                const fresh = sessionStorage.getItem('pastecal_signed_in_to') || '';
                                sessionStorage.removeItem('pastecal_signed_in_to');
                                if (plan === 'keep') track(a => a.trialReminderClicked());     // only the day-27 email links ?pro=keep
                                if (!ProIntent.get(this.calendar.id)) ProIntent.set(this.calendar.id, plan, plan !== 'keep' && fresh.endsWith('?pro=' + plan));
                                q.delete('pro');
                                history.replaceState(history.state, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
                            }
                        } catch (e) { /* storage blocked: Share still opens below if the intent was kept */ }
                        // Back from a sign-in link (trial, checkout, the reminder's Keep Plus): open the Plus tab,
                        // where the trial or checkout continues.
                        const proIntent = typeof ProIntent !== 'undefined' ? ProIntent.get(this.calendar.id) : null;
                        if (proIntent) {
                            // Once: the panel reads the chosen interval as it mounts, then the intent is done.
                            this.$nextTick(() => {
                                if (!this.showPlus) this.openPlusTab(proIntent.surface || 'share');
                                this.$nextTick(() => {
                                    ProIntent.clear();
                                    // The lock offer sits at the bottom of Share: below the fold on a phone.
                                    setTimeout(() => {
                                        const panel = [...document.querySelectorAll('[data-testid=pro-panel]')].find(el => el.offsetParent);
                                        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    }, 400);
                                });
                            });
                        }
                    }
                    this.visitCounted = true;

                    if (firstLoad) {
                        // Read the PREVIOUS visit before add() overwrites it -- once the
                        // visit is recorded, lastVisited is "now" and can no longer mark
                        // where the reader left off.
                        const prior = this.recentManager.getAll()
                            .find(item => item.id === this.calendar.id);
                        this.lastSeenAt = prior?.lastVisited
                            ? new Date(prior.lastVisited).getTime()
                            : null;
                        this.lastSeenKnown = true;
                        this.recentManager.add(this.calendar.id, this.calendar.title);
                        this.$nextTick(() => this.maybeShowProUpsell());
                    } else {
                        this.recentManager.touchTitle(this.calendar.id, this.calendar.title);
                    }
                    this.recentCalendars = this.recentManager.getAll();

                    // Return depth: only interesting from the second visit on, since
                    // every first load would otherwise report visit 1 and swamp it.
                    if (firstLoad) {
                        const visited = this.recentManager.getAll()
                            .find(item => item.id === this.calendar.id);
                        if (visited && visited.visitCount > 1) {
                            track(a => a.calendarReturned(this.calendar, visited.visitCount));
                        }
                        // Sizes the "one plan, N calendars" question. Fires at most
                        // once per session -- see calendarsOwned().
                        track(a => a.calendarsOwned(this.recentManager.getMine().length));
                    }

                    if (!this.remoteSettingsApplied) {
                        this.applyGlobalSettingsAfterRemote();
                        this.remoteSettingsApplied = true;
                    }
                } else {
                    // Calendar doesn't exist
                    this.isExisting = false;
                }
                this.isLoading = false;
            });
        } else {
            // homepage - no remote calendar to load
            this.isExisting = false;
            this.calendar.id = Utils.randomID(10);
            this.isLoading = false;

            // The claim bar is on screen with a generated name in it. This is the
            // denominator for the naming question: everyone who was offered a name
            // to change, whether or not they ever touch it.
            track(a => a.slugPromptShown('homepage_bar', this.calendar));
        }

        // The calendar on screen: pastecal's own on a native view link (index.html, window.pcNativeCal), else
        // Syncfusion's. The rest of the app reaches it through this.calView (services/CalendarView.js).
        this.calView = this.nativeCal ? CalendarView.native(this, () => this.$refs.nativeCal || null) : this.mountSyncfusion();
        if (this.nativeCal) this.watchNativeCalendar();

        // Settings were already loaded at the top of mounted() and applied to scheduleObj
        // pre-appendTo. Call applyGlobalSettings again here as a safety net for settings that
        // depend on scheduleObj being fully initialized (e.g. applyDefaultView, which mutates
        // scheduleObj.views/currentView). This used to be gated behind !this.urlslug, which
        // meant non-homepage URLs relied on applyGlobalSettingsAfterRemote — and that path
        // silently no-op'd when scheduleObj wasn't ready at remote-callback time.
        this.applyGlobalSettings();
        this.applyTheme();

        // Keep theme in sync with OS preference when darkMode is 'auto'.
        // Without this, toggling the OS theme at runtime leaves data-theme stale
        // while Syncfusion's CSS doesn't move at all — the mixed-mode bug.
        if (window.matchMedia) {
            const mql = window.matchMedia('(prefers-color-scheme: dark)');
            const onSystemThemeChange = () => {
                if (this.globalSettings.darkMode === 'auto') this.applyTheme();
            };
            mql.addEventListener ? mql.addEventListener('change', onSystemThemeChange) : mql.addListener(onSystemThemeChange);
        }

        // Tell the user when the write path had to drop an event, rather than leaving the
        // screen showing something Firebase does not have.
        CalendarDataService.onIncompleteEvents = (dropped) => {
            const named = dropped.map(e => e && e.title).filter(Boolean);
            const what = named.length === 1 ? `"${named[0]}"`
                : `${dropped.length} event${dropped.length === 1 ? '' : 's'}`;
            this.showToast(`${what} wasn’t saved: it needs a start and end time`, 'error');
            // The count, not the events: this is how we find out whether an entry path
            // is still producing unsaveable events without waiting for a bug report.
            track(a => a.eventsDropped(dropped.length, 'incomplete'));
        };

        // How often real editing actually collides. Merging is the intended behavior, so
        // this is not an error -- but the rate is the only visibility into whether the
        // merge is settling or thrashing, and it was completely dark before.
        CalendarDataService.onSyncMerged = (counts) => {
            track(a => a.syncMerged(counts));
        };

        // A write that never landed. The user is told, because silently keeping an edit
        // that exists only on their screen is the failure mode this whole investigation
        // was about.
        CalendarDataService.onSyncPaused = ({ writes }) => {
            this.showToast('Saving paused. Reload the page to keep editing.', 'error');
            track(a => a.jsError('sync_paused', `${writes} writes in a minute`, 'sync'));
        };
        CalendarDataService.onSyncFailed = () => {
            this.showToast('Couldn’t save. Check your connection.', 'error');
            track(a => a.jsError('sync_failed', 'transaction did not commit', 'sync'));
        };

        // The write gate refused a removal nobody asked for. The screen is now missing
        // events the server still has, so put the server's copy straight back rather than
        // leaving the user staring at a calendar that has lost data. Restoring through
        // applyRemoteCalendar marks it as a remote apply, so the watcher does not treat
        // the restoration as a fresh local edit and bounce it back at the server.
        //
        // REPLACE, not merge: the ordinary inbound merge diffs local against the
        // baseline, sees every dropped row as deleted-by-us, and drops it again -- the
        // toast said "Recovered" while the screen stayed shrunk and every later edit was
        // refused until a reload. The list keeps this write's own additions and edits,
        // and the service re-sends them along with any deletion the user named, so local
        // and server converge on the same list.
        // Pro lock: who may change this calendar. Fired on every snapshot and editor-key answer.
        CalendarDataService.onLockState = (s) => this.applyLockState(s);

        CalendarDataService.onSyncRefused = ({ before, removing, recovered, events, code }) => {
            if (code === 'locked' || code === 'paused') {
                // The calendar is locked or paused (or the editor link stopped working): undo the edit, say why.
                this.showToast(code === 'paused' ? PRO_MESSAGES.paused : PRO_MESSAGES.lockedVisitor, 'info');
                if (Array.isArray(events)) {
                    this.applyRemoteCalendar({ ...this.calendar, events: JSON.parse(JSON.stringify(events)) }, { replace: true });
                }
                return;
            }
            // The rows put back, not the net shrink: an addition in the same write offsets
            // the count without making the loss any smaller.
            const n = recovered ?? removing;
            this.showToast(`Recovered ${n} event${n === 1 ? '' : 's'} that were about to be lost`, 'error');
            track(a => a.syncRefused({ before, removing }));
            if (Array.isArray(events)) {
                this.applyRemoteCalendar({ ...this.calendar, events: JSON.parse(JSON.stringify(events)) },
                    { replace: true });
            }
        };

        // Every write's shape. The counter-signal the incident lacked: grid saves going
        // to zero looked like nobody using the grid, because zero of something uncounted
        // is invisible.
        CalendarDataService.onSyncShape = (shape) => {
            track(a => a.syncShape(shape));
        };

        // Send any pending debounced write before the page goes away. pagehide covers
        // navigation and close; visibilitychange covers a backgrounded mobile tab, which
        // is where the process is most likely to be killed before a timer fires.
        window.addEventListener('pagehide', () => CalendarDataService.flush());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') CalendarDataService.flush();
        });

        // Apply custom colors CSS if any
        this.updateColorCSS();

        // extended hours button
        document.addEventListener('click', (e) => {
            if (e.target.className == "e-header-cells e-disable-dates") {
                if (!this.calendar.options) this.calendar.options = {};
                this.calendar.options.extended = !this.calendar?.options?.extended;
            }
        });

        // populate sample data for new calendars on homepage
        if (this.isHomepageCalendar && this.calendar.events.length == 0) {
            // Load homepage data from localStorage
            this.loadLocalStorage();
            if ((this.calendar.events || []).some(e => e && (e.title || e.Subject) && !Calendar.isSampleTitle(e.title || e.Subject) && !CalendarTemplates.templateOf(e))) this.userAddedEvent = true;
            this.restoreTemplate();

            // If still no events after loading, show the example event
            if (this.calendar.events.length == 0) {
                this.calendar.setEvents(this.calendar.sampleEvents());
            }
            this.updateCalendarView();

            // "Use this template" on pastecal.com/templates: /?template=<id> starts the draft from it (events the
            // visitor already added stay, as with the chips). The parameter is then dropped, so a reload doesn't redo it.
            try {
                const want = new URLSearchParams(location.search).get('template');
                if (want && CalendarTemplates.label(want)) {
                    this.$nextTick(() => { this.pickTemplate(want); track(a => a.featureUsed('template_link', want)); });
                    const u = new URL(location.href); u.searchParams.delete('template');
                    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
                }
            } catch (e) { /* a bad link opens the plain draft */ }
        }

        // Global keyboard shortcut for quick-add (Cmd/Ctrl+E)
        // Cmd/Ctrl+Z is the reflex when something disappears -- people reach for it before
        // they look at any UI. Ignored while typing, so it still means "undo my text" in
        // an input, and skipped on a calendar with neither server history nor anything
        // done in this tab to undo.
        this._undoShortcutHandler = (e) => {
            // e.key is undefined on some synthetic keydowns (Chrome autofill fires one).
            const isZ = typeof e.key === 'string' && e.key.toLowerCase() === 'z';
            if (!((e.metaKey || e.ctrlKey) && isZ) || e.shiftKey) return;
            const el = document.activeElement;
            const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
            // Nor while a dialog is open: focus there is often on a button, not an input,
            // and an undo landing under the scheduler's open editor changes the event it
            // is about to save. Tooltips are popups too but block nothing.
            // aria-modal only counts while the dialog is showing: Syncfusion leaves it set on
            // dialogs it has closed (hidden), which used to disable this shortcut for good.
            const modalShowing = [...document.querySelectorAll('[aria-modal="true"]')]
                .some((m) => m.getClientRects().length > 0 && getComputedStyle(m).visibility !== 'hidden');
            const dialogOpen = modalShowing || !!document.querySelector('.e-popup-open:not(.e-tooltip-wrap), .pc-modal')
                || !!(this.$refs.quickAddDialog && this.$refs.quickAddDialog.dialogVisible);
            if (dialogOpen) return;
            // Without server history there is still this session's own stack to undo.
            if (typing || (!this.isExisting && !this.store().canUndo)) return;
            e.preventDefault();
            // This visit's last change is known exactly; undo it directly. Otherwise fall
            // back to server history (after a reload, or for a change from another browser).
            if (this.store().canUndo && this.undoLastLocal()) return;
            this.undoLastChange();
        };
        window.addEventListener('keydown', this._undoShortcutHandler);

        this._quickAddShortcutHandler = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
                e.preventDefault();
                if (this.$refs && this.$refs.quickAddDialog && typeof this.$refs.quickAddDialog.showDialog === 'function') {
                    this.$refs.quickAddDialog.showDialog();
                }
            }
        };
        window.addEventListener('keydown', this._quickAddShortcutHandler);

        // Escape closes whatever dialog is open. Every modal has an X, but Escape is
        // the reflex -- and in a long dialog the X can be a scroll away from where the
        // reader's attention is. Closes the innermost thing first, so one key backs out
        // in the order the user entered.
        this._escapeHandler = (e) => {
            if (e.key !== 'Escape') return;
            // The native calendar's own boxes first: the question, the editor, the quick box (innermost first).
            if (this.nativeAsk) { this.nativeAnswer(null); return; }
            if (this.nativeEditor) { this.closeNativeEditor(); return; }
            if (this.nativeQuick) { this.nativeQuick = null; return; }
            if (this.nativeCard) { this.nativeCardCancel(); return; }   // (the card takes its own Escape first: EventCard onKey)
            if (this.showRecentChanges) { this.showRecentChanges = false; return; }
            if (this.showProStats || this.showProHistory || this.showStatsInfo) { this.closeAllPanels(); return; }
            if (this.showNotes && this.notesEditing) { this.notesEditing = false; return; }
            if (this.showClaimDialog) { this.showClaimDialog = false; return; }
            if (this.showSettings) { this.showSettings = false; return; }
            if (this.showSearch) { this.showSearch = false; return; }
            if (this.showShare) { this.showShare = false; return; }
            if (this.showHelp) { this.showHelp = false; }
        };
        window.addEventListener('keydown', this._escapeHandler);

        // Whether the side panel docks (style.css uses the same 1100px line).
        if (typeof window.matchMedia === 'function') {
            const wide = window.matchMedia('(min-width: 1100px)');
            const sync = () => { this.sideWide = wide.matches; };
            if (wide.addEventListener) wide.addEventListener('change', sync); else if (wide.addListener) wide.addListener(sync);
        }
    },

    beforeUnmount() {
        this.unwatchLastEdited();
        window.removeEventListener('keydown', this._undoShortcutHandler);
        window.removeEventListener('keydown', this._quickAddShortcutHandler);
    },

    watch: {
        // The event card follows changes made in other browsers (nativeCardRefresh).
        'calendar.events'() { if (this.nativeCard) this.$nextTick(() => this.nativeCardRefresh()); },
        'calendar.id'() { this.$nextTick(() => this.fitSlugBox()); },
        // The footer line appears once loading ends (or changes with Pro): give the month grid its room.
        pageFooter() { this.$nextTick(() => { if (this._refitMonthRows) this._refitMonthRows(); }); },
        // The homepage pitch is an experiment: pick (or recall) this browser's variant
        // once the page is known to be the homepage, then report which parts of it are read.
        isHomepageCalendar: {
            immediate: true,
            handler(home) {
                if (!home || this._tourStarted) return;
                this._tourStarted = true;
                track(a => {
                    this.tourVariant = a.homepageVariant();
                    a.homepageViewed(this.homeRecents.length ? 'returning' : 'new');
                });
                this.$nextTick(() => this.observeTour());
            },
        },
        // Move focus into the Recent changes dialog when it opens and give it back to
        // whatever opened it on close, so keyboard and screen-reader users are not left
        // stranded on the page behind a modal.
        showRecentChanges(open) {
            if (open) {
                this._recentChangesOpener = document.activeElement;
                this.$nextTick(() => {
                    const panel = this.$refs.recentChangesPanel;
                    if (panel) panel.focus();
                });
            } else {
                const opener = this._recentChangesOpener;
                this._recentChangesOpener = null;
                // Switching to another tab keeps focus in the panel; only closing gives it back.
                if (this.sideTab) return;
                if (opener && document.contains(opener) && typeof opener.focus === 'function') {
                    opener.focus();
                }
            }
        },

        // Theme has two outputs: <html data-theme> (drives style.css vars) and the
        // Syncfusion CSS bundle. They must stay in lockstep — if they desync, the
        // page renders mixed light/dark (e.g. tooltip on /view/<slug> looks transparent
        // because bg-2 is light while the calendar grid is dark). This watcher makes
        // darkMode the single source of truth: any mutation re-applies both outputs.
        sideTab(tab, was) {
            if (!tab || tab === was || !this._panelVia) return;
            const via = this._panelVia;
            this._panelVia = null;
            track(a => a.panelOpened(tab, via));
        },
        'globalSettings.darkMode': {
            handler() {
                this.applyTheme();
            },
            immediate: false, // mounted() already calls applyTheme on initial load
        },

        // Who owns a Pro calendar decides who sees Stats and History. The share dialog's Pro
        // panel reports it too, but Recent changes needs it without that dialog ever opening.
        'lock.locked': {
            handler(locked) {
                this.proOwnerChecked = false;
                if (!locked) { this.proOwner = false; this.upgradeNotice = null; this.shareNames = null; if (this.showPlus) this.refreshProTrial(); return; }
                this.refreshProOwner();
                this.checkUpgradeNotice();
            },
        },
        // The plan ended and the owner opened it: the offer is back, without the trial it already had.
        'lock.paused'(paused) {
            if (!paused && this.showPlus) this.refreshProTrial();
            this.checkPausedOwner();
        },
        recordingRole: {
            handler(role) { track(a => a.tag('role', role)); },
            immediate: true,
        },
        // The owner's first visit after locking: say once what changed, and where the editor link is.
        proOwner(isOwner) {
            // Stats opened before the owner check answered: now it can show the real numbers.
            if (isOwner && this.showStatsInfo && this.canSeeProStats) this.openInsight('stats', 'side_panel');
            if (!isOwner || !this.calendar || !this.calendar.id) return;
            const key = 'pastecal_pro_welcomed:' + String(this.calendar.id).toLowerCase();
            try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (e) { return; }
            this.showToast(`Upgraded with ${planName(this.proPlan)}. Everyone can view; only people with your editor link can edit.`, 'info', {
                actionLabel: 'Editor link', action: () => { if (!this.showPlus) this.openPlusTab('share'); }, duration: 10000,
            });
        },
        showPlus(open) {
            if (!open) { this.proSurface = 'share'; this.plusAutoJoin = false; return; }
            if (this.isExisting && !this.lock.locked && this.canEdit) this.refreshProTrial();
        },
        showProStats(open) { this.focusInsight(open, 'proStatsPanel'); },
        showProHistory(open) { this.focusInsight(open, 'proHistoryPanel'); },
        // The grid re-lays out on any container resize (mounted); this is the explicit nudge
        // for the moment the panel docks or undocks.
        sideDocked() {
            this.$nextTick(() => { if (this.calView) this.calView.refreshLayout(); });
        },
        // A question on the native calendar: its main button takes the focus, so Enter answers and Escape cancels.
        // A phone's sheet: the calendar behind it is out of reach until it closes (the scrim closes it).
        nativeCard(c) {
            const cal = document.querySelector('.pc-native-cal');
            if (!cal) return;
            const sheet = !!c && window.innerWidth <= 760;
            if (sheet) cal.setAttribute('inert', ''); else cal.removeAttribute('inert');
            document.documentElement.classList.toggle('nk-sheet-open', sheet);
        },
        nativeAsk(ask) {
            if (ask) this.$nextTick(() => { const b = document.querySelector('.pc-native-ask .pc-btn--primary'); if (b) b.focus(); });
        },
        // The native month fills the window once the page around it (title, footer line) is in.
        isLoading(loading) {
            if (!loading && this.nativeCal) this.$nextTick(() => this.fitNativeMonthRows());
        },
        viewerNotesPinnable: {
            immediate: true,
            handler(pin) {
                if (!pin || this._notesPinned) return;
                this._notesPinned = true;
                // Only where it docks: over a phone's calendar it would hide what they came to see.
                if (!this.sideWide || this.sideTab || this.notesHiddenHere()) return;
                this.showNotes = true;
            },
        },

        showShare(newValue) {
            if (!newValue) { this.showViewHelp = false; }
            if (newValue) {
                this.updateCurrentViewURL();
                this.startUpdateLinkTimer();
            } else {
                this.stopUpdateLinkTimer();
            }
        },

        editTitle(newValue) {
            // Auto-focus the title input when entering edit mode
            if (newValue) {
                this.$nextTick(() => {
                    if (this.$refs.mobileTitleInput) {
                        this.$refs.mobileTitleInput.focus();
                        this.$refs.mobileTitleInput.select();
                    }
                });
            }
        },

        calendar: {
            // sync changes to local storage or firebase
            handler: function (newVal, oldVal) {
                // console.log("Vue:watch:calendar", newVal, oldVal);

                // A remote snapshot lands here too: import() mutates `calendar`, which
                // fires this watcher, which used to write the server's own data straight
                // back. That turned every open tab into an amplifier -- one stale write
                // was re-committed by everyone watching, so a deleted event could come
                // back and a fresh edit could be reverted by a bystander's echo. Applying
                // a remote change is not a local edit and must not be published as one.
                // Skip the write only if the calendar still looks exactly as the remote
                // snapshot left it. If the user changed something in the same batch, that
                // edit is real and must be published -- suppressing it would trade the
                // echo bug for a silent lost edit.
                if (this.isApplyingRemote
                    && JSON.stringify(this.calendar.events || []) === this.remoteAppliedSignature) {
                    this.updateCalendarView();
                    return;
                }

                if (!this.isExisting) {
                    this.saveLocalStorage();
                } else {
                    this.saveLocalBackup();
                    // because calendar.options.notes may be noisy
                    CalendarDataService.debounce_sync(this.calendar);
                }
                this.updateCalendarView();
            },
            deep: true
        },
        'calendar.options.extended'(val) {
            // No need to call CalendarDataService.sync here as the calendar watcher will handle that
            console.log("calendar.options.extended changed", val);
            // Apply extended hour setting immediately
            if (window.scheduleObj) {
                scheduleObj.startHour = val ? "00:00" : this.globalSettings.startHour;
            }
        },

        // Initialize custom view defaults when Custom is selected
        'globalSettings.defaultView'(newVal) {
            if (newVal === 'Custom') {
                if (this.globalSettings.customViewDuration === undefined) {
                    this.globalSettings.customViewDuration = 3;
                }
                if (this.globalSettings.customViewUnit === undefined) {
                    this.globalSettings.customViewUnit = 'Months';
                }
            }
        },

        'calendar.options.defaultView'(newVal) {
            if (newVal === 'Custom') {
                const hasOptions = !!this.calendar.options;
                const existingOptions = hasOptions ? this.calendar.options : {};
                const normalizedOptions = { ...existingOptions };
                let shouldReplace = !hasOptions;

                if (!('customViewDuration' in normalizedOptions) || normalizedOptions.customViewDuration === undefined) {
                    normalizedOptions.customViewDuration = this.globalSettings.customViewDuration ?? 3;
                    shouldReplace = true;
                }
                if (!('customViewUnit' in normalizedOptions) || normalizedOptions.customViewUnit === undefined) {
                    normalizedOptions.customViewUnit = this.globalSettings.customViewUnit ?? 'Months';
                    shouldReplace = true;
                }

                if (shouldReplace) {
                    this.calendar.options = normalizedOptions;
                }
            }
        },

        colorFilters: {
            handler() { this.updateCalendarView(); },
            deep: true
        },

        // Watch for changes to custom view settings and update schedule
        'globalSettings.customViewDuration'(newVal, oldVal) {
            if (oldVal !== undefined && newVal !== oldVal) {
                this.updateCustomViewInSchedule(true);
            }
        },
        'globalSettings.customViewUnit'(newVal, oldVal) {
            if (oldVal !== undefined && newVal !== oldVal) {
                this.updateCustomViewInSchedule(true);
            }
        },
        'calendar.options.customViewDuration'(newVal, oldVal) {
            if (oldVal !== undefined && newVal !== oldVal) {
                this.updateCustomViewInSchedule(true);
            }
        },
        'calendar.options.customViewUnit'(newVal, oldVal) {
            if (oldVal !== undefined && newVal !== oldVal) {
                this.updateCustomViewInSchedule(true);
            }
        }
    },



    methods: {
        // ============================================================
        // REGION: The calendar on screen (services/CalendarView.js)
        // ============================================================

        // The native calendar's event popup: beside the event that was clicked, kept on screen.
        openNativePopover({ event, occurrence, jsEvent }) {
            const el = jsEvent && jsEvent.target && jsEvent.target.closest ? jsEvent.target.closest('[data-testid^="event-"]') : null;
            const r = el ? el.getBoundingClientRect() : { left: 16, right: 16, top: 80, bottom: 80 };
            const w = Math.min(360, window.innerWidth - 16), h = 200;
            const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
            const top = r.bottom + h + 8 < window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6);
            this.nativePopover = { event, occurrence, top, left };
            this.$nextTick(() => this.fitNativePopover());
        },
        /** The popup kept inside the window, whatever its details' length (Show all can make it taller). */
        fitNativePopover() {
            const p = this.nativePopover, el = document.querySelector('.np');
            if (!p || !el) return;
            const h = el.offsetHeight;
            if (p.top + h > window.innerHeight - 8) p.top = Math.max(8, window.innerHeight - 8 - h);
        },
        // The native calendar's page wiring. A press outside the open popup closes it and does nothing else (as on
        // the classic calendar), unless it lands on another event; Escape closes it too. The month fills the window.
        watchNativeCalendar() {
            let closedAtPress = false;
            document.addEventListener('pointerdown', (e) => {
                const inside = (sel) => !!(e.target.closest && e.target.closest(sel));
                // The event card: a press outside it (and its pickers, the question, the toast) closes it, keeping
                // what was saved, and does nothing else: no new event, no drag (the press's mouse events never reach
                // the calendar, and its click is swallowed below).
                if (this.nativeCard && !inside('.nk-card, .nk-pick, .nk-menu, .pc-native-ask, .pc-toast-wrap')) {
                    const cal = inside('.nc') || inside('.nk-scrim');
                    this.nativeCardDone();
                    if (cal) { closedAtPress = true; this._nativeCardClosedAt = true; e.preventDefault(); e.stopPropagation(); }
                    return;
                }
                // The quick box closes the same way (its "New event" block goes with it), unless the press is in the
                // question or the editor it may have opened.
                const quick = !!this.nativeQuick && !inside('.nq, .ne-overlay, .pc-native-ask');
                closedAtPress = (!!this.nativePopover && !inside('.np, .pc-native-ask, .ne-overlay')) || quick;
                if (closedAtPress) this.nativePopover = null;
                if (quick) this.nativeQuick = null;
            }, true);
            document.addEventListener('click', (e) => {
                if (closedAtPress && e.target.closest && e.target.closest('.nc, .nk-scrim') && (this._nativeCardClosedAt === true || !e.target.closest('[data-testid^="event-"]'))) { e.stopPropagation(); e.preventDefault(); }
                this._nativeCardClosedAt = false;
                closedAtPress = false;
            }, true);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.nativePopover = null; });
            if (this.nativeEdit) document.addEventListener('keydown', (e) => this.onNativeKey(e));
            // A locked calendar ignores a double-click on a day: say why (as classic does).
            document.addEventListener('dblclick', (e) => {
                if (this.lockedOut && e.target.closest && e.target.closest('.nc-cell, .nc-col, .nc-allday-cell')) this.showToast(this.lockedOutMessage, 'info');
            });
            let fitTimer = null;
            window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => this.fitNativeMonthRows(), 150); });
        },
        // Wide screens: the month grid fills the window instead of stopping at 5-6 rows of 100px with empty page
        // below (the classic calendar's fitMonthRows). Rows grow, never shrink below 100px.
        fitNativeMonthRows() {
            const cal = document.querySelector('.pc-native-cal');
            const rows = cal ? cal.querySelectorAll('.nc-week-row') : [];
            if (!rows.length) return;
            let h = 100;
            if (window.innerWidth >= 1100) {
                const rect = cal.getBoundingClientRect();
                const chrome = rect.height - rows[0].getBoundingClientRect().height * rows.length;
                const foot = document.querySelector('.pc-home-cal > .pc-view-footer, .pc-home-cal > .pc-edit-footer, .pc-home-cal > .pc-hosted-note');
                const cs = foot && getComputedStyle(foot);
                const footH = foot ? foot.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom) : 0;
                h = Math.max(100, Math.floor((window.innerHeight - (rect.top + window.scrollY) - 12 - chrome - footH) / rows.length));
            }
            if (Math.abs(this.nativeRowHeight - h) >= 2) this.nativeRowHeight = h;
        },
        eventTextOn(color) { return ScheduleAdapter.onColor(color); },
        // ---- "Try the new calendar (beta)" (CalSwitch in the footer) ----
        // This browser's choice of calendar, then a reload into it. The head script in index.html reads
        // localStorage pc_cal before anything loads (so no flash, and no Syncfusion download in native mode); the
        // same value also goes in a cookie (a year, whole site) so the Worker could see the choice one day, e.g. to
        // send the right first byte. Nothing on the server reads it today, and nothing may depend on it: storage
        // is the source of truth. "Back to classic" stores 'classic' rather than clearing: with nothing stored, a
        // view link falls back to the server's default (<meta name="pc-cal">, NATIVE_VIEW_LINKS), which may be native.
        // A ?cal= in the address would win over the stored choice, so it is dropped before reloading.
        setCalPref(pick, source) {
            const value = pick === 'native' ? 'native' : 'classic';
            try { localStorage.setItem('pc_cal', value); } catch (e) { /* storage blocked: the ?cal= below still switches this page */ }
            try { document.cookie = `pc_cal=${value}; Max-Age=31536000; Path=/; SameSite=Lax` + (location.protocol === 'https:' ? '; Secure' : ''); } catch (e) { }
            track(a => a.newUi(value === 'native' ? 'opt_in' : 'opt_out', source, true));
            const url = new URL(location.href);
            url.searchParams.delete('cal');
            // Storage blocked (some private modes): carry the choice in the address for this page at least.
            let stored = null; try { stored = localStorage.getItem('pc_cal'); } catch (e) { }
            if (stored !== value) url.searchParams.set('cal', value);
            location.replace(url.toString());
        },
        hideCalPill() {
            this.calPillHidden = true;
            try { sessionStorage.setItem('pc_cal_pill_hidden', '1'); } catch (e) { }
        },
        openCalFeedback() {
            this.calFeedback = { text: '', email: '', website: '', openedAt: Date.now(), sending: false, error: '', sent: false };
            track(a => a.newUi('feedback_open', 'pill'));
            this.$nextTick(() => { const t = document.querySelector('[data-testid="cal-feedback-text"]'); if (t) t.focus(); });
        },
        // Sent through the contact form's endpoint (/api/contact: same-site, honeypot, fill time, 5 an hour) as an
        // 'idea', the message prefixed with where it came from. Never the calendar or its events: only the page
        // kind, the browser and OS family, and the screen width.
        async sendCalFeedback() {
            const f = this.calFeedback;
            if (!f || f.sending || !f.text.trim()) return;
            const ua = navigator.userAgent;
            const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other browser';
            const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS'
                : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'other OS';
            const where = `[New calendar (beta) feedback: ${this.isReadOnly ? 'view link' : 'edit link'}, ${browser} on ${os}, ${window.innerWidth}px wide]`;
            f.sending = true; f.error = '';
            try {
                const res = await fetch('/api/contact', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'idea', message: `${where}\n\n${f.text.trim()}`, email: f.email.trim(), website: f.website, elapsed: Date.now() - f.openedAt }),
                });
                let body = null; try { body = await res.json(); } catch (e) { }
                if (res.ok && body && body.ok !== false) {
                    f.sent = true;
                    track(a => a.newUi('feedback_sent', 'pill'));
                } else f.error = (body && body.error) || 'That didn\'t send. Try again in a moment.';
            } catch (e) {
                f.error = 'That didn\'t send. Check your connection and try again.';
            } finally { f.sending = false; }
        },
        // The dates on the native calendar changed: what depends on them recomputes (hidden-events count).
        onNativeRange() {
            this.viewTick++;
            this.nativePopover = null;
            this.nativeQuick = null;
            this.$nextTick(() => this.fitNativeMonthRows());
        },

        // ---- Editing on the native calendar (a native edit link) ------------------------------------------------
        // Every write goes through commitScheduleAction in the record shapes classic's grid produces
        // (ScheduleAdapter.toView / toCommand), so the repeat-exception stamps, all-day dates, "this event / all
        // events", the merge that saves only the fields the person changed (noteStart, when they began), undo,
        // Recent changes and analytics are classic's own. Nothing here writes the event list itself.

        /** The stored row an event on the grid stands for (the grid may hold a display copy of it). */
        nativeStored(ev) {
            if (!ev) return null;
            return (this.calendar.events || []).find((e) => e && String(e.id) === String(ev.id)
                && String(e.recurrenceID ?? '') === String(ev.recurrenceID ?? '')) || null;
        },
        /** The series a row belongs to: itself for a repeating event, its parent for an edited occurrence. */
        nativeSeriesOf(row) {
            if (!row) return null;
            const id = !isBlankId(row.recurrenceID) ? row.recurrenceID : (row.recurrencerule ? row.id : null);
            if (id === null) return null;
            return (this.calendar.events || []).find((e) => e && String(e.id) === String(id) && isBlankId(e.recurrenceID)) || null;
        },
        /** 'single', 'series' (a repeating event) or 'edited' (one occurrence edited on its own, a row of its own). */
        /** A rule too big to expand (EventStore.unsafeRecurrence) is drawn once, so it is edited and deleted as one event. */
        nativeKind(row) {
            if (!row) return null;
            if (!isBlankId(row.recurrenceID)) return 'edited';
            return row.recurrencerule && !(typeof EventStore !== 'undefined' && EventStore.unsafeRecurrence?.(row.recurrencerule)) ? 'series' : 'single';
        },
        /** A stored row as classic's grid record (an edited occurrence is read beside its series, whose grid its slot is in). */
        nativeRecord(row) {
            const series = this.nativeKind(row) === 'edited' ? this.nativeSeriesOf(row) : null;
            const rec = { ...ScheduleAdapter.toView(series ? [row, series] : [row])[0] };
            // Native reads the rule itself (rrule.js), not Syncfusion's every-12-months stand-in for a yearly one (#48).
            if (rec._gridRule) { rec.RecurrenceRule = rec._gridRule.rule; delete rec._gridRule; }
            return rec;
        },
        /** One native action -> the shared write path. */
        nativeAction(requestType, records, context) {
            return this.commitScheduleAction({ requestType, addedRecords: [], changedRecords: [], deletedRecords: [], ...records }, context);
        },
        /** The calendar can't be changed here: say why (as classic does on a locked calendar). */
        nativeCanEdit() {
            if (this.canEdit && !this.isReadOnly) return true;
            if (this.lockedOut) this.showToast(this.lockedOutMessage, 'info');
            return false;
        },
        /** "This event / All events" for a repeating event (classic asks the same before it edits, moves or deletes one). */
        nativeAskScope(title, onThis, onAll, ok = 'OK', onCancel = null) {
            this.nativeAsk = { title, choice: 0, ok, cancel: onCancel, options: [
                { label: 'This event', testid: 'scope-this', action: onThis },
                { label: 'All events', testid: 'scope-all', action: onAll },
            ] };
        },
        /** The open question's answer: an option and OK, a button, or (null) Cancel. */
        nativeAnswer(button) {
            const ask = this.nativeAsk;
            this.nativeAsk = null;
            if (!ask) return;
            const c = this.nativeCard;
            if (button === null) { if (ask.cancel) ask.cancel(); this._nativeMoveToast = null; }
            else (button || ask.options[ask.choice]).action();
            if (this._nativeMoveToast) this.nativeMoveToast();   // a drop that asked first: its toast now
            if (this.nativeCard) this.$nextTick(() => this.nativeCardRefresh());   // (what changed elsewhere while it asked)
            if (c && c.closeAfterAsk && this.nativeCard === c && !this.nativeAsk) this.closeNativeCard();
        },

        // The quick box: a click (or a drag) on an empty part of the grid. A double-click opens the full editor.
        onNativeCreate({ start, end, isAllDay, event: jsEvent, full }) {
            if (!this.nativeEdit || !this.nativeCanEdit()) return;
            this.nativePopover = null;
            // The event card (EventCard.js): beside the new event's block, a sheet on a phone.
            if (typeof EventCard !== 'undefined') { this.openNativeNewCard({ start, end, isAllDay, jsEvent, full }); return; }
            if (full) { this.nativeQuick = null; this.openNativeEditor({ mode: 'Add', fresh: { start, end, isAllDay, title: '' } }); return; }
            // Beside the day (time grid) or under it (month), so the "New event" block stays in view; a phone shows
            // the box as a sheet along the bottom instead (native-calendar.css).
            const w = Math.min(364, window.innerWidth - 16), h = 180, pad = 8;
            const x = jsEvent && jsEvent.clientX != null ? jsEvent.clientX : window.innerWidth / 2;
            const y = jsEvent && jsEvent.clientY != null ? jsEvent.clientY : 120;
            const box = jsEvent && jsEvent.target && jsEvent.target.closest ? jsEvent.target.closest('.nc-col, .nc-cell, .nc-allday-cell') : null;
            const r = box ? box.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y };
            let left, top;
            if (box && box.classList.contains('nc-col')) {
                left = r.right + pad + w < window.innerWidth ? r.right + pad : r.left - pad - w;
                top = y - h / 2;
            } else {
                left = r.left;
                top = r.bottom + pad + h < window.innerHeight ? r.bottom + pad : r.top - pad - h;
            }
            left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
            top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
            this.nativeQuick = { start, end, isAllDay, title: '', top, left };
        },
        saveNativeQuick(title) {
            const q = this.nativeQuick;
            if (!q) return;
            this.nativeQuick = null;
            // No title: "(No title)", as the editor saves it (classic stores Syncfusion's placeholder, "Add title").
            this.nativeAction('eventCreate', { addedRecords: [{ Subject: title || '(No title)', StartTime: new Date(q.start), EndTime: nativeEnd(q.end, q.isAllDay),
                IsAllDay: !!q.isAllDay, Type: 1, Description: '', RecurrenceRule: '' }] }, { action: 'Add' });
        },
        moreNativeQuick(title) {
            const q = this.nativeQuick;
            if (!q) return;
            this.nativeQuick = null;
            this.openNativeEditor({ mode: 'Add', fresh: { ...q, title } });
        },

        /**
         * The full editor. mode: 'Add' (fresh: { start, end, isAllDay, title }), 'Save' (row: a single event or an
         * edited occurrence), 'EditOccurrence' (row: the series; occurrence: { start, end } of the one clicked), or
         * 'EditSeries' (row: the series). The record it starts from is noted (ScheduleAdapter.noteStart), so Save
         * writes only what changed since now: a field someone else changes meanwhile is kept (finding D1).
         */
        openNativeEditor({ mode, row = null, occurrence = null, fresh = null }) {
            if (!this.nativeCanEdit()) return;
            this.nativePopover = null;
            this.nativeQuick = null;
            let record;
            if (mode === 'Add') {
                record = { Subject: fresh.title || '', StartTime: new Date(fresh.start), EndTime: nativeEnd(fresh.end, fresh.isAllDay),
                    IsAllDay: !!fresh.isAllDay, Type: 1, Description: '', RecurrenceRule: '' };
            } else {
                if (!row) return;
                record = this.nativeRecord(row);
                // One occurrence: a new row pointing at the series, at the occurrence's time (classic's EditOccurrence).
                if (mode === 'EditOccurrence') Object.assign(record, { Id: NATIVE_OCCURRENCE_ID, RecurrenceID: record.Id,
                    StartTime: new Date(occurrence.start), EndTime: new Date(occurrence.end) });
                // The whole series, as classic's record has it: RecurrenceID = its own id.
                if (mode === 'EditSeries') record.RecurrenceID = record.Id;
                ScheduleAdapter.noteStart(record);
            }
            const shown = { id: mode === 'Add' ? null : record.Id, title: record.Subject || '', description: record.Description || '',
                type: record.Type || 1, isAllDay: !!record.IsAllDay, start: record.StartTime, end: record.EndTime,
                recurrencerule: record.RecurrenceRule || '', recurrenceID: mode === 'Save' ? (record.RecurrenceID || null) : null,
                ...(mode === 'EditOccurrence' ? { _occurrenceOf: record.RecurrenceID } : {}) };
            // Frozen: the form loads once, and a live update from another browser never resets what is being typed.
            this.nativeEditor = { mode, record, occurrence, event: Object.freeze(shown) };
            this.editorSaved = false;
        },
        closeNativeEditor() {
            if (!this.nativeEditor) return;
            // An editor that closes without a save is the "this was confusing or fiddly" signal (as classic's popupClose).
            if (!this.editorSaved) track(a => a.editorAbandoned());
            this.editorSaved = false;
            this.nativeEditor = null;
        },
        saveNativeEditor(data) {
            const ed = this.nativeEditor;
            if (!ed) return;
            const allDay = !!data.isAllDay;
            const record = { ...ed.record, Subject: data.title, Description: data.description, Type: Number(data.type) || 1,
                IsAllDay: allDay, StartTime: new Date(data.start), EndTime: nativeEnd(data.end, allDay) };
            if (ed.mode !== 'EditOccurrence') record.RecurrenceRule = data.recurrencerule || '';
            const finish = (ok) => {
                if (ok) { this.editorSaved = true; this.closeNativeEditor(); return; }
                // The series went (someone else deleted it) while this editor was open: nothing left to edit; the
                // toast says why.
                const seriesId = ed.mode === 'EditOccurrence' ? ed.record.RecurrenceID : ed.mode === 'EditSeries' ? ed.record.Id : null;
                if (seriesId !== null && !this.nativeStored({ id: seriesId })) this.closeNativeEditor();
            };
            if (ed.mode === 'Add') return finish(this.nativeAction('eventCreate', { addedRecords: [record] }, { action: 'Add' }));
            if (ed.mode === 'Save') return finish(this.nativeAction('eventChange', { changedRecords: [record] }, { action: 'Save' }));
            if (ed.mode === 'EditOccurrence') {
                return finish(this.nativeAction('eventChange', { changedRecords: [record] }, { action: 'EditOccurrence', occurrenceStart: ed.occurrence.start }));
            }
            // The whole series. Classic asks first whenever the series has skipped dates or separately edited
            // occurrences, and the answer decides whether they survive (ScheduleAdapter.toCommand, keepOccurrences).
            const series = this.nativeSeriesOf(this.nativeStored({ id: ed.record.Id }));
            const time = (v) => new Date(v).getTime();
            const timing = time(record.StartTime) !== time(ed.record.StartTime) || time(record.EndTime) !== time(ed.record.EndTime)
                || !!record.IsAllDay !== !!ed.record.IsAllDay || String(record.RecurrenceRule || '') !== String(ed.record.RecurrenceRule || '');
            this.nativeSaveSeries(series, record, { timing }, finish);
        },
        // ---- "All events": the one path every series change takes (a drag, the card, the editor) ----
        /**
         * The series' record moved as one of its occurrences moved (from / to: { start, end }): by as much, in
         * wall-clock days and minutes (a DST change in between keeps the clock time), from the series' own start (an
         * earlier occurrence is never dropped), its repeat days and UNTIL moving with it (CalendarView.edits.shiftRule).
         */
        nativeSeriesMoved(series, from, to) {
            const rec = this.nativeRecord(series);
            rec.RecurrenceID = rec.Id;
            ScheduleAdapter.noteStart(rec);
            // A series in its own zone moves by that zone's days and minutes (its repeat days are that zone's).
            const z = this.nativeCardZone({ tz: rec.Tz, isAllDay: rec.IsAllDay });
            const shift = nativeShift(from.start, to.start, z), stretch = nativeShift(from.end, to.end, z);
            return { ...rec, StartTime: shift(rec.StartTime), EndTime: stretch(rec.EndTime),
                RecurrenceRule: nativeShiftRule(rec.RecurrenceRule, from.start, to.start, z) };
        },
        /**
         * Save an "all events" change (record: the series' record as it should be). A series with skipped dates or
         * edited occurrences keeps them without asking when its dates are untouched (a rename, a color, the details:
         * asking let "rename, Enter, Enter" wipe them); a time or repeat change (timing) asks classic's question,
         * keep focused. shift ({ from, to }, the series moved): kept stamps and UNTIL move with it (ScheduleAdapter).
         * keep: an answer already given (the card asks once). done(ok, keepOccurrences, asked) runs once saved;
         * cancel if the question is cancelled.
         */
        nativeSaveSeries(series, record, { timing, shift = null, keep = null, cancel = null }, done = () => {}) {
            const save = (keepOccurrences, asked = false) => done(this.nativeAction('eventChange', { changedRecords: [record] },
                { action: 'EditSeries', keepOccurrences, ...(shift ? { shift } : {}) }), keepOccurrences, asked);
            if (!this.nativeHasOwn(series)) return save(false);
            if (!timing) return save(true);
            if (keep !== null) return save(keep);
            this.nativeAskSeriesChange((k) => save(k, true), cancel);
        },
        // Classic's "match every occurrence to the series again?". Keeping them ("No") is the primary, focused
        // answer, so Enter never deletes anyone's edits; clearing them takes a deliberate click.
        nativeAskSeriesChange(save, cancel = null) {
            this.nativeAsk = { title: 'Edit event', message: NATIVE_SERIES_CHANGE, cancel,
                buttons: [
                    { label: 'Yes', testid: 'confirm-yes', action: () => save(false) },
                    { label: 'No', testid: 'confirm-no', primary: true, action: () => save(true) },
                ] };
        },

        // The popup's pencil (or its date line), the editor of a search result: which event, and for a repeating one
        // which part of it (classic's "Edit event / Entire series" question).
        nativeEditEvent(ev, occurrence) {
            const row = this.nativeStored(ev);
            if (!row || !this.nativeCanEdit()) return;
            this.nativePopover = null;
            const kind = this.nativeKind(row), series = this.nativeSeriesOf(row);
            if (kind === 'single' || ((kind === 'edited') && !series)) return this.openNativeEditor({ mode: 'Save', row });
            if (kind === 'series' && !occurrence) return this.openNativeEditor({ mode: 'EditSeries', row });
            const forThis = kind === 'edited' ? () => this.openNativeEditor({ mode: 'Save', row })
                : () => this.openNativeEditor({ mode: 'EditOccurrence', row, occurrence });
            this.nativeAskScope('Edit recurring event', forThis, () => this.openNativeEditor({ mode: 'EditSeries', row: series }));
        },
        // The popup's or the editor's Delete: no "Are you sure?" (the Undo toast covers it), but a repeating event asks
        // which part, as classic does.
        nativeDeleteEvent(ev, occurrence, fromEditor = null) {
            const row = this.nativeStored(ev) || (fromEditor && fromEditor.mode === 'EditOccurrence' ? this.nativeStored({ id: fromEditor.record.RecurrenceID }) : null);
            if (!row || !this.nativeCanEdit()) return;
            this.nativePopover = null;
            const kind = this.nativeKind(row), series = this.nativeSeriesOf(row);
            const done = () => { if (fromEditor) { this.editorSaved = true; this.closeNativeEditor(); } };
            const removeRow = () => { this.nativeAction('eventRemove', { deletedRecords: [this.nativeRecord(row)] }, { action: 'Delete' }); done(); };
            const removeSeries = () => {
                const rec = this.nativeRecord(series);
                rec.RecurrenceID = rec.Id;
                this.nativeAction('eventRemove', { deletedRecords: [rec] }, { action: 'DeleteSeries' });
                done();
            };
            const removeOne = (when) => {
                const rec = this.nativeRecord(series);
                rec.RecurrenceID = rec.Id;
                rec.StartTime = new Date(when);
                this.nativeAction('eventRemove', { changedRecords: [rec] }, { action: 'DeleteOccurrence', occurrenceStart: new Date(when) });
                done();
            };
            if (kind === 'single' || !series) return removeRow();
            // From the editor the question was already answered when it opened.
            if (fromEditor) {
                if (fromEditor.mode === 'EditOccurrence') return removeOne(fromEditor.occurrence.start);
                if (fromEditor.mode === 'EditSeries') return removeSeries();
                return removeRow();
            }
            if (kind === 'series' && !occurrence) return removeSeries();
            this.nativeAskScope('Delete recurring event', kind === 'edited' ? removeRow : () => removeOne(occurrence.start), removeSeries, 'Delete');
        },
        // Whether people categorise events at all decides if type labels are worth building on (classic sends it too).
        onNativeColor() { track(a => a.featureUsed('event_type', 'popup')); },
        // A double-click on an event opens its editor (classic's grid does the same).
        onNativeOpen({ event, occurrence }) { if (typeof EventCard !== 'undefined') return this.openNativeCard({ event, occurrence }, true); this.nativeEditEvent(event, occurrence); },
        onNativePopoverEdit() {
            const p = this.nativePopover;
            if (p) this.nativeEditEvent(p.event, p.occurrence);
        },
        onNativePopoverDelete() {
            const p = this.nativePopover;
            if (p) this.nativeDeleteEvent(p.event, p.occurrence);
        },
        onNativeEditorDelete() {
            const ed = this.nativeEditor;
            if (!ed) return;
            const ev = ed.mode === 'EditOccurrence' ? { id: ed.record.RecurrenceID } : { id: ed.record.Id, recurrenceID: ed.mode === 'EditSeries' ? null : ed.record.RecurrenceID };
            this.nativeDeleteEvent(ev, ed.occurrence, ed);
        },

        // Drag and resize. The event as it was when the drag began is the merge's starting point.
        onNativeDragStart({ event }) {
            if (this.nativeCard) this.nativeCardDone();
            const row = this.nativeStored(event);
            this._nativeDragFrom = row ? { ...row } : null;
        },
        onNativeMove({ event, occurrence, start, end }) {
            const row = this.nativeStored(event);
            const from = this._nativeDragFrom && row && String(this._nativeDragFrom.id) === String(row.id)
                && String(this._nativeDragFrom.recurrenceID ?? '') === String(row.recurrenceID ?? '') ? this._nativeDragFrom : row;
            this._nativeDragFrom = null;
            if (!row || !this.nativeCanEdit()) return;
            const kind = this.nativeKind(row), series = this.nativeSeriesOf(row);
            const moveRow = () => {
                const rec = this.nativeRecord(from);
                ScheduleAdapter.noteStart(rec);
                this.nativeAction('eventChange', { changedRecords: [{ ...rec, StartTime: start, EndTime: end }] }, { action: 'Save' });
            };
            if (kind === 'single' || !series) return moveRow();
            const moveOne = () => {
                const rec = this.nativeRecord(series);
                Object.assign(rec, { Id: NATIVE_OCCURRENCE_ID, RecurrenceID: rec.Id, StartTime: start, EndTime: end });
                this.nativeAction('eventChange', { changedRecords: [rec] }, { action: 'EditOccurrence', occurrenceStart: occurrence.start });
            };
            // All events (classic's drag moves only the one occurrence and never asks; Google asks): the series moves
            // by as much as this occurrence did, in wall-clock days and minutes (a DST change in between keeps the
            // clock time), and its repeat days move with it (weekly on Tuesdays dragged to a Wednesday repeats on
            // Wednesdays). A series with skipped dates or edited occurrences asks classic's own question first, as
            // its editor does for any series change: they match the series again, or they are kept.
            const moveAll = () => {
                // An edited occurrence is drawn at its edited time; the series moves from the slot it stands for (its
                // exception stamp, read in the grid's frame as toView reads it).
                const slot = kind === 'edited' ? ScheduleAdapter.stampDate(series.isAllDay
                    ? Event.allDayExceptionsToLocal(row.recurrenceException) : row.recurrenceException) : null;
                const fromStart = slot || new Date(occurrence.start);
                const fromEnd = slot ? new Date(slot.getTime() + (new Date(occurrence.end) - new Date(occurrence.start))) : occurrence.end;
                const moved = this.nativeSeriesMoved(series, { start: fromStart, end: fromEnd }, { start, end });
                this.nativeSaveSeries(series, moved, { timing: true, shift: { from: fromStart, to: start } });
            };
            this.nativeAskScope('Edit recurring event', kind === 'edited' ? moveRow : moveOne, moveAll);
        },
        /** Skipped dates or separately edited occurrences: what an "all events" change can reset. */
        nativeHasOwn(series) {
            return !!series && (!isBlankId(series.recurrenceException)
                || (this.calendar.events || []).some((e) => e && !isBlankId(e.recurrenceID) && String(e.recurrenceID) === String(series.id)));
        },
        // ---- The event card (nativecal/components/EventCard.js), a native edit link's editor ----------------------
        // One card for a new event and an existing one. Changes to an existing event are saved the moment they are
        // made, each through the write path above (commitScheduleAction, in classic's record shapes), from the row
        // as it is just then (noteStart), so only the field that changed is written and someone else's change made
        // meanwhile is kept. Each change gets a toast with Undo (the store's own inverse). Cancel (or Escape) takes
        // back every change made since the card opened; a new event is a draft until Done.
        //
        // nativeCard: { key, isNew, full, canRepeat, value, anchor, edited, place,
        //               target: { kind: 'new' | 'row' | 'occ' | 'series', id, recurrenceID, seriesId, occurrence },
        //               keepOccurrences, entries: [{ entry (a store undo entry), before: { target, value, canRepeat } }] }
        //   kind 'row': a single event or an edited occurrence (its own row); 'occ': one occurrence of a series, not yet
        //   asked "this event / all events"; 'series': the whole series (asked, or opened from a search result).

        /** A stored row (or one occurrence of it) as the card's value. All day: the first and the LAST day, at midnight here. */
        nativeCardValue(row, occurrence) {
            const rec = this.nativeRecord(row);
            const value = { title: rec.Subject || '', type: Number(rec.Type) || 1, description: rec.Description || '', isAllDay: !!rec.IsAllDay, rule: rec.RecurrenceRule || '', tz: rec.Tz || '' };
            let start = new Date(occurrence ? occurrence.start : rec.StartTime), end = new Date(occurrence ? occurrence.end : rec.EndTime);
            if (value.isAllDay) {
                // (Dates: read and made in this browser's wall clock, cardKit, never a local Date built from parts.)
                const here = EventZone.localZone(), s = cardKit.wallOf(start, here), e = cardKit.wallOf(end, here);
                const exclusive = !cardKit.minutesOf(e) && !e.getUTCSeconds() && !e.getUTCMilliseconds();
                start = cardKit.instantOf(cardKit.startOfDay(s), here);
                end = cardKit.instantOf(cardKit.addDays(cardKit.startOfDay(e), exclusive ? -1 : 0), here);
                if (end < start) end = new Date(start);
            }
            return { ...value, start, end };
        },
        // ---- The card's start and end are instants. It shows and edits them as wall clock values in the event's own zone
        // (services/EventZone.js), or this browser's (EventCard wv, cardKit): "2:00 PM" typed with Tokyo picked means
        // 2 PM in Tokyo, and 2:30 AM in Tokyo exists on the day Los Angeles springs forward (stress S01).
        /** The event's own zone for a card value's times, or null (none, or all day: dates are dates). */
        nativeCardZone(v) { return v && v.tz && !v.isAllDay && typeof EventZone !== 'undefined' ? EventZone.validZone(v.tz) : null; },
        /** The instants a card value stands for (all day: the first and the last day's midnights, here). */
        nativeCardInstants(v) { return { start: new Date(v.start), end: new Date(v.end) }; },
        /** The same instants, shown in zone `tz` ('' = this browser's own). */
        nativeCardRezone(v, tz) { return { ...v, tz: tz || '' }; },
        /** The card's start / end in the shapes classic's records carry (an all-day end: the next midnight here). */
        nativeCardTimes(v) {
            if (!v.isAllDay) return { StartTime: new Date(v.start), EndTime: new Date(v.end) };
            const here = EventZone.localZone(), day = (x, n) => cardKit.instantOf(cardKit.addDays(cardKit.startOfDay(cardKit.wallOf(x, here)), n), here);
            return { StartTime: day(v.start, 0), EndTime: day(v.end, 1) };
        },
        /** The fields a change touched, as record fields. */
        nativeCardFields(before, after) {
            const same = (a, b) => (a instanceof Date || b instanceof Date) ? new Date(a).getTime() === new Date(b).getTime() : a === b;
            const out = {};
            if (!same(before.title, after.title)) out.Subject = after.title;
            if (!same(before.type, after.type)) out.Type = Number(after.type) || 1;
            if (!same(before.description, after.description)) out.Description = after.description;
            if (!same(before.rule, after.rule)) out.RecurrenceRule = after.rule || '';
            if ((before.tz || '') !== (after.tz || '')) out.Tz = after.tz || '';
            // (Compared as instants: the same time shown in another zone is not a change of time.)
            const a = this.nativeCardInstants(before), b = this.nativeCardInstants(after);
            if (!same(a.start, b.start) || !same(a.end, b.end) || before.isAllDay !== after.isAllDay) Object.assign(out, { IsAllDay: !!after.isAllDay }, this.nativeCardTimes(after));
            return out;
        },
        nativeCardClone(v) { return { ...v, start: new Date(v.start), end: new Date(v.end) }; },
        /** A record with the card's fields on it. Switching All day changes what its stored times mean, so the stored
         *  text they were read from (_storedStart/_storedEnd, kept verbatim when the meaning is unchanged) goes. */
        nativeCardApply(rec, fields) {
            const out = { ...rec, ...fields };
            if ('IsAllDay' in fields && !!fields.IsAllDay !== !!rec.IsAllDay) { delete out._storedStart; delete out._storedEnd; delete out._shownEnd; }
            return out;
        },

        /** Open the card on an event that was clicked (or double-clicked: full). */
        openNativeCard({ event, occurrence, jsEvent }, full = false) {
            const row = this.nativeStored(event);
            if (!row || !this.nativeCanEdit()) return;
            this.nativePopover = null;
            const kind = this.nativeKind(row), series = this.nativeSeriesOf(row);
            let target, value;
            if (kind === 'series' && series && occurrence && occurrence.start) {
                target = { kind: 'occ', id: series.id, recurrenceID: null, seriesId: series.id, occurrence: { start: new Date(occurrence.start), end: new Date(occurrence.end) }, series: this.nativeSeriesTimes(series) };
                value = { ...this.nativeCardValue(series, occurrence), rule: series.recurrencerule || '' };
            } else if (kind === 'series') {
                target = { kind: 'series', id: row.id, recurrenceID: null, seriesId: row.id, occurrence: null, series: this.nativeSeriesTimes(row) };
                value = this.nativeCardValue(row);
                target.occurrence = this.nativeCardInstants(value);
            } else {
                target = { kind: 'row', id: row.id, recurrenceID: row.recurrenceID ?? null, seriesId: kind === 'edited' && series ? series.id : null, occurrence: null };
                value = this.nativeCardValue(row);
            }
            const el = jsEvent && jsEvent.target && jsEvent.target.closest ? jsEvent.target.closest('[data-testid^="event-"]') : null;
            this.showNativeCard({ isNew: false, full, target, value, canRepeat: kind !== 'edited',
                anchor: { testid: `event-${row.id}`, rect: el ? el.getBoundingClientRect().toJSON() : null }, returnTo: el });
            this.nativeCardEdited(row);
        },
        /** A new event from a click or drag on the grid (or N): a draft until Done. */
        openNativeNewCard({ start, end, isAllDay, jsEvent, full = false }) {
            // (All day: the first and the last day's midnights here, read in this browser's wall clock.)
            const here = EventZone.localZone(), day = (x) => cardKit.instantOf(cardKit.startOfDay(cardKit.wallOf(x, here)), here);
            const value = { title: '', type: 1, description: '', isAllDay: !!isAllDay, rule: '', tz: '',
                start: isAllDay ? day(start) : new Date(start), end: isAllDay ? day(new Date(end).getTime() - 1) : new Date(end) };
            if (value.isAllDay && value.end < value.start) value.end = new Date(value.start);
            const r = jsEvent && jsEvent.clientX != null ? { left: jsEvent.clientX, top: jsEvent.clientY, width: 1, height: 1, right: jsEvent.clientX + 1, bottom: jsEvent.clientY + 1 } : null;
            this.showNativeCard({ isNew: true, full, target: { kind: 'new' }, value, canRepeat: true, anchor: { testid: 'draft-block', rect: r }, returnTo: null });
        },
        showNativeCard({ isNew, full, target, value, canRepeat, anchor, returnTo }) {
            this.nativeQuick = null;
            this._nativeCardSeq = (this._nativeCardSeq || 0) + 1;
            this._nativeCardReturn = returnTo && returnTo.dataset ? returnTo.dataset.testid : null;
            this.nativeCard = { key: this._nativeCardSeq, isNew, full, canRepeat, target, value, opened: this.nativeCardClone(value), anchor, edited: '', place: 0,
                keepOccurrences: null, entries: [] };
        },
        /** "Edited 5m ago": the newest change to this event in the history the app already reads (one read per card). */
        nativeCardEdited(row) {
            const c = this.nativeCard, key = this.eventKey(row);
            const label = () => {
                const hit = (this.undoEntries || []).find((u) => (u.keys || []).includes(key));
                if (hit && this.nativeCard === c) c.edited = `Edited ${cardKit.ago(hit.savedAt, this.serverNow ? this.serverNow() : Date.now())}`;
            };
            label();
            if (this.isExisting && Date.now() - (this._nativeHistoryAt || 0) > 60000) { this._nativeHistoryAt = Date.now(); this.loadUndoEntries().then(label).catch(() => {}); }
        },
        /** One change from the card (patch: the fields it changed; message: what the toast says). */
        nativeCardChange(patch, message, meta = null) {
            const c = this.nativeCard;
            if (!c) return;
            if (meta && meta.details && !c.isNew) return this.nativeCardDetails(patch, meta.details);
            // Another time zone keeps the date and clock time shown and means them in that zone (as Google Calendar
            // does): Wed 9 AM with Tokyo picked is Wed 9 AM in Tokyo. The card sends the new tz with the start and end
            // that now mean (EventCard change).
            const before = this.nativeCardClone(c.value), after = { ...before, ...patch };
            // Whether people categorize events at all (classic sends it too).
            if ('type' in patch && Number(patch.type) !== Number(before.type)) this.onNativeColor();
            if (c.isNew || !message) { c.value = after; return; }
            if (!Object.keys(this.nativeCardFields(before, after)).length) { c.value = after; return; }
            if (c.target.kind === 'occ') {
                // A repeat belongs to the whole series; anything else asks first, once ("this event" is the default).
                if ('rule' in patch || 'tz' in patch) return this.nativeCardWrite('all', before, after, message);
                this.nativeAskScope('Edit recurring event', () => this.nativeCardWrite('this', before, after, message),
                    () => this.nativeCardWrite('all', before, after, message), 'OK', () => { if (this.nativeCard === c) c.value = before; });
                return;
            }
            this.nativeCardWrite(c.target.kind === 'series' ? 'all' : 'row', before, after, message);
        },
        /**
         * The details box, saved while typing and when it is left (EventCard saveDetails). One session of the box is one
         * Undo step: each later save in it folds into the first (its own undo entry is dropped, so Undo puts back what was
         * there before the session). Only the last save says "Details saved". If someone else changed the details while
         * they were being typed, these win, and a toast says so with an Undo that puts theirs back.
         */
        nativeCardDetails(patch, d) {
            const c = this.nativeCard;
            const row = c.target.kind === 'occ' ? null : this.nativeStored({ id: c.target.kind === 'series' ? c.target.seriesId : c.target.id, recurrenceID: c.target.kind === 'series' ? null : c.target.recurrenceID });
            // One occurrence of a series not yet asked "this event / all events": ask once, when the box is left.
            if (c.target.kind === 'occ') { if (d.final && 'description' in patch) this.nativeCardChange(patch, 'Details saved'); return; }
            // Kept off the reactive card (a store undo entry must stay the very object in the store's stack).
            const prev = this._nativeDetSession;
            const sess = prev && prev.card === c.key && prev.id === d.id ? prev : (this._nativeDetSession = { card: c.key, id: d.id, entry: null, mine: d.base, theirs: null });
            if ('description' in patch && row) {
                const now = row.description || '';
                if (now !== sess.mine && now !== patch.description) sess.theirs = now;   // changed elsewhere meanwhile
                const stack = this.store().undoStack, len = stack.length;
                this._nativeDetailsQuiet = true;
                this.nativeCardWrite(c.target.kind === 'series' ? 'all' : 'row', this.nativeCardClone(c.value), { ...this.nativeCardClone(c.value), description: patch.description }, 'Details saved');
                this._nativeDetailsQuiet = false;
                if (stack.length > len) {
                    if (sess.entry && stack.includes(sess.entry)) {
                        // Fold into the session's first save: drop this undo entry (and the card's record of it).
                        const mineEntry = stack.pop();
                        this.nativeFoldWrote(sess.entry, mineEntry);
                        const i = c.entries.findIndex((e) => e.entry === mineEntry);
                        if (i >= 0) c.entries.splice(i, 1);
                    } else sess.entry = stack[stack.length - 1];
                }
                sess.mine = patch.description;
            }
            if (!d.final) return;
            this._nativeDetSession = null;
            if (!sess.entry) return;
            if (sess.theirs !== null) {
                const theirs = sess.theirs;
                this.showToast('Someone else edited these details too', 'info', { actionLabel: 'Undo', action: () => {
                    if (this.nativeCard === c) this.nativeCardWrite(c.target.kind === 'series' ? 'all' : 'row', this.nativeCardClone(c.value), { ...this.nativeCardClone(c.value), description: theirs }, 'Their details are back');
                    else {
                        const r = this.nativeStored({ id: row.id, recurrenceID: row.recurrenceID });
                        if (!r) return;
                        const rec = this.nativeRecord(r);
                        ScheduleAdapter.noteStart(rec);
                        if (this.nativeAction('eventChange', { changedRecords: [{ ...rec, Description: theirs }] }, { action: 'Save' })) this.showToast('Their details are back', 'success');
                    }
                } });
            }
        },
        /**
         * A details session's first undo entry takes on what each later save in it wrote: an undo takes back only what
         * this tab wrote and the row still holds (EventStore undoOnly), so it must know the session's last words.
         */
        nativeFoldWrote(into, from) {
            const flat = (inv) => !inv ? [] : inv.type === 'batch' ? (inv.commands || []).flatMap(flat) : [inv];
            const kept = flat(into && into.inverse);
            for (const u of flat(from && from.inverse)) {
                if (u.type !== 'update' || !u.wrote) continue;
                const k = kept.find((x) => x.type === 'update' && x.wrote && x.key === u.key);
                if (k) Object.assign(k.wrote, u.wrote);
            }
        },
        /** A series' own start and end (ms), as the card last saw them: how far another browser moved it since. */
        nativeSeriesTimes(series) {
            const r = this.nativeCardInstants(this.nativeCardValue(series));
            return { start: r.start.getTime(), end: r.end.getTime() };
        },
        /** The event changed in another browser while the card is open: the card shows it (the box being typed in waits). */
        nativeCardRefresh() {
            const c = this.nativeCard;
            if (!c || c.isNew || this.nativeAsk) return;
            const t = c.target;
            const row = this.nativeStored(t.kind === 'row' ? { id: t.id, recurrenceID: t.recurrenceID } : { id: t.seriesId });
            if (!row) return this.nativeCardGone(t.kind !== 'row' || (t.seriesId != null && !this.nativeStored({ id: t.seriesId })));
            const v = this.nativeCardValue(row), cur = c.value;
            let next = t.kind === 'row' ? v : { ...this.nativeCardRezone(cur, v.tz), title: v.title, type: v.type, description: v.description, rule: v.rule };
            if (t.kind !== 'row' && this.nativeCardFollow(t, row)) next = { ...this.nativeCardValue(row, t.occurrence), rule: v.rule };
            if (Object.keys(this.nativeCardFields(cur, next)).length) c.value = next;
        },
        /**
         * An occurrence (or series) card whose series was moved elsewhere since the card last saw it ("all events" in
         * another browser): the occurrence on the card moves with it, by as much on the clock (as nativeSeriesMoved
         * moves it), so a save lands on its slot as it is now (stress F02). Returns a function that moves a card value's
         * times the same way, or null when the series has not moved.
         */
        nativeCardFollow(t, series) {
            const was = t.series, now = this.nativeSeriesTimes(series);
            t.series = now;
            if (!was || !t.occurrence || (was.start === now.start && was.end === now.end)) return null;
            const z = this.nativeCardZone(this.nativeCardValue(series));
            const s = nativeShift(was.start, now.start, z), e = nativeShift(was.end, now.end, z);
            t.occurrence = { start: s(t.occurrence.start), end: e(t.occurrence.end) };
            return (v) => ({ ...v, start: s(v.start), end: e(v.end) });
        },
        nativeCardWrite(scope, before, after, message) {
            const c = this.nativeCard;
            if (!c || !this.nativeCanEdit()) return;
            // The series moved while a question was open (the card does not follow it then): this change moves with it.
            const now = scope !== 'row' && c.target.kind !== 'row' ? this.nativeStored({ id: c.target.seriesId }) : null;
            const move = now ? this.nativeCardFollow(c.target, now) : null;
            if (move) { before = move(before); after = move(after); }
            const snapshot = { target: { ...c.target }, value: before, canRepeat: c.canRepeat };
            const ids = new Set((this.calendar.events || []).map((e) => e && String(e.id)));
            const fields = this.nativeCardFields(before, after);
            let ok = false;
            if (scope === 'row') {
                const row = this.nativeStored({ id: c.target.id, recurrenceID: c.target.recurrenceID });
                if (!row) return this.nativeCardGone();
                const rec = this.nativeRecord(row);
                ScheduleAdapter.noteStart(rec);
                if (this.nativeKind(row) === 'edited') delete fields.RecurrenceRule;   // an occurrence's rule is the series'
                ok = this.nativeAction('eventChange', { changedRecords: [this.nativeCardApply(rec, fields)] }, { action: 'Save' });
            } else if (scope === 'this') {
                const series = this.nativeStored({ id: c.target.seriesId });
                if (!series) return this.nativeCardGone();
                let rec = this.nativeRecord(series);
                delete fields.RecurrenceRule;
                // The occurrence as this change began: the series as it is NOW (renamed elsewhere meanwhile, say) at
                // this slot's times, noted; then only the fields this change changed. The card's whole value carried
                // what it showed when it opened, and a stale title went into the new row (stress S04).
                Object.assign(rec, { Id: NATIVE_OCCURRENCE_ID, RecurrenceID: rec.Id, ...this.nativeCardTimes(before) });
                ScheduleAdapter.noteStart(rec);
                rec = this.nativeCardApply(rec, fields);
                ok = this.nativeAction('eventChange', { changedRecords: [rec] }, { action: 'EditOccurrence', occurrenceStart: c.target.occurrence.start });
                if (ok) {
                    // Its new row, or (someone else saved "This event" on this slot first) the slot's row it updated.
                    const own = (e) => e && !isBlankId(e.recurrenceID) && String(e.recurrenceID) === String(series.id);
                    const stamp = ScheduleAdapter.stamp(c.target.occurrence.start);
                    const child = (this.calendar.events || []).find((e) => own(e) && !ids.has(String(e.id)))
                        || (this.calendar.events || []).find((e) => own(e) && String(e.recurrenceException || '').trim() === stamp);
                    if (child) { c.target = { kind: 'row', id: child.id, recurrenceID: child.recurrenceID, seriesId: series.id, occurrence: null }; c.canRepeat = false; }
                }
            } else {
                const series = this.nativeStored({ id: c.target.seriesId });
                if (!series) return this.nativeCardGone();
                // The shared "all events" path (nativeSeriesMoved, nativeSaveSeries), the one a drag of the series takes:
                // a time change moves the series, and the stamps it keeps, by as much as this occurrence moved.
                const timed = 'StartTime' in fields;
                const from = this.nativeCardTimes(before), to = this.nativeCardTimes(after);
                let moved = this.nativeRecord(series);
                moved.RecurrenceID = moved.Id;
                ScheduleAdapter.noteStart(moved);
                if (timed && 'Tz' in fields && !!before.isAllDay === !!after.isAllDay) {
                    // Another zone: the series' own dates and clock times, meant in the new zone (its repeat days too).
                    const oz = this.nativeCardZone(before) || EventZone.localZone(), nz = this.nativeCardZone(after) || EventZone.localZone();
                    const re = (d) => EventZone.unfloating(EventZone.floating(new Date(d).getTime(), oz), nz);
                    moved = { ...moved, StartTime: re(moved.StartTime), EndTime: re(moved.EndTime) };
                } else if (timed) {
                    moved = this.nativeCardApply(this.nativeSeriesMoved(series, { start: from.StartTime, end: from.EndTime }, { start: to.StartTime, end: to.EndTime }),
                        { IsAllDay: !!after.isAllDay });
                }
                for (const f of ['Subject', 'Type', 'Description', 'RecurrenceRule', 'Tz']) if (f in fields) moved[f] = fields[f];
                this.nativeSaveSeries(series, moved, {
                    timing: timed || 'RecurrenceRule' in fields,
                    // (Switching All day changes what a stamp names: kept stamps stay as they are.)
                    shift: timed && !!before.isAllDay === !!after.isAllDay ? { from: from.StartTime, to: to.StartTime } : null,
                    keep: c.keepOccurrences,
                    cancel: () => { if (this.nativeCard === c) c.value = before; },
                }, (done, keepOccurrences, asked) => {
                    if (this.nativeCard !== c) return;
                    if (asked) c.keepOccurrences = keepOccurrences;   // asked once per card
                    if (done) {
                        const saved = this.nativeStored({ id: series.id }) || series;
                        c.target = { kind: 'series', id: series.id, recurrenceID: null, seriesId: series.id, occurrence: this.nativeCardInstants(after), series: this.nativeSeriesTimes(saved) };
                        this.nativeCardSaved(c, snapshot, after, message);
                    } else c.value = before;
                });
                return;
            }
            if (ok) this.nativeCardSaved(c, snapshot, after, message);
            else c.value = before;
        },
        /** A change was saved: remember how to take it back, show it, offer Undo. */
        nativeCardSaved(c, snapshot, after, message) {
            const stack = this.store().undoStack;
            // Raw (never a reactive proxy), so it can be found in the store's stack by identity.
            c.entries.push(Vue.markRaw({ entry: stack[stack.length - 1], before: snapshot }));
            c.value = this.nativeCardClone(after);
            c.edited = 'Edited just now';
            this._nativeGlow = `event-${c.target.id}`;
            // No toast: the change is on screen and the event glows once; ⌘Z undoes. Toasts are for what you can't see
            // happen (a delete, someone else's edit, an error).
        },
        /** The event (or its whole series) went away under the card (deleted in another browser): close it. */
        nativeCardGone(series = false) {
            this.nativeCard = null;
            this.showToast(series ? "This event's series was deleted." : 'This event was deleted elsewhere', 'info');
        },
        nativeUndo() { if (this.store().canUndo) this.undoLastLocal(); },
        /** After an undo (the toast, Cmd+Z): the card follows the event back, and the event glows once. */
        nativeAfterUndo() {
            const c = this.nativeCard;
            if (c) {
                const stack = this.store().undoStack;
                let moved = false;
                while (c.entries.length && !stack.includes(c.entries[c.entries.length - 1].entry)) {
                    const { before } = c.entries.pop();
                    c.target = before.target; c.canRepeat = before.canRepeat; c.value = this.nativeCardClone(before.value);
                    moved = true;
                }
                if (moved) this.$nextTick(() => { c.place++; });
            }
            const id = this._nativeGlow;
            if (id && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                setTimeout(() => document.querySelectorAll(`.nc [data-testid="${id}"]`).forEach((el) => { el.classList.remove('nc-glow'); void el.offsetWidth; el.classList.add('nc-glow'); }), 50);
            }
        },
        /** Done (or a click outside): a new event is added; an existing one keeps what was saved. */
        nativeCardDone({ title, description } = {}) {
            const c = this.nativeCard;
            if (!c) return;
            // The last change (a title saved as the card closes) is still asking "this event / all events": close
            // once it is answered.
            if (!c.isNew && this.nativeAsk) { c.closeAfterAsk = true; return; }
            if (!c.isNew) return this.closeNativeCard();
            const v = c.value;
            const name = (title != null ? title : v.title || '').trim();
            const details = description != null ? description : v.description || '';
            // Nothing entered at all: nothing was meant. Anything entered (details, a type, a repeat) is kept, untitled
            // as "(No title)", as the editor and quick add save it (stress F03).
            if (!name && !details.trim() && !v.rule && (Number(v.type) || 1) === 1) { track(a => a.editorAbandoned()); return this.closeNativeCard(); }
            const ids = new Set((this.calendar.events || []).map((e) => e && String(e.id)));
            const ok = this.nativeAction('eventCreate', { addedRecords: [{ Subject: name || '(No title)', ...this.nativeCardTimes(v), IsAllDay: !!v.isAllDay,
                Type: Number(v.type) || 1, Description: details, RecurrenceRule: v.rule || '', ...(v.tz ? { Tz: v.tz } : {}) }] }, { action: 'Add' });
            this.closeNativeCard();
            if (!ok) return;
            const row = (this.calendar.events || []).find((e) => e && !ids.has(String(e.id)));
            this._nativeGlow = row ? `event-${row.id}` : null;
        },
        /** Cancel (or Escape): every change since the card opened is taken back; a new event is dropped. No Undo for that. */
        nativeCardCancel() {
            const c = this.nativeCard;
            if (!c) return;
            // A new event closed without adding is the "this was confusing or fiddly" signal (as classic's popupClose).
            if (c.isNew) track(a => a.editorAbandoned());
            let undid = 0;
            const stack = this.store().undoStack;
            while (c.entries.length && stack.length && stack[stack.length - 1] === c.entries[c.entries.length - 1].entry) {
                c.entries.pop();
                if (!this.undoLastLocal({ quiet: true })) break;
                undid++;
            }
            this.closeNativeCard();
        },
        closeNativeCard() {
            const c = this.nativeCard;
            if (!c) return;
            const card = document.querySelector('.nk-card');
            const hadFocus = !!card && card.contains(document.activeElement);
            if (hadFocus) document.activeElement.blur();
            this.nativeCard = null;
            const back = this._nativeCardReturn || (c.target && c.target.id != null ? `event-${c.target.id}` : null);
            if (hadFocus && back) this.$nextTick(() => { const el = document.querySelector(`.nc [data-testid="${back}"]`); if (el) el.focus({ preventScroll: true }); });
        },
        nativeCardDelete() {
            const c = this.nativeCard;
            if (!c) return;
            if (c.isNew) return this.closeNativeCard();
            const t = c.target;
            this.closeNativeCard();
            // The event shrinks and fades where it was.
            const el = document.querySelector(`.nc [data-testid="event-${t.id}"]`);
            const ghost = () => {
                if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
                const r = el.getBoundingClientRect(), g = document.createElement('div');
                g.className = 'nc-ghost';
                Object.assign(g.style, { left: `${r.left + window.scrollX}px`, top: `${r.top + window.scrollY}px`, width: `${r.width}px`, height: `${r.height}px`, background: getComputedStyle(el).backgroundColor });
                document.body.appendChild(g);
                setTimeout(() => g.remove(), 220);
            };
            this._nativeGlow = `event-${t.id}`;
            if (t.kind === 'row') this.nativeDeleteEvent({ id: t.id, recurrenceID: t.recurrenceID }, null);
            else if (t.kind === 'occ') this.nativeDeleteEvent({ id: t.seriesId }, t.occurrence);
            else this.nativeDeleteEvent({ id: t.seriesId }, t.occurrence, { mode: 'EditSeries' });
            if (!this.nativeAsk) ghost();
        },
        /** Duplicate: a copy the next day (a repeating event's copy is one event), and the card follows the copy. */
        nativeCardDuplicate() {
            const c = this.nativeCard;
            if (!c || c.isNew) return;
            const v = this.nativeCardClone(c.value);
            // The next day on the event's own wall clock (its zone, or this browser's).
            const W = cardKit.zoneOf(v), nextDay = (x) => cardKit.instantOf(cardKit.addDays(cardKit.wallOf(x, W), 1), W);
            const next = { ...v, start: nextDay(v.start), end: nextDay(v.end), rule: '' };
            const ids = new Set((this.calendar.events || []).map((e) => e && String(e.id)));
            const snapshot = { target: { ...c.target }, value: v, canRepeat: c.canRepeat };
            const t = c.target, src = this.nativeStored(t.kind === 'row' ? { id: t.id, recurrenceID: t.recurrenceID } : { id: t.seriesId });
            if (!src) return this.nativeCardGone(t.kind !== 'row');
            const ok = this.nativeAction('eventCreate', { addedRecords: [this.nativeCopyRecord(src, { ...this.nativeCardTimes(next), IsAllDay: !!v.isAllDay })] }, { action: 'Add' });
            const row = ok && (this.calendar.events || []).find((e) => e && !ids.has(String(e.id)));
            if (!row) return;
            c.target = { kind: 'row', id: row.id, recurrenceID: null, seriesId: null, occurrence: null };
            c.canRepeat = true;
            c.anchor = { testid: `event-${row.id}`, rect: null };
            const ns = cardKit.wallOf(next.start, W);
            const when = v.isAllDay ? cardKit.fmtDate(ns) : `${cardKit.fmtDate(ns, { weekday: 'short' })} ${cardKit.fmtTime(ns, this.globalSettings.timeFormat === '24' ? '24' : '12', true)}`;
            this.nativeCardSaved(c, snapshot, next, `Duplicated to ${when}`);
            this.$nextTick(() => { c.place++; });
        },
        /** Edit types…: names for the colors, for the whole calendar (as Settings saves them). */
        nativeCardLabels(names) {
            let changed = 0;
            (names || []).forEach((n, i) => { if (typeof n === 'string' && n.trim() !== (this.displayTypeLabels[i] || '')) { this.updateTypeLabel(i + 1, n); changed++; } });
            if (changed) this.showToast('Types saved for everyone', 'success');
        },
        /** The calendar's own clicks on an edit link: the card, else (locked, view-only) the read-only popup. */
        onNativeEventClick(payload) {
            if (this.nativeEdit && this.canEdit && !this.isReadOnly) return this.openNativeCard(payload);
            this.openNativePopover(payload);
        },
        /** A drop, a resize or an arrow key: saved as before (onNativeMove), then said in a toast with Undo, and the event settles. */
        /** Right-click on an event: its card opens, and the card's menu (Duplicate, Delete) at the pointer. */
        onNativeEventMenu(payload) {
            if (!(this.nativeEdit && this.canEdit && !this.isReadOnly)) return;
            this.openNativeCard(payload);
            this.$nextTick(() => this.$refs.eventCard && this.$refs.eventCard.menuAt(payload.x, payload.y));
        },
        /** Option/Alt-drag: a copy where it was dropped, as one event (a repeating event's copy doesn't repeat); the original stays. */
        nativeDropCopy(payload) {
            const row = this.nativeStored({ id: payload.event.id, recurrenceID: payload.event.recurrenceID });
            if (!row) return;
            const ids = new Set((this.calendar.events || []).map((e) => e && String(e.id)));
            const ok = this.nativeAction('eventCreate', { addedRecords: [this.nativeCopyRecord(row, { StartTime: new Date(payload.start), EndTime: new Date(payload.end) })] }, { action: 'Add' });
            const copy = ok && (this.calendar.events || []).find((e) => e && !ids.has(String(e.id)));
            if (copy) this._nativeGlow = `event-${copy.id}`;
        },
        /**
         * A new event's record copying a stored row: every field (EventStore.copy) but its id and its repeat (a repeating
         * event's copy is one event), at `times` ({ StartTime, EndTime }, maybe IsAllDay). Duplicate and an Option-drag
         * both copy through here, so a field the event has is never left behind (stress S03: the drag copy lost its zone).
         */
        nativeCopyRecord(row, times) {
            const copy = EventStore.copy(row);
            if (!String(copy.title || '').trim()) copy.title = '(No title)';
            const rec = ScheduleAdapter.toView([copy])[0];
            for (const k of ['Id', '_storedStart', '_storedEnd', '_shownEnd', '_storedRule', '_storedException', '_gridRule']) delete rec[k];
            return { ...rec, ...times };
        },
        onNativeMoveSaved(payload) {
            if (payload.copy) return this.nativeDropCopy(payload);
            const len = this.store().undoStack.length;
            const f = this.globalSettings.timeFormat === '24' ? '24' : '12';
            // (Said in this browser's wall clock, as the grid shows it.)
            const here = EventZone.localZone(), s = cardKit.wallOf(payload.start, here), e = cardKit.wallOf(payload.end, here);
            const msg = payload.mode === 'resize' ? (payload.allDay ? `Ends ${cardKit.fmtDate(new Date(e.getTime() - 1))}` : `Ends ${cardKit.fmtTime(e, f, true)}`)
                : payload.mode === 'resize-top' ? `Starts ${cardKit.fmtTime(s, f, true)}`
                    : `Moved to ${cardKit.fmtDate(s, { weekday: 'short' })}${payload.allDay ? '' : ' ' + cardKit.fmtTime(s, f, true)}`;
            const id = payload.event && payload.event.id;
            this._nativeMoveToast = { len, msg, id, key: !!payload.key };
            this.onNativeMove(payload);
            this.nativeMoveToast();
        },
        nativeMoveToast() {
            const p = this._nativeMoveToast;
            if (!p || this.nativeAsk) return;   // still asking "this event / all events": checked again on the answer
            this._nativeMoveToast = null;
            if (this.store().undoStack.length <= p.len) return;
            this._nativeGlow = `event-${p.id}`;
            this.$nextTick(() => {
                const els = document.querySelectorAll(`.nc [data-testid="event-${p.id}"]`);
                if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) els.forEach((el) => { el.classList.remove('nc-settle'); void el.offsetWidth; el.classList.add('nc-settle'); });
                if (p.key && els[0]) els[0].focus({ preventScroll: true });
            });
        },
        /** Keys on a native edit link: N new, Cmd/Ctrl+D duplicate, Delete, T today, arrows previous / next, D W M A views. */
        onNativeKey(e) {
            if (!this.nativeEdit || this.isReadOnly || !this.canEdit || e.defaultPrevented) return;
            const el = document.activeElement;
            const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
            if (typing || this.nativeAsk) return;
            const open = [...document.querySelectorAll('[aria-modal="true"], .pc-modal')].some((m) => m.getClientRects().length > 0);
            if (open) return;
            const c = this.nativeCard, cal = this.$refs.nativeCal;
            const k = e.key.toLowerCase();
            if ((e.metaKey || e.ctrlKey) && k === 'd' && c && !c.isNew) { e.preventDefault(); this.nativeCardDuplicate(); return; }
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if ((e.key === 'Delete' || e.key === 'Backspace') && c && !c.isNew) { e.preventDefault(); this.nativeCardDelete(); return; }
            if (e.key === '?') { e.preventDefault(); this.nativeKeys = true; this.$nextTick(() => document.querySelector('[data-testid="shortcuts-close"]')?.focus()); return; }
            if (c || !cal) return;
            if (k === 'n') {
                e.preventDefault();
                const r = cal.visibleRange(), now = new Date();
                const day = now.getTime() >= r.start && now.getTime() < r.end ? now : new Date(r.start);
                const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.min(23, now.getHours() + 1));
                this.openNativeNewCard({ start, end: new Date(start.getTime() + 3600000), isAllDay: false });
                return;
            }
            if (el && el.closest && el.closest('.nc [data-testid^="event-"]')) return;   // arrows move a focused event (NativeCalendar keyMove)
            const views = { d: 'Day', w: 'Week', m: 'Month', a: 'Agenda' };
            if (k === 't') { e.preventDefault(); cal.goToday(); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); cal.step(e.key === 'ArrowLeft' ? -1 : 1); }
            else if (views[k]) { e.preventDefault(); cal.setView(views[k]); }
        },
        /** Tab stays inside the open question. */
        nativeAskTrap(e) {
            if (e.key !== 'Tab') return;
            const items = [...e.currentTarget.querySelectorAll('button, input')].filter((x) => x.offsetParent !== null);
            if (!items.length) return;
            const i = items.indexOf(document.activeElement);
            if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
            else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
        },

        // Syncfusion's Schedule, built and wired as it always was: the classic calendar. Returns its
        // CalendarView; nothing else in the app touches scheduleObj except through that or a guard.
        mountSyncfusion() {
            // Sentence case for Syncfusion's own words ("More Details", "New Event", "Repeat
            // On"...), like the rest of pastecal. Keys missing here keep Syncfusion's text.
            ej.base.L10n.load({
                'en-US': {
                    schedule: {
                        newEvent: 'New event', editEvent: 'Edit event', deleteEvent: 'Delete event',
                        deleteTitle: 'Delete event', editTitle: 'Edit event',
                        deleteMultipleEvent: 'Delete multiple events', moreDetails: 'More details',
                        editSeries: 'Entire series', deleteSeries: 'Entire series',
                        editFollowingEvent: 'Following events', recurringEvent: 'Recurring event',
                        editRecurrence: 'Edit recurrence', startTimezone: 'Start timezone',
                        endTimezone: 'End timezone', searchTimezone: 'Search timezone',
                        beginFrom: 'Begin from', endAt: 'Ends at', noTitle: '(No title)',
                    },
                    recurrenceeditor: { on: 'Repeat on' },
                },
            });
            const scheduleObj = window.scheduleObj = new ej.schedule.Schedule();
            const scheduleInitTimestamp = performance.now();
            console.log('[schedule-init] Schedule constructed at', scheduleInitTimestamp.toFixed(1), 'ms');
            scheduleObj.on('actionComplete', (args) => {
                if (args?.requestType === 'toolBarRendered') {
                    console.log('[schedule-init] toolBarRendered at', (performance.now() - scheduleInitTimestamp).toFixed(1), 'ms since init');
                }
            });
            scheduleObj.addEventListener('dataBound', () => {
                console.log('[schedule-init] dataBound at', (performance.now() - scheduleInitTimestamp).toFixed(1), 'ms since init');
            });
            scheduleObj.on('eventsLoaded', () => {
                console.log('[schedule-init] eventsLoaded at', (performance.now() - scheduleInitTimestamp).toFixed(1), 'ms since init');
            });

            // Apply globalSettings BEFORE appendTo — these properties bake into Syncfusion's
            // first render and won't reactively update if set later. (See applyGlobalSettings
            // for the post-render path used when settings change at runtime.)
            scheduleObj.startHour = this.calendar?.options?.extended ? "00:00" : (this.globalSettings.startHour || "05:00");
            scheduleObj.timeFormat = this.globalSettings.timeFormat === '24' ? 'HH:mm' : 'h:mm a';
            scheduleObj.firstDayOfWeek = parseInt(this.globalSettings.firstDayOfWeek) || 0;
            // Phones: Week/Day hour labels like "5:00 AM" clip to "5:00…" in the narrow time column,
            // so label hours compactly ("5a", "12p", or "17" in 24-hour time). window.pcHourLabel reads
            // the format live, so a settings change applies on the next render.
            if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639px)').matches) {
                const vm = this;
                window.pcHourLabel = (date) => {
                    const h = date.getHours();
                    if (vm.globalSettings.timeFormat === '24') return String(h);
                    return (h % 12 || 12) + (h < 12 ? 'a' : 'p');
                };
                scheduleObj.timeScale.majorSlotTemplate = '<span class="pc-hour">${pcHourLabel(data.date)}</span>';
            }

            // Build custom view configuration dynamically
            const customViewDuration = this.calendar?.options?.customViewDuration || this.globalSettings.customViewDuration;
            const customViewUnit = this.calendar?.options?.customViewUnit || this.globalSettings.customViewUnit;
            const customViewConfig = this.buildCustomViewConfig(customViewDuration, customViewUnit);

            scheduleObj.views = [
                'Day',
                'Week',
                'Month',
                customViewConfig,
                'Year',
                'Agenda'
            ];
            scheduleObj.enableAdaptiveUI = false;

            scheduleObj.readonly = this.isReadOnly;


            // Set up scheduler first, then apply settings after initialization
            // set params from URL
            let sanitizedUrl = Utils.sanitizeUrl(window.location.href.toLowerCase());
            let url = new URL(sanitizedUrl);
            let date_param = url.searchParams.get("d") || url.searchParams.get("date");
            let view_param = url.searchParams.get("v") || url.searchParams.get("view");

            let d;
            if (d = Utils.parseDate(date_param)) {
                scheduleObj.selectedDate = d;
            }

            if (view_param) {
                switch (view_param.toLowerCase()) {
                    case "d":
                    case "day":
                        scheduleObj.currentView = "Day"; break;
                    case "w":
                    case "week":
                        scheduleObj.currentView = "Week"; break;
                    case "12w":
                    case "12weeks":
                        // Map to custom 12 weeks view
                        const twelveWeeksView = this.buildCustomViewConfig(12, 'Weeks');
                        const twelveWeeksIndex = scheduleObj.views.findIndex(v =>
                            typeof v === 'object' && (v === customViewConfig)
                        );
                        if (twelveWeeksIndex !== -1) {
                            scheduleObj.views[twelveWeeksIndex] = twelveWeeksView;
                        }
                        scheduleObj.currentView = twelveWeeksView.displayName;
                        break;
                    case "m":
                    case "month":
                        scheduleObj.currentView = "Month"; break;
                    case "c":
                    case "custom":
                        // Check for URL parameter overrides for custom view
                        const durParam = url.searchParams.get("dur") || url.searchParams.get("duration");
                        const unitParam = url.searchParams.get("unit");

                        let customViewToUse = customViewConfig;

                        if (durParam && unitParam) {
                            // Temporarily override custom view config from URL
                            const duration = parseInt(durParam);
                            const unit = unitParam.charAt(0).toUpperCase() + unitParam.slice(1).toLowerCase();

                            if (this.validateCustomView(duration, unit)) {
                                // Rebuild the custom view with URL parameters
                                customViewToUse = this.buildCustomViewConfig(duration, unit);
                                // Replace the custom view in the views array
                                const customViewIndex = scheduleObj.views.findIndex(v =>
                                    typeof v === 'object' && (v === customViewConfig)
                                );
                                if (customViewIndex !== -1) {
                                    scheduleObj.views[customViewIndex] = customViewToUse;
                                }
                            }
                        }

                        // Set currentView to the display name
                        scheduleObj.currentView = customViewToUse.displayName;
                        break;
                    case "q":
                    case "quarter":
                        // Map to custom 3 months view
                        const quarterView = this.buildCustomViewConfig(3, 'Months');
                        const quarterIndex = scheduleObj.views.findIndex(v =>
                            typeof v === 'object' && (v === customViewConfig)
                        );
                        if (quarterIndex !== -1) {
                            scheduleObj.views[quarterIndex] = quarterView;
                        }
                        scheduleObj.currentView = quarterView.displayName;
                        break;
                    case "y":
                    case "year":
                        scheduleObj.currentView = "Year"; break;
                    case "a":
                    case "agenda":
                        scheduleObj.currentView = "Agenda"; break;
                    default:
                        break;
                }
            }

            // disable drag and drop / resizing for touch devices
            let touchDevice = ('ontouchstart' in document.documentElement);
            scheduleObj.allowDragAndDrop = !touchDevice;
            scheduleObj.allowResizing = !touchDevice;

            // live binding to events
            scheduleObj.eventSettings.dataSource = this.syncFusionEvents;

            // Syncfusion is a VIEW. When the user adds, changes or removes an event on the grid,
            // Syncfusion's own change is cancelled here and the user's intent goes to the
            // EventStore as a command; the grid is then redrawn from the store (the calendar
            // watcher calls updateCalendarView). Syncfusion never edits our data itself, so its
            // internal records -- their id kinds, escaped text, stale fields -- never become it.
            scheduleObj.actionBegin = (args) => {
                if (!['eventCreate', 'eventChange', 'eventRemove'].includes(args.requestType)) return;
                args.cancel = true;
                this.editorSaved = true;
                this.applyScheduleAction(args);
            };
            // An editor that closes without a save is the "this was confusing or fiddly" signal.
            scheduleObj.popupClose = (args) => {
                this.hideDraftBlock();
                if (args.type !== 'Editor') return;
                if (!this.editorSaved) track(a => a.editorAbandoned());
                this.editorSaved = false;
            };
            // The user's change is measured from the event as it was when they started (see
            // ScheduleAdapter.noteStart), so a field someone else changed meanwhile is kept.
            scheduleObj.dragStart = (args) => ScheduleAdapter.noteStart(args.data);
            scheduleObj.resizeStart = (args) => ScheduleAdapter.noteStart(args.data);

            // color events based on type
            // Month view day names ("Monday") get a short form ("Mon") that phones show instead
            // (style.css swaps them); the full name was clipped to "Mond..." at phone width.
            scheduleObj.renderCell = (args) => {
                // Week/Day: the corner above the time column toggles the hours before the
                // start hour (calendar.options.extended; click handler below). It used to say
                // "12-4 AM" whatever the start hour was, and the same when they were showing.
                if (args.elementType === 'emptyCells' && args.element
                    && args.element.classList.contains('e-header-cells')) {
                    const label = this.earlyHoursLabel();
                    args.element.setAttribute('data-pc-label', label.text);
                    if (label.title) args.element.title = label.title;
                    return;
                }
                if (args.elementType !== 'monthDay' || !args.element) return;
                const label = args.element.querySelector('span') || args.element;
                const full = (label.textContent || '').trim();
                if (full) label.setAttribute('data-short', Array.from(full).slice(0, 3).join(''));
            };

            scheduleObj.eventRendered = (args) => {
                // change color as needed
                categoryColor = app.COLORS[args.data.Type - 1] || app.COLORS[0];
                if (scheduleObj.currentView === 'Agenda') {
                    args.element.firstChild.style.borderLeftColor = categoryColor;
                } else {
                    args.element.style.backgroundColor = categoryColor;
                    // Its text: dark on light colors, white on dark (style.css reads the variable).
                    args.element.style.setProperty('--pc-on-event', ScheduleAdapter.onColor(categoryColor));
                }
                ScheduleAdapter.showTitle(args.element, args.data);
            }

            // custom display for types
            scheduleObj.popupOpen = (args) => {
                // Deleting needs no "Are you sure?": the Undo toast that follows covers it. Syncfusion's
                // confirm is pressed for the person, unseen, so its own delete path (one occurrence, the
                // series, several selected) runs unchanged. The "this event or the series?" choice stays.
                if (args.type === 'DeleteAlert') {
                    document.body.classList.add('pc-skip-confirm');
                    requestAnimationFrame(() => {
                        const del = args.element && args.element.querySelector('.e-quick-dialog-delete');
                        if (del) del.click();
                        setTimeout(() => document.body.classList.remove('pc-skip-confirm'), 400);
                    });
                    return;
                }
                if (args.type === 'QuickInfo' && args.data) ScheduleAdapter.showTitle(args.element, args.data);
                // A new event: the chosen slot shows as a "New event" block while the quick box is open, and its
                // label follows the title being typed (as Google Calendar does), so you see where it will land.
                if (args.type === 'QuickInfo' && args.data && args.data.Id === undefined && !scheduleObj.readonly) app.showDraftBlock(args.element);
                // The popup header takes the event's color; its title and icons take the matching text color.
                if (args.type === 'QuickInfo' && args.data && args.data.Id !== undefined) {
                    args.element.style.setProperty('--pc-on-event', ScheduleAdapter.onColor(app.getTypeColor(args.data.Type)));
                }
                // The date line opens the editor (click handler by appendTo below); say so on hover.
                if (args.type === 'QuickInfo' && args.data && !scheduleObj.readonly) {
                    const when = args.element.querySelector('.e-event-popup .e-date-time');
                    if (when) when.title = 'Change date or time';
                }


                // One popup at a time. A double-click on a day fires Syncfusion's quick
                // popup twice and THEN the editor, and Syncfusion never closes that quick
                // popup: it stays open behind the editor, and when its open animation
                // finishes it focuses its own title box. Whatever the user was typing in
                // the editor -- usually the description -- carries on into that invisible
                // box, and the editor then saves with no title ("Add title"). That is the
                // second half of #32: "no way to save once you've written a description".
                //
                // So a quick popup may not open over an editor, and opening the editor
                // closes any quick popup already up.
                if (args.type === 'QuickInfo' && document.querySelector('.e-schedule-dialog.e-popup-open')) {
                    args.cancel = true;
                    return;
                }
                if (args.type === 'Editor' && typeof scheduleObj.closeQuickInfoPopup === 'function') {
                    scheduleObj.closeQuickInfoPopup();
                }

                if (args.type === 'Editor' && this.lockedOut) {
                    args.cancel = true;
                    this.showToast(this.lockedOutMessage, 'info');
                    return;
                }
                if (args.type === 'Editor') {
                    this.editorSaved = false;
                    ScheduleAdapter.noteStart(args.data);
                    // A yearly "last Monday of October" is drawn as every 12 months (ScheduleAdapter, #48); the
                    // repeat editor shows and saves the yearly rule it stands for.
                    if (args.data && args.data._gridRule) {
                        const re = args.element.querySelector('.e-recurrenceeditor');
                        const inst = re && re.ej2_instances && re.ej2_instances[0];
                        if (inst) inst.setRecurrenceRule(ScheduleAdapter.editorRule(args.data), args.data.StartTime);
                    }

                    // Configure datetime pickers with strictMode and the user's chosen date format.
                    // Syncfusion's default is en-US (M/d/yy) which is ambiguous internationally
                    // (1/7/26 = Jan 7 in US, July 1 elsewhere). resolveDateFormat() picks a
                    // pattern from globalSettings.dateFormat, falling back to navigator.language.
                    const startElement = args.element.querySelector('[name="StartTime"]');
                    const endElement = args.element.querySelector('[name="EndTime"]');
                    const dateFmt = this.resolveDateFormat();
                    const timeFmt = this.globalSettings.timeFormat === '24' ? 'HH:mm' : 'hh:mm a';
                    const dateTimeFmt = `${dateFmt} ${timeFmt}`;

                    if (startElement && startElement.ej2_instances && startElement.ej2_instances[0]) {
                        const startPicker = startElement.ej2_instances[0];
                        startPicker.strictMode = true;
                        startPicker.format = dateTimeFmt;
                    }

                    if (endElement && endElement.ej2_instances && endElement.ej2_instances[0]) {
                        const endPicker = endElement.ej2_instances[0];
                        endPicker.strictMode = true;
                        endPicker.format = dateTimeFmt;
                    }

                    function setColor(id) {
                        if (!window.btnObj) {
                            return;
                        }

                        window.btnObj.element.style.background = app.COLORS[id - 1];
                        // The color is a form field (name="Type", class e-field): Syncfusion reads
                        // it into the record it hands actionBegin, and the store saves that. Nothing
                        // writes into Syncfusion's own event objects.
                        window.inputEle.setAttribute('value', id);
                        window.inputEle.value = id;
                        // Whether people categorise events at all decides if type
                        // labels/colors are worth building on (see pro.md).
                        track(a => a.featureUsed('event_type', 'popup'));
                        // console.log("Color set to:", id, "for event:", args.data);
                    }

                    // Initial setup
                    if (!args.element.querySelector('.custom-field-row-color')) {

                        // console.log("Initial args", args);

                        // button dropdown
                        // TODO: allow live edit (vs reload for types)
                        let items = app.getTypes();

                        window.btnObj = new ej.splitbuttons.DropDownButton({
                            items: items,
                            iconCss: 'e-type',
                            select: (button_args) => {
                                // console.log("select type args", button_args);
                                let type = button_args.item.value;
                                // Only the form field changes; the record Syncfusion builds from
                                // the form on Save carries it (see setColor).
                                setColor(type);
                            },
                            open: () => {
                                app.dropdownOpen = true;
                                updateTooltipVisibility();
                            },
                            close: () => {
                                app.dropdownOpen = false;
                                // Take the hint out of the popup on every close. Syncfusion drops
                                // its item list on close and, on the next open, renders the items
                                // into the popup's FIRST CHILD -- which, with the list gone, was
                                // this hint. On phones the hint is hidden, so the colors rendered
                                // inside a hidden div: a 0x0 menu, and no way to change an event's
                                // color after the first time per visit (#32: "impossible de
                                // changer les couleurs"). open re-appends it after the list.
                                if (window.typeTooltip && window.typeTooltip.parentElement) window.typeTooltip.remove();
                                updateTooltipVisibility();
                            }
                        });

                        var createElement = ej.base.createElement;
                        let row = createElement('div', { className: 'custom-field-row-color group' });
                        let formElement = args.element.querySelector('.e-schedule-form');
                        formElement.firstChild.insertBefore(row, args.element.querySelector('.e-description-row'));
                        let container = createElement('div', { className: 'custom-field-container', attrs: { name: 'Type' } });

                        window.inputEle = createElement('input', {
                            className: 'e-type e-field', attrs: { name: 'Type' }
                        });
                        container.appendChild(window.inputEle);
                        row.appendChild(container);

                        btnObj.appendTo(container);
                        window.inputEle.setAttribute('name', 'Type');
                        window.inputEle.style.display = "none";
                        window.inputEle.setAttribute('value', args.data.Type);

                        // Add tooltip for customizing labels (shown in dropdown when opened)
                        let tooltip = createElement('div', {
                            id: 'type-label-hint',
                            className: 'w-full px-4 py-2 text-xs text-center italic hidden flex items-center justify-center gap-1',
                            innerHTML: `Name these colors in Settings`
                        });
                        tooltip.style.background = 'var(--panel-bg)';
                        tooltip.style.color = 'var(--text-color-1)';
                        tooltip.style.borderTop = '1px solid var(--border-color)';
                        // Will be appended to dropdown after it's rendered
                        window.typeTooltip = tooltip;
                    }

                    // Function to update tooltip visibility based on dropdown state
                    window.updateTooltipVisibility = () => {
                        const isDefaultLabels = app.localSettings.typeLabels.every((label, i) => label === `Type ${i + 1}`);
                        const shouldShow = app.dropdownOpen && isDefaultLabels && window.innerWidth >= 768;

                        if (window.typeTooltip) {
                            // Append tooltip to dropdown popup if not already there
                            if (app.dropdownOpen && !window.typeTooltip.parentElement) {
                                const dropdownPopup = document.querySelector('.e-dropdown-popup.e-popup-open ul');
                                if (dropdownPopup) {
                                    dropdownPopup.parentElement.appendChild(window.typeTooltip);
                                }
                            }

                            window.typeTooltip.classList.toggle('hidden', !shouldShow);
                        }
                    };

                    // Initialize dropdown state
                    app.dropdownOpen = false;
                    updateTooltipVisibility();

                    // Initialize with existing type or default to Type 1
                    const initialType = args.data.Type || 1;
                    setColor(initialType);

                    // Make sure the event has a Type property even if not selected
                    if (!args.data.Type) {
                        args.data.Type = 1; // Default to first type if not set
                    }

                    //setColor(args.data.Type);
                }

                // Syncfusion positions the popup (top/left) based on its natural,
                // pre-clamp height -- our CSS max-height on .e-quick-popup-wrapper then
                // shrinks a long-description popup without updating that position, so a
                // popup meant to be vertically centered near the click target can end up
                // with its top or bottom pushed outside the viewport, with no way to scroll
                // back to the clipped part.
                //
                // A JS fix that rewrites style.top after the fact was tried and reverted: it
                // reliably broke the header icon buttons' icon-font glyph paint (edit/delete/
                // close rendered blank) even though DOM and computed styles were identical to
                // the working case -- a genuine paint bug from mutating position mid-transition,
                // not a layout bug. The .pc-clamp-top class (see style.css) instead forces
                // position: fixed + vertical centering via pure CSS, which sidesteps that
                // entirely since it participates in Syncfusion's own layout/paint pass instead
                // of fighting it after the fact.
                //
                // The class must only apply when the popup actually overflows -- applying it
                // unconditionally force-centers every popup regardless of size, dragging a
                // short popup (e.g. a one-line description) away from the event it belongs to
                // even when it would have fit fine at Syncfusion's own position.
                const wrapper = args.element.closest('.e-quick-popup-wrapper');
                if (wrapper) {
                    // Widen the popup for long descriptions -- narrow-column wrapping makes a
                    // multi-paragraph description feel cramped. 480px was chosen (not something
                    // wider, like 700px) specifically to keep collision risk low: on a month view
                    // packed with events, a much wider popup routinely covers a neighboring day's
                    // event, and clicking what looks like that event actually lands on the
                    // popup's own content -- Syncfusion doesn't see it as an event click at all,
                    // so the popup silently keeps showing the wrong title/content at the wrong
                    // position. Rather than chase that with active collision-avoidance (tried:
                    // pushing the popup down until clear doesn't converge on a busy grid, and
                    // shrinking-until-it-fits makes width inconsistent/unpredictable), the fix is
                    // to stay narrow enough that overlap is rare in the first place -- matching
                    // how other calendar apps (e.g. Google Calendar) handle this same tension.
                    // Must run before the overflow clamp below, since widening changes how the
                    // text wraps and therefore how tall (and whether it overflows) the popup ends up.
                    const LONG_DESCRIPTION_THRESHOLD = 140;
                    wrapper.classList.toggle('pc-wide', (args.data.Description || '').length > LONG_DESCRIPTION_THRESHOLD);

                    const applyClampIfOverflowing = () => {
                        const margin = 10;

                        // Syncfusion's own horizontal centering can be wildly wrong -- confirmed
                        // 1000px+ off on a wide viewport, worse right after a different popup was
                        // open and closed (its clamped/offset state seems to leak into the next
                        // centering calculation), but present even on a cold click. Rather than
                        // chase Syncfusion's internal math, anchor to args.target -- the actual
                        // clicked .e-appointment element -- which is ground truth for where the
                        // popup should visually appear, regardless of what Syncfusion computed.
                        if (args.target) {
                            const targetRect = args.target.getBoundingClientRect();
                            const wrapperRect = wrapper.getBoundingClientRect();
                            const offsetParentRect = wrapper.offsetParent
                                ? wrapper.offsetParent.getBoundingClientRect()
                                : { left: 0, top: 0 };

                            let desiredLeft = targetRect.left - offsetParentRect.left;
                            let desiredTop = targetRect.bottom - offsetParentRect.top + margin;

                            // Keep it on-screen: clamp horizontally, and flip above the target if
                            // there's no room below.
                            const viewportLeft = desiredLeft + offsetParentRect.left;
                            if (viewportLeft + wrapperRect.width > window.innerWidth - margin) {
                                desiredLeft -= (viewportLeft + wrapperRect.width) - (window.innerWidth - margin);
                            }
                            if (desiredLeft + offsetParentRect.left < margin) {
                                desiredLeft = margin - offsetParentRect.left;
                            }
                            const viewportTop = desiredTop + offsetParentRect.top;
                            if (viewportTop + wrapperRect.height > window.innerHeight - margin) {
                                desiredTop = (targetRect.top - offsetParentRect.top) - wrapperRect.height - margin;
                            }

                            wrapper.style.left = `${desiredLeft}px`;
                            wrapper.style.top = `${desiredTop}px`;
                        }

                        const rect = wrapper.getBoundingClientRect();
                        const overflowsVertically = rect.top < margin || rect.bottom > window.innerHeight - margin;
                        wrapper.classList.toggle('pc-clamp-top', overflowsVertically);
                    };

                    // popupOpen fires while the wrapper still carries its closed-state class
                    // (e-popup-close) and pre-open position -- Syncfusion applies its final
                    // position asynchronously as part of the open transition. Wait for the
                    // class to flip to e-popup-open before measuring for overflow.
                    if (wrapper.classList.contains('e-popup-open')) {
                        applyClampIfOverflowing();
                    } else {
                        const classObserver = new MutationObserver(() => {
                            if (wrapper.classList.contains('e-popup-open')) {
                                classObserver.disconnect();
                                requestAnimationFrame(applyClampIfOverflowing);
                            }
                        });
                        classObserver.observe(wrapper, { attributes: true, attributeFilter: ['class'] });
                    }
                }
            }

            // Belt to the braces above. Syncfusion can leave a quick popup alive behind the
            // editor (a double-click opens two of them before the editor), and that popup
            // pulls focus into its own title box when the user clicks into the editor's
            // Description -- measured at 3ms after the click. Closing it through the API is
            // not reliable against its own timers, so enforce the rule at the only place
            // that matters: while an editor is open, focus may not enter a quick popup. It
            // goes straight back to the field the user was in, so no keystroke is lost.
            document.addEventListener('focusin', (e) => {
                const target = e.target;
                if (!target || !target.closest || !target.closest('.e-quick-popup-wrapper')) return;
                if (!document.querySelector('.e-schedule-dialog.e-popup-open')) return;
                const back = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.e-schedule-dialog')
                    ? e.relatedTarget
                    : document.querySelector('.e-schedule-dialog.e-popup-open input[name="Subject"]');
                if (back) back.focus();
                if (typeof scheduleObj.closeQuickInfoPopup === 'function') scheduleObj.closeQuickInfoPopup();
            }, true);

            // The date line in an event's popup ("Friday, October 10 (9:00 AM - 10:00 AM)") opens the
            // editor, as the pencil does. People clicked it expecting to change the time, and the
            // click did nothing (Clarity, Oct 2026). Only where the pencil is there to click: view
            // links and locked calendars have none, so their date line stays plain text.
            document.addEventListener('click', (e) => {
                const when = e.target && e.target.closest && e.target.closest('.e-quick-popup-wrapper .e-event-popup .e-date-time');
                if (!when) return;
                const edit = when.closest('.e-quick-popup-wrapper').querySelector('.e-event-popup .e-edit');
                if (edit && !edit.disabled && edit.offsetParent) edit.click();
            });

            scheduleObj.appendTo('#Schedule');

            // A locked calendar's grid is read-only, so a double-click on a day opens nothing at all.
            // Say why, instead of leaving people clicking at a calendar that ignores them.
            try {
                const el = document.getElementById('Schedule');
                if (el) el.addEventListener('dblclick', (e) => {
                    if (this.lockedOut && e.target && e.target.closest && e.target.closest('.e-work-cells, .e-all-day-cells')) {
                        this.showToast(this.lockedOutMessage, 'info');
                    }
                });
            } catch (e) { /* no grid: nothing to explain */ }

            // View links: a click on a day opens that day, as a click on its date number already
            // does. Syncfusion's own day click opens the new-event box, which read-only mode
            // turns off, so on a view link the click did nothing: a third of the day clicks there
            // were dead clicks (Clarity, Oct 2026). Events and "+N more" keep their own popups.
            // A click made while an event popup or "+N more" list is open only closes it (as on an
            // edit link); the popup is already gone by the click, so look at the press.
            let popupAtPress = false;
            scheduleObj.element.addEventListener('pointerdown', () => {
                popupAtPress = !!document.querySelector('.e-quick-popup-wrapper.e-popup-open, .e-more-popup-wrapper.e-popup-open');
            }, true);
            scheduleObj.element.addEventListener('click', (e) => {
                if (!scheduleObj.readonly || scheduleObj.currentView !== 'Month') return;
                if (popupAtPress) {
                    // Read-only mode leaves "+N more" open on an outside click; close it like the event popup.
                    const more = document.querySelector('.e-more-popup-wrapper.e-popup-open');
                    if (more && !more.contains(e.target)) more.querySelector('.e-more-event-close')?.click();
                    return;
                }
                const cell = e.target && e.target.closest && e.target.closest('.e-work-cells');
                if (!cell || e.target.closest('.e-appointment, .e-more-indicator, .e-date-header')) return;
                const day = scheduleObj.getCellDetails(cell);
                if (!day || !day.startTime) return;
                scheduleObj.selectedDate = day.startTime;
                scheduleObj.currentView = 'Day';
            });

            // Syncfusion sizes month-view event chips in pixels from the cell widths it measures
            // while it renders. On first load the grid is still being built (and fonts/styles may
            // still be landing) when events are laid out, so chips can come out ~30px wide until
            // something forces a layout (an edit did). Re-lay-out once after the first events
            // render has settled, and whenever the container's width changes.
            let settleTimer;
            const relayout = () => {
                clearTimeout(settleTimer);
                settleTimer = setTimeout(() => scheduleObj.refreshLayout(), 50);
            };
            // A month-view chip is never narrower than one cell, so a narrower one is stale.
            // Checked after every render (not on a timer, which was a guess about when the grid
            // is done); capped so a view that can't satisfy it can't loop.
            let staleRetries = 0;
            scheduleObj.addEventListener('dataBound', () => {
                requestAnimationFrame(() => {
                    const cell = document.querySelector('.e-schedule .e-month-view .e-work-cells');
                    const chip = document.querySelector('.e-schedule .e-month-view .e-appointment');
                    if (!cell || !chip) { staleRetries = 0; return; }
                    if (chip.getBoundingClientRect().width >= cell.getBoundingClientRect().width * 0.9) { staleRetries = 0; return; }
                    if (staleRetries++ < 3) relayout();
                });
            });
            // Wide screens: the month grid fills the window instead of stopping at 5-6 rows of 100px
            // with empty page below, and the side panel (same grid row) follows. Rows grow, never
            // shrink below 100px; a change re-lays out once so chips sit in the taller cells.
            const fitMonthRows = () => {
                const sched = document.getElementById('Schedule');
                const rows = sched ? sched.querySelectorAll('.e-month-view .e-content-table tbody tr') : [];
                if (!rows.length) return false;
                let h = 100;
                if (window.innerWidth >= 1100) {
                    const rect = sched.getBoundingClientRect();
                    const chrome = rect.height - rows[0].getBoundingClientRect().height * rows.length;
                    // The one line under the calendar (pageFooter) fits in the window too, or every page scrolls.
                    const foot = document.querySelector('.pc-home-cal > .pc-view-footer, .pc-home-cal > .pc-edit-footer, .pc-home-cal > .pc-hosted-note');
                    const cs = foot && getComputedStyle(foot);
                    const footH = foot ? foot.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom) : 0;
                    h = Math.max(100, Math.floor((window.innerHeight - (rect.top + window.scrollY) - 12 - chrome - footH) / rows.length));
                    // The homepage has "How pastecal works" below: keep rows modest so it peeks into view.
                    if (document.getElementById('how')) h = Math.min(h, 116);
                }
                const now = parseFloat(sched.style.getPropertyValue('--month-cell-h')) || 100;
                if (Math.abs(now - h) < 2) return false;
                sched.style.setProperty('--month-cell-h', h + 'px');
                return true;
            };
            scheduleObj.addEventListener('dataBound', () => {
                requestAnimationFrame(() => { if (fitMonthRows()) relayout(); });
            });
            this._refitMonthRows = () => { if (fitMonthRows()) relayout(); };
            let fitTimer = null;
            window.addEventListener('resize', () => {
                clearTimeout(fitTimer);
                fitTimer = setTimeout(() => { if (fitMonthRows()) relayout(); }, 150);
            });
            const calWrap = document.getElementById('cal2_wrap');
            if (calWrap && window.ResizeObserver) {
                let lastWidth = calWrap.offsetWidth;
                new ResizeObserver(() => {
                    const w = calWrap.offsetWidth;
                    if (w && w !== lastWidth) { lastWidth = w; relayout(); }
                }).observe(calWrap);
            }

            // Add event listener to mark month-start dates and colorize year view dots
            scheduleObj.dataBound = function () {
                // hiddenEventCount is scoped to the dates on screen, and the scheduler's view
                // is not a Vue dependency -- without this the count would go stale the moment
                // the user changed week or switched view.
                app.viewTick++;

                // Find all date headers and mark ones with month names (contain space)
                const dateHeaders = document.querySelectorAll('.e-schedule .e-month-view .e-date-header.e-navigate');
                dateHeaders.forEach(header => {
                    const text = header.textContent.trim();
                    // If the text contains a space, it's a month-start date like "Jul 1", "Aug 1"
                    if (text.includes(' ')) {
                        header.classList.add('month-start');
                    } else {
                        header.classList.remove('month-start');
                    }
                });

                // Colorize year view dots based on event types
                if (scheduleObj.currentView === 'Year') {
                    const cells = document.querySelectorAll('.e-year-view td.e-cell[data-date]');
                    const allEvents = scheduleObj.eventsData || [];

                    // Helper to check if a recurring event occurs on a given date
                    const eventOccursOnDate = (event, targetDate) => {
                        const eventStart = new Date(event.StartTime);
                        const eventEnd = new Date(event.EndTime);
                        const targetStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
                        const targetEnd = new Date(targetStart.getTime() + 24 * 60 * 60 * 1000);

                        // Event must have started on or before target date
                        const eventStartDay = new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate());
                        if (eventStartDay > targetStart) return false;

                        // For non-recurring events, check if date overlaps
                        if (!event.RecurrenceRule) {
                            return eventStart < targetEnd && eventEnd > targetStart;
                        }

                        // For recurring events, parse the RecurrenceRule
                        const rule = event.RecurrenceRule;
                        const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
                        const targetDayName = dayNames[targetDate.getDay()];

                        // Check BYDAY constraint
                        const bydayMatch = rule.match(/BYDAY=([^;]+)/);
                        if (bydayMatch) {
                            const allowedDays = bydayMatch[1].split(',');
                            if (!allowedDays.includes(targetDayName)) return false;
                        }

                        // Check FREQ and INTERVAL
                        const freqMatch = rule.match(/FREQ=(\w+)/);
                        const intervalMatch = rule.match(/INTERVAL=(\d+)/);
                        const freq = freqMatch ? freqMatch[1] : 'DAILY';
                        const interval = intervalMatch ? parseInt(intervalMatch[1]) : 1;

                        // Calculate if target date matches the recurrence pattern
                        const daysDiff = Math.floor((targetStart - eventStartDay) / (24 * 60 * 60 * 1000));

                        if (freq === 'DAILY') {
                            return daysDiff % interval === 0;
                        } else if (freq === 'WEEKLY') {
                            // For weekly with BYDAY, just check if day is in BYDAY (already done above)
                            // and target is at least interval weeks from a valid occurrence
                            const weeksDiff = Math.floor(daysDiff / 7);
                            return weeksDiff % interval === 0 || bydayMatch; // BYDAY takes precedence
                        } else if (freq === 'MONTHLY') {
                            // Check if same day of month
                            return eventStart.getDate() === targetDate.getDate();
                        } else if (freq === 'YEARLY') {
                            // Check if same month and day
                            return eventStart.getMonth() === targetDate.getMonth() &&
                                   eventStart.getDate() === targetDate.getDate();
                        }

                        return true; // Default: assume it occurs
                    };

                    cells.forEach(cell => {
                        const appointmentDiv = cell.querySelector('.e-appointment');
                        if (!appointmentDiv) return;

                        // Get the date for this cell
                        const dateMs = parseInt(cell.getAttribute('data-date'));
                        const cellDate = new Date(dateMs);

                        // Find all events that occur on this date
                        const eventsOnDate = allEvents.filter(event => eventOccursOnDate(event, cellDate));

                        if (eventsOnDate.length > 0) {
                            // Get unique event types for this day
                            const types = [...new Set(eventsOnDate.map(e => e.Type || 1))];

                            if (types.length === 1) {
                                // Single type: color the dot with that type's color
                                const color = app.COLORS[types[0] - 1] || app.COLORS[0];
                                appointmentDiv.style.backgroundColor = color;
                            } else {
                                // Multiple types: show multiple dots
                                appointmentDiv.style.display = 'none';

                                // Remove any existing color dots
                                cell.querySelectorAll('.color-dot').forEach(d => d.remove());

                                // Create a container for multiple dots
                                const dotsContainer = document.createElement('div');
                                dotsContainer.className = 'color-dots-container';
                                dotsContainer.style.cssText = 'display: flex; gap: 2px; justify-content: center; margin-top: 2px;';

                                // Add a dot for each type (max 3 to avoid overflow)
                                types.slice(0, 3).forEach(type => {
                                    const dot = document.createElement('div');
                                    dot.className = 'color-dot';
                                    const color = app.COLORS[type - 1] || app.COLORS[0];
                                    dot.style.cssText = `width: 4px; height: 4px; border-radius: 50%; background-color: ${color};`;
                                    dotsContainer.appendChild(dot);
                                });

                                cell.appendChild(dotsContainer);
                            }
                        }
                    });
                }
            };
            return CalendarView.syncfusion(scheduleObj, this);
        },

        // ============================================================
        // REGION: Calendar Initialization & Setup
        // ============================================================

        // Ensure calendar.options has proper default values
        ensureCalendarOptionsDefaults() {
            const hasOptions = !!this.calendar.options;
            const existingOptions = hasOptions ? this.calendar.options : {};
            const normalizedOptions = { ...existingOptions };
            let shouldReplace = !hasOptions;

            // Ensure defaultView is null (not undefined) for proper dropdown binding
            if (!Object.prototype.hasOwnProperty.call(normalizedOptions, 'defaultView')) {
                normalizedOptions.defaultView = null;
                shouldReplace = true;
            }
            if (!Object.prototype.hasOwnProperty.call(normalizedOptions, 'customViewDuration') ||
                normalizedOptions.customViewDuration === undefined) {
                const fallbackDuration = this.globalSettings.customViewDuration ?? 3;
                normalizedOptions.customViewDuration = fallbackDuration;
                shouldReplace = true;
            }
            if (!Object.prototype.hasOwnProperty.call(normalizedOptions, 'customViewUnit') ||
                normalizedOptions.customViewUnit === undefined) {
                const fallbackUnit = this.globalSettings.customViewUnit ?? 'Months';
                normalizedOptions.customViewUnit = fallbackUnit;
                shouldReplace = true;
            }

            if (shouldReplace) {
                this.calendar.options = normalizedOptions;
            }
        },

        // ============================================================
        // REGION: View Management & Calendar Display
        // ============================================================

        // Apply default view to schedule (if no URL override)
        applyDefaultView() {
            // Parsed, not substring-matched: "?hv=below" contains "v=" but is not a view.
            const params = new URLSearchParams(window.location.search);
            if (!params.has('view') && !params.has('v')) {
                let defaultView = this.calendar?.options?.defaultView || this.globalSettings.defaultView || 'Month';
                const actualViewName = this.getActualViewName(defaultView);

                const viewIndex = scheduleObj.views.findIndex(v => {
                    if (typeof v === 'string') {
                        return v === actualViewName;
                    } else if (typeof v === 'object' && v.displayName) {
                        return v.displayName === actualViewName;
                    }
                    return false;
                });

                if (viewIndex === -1) {
                    console.warn('[applyDefaultView] View not found in schedule:', actualViewName);
                    return;
                }

                const activateViewIfReady = () => {
                    const viewButtons = document.querySelectorAll('.e-toolbar-item.e-views button');
                    const targetButton = viewButtons[viewIndex];
                    if (!targetButton) {
                        return false;
                    }
                    const buttonLabel = (targetButton.getAttribute('aria-label') || targetButton.textContent || '').trim();
                    if (buttonLabel && buttonLabel.toLowerCase().includes(actualViewName.toLowerCase())) {
                        targetButton.click();
                        return true;
                    }
                    return false;
                };

                if (activateViewIfReady()) {
                    return;
                }

                if (this._pendingViewActivationHandler) {
                    scheduleObj.removeEventListener('dataBound', this._pendingViewActivationHandler);
                    this._pendingViewActivationHandler = null;
                }
                if (this._pendingViewActivationTimeout) {
                    clearTimeout(this._pendingViewActivationTimeout);
                    this._pendingViewActivationTimeout = null;
                }

                const dataBoundHandler = () => {
                    if (activateViewIfReady()) {
                        scheduleObj.removeEventListener('dataBound', dataBoundHandler);
                        this._pendingViewActivationHandler = null;
                        if (this._pendingViewActivationTimeout) {
                            clearTimeout(this._pendingViewActivationTimeout);
                            this._pendingViewActivationTimeout = null;
                        }
                    }
                };

                this._pendingViewActivationHandler = dataBoundHandler;
                scheduleObj.addEventListener('dataBound', dataBoundHandler);

                this._pendingViewActivationTimeout = setTimeout(() => {
                    scheduleObj.removeEventListener('dataBound', dataBoundHandler);
                    this._pendingViewActivationHandler = null;
                    this._pendingViewActivationTimeout = null;
                    if (!activateViewIfReady()) {
                        console.error('[applyDefaultView] Unable to activate view after waiting for dataBound events:', actualViewName);
                    }
                }, 10000);
            }
        },

        // Apply theme based on user preference and system settings
        applyTheme() {
            let isDark = false;
            // ?theme=light|dark (an embed matching its host page) wins, as in index.html's first-paint script.
            const forced = (() => { try { return new URLSearchParams(location.search).get('theme'); } catch (e) { return null; } })();

            if (forced === 'light' || forced === 'dark') {
                isDark = forced === 'dark';
            } else if (this.globalSettings.darkMode === 'auto') {
                // Use system preference
                isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            } else {
                // Use explicit user preference
                isDark = this.globalSettings.darkMode === 'dark';
            }

            document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
            this.swapSyncfusionTheme(isDark);
        },
        swapSyncfusionTheme(dark) {
            // One self-hosted stylesheet per theme (scripts/build-vendor.sh), pinned to the
            // same Syncfusion version as the JS. index.html already loaded the right one
            // before first paint, so this is normally a no-op; it only works when the user
            // changes the setting. The new sheet is added and the old removed once it has
            // loaded: pointing the existing <link> at a new href drops the old rules first,
            // leaving the page unstyled (and Syncfusion measuring a collapsed grid) until
            // the new file arrives.
            const link = document.getElementById('syncfusion-theme');
            if (!link) return;
            // A switch whose sheet is still loading is stale once the setting changes again
            // (light -> dark -> light before the dark file arrives): drop it, or its late onload
            // swaps in the wrong theme and leaves two sheets claiming the id.
            if (this._themeLoading) { this._themeLoading.onload = null; this._themeLoading.remove(); this._themeLoading = null; }
            const file = dark ? 'material-dark.css' : 'material.css';
            const url = new URL(link.href, location.href);
            if (url.pathname.endsWith('/' + file)) return;
            url.pathname = url.pathname.replace(/[^/]+$/, file);
            const next = link.cloneNode();
            next.removeAttribute('id');
            next.href = url.href;
            this._themeLoading = next;
            next.onload = () => {
                if (this._themeLoading !== next) return;
                this._themeLoading = null;
                link.remove();
                next.id = 'syncfusion-theme';
                if (window.scheduleObj) window.scheduleObj.refreshLayout();
            };
            link.after(next);
        },

        // Validate custom view configuration
        validateCustomView(duration, unit) {
            const maxWeeks = 52;
            const maxMonths = 24;

            if (unit === 'Weeks') {
                return duration >= 1 && duration <= maxWeeks;
            } else if (unit === 'Months') {
                return duration >= 1 && duration <= maxMonths;
            }
            return false;
        },

        // Build custom view configuration for Syncfusion
        buildCustomViewConfig(duration, unit) {
            // Validate inputs
            if (!this.validateCustomView(duration, unit)) {
                console.warn('Invalid custom view configuration, using defaults');
                duration = 3;
                unit = 'Months';
            }

            // Build dynamic display name
            const unitLabel = duration === 1 ? unit.slice(0, -1) : unit; // Singular/plural
            const displayName = `${duration} ${unitLabel}`;

            // Standard interval view
            const baseOption = unit === 'Weeks' ? 'Week' : 'Month';
            return {
                option: baseOption,
                displayName: displayName,
                interval: duration
            };
        },

        // Update the custom view in the schedule when duration/unit changes
        updateCustomViewInSchedule(shouldRefresh = false) {
            if (!window.scheduleObj || !window.scheduleObj.views) {
                return;
            }

            // Get the current custom view configuration
            const customViewDuration = this.calendar?.options?.customViewDuration || this.globalSettings.customViewDuration;
            const customViewUnit = this.calendar?.options?.customViewUnit || this.globalSettings.customViewUnit;
            const newCustomViewConfig = this.buildCustomViewConfig(customViewDuration, customViewUnit);

            // Find the custom view index (it's the object with interval property)
            const customViewIndex = scheduleObj.views.findIndex(v =>
                typeof v === 'object' && v.interval !== undefined
            );

            if (customViewIndex !== -1) {
                const oldDisplayName = scheduleObj.views[customViewIndex].displayName;
                const currentView = scheduleObj.currentView;

                // Replace the custom view
                scheduleObj.views[customViewIndex] = newCustomViewConfig;

                // If we're currently viewing the custom view, update the currentView
                if (currentView === oldDisplayName) {
                    scheduleObj.currentView = newCustomViewConfig.displayName;
                }

                // Refresh the schedule to update the header (only if user actively changed settings)
                if (shouldRefresh) {
                    scheduleObj.refresh();
                }
            } else {
            }
        },

        // Get the actual Syncfusion view name for a given default view setting
        // Converts "Custom" to the actual display name like "3 Months"
        getActualViewName(viewSetting) {
            // Handle null/undefined viewSetting - default to Month
            if (!viewSetting) {
                return 'Month';
            }

            if (viewSetting !== 'Custom') {
                return viewSetting;
            }

            // For Custom view, we need to find the custom view in the scheduleObj.views array
            if (typeof window.scheduleObj !== 'undefined' && window.scheduleObj && window.scheduleObj.views) {
                // Find the custom view (it's the one with interval property and not a string)
                const customView = window.scheduleObj.views.find(v =>
                    typeof v === 'object' && v.interval !== undefined && v.displayName
                );
                if (customView) {
                    return customView.displayName;
                }
            }

            // Fallback: compute it from settings
            const duration = this.calendar?.options?.customViewDuration || this.globalSettings.customViewDuration || 3;
            const unit = this.calendar?.options?.customViewUnit || this.globalSettings.customViewUnit || 'Months';
            const unitLabel = duration === 1 ? unit.slice(0, -1) : unit;
            return `${duration} ${unitLabel}`;
        },

        clearLocalStorage() {
            localStorage.removeItem("calendar");
            try { localStorage.removeItem('pastecal_template'); } catch (e) { /* nothing to clear */ }
        },

        resetToDefaults() {
            // Reset to a completely fresh calendar state
            this.calendar.id = Utils.randomID(10);
            this.calendar.title = "New Calendar";
            this.calendar.events = [];
            this.calendar.options = {
                notes: '',
                defaultView: 'month'
            };
            this.calendar.setEvents(this.calendar.sampleEvents());
            // Reset local settings to defaults
            this.initializeLocalSettings();
        },

        loadLocalStorage() {
            var c = null;
            try {
                c = JSON.parse(localStorage.getItem("calendar"));
            } catch (e) {
                console.warn('Ignoring unreadable saved draft:', e && e.message);
            }
            if (c && typeof c === 'object' && !Array.isArray(c)) {
                // Load ALL draft data from localStorage (ID, title, events, settings, colors, notes, etc.)
                this.calendar.import(c);
                // Keep the draft's events/settings but not its URL name: a name typed on an
                // earlier visit (maybe taken, maybe abandoned) shouldn't come back as the suggestion.
                this.calendar.id = Utils.randomID(10);
                // Re-initialize local settings to load custom colors and labels
                this.initializeLocalSettings();
            } else {
                // No localStorage data (fresh start after save, or first visit)
                this.resetToDefaults();
            }
        },

        // "Make your own copy" from a locked calendar: the events become a new unsaved draft on
        // the homepage, under a new name, for the visitor to Save & share as their own. Nothing
        // touches the original. A draft they already had with events of their own is kept aside
        // (pastecal_previous_draft) rather than silently replaced.
        // Also from Settings ("Make a copy", for next season or your own use), and, as 'style', from the
        // "Make one like this" line under a calendar you didn't make: same colors and type names, no events.
        makeOwnCopy(mode = 'full', from = 'locked') {
            const src = JSON.parse(JSON.stringify(this.calendar));
            const o = src.options || {};
            const copy = mode === 'style'
                ? { id: Utils.randomID(10), title: 'New Calendar', events: [],
                    options: { ...(Array.isArray(o.colors) ? { colors: o.colors } : {}), ...(Array.isArray(o.typeLabels) ? { typeLabels: o.typeLabels } : {}) } }
                : {
                id: Utils.randomID(10),
                title: `Copy of ${Calendar.displayTitle ? Calendar.displayTitle(src.title) : (src.title || 'calendar')}`,
                events: (src.events || []).map((e) => ({ ...e, secret: undefined })),
                options: { ...o, publicViewId: undefined },
            };
            try {
                const prev = JSON.parse(localStorage.getItem('calendar') || 'null');
                const mine = prev && Array.isArray(prev.events) && prev.events.some((e) => !Calendar.isSampleTitle(e.title || e.Subject));
                if (mine) localStorage.setItem('pastecal_previous_draft', JSON.stringify(prev));
                localStorage.setItem('calendar', JSON.stringify(copy));
            } catch (e) {
                this.showToast && this.showToast("Couldn't make a copy: this browser blocks saving.", 'error');
                return;
            }
            track(a => a.featureUsed && a.featureUsed(from === 'locked' ? 'locked_copy' : `copy_${mode}_${from}`));
            (window.top || window).location.href = '/?from=' + encodeURIComponent(from);
        },

        saveLocalStorage() {
            // Only save to localStorage when on homepage
            // Named calendars should never overwrite homepage data
            if (this.isHomepageCalendar) {
                localStorage.setItem("calendar", JSON.stringify(this.calendar));
            }
        },

        // A per-browser copy of the last good state of a NAMED calendar. Until now a
        // named calendar had no local copy at all -- saveLocalStorage() is homepage-only
        // -- so an edit that never reached the server (offline, closed tab, or the Sept
        // 2026 save bug) existed nowhere once the tab was gone.
        //
        // This is a net for the person who did the editing, not a guarantee: it is
        // per-device, cleared with site data, and can be stale if someone else edited
        // since. It is never auto-applied; the server-side /history node is the durable
        // record. Kept for the last three calendars visited so it stays bounded.
        //
        // Never overwrites a copy that has events with one that has none: the failure this
        // exists for is precisely "the events just vanished", and recording that state
        // would destroy the one copy worth keeping.
        saveLocalBackup() {
            if (!this.calendar || !this.calendar.id || !this.isExisting) return;
            try {
                const key = 'pastecal_backup_' + this.calendar.id;
                const events = this.calendar.events || [];
                if (events.length === 0) {
                    const existing = JSON.parse(localStorage.getItem(key) || 'null');
                    if (existing && existing.events && existing.events.length > 0) return;
                }
                localStorage.setItem(key, JSON.stringify({
                    savedAt: Date.now(),
                    id: this.calendar.id,
                    title: this.calendar.title,
                    options: this.calendar.options,
                    events,
                }));
                const index = JSON.parse(localStorage.getItem('pastecal_backup_index') || '[]')
                    .filter(k => k !== key);
                index.push(key);
                while (index.length > 3) localStorage.removeItem(index.shift());
                localStorage.setItem('pastecal_backup_index', JSON.stringify(index));
            } catch (e) {
                // Quota or private mode. The server is the store; this is only a net.
            }
        },

        updateCalendarView() {
            if (!this.calView) return;   // before mounted() built the calendar: it draws the events when it mounts
            if (this.nativeCard) this.$nextTick(() => this.nativeCardRefresh());   // the open card follows a change from elsewhere
            // Syncfusion is handed display records (ScheduleAdapter.toView); the native calendar reads
            // calendar.events itself. Either way the color filter is one predicate, isEventVisible (#41):
            // a second definition of "visible" (Syncfusion's ej.data.Query allow-list) is how every round
            // of #41 happened. CalendarView.render() hands the grid only what it admits.
            if (this.calView.kind === 'syncfusion') this.syncFusionEvents = this.calendar.getSyncFusionEvents();
            this.calView.render();
        },

        /**
         * The EventStore for this calendar -- the one place events change. It saves through
         * the existing path (calendar.setEvents -> CalendarDataService), so what is stored
         * and how it syncs are unchanged; it decides WHAT goes into that list.
         */
        store() {
            if (!this._eventStore) {
                this._eventStore = new EventStore({
                    getEvents: () => this.calendar.events,
                    commit: (list, info) => {
                        // The write gate refuses a save that shrinks the calendar unless the
                        // shrink was declared. The store knows the exact number, so it is
                        // declared here and nowhere else.
                        // Named by key as well, so a refused write knows WHICH rows were deleted
                        // on purpose instead of guessing (see CalendarDataService.sync).
                        if (info.shrink) {
                            const kept = new Set(list.map(EventStore.keyOf));
                            CalendarDataService.declareIntent(info.shrink,
                                (this.calendar.events || []).map(EventStore.keyOf).filter(k => !kept.has(k)));
                        }
                        this.calendar.setEvents(list);
                    },
                    onError: (err, command) => {
                        console.warn('[store] command failed:', err.code, command && command.type);
                        // Analytics gets a code, never an event's text (EventStore.report); the title is for the toast only.
                        const sent = EventStore.report(err, command);
                        track(a => a.jsError('command_failed', sent.message, sent.where));
                        this.showToast(err.userMessage || `Couldn't save that change: ${err.title ? `"${err.title}" ` : ''}${err.message.replace(/^\w+: /, '')}`, 'error');
                    },
                });
            }
            return this._eventStore;
        },

        /** A grid action (Syncfusion's add / change / remove, cancelled in actionBegin) -> the store. */
        applyScheduleAction(args) {
            const active = window.scheduleObj && window.scheduleObj.activeEventData && window.scheduleObj.activeEventData.event;
            const ui = (window.scheduleObj && window.scheduleObj.uiStateValues) || {};
            const context = {
                action: window.scheduleObj && window.scheduleObj.currentAction,
                occurrenceStart: active && active.StartTime,
                keepOccurrences: !!ui.isIgnoreOccurrence,
            };
            // Syncfusion clears this flag in the step we cancel; clear it so a "No" here
            // cannot leak into the next series edit.
            ui.isIgnoreOccurrence = false;
            return this.commitScheduleAction(args, context);
        },

        /**
         * One calendar action, in Syncfusion's record shapes (ScheduleAdapter), -> the store: the one write path both
         * calendars share. The classic grid hands its own actionBegin args here (applyScheduleAction); the native one
         * builds the same args from what the person did (nativeAction). context: { action ('Add' | 'Save' | 'Delete' |
         * 'EditOccurrence' | 'DeleteOccurrence' | 'EditSeries' | 'DeleteSeries'), occurrenceStart, keepOccurrences }.
         * Returns true when something was saved.
         */
        commitScheduleAction(args, context) {
            let command;
            try {
                command = ScheduleAdapter.toCommand(args, this.store(), context);
            } catch (err) {
                // An action the adapter cannot map safely: nothing is saved, the person is
                // told, and it is logged with the action name (command_failed).
                this.store().onError(err, { type: 'schedule', where: `${args.requestType}/${context && context.action}` });
                return false;
            }
            if (!command.commands.length) return false;
            const deleting = args.requestType === 'eventRemove';
            const subject = (r) => r && r.Subject ? `"${String(r.Subject).trim()}"` : 'event';
            const records = [...(args.deletedRecords || []), ...(args.changedRecords || [])];
            const label = !deleting ? (args.requestType === 'eventCreate' ? 'Added event' : `Edited ${subject(records[0] || (args.addedRecords || [])[0])}`)
                : (args.deletedRecords || []).length > 1 && !(args.deletedRecords || []).some(r => r.RecurrenceRule) ? `Deleted ${args.deletedRecords.length} events`
                : (args.deletedRecords || []).length ? `Deleted ${subject(args.deletedRecords[0])}`
                : `Deleted one ${subject(records[0])}`;
            const r = this.store().dispatch(command, { label });
            if (!r.ok) return false;
            // A real, user-initiated change to this calendar (sync() also runs for other
            // people's edits echoing back, so it cannot be recorded there).
            if (this.isExisting && typeof AuthorSignal !== 'undefined') AuthorSignal.touch(this.calendar.id);
            if (args.requestType === 'eventCreate') { track(a => a.eventAdded('grid', this.calendar)); this.noteHomepageEvent(); }
            if (deleting) this.offerUndo(label);
            return true;
        },

        // ============================================================
        // REGION: Calendar CRUD Operations
        // ============================================================

        // Hide or show the homepage pitch column. Remembered in this browser, so someone who
        // comes back to make another calendar keeps the full-width calendar.
        toggleHomeAside() {
            this.homeAsideHidden = !this.homeAsideHidden;
            try { localStorage.setItem('pc_home_aside', this.homeAsideHidden ? 'hidden' : 'shown'); } catch (e) { /* this visit only */ }
            track(a => a.track('feature_used', { feature: this.homeAsideHidden ? 'home_aside_hidden' : 'home_aside_shown' }));
            // The calendar measures its width only on window resize; tell it the column moved.
            this.$nextTick(() => { if (this.calView) this.calView.refreshLayout(); });
        },

        // One tour_seen per section per page view, when half of it is on screen.
        observeTour() {
            try {
                const root = document.getElementById('how');
                if (!root || typeof IntersectionObserver === 'undefined') return;
                const seen = new Set();
                const io = new IntersectionObserver((entries) => {
                    for (const e of entries) {
                        const section = e.target.dataset.tour;
                        if (!e.isIntersecting || seen.has(section)) continue;
                        seen.add(section);
                        io.unobserve(e.target);
                        track(a => a.tourSeen(section));
                    }
                }, { threshold: 0.5 });
                root.querySelectorAll('[data-tour]').forEach(el => io.observe(el));
            } catch (e) { /* observational only */ }
        },

        // The first event someone adds on the homepage: the tip has done its job, and Share
        // gets one gentle pulse, because now a link is worth having.
        // The example event makes room for it at the same moment.
        noteHomepageEvent() {
            if (!this.isHomepageCalendar || this.userAddedEvent) return;
            this.userAddedEvent = true;
            this.sharePulse = true;
            setTimeout(() => { this.sharePulse = false; }, 3500);
            // After Syncfusion finishes the add that called us.
            setTimeout(() => {
                if (this.dropSampleEvents()) {
                    this.updateCalendarView();
                    this.saveLocalStorage();
                }
            }, 0);
        },

        // ---- "Start from" templates (homepage draft only; utils/templates.js) ----

        templateLabel(id) {
            return CalendarTemplates.label(id);
        },

        templateDate(state) {
            const [y, m] = String(state.date).split('-').map(Number);
            return new Date(y, m - 1, 1, 12);
        },

        // The template's events still on the draft exactly as it made them. One the visitor changed
        // (or one left from an earlier template) is theirs from then on, and nothing here removes it.
        templateOwned(state = this.template) {
            if (!state) return [];
            const built = CalendarTemplates.build(state.id, this.templateDate(state));
            if (!built) return [];
            const pristine = new Map(built.events.map(e => [String(e.id), EventStore.normalize(e)]));
            return (this.calendar.events || []).filter(e => {
                const p = e && pristine.get(String(e.id));
                return p && !Object.keys(EventStore.diff(EventStore.normalize(e), p)).length;
            });
        },

        // Switching templates is instant: no "are you sure", because one Undo (toast or Cmd+Z) puts back
        // exactly what was there, the same rule as deleting an event.
        toggleTemplates() {
            this.templatesOpen = !this.templatesOpen;
            try { sessionStorage.setItem('pc_tpl_open', this.templatesOpen ? '1' : '0'); } catch (e) { /* this page view only */ }
        },

        pickTemplate(id) {
            this.tplMore = false;   // the guide panel's line folds back to 'Template: X · Start blank · Other templates…'
            if (this.template && this.template.id === id) return;
            this.applyTemplate(id);
        },

        startBlank() {
            this.applyTemplate(null);
        },

        dismissTemplateNudge() {
            this.templateNudge = false;
            this._templateNudgeDismissed = true;
        },

        // Swap the draft's template events for another template's (or for none) as ONE store change,
        // so they save like any events and one Cmd+Z puts back exactly what was there.
        applyTemplate(id) {
            const anchor = (window.scheduleObj && scheduleObj.selectedDate) || new Date();
            const next = id ? { id, date: `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-01` } : null;
            const built = next && CalendarTemplates.build(id, this.templateDate(next));
            const events = this.calendar.events || [];
            // Every template event goes, edited or not (Undo brings them back); events the visitor made stay.
            const fromTemplate = (e) => e && String(e.id).startsWith(CalendarTemplates.PREFIX);
            const going = events.filter(e => fromTemplate(e) || (e && Calendar.isSampleTitle(e.title || e.Subject)));
            // Only a switch that discards the visitor's own edits offers Undo; an untouched template has nothing to undo.
            const editedGone = going.filter(fromTemplate).length > this.templateOwned().length;
            const commands = going.map(e => ({ type: 'remove', key: EventStore.keyOf(e) }));
            if (built) built.events.forEach(e => commands.push({ type: 'add', event: e }));
            // Back to a fresh draft: the example event returns, as on a first visit.
            else if (going.length === events.length) this.calendar.sampleEvents().forEach(e => commands.push({ type: 'add', event: e }));
            const before = this.template;
            if (commands.length) {
                const label = id ? `Started from ${CalendarTemplates.label(id)}` : 'Cleared the template';
                const r = this.store().dispatch({ type: 'batch', commands, label }, { label });
                if (!r.ok) return;
                // Undoing this change also puts the template before it back (undoLastLocal).
                const stack = this.store().undoStack;
                (this._templateUndo = this._templateUndo || []).push({ entry: stack[stack.length - 1], state: before });
            }
            this.setTemplate(next);
            clearTimeout(this._templateUndoTimer);
            this.templateUndo = commands.length > 0 && editedGone;
            if (this.templateUndo) this._templateUndoTimer = setTimeout(() => { this.templateUndo = false; }, 8000);
            if (id) {
                this.templateNudge = !this._templateNudgeDismissed;
                track(a => a.featureUsed('template', id));
            }
        },

        // Point the draft at another template (or none). Its title, notes and color names follow, but
        // only where they still read as the last template (or a fresh draft) left them: nothing the
        // visitor typed is replaced. Never the URL name; that stays the visitor's to pick.
        setTemplate(next) {
            const was = this.template && CalendarTemplates.build(this.template.id, this.templateDate(this.template));
            const now = next && CalendarTemplates.build(next.id, this.templateDate(next));
            const plain = (i) => `Type ${i + 1}`;
            if (!this.calendar.options) this.calendar.options = {};
            const o = this.calendar.options;
            if ((this.calendar.title || Calendar.DEFAULT_TITLE) === (was ? was.title : Calendar.DEFAULT_TITLE)) this.calendar.title = now ? now.title : Calendar.DEFAULT_TITLE;
            if ((o.notes || '').trim() === (was ? was.notes : '')) o.notes = now ? now.notes : '';
            const labels = [...(this.localSettings.typeLabels || [])];
            for (let i = 0; i < 8; i++) {
                if ((labels[i] || plain(i)) === (was ? was.typeLabels[i] : plain(i))) labels[i] = now ? now.typeLabels[i] : plain(i);
            }
            this.localSettings.typeLabels = labels;
            this.storeTypeLabelsInCalendarOptions();
            this.template = next;
            if (!next) this.templateNudge = false;
            try {
                if (next) localStorage.setItem('pastecal_template', JSON.stringify(next));
                else localStorage.removeItem('pastecal_template');
            } catch (e) { /* this visit only: its events are still ordinary draft events */ }
        },

        // A reload of a templated draft: the template is still "on" while any of its events are untouched.
        restoreTemplate() {
            let state = null;
            try { state = JSON.parse(localStorage.getItem('pastecal_template') || 'null'); } catch (e) { /* none */ }
            if (state && CalendarTemplates.label(state.id) && /^\d{4}-\d{2}-\d{2}$/.test(state.date) && this.templateOwned(state).length) {
                this.template = state;
                this.templateNudge = true;
            } else {
                try { localStorage.removeItem('pastecal_template'); } catch (e) { /* nothing stored */ }
            }
        },

        // Remove the untouched example event. True when it was removed.
        dropSampleEvents() {
            const events = this.calendar.events || [];
            const kept = events.filter(e => !(e && Calendar.isSampleTitle(e.title || e.Subject)));
            if (!kept.length || kept.length === events.length) return false;
            this.calendar.setEvents(kept);
            return true;
        },

        // A link name from the calendar's title, else its first event: "Soccer Fall 2026" ->
        // "soccer-fall-2026". Null when there is nothing better than the random name.
        suggestedSlug() {
            // Never from a template's title or events: the visitor picks the name, and "tigers-u10-soccer"
            // would be taken by the second person to try the template anyway.
            const own = (this.calendar.events || []).find(e => e && (e.title || e.Subject) && !Calendar.isSampleTitle(e.title || e.Subject) && !CalendarTemplates.templateOf(e));
            const fromTemplate = this.template && this.calendar.title === CalendarTemplates.build(this.template.id, this.templateDate(this.template)).title;
            const source = (this.calendar.title && this.calendar.title !== 'New Calendar' && !fromTemplate) ? this.calendar.title : (own && (own.title || own.Subject));
            if (!source) return null;
            const slug = String(source).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
            return slug.length >= 3 ? slug : null;
        },

        // Share on a draft: ask for a name first (suggested from the title), unless one was typed.
        // This was a second create() until Oct 2026; the later create() replaced it, so the naming
        // dialog never appeared and Claim saved the random name straight away.
        share() {
            if (!this.userHasEditedSlug) {
                const suggestion = this.suggestedSlug();
                if (suggestion) this.calendar.id = suggestion;
                this.showClaimDialog = true;
                // Focus input in dialog on next tick
                this.$nextTick(() => {
                    if (this.$refs.claimInput) {
                        this.$refs.claimInput.focus();
                        this.$refs.claimInput.select();
                    }
                });
                return;
            }

            this.confirmClaim();
        },

        confirmClaim() {
            if (this.calendar.id) {
                // Proceed with creation
                this.create();
                this.showClaimDialog = false;
            }
        },

        create() {
            // The example event only shows what a calendar looks like; it is never part of
            // someone's real calendar. One they edited has a new title, so it stays.
            if (this.isHomepageCalendar && this.userAddedEvent) this.dropSampleEvents();
            let slug = this.calendar.id;
            if (!slug) {
                slug = Utils.randomID(10);
                this.calendar.id = slug;
            }

            // normalize. A name typed here is trimmed (once, now: from then on the name is exact everywhere); one that
            // came from the address ("/royal%20city%20", a draft saved where it was opened) is kept as it is.
            if (this.userHasEditedSlug && slug.trim()) slug = slug.trim();
            slug = SlugManager.normalizeSlug(slug);
            this.calendar.id = slug;

            // Whether the name was chosen or just accepted is the whole naming
            // question -- a claim of an untouched generated id is not evidence
            // that anyone wanted that name.
            const chosen = this.userHasEditedSlug;

            // check for existing
            CalendarDataService.checkExists(slug, () => {
                track(a => a.track('slug_claim_failed', {
                    where: 'calendar_url',
                    reason: 'taken',
                }));
                // Say so without a blocking alert, and offer names that are free (60 of
                // the 83 failed claims in 30 days were "taken": a dead end with no way on).
                this.offerSlugAlternatives(slug);
            }, () => {
                // does not exist, proceed
                this.isLoading = true;
                // Template ids ("tpl-team-3") mean something only on the draft. Saved, each event gets an id
                // of its own, or two calendars made from one template would share iCal UIDs in a subscriber's app.
                if (this.calendar.events.some(e => CalendarTemplates.templateOf(e))) {
                    this.calendar.setEvents(this.calendar.events.map(e => CalendarTemplates.templateOf(e) ? { ...e, id: Utils.uuidv4() } : e));
                }
                CalendarDataService.createWithId(slug, this.calendar, () => {
                    // The calendar now exists on the server. Fired separately from
                    // the slug events below because those answer "did they choose a
                    // name" and the read-only-link flow reuses their names for
                    // something that is not a new calendar at all.
                    track(a => a.calendarCreated(chosen, this.calendar));

                    // `where` matches the tag SlugManager puts on the read-only
                    // link flow, so the two never get conflated in reporting.
                    if (chosen) {
                        track(a => a.track('slug_claimed', {
                            where: 'calendar_url',
                            slug_length: slug ? slug.length : 0,
                            event_count_bucket: a.bucketEvents(this.calendar?.events?.length),
                        }));
                    } else {
                        track(a => a.track('slug_autoassigned', {
                            where: 'calendar_url',
                            event_count_bucket: a.bucketEvents(this.calendar?.events?.length),
                        }));
                    }
                    if (this.template) track(a => a.featureUsed('template_saved', this.template.id));
                    // success - clear localStorage so homepage starts fresh next time
                    this.clearLocalStorage();
                    // Record in recents here rather than relying on the post-redirect
                    // load to do it, so a calendar you just made is always in the list.
                    // Flagged `mine` so it's stored durably and never evicted by the
                    // recents cap — this list is the only way back without a login.
                    this.recentManager.add(slug, this.calendar.title, true);
                    this.recentCalendars = this.recentManager.getAll();
                    this.showToast('Calendar saved', 'success');
                    try { sessionStorage.setItem('pastecal_open_share', slug); } catch (e) { /* the links are still under Share */ }
                    window.location.href = CalendarPath.of(slug);   // encoded: "a?b" is not "/a" + a query (A04)
                });
            });
        },

        // The desktop name box is as wide as the name, so its dashed underline ends where the name does
        // and the pencil sits right after it. Measured, because letters differ in width.
        fitSlugBox() {
            try {
                const el = document.getElementById('slug');
                if (!el) return;
                const ctx = this._slugCtx || (this._slugCtx = document.createElement('canvas').getContext('2d'));
                ctx.font = getComputedStyle(el).font;
                const w = ctx.measureText(el.value || el.placeholder || '').width;
                el.style.width = Math.ceil(Math.max(w, 60) + 4) + 'px';
            } catch (err) { /* layout nicety only */ }
        },
        /** Share's Print button: the browser's print dialog (which also saves a PDF), counted as 'share'. */
        printCalendar() {
            this.printFrom = 'share';
            try { window.print(); } catch (e) { this.printFrom = null; }
        },

        // Before printing: the dates on screen, the view link (never the edit link: a printout gets passed around)
        // and its QR code, if the small QR library has loaded (it loads once the page is idle; see mounted).
        preparePrint() {
            try {
                this.printMonth = this.buildPrintMonth();
                const view = this.isReadOnly ? (location.origin + location.pathname) : (this.shareViewURL() || this.getReadOnlyURL() || '');
                this.printLink = view ? view.replace(/^https?:\/\//, '').replace(/\?.*$/, '') : '';
                this.printDate = new Date().toLocaleDateString();
                this.printQr = '';
                // The QR opens the subscribe page (this phone's calendar app, one tap); the printed text is the view link.
                const scan = this.subscribePageURL() || view;
                if (scan && typeof qrcode === 'function') { const q = qrcode(0, 'M'); q.addData(scan.replace(/\?.*$/, '')); q.make(); this.printQr = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true }); }
            } catch (e) { /* print without the footer extras */ }
        },

        // The month being looked at, as weeks of days with their events (repeats expanded), for the printed page.
        // As many events as fit in a day on paper; the rest are "+N more".
        buildPrintMonth() {
            const cal = this.calView;
            if (!cal) return null;
            const sel = cal.selectedDate();
            const first = new Date(sel.getFullYear(), sel.getMonth(), 1);
            const fdow = Number(this.globalSettings.firstDayOfWeek) || 0;
            const start = new Date(first); start.setDate(1 - ((first.getDay() - fdow + 7) % 7));
            const last = new Date(sel.getFullYear(), sel.getMonth() + 1, 0);
            const weeks = Math.ceil(((last - start) / 864e5 + 1) / 7);
            const end = new Date(start); end.setDate(start.getDate() + weeks * 7);
            const loc = navigator.language || 'en-US';
            const en = /^en/i.test(loc);
            const time = (d) => { const t = d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' }); return en ? t.replace(':00', '').replace(/\s?([AP])M/i, (m, x) => x.toLowerCase() + 'm') : t; };
            // Repeats expanded, as the grid draws them (CalendarView.occurrences: the color filter applies).
            const evs = (cal.occurrences(start, end) || []).map((e) => ({ s: e.start, e: e.end, all: e.allDay, title: e.title || '(No title)', type: e.type }))
                .sort((a, b) => (b.all - a.all) || (a.s - b.s));
            const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
            const out = [];
            for (let w = 0; w < weeks; w++) {
                const row = [];
                for (let i = 0; i < 7; i++) {
                    const d = new Date(start); d.setDate(start.getDate() + w * 7 + i);
                    const t = d.getTime(), next = new Date(d); next.setDate(d.getDate() + 1);
                    const on = evs.filter((e) => e.all ? (day0(e.s) <= t && t < Math.max(day0(e.e), day0(e.s) + 1)) : (e.s < next && e.e > d && (day0(e.s) === t || e.e - e.s > 864e5 || day0(e.s) < t)));
                    // What fits in a day (mm): a one-line event is ~5.3, a wrapped one ~8.6 (about 24 characters a line);
                    // past that, the last ones become "+N more".
                    const room = (146 / weeks) - 5.5;
                    const tall = (e) => ((e.all ? 0 : 7) + e.title.length > 24 ? 8.6 : 5.3);
                    let used = 0, fit = 0;
                    for (const e of on) { const h = tall(e); const moreLine = fit + 1 < on.length ? 4 : 0; if (used + h + moreLine > room) break; used += h; fit++; }
                    const shown = on.slice(0, fit);
                    row.push({ key: t, num: d.getDate() === 1 ? d.toLocaleDateString(loc, { month: 'short', day: 'numeric' }) : d.getDate(), inMonth: d.getMonth() === sel.getMonth(),
                        events: shown.map((e) => { const color = this.getTypeColor(e.type); return { title: e.title, time: e.all || day0(e.s) !== t ? '' : time(e.s), color, on: ScheduleAdapter.onColor(color) }; }),
                        more: on.length - shown.length });
                }
                out.push(row);
            }
            const dows = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d.toLocaleDateString(loc, { weekday: 'short' }); });
            return { label: sel.toLocaleDateString(loc, { month: 'long', year: 'numeric' }), dows, weeks: out };
        },

        showDraftBlock(popup) {
            try {
                this.hideDraftBlock();
                const cells = [...document.querySelectorAll('#Schedule .e-work-cells.e-selected-cell, #Schedule .e-all-day-cells.e-selected-cell')];
                if (!cells.length) return;
                cells.forEach((c, i) => c.classList.add('pc-draft-cell', i === 0 ? 'pc-draft-head' : 'pc-draft-more', ...(i === cells.length - 1 ? ['pc-draft-tail'] : [])));
                const root = document.getElementById('Schedule');
                const input = popup && popup.querySelector('input.e-subject, .e-subject');
                const label = () => root.style.setProperty('--draft-label', JSON.stringify((input && input.value.trim()) || 'New event'));
                label();
                if (input) { input.addEventListener('input', label); this._draftOff = () => input.removeEventListener('input', label); }
            } catch (e) { /* a nicety: never in the way of adding the event */ }
        },
        hideDraftBlock() {
            document.querySelectorAll('#Schedule .pc-draft-cell').forEach((c) => c.classList.remove('pc-draft-cell', 'pc-draft-head', 'pc-draft-more', 'pc-draft-tail'));
            if (this._draftOff) { this._draftOff(); this._draftOff = null; }
        },

        // Clicking the name selects all of it, so typing replaces the random name instead of appending.
        // At once, not on a timer: a fast typist beat the timer and appended. A click focuses on mouse
        // down, and the mouse up would collapse the selection, so that one mouse up is cancelled.
        selectSlug(e) {
            const el = e && e.target;
            if (!el || !el.setSelectionRange) return;
            try { el.setSelectionRange(0, el.value.length); } catch (err) { /* */ }
            this._slugKeepSelection = true;
        },
        keepSlugSelection(e) {
            if (this._slugKeepSelection && e.type === 'mouseup') e.preventDefault();
            this._slugKeepSelection = false;   // one mouse up, or a blur, ends it
        },
        handleSlugInput() {
            this.userHasEditedSlug = true;
            this.slugTaken = null;
        },

        // Show "taken" and up to 3 alternatives that are actually free. The message is up
        // at once; the options fill in when the (parallel) existence checks come back.
        offerSlugAlternatives(slug) {
            this.slugTaken = { slug, options: [] };
            const candidates = SlugManager.suggestSlugs(slug);
            const free = new Array(candidates.length).fill(false);
            let pending = candidates.length;
            const settle = () => {
                if (--pending > 0) return;
                // Through this.slugTaken (Vue's reactive copy), and only if it is still the
                // same name: the user may have typed on or dismissed it meanwhile.
                if (!this.slugTaken || this.slugTaken.slug !== slug) return;
                this.slugTaken.options = candidates.filter((_, i) => free[i]).slice(0, 3);
                track(a => a.track('slug_suggestion_shown', { count: this.slugTaken.options.length }));
            };
            if (!pending) return;
            candidates.forEach((c, i) => {
                CalendarDataService.checkExists(c, settle, () => { free[i] = true; settle(); });
            });
        },

        pickSlugAlternative(slug) {
            track(a => a.track('slug_suggestion_used', {}));
            this.calendar.id = slug;
            this.userHasEditedSlug = true;
            this.slugTaken = null;
            this.create();
        },

        randomizeId() {
            this.calendar.id = Utils.randomID(10);
            // Reset edited state if they randomize (treat as "auto" again, or maybe not? 
            // Let's keep it as "not edited" so they get the review dialog if they just clicked shuffle
            // Actually, if they clicked shuffle, they interacted. 
            // But let's err on safe side: if they just shuffled but didn't TYPE, show dialog to confirm.
            this.userHasEditedSlug = false;
        },

        renameCalendar() {
            if (!this.newCalendarId || !this.newCalendarId.trim()) return;

            let newId = this.newCalendarId.trim();
            // basic validation (alphanumeric, hyphens)
            if (!newId.match(/^[a-zA-Z0-9_\-]+$/)) {
                alert("That name won’t work. Use letters, numbers, dashes and underscores.");
                return;
            }

            // Check if current name is same as new name
            if (newId.toLowerCase() === this.calendar.id.toLowerCase()) {
                alert("That’s already this calendar’s name.");
                return;
            }

            CalendarDataService.checkExists(newId, () => {
                alert("That name is already taken.");
            }, () => {
                // Does not exist, proceed
                if (confirm(`Move calendar to pastecal.com/${newId}?`)) {
                    // Create copy with new ID
                    let newCalendar = JSON.parse(JSON.stringify(this.calendar));
                    newCalendar.id = newId;
                    newCalendar.title = newCalendar.title || "New Calendar";

                    const oldId = this.calendar.id;
                    // Lets the server move the read-only view to the new id (see
                    // PublicViewService.followRename); without it the view stays bound to
                    // the old copy and its link and ICS feed stop updating.
                    newCalendar.options = { ...(newCalendar.options || {}), renamedFrom: oldId };

                    // A copy: this browser did not create the original.
                    CalendarDataService.createWithId(newId, newCalendar, () => {
                        // We don't delete the old one (safer, acts as a copy), but the
                        // recents entry has to move: leaving both would list a stale copy
                        // alongside the live calendar with no way to tell them apart.
                        const previous = this.recentManager.getAll()
                            .find(item => item.id === oldId);
                        this.recentManager.remove(oldId);
                        // Renaming your own calendar keeps it yours.
                        this.recentManager.add(newId, newCalendar.title, !!previous?.mine);
                        if (previous?.pinned) this.recentManager.togglePin(newId);
                        this.recentCalendars = this.recentManager.getAll();

                        window.location = CalendarPath.of(newId);
                    }, { asCreator: false });
                }
            });
        },

        setTitle(event) {
            if (event.target.value.trim()) {
                this.editTitle = false;
                this.calendar.title = event.target.value.trim();
            }
        },

        getTypes() {
            // First check if we have custom labels in calendar.options.typeLabels
            // An untouched label shows as "Type N" (typeLabelFor).
            return Array(this.COLORS.length).fill().map((_, i) => {
                let id = i + 1;
                // Syncfusion renders item text as HTML, and labels are set by anyone with the edit link.
                return { text: escapeHtml(this.typeLabelFor(i)), value: id, iconCss: `e-color-${id}` };
            });
        },

        // Apply a snapshot from the server without the calendar watcher mistaking it for a
        // local edit and writing it back. The flag is cleared after the watcher queue has
        // drained -- a deep watcher fires asynchronously, so clearing it synchronously
        // would let the echo through anyway.
        // `replace` skips the merge: used when local is known to be wrong (a refused
        // write's recovery), where merging would keep exactly the damage being undone.
        applyRemoteCalendar(c, { replace = false } = {}) {
            this.isApplyingRemote = true;
            try {
                // import() is a bare Object.assign, so it replaces events wholesale. A
                // local edit made inside the 500ms debounce window has not reached the
                // server yet, and would simply be overwritten by the snapshot -- the user
                // watches their change undo itself. Merge the incoming events over the
                // local ones the same way the write path does, so unsent work survives
                // until its sync lands.
                // Normalized: Firebase hands back a holey array as an object keyed by index.
                const incoming = CalendarDataService._eventList(c?.events);
                // `_writer` is the server's note of who wrote last, not calendar data;
                // carried into local state it would be sent back as this browser's.
                c = { ...CalendarDataService._withoutMeta(c), events: incoming };
                // The baseline from BEFORE this snapshot. _lastSeen has already been
                // advanced to the incoming data by the time we get here, and diffing
                // against that would mark every local row as an edit and reinstate our
                // stale copies over the change that just arrived.
                const base = CalendarDataService._previousSeen[this.calendar.id];
                if (!replace && base && this.calendar.events && this.calendar.events.length) {
                    c = { ...c, events: CalendarDataService._mergeEvents(
                        base, this.calendar.events, incoming) };
                }
                this.calendar.import(c);
            } finally {
                // Record what the calendar looks like immediately after the import. The
                // watcher compares against this rather than simply trusting the flag: a
                // local edit landing in the same batch as a remote snapshot would
                // otherwise be skipped along with it and never reach the server -- a new
                // data-loss bug in the fix for the old one.
                this.remoteAppliedSignature = JSON.stringify(this.calendar.events || []);
                this.$nextTick(() => { this.isApplyingRemote = false; });
            }
        },

        // Human name for one color slot, for the filter dots' labels. The dots are
        // otherwise distinguishable only by hue, which fails for colorblind users and for
        // the near-identical colors a custom palette can contain.
        //
        // Most calendars never rename their types, and the stored default labels are
        // literally "Type 1".."Type 8" -- a slot index with no referent, which read aloud
        // sounds like information while conveying none. Fall back to the dot's own color
        // instead, which is at least something the user can see on screen.
        // A color the calendar has named ("Practice"), not just "Type N".
        hasTypeLabel(index) {
            const label = this.calendar?.options?.typeLabels?.[index];
            return !!label && !/^Type \d+$/.test(label);
        },
        typeLabelFor(index) {
            const custom = this.calendar?.options?.typeLabels;
            const label = custom && custom[index];
            if (label && !/^Type \d+$/.test(label)) return label;
            return `Type ${index + 1}`;   // not the color's name: "Sky" told people nothing
        },

        // The Week/Day corner toggle for the hours before the start hour (see renderCell).
        earlyHoursLabel() {
            const start = this.globalSettings.startHour || '05:00';
            const hour = parseInt(start, 10) || 0;
            if (!hour) return { text: '', title: '' };   // nothing is hidden
            const at = this.globalSettings.timeFormat === '24'
                ? start : `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
            return this.calendar?.options?.extended
                ? { text: 'Hide early', title: `Hide the hours before ${at}` }
                : { text: 'Earlier', title: `Show the hours before ${at}` };
        },


        updateCurrentViewURL() {
            if (!this.calView) return;
            const currentView = this.calView.currentView();
            const currentDate = Utils.localDay(this.calView.selectedDate());   // the day on screen, not its UTC date (A06)

            // Map display name to URL parameter
            let viewParam;
            const viewLower = currentView.toLowerCase();

            // Check if it's a custom view (has a number and unit)
            const customViewMatch = currentView.match(/^(\d+)\s+(Week|Month)s?$/);
            if (customViewMatch) {
                const duration = customViewMatch[1];
                const unit = customViewMatch[2].toLowerCase() + 's';
                viewParam = `custom&dur=${duration}&unit=${unit}`;
            } else {
                // Standard view - just lowercase it
                viewParam = viewLower;
            }

            // The owner of a calendar with an @link or short link: "This view" starts from that view-only link too.
            const named = !this.isReadOnly && this.shareNames ? this.shareViewURL() : null;
            const baseURL = named || SlugManager.getViewerBaseURL(this.calendar, this.isReadOnly);
            // baseURL is null only if read-only mode somehow lacks a slug (server race + no
            // /view/<slug> in the URL). Fall back to the current href so we never leak the edit id.
            this.currentViewURL = baseURL
                ? `${baseURL}?date=${currentDate}&view=${viewParam}`
                : window.location.href;
        },

        // ============================================================
        // REGION: URL Generation & Sharing
        // ============================================================

        // Owner-only — returns null in read-only mode so a forgotten v-if can't leak the edit id.
        getEditableURL() {
            if (this.isReadOnly) return null;
            return window.location.origin + CalendarPath.of(this.calendar.id);
        },

        getEditableICSURL() {
            if (this.isReadOnly) return null;
            return window.location.origin + CalendarPath.feed(CalendarPath.of(this.calendar.id));
        },

        getReadOnlyICSURL() {
            // Use SlugManager for centralized read-only link operations
            return SlugManager.getReadOnlyICSURL(this.calendar);
        },

        /**
         * The feed to hand out for subscribing. Prefers the read-only link: someone
         * adding a roster to their phone wants to read it, and defaulting to the
         * editable feed would spread write access further than anyone intended.
         */
        getSubscribeICSURL() {
            // No fallback to the editable feed: these URLs go to Google, Microsoft and the OS,
            // so without a read-only link the subscribe buttons hide (their v-if) instead.
            const own = this.getReadOnlyICSURL();
            if (own) return own;
            // A view link's calendar never carries its publicViewId (the server strips it): the
            // feed is the address being viewed, plus .ics.
            if (!this.viewRoute) return null;
            const parts = stripBase(window.location.pathname).split('/').filter(Boolean);
            const name = (p) => { try { return decodeURIComponent(p); } catch (e) { return p; } };
            if (atViewSlug() && parts.length === 2) return window.location.origin + CalendarPath.feed(CalendarPath.at(name(parts[0]).replace(/^@/, ''), name(parts[1])));
            return parts[0] === 'view' && parts[1] ? window.location.origin + CalendarPath.feed(CalendarPath.view(name(parts[1]))) : null;
        },

        /**
         * webcal:// is the scheme operating systems hand to the default calendar
         * app, which is what turns "subscribe" into one tap instead of copy, find
         * your calendar app, locate add-by-URL, paste.
         *
         * It can fail silently -- if nothing is registered for the scheme, the
         * click does nothing at all -- which is why the named app buttons and the
         * plain feed URL stay visible next to it.
         */
        /** The add-to-calendar page for the read-only feed (/view/<id>/add): Add to my calendar, Share, the printed QR. */
        subscribePageURL() {
            const feed = this.getSubscribeICSURL();
            return feed ? feed.replace(/\.ics$/i, '/add') : null;
        },

        getWebcalURL() {
            const url = this.getSubscribeICSURL();
            if (!url) return null;
            return url.replace(/^https?:\/\//, 'webcal://');
        },

        getGoogleSubscribeURL() {
            const webcal = this.getWebcalURL();
            if (!webcal) return null;
            return 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal);
        },

        getOutlookSubscribeURL() {
            // Outlook's add-from-web takes the https URL, not the webcal one.
            const url = this.getSubscribeICSURL();
            if (!url) return null;
            return 'https://outlook.live.com/calendar/0/addfromweb?url='
                + encodeURIComponent(url)
                + '&name=' + encodeURIComponent(this.calendar.title || 'pastecal');
        },

        /** Records which subscribe path was used, so the rate is measurable. */
        // A paused calendar opens in the view-only layout, which has no Share button. Its owner still needs
        // the "Plus ended" choices (Open to everyone / Keep Plus), so ask the server whether this is the owner.
        async checkPausedOwner() {
            if (!this.lock.paused || !this.calendar || !this.calendar.id) { this.pausedOwner = false; return; }
            try {
                const r = await fetch('/api/pro/status?calendar=' + encodeURIComponent(this.calendar.id), { credentials: 'same-origin' });
                const st = r.ok ? await r.json() : null;
                this.pausedOwner = !!(st && st.lapsedOwner);
                if (this.pausedOwner) { this.proPlan = st.plan || null; this.pausedTrial = !!st.lapsedTrial; }   // which plan ended: 'Trial ended' / 'Plus ended'
            } catch (e) { this.pausedOwner = false; }
        },

        trackSubscribe(method) {
            track(a => a.calendarShared(method));
        },

        createReadOnlyLink() {
            // Use SlugManager for centralized read-only link operations
            return SlugManager.createReadOnlyLink(this.calendar);
        },

        /** Share's "Create read-only link", for a calendar saved before view links were made on save. Saves it too. */
        async makeReadOnlyLink() {
            if (this.creatingReadOnly) return;
            this.creatingReadOnly = true;
            try { await SlugManager.createReadOnlyLink(this.calendar, { autoCreate: true }); }
            catch (e) { this.showToast('Couldn’t create the link. Try again in a moment.', 'error'); }
            finally { this.creatingReadOnly = false; }
        },

        customizeExistingLink() {
            if (!this.readOnlySlugInput.trim()) return;

            // Use SlugManager for centralized read-only link operations
            SlugManager.customizeReadOnlyLink(this.calendar, this.readOnlySlugInput.trim())
                .then(() => {
                    // Clear the input and hide the form
                    this.readOnlySlugInput = '';
                    this.showReadOnlySlug = false;
                });
        },

        getReadOnlySlug() {
            // Use SlugManager for centralized read-only link operations
            return SlugManager.getReadOnlySlug(this.calendar) || '';
        },

        /** A link as Share shows it: pastecal.com and the path, whatever host this page is on. The full URL is what's copied. */
        shortLink(url) {
            return String(url || '').replace(/^[a-z]+:\/\/(www\.)?[^/]+/i, 'pastecal.com');
        },

        /** Share's "Embed on a website": the read-only calendar in an iframe (view pages allow framing). */
        embedCode() {
            const title = String(this.displayCalendarTitle || 'Calendar').replace(/[<>"&]/g, '');
            return `<iframe src="${this.getReadOnlyURL()}" title="${title}" width="100%" height="640" style="border:0" loading="lazy"></iframe>`;
        },

        getReadOnlyURL() {
            // Use SlugManager for centralized read-only link operations
            return SlugManager.getReadOnlyURL(this.calendar);
        },

        /** /api/pro/status (here, or from the Pro panel after a change): the owner's @link and short links for
         *  this calendar. Only its owner gets them, and only they are shown them. */
        onProNames(st) {
            if (!st || !st.isOwner || !this.calendar) { this.shareNames = null; return; }
            const shortNames = Array.isArray(st.shortNames) ? st.shortNames.filter((n) => typeof n === 'string') : [];
            this.shareNames = (st.handle && st.atName) || shortNames.length ? { handle: st.handle || '', atName: st.atName || '', shortNames } : null;
        },
        /** The editor link the Pro panel last made in this browser (same key as Pro.js storedLink and /pro/done). */
        storedEditorLink() {
            try { return (this.calendar && localStorage.getItem('pastecal_editor_link:' + String(this.calendar.id).toLowerCase())) || ''; } catch (e) { return ''; }
        },
        /** "Share to edit" with no editor link here yet: the Pro panel's Editor link section makes one (never resets one). */
        /** Share to edit, no editor link made in this browser yet: they're made in the Plus tab, under Who can edit. */
        goEditorLink() {
            this.openPlusTab('share');
            setTimeout(() => { const el = document.getElementById('pc-pro-editor'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 300);
        },
        /** "Share to view": one link, the best this calendar has: its @link, else a short link, else its view link.
         *  All three open the view-only calendar. */
        shareViewURL() {
            const n = this.shareNames, origin = window.location.origin;
            if (n && n.handle && n.atName) return origin + CalendarPath.at(n.handle, n.atName);
            if (n && n.shortNames.length) return origin + CalendarPath.of(n.shortNames[0]);
            return this.getReadOnlyURL();
        },
        /** Share's "Other links": the calendar's other view-only addresses, listed compactly under the main one. */
        otherViewLinks() {
            const n = this.shareNames, origin = window.location.origin, main = this.shareViewURL();
            const all = [];
            if (n && n.handle && n.atName) all.push(origin + CalendarPath.at(n.handle, n.atName));
            if (n) for (const s of n.shortNames) all.push(origin + CalendarPath.of(s));
            const view = this.getReadOnlyURL();
            if (view) all.push(view);
            return all.filter((u) => u !== main);
        },

        getReadOnlyNotes() {
            // Escaped, then only http(s)/www/email become links (Utils.linkify), then line breaks.
            return Utils.linkify(this.calendar.options?.notes || '', { style: false }).replace(/\n/g, "<br>");
        },

        startUpdateLinkTimer() {
            this.updateLinkTimer = setInterval(() => {
                this.updateCurrentViewURL();
            }, 100);
        },

        stopUpdateLinkTimer() {
            clearInterval(this.updateLinkTimer);
        },

        copyToClipboard(target) {
            target.select();
            document.execCommand('copy');
        },

        // ============================================================
        // REGION: Events & Search Management
        // ============================================================

        searchEvents() {
            if (this.searchQuery.trim() !== '') {
                // A title or its details (classic and native alike), ignoring case.
                const q = this.searchQuery.toLowerCase();
                this.searchResults = this.calendar.events.filter(event =>
                    String(event.title || '').toLowerCase().includes(q) || String(event.description || '').toLowerCase().includes(q)
                );

                // sort results by newest first
                this.searchResults.sort((a, b) => new Date(b.start) - new Date(a.start));
            } else {
                this.searchResults = [];
            }
        },

        toggleColorFilter(index) {
            this.colorFilters[index] = !this.colorFilters[index];
        },

        // A search-panel chip: show only this type (and list its events). Tapping the one shown again
        // shows everything. Seeing all of one color took a tap on every other chip before.
        soloColorFilter(index) {
            // Only types some event uses: switching off an unused one hides nothing and only adds clutter.
            const used = new Set(this.filterChips.filter(c => c.count > 0).map(c => c.idx));
            const onlyThis = this.colorFilters[index] !== false
                && [...used].every(i => i === index || this.colorFilters[i] === false);
            this.colorFilters = this.COLORS.map((_, i) => onlyThis || i === index || !used.has(i));
        },

        resetColorFilters() {
            this.colorFilters = this.COLORS.map(() => true);
        },

        // Keep one filter flag per color, preserving existing choices. Called whenever
        // COLORS is replaced, so the filter array can never be a different length than
        // the palette it describes.
        syncColorFiltersLength() {
            const want = this.COLORS.length;
            if (this.colorFilters.length === want) return;
            const next = [];
            for (let i = 0; i < want; i++) {
                next.push(this.colorFilters[i] !== false); // default new slots to shown
            }
            this.colorFilters = next;
        },

        // The date window the grid is currently showing, or null if it can't be read.
        // Syncfusion exposes it as getCurrentViewDates(); falling back to null means the
        // count degrades to "all events" rather than throwing.
        visibleDateRange() {
            return this.calView ? this.calView.visibleRange() : null;
        },

        // Does this series actually put an occurrence inside the window? The stored start
        // only says when the series began, so the rule has to be expanded: COUNT/UNTIL end
        // it, and BYDAY/INTERVAL/EXDATE decide which days it lands on. Syncfusion's own
        // expansion is the authority, since it is what draws the grid; if it is unavailable
        // we fall back to a COUNT/UNTIL estimate, which over-reports rather than hiding
        // something. A method, not a computed: Vue 3 calls a computed getter with no
        // arguments, so as a computed this was a boolean and calling it threw.
        recurrenceOccursInRange(event, range) {
            // The live scheduler cannot answer this: hidden events are filtered out of its
            // dataSource, so it would report "no occurrences" for precisely the events
            // being counted. The rule is expanded in isolation (CalendarView.occursInRange),
            // from the values the grid is given: an all-day series' start, UNTIL and EXDATEs
            // at the viewer's local midnight of their stored dates.
            const allDay = !!event.isAllDay;
            const ms = (v) => {
                const d = allDay ? Event.allDayToLocal(v) : new Date(v);
                return d ? d.getTime() : NaN;
            };
            const start = ms(event.start);
            if (isNaN(start)) return true;
            // A rule too big to expand is shown once (ScheduleAdapter.toView): count it the same way.
            if (typeof EventStore !== 'undefined' && EventStore.unsafeRecurrence?.(event.recurrencerule)) {
                const end = ms(event.end);
                return this.spansRange(start, start + (isNaN(end) ? 0 : Math.max(0, end - start)), range);
            }
            const rule = String((allDay ? Event.allDayRuleToLocal(event.recurrencerule) : event.recurrencerule) || '');

            // The calendar's own expansion (Syncfusion's ej.schedule.generate, or the native grid's rrule), the
            // same one that draws the grid; null when it cannot answer, and then the estimate below.
            const known = this.calView ? this.calView.occursInRange(event, range) : null;
            if (known === true || known === false) return known;

            try {
                const until = /UNTIL=([0-9TZ]+)/.exec(rule);
                if (until) {
                    const u = typeof ej !== 'undefined' ? ej.schedule.getDateFromRecurrenceDateString(until[1]) : null;
                    if (u && !isNaN(u.getTime()) && u.getTime() < range.start) return false;
                }
                const count = /COUNT=(\d+)/.exec(rule);
                if (count) {
                    // Walk the rule's own interval forward COUNT times and see whether the
                    // last occurrence lands before the window opens. BYDAY can push it
                    // later, so this is only a lower bound -- the reason it is a fallback.
                    const n = parseInt(count[1], 10);
                    const every = parseInt((/INTERVAL=(\d+)/.exec(rule) || [, '1'])[1], 10) || 1;
                    const freq = (/FREQ=(\w+)/.exec(rule) || [, ''])[1];
                    const stepMs = { DAILY: 864e5, WEEKLY: 6048e5 }[freq];
                    if (stepMs && n > 0) {
                        const lastStart = start + stepMs * every * (n - 1);
                        if (lastStart < range.start) return false;
                    } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
                        const last = new Date(start);
                        const add = every * (n - 1);
                        if (freq === 'MONTHLY') last.setMonth(last.getMonth() + add);
                        else last.setFullYear(last.getFullYear() + add);
                        if (last.getTime() < range.start) return false;
                    }
                }
            } catch (err) {
                // Fall through: over-reporting is safer than silently not counting.
            }

            return start < range.end;
        },

        // Does [start, end) overlap the window? Ends are exclusive, so an all-day Saturday
        // ending at Sunday 00:00 is not in the week that starts that Sunday. A zero-length
        // event has no extent to overlap with, so it counts where it starts.
        spansRange(start, end, range) {
            if (isNaN(end) || end <= start) return start >= range.start && start < range.end;
            return start < range.end && end > range.start;
        },


        // The only definition of "visible". updateCalendarView() filters the grid with
        // this, and hiddenEventCount counts with it, so the two cannot disagree.
        isEventVisible(event) {
            return this.colorFilters[this.filterSlotFor(event)] === true;
        },

        // Which color dot governs this event. Both paint paths (eventRendered and
        // getTypeColor) fall back to COLORS[0] for a type with no slot, so such an event
        // reads on screen as type 1 and follows the type 1 dot. Normalized with `|| 1`,
        // matching Calendar.getSyncFusionEvents() and Event.js, so a type of 0 or ""
        // lands in the same slot here as it does on the grid.
        filterSlotFor(event) {
            const type = parseInt(event.type || event.Type || 1);
            if (!Number.isFinite(type) || type < 1 || type > this.COLORS.length) return 0;
            return type - 1;
        },


        // Edit from a search result: the same editor a double-click opens (a repeating event opens its series).
        editSearchResult(event) {
            if (this.calView) this.calView.openEditor(event);
        },

        jumpToEvent(event) {
            if (this.calView) this.calView.goTo({ date: new Date(event.start), view: 'Week' });
        },

        toggleRecents() {
            // On desktop, pointing at the logo already opened the menu: the click that follows
            // must keep it open, not close it again.
            if (this.showRecents && Date.now() - (this.recentsHoverOpenedAt || 0) < 1500) { this.recentsHoverOpenedAt = 0; return; }
            this.showRecents = !this.showRecents;
        },

        closeRecents() {
            this.showRecents = false;
        },

        handleDropdownMouseEnter() {
            // Only handle hover on non-touch devices
            if (!('ontouchstart' in window)) {
                clearTimeout(this.hoverTimeout);
                if (!this.showRecents) this.recentsHoverOpenedAt = Date.now();
                this.showRecents = true;
            }
        },

        handleDropdownMouseLeave() {
            // Only handle hover on non-touch devices
            if (!('ontouchstart' in window)) {
                this.hoverTimeout = setTimeout(() => {
                    this.showRecents = false;
                }, 300);
            }
        },

        goToHomepage() {
            this.closeRecents();
            window.location.href = '/';
        },

        // The logo menu's "Start over" on the homepage draft: back to a fresh blank draft -- every
        // event (the visitor's own too), the title, notes, color names and colors. The events go as
        // ONE store change, and that undo entry also carries everything else, so one Cmd+Z (or the
        // toast's Undo) brings the whole draft back (undoLastLocal). The URL name stays the visitor's.
        startOver() {
            this.closeRecents();
            // Only the homepage draft clears in place; anywhere else, starting over means the homepage.
            if (!this.isHomepageCalendar) { this.goToHomepage(); return; }
            const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
            const before = {
                title: this.calendar.title,
                options: clone(this.calendar.options || {}),
                colors: [...this.COLORS],
                localColors: [...(this.localSettings.colors || this.COLORS)],
                labels: [...(this.localSettings.typeLabels || [])],
                template: clone(this.template),
                templateNudge: this.templateNudge,
                userAddedEvent: this.userAddedEvent,
            };
            const commands = (this.calendar.events || []).map(e => ({ type: 'remove', key: EventStore.keyOf(e) }));
            this.calendar.sampleEvents().forEach(e => commands.push({ type: 'add', event: e }));
            const label = 'Started over';
            const r = this.store().dispatch({ type: 'batch', commands, label }, { label });
            if (!r.ok) return;
            const stack = this.store().undoStack;
            (this._templateUndo = this._templateUndo || []).push({ entry: stack[stack.length - 1], restore: () => this.restoreDraftMeta(before) });
            this.restoreDraftMeta({
                title: Calendar.DEFAULT_TITLE,
                options: { notes: '', defaultView: before.options.defaultView || 'month' },
                colors: [...this.DEFAULT_COLORS],
                localColors: [...this.DEFAULT_COLORS],
                labels: this.DEFAULT_COLORS.map((_, i) => `Type ${i + 1}`),
                template: null,
                templateNudge: false,
                userAddedEvent: false,
            });
            clearTimeout(this._templateUndoTimer);
            this.templateUndo = false;
            track(a => a.featureUsed('start_over'));
            this.offerUndo('Started over with a blank calendar');
            try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
        },

        // Put a draft's title, options, palette, color names and template back as given (startOver and its undo).
        restoreDraftMeta(m) {
            this.calendar.title = m.title;
            this.calendar.options = JSON.parse(JSON.stringify(m.options || {}));
            this.COLORS = [...m.colors];
            this.localSettings.colors = [...m.localColors];
            this.localSettings.typeLabels = [...m.labels];
            this.syncColorFiltersLength();
            this.storeColorsInCalendarOptions();
            this.storeTypeLabelsInCalendarOptions();
            this.updateColorCSS();
            this.template = m.template;
            this.templateNudge = !!m.templateNudge;
            this.userAddedEvent = !!m.userAddedEvent;
            try {
                if (m.template) localStorage.setItem('pastecal_template', JSON.stringify(m.template));
                else localStorage.removeItem('pastecal_template');
            } catch (e) { /* this visit only */ }
        },

        // ============================================================
        // REGION: UI State Management (Panels & Toggles)
        // ============================================================

        isPanelOpen() {
            return !!this.sideTab;
        },

        /** A person's click that may open a side panel tab: where it came from (header, menu, tabs, share, paused,
         *  logo_menu). The sideTab watcher counts the open once (panel_opened); opens nobody clicked (a pinned panel, a
         *  restored tab) are never counted. Cleared after the click either way. */
        viaPanel(via) {
            this._panelVia = via;
            setTimeout(() => { this._panelVia = null; }, 0);
        },
        /** A tab in the side panel's row. Picking the open tab leaves it open. */
        openSideTab(id) {
            if (this.sideTab === id) return;
            if (id === 'notes') this.toggleNotes();
            else if (id === 'share') this.toggleShare();
            else if (id === 'settings') this.toggleSettings();
            else if (id === 'changes') this.openRecentChanges();
            else if (id === 'stats') this.openStats();
            else if (id === 'plus') this.openPlusTab('share');
            else if (id === 'history') this.openInsight(id, 'side_panel');
        },
        /** Stats: the Pro numbers for the owner; for everyone else, what Stats holds and how to get it. */
        openStats() {
            if (this.canSeeProStats) { this.openInsight('stats', 'side_panel'); return; }
            this.closeAllPanels();
            this.showStatsInfo = true;
            // A free calendar: its views and followers, then what Pro adds. Counted where it now lives.
            if (this.isExisting && !this.lock.locked) {
                track(a => a.proStatsTeaserShown());
                this.loadFreeStats();
            }
        },
        /** The free counts (/api/stats): anyone with an unlocked calendar's edit link. Counts only, never who. */
        async loadFreeStats() {
            const id = this.calendar && this.calendar.id;
            if (!id) return;
            const keep = this.freeStats && this.freeStats.id === id && !this.freeStats.error ? this.freeStats : null;
            this.freeStats = { id, views: 0, viewsPrev: 0, followers: 0, ...keep, loading: !keep, error: false };
            let data = null, offline = false, unavailable = false;
            try {
                const res = await fetch(`/api/stats?calendar=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
                data = res.ok ? await res.json().catch(() => null) : null;
                // 503 stats-unavailable: this calendar isn't being counted yet. Never shown as zeros.
                if (res.status === 503) unavailable = ((await res.json().catch(() => null)) || {}).error === 'stats-unavailable';
            } catch (e) { offline = true; }
            if (!this.freeStats || this.freeStats.id !== id) return;      // another calendar opened meanwhile
            // No numbers to show (not stored here, or locked meanwhile): just the Pro list, no error.
            this.freeStats = data
                ? { id, loading: false, error: false, views: Number(data.views) || 0, viewsPrev: Number(data.viewsPrev) || 0, followers: Number(data.followers) || 0 }
                : unavailable ? { id, loading: false, error: false, unavailable: true }
                : keep ? { ...keep, loading: false } : { id, loading: false, error: offline, none: !offline };
        },
        /** Notes' Edit and Add notes. The textarea is bound as before, so typing saves the same way. */
        editNotes() {
            this.notesEditing = true;
            this.$nextTick(() => { const el = this.$refs.notesInput; if (el) el.focus(); });
        },
        /** From the Stats tab: the Plus tab. */
        getProFromStats() {
            track(a => a.proStatsTeaserClicked());
            this.openPlusTab('stats');
        },

        /** The panel's close button, its backdrop on small screens, and Escape. */
        closeSidePanel() {
            // A viewer who hides the pinned notes means it for this calendar, in this browser.
            if (this.showNotes && this.isReadOnly) {
                try { localStorage.setItem('pc_notes_hidden:' + String(this.calendar.id).toLowerCase(), '1'); } catch (e) { /* this visit only */ }
            }
            this.closeAllPanels();
        },
        notesHiddenHere() {
            try { return !!localStorage.getItem('pc_notes_hidden:' + String(this.calendar.id).toLowerCase()); } catch (e) { return false; }
        },

        // First-run welcome. Deliberately narrow: it's for someone who has never
        // been here, landing on the homepage. Anyone who arrived at a shared link
        // came to read a calendar, not to be pitched the product.
        shouldShowWelcome() {
            try {
                if (localStorage.getItem('pastecal_welcome_seen')) return false;
            } catch (e) {
                // Private browsing with storage blocked: skip rather than nag on
                // every page load, since we'd have no way to remember a dismissal.
                return false;
            }

            // Checked from mounted(), before the load callback resolves
            // isExisting -- so test urlslug directly rather than going through
            // isHomepageCalendar, which isn't trustworthy this early.
            if (this.urlslug) return false;
            if (this.isReadOnly) return false;

            // Been here before, in any capacity: they don't need the pitch.
            if (this.recentManager && this.recentManager.getAll().length > 0) return false;

            return true;
        },

        maybeShowWelcome() {
            this.showWelcome = this.shouldShowWelcome();
        },

        dismissWelcome() {
            this.showWelcome = false;
            try {
                localStorage.setItem('pastecal_welcome_seen', '1');
            } catch (e) {
                console.warn('[welcome] unable to persist dismissal', e);
            }
        },


        welcomeShowHelp() {
            this.dismissWelcome();
            this.toggleHelp();
        },

        toggleHelp() {
            // If help is already open, close it
            if (this.showHelp) {
                this.showHelp = false;
            } else {
                // Close all other panels first
                this.closeAllPanels();
                // Then open help
                this.showHelp = true;
            }
        },

        toggleNotes() {
            if (this.showNotes) {
                // Count notes as USED only when the panel closes with content in
                // it. Firing on open would count anyone who clicked the icon once
                // and immediately left, which is the opposite of what the question
                // ("does anyone actually keep notes?") is asking.
                if ((this.calendar?.options?.notes || '').trim()) {
                    track(a => a.featureUsed('notes'));
                }
                this.showNotes = false;
                this.notesEditing = false;
            } else {
                this.closeAllPanels();
                this.showNotes = true;
            }
        },

        // Closing the panel no longer clears the color filter. It used to, because the
        // filter was otherwise invisible once the dots were off screen -- the reset was the
        // only thing standing between a user and #41. The banner above the calendar now
        // reports a filter wherever the user is, so the filter can behave like a filter and
        // survive until it is switched off. It still lives only in memory: never persisted,
        // never shared, so a reload clears it and one person's filter never changes what
        // anyone else sees on a link-shared calendar.
        toggleSearch() {
            if (this.showSearch) {
                this.showSearch = false;
            } else {
                this.closeAllPanels();
                this.showSearch = true;
            }
        },

        /**
         * Copy this calendar's link straight from the header pill.
         *
         * Defaults to the READ-ONLY url: someone sharing casually is far more likely
         * to want "look at this" than "you can edit this," and handing out edit rights
         * by accident is the one mistake here that cannot be taken back. Falls back to
         * the editable url only when no read-only link exists yet, which is rarer than
         * it looks (all of the busiest calendars have one) but must not copy null.
         *
         * Tagged `pill` rather than `copy` so it stays distinguishable from the share
         * panel's own copy buttons -- the whole point is to learn whether this path
         * gets used, and lumping them together would hide the answer.
         */
        // The header pill copies the page's own link, the edit link (it is the address you are on); the
        // view-only link is one click away in Share. The toast says what was copied, since it grants editing.
        copyShareLink() {
            const url = this.getEditableURL();
            if (!url) return;

            const settle = () => {
                this.showToast('Copied the edit link: anyone with it can change this calendar. For a view-only link, open Share.', 'info');
                this.shareCopied = true;
                clearTimeout(this.shareCopiedTimer);
                this.shareCopiedTimer = setTimeout(() => { this.shareCopied = false; }, 1600);
            };

            track(a => a.calendarShared('pill'));

            // clipboard API is https-only and absent in some in-app browsers; the
            // execCommand path is the fallback, and a failure must still tell the
            // user something rather than silently doing nothing.
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(settle).catch(() => {
                    if (!this.legacyCopy(url)) this.showToast('Couldn’t copy the link', 'error');
                    else settle();
                });
            } else if (this.legacyCopy(url)) {
                settle();
            } else {
                this.showToast('Couldn’t copy the link', 'error');
            }
        },

        /** execCommand fallback for browsers without the async clipboard API. */
        legacyCopy(text) {
            try {
                const el = document.createElement('textarea');
                el.value = text;
                // Keep it off-screen but focusable; display:none would make select() a no-op.
                el.setAttribute('readonly', '');
                el.style.cssText = 'position:absolute;left:-9999px;top:0';
                document.body.appendChild(el);
                el.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(el);
                return ok;
            } catch (err) {
                return false;
            }
        },

        toggleShare() {
            if (this.showShare) {
                this.showShare = false;
            } else {
                this.closeAllPanels();
                this.showShare = true;
            }
        },

        closeAllPanels() {
            if (this.showHelp) {
                this.toggleHelp();
            }

            if (this.showNotes) {
                this.toggleNotes();
            }

            if (this.showSearch) {
                this.toggleSearch();
            }

            if (this.showShare) {
                this.toggleShare();
            }

            if (this.showSettings) {
                this.toggleSettings();
            }

            // Activity, Stats and History share the panel, so opening anything closes them too.
            this.showRecentChanges = false;
            this.showProStats = false;
            this.showProHistory = false;
            this.showStatsInfo = false;
            this.showPlus = false;
        },

        togglePin(id) {
            this.recentManager.togglePin(id);
            this.recentCalendars = this.recentManager.getAll();
        },

        removeRecent(id) {
            this.recentManager.remove(id);
            this.recentCalendars = this.recentManager.getAll();
        },

        formatDate(dateString) {
            const options = {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                hour12: true
            };
            return new Date(dateString).toLocaleString(undefined, options);
        },

        // A search result's "when". An all-day event shows its dates only: its stored start is a
        // midnight, so formatDate printed "12:00 AM", and its end is the day AFTER the last one.
        formatEventRange(event) {
            if (!event.isAllDay) return `${this.formatDate(event.start)} - ${this.formatDate(event.end)}`;
            const day = { weekday: 'short', month: 'short', day: 'numeric' };
            const start = Event.allDayToLocal(event.start);
            if (!start) return '';
            const end = Event.allDayToLocal(event.end);
            const last = end && end > start ? new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1) : start;
            const first = start.toLocaleDateString(undefined, day);
            return last.toDateString() === start.toDateString() ? first : `${first} - ${last.toLocaleDateString(undefined, day)}`;
        },

        // Resolves globalSettings.dateFormat to a Syncfusion-compatible date pattern.
        // 'auto' inspects navigator.language: US locales use M/d/yy; ISO regions (Sweden,
        // Hungary, Korea, etc.) use yyyy-MM-dd; everywhere else uses dd/MM/yyyy.
        resolveDateFormat() {
            const patterns = {
                us: 'M/d/yy',
                iso: 'yyyy-MM-dd',
                eu: 'dd/MM/yyyy',
            };
            const choice = this.globalSettings.dateFormat || 'auto';
            if (choice !== 'auto') return patterns[choice] || patterns.us;

            const locale = (navigator.language || 'en-US').toLowerCase();
            if (locale.startsWith('en-us')) return patterns.us;
            // ISO-style: Sweden, Hungary, Korea, Lithuania, Estonia, Latvia, Mongolia, Japan (de facto)
            if (/^(sv|hu|ko|lt|et|lv|mn|ja)/.test(locale)) return patterns.iso;
            return patterns.eu;
        },

        handleQuickAddEvent(event) {
            this.noteHomepageEvent();
            // Quick-add can produce a start with no end ("standup tomorrow 9am" parses a
            // time but no duration), and the dialog's own validation only requires a start.
            // An event with a null end is dropped at the write boundary by
            // CalendarDataService._dropIncompleteEvents, so it would sit on the grid until
            // the next reload and then be gone for good -- exactly the "my event vanished"
            // report this app keeps getting. Give it the same one-hour default the rest of
            // the app uses instead of letting it reach that boundary incomplete.
            const start = event.startDateTime;
            let end = event.endDateTime;
            if (start && !end) {
                const startMs = new Date(start).getTime();
                if (!isNaN(startMs)) end = new Date(startMs + 3600000).toISOString();
            }

            const r = this.store().dispatch({ type: 'add', event: { title: event.subject, start, end, type: event.type || 1, isAllDay: !!event.isAllDay } },
                { label: `Added "${(event.subject || '').trim()}"` });
            if (!r.ok) return;
            // Quick-add bypasses the scheduler, so it needs its own signal.
            if (this.isExisting && typeof AuthorSignal !== 'undefined') {
                AuthorSignal.touch(this.calendar.id);
            }
            track(a => a.eventAdded('quick_add', this.calendar));
        },

        shareUrl(url, title) {
            if (navigator.share) {
                track(a => a.calendarShared('native'));
                // The message is the calendar's name and its link, nothing else: it reads like a person sent it.
                navigator.share({ title: title || 'Calendar', text: title || '', url: url }).catch(err => {
                    console.log('Error sharing:', err);
                });
            }
        },

        canShare() {
            return !!navigator.share;
        },

        toggleSettings() {
            if (this.showSettings) {
                this.showSettings = false;
            } else {
                this.closeAllPanels();
                this.showSettings = true;

                // One-time import of type labels from notes when settings panel is opened
                this.importTypeLabelsFromNotes();
                this.loadUndoEntries();
            }
        },

        // Read the changes this calendar can undo. /history is written by a Cloud Function
        // on every write that changed events, and is read-only to clients -- so this is a
        // plain read with nothing to keep in sync.
        //
        // Only called when someone looks (the panel, Settings, a Cmd+Z with nothing local
        // to undo): the log can be large, and the header label has its own live stamp.
        async loadUndoEntries() {
            // Calls overlap (open panel + Cmd+Z + a refresh after an undo). Only the newest
            // may assign, or a slow older read would overwrite a fresher list.
            const seq = (this._undoLoadSeq = (this._undoLoadSeq || 0) + 1);
            const calendarId = this.calendar.id;
            if (!this.isExisting || !calendarId) {
                this.undoEntries = [];
                return this.undoEntries;
            }
            try {
                let rows = [];
                if (typeof CalendarDataService.loadUndoEntries === 'function') {
                    const cloudRows = await CalendarDataService.loadUndoEntries(calendarId);
                    if (Array.isArray(cloudRows) && cloudRows.length) {
                        rows = cloudRows;
                    }
                }
                // Never on the staging copy: Firebase there is production's data for a same-named calendar.
                if (!rows.length && typeof firebase !== 'undefined' && firebase.database && !window.pcNoProdSideEffects && !(typeof PreviewSite !== 'undefined' && PreviewSite.is())) {
                    // Only the newest 20 entries are ever shown, so only they are downloaded:
                    // a calendar's history is 10-20x the calendar itself.
                    const snap = await firebase.database()
                        .ref('/history/' + calendarId).orderByKey().limitToLast(20).once('value');
                    snap.forEach(c => { rows.push({ key: c.key, ...c.val() }); });
                }
                if (seq !== this._undoLoadSeq || calendarId !== this.calendar.id) return this.undoEntries;

                rows.sort((a, b) => b.savedAt - a.savedAt);

                const keyOf = this.eventKey;
                // Full events, not just ids: detecting an EDIT means comparing values.
                const live = this.calendar.events.map(e => JSON.parse(JSON.stringify(e)));
                const label = (e) => ({ title: this.eventName(e), when: this.describeEventTime(e) });
                // 'added' entries carry no snapshot, so the chain steps over them.
                const snapshotNear = (from, step) => {
                    for (let j = from; j >= 0 && j < rows.length; j += step) {
                        if (rows[j].events) return rows[j].events;
                    }
                    return null;
                };

                const detailed = rows.slice(0, 20).map((r, i) => {
                    // Current entries say exactly what they did. Firebase drops empty
                    // arrays, so an 'added' entry (which also has no snapshot) is
                    // recognized by the missing snapshot rather than by its delta fields.
                    const isDelta = !!(r.removedEvents || r.changedEvents || (r.kind === 'added' && !r.events));
                    let lostEvents, editedPairs, addedEvents, delta;

                    if (isDelta) {
                        lostEvents = r.removedEvents || [];
                        editedPairs = (r.changedEvents || []).filter(p => p && p.from && p.to);
                        addedEvents = r.addedEvents || [];
                        delta = { removed: lostEvents, changed: editedPairs, added: addedEvents };
                    } else {
                        // Legacy entry: only the calendar as it was BEFORE the change. What
                        // it cost is the difference from whatever came next -- the next
                        // newer snapshot (rows are newest-first), or the live calendar.
                        const before = r.events || [];
                        const after = snapshotNear(i - 1, -1) || live;
                        const stillThere = new Set(after.map(keyOf));
                        lostEvents = before.filter(e => !stillThere.has(keyOf(e)));
                        // Only what the chain itself proves this change removed is safe to
                        // put back. A legacy entry is never used to remove or revert.
                        delta = { removed: lostEvents.slice(), changed: [], added: [] };

                        // The server counted a removal but the comparison found none: a
                        // later change put the events back (e.g. an undo). Name them from
                        // the next OLDER snapshot so the row is not a nameless "1 event
                        // deleted" -- display only; they are already on the calendar.
                        if (!lostEvents.length && (r.removed || 0) > 0) {
                            const reference = snapshotNear(i + 1, 1) || live;
                            const refKeys = new Set(reference.map(keyOf));
                            const candidates = before.filter(e => !refKeys.has(keyOf(e)));
                            lostEvents = candidates.length ? candidates : before.slice(-(r.removed || 1));
                        }

                        const afterByKey = new Map(after.map(e => [keyOf(e), e]));
                        editedPairs = before
                            .filter(e => afterByKey.has(keyOf(e)))
                            .map(e => ({ from: e, to: afterByKey.get(keyOf(e)) }));
                        const beforeKeys = new Set(before.map(keyOf));
                        addedEvents = (r.addedEvents && r.addedEvents.length)
                            ? r.addedEvents
                            : after.filter(e => !beforeKeys.has(keyOf(e)));
                    }

                    // An edit row names the event and says what changed; a pair whose
                    // difference no person would notice is not listed.
                    const visibleEdits = editedPairs.filter(pair => this.describeEventDiff(pair.from, pair.to));
                    const edited = visibleEdits.map(pair => ({
                        title: this.eventName(pair.from),
                        change: this.describeEventDiff(pair.from, pair.to),
                    }));
                    const lost = lostEvents.map(label);
                    const added = addedEvents.map(label);

                    // The events this entry touched -- what collapsing and the "already
                    // undone" check compare, since titles are neither unique nor stable.
                    const keys = [...new Set([
                        ...lostEvents.map(keyOf),
                        ...visibleEdits.map(p => keyOf(p.from)),
                        ...addedEvents.map(keyOf),
                    ])].sort();
                    const n = lost.length;
                    if (this.isEmptyChange(r, { lost, edited, added })) return null;
                    // The row's dot: the color of the first event it touched (none for calendar-level changes).
                    const firstEvent = lostEvents[0] || (visibleEdits[0] && visibleEdits[0].to) || addedEvents[0];

                    return {
                        key: r.key,
                        savedAt: r.savedAt,
                        // Which browser wrote it (null on entries from before writers
                        // were recorded). Collapsing and Cmd+Z both go by it.
                        writer: r.writer || null,
                        keys,
                        lost,
                        edited,
                        added,
                        // One per history entry, newest first. A collapsed row undoes every
                        // part in turn rather than jumping back to the oldest snapshot.
                        parts: [{ key: r.key, savedAt: r.savedAt, writer: r.writer || null, keys, delta }],
                        // An addition has nothing to put back -- the event is already
                        // there. Listing it without a button is honest; a no-op Restore is
                        // not. (Cmd+Z can still take an addition back: undoLastChange.)
                        canRestore: delta.removed.length > 0 || delta.changed.length > 0,
                        type: firstEvent && firstEvent.type ? firstEvent.type : null,
                        what: this.describeChange(r, lost, edited, added),
                        when: this.describeWhen(r.savedAt),
                        // Terse for the row's right-hand column; the full timestamp rides
                        // along for the tooltip, so nothing is lost by keeping it short.
                        ago: this.describeAgo(r.savedAt),
                        // Clock time, for use under a day heading where "1d ago" on every
                        // row is both redundant and unscannable. The heading carries the
                        // date; this carries the time within it.
                        atTime: new Date(r.savedAt).toLocaleTimeString(undefined, {
                            hour: 'numeric', minute: '2-digit',
                        }),
                        whenExact: this.describeExact(r.savedAt),
                        // "Restore" is the word people expect for this, and naming the
                        // unit keeps a count from reading as a bare number ("Put back 2").
                        restoreLabel: n === 1 ? 'Restore event'
                            : n > 1 ? `Restore ${n} events`
                                : edited.length === 1 ? 'Undo this edit'
                                    : edited.length > 1 ? `Undo ${edited.length} edits`
                                        : 'Undo this change',
                    };
                });

                this.undoEntries = this.collapseSessions(detailed.filter(Boolean)).slice(0, 10);
                // An old calendar may predate the lastEditedAt stamp; the log still knows.
                const newest = this.undoEntries[0];
                if (newest && newest.savedAt > (this.lastEditedAt || 0)) {
                    this.lastEditedAt = newest.savedAt;
                    this.refreshRelativeTimes();
                }
            } catch (err) {
                // Never let a failed read break the settings panel.
                console.warn('[app] could not load undo history', err);
            }
            return this.undoEntries;
        },

        /**
         * Keep "Edited N ago" current from /history_meta/<id>/lastEditedAt, which the
         * server stamps on every real edit. A live listener updates the label when
         * somebody else changes a link-shared calendar while it is open -- the question it
         * exists to answer -- without downloading the history log on every echo.
         */
        watchLastEdited(calendarId) {
            if (!calendarId || typeof firebase === 'undefined') return;
            if (window.pcNoProdSideEffects || (typeof PreviewSite !== 'undefined' && PreviewSite.is())) return;   // staging/local CF: never production Firebase
            if (this._lastEditedRef && this._lastEditedId === calendarId) return;
            this.unwatchLastEdited();   // a different calendar: drop the old listener

            const db = firebase.database();
            this._lastEditedId = calendarId;
            this._lastEditedRef = db.ref('/history_meta/' + calendarId + '/lastEditedAt');
            this._lastEditedCb = this._lastEditedRef.on('value', (snap) => {
                const at = snap.val();
                if (typeof at === 'number') this.lastEditedAt = Math.max(at, this.lastEditedAt || 0);
                this.refreshRelativeTimes();
                // The list is only worth refreshing while someone is looking at it.
                // Deferred, since the history entry may land just after the stamp.
                if (this.showRecentChanges || this.showSettings) {
                    clearTimeout(this._undoRefreshTimer);
                    this._undoRefreshTimer = setTimeout(() => this.loadUndoEntries(), 1200);
                }
            }, (err) => console.warn('[app] could not watch lastEditedAt', err));

            // Our clock may be minutes off; "Edited 5m ago" for an edit made just now
            // reads as somebody else's change.
            this._serverOffsetRef = db.ref('.info/serverTimeOffset');
            this._serverOffsetCb = this._serverOffsetRef.on('value', (snap) => {
                this.serverTimeOffset = Number(snap.val()) || 0;
                this.refreshRelativeTimes();
            });

            // Relative labels go stale while the tab sits open ("just now" for an hour).
            clearInterval(this._relativeTimeTimer);
            this._relativeTimeTimer = setInterval(() => this.refreshRelativeTimes(), 60 * 1000);
        },

        unwatchLastEdited() {
            if (this._lastEditedRef) this._lastEditedRef.off('value', this._lastEditedCb);
            if (this._serverOffsetRef) this._serverOffsetRef.off('value', this._serverOffsetCb);
            clearInterval(this._relativeTimeTimer);
            clearTimeout(this._undoRefreshTimer);
            this._lastEditedRef = this._serverOffsetRef = null;
            this._lastEditedCb = this._serverOffsetCb = null;
            this._lastEditedId = null;
            this._relativeTimeTimer = null;
        },

        /**
         * Seed "Edited N ago" from the stamp that travels with the calendar (written by
         * CalendarDataService on every save) when the live /history_meta listener has not
         * answered yet, or the calendar has no server stamp. No network read: the server's
         * stamp, on the server's clock, always wins once it arrives.
         */
        loadLastEdit() {
            if (this.lastEditedAt == null && this.calendar && this.calendar.lastEditedAt) {
                this.lastEditedAt = this.calendar.lastEditedAt;
            }
            this.refreshRelativeTimes();
            this.maybeShowProUpsell();
        },

        /**
         * Pro, at the moment it is most relevant: you open a calendar YOU made and someone else
         * has changed it since your last visit. One quiet line above the calendar, at most once
         * per calendar per 30 days (ProUpsell, public/components/Pro.js). Never on someone
         * else's calendar, a locked or read-only one, the homepage draft, an embed or /beta.
         * Called whenever one of its inputs arrives (visit, lock state, last-edit stamp); the
         * history is read once, and only when everything cheaper already says yes.
         */
        async maybeShowProUpsell() {
            if (this._upsellChecked || this.proUpsell || typeof ProUpsell === 'undefined') return;
            const id = this.calendar && this.calendar.id;
            let embedded = true;
            try { embedded = window.self !== window.top; } catch (e) { /* cross-origin parent: embedded */ }
            const verdict = ProUpsell.precheck({
                id, existing: this.isExisting, homepage: this.isHomepageCalendar,
                readOnly: this.isReadOnly, viewRoute: this.viewRoute, embedded,
                beta: /^\/(beta|nativecal)(\/|$)/.test(location.pathname),
                mine: !!(this.recentManager && this.recentManager.getMine().some(item => item.id === id)),
                shownAt: ProUpsell.shownAt(id), now: Date.now(),
                lockKnown: this.lockKnown, locked: this.lock.locked,
                visitKnown: this.lastSeenKnown, lastSeenAt: this.lastSeenAt, lastEditedAt: this.lastEditedAt,
            });
            if (verdict === 'wait') return;
            this._upsellChecked = true;
            if (verdict !== 'yes') return;
            const rows = await this.loadUndoEntries();
            if (!ProUpsell.changedByOthers(rows, this.lastSeenAt, CalendarDataService.writerId)) return;
            // Things may have moved while the history loaded.
            if (!this.calendar || this.calendar.id !== id || this.lock.locked || this.isReadOnly) return;
            this.proUpsell = true;
            ProUpsell.markShown(id);
            track(a => a.proUpsellShown());
        },

        dismissProUpsell() {
            this.proUpsell = false;
            track(a => a.proUpsellDismissed());
        },

        // The quiet upsell line: the Plus tab. Billing not on yet: its beta email field is already open.
        openProUpsell() {
            this.proUpsell = false;
            track(a => a.proUpsellClicked());
            this.openPlusTab('lock', { join: this.proBilling === false });
        },

        /** Re-render every relative time from its stored timestamp. */
        refreshRelativeTimes() {
            // Always relative and always short -- "Edited 2d ago" is scannable at a glance
            // where an absolute date is not; the exact time is one hover away.
            const at = this.lastEditedAt;
            this.lastEditLabel = at ? `Edited ${this.describeAgo(at)}` : '';
            this.lastEditExact = at ? this.describeExact(at) : '';
            for (const entry of this.undoEntries) {
                entry.ago = this.describeAgo(entry.savedAt);
                entry.when = this.describeWhen(entry.savedAt);
            }
        },

        /** Now, on the server's clock -- the clock history timestamps are written in. */
        serverNow() {
            return Date.now() + (this.serverTimeOffset || 0);
        },

        /** An event's identity: an occurrence exception shares its series' id. */
        eventKey(e) {
            return `${e.id}|${e.recurrenceID ?? ''}`;
        },

        eventName(e) {
            return e && e.title && e.title.trim() ? e.title.trim() : 'Untitled event';
        },

        /**
         * Two versions of an event are the same if nothing a person would see differs.
         * Firebase drops empty values and dates can round-trip as different strings, so
         * compare normalized rather than with JSON equality.
         */
        sameEvent(a, b) {
            if (!a || !b) return false;
            return EventStore.same(a, b);   // every field of the one list, on meaning
        },

        /** What turned `before` into `after`, in the same shape the server records. */
        deltaBetween(before, after) {
            const keyOf = this.eventKey;
            const plain = (e) => JSON.parse(JSON.stringify(e));
            const afterByKey = new Map(after.map(e => [keyOf(e), e]));
            const beforeKeys = new Set(before.map(keyOf));
            const delta = { removed: [], changed: [], added: [] };
            for (const e of before) {
                const now = afterByKey.get(keyOf(e));
                if (!now) delta.removed.push(plain(e));
                else if (!this.sameEvent(e, now)) delta.changed.push({ from: plain(e), to: plain(now) });
            }
            for (const e of after) {
                if (!beforeKeys.has(keyOf(e))) delta.added.push(plain(e));
            }
            return delta;
        },

        /**
         * Work out what undoing these changes would do to the calendar AS IT IS NOW,
         * without doing it. Deltas are applied in the order given (newest first).
         *
         * A targeted patch, never a snapshot restore: putting back an old snapshot also
         * wiped every later add and edit, by anyone. So each part is reversed only where
         * the calendar still shows it -- a deleted event comes back only if it is missing,
         * an edit is reverted only if the event still holds the edited version, and an
         * addition is removed only if it is still there untouched. Anything changed since
         * is left alone and reported.
         */
        planUndo(deltas) {
            const keyOf = this.eventKey;
            const next = this.calendar.events.map(e => new Event(e));
            const at = (k) => next.findIndex(e => keyOf(e) === k);
            const plan = { next, restored: [], reverted: [], removed: [], skipped: [] };

            // Each reversal checks the calendar as it is now: 'done' (already as it was),
            // 'skip' (changed since) or 'apply'.
            const restoreOp = (e) => ({
                subject: e, list: plan.restored,
                check: () => (at(keyOf(e)) !== -1 ? 'done' : 'apply'),
                apply: () => next.push(new Event(e)),
            });
            const removeOp = (e) => ({
                subject: e, list: plan.removed,
                check: () => {
                    const i = at(keyOf(e));
                    if (i === -1) return 'done';
                    return this.sameEvent(next[i], e) ? 'apply' : 'skip';
                },
                apply: () => next.splice(at(keyOf(e)), 1),
            });
            const revertOp = ({ from, to }) => {
                // The edit touched nothing but the series' exception dates -- what editing
                // or deleting ONE occurrence does to the master. Reverting the whole master
                // would also wipe exception dates added since (another occurrence edited),
                // so only this edit's own dates are taken back out, or put back.
                const exOnly = !from.recurrenceID && this.sameEvent(
                    { ...from, recurrenceException: null }, { ...to, recurrenceException: null });
                const target = (cur) => (exOnly
                    ? new Event({ ...cur, recurrenceException: this.revertExdates(cur.recurrenceException, from, to) })
                    : new Event(from));
                return {
                    subject: from, list: plan.reverted,
                    check: () => {
                        const i = at(keyOf(from));
                        if (i === -1) return 'skip';
                        if (this.sameEvent(next[i], from)) return 'done';
                        if (this.sameEvent(next[i], to)) return 'apply';
                        if (!exOnly) return 'skip';
                        return this.sameEvent(next[i], target(next[i])) ? 'done' : 'apply';
                    },
                    apply: () => { const i = at(keyOf(from)); next[i] = target(next[i]); },
                };
            };

            for (const d of deltas) {
                // A series master and its occurrence exceptions are one unit: undoing an
                // occurrence edit both hides the exception row and un-hides the date on the
                // master. Done piecemeal, the exception could go while the master revert
                // was skipped (its exception dates changed since), and the occurrence
                // vanished; the reverse would show it twice. So all of a unit, or none.
                const all = [
                    ...(d.removed || []).map(e => ({ row: e, op: restoreOp(e) })),
                    ...(d.changed || []).map(p => ({ row: p.from, op: revertOp(p) })),
                    ...(d.added || []).map(e => ({ row: e, op: removeOp(e) })),
                ];
                const series = new Set(all.filter(x => !x.row.recurrenceID && x.row.recurrencerule)
                    .map(x => String(x.row.id)));
                const unitOf = (row) => {
                    if (row.recurrenceID && series.has(String(row.recurrenceID))) return 's:' + row.recurrenceID;
                    if (!row.recurrenceID && series.has(String(row.id))) return 's:' + row.id;
                    return 'k:' + keyOf(row);
                };
                const units = new Map();
                for (const x of all) {
                    const u = unitOf(x.row);
                    if (!units.has(u)) units.set(u, []);
                    units.get(u).push(x.op);
                }
                for (const ops of units.values()) {
                    const states = ops.map(op => op.check());
                    if (states.includes('skip')) {
                        ops.forEach((op, i) => { if (states[i] !== 'done') plan.skipped.push(op.subject); });
                        continue;
                    }
                    ops.forEach((op, i) => {
                        if (states[i] !== 'apply') return;
                        op.apply();
                        op.list.push(op.subject);
                    });
                }
            }

            const nextKeys = new Set(next.map(keyOf));
            // What actually leaves the calendar -- the only number the write gate is told.
            plan.removingKeys = this.calendar.events.map(keyOf).filter(k => !nextKeys.has(k));
            plan.removing = plan.removingKeys.length;
            plan.touched = new Set([...plan.restored, ...plan.reverted, ...plan.removed].map(keyOf));
            plan.noop = plan.touched.size === 0;
            return plan;
        },

        /**
         * A series' exception dates (comma-separated EXDATEs) as they are now, with ONE
         * edit's change (from -> to) taken back: dates it added are removed, dates it
         * removed are put back, and anything else added since is kept.
         */
        revertExdates(current, from, to) {
            const list = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
            const was = new Set(list(from.recurrenceException));
            const became = new Set(list(to.recurrenceException));
            const out = list(current).filter(x => !(became.has(x) && !was.has(x)));
            for (const x of was) if (!became.has(x) && !out.includes(x)) out.push(x);
            return out.length ? out.join(',') : null;
        },

        /** Write a plan from planUndo, and remember the write as this session's own. */
        commitUndo(plan) {
            if (plan.noop) return;
            const before = this.calendar.events.map(e => new Event(e));
            // Through the store: it counts what leaves for the write gate (declared by key
            // in its commit hook), and the undo can itself be undone.
            const r = this.store().dispatch(
                { type: 'batch', commands: EventStore.changesBetween(this.calendar.events, plan.next) },
                { label: 'Undo from history' });
            if (!r.ok) { plan.noop = true; return; }
            // The server logs this undo as a change of its own; the /history fallback
            // must not then offer to undo the undo. Matched on exactly what we wrote, at
            // the time we wrote it (see isHandledHistory).
            this._handledUndo.push({ at: this.serverNow(), delta: this.deltaBetween(before, this.calendar.events) });
            if (this.showRecentChanges || this.showSettings) {
                clearTimeout(this._undoRefreshTimer);
                this._undoRefreshTimer = setTimeout(() => this.loadUndoEntries(), 1500);
            }
        },

        /** Say what an undo actually did -- never "Restored 12 events" when it removed one. */
        describeUndo(plan) {
            // A collapsed drag reverts one event several times over; it is still one event,
            // named as it ends up (the last version written for its key).
            const phrase = (all, verb) => {
                const list = [...new Map(all.map(e => [this.eventKey(e), e])).values()];
                return list.length === 1
                    ? `${verb} "${this.eventName(list[0])}"`
                    : `${verb} ${list.length} events`;
            };
            const parts = [];
            if (plan.restored.length) parts.push(phrase(plan.restored, 'Restored'));
            if (plan.reverted.length) parts.push(phrase(plan.reverted, 'Reverted'));
            if (plan.removed.length) parts.push(phrase(plan.removed, 'Removed'));
            const skippedList = [...new Map(plan.skipped.map(e => [this.eventKey(e), e])).values()];
            const skipped = skippedList.length;
            const since = skipped === 1
                ? `"${this.eventName(skippedList[0])}" was changed since, so it was left as is`
                : `${skipped} events were changed since, so they were left as is`;
            if (!parts.length) return skipped ? `Nothing undone: ${since}` : 'Nothing to undo: already as it was';
            const text = parts.map((p, i) => i ? p.charAt(0).toLowerCase() + p.slice(1) : p).join(', ');
            return skipped ? `${text}; ${since}` : text;
        },

        /**
         * True if this session already undid this history entry, or its own undo wrote it.
         *
         * Matched on what the entry DID, not just which events it touched: the writer id
         * names a browser, not a tab or session, so another tab's edit to the same event
         * inside the window would otherwise be taken for this session's undo and skipped
         * (before writers were recorded, a colleague's was too), and Cmd+Z undid
         * something older. A near miss is the safe failure -- an unmatched entry of ours plans as a
         * no-op or names what it would change; skipping someone else's change does not.
         */
        isHandledHistory(part) {
            if (this._undoneHistoryKeys.has(part.key)) return true;
            // savedAt is stamped after the debounced write and the Cloud Function have
            // both run, so it trails the moment we wrote by up to a cold start.
            return this._handledUndo.some(h => part.savedAt >= h.at - 2000
                && part.savedAt <= h.at + 60 * 1000
                && this.sameDelta(part.delta, h.delta));
        },

        /** Two deltas make the same change, compared on meaning (see sameEvent). */
        sameDelta(a, b) {
            if (!a || !b) return false;
            const keyOf = this.eventKey;
            const sameSet = (x, y) => {
                x = x || []; y = y || [];
                if (x.length !== y.length) return false;
                const byKey = new Map(y.map(e => [keyOf(e), e]));
                return x.every(e => this.sameEvent(e, byKey.get(keyOf(e))));
            };
            const tos = (d) => (d.changed || []).filter(p => p && p.from && p.to)
                .map(p => ({ ...p.to, id: p.from.id, recurrenceID: p.from.recurrenceID }));
            const any = (d) => (d.removed || []).length + (d.changed || []).length + (d.added || []).length;
            return any(a) > 0
                && sameSet(a.removed, b.removed)
                && sameSet(a.added, b.added)
                && sameSet(tos(a), tos(b));
        },

        /**
         * Plain language for what a change cost. Names the event wherever we know it: a row
         * reading "1 event deleted" with nothing named tells the user nothing they can act
         * on, which is the whole point of the list.
         */
        describeChange(entry, lost, edited, added) {
            const name = (list, verb) => {
                if (list.length === 1) return `${verb} "${list[0].title}"`;
                if (list.length === 2) return `${verb} "${list[0].title}" and "${list[1].title}"`;
                return `${verb} "${list[0].title}" and ${list.length - 1} more`;
            };

            const gone = (lost || []).map(e => ({
                title: (e.title && e.title.trim()) ? e.title : 'Untitled event',
            }));
            if (entry.kind === 'restored') return ProInsightMath.restoredLabel(entry.label);   // "Restored the version from Oct 21"
            // Server-written rows: "Upgraded with Plus", "Unlocked". Rows written before the rename said Pro for the Plus plan.
            if (entry.label) return { 'Locked with Pro': 'Upgraded with Plus', 'Pro ended. Editing paused by the owner': 'Plus ended. Editing paused by the owner' }[entry.label] || entry.label;
            if (entry.kind === 'wiped' || entry.kind === 'deleted') {
                return gone.length ? `All events deleted (${gone.length})` : 'All events deleted';
            }
            if (gone.length) return name(gone, 'Deleted');

            const e = edited || [];
            if (e.length) return name(e, 'Edited');

            const a = added || [];
            if (a.length) return name(a, 'Added');

            const n = entry.removed || 0;
            if (n > 0) return n === 1 ? '1 event deleted' : `${n} events deleted`;
            const c = entry.changed || 0;
            if (c > 0) return c === 1 ? '1 event edited' : `${c} events edited`;
            const ad = entry.added || 0;
            if (ad > 0) return ad === 1 ? '1 event added' : `${ad} events added`;
            if (entry.kind === 'title-cleared') return 'Calendar title cleared';
            // Nothing to name: a write that changed no event (see isEmptyChange).
            return null;
        },

        /**
         * A history entry that changed no event, so there is nothing to list or undo. Rooms
         * on Cloudflare stored one for every settings-only write (the option defaults a tab
         * fills in on load go out right after its first edit), listed as "0 events added".
         * They no longer record them, but entries already stored are skipped here.
         */
        isEmptyChange(r, row) {
            if (['wiped', 'deleted', 'title-cleared'].includes(r.kind)) return false;
            return !row.lost.length && !row.edited.length && !row.added.length
                && !(r.removed || 0) && !(r.changed || 0) && !(r.added || 0);
        },

        /**
         * What actually changed between two versions of the same event, in the words a
         * person would use -- "renamed", "moved to Thu, Sep 17" -- or null if nothing
         * meaningful differs. Firebase drops empty values, so compare normalized.
         */
        describeEventDiff(from, to) {
            const norm = (v) => (v === undefined || v === null || v === '') ? null : v;
            const parts = [];
            if (norm(from.title) !== norm(to.title)) {
                parts.push(to.title && to.title.trim() ? `renamed to "${to.title}"` : 'title cleared');
            }
            if (norm(from.start) !== norm(to.start) || norm(from.end) !== norm(to.end)) {
                parts.push(`moved to ${this.describeEventTime(to)}`);
            }
            if (norm(from.description) !== norm(to.description)) parts.push('notes changed');
            if (String(from.type ?? 1) !== String(to.type ?? 1)) parts.push('color changed');
            if (!!from.isAllDay !== !!to.isAllDay) parts.push(to.isAllDay ? 'made all-day' : 'given a time');
            if (norm(from.recurrencerule) !== norm(to.recurrencerule)) parts.push('repeat changed');
            return parts.length ? parts.join(', ') : null;
        },

        /**
         * Fold a burst of writes into one row per thing the user actually did.
         *
         * The 500ms debounce writes repeatedly while somebody drags an event, so one
         * gesture lands as several history entries -- measured on /kalid: 14 entries from
         * about 4 real actions, with gaps of 1, 3, 5, 6 and 8 seconds. Listing them raw
         * gives five near-identical "Edited 'test' -- moved to..." rows for a single drag,
         * which buries the changes that matter. Google Docs collapses the same way, and
         * hides the individual versions behind a toggle.
         *
         * Two entries merge when they touch exactly the same events (by identity, not by
         * title: two events called "Standup" are not one event, and a rename changes the
         * title mid-run) AND each is within the gap of the one before it, so distinct edits
         * made back to back stay separate -- and only when one browser wrote them all: two
         * people nudging the same event are two changes, and undoing the row must not take
         * back a collaborator's along with yours. Entries with no recorded writer (older
         * than the field) count as one writer of their own, so they still collapse with
         * each other but never with a known writer's. Every entry in a run is kept: undoing the row
         * reverses each one in turn, newest first, which lands where the gesture began
         * without discarding unrelated changes the way restoring the oldest snapshot did.
         */
        collapseSessions(entries) {
            const SESSION_GAP_MS = 2 * 60 * 1000;
            const keysOf = (e) => (e.keys || []).join(',');
            // Only merge writes of the same KIND. A deletion and the restore that follows
            // it touch the same event within seconds, but they are opposite actions --
            // merging them made the deletion disappear from the list entirely, so there
            // was nothing left to undo.
            const kindOf = (e) => e.lost.length ? 'del'
                : (e.edited || []).length ? 'edit'
                    : (e.added || []).length ? 'add' : 'other';

            const out = [];
            for (const entry of entries) {           // newest first
                const prev = out[out.length - 1];
                // Measured from the OLDEST entry already in the run, so a long drag keeps
                // chaining while two edits minutes apart do not.
                const sameThing = prev
                    && prev.oldestAt - entry.savedAt < SESSION_GAP_MS
                    && kindOf(prev) === kindOf(entry)
                    && (prev.writer || null) === (entry.writer || null)
                    && keysOf(prev) === keysOf(entry)
                    && keysOf(entry) !== '';
                if (!sameThing) {
                    out.push({ ...entry, parts: [...entry.parts], oldestAt: entry.savedAt, mergedCount: 1 });
                    continue;
                }
                // Same burst: keep the newest row's wording, and every part to undo.
                prev.mergedCount += 1;
                prev.parts.push(...entry.parts);
                prev.oldestAt = entry.savedAt;
            }

            return out.map(e => e.mergedCount > 1
                ? { ...e, what: this.describeSession(e) }
                : e);
        },

        /**
         * Wording for a collapsed run, which describes the gesture rather than one write.
         *
         * The verb comes from what the run ENDED in -- a drag that finishes in a deletion
         * reads as a deletion, not as "Deleted X (4 changes)", which invites the reader to
         * wonder what the other three were.
         */
        describeSession(entry) {
            const n = entry.mergedCount;
            const lost = entry.lost || [];
            const edited = entry.edited || [];

            // A run that ends in a deletion is a deletion; the edits before it are noise.
            if (lost.length) return entry.what;
            if (edited.length === 1) return `Edited "${edited[0].title}" ${n} times`;
            if (edited.length > 1) return `${entry.what}, ${n} changes`;
            return entry.what;
        },

        /** Terse relative age: "just now", "5m ago", "3h ago", "2d ago", "6w ago". */
        describeAgo(ts) {
            if (!ts) return '';
            const s = Math.max(0, Math.round((this.serverNow() - ts) / 1000));
            if (s < 60) return 'just now';
            const m = Math.round(s / 60);
            if (m < 60) return `${m}m ago`;
            const h = Math.round(m / 60);
            if (h < 24) return `${h}h ago`;
            const d = Math.round(h / 24);
            if (d < 7) return `${d}d ago`;
            const w = Math.round(d / 7);
            if (w < 5) return `${w}w ago`;
            const mo = Math.round(d / 30);
            return mo < 12 ? `${mo}mo ago` : `${Math.round(d / 365)}y ago`;
        },

        /** The precise moment, for the tooltip. The year only when it is not this one. */
        describeExact(ts) {
            if (!ts) return '';
            const d = new Date(ts);
            return d.toLocaleString([], {
                weekday: 'short', month: 'short', day: 'numeric',
                year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
                hour: 'numeric', minute: '2-digit',
            });
        },

        /** When an event was scheduled, for the expanded detail list. */
        describeEventTime(e) {
            const d = new Date(e.start);
            if (isNaN(d.getTime())) return '';
            const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
            if (e.isAllDay) return `${date}, all day`;
            return `${date}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        },

        describeWhen(ts) {
            if (!ts) return '';
            const d = new Date(ts);
            const mins = Math.round((this.serverNow() - ts) / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return `${mins} min ago`;
            const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const today = new Date();
            if (d.toDateString() === today.toDateString()) return `today ${time}`;
            return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
        },

        /**
         * Undo one Recent changes row: every history entry folded into it, newest first,
         * patched onto the calendar as it is now (see planUndo).
         */
        undoChange(entry) {
            const plan = this.planUndo(entry.parts.map(p => p.delta));
            this.commitUndo(plan);
            if (!plan.noop) entry.parts.forEach(p => this._undoneHistoryKeys.add(p.key));
            this.showToast(this.describeUndo(plan), plan.noop ? 'info' : 'success');
        },

        // ============================================================
        // REGION: Settings & Preferences Management
        // ============================================================

        // Global Settings methods (device-specific, stored in localStorage)
        loadGlobalSettings() {
            // Storage can be unreadable (blocked in private/embedded browsers) or hold garbage
            // from an old build; either threw here and left the app on "Loading..." for good.
            let settings = null;
            try {
                settings = JSON.parse(localStorage.getItem('pastecal_global_settings'));
            } catch (e) {
                console.warn('Ignoring unreadable saved settings:', e && e.message);
            }
            if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
                this.globalSettings = { ...this.globalSettings, ...settings };

                // Ensure custom view properties exist for backwards compatibility
                if (this.globalSettings.customViewDuration === undefined) {
                    this.globalSettings.customViewDuration = 3;
                }
                if (this.globalSettings.customViewUnit === undefined) {
                    this.globalSettings.customViewUnit = 'Months';
                }
            } else {
                // Auto-import locale settings if no saved settings exist
                this.autoImportLocaleSettings();
            }
        },

        // Auto-import settings from browser locale
        autoImportLocaleSettings() {
            try {
                // Get browser locale 
                const locale = navigator.language || navigator.userLanguage;
                console.log("Detected locale:", locale);

                // Detect 12/24 hour format preference from locale
                const formatter = new Intl.DateTimeFormat(locale, {
                    hour: 'numeric',
                    hour12: undefined // Let the system decide
                });
                const timeFormatSample = formatter.format(new Date(2023, 0, 1, 13, 0, 0));
                // Check if the formatted time contains "AM" or "PM" or their locale equivalents
                const is12Hour = timeFormatSample.match(/am|pm|a\.m\.|p\.m\.|AM|PM|A\.M\.|P\.M\./i) !== null;
                this.globalSettings.timeFormat = is12Hour ? '12' : '24';
                console.log("Detected time format:", is12Hour ? "12-hour" : "24-hour");

                // Detect first day of week - cross-browser compatible approach
                let firstDay = 0; // Default to Sunday (0)

                try {
                    // Try the newer Intl.Locale API first
                    if (typeof Intl !== 'undefined' &&
                        typeof Intl.Locale !== 'undefined' &&
                        typeof Intl.Locale.prototype.getWeekInfo === 'function') {
                        const weekInfo = new Intl.Locale(locale).getWeekInfo();
                        firstDay = weekInfo.firstDay === 7 ? 0 : weekInfo.firstDay; // Convert Sunday (7) to 0
                        console.log("First day detected using Intl.Locale.getWeekInfo");
                    }
                    // Fallback to region-based detection
                    else {
                        // Countries/regions that typically use Monday as first day of week
                        const mondayFirstRegions = ['AD', 'AL', 'AM', 'AT', 'AZ', 'BA', 'BE', 'BG', 'BY', 'CH',
                            'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GE', 'GR',
                            'HR', 'HU', 'IS', 'IT', 'KG', 'KZ', 'LT', 'LU', 'LV', 'MC',
                            'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS',
                            'RU', 'SE', 'SI', 'SK', 'SM', 'TJ', 'TM', 'TR', 'UA', 'UZ',
                            'VA', 'CN', 'HK', 'JP', 'KP', 'KR', 'MO', 'TW'];

                        // Languages that typically use Monday as first day of week
                        const mondayFirstLanguages = ['ar', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'et', 'eu', 'fa',
                            'fi', 'fr', 'hr', 'hu', 'is', 'it', 'lt', 'lv', 'mk', 'nl',
                            'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'tr', 'uk', 'zh'];

                        // Extract region code and language code
                        let regionCode = '';
                        let languageCode = '';

                        if (locale.includes('-')) {
                            const parts = locale.split('-');
                            languageCode = parts[0].toLowerCase();
                            regionCode = parts[1].toUpperCase();
                        } else {
                            languageCode = locale.toLowerCase();
                        }

                        // Check region first, then fall back to language
                        if (mondayFirstRegions.includes(regionCode)) {
                            firstDay = 1; // Monday
                            console.log("First day detected as Monday based on region:", regionCode);
                        } else if (mondayFirstLanguages.includes(languageCode)) {
                            firstDay = 1; // Monday
                            console.log("First day detected as Monday based on language:", languageCode);
                        } else {
                            console.log("First day defaulting to Sunday (not in Monday lists)");
                        }
                    }
                } catch (e) {
                    console.warn("Error in first day detection:", e);
                    // Keep the default (Sunday) if there's an error
                }

                this.globalSettings.firstDayOfWeek = firstDay.toString();
                console.log("Detected first day of week:", firstDay === 0 ? "Sunday" : "Monday");

                // Add locale detection flag for UI messaging
                this.globalSettings.autoDetectedFromLocale = true;

                // Save the imported settings
                this.saveGlobalSettings();
            } catch (error) {
                console.error("Error auto-importing locale settings:", error);
                // Fallback to defaults if import fails
            }
        },

        /** e: the change event of a Settings field (a person's change, counted as settings:<field>); none for the
         *  first visit's automatic import, which used to count every new visitor as a Settings use. */
        saveGlobalSettings(e) {
            try {
                localStorage.setItem('pastecal_global_settings', JSON.stringify(this.globalSettings));
                const field = e && e.target && String(e.target.id || e.target.getAttribute('aria-label') || '').replace(/^set-/, '').replace(/\W+/g, '_').toLowerCase();
                if (field) track(a => a.featureUsed(`settings:${field}`));
                console.log('Global settings saved to localStorage');
            } catch (error) {
                console.warn('Failed to save settings to localStorage:', error);
                // Notify user if in private mode
                if (error.name === 'QuotaExceededError' ||
                    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                    error.code === 22) {
                    console.warn('Browser may be in private browsing mode');
                } else {
                    console.warn('Unable to save settings', error);
                }
            }
            this.applyGlobalSettings();
            this.applyTheme();
        },

        // settings which are stored in the remote calendar object
        applyGlobalSettingsAfterRemote() {
            if (typeof window.scheduleObj === 'undefined' || !window.scheduleObj) {
                console.log('[applyGlobalSettingsAfterRemote] Scheduler not initialized yet, skipping settings application');
                return;
            }

            this.applyGlobalSettings();
        },

        applyGlobalSettings() {
            console.log('[applyGlobalSettings] Called');
            if (typeof window.scheduleObj === 'undefined' || !window.scheduleObj) {
                return;
            }

            // console.log("[app] cal data", this.calendar);

            try {
                // Apply first day of week
                scheduleObj.firstDayOfWeek = parseInt(this.globalSettings.firstDayOfWeek);

                // Apply time format
                const timeFormat = this.globalSettings.timeFormat === '24' ? 'HH:mm' : 'h:mm a';
                scheduleObj.timeFormat = timeFormat;

                // Apply default view if not already set via URL
                this.applyDefaultView();

                // Apply start hour if not overridden by extended setting
                if (!this.calendar?.options?.extended) {
                    scheduleObj.startHour = this.globalSettings.startHour;
                }

                console.log('Global settings applied successfully:', {
                    firstDayOfWeek: scheduleObj.firstDayOfWeek,
                    timeFormat: scheduleObj.timeFormat,
                    currentView: scheduleObj.currentView,
                    startHour: scheduleObj.startHour
                });
            } catch (error) {
                console.error('Error applying global settings:', error);
                // Try to recover by applying settings individually
                try {
                    scheduleObj.firstDayOfWeek = parseInt(this.globalSettings.firstDayOfWeek);
                    console.log('Applied first day of week setting');
                } catch (e) { console.warn('Failed to apply first day of week setting:', e); }

                try {
                    scheduleObj.timeFormat = this.globalSettings.timeFormat === '24' ? 'HH:mm' : 'h:mm a';
                    console.log('Applied time format setting');
                } catch (e) { console.warn('Failed to apply time format setting:', e); }

                try {
                    this.applyDefaultView();
                    console.log('Applied default view setting');
                } catch (e) { console.warn('Failed to apply default view setting:', e); }

                try {
                    if (!this.calendar?.options?.extended) {
                        scheduleObj.startHour = this.globalSettings.startHour;
                        console.log('Applied start hour setting');
                    }
                } catch (e) { console.warn('Failed to apply start hour setting:', e); }
            }
        },

        // Calendar-specific Settings methods (stored in calendar.options)
        initializeLocalSettings() {
            // Ensure we have default type labels
            const defaultLabels = Array(this.COLORS.length).fill().map((_, i) => `Type ${i + 1}`);

            if (!this.localSettings.typeLabels || !Array.isArray(this.localSettings.typeLabels)) {
                this.localSettings.typeLabels = [...defaultLabels];
            }

            // If the calendar has typeLabels, use them
            if (this.calendar?.options?.typeLabels?.length > 0) {
                this.localSettings.typeLabels = [...this.calendar.options.typeLabels];
            } else {
                // Try to import from notes
                const imported = this.importTypeLabelsFromNotes();
                if (!imported) {
                    // If import failed or had no labels, use defaults
                    this.localSettings.typeLabels = [...defaultLabels];
                    // Store defaults in calendar.options
                    if (!this.calendar.options) this.calendar.options = {};
                    this.calendar.options.typeLabels = [...defaultLabels];
                }
            }

            // Load custom colors
            this.loadCustomColors();
        },

        /**
         * Add one more event category.
         *
         * Everything downstream already derives its length from COLORS -- the resource
         * list Syncfusion binds, the dynamic .e-color-N CSS, the filter dots, the ICS
         * feed (which ignores type entirely) -- so growing the palette is genuinely just
         * pushing a color and a label. The only thing that needs saying out loud is that
         * colorFilters has to grow with it, which syncColorFiltersLength already does.
         *
         * No removal. Deleting a category orphans the events on it, and reassigning them
         * silently is worse than not offering the button. Nobody has asked for it.
         */
        /**
         * The stock color for a category slot, for any index -- not just the first eight.
         *
         * DEFAULT_COLORS covers 1-8 and EXTRA_COLORS covers 9-16, so a bare
         * DEFAULT_COLORS[index] is undefined past the eighth and would write undefined
         * into the palette. Both reset paths go through here.
         */
        defaultColorForIndex(index) {
            if (index < this.DEFAULT_COLORS.length) return this.DEFAULT_COLORS[index];
            const extra = index - this.DEFAULT_COLORS.length;
            return this.EXTRA_COLORS[extra % this.EXTRA_COLORS.length];
        },

        addCategory() {
            if (this.COLORS.length >= this.MAX_COLORS) return;

            const index = this.COLORS.length;
            // Walk the extension palette from where the defaults left off, then wrap.
            // A color already in use is still better than a random one: it is at least
            // a color chosen to be legible.
            const next = this.EXTRA_COLORS[(index - this.DEFAULT_COLORS.length + this.EXTRA_COLORS.length) % this.EXTRA_COLORS.length]
                || this.EXTRA_COLORS[0];

            this.COLORS.push(next);
            this.localSettings.colors.push(next);
            this.localSettings.typeLabels.push(`Type ${index + 1}`);

            // One filter flag per color, or a dot toggles the wrong type.
            this.syncColorFiltersLength();

            this.storeColorsInCalendarOptions();
            this.storeTypeLabelsInCalendarOptions();
            this.updateColorCSS();

            track(a => a.featureUsed('category_added', String(this.COLORS.length)));

            // Focus the new row's label so it can be named without hunting for it.
            this.$nextTick(() => {
                const el = document.querySelector(`[data-category-label="${index}"]`);
                if (el) { el.focus(); el.select?.(); }
            });
        },

        updateTypeLabel(typeId, value) {
            const index = typeId - 1;
            if (index >= 0 && index < this.COLORS.length) {
                // Sanitize input: trim whitespace, limit length to 70 chars, ensure non-empty
                let sanitizedValue = value.trim().substring(0, 70);
                if (sanitizedValue === '') {
                    sanitizedValue = `Type ${typeId}`; // Fallback to default if empty
                }

                this.localSettings.typeLabels[index] = sanitizedValue;
                // Store directly in calendar.options and sync
                this.storeTypeLabelsInCalendarOptions();
            }
        },

        updateEventColor(index, color) {
            if (index >= 0 && index < this.COLORS.length) {
                // Custom colors are a candidate paid feature (see pro.md's
                // whitelabel tier), and nobody currently knows if anyone changes
                // them from the defaults.
                track(a => a.featureUsed('colors'));

                // Update local settings
                this.localSettings.colors[index] = color;

                // Update the component COLORS array
                this.COLORS[index] = color;

                // Store in calendar options and sync
                this.storeColorsInCalendarOptions();

                // Update CSS dynamically
                this.updateColorCSS();
            }
        },

        resetEventColor(index) {
            if (index >= 0 && index < this.COLORS.length) {
                this.localSettings.colors[index] = this.defaultColorForIndex(index);
                this.COLORS[index] = this.defaultColorForIndex(index);

                this.storeColorsInCalendarOptions();
                this.updateColorCSS();
            }
        },

        resetAllColors() {
            // Reset the COLORS, keep the COUNT. Someone with twelve categories who wants
            // the default palette back is asking for default colors, not to lose four
            // categories -- and dropping to eight left twelve labels pointing at eight
            // slots, so types 9-12 rendered in the fallback color while still being
            // listed and selectable.
            const count = Math.max(this.localSettings.typeLabels.length, this.DEFAULT_COLORS.length);
            const palette = [];
            for (let i = 0; i < count; i++) {
                palette.push(this.defaultColorForIndex(i));
            }
            this.localSettings.colors = palette;
            this.COLORS = [...palette];
            this.syncColorFiltersLength();

            this.storeColorsInCalendarOptions();
            this.updateColorCSS();
        },

        storeColorsInCalendarOptions() {
            // Ensure calendar.options exists
            if (!this.calendar.options) {
                this.calendar.options = {};
            }

            // Store custom colors in calendar.options
            this.calendar.options.colors = [...this.localSettings.colors];

            // The calendar watcher will handle syncing to Firebase or localStorage
            // Refresh the schedule to update the UI
            if (window.scheduleObj) {
                scheduleObj.refresh();
            }
        },

        updateColorCSS() {
            // Remove existing dynamic style if it exists
            const existingStyle = document.getElementById('dynamic-color-styles');
            if (existingStyle) {
                existingStyle.remove();
            }

            // Create new style element
            const style = document.createElement('style');
            style.id = 'dynamic-color-styles';

            let css = '';
            this.COLORS.forEach((color, index) => {
                const num = index + 1;
                css += `.e-color-${num} { background-color: ${color} !important; }\n`;
                css += `.e-color-${num}:hover { background-color: ${color} !important; }\n`;
            });

            style.textContent = css;
            document.head.appendChild(style);
        },

        loadCustomColors() {
            // Load custom colors from calendar options if available
            if (this.calendar.options && this.calendar.options.colors && Array.isArray(this.calendar.options.colors)) {
                // Calendars store a copy of the palette, so ones made before Oct 2026 still hold the
                // old coral/green/gray, which only dark text could read. An exact old default shows as
                // the deeper one (white text passes 4.5:1); a color someone picked themselves stays.
                const UPGRADE = { '#ff6652': '#d0442f', '#4caf50': '#2e7d32', '#9e9e9e': '#757575' };
                const colors = this.calendar.options.colors.map(c => UPGRADE[String(c).toLowerCase()] || c);

                // Update local settings with stored colors
                this.localSettings.colors = [...colors];

                // Update the component COLORS array
                this.COLORS = [...colors];

                // One filter flag per color. colorFilters is sized once at init from the
                // default palette; COLORS is replaced here with whatever the calendar
                // stored, a Firebase value of unchecked length. Without this a palette of
                // a different size leaves dots and flags misaligned, so a dot would toggle
                // the wrong type -- or a type would have no dot at all.
                this.syncColorFiltersLength();

                // Update CSS to reflect custom colors
                this.updateColorCSS();
            }
        },

        getTypeColor(typeId) {
            typeId = parseInt(typeId);
            return this.COLORS[typeId - 1] || this.COLORS[0];
        },

        storeTypeLabelsInCalendarOptions() {
            // Ensure calendar.options exists
            if (!this.calendar.options) {
                this.calendar.options = {};
            }

            // Store type labels directly in calendar.options
            this.calendar.options.typeLabels = [...this.localSettings.typeLabels];

            // The calendar watcher will handle syncing to Firebase or localStorage
            // Refresh the schedule to update the UI
            if (window.scheduleObj) {
                scheduleObj.refresh();
            }
        },

        // One-time migration from notes format to calendar.options format
        importTypeLabelsFromNotes() {
            try {
                if (!this.calendar.options) {
                    this.calendar.options = {};
                }

                // Skip if we already have typeLabels in calendar.options
                if (this.calendar?.options?.typeLabels?.length > 0) {
                    this.localSettings.typeLabels = [...this.calendar.options.typeLabels];
                    return true; // Success - already had labels
                }

                const notes = this.calendar?.options?.notes || '';
                const typeRegex = /\b(Type)\s*(\d)\s*[=](.*)\b/ig;
                const matches = [...notes.matchAll(typeRegex)];

                if (matches.length > 0) {
                    // Found type definitions in notes to migrate
                    const labels = Array(this.COLORS.length).fill().map((_, i) => `Type ${i + 1}`);

                    matches.forEach(m => {
                        const index = parseInt(m[2]) - 1;
                        if (index >= 0 && index < this.COLORS.length) {
                            labels[index] = m[3].trim().substring(0, 70);
                        }
                    });

                    // Update localSettings and store in calendar.options
                    this.localSettings.typeLabels = labels;
                    this.calendar.options.typeLabels = [...labels];

                    // Clean up the notes by removing type definitions
                    this.cleanTypeDefinitionsFromNotes(notes, matches);

                    return true; // Success - found and migrated labels
                }

                return false; // No labels found to migrate
            } catch (error) {
                console.error('Error importing type labels from notes:', error);
                return false; // Error occurred
            }
        },

        cleanTypeDefinitionsFromNotes(notes, matches) {
            // Get all the strings to remove
            const stringsToRemove = matches.map(match => match[0]);

            let newNotes = notes;
            // Remove each string and any line breaks around it
            stringsToRemove.forEach(str => {
                // Remove the string with surrounding line breaks
                newNotes = newNotes.replace(new RegExp(str + '\\n?\\n?', 'g'), '');
                newNotes = newNotes.replace(new RegExp('\\n?\\n?' + str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
            });

            // Clean up excessive line breaks
            newNotes = newNotes.replace(/\n{3,}/g, '\n\n').trim();

            // Update notes
            this.calendar.options.notes = newNotes;
        },

        /**
         * @param method What was copied, for analytics: 'copy' for a calendar link,
         *   'ics' for a feed URL. The function itself can't tell them apart, so the
         *   call site says which -- an untagged copy still works, it just isn't
         *   attributed.
         */
        // Share's click-to-copy fields: reactive "copied" state, so Vue owns the markup. The async
        // clipboard can be refused (permissions, focus, older browsers), so fall back to the
        // execCommand path, and if that fails too, select the link so Cmd/Ctrl+C works.
        copyLink(key, text, method) {
            if (!text) { this.showToast('Nothing to copy', 'error'); return; }
            if (method) track(a => a.calendarShared(method));
            const done = () => {
                this.copiedKey = key;
                clearTimeout(this._copiedTimer);
                this._copiedTimer = setTimeout(() => { this.copiedKey = null; }, 1600);
            };
            const legacy = () => {
                const ta = document.createElement('textarea');
                ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
                document.body.appendChild(ta); ta.select();
                let ok = false;
                try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
                ta.remove();
                return ok;
            };
            const fail = () => {
                const el = document.querySelector(`[data-copy-key="${key}"] .pc-link-url`);
                if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
                this.showToast('Your browser blocked copying. The link is selected: press ⌘C or Ctrl+C.', 'error');
            };
            const p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
            p.then(done).catch(() => (legacy() ? done() : fail()));
        },

        copyToClipboard(textToCopy, buttonElement, method) {
            if (!textToCopy) {
                this.showToast('Nothing to copy', 'error');
                return;
            }

            if (method) track(a => a.calendarShared(method));

            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalContent = buttonElement.innerHTML;
                const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>`;
                buttonElement.innerHTML = `${checkIcon} Copied`;
                buttonElement.classList.add('bg-theme-success');

                setTimeout(() => {
                    buttonElement.innerHTML = originalContent;
                    buttonElement.classList.remove('bg-theme-success');
                                    }, 1500); // Revert after 1.5 seconds

            }).catch(err => {
                console.error('Failed to copy: ', err);
                this.showToast('Couldn’t copy the link', 'error');
            });
        },

        // Normalize boolean-ish values coming from external sources
        normalizeBoolean(val) {
            if (typeof val === 'string') {
                const v = val.trim().toLowerCase();
                if (v === 'true') return true;
                if (v === 'false') return false;
            }
            return Boolean(val);
        },

        // Safely set isReadOnly with normalization
        setIsReadOnly(val) {
            this.isReadOnly = this.normalizeBoolean(val);
        },

        /**
         * Pro lock state for the open calendar. A locked calendar this tab may not change is
         * shown exactly like a view link (the existing read-only mode), so every editing control
         * that already hides for view links hides here too. An editor key or the owner's
         * sign-in lifts it again.
         */
        applyLockState(s) {
            if (!s || (this.calendar && s.id && s.id !== this.calendar.id)) return;
            this.lock = { locked: !!s.locked, pro: !!s.pro, paused: !!s.paused, canEdit: s.canEdit !== false, proSettings: s.proSettings || null };
            this.lockKnown = true;
            if (this.lock.locked || this.lock.paused) this.proUpsell = false;
            else this.$nextTick(() => this.maybeShowProUpsell());
            const out = (this.lock.locked || this.lock.paused) && !this.lock.canEdit;
            if (out !== this.lockedOut) {
                this.lockedOut = out;
                this.setIsReadOnly(out || this.viewRoute);
                if (out) this.editTitle = false;
                try {
                    if (out && this.calView && this.calView.kind === 'native') this.calView.closePopups();
                    if (window.scheduleObj) {
                        if (out && typeof scheduleObj.closeEditor === 'function') scheduleObj.closeEditor();
                        if (out && typeof scheduleObj.closeQuickInfoPopup === 'function') scheduleObj.closeQuickInfoPopup();
                        scheduleObj.readonly = this.isReadOnly;
                    }
                } catch (e) { /* the grid catches up on its next render */ }
            }
            if (s.reason === 'key-rotated') this.showToast(PRO_MESSAGES.keyReset, 'info', { duration: 10000 });
        },

        /** Quick add from a menu: on a calendar this tab can't change, say why instead of opening it. */
        openQuickAdd() {
            if (!this.canEdit) {
                this.showToast(this.lockedOut ? this.lockedOutMessage : 'This is a view-only link. You can’t add or change events.', 'info');
                return;
            }
            this.$refs.quickAddDialog && this.$refs.quickAddDialog.showDialog();
        },

        // ---- Pro stats and history (ProInsight.js) -------------------------------------------
        /** Open Stats or History. The dialogs ask the server, which answers only the owner. */
        openInsight(view, where) {
            this.insightWhere = where || 'share_panel';
            this.trialFeatureUsed(view === 'history' ? 'history' : 'stats_pro');
            this.closeAllPanels();
            this.showProHistory = view === 'history';
            this.showProStats = view !== 'history';
        },
        /** The logo menu's "Stats" beside a Pro calendar: here, or on that calendar's page. */
        openStatsFor(id) {
            this.showRecents = false;
            if (this.calendar && String(this.calendar.id).toLowerCase() === String(id).toLowerCase()) {
                this.openInsight('stats', 'logo_menu');
                return;
            }
            ProInsightIntent.set(id, 'stats');
            window.location.href = CalendarPath.of(id);
        },
        /** Has this calendar had its one free trial? Only so the Go Pro card doesn't offer one it can't have. */
        async refreshProTrial() {
            const id = this.calendar && this.calendar.id;
            if (!id) return;
            try {
                const res = await fetch('/api/pro/status?calendar=' + encodeURIComponent(id), { credentials: 'same-origin' });
                const data = res.ok ? await res.json() : null;
                if (this.calendar && this.calendar.id === id) {
                    this.proTrialUsed = !!(data && data.trialUsed);
                    this.proUnlimited = !!(data && data.unlimited);
                    this.proUnlimitedFull = !!(data && data.unlimitedFull);    // its 5 are used: this one goes under @name
                    this.proHandle = (data && data.handle) || '';
                }
            } catch (e) { /* offline: offer it; the server decides */ }
        },
        /** During a trial: the first use of a Pro feature per calendar per day (Pro.js trialFeature). */
        trialFeatureUsed(feature) {
            if (this.proTrialActive && this.calendar && typeof trialFeature === 'function') trialFeature(this.calendar.id, feature);
        },
        async refreshProOwner() {
            const id = this.calendar && this.calendar.id;
            if (!id) return;
            try {
                const res = await fetch('/api/pro/status?calendar=' + encodeURIComponent(id), { credentials: 'same-origin' });
                const data = res.ok ? await res.json() : null;
                if (this.calendar && this.calendar.id === id) {
                    this.proOwner = !!(data && data.isOwner);
                    this.proPlan = (data && data.plan) || null;
                    this.onProNames(data);
                    this.editorLinkStored = data && data.isOwner ? this.storedEditorLink() : '';
                    this.proTrialActive = !!(data && data.isOwner && data.trial);
                    this.trialFeatureUsed('lock');          // the owner on their locked calendar: the lock in use
                }
            } catch (e) { /* offline: leave it as it was */ }
            this.proOwnerChecked = true;
        },
        /** A restore landed. The room has already sent every open tab (this one too) the restored calendar. */
        onVersionRestored({ label, unchanged }) {
            this.showProHistory = false;      // back to the calendar, which now shows the restored version
            if (unchanged) {
                this.showToast('That version matches the calendar now. Nothing changed.', 'info');
                return;
            }
            // This tab's own undo stack holds edits to the calendar as it was; replaying one now
            // would edit the restored version instead. The restore's undo is the version saved before it.
            if (this._eventStore && Array.isArray(this._eventStore.undoStack)) this._eventStore.undoStack.length = 0;
            this.trialFeatureUsed('restore');
            this.showToast(`Restored the version from ${label}`, 'success');
            this.loadUndoEntries();
        },
        /**
         * The Plus tab: what an upgrade adds (trial, checkout, or the beta list), or the owner's plan,
         * editor links and billing. Every "Upgrade" and "Join the beta" in the app opens it.
         * surface: where it was opened from, for trial_started / pro_beta_joined ('share' | 'stats' | 'lock').
         * join: billing off and they pressed "Join the beta": open on the email field.
         */
        openPlusTab(surface, { join = false } = {}) {
            this.closeAllPanels();
            this.proSurface = surface === 'stats' || surface === 'lock' ? surface : 'share';
            this.plusAutoJoin = !!join;
            this.showPlus = true;
        },
        /** Activity's line for a free calendar's creator. */
        openProOffer() { this.openPlusTab('share'); },
        /** Someone other than its creator upgraded this calendar lately: may this browser undo it? Only the
         *  server knows (it checks this browser's author uid), so ask; the notice shows only on a yes. */
        async checkUpgradeNotice(retried = false) {
            const id = this.calendar && this.calendar.id;
            this.upgradeNotice = null;
            if (!id || !this.lock.locked || typeof proAuthor !== 'function') return;
            // The author uid comes from an anonymous sign-in that may still be on its way: look once more shortly.
            if (!proAuthor()) { if (!retried) setTimeout(() => this.checkUpgradeNotice(true), 4000); return; }
            try {
                const r = await fetch('/api/pro/upgrade-notice', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ calendarId: id, author: proAuthor() }) });
                const d = r.ok ? await r.json() : null;
                if (d && d.notice && this.calendar && this.calendar.id === id && this.lock.locked) {
                    this.upgradeNotice = { day: new Date(d.notice.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), busy: false };
                }
            } catch (e) { /* offline: no notice */ }
        },
        async undoUpgrade() {
            if (!this.upgradeNotice || !window.confirm('Undo this upgrade? The calendar goes back to a free calendar anyone with the link can edit, and any payment is refunded.')) return;
            this.upgradeNotice.busy = true;
            let r = null;
            try {
                r = await fetch('/api/pro/undo-upgrade', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ calendarId: this.calendar.id, author: await proAuthorReady() }) });
            } catch (e) { /* offline */ }
            const d = r ? await r.json().catch(() => ({})) : {};
            if (r && r.ok) { this.upgradeNotice = null; this.showToast('Upgrade undone. Anyone with the link can edit again.', 'success'); return; }
            if (this.upgradeNotice) this.upgradeNotice.busy = false;
            this.showToast(d.message || (r ? 'That didn’t work. Write to support@pastecal.com and we’ll sort it out.' : 'We couldn’t reach pastecal. Check your connection and try again.'), 'error');
            if (r && r.status === 410) this.upgradeNotice = null;
        },
        /** A plan id's display name (Pro.js planName), for templates: 'pro' is Plus, 'unlimited' is Pro. */
        planName(plan) { return planName(plan); },
        focusInsight(open, ref) {
            if (open) {
                this._insightOpener = this._insightOpener || document.activeElement;
                this.$nextTick(() => { const el = this.$refs[ref]; if (el) el.focus(); });
            } else if (!this.showProStats && !this.showProHistory && !this.sideTab) {
                const opener = this._insightOpener;
                this._insightOpener = null;
                if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
            }
        },

        showToast(message, type = 'info', options = {}) {
            this.$refs.toast.display(message, type, options);
        },

        /** Open the change history, refreshing it first so the list is never stale. */
        async openRecentChanges() {
            if (this.isExisting) await this.loadUndoEntries();   // a draft has no history yet
            if (!this.showRecentChanges) this.closeAllPanels();
            this.showRecentChanges = true;
        },

        /**
         * Offer to undo a deletion at the moment it happens -- the pattern Drive, Gmail and
         * Notion all use, and the one place a person is guaranteed to be looking. The undo is
         * the store's inverse command: it puts back exactly the rows that went, with their
         * ids, and leaves every other event as it is now (the old snapshot restore could
         * revert someone else's edit made in between).
         */
        // The tour's "Start your calendar": back up to the calendar, whose first-event hint says what to do.
        startFromTour() {
            track(a => a.featureUsed('tour_start'));
            window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        },

        offerUndo(message) {
            this.showToast(message, 'info', {
                actionLabel: 'Undo',
                action: () => this.undoLastLocal(),
            });
        },

        /**
         * Undo this tab's own last action through the store (exactly the rows it touched).
         * The server logs the undo as a change of its own, so it is remembered here too:
         * otherwise the /history fallback of the next Cmd+Z would offer to undo the undo.
         */
        undoLastLocal({ quiet = false } = {}) {
            const before = this.calendar.events.map(e => new Event(e));
            const stack = this.store().undoStack;
            const tpl = this._templateUndo && this._templateUndo[this._templateUndo.length - 1];
            const templateChange = !!tpl && tpl.entry === stack[stack.length - 1];
            const undone = this.store().undo();
            // Undoing "Started from ..." also puts back the title, notes and labels from before it;
            // undoing "Started over" puts back the whole draft (startOver).
            if (undone && templateChange) {
                const t = this._templateUndo.pop();
                if (t.restore) t.restore();
                else this.setTemplate(t.state);
            }
            if (!undone) return null;
            this._handledUndo.push({ at: this.serverNow(), delta: this.deltaBetween(before, this.calendar.events) });
            // The native edit link's card follows the event back (EventCard), and says only "Undone" (no button).
            if (this.nativeEdit) this.nativeAfterUndo();
            if (!quiet && !this.nativeEdit) this.showToast(`Undid: ${undone}`, 'success');
            return undone;
        },

        /**
         * Undo the most recent change, for Cmd/Ctrl+Z.
         *
         * (The keydown handler tries this tab's own EventStore stack first -- the server's
         * /history entry for something done a moment ago may not exist yet, and reading it
         * then undid an OLDER change.) This is the fallback, reached only when there is
         * nothing local left; it reads /history -- which still works after a
         * reload -- skipping what this session already undid, the entries its own undos
         * produced (otherwise a second Cmd+Z re-deletes what the first restored), and
         * entries with nothing left to undo.
         *
         * The fallback only takes entries THIS browser wrote. Cmd+Z reverting a
         * collaborator's change is a surprise nobody asked for, and two browsers pressing
         * it at once would race over the same entry. Entries with no recorded writer
         * predate the field and cannot be claimed; Recent changes still restores them.
         */
        async undoLastChange() {
            if (this._undoBusy) return;
            this._undoBusy = true;
            try {
                if (!this.isExisting) {
                    this.showToast('Nothing to undo', 'info');
                    return;
                }
                const rows = await this.loadUndoEntries();
                const me = CalendarDataService.writerId;
                for (const row of rows) {
                    const parts = row.parts.filter(p => p.writer && p.writer === me
                        && !this.isHandledHistory(p));
                    if (!parts.length) continue;
                    const plan = this.planUndo(parts.map(p => p.delta));
                    if (plan.noop) continue;
                    this.commitUndo(plan);
                    parts.forEach(p => this._undoneHistoryKeys.add(p.key));
                    this.showToast(this.describeUndo(plan), 'success');
                    return;
                }
                this.showToast('Nothing to undo', 'info');
            } finally {
                this._undoBusy = false;
            }
        },
    }
};

const vueApp = Vue.createApp(CalendarVueApp);
// Vue catches errors in components itself, so they never reach window.onerror: report them the
// same way (and let a stale page reload) while still logging them as Vue would.
vueApp.config.errorHandler = (err, instance, info) => {
    console.error(err);
    try { window.pcReportError && window.pcReportError(err, `vue:${info}`); } catch (e) { /* never the failure */ }
};
// The native calendar's icons, used inside its own templates (a native view link only).
if (typeof NcIcon !== 'undefined') vueApp.component('nc-icon', NcIcon);
const app = vueApp
    .component('quick-add-button', QuickAddButton)
    .component('quick-add-dialog', QuickAddDialog)
    .component('welcome-dock', WelcomeDock)
    .mount('#app');

// Signal to tests that the app has mounted
try {
    document.dispatchEvent(new CustomEvent('app:mounted'));
    window.__appMounted = true;
} catch (e) {
    console.warn('[app] unable to dispatch app:mounted', e);
}

// Sanity guard: verify canEdit exists and matches the inverse of isReadOnly after mount
setTimeout(() => {
    try {
        if (typeof app.canEdit === 'undefined') {
            console.warn('[sanity] app.canEdit is undefined — computed block may be overwritten');
        } else if (app.canEdit !== !Boolean(app.isReadOnly)) {
            console.warn('[sanity] canEdit mismatch', { isReadOnly: app.isReadOnly, canEdit: app.canEdit });
        }
    } catch (e) {
        console.warn('[sanity] error checking app computed properties', e);
    }
}, 250);

// ============================================================
// COMPONENT REGISTRATION VALIDATOR
// ============================================================
// This function validates that all components used in templates are registered
// It will log warnings for any unregistered components found in the DOM
// ============================================================
function validateComponentRegistration() {
    const registeredComponents = Object.keys(COMPONENT_REGISTRY); // registry now includes quick-add-button & quick-add-dialog
    const allElements = document.querySelectorAll('*');
    const customElements = new Set();

    allElements.forEach(el => {
        const tagName = el.tagName.toLowerCase();
        // Check if it's a custom element (contains hyphen and not a standard HTML tag)
        if (tagName.includes('-') && !tagName.startsWith('x-')) {
            customElements.add(tagName);
        }


    });

    const unregistered = Array.from(customElements).filter(
        tag => !registeredComponents.includes(tag)
    );

    if (unregistered.length > 0) {
        console.error('⚠️  UNREGISTERED COMPONENTS DETECTED:');
        console.error('The following components are used in templates but not registered:');
        unregistered.forEach(tag => {
            console.error(`  - <${tag}> (empty/not rendering)`);
        });
        console.error('\nTo fix: Add these components to COMPONENT_REGISTRY in index.html');
    } else {
        console.log('✅ All components properly registered');
    }
}

// Run validation after a short delay to allow Vue to mount
setTimeout(validateComponentRegistration, 1000);
