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

    window.addEventListener('error', (e) => {
        const where = e.filename
            ? `${String(e.filename).split('/').pop()}:${e.lineno || 0}`
            : 'unknown';
        report('error', (e.error && e.error.message) || e.message, where);
    });

    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        report('unhandledrejection', (r && (r.message || r.code)) || String(r), 'promise');
    });
})();

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
    'close-icon': CloseIcon                    // Close icon SVG
};

const CAL_BASE = (typeof window !== 'undefined' && window.CAL_BASE) ? window.CAL_BASE : '/';
const stripBase = (path) => {
    const base = CAL_BASE.endsWith('/') ? CAL_BASE.slice(0, -1) : CAL_BASE;
    if (base && base !== '/' && path.startsWith(base)) {
        const stripped = path.slice(base.length);
        return stripped.startsWith('/') ? stripped : `/${stripped}`;
    }
    return path;
};

const CalendarVueApp = {
    components: COMPONENT_REGISTRY,
    directives: {
        'click-outside': clickOutside
    },
    data() {
        const normalizedPathParts = (() => {
            const path = stripBase(window.location.pathname);
            return path.split('/').filter(Boolean);
        })();

        let urlslug = normalizedPathParts[0];

        if (urlslug && urlslug.match(/^[a-zA-Z0-9_\-]+$/) && urlslug.length < 40) {
            // slug is ok, normalize for consistent lookup
            urlslug = SlugManager.normalizeSlug(urlslug);
        } else {
            // should redirect back to homepage if we have a bad url;
            urlslug = null;
        }

        let id = urlslug ?? Utils.randomID(8);
        let cal = new Calendar(id, "New Calendar", []);

        // Define default colors
        const DEFAULT_COLORS = [
            "#3f51b5", "#e3165b", "#ff6652", "#4caf50",
            "#ff9800", "#03a9f4", "#9e9e9e", "#27282f"
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
            showShare: false,
            showSearch: false,
            showSettings: false,
            undoEntries: [],   // changes this calendar can undo (read from /history)
            showRecentChanges: false,   // the recent-changes dialog
            // When this browser last opened THIS calendar, captured before the visit is
            // recorded and so still pointing at the previous visit. It is what makes the
            // changes list answer "what happened while I was away" rather than only
            // "what can I undo". Null on a first visit, where nothing is "new".
            lastSeenAt: null,
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
            EXTRA_COLORS: EXTRA_COLORS,
            MAX_COLORS: MAX_COLORS,
            colorFilters: COLORS.map(() => true), // allow all color types by default
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
            readOnlySlugInput: '',

            // Rename
            newCalendarId: '',

            // Creation flow
            showClaimDialog: false,
            userHasEditedSlug: false,

            // Mobile Menu
            showMobileMenu: false,
        }
    },

    computed: {
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
            for (const entry of this.undoEntries) {   // already newest-first
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
            return this.undoEntries.filter(e => e.savedAt > this.lastSeenAt).length;
        },

        isAutogeneratedId() {
            const id = this.calendar?.id;
            if (!id) return false;
            // Check if ID is exactly 8 characters and contains only chars from the random alphabet (1-9, A-Z excluding I,O)
            // Regex: ^[1-9a-hj-np-z]+$  (case insensitive)
            return /^[1-9a-hj-np-z]{8}$/i.test(id);
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
                    ? `${n} ${named} ${n === 1 ? 'event is' : 'events are'} hidden.`
                    : `${n} ${n === 1 ? 'event is' : 'events are'} hidden by a filter.`;
            }
            return named
                ? `${named} events are hidden — none in this view.`
                : 'Some event types are hidden — none in this view.';
        },

        // Is any color switched off? Distinct from hiddenEventCount, which is 0 whenever
        // the current view happens to contain none of the hidden types. Now that filters
        // persist past closing the panel, that state is reachable by simply paging to
        // another week -- and a filter that is on while nothing says so is exactly the
        // condition behind #41. The banner keys off this, so it is shown for as long as
        // the filter is on, and reports the count only when it has one to report.
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

        // Homepage calendar (no slug and not an existing saved calendar)
        isHomepageCalendar() {
            return !this.urlslug && !this.isExisting;
        }
    },

    mounted() {
        // Load globalSettings from localStorage FIRST, before scheduleObj is constructed.
        // Syncfusion bakes some properties (e.g. timeFormat, firstDayOfWeek) into the initial
        // DOM render and doesn't reactively update them when set later — so settings must be
        // available for the pre-appendTo configuration block below, not just applied after.
        this.loadGlobalSettings();

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

                if (path?.startsWith('/view/')) {
                    // Read-only view mode
                    const requestedSlug = path.split('/')[2];
            // Ensure explicit boolean normalization when setting read-only mode
            this.setIsReadOnly(true);

            // Always use lookupCalendar for consistent case-insensitive handling
            (async () => {
                try {
                    console.log('Looking up calendar for /view/ route:', requestedSlug);
                    const result = await CalendarDataService.lookupCalendar(requestedSlug);

                    if (result.data.found && result.data.isReadOnly) {
                        // Found as read-only - subscribe with the actual slug
                        const actualSlug = result.data.actualSlug;
                        console.log('Found read-only calendar with slug:', actualSlug);

                        CalendarDataService.subscribe_readonly(actualSlug, (c) => {
                            this.applyRemoteCalendar(c);
                            this.ensureCalendarOptionsDefaults();
                            // Update custom view in schedule with calendar's settings
                            this.updateCustomViewInSchedule();
                            // Re-initialize local settings to load custom colors and labels
                            this.initializeLocalSettings();
                            // Add to recents when calendar loads, but mark as read-only
                            if (c.title) {
                                // A read-only calendar you were linked to is a visit,
                                // not something you created.
                                this.recentManager.add(actualSlug, `${c.title} (View Only)`);
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
                        alert('This calendar exists but is not shared for viewing. Ask the owner to create a read-only link.');
                    } else {
                        // Calendar doesn't exist at all
                        this.isLoading = false;
                        alert('Calendar not found. Please check the URL and try again.');
                    }
                } catch (error) {
                    console.error('Calendar lookup failed:', error);
                    this.isLoading = false;
                    alert('Failed to load calendar. Please try again later.');
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
                        this.recentManager.add(this.calendar.id, this.calendar.title);
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
            this.calendar.id = Utils.randomID(8);
            this.isLoading = false;

            // The claim bar is on screen with a generated name in it. This is the
            // denominator for the naming question: everyone who was offered a name
            // to change, whether or not they ever touch it.
            track(a => a.slugPromptShown('homepage_bar', this.calendar));
        }

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
        scheduleObj.timeFormat = this.globalSettings.timeFormat === '24' ? 'HH:mm' : 'hh:mm a';
        scheduleObj.firstDayOfWeek = parseInt(this.globalSettings.firstDayOfWeek) || 0;

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
            this.applyScheduleAction(args);
        };
        // The user's change is measured from the event as it was when they started (see
        // ScheduleAdapter.noteStart), so a field someone else changed meanwhile is kept.
        scheduleObj.dragStart = (args) => ScheduleAdapter.noteStart(args.data);
        scheduleObj.resizeStart = (args) => ScheduleAdapter.noteStart(args.data);

        // color events based on type
        scheduleObj.eventRendered = (args) => {
            // change color as needed
            categoryColor = app.COLORS[args.data.Type - 1] || app.COLORS[0];
            if (scheduleObj.currentView === 'Agenda') {
                args.element.firstChild.style.borderLeftColor = categoryColor;
            } else {
                args.element.style.backgroundColor = categoryColor;
            }
            ScheduleAdapter.showTitle(args.element, args.data);
        }

        // custom display for types
        scheduleObj.popupOpen = (args) => {
            if (args.type === 'QuickInfo' && args.data) ScheduleAdapter.showTitle(args.element, args.data);


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

            if (args.type === 'Editor') {
                ScheduleAdapter.noteStart(args.data);

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
                        innerHTML: `Customize labels in Settings`
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

        scheduleObj.appendTo('#Schedule');

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
            this.showToast(`${what} needs a start and end time — not saved`, 'error');
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
            this.showToast('Saving paused — reload the page to continue', 'error');
            track(a => a.jsError('sync_paused', `${writes} writes in a minute`, 'sync'));
        };
        CalendarDataService.onSyncFailed = () => {
            this.showToast('Could not save — check your connection', 'error');
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
        CalendarDataService.onSyncRefused = ({ before, removing, recovered, events, code, message }) => {
            if (code) {
                this.showToast(`Server refused update: ${message || code}`, 'error');
                track(a => a.syncRefused({ before, removing: 0, code, message }));
            } else {
                // The rows put back, not the net shrink: an addition in the same write offsets
                // the count without making the loss any smaller.
                const n = recovered ?? removing;
                this.showToast(`Recovered ${n} event${n === 1 ? '' : 's'} that were about to be lost`, 'error');
                track(a => a.syncRefused({ before, removing, code: 'undeclared_removal' }));
            }
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

            // If still no events after loading, create default sample event
            if (this.calendar.events.length == 0) {
                var defaultEvent = this.calendar.defaultEvent("Sample event");
                this.calendar.setEvents([defaultEvent]);
            }
            this.updateCalendarView();
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
            const dialogOpen = !!document.querySelector('.e-popup-open:not(.e-tooltip-wrap), .pc-modal, [aria-modal="true"]')
                || !!(this.$refs.quickAddDialog && this.$refs.quickAddDialog.dialogVisible)
                || this.showRecentChanges;
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
            if (this.showRecentChanges) { this.showRecentChanges = false; return; }
            if (this.showClaimDialog) { this.showClaimDialog = false; return; }
            if (this.showSettings) { this.showSettings = false; return; }
            if (this.showSearch) { this.showSearch = false; return; }
            if (this.showShare) { this.showShare = false; return; }
            if (this.showHelp) { this.showHelp = false; }
        };
        window.addEventListener('keydown', this._escapeHandler);
    },

    beforeUnmount() {
        this.unwatchLastEdited();
        window.removeEventListener('keydown', this._undoShortcutHandler);
        window.removeEventListener('keydown', this._quickAddShortcutHandler);
    },

    watch: {
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
        'globalSettings.darkMode': {
            handler() {
                this.applyTheme();
            },
            immediate: false, // mounted() already calls applyTheme on initial load
        },

        showShare(newValue) {
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
            if (!window.location.search.includes('view=') && !window.location.search.includes('v=')) {
                const defaultView = this.calendar?.options?.defaultView || this.globalSettings.defaultView || 'Month';
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

            if (this.globalSettings.darkMode === 'auto') {
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
            // same Syncfusion version as the JS.
            document.getElementById('syncfusion-theme').href = dark
                ? '/vendor/syncfusion-23.2.6/material-dark.css'
                : '/vendor/syncfusion-23.2.6/material.css';
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
        },

        resetToDefaults() {
            // Reset to a completely fresh calendar state
            this.calendar.id = Utils.randomID(8);
            this.calendar.title = "New Calendar";
            this.calendar.events = [];
            this.calendar.options = {
                notes: '',
                defaultView: 'week'
            };
            // Add one sample event
            var defaultEvent = this.calendar.defaultEvent("Sample event");
            this.calendar.setEvents([defaultEvent]);
            // Reset local settings to defaults
            this.initializeLocalSettings();
        },

        loadLocalStorage() {
            var c = JSON.parse(localStorage.getItem("calendar"));
            if (c) {
                // Load ALL draft data from localStorage (ID, title, events, settings, colors, notes, etc.)
                this.calendar.import(c);
                // Re-initialize local settings to load custom colors and labels
                this.initializeLocalSettings();
            } else {
                // No localStorage data (fresh start after save, or first visit)
                this.resetToDefaults();
            }
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
            // Step 1: Ensure this.syncFusionEvents is up-to-date from the master store (this.calendar.events).
            // This creates a new array instance for this.syncFusionEvents if this.calendar.events has changed.
            this.syncFusionEvents = this.calendar.getSyncFusionEvents();

            // Step 2: Hand the scheduler only the events the color filter admits.
            //
            // This filters the array rather than passing a DataManager plus an ej.data.Query
            // predicate. The query built an allow-list of `Type == n` clauses, which is a
            // second, separate definition of "visible" alongside isEventVisible() -- and
            // every round of issue #41 was those two definitions disagreeing (first about
            // whether the search panel was open, then about types with no color slot, then
            // about how `type` is normalized). One predicate, used here and by
            // hiddenEventCount, makes that whole class of bug unrepresentable.
            scheduleObj.setProperties({
                eventSettings: {
                    dataSource: this.syncFusionEvents.filter(e => this.isEventVisible(e)),
                    query: new ej.data.Query()
                }
            });

            // Step 3: Re-bind the data to ensure the Scheduler reflects the changes.
            // While setProperties might sometimes trigger a refresh, explicitly calling dataBind is safer
            // when dataSource changes significantly.
            scheduleObj.dataBind();
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
                        console.warn('[store] command failed:', err.message, command);
                        track(a => a.jsError('command_failed', err.message, (command && command.label) || (command && command.type) || 'command'));
                        this.showToast(`Couldn't save that change: ${err.message.replace(/^\w+: /, '')}`, 'error');
                    },
                });
            }
            return this._eventStore;
        },

        /** A grid action (Syncfusion's add / change / remove, cancelled in actionBegin) -> the store. */
        applyScheduleAction(args) {
            const active = window.scheduleObj && window.scheduleObj.activeEventData && window.scheduleObj.activeEventData.event;
            let command;
            try {
                const ui = (window.scheduleObj && window.scheduleObj.uiStateValues) || {};
                command = ScheduleAdapter.toCommand(args, this.store(), {
                    action: window.scheduleObj && window.scheduleObj.currentAction,
                    occurrenceStart: active && active.StartTime,
                    keepOccurrences: !!ui.isIgnoreOccurrence,
                });
                // Syncfusion clears this flag in the step we cancel; clear it so a "No" here
                // cannot leak into the next series edit.
                ui.isIgnoreOccurrence = false;
            } catch (err) {
                // An action the adapter cannot map safely: nothing is saved, the person is
                // told, and it is logged with the action name (command_failed).
                this.store().onError(err, { type: 'schedule', label: `${args.requestType}/${window.scheduleObj && window.scheduleObj.currentAction}` });
                return;
            }
            if (!command.commands.length) return;
            const deleting = args.requestType === 'eventRemove';
            const subject = (r) => r && r.Subject ? `"${String(r.Subject).trim()}"` : 'event';
            const records = [...(args.deletedRecords || []), ...(args.changedRecords || [])];
            const label = !deleting ? (args.requestType === 'eventCreate' ? 'Added event' : `Edited ${subject(records[0] || (args.addedRecords || [])[0])}`)
                : (args.deletedRecords || []).length > 1 && !(args.deletedRecords || []).some(r => r.RecurrenceRule) ? `Deleted ${args.deletedRecords.length} events`
                : (args.deletedRecords || []).length ? `Deleted ${subject(args.deletedRecords[0])}`
                : `Deleted one ${subject(records[0])}`;
            const r = this.store().dispatch(command, { label });
            if (!r.ok) return;
            // A real, user-initiated change to this calendar (sync() also runs for other
            // people's edits echoing back, so it cannot be recorded there).
            if (this.isExisting && typeof AuthorSignal !== 'undefined') AuthorSignal.touch(this.calendar.id);
            if (args.requestType === 'eventCreate') track(a => a.eventAdded('grid', this.calendar));
            if (deleting) this.offerUndo(label);
        },

        // ============================================================
        // REGION: Calendar CRUD Operations
        // ============================================================

        create() {
            // If user hasn't manually edited the slug, show intervention dialog
            if (!this.userHasEditedSlug) {
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
            let slug = this.calendar.id;
            if (!slug) {
                slug = Utils.randomID(8);
                this.calendar.id = slug;
            }

            // normalize
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
                // Revert to alert for this validation as per user request
                alert("This URL is already taken. Please choose another.");
            }, () => {
                // does not exist, proceed
                this.isLoading = true;
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
                    // success - clear localStorage so homepage starts fresh next time
                    this.clearLocalStorage();
                    // Record in recents here rather than relying on the post-redirect
                    // load to do it, so a calendar you just made is always in the list.
                    // Flagged `mine` so it's stored durably and never evicted by the
                    // recents cap — this list is the only way back without a login.
                    this.recentManager.add(slug, this.calendar.title, true);
                    this.recentCalendars = this.recentManager.getAll();
                    this.showToast('Calendar created!', 'success');
                    window.location.href = "/" + slug;
                });
            });
        },

        handleSlugInput() {
            this.userHasEditedSlug = true;
        },

        randomizeId() {
            this.calendar.id = Utils.randomID(8);
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
                alert("Invalid name. Use letters, numbers, dashes, and underscores.");
                return;
            }

            // Check if current name is same as new name
            if (newId.toLowerCase() === this.calendar.id.toLowerCase()) {
                alert("New name must be different from current name.");
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

                        window.location = "/" + newId;
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
            if (this.calendar?.options?.typeLabels?.length > 0) {
                return Array(this.COLORS.length).fill().map((_, i) => {
                    let id = i + 1;
                    let title = this.calendar.options.typeLabels[i] || `Type ${id}`;
                    return { text: title, value: id, iconCss: `e-color-${id}` };
                });
            }

            // Fallback to default labels if no custom labels are found
            return Array(this.COLORS.length).fill().map((_, i) => {
                let id = i + 1;
                return { text: `Type ${id}`, value: id, iconCss: `e-color-${id}` };
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
        typeLabelFor(index) {
            const custom = this.calendar?.options?.typeLabels;
            const label = custom && custom[index];
            if (label && !/^Type \d+$/.test(label)) return label;
            return this.colorNameFor(index);
        },

        // Nearest plain-English name for a palette color, so a dot has a spoken label
        // even when its type was never given one.
        colorNameFor(index) {
            const hex = (this.COLORS[index] || '').replace('#', '');
            if (hex.length !== 6) return `Type ${index + 1}`;
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max - min < 30) return max > 160 ? 'Light gray' : (max < 80 ? 'Black' : 'Gray');

            let hue;
            const d = max - min;
            if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
            else if (max === g) hue = ((b - r) / d + 2) * 60;
            else hue = ((r - g) / d + 4) * 60;

            const names = [
                [15, 'Red'], [45, 'Orange'], [70, 'Yellow'], [160, 'Green'],
                [200, 'Teal'], [250, 'Blue'], [290, 'Purple'], [340, 'Pink'], [360, 'Red'],
            ];
            return (names.find(([limit]) => hue <= limit) || [0, 'Red'])[1];
        },

        updateCurrentViewURL() {
            const currentView = scheduleObj.currentView;
            const currentDate = scheduleObj.selectedDate.toISOString().slice(0, 10);

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

            const baseURL = SlugManager.getViewerBaseURL(this.calendar, this.isReadOnly);
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
            return `${window.location.origin}/${this.calendar.id}`;
        },

        getEditableICSURL() {
            if (this.isReadOnly) return null;
            return `${window.location.origin}/${this.calendar.id}.ics`;
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
            return this.getReadOnlyICSURL() || this.getEditableICSURL();
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
                + '&name=' + encodeURIComponent(this.calendar.title || 'PasteCal');
        },

        /** Records which subscribe path was used, so the rate is measurable. */
        trackSubscribe(method) {
            track(a => a.calendarShared(method));
        },

        createReadOnlyLink() {
            // Use SlugManager for centralized read-only link operations
            return SlugManager.createReadOnlyLink(this.calendar);
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

        getReadOnlyURL() {
            // Use SlugManager for centralized read-only link operations
            return SlugManager.getReadOnlyURL(this.calendar);
        },

        getReadOnlyNotes() {
            let notes = this.calendar.options?.notes || '';

            // Escape HTML special characters
            notes = notes.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");

            // Convert URLs to hyperlinks safely
            // Match URLs starting with http://, https://, or ftp://
            notes = notes.replace(/(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig,
                '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

            // Match URLs starting with "www." not preceded by '://'
            notes = notes.replace(/(^|\s)(www\.[\S]+(\b|$))/ig,
                '$1<a href="http://$2" target="_blank" rel="noopener noreferrer">$2</a>');

            // Convert line breaks to <br> tags
            notes = notes.replace(/\n/g, "<br>");

            return notes;
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
                this.searchResults = this.calendar.events.filter(event =>
                    event.title.toLowerCase().includes(this.searchQuery.toLowerCase())
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
            if (typeof scheduleObj === 'undefined' || !scheduleObj) return null;
            const dates = typeof scheduleObj.getCurrentViewDates === 'function'
                ? scheduleObj.getCurrentViewDates() : null;
            if (!dates || !dates.length) return null;
            const first = new Date(dates[0]).getTime();
            const last = new Date(dates[dates.length - 1]).getTime();
            if (isNaN(first) || isNaN(last)) return null;
            return { start: first, end: last + 86400000 }; // through the end of the last day
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
            // being counted. Expand the rule in isolation instead.
            // An all-day series is expanded from the same values the grid is given
            // (Calendar.getSyncFusionEvents): start, UNTIL and EXDATEs at the viewer's
            // local midnight of their stored dates.
            const allDay = !!event.isAllDay;
            const ms = (v) => {
                const d = allDay ? Event.allDayToLocal(v) : new Date(v);
                return d ? d.getTime() : NaN;
            };
            const start = ms(event.start);
            if (isNaN(start)) return true;
            const end = ms(event.end);
            const duration = isNaN(end) ? 0 : Math.max(0, end - start);
            const rule = String((allDay ? Event.allDayRuleToLocal(event.recurrencerule) : event.recurrencerule) || '');
            const exceptions = (allDay ? Event.allDayExceptionsToLocal(event.recurrenceException)
                : event.recurrenceException) || null;

            try {
                if (typeof ej.schedule.generate === 'function') {
                    // Same call the scheduler makes when it renders a view: begin one event
                    // length before the window, so an occurrence spilling in from the day
                    // before is caught, and cap the walk at the window's length in days.
                    const viewDate = new Date(range.start - duration);
                    const days = Math.ceil((range.end - viewDate.getTime()) / 864e5) + 1;
                    const firstDay = parseInt(this.globalSettings?.firstDayOfWeek) || 0;
                    const dates = ej.schedule.generate(new Date(start), rule,
                        exceptions, firstDay, days, viewDate);
                    return dates.some(d => this.spansRange(d, d + duration, range));
                }
            } catch (err) {
                // Fall through to the estimate: over-reporting is safer than not counting.
            }

            try {
                const until = /UNTIL=([0-9TZ]+)/.exec(rule);
                if (until) {
                    const u = ej.schedule.getDateFromRecurrenceDateString(until[1]);
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


        jumpToEvent(event) {
            let startDate = new Date(event.start);
            scheduleObj.selectedDate = startDate;
            scheduleObj.currentView = 'Week';
        },

        toggleRecents() {
            this.showRecents = !this.showRecents;
        },

        closeRecents() {
            this.showRecents = false;
        },

        handleDropdownMouseEnter() {
            // Only handle hover on non-touch devices
            if (!('ontouchstart' in window)) {
                clearTimeout(this.hoverTimeout);
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

        // ============================================================
        // REGION: UI State Management (Panels & Toggles)
        // ============================================================

        isPanelOpen() {
            return this.showNotes || this.showSearch || this.showHelp || this.showShare || this.showSettings;
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
        copyShareLink() {
            const readOnly = this.getReadOnlyURL();
            const url = readOnly || this.getEditableURL();
            if (!url) return;

            const settle = () => {
                // The view-only link is minted asynchronously and can be missing or still
                // pending; the fallback grants full edit access, so say so rather than
                // giving the same "copied" as the safe link.
                if (!readOnly) this.showToast('Copied the edit link: anyone with it can change this calendar', 'info');
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
                    if (!this.legacyCopy(url)) this.showToast('Could not copy the link', 'error');
                    else settle();
                });
            } else if (this.legacyCopy(url)) {
                settle();
            } else {
                this.showToast('Could not copy the link', 'error');
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
                navigator.share({
                    title: 'PasteCal Calendar',
                    text: title,
                    url: url
                }).catch(err => {
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
                if (!rows.length && typeof firebase !== 'undefined' && firebase.database) {
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

                this.undoEntries = this.collapseSessions(detailed).slice(0, 10);
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
            const norm = (v) => (v === undefined || v === null || v === '') ? null : v;
            const when = (v) => Event.toISOStringOrNull(v);
            return norm(a.title) === norm(b.title)
                && when(a.start) === when(b.start) && when(a.end) === when(b.end)
                && norm(a.description) === norm(b.description)
                && String(a.type ?? 1) === String(b.type ?? 1)
                && !!a.isAllDay === !!b.isAllDay
                && norm(a.recurrencerule) === norm(b.recurrencerule)
                && norm(a.recurrenceException) === norm(b.recurrenceException);
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
            return ad === 1 ? '1 event added' : `${ad} events added`;
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
            const settings = JSON.parse(localStorage.getItem('pastecal_global_settings'));
            if (settings) {
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

        saveGlobalSettings() {
            try {
                localStorage.setItem('pastecal_global_settings', JSON.stringify(this.globalSettings));
                track(a => a.featureUsed('settings'));
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
                const timeFormat = this.globalSettings.timeFormat === '24' ? 'HH:mm' : 'hh:mm a';
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
                    scheduleObj.timeFormat = this.globalSettings.timeFormat === '24' ? 'HH:mm' : 'hh:mm a';
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
                // Update local settings with stored colors
                this.localSettings.colors = [...this.calendar.options.colors];

                // Update the component COLORS array
                this.COLORS = [...this.calendar.options.colors];

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
        copyToClipboard(textToCopy, buttonElement, method) {
            if (!textToCopy) {
                this.showToast('Nothing to copy', 'error');
                return;
            }

            if (method) track(a => a.calendarShared(method));

            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalContent = buttonElement.innerHTML;
                const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 text-green-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>`;
                buttonElement.innerHTML = `${checkIcon} Copied!`;
                buttonElement.classList.remove('bg-blue-500', 'hover:bg-blue-600');
                buttonElement.classList.add('bg-green-500');

                setTimeout(() => {
                    buttonElement.innerHTML = originalContent;
                    buttonElement.classList.remove('bg-green-500');
                    buttonElement.classList.add('bg-blue-500', 'hover:bg-blue-600');
                }, 1500); // Revert after 1.5 seconds

            }).catch(err => {
                console.error('Failed to copy: ', err);
                this.showToast('Failed to copy link', 'error');
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

        showToast(message, type = 'info', options = {}) {
            this.$refs.toast.display(message, type, options);
        },

        /** Open the change history, refreshing it first so the list is never stale. */
        async openRecentChanges() {
            await this.loadUndoEntries();
            this.showRecentChanges = true;
        },

        /**
         * Offer to undo a deletion at the moment it happens -- the pattern Drive, Gmail and
         * Notion all use, and the one place a person is guaranteed to be looking. The undo is
         * the store's inverse command: it puts back exactly the rows that went, with their
         * ids, and leaves every other event as it is now (the old snapshot restore could
         * revert someone else's edit made in between).
         */
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
        undoLastLocal() {
            const before = this.calendar.events.map(e => new Event(e));
            const undone = this.store().undo();
            if (!undone) return null;
            this._handledUndo.push({ at: this.serverNow(), delta: this.deltaBetween(before, this.calendar.events) });
            this.showToast(`Undid: ${undone}`, 'success');
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

const app = Vue.createApp(CalendarVueApp)
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
