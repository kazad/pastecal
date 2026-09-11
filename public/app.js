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
            colorFilters: COLORS.map(() => true), // allow all color types by default
            // Bumped on every scheduler dataBound so hiddenEventCount, which reads the
            // visible date range off scheduleObj, recomputes when the view moves.
            viewTick: 0,

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
        // How many events the colour filter is hiding from the view on screen. Surfaced
        // next to the dots because a switched-off colour is otherwise signalled only by a
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
        // filtered both what happened and what to look for, which "a colour filter is on"
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

        // Does this series actually put an occurrence inside the window? The stored start
        // only says when the series began, so COUNT/UNTIL have to be honoured -- a weekly
        // standup that finished last year starts before every future window but belongs in
        // none of them. Syncfusion's own expansion is the authority; if it is unavailable
        // we fall back to the old "starts before the window" guess, which over-reports
        // rather than hiding something.
        recurrenceOccursInRange(event, range) {
            // The live scheduler cannot answer this: hidden events are filtered out of its
            // dataSource, so it would report "no occurrences" for precisely the events
            // being counted. Expand the rule in isolation instead.
            const start = new Date(event.start).getTime();
            if (isNaN(start)) return true;

            try {
                const rule = String(event.recurrencerule || '');
                const until = /UNTIL=([0-9TZ]+)/.exec(rule);
                if (until) {
                    const u = ej.schedule.getDateFromRecurrenceDateString(until[1]);
                    if (u && !isNaN(u.getTime()) && u.getTime() < range.start) return false;
                }
                const count = /COUNT=(\d+)/.exec(rule);
                if (count) {
                    // Walk the rule's own interval forward COUNT times and see whether the
                    // last occurrence lands before the window opens.
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

        // Is any colour switched off? Distinct from hiddenEventCount, which is 0 whenever
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
                const start = new Date(e.start).getTime();
                if (isNaN(start)) return true; // undateable: count it rather than hide the fact
                // A recurring event is one stored record but many occurrences, so the
                // stored start says only when the series began. Ask the scheduler which
                // occurrences actually fall in the window instead of guessing: a series
                // that finished last year starts before the window but puts nothing in it,
                // and counting it produced a banner reporting a hidden event the user
                // could never find.
                if (e.recurrencerule) return this.recurrenceOccursInRange(e, range);
                const end = new Date(e.end).getTime();
                return start < range.end && (isNaN(end) ? start : end) >= range.start;
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
                    const lookupCalendar = firebase.functions().httpsCallable('lookupCalendar');
                    const result = await lookupCalendar({ slug: requestedSlug });

                    if (result.data.found && result.data.isReadOnly) {
                        // Found as read-only - subscribe with the actual slug
                        const actualSlug = result.data.actualSlug;
                        console.log('Found read-only calendar with slug:', actualSlug);

                        CalendarDataService.subscribe_readonly(actualSlug, (c) => {
                            this.calendar.import(c);
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
                    this.calendar.import(c);
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
        scheduleObj.actionComplete = (ev) => {
            switch (ev.requestType) {
                case 'eventChanged':
                case 'eventCreated':
                case 'eventRemoved':
                    console.log("[app] actionComplete()", "event", ev);
                    console.log(` - syncFusionEvents ${this.syncFusionEvents.length}`, this.syncFusionEvents);
                    console.log(` - eventsData ${scheduleObj.eventsData.length}`, scheduleObj.eventsData);
                    this.calendar.setEvents(this.syncFusionEvents);
                    // A real, user-initiated change to this calendar. Recorded here
                    // rather than in CalendarDataService.sync(), because sync() also
                    // runs when the live subscription echoes back someone else's edit --
                    // which made every viewer look like an editor.
                    if (typeof AuthorSignal !== 'undefined') {
                        AuthorSignal.touch(this.calendar.id);
                    }
                    if (ev.requestType === 'eventCreated') {
                        // Everything the scheduler itself creates: grid drag, the
                        // built-in editor, and the cell popup all land here.
                        track(a => a.eventAdded('grid', this.calendar));
                    }
                    break;
            }
            // console.log(ev);
        };

        // color events based on type
        scheduleObj.eventRendered = (args) => {
            // change color as needed
            categoryColor = app.COLORS[args.data.Type - 1] || app.COLORS[0];
            if (scheduleObj.currentView === 'Agenda') {
                args.element.firstChild.style.borderLeftColor = categoryColor;
            } else {
                args.element.style.backgroundColor = categoryColor;
            }
        }

        // custom display for types
        scheduleObj.popupOpen = (args) => {

            if (args.type === 'Editor') {
                // console.log("Editor call");

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
                    window.inputEle.setAttribute('value', id);

                    // Explicitly set the Type on the event data object
                    args.data.Type = parseInt(id);
                    // Whether people categorise events at all decides if type
                    // labels/colours are worth building on (see pro.md).
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
                            inputEle.value = type;
                            args.data.Type = type;
                            setColor(type);
                        },
                        open: () => {
                            app.dropdownOpen = true;
                            updateTooltipVisibility();
                        },
                        close: () => {
                            app.dropdownOpen = false;
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
        };

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
        this._quickAddShortcutHandler = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
                e.preventDefault();
                if (this.$refs && this.$refs.quickAddDialog && typeof this.$refs.quickAddDialog.showDialog === 'function') {
                    this.$refs.quickAddDialog.showDialog();
                }
            }
        };
        window.addEventListener('keydown', this._quickAddShortcutHandler);
    },

    watch: {
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

                if (!this.isExisting) {
                    this.saveLocalStorage();
                } else {
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
            document.getElementById('syncfusion-base-theme').href = dark
                ? 'https://cdn.syncfusion.com/ej2/ej2-base/styles/material-dark.css'
                : 'https://cdn.syncfusion.com/ej2/ej2-base/styles/material.css';
            document.getElementById('syncfusion-theme').href = dark
                ? 'https://cdn.syncfusion.com/ej2/material-dark.css'
                : 'https://cdn.syncfusion.com/ej2/material.css';
            document.getElementById('syncfusion-schedule-theme').href = dark
                ? 'https://cdn.syncfusion.com/ej2/ej2-schedule/styles/material-dark.css'
                : 'https://cdn.syncfusion.com/ej2/ej2-schedule/styles/material.css';
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

        updateCalendarView() {
            // Step 1: Ensure this.syncFusionEvents is up-to-date from the master store (this.calendar.events).
            // This creates a new array instance for this.syncFusionEvents if this.calendar.events has changed.
            this.syncFusionEvents = this.calendar.getSyncFusionEvents();

            // Step 2: Hand the scheduler only the events the colour filter admits.
            //
            // This filters the array rather than passing a DataManager plus an ej.data.Query
            // predicate. The query built an allow-list of `Type == n` clauses, which is a
            // second, separate definition of "visible" alongside isEventVisible() -- and
            // every round of issue #41 was those two definitions disagreeing (first about
            // whether the search panel was open, then about types with no colour slot, then
            // about how `type` is normalised). One predicate, used here and by
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
                    });
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

        // Human name for one colour slot, for the filter dots' labels. The dots are
        // otherwise distinguishable only by hue, which fails for colourblind users and for
        // the near-identical colours a custom palette can contain.
        //
        // Most calendars never rename their types, and the stored default labels are
        // literally "Type 1".."Type 8" -- a slot index with no referent, which read aloud
        // sounds like information while conveying none. Fall back to the dot's own colour
        // instead, which is at least something the user can see on screen.
        typeLabelFor(index) {
            const custom = this.calendar?.options?.typeLabels;
            const label = custom && custom[index];
            if (label && !/^Type \d+$/.test(label)) return label;
            return this.colorNameFor(index);
        },

        // Nearest plain-English name for a palette colour, so a dot has a spoken label
        // even when its type was never given one.
        colorNameFor(index) {
            const hex = (this.COLORS[index] || '').replace('#', '');
            if (hex.length !== 6) return `Type ${index + 1}`;
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max - min < 30) return max > 160 ? 'Light grey' : (max < 80 ? 'Black' : 'Grey');

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

        // Keep one filter flag per colour, preserving existing choices. Called whenever
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

        // The only definition of "visible". updateCalendarView() filters the grid with
        // this, and hiddenEventCount counts with it, so the two cannot disagree.
        isEventVisible(event) {
            return this.colorFilters[this.filterSlotFor(event)] === true;
        },

        // Which colour dot governs this event. Both paint paths (eventRendered and
        // getTypeColor) fall back to COLORS[0] for a type with no slot, so such an event
        // reads on screen as type 1 and follows the type 1 dot. Normalised with `|| 1`,
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

        // Closing the panel no longer clears the colour filter. It used to, because the
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
            const url = this.getReadOnlyURL() || this.getEditableURL();
            if (!url) return;

            const settle = () => {
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

            const newEvent = new Event({
                title: event.subject,
                start: start,
                end: end
            });
            this.calendar.events.push(newEvent);
            this.calendar.setEvents(this.calendar.events);
            // Quick-add bypasses the scheduler, so it needs its own signal.
            if (typeof AuthorSignal !== 'undefined') {
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
            }
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
                // Custom colours are a candidate paid feature (see pro.md's
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
                this.localSettings.colors[index] = this.DEFAULT_COLORS[index];
                this.COLORS[index] = this.DEFAULT_COLORS[index];

                this.storeColorsInCalendarOptions();
                this.updateColorCSS();
            }
        },

        resetAllColors() {
            this.localSettings.colors = [...this.DEFAULT_COLORS];
            this.COLORS = [...this.DEFAULT_COLORS];
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

                // One filter flag per colour. colorFilters is sized once at init from the
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

        showToast(message, type = 'info') {
            this.$refs.toast.display(message, type);
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
