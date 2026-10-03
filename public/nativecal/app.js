// CopyIcon and SettingsIcon already defined above, no need to redeclare

// ============================================================
// COMPONENT REGISTRY
// ============================================================
// IMPORTANT: All components used in templates must be registered here!
// If you add a new component, add it to this object.
// The key is the kebab-case name used in templates (e.g., <calendar-title>)
// The value is the component object defined above (e.g., CalendarTitle)
// ============================================================
const COMPONENT_REGISTRY = {
    'app-header': AppHeader,                 // The one header (all widths), driven by pageMode
    'claim-dialog': ClaimDialog,             // "Name your calendar"
    'share-panel': SharePanel,               // Every link to this calendar, safest first
    'calendar-title': CalendarTitle,           // Mobile & desktop title component
    'navigation-dropdown': NavigationDropdown, // Recent calendars dropdown
    'custom-tooltip': Tooltip,                 // Tooltip wrapper
    'toast-notification': ToastNotification,   // Toast messages
    'quick-add-button': QuickAddButton,        // Quick Add trigger component (button/FAB)
    'quick-add-dialog': QuickAddDialog,        // Quick Add dialog (parsing & create)
    'native-calendar': NativeCalendar,         // Native Calendar component
    'event-editor': EventEditor,               // Full event editor
    'event-popover': EventPopover,             // Quick info popover
    'quick-create-popover': QuickCreatePopover, // Quick create popover
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

/** @type {import('vue').ComponentOptions} */
const CalendarVueApp = {
    components: COMPONENT_REGISTRY,
    // Page mode, claim, rename and view-link problems: shared with the other app
    // (public/services/CalendarFlow.js). Methods defined here would override it.
    mixins: [CalendarFlow.mixin],
    directives: {
        'click-outside': clickOutside
    },
    data() {
        const normalizedPathParts = (() => {
            const path = stripBase(window.location.pathname);
            return path.split('/').filter(Boolean);
        })();

        let urlslug = normalizedPathParts[0];

        // SlugRules.isRoutable: any key that may exist, legacy mixed-case and long ones
        // included. This used to cap at 39 chars, so a 45-char name the database accepted
        // reloaded as the homepage. Whether a name may be CLAIMED is SlugRules.check.
        if (SlugRules.isRoutable(urlslug)) {
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
                darkMode: 'auto'
            },
            localSettings: {
                typeLabels: Array(COLORS.length).fill().map((_, i) => `Type ${i + 1}`),
                colors: [...DEFAULT_COLORS]
            },

            // Store COLORS as a component property for consistent reference
            COLORS: COLORS,
            DEFAULT_COLORS: DEFAULT_COLORS,
            colorFilters: COLORS.map(() => true), // allow all color types by default

            // Store browser locale for display
            browserLocale: navigator.language || navigator.userLanguage || 'en-US',

            remoteSettingsApplied: false,

            // Read-only slug properties
            showReadOnlySlug: false,
            readOnlySlugInput: '',


            // Mobile Menu
            showMobileMenu: false,

            // NativeCal Interactions
            showEditor: false,
            editorEvent: null,
            showPopover: false,
            popoverEvent: null,
            popoverPosition: { top: 0, left: 0 },
            
            // Quick Create
            showQuickCreate: false,
            quickCreateEvent: null,
            quickCreatePosition: { top: 0, left: 0 },
        }
    },

    computed: {
        // What the grid, popover and editor see. A stored all-day date is the author's
        // local midnight (see CalDate in models/caldate.js); shown raw, LA saw Tokyo's Oct 2
        // holiday on Oct 1. An all-day series' UNTIL is a date too and is shown at the
        // viewer's local midnight, which is what the grid's rrule expansion compares by
        // instant (a floating "T235959" UNTIL otherwise added a day east of UTC). Timed
        // events pass through as the same objects, so in-place drags still land on
        // calendar.events as before.
        displayEvents() {
            return this.calendar.events.map(e => e && e.isAllDay
                ? { ...e, ...Event.allDayDisplayRange(e),
                    recurrencerule: Event.allDayRuleToLocal(e.recurrencerule) }
                : e);
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
        },

        // An unclaimed /slug with something on it, kept only in this browser (LocalDraft).
        hasUnsavedDraft() {
            return !!this.urlslug && !this.isExisting && !this.isReadOnly && !this.isLoading
                && LocalDraft.hasContent(this.calendar);
        }
    },

    mounted() {
        // Initialize recents
        this.recentManager = new RecentCalendars();
        this.recentCalendars = this.recentManager.getAll();

        // "Calendar created!" from the page that created it (carried as ?created=1).
        this.announceIfJustCreated();

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
                            // Add to recents when calendar loads, marked as a read-only
                            // link so the dropdown can send you back to /view/<slug>.
                            // visit() counts once per page load: this callback re-fires
                            // on every remote edit.
                            if (c.title) {
                                this.recentManager.visit(actualSlug, c.title, { kind: 'view' });
                                this.recentCalendars = this.recentManager.getAll();
                            }

                            if (!this.remoteSettingsApplied) {
                                this.applyGlobalSettingsAfterRemote();
                                this.remoteSettingsApplied = true;
                            }
                            this.isLoading = false;
                        });
                    } else if (result.data.found && !result.data.isReadOnly) {
                        // Found as editable calendar: never opened from a /view/ link.
                        this.showViewProblem('not-shared');
                    } else {
                        // Calendar doesn't exist at all
                        this.showViewProblem('not-found');
                    }
                } catch (error) {
                    console.error('Calendar lookup failed:', error);
                    this.showViewProblem('failed');
                }
            })();
        } else if (this.urlslug) {
            // default: pastecal.com/ID
            // The third argument is the local copy. Each snapshot arrives already merged
            // with it (CalendarDataService._receive), so importing it whole is safe: edits
            // still in the debounce window and deletions not yet sent survive. A bare
            // import of the raw snapshot overwrote both.
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
                    // Add to recents when calendar loads. This subscription re-fires
                    // on every remote edit; visit() counts once per page load.
                    this.recentManager.visit(this.calendar.id, this.calendar.title);
                    this.recentCalendars = this.recentManager.getAll();

                    if (!this.remoteSettingsApplied) {
                        this.applyGlobalSettingsAfterRemote();
                        this.remoteSettingsApplied = true;
                    }
                    LocalDraft.settle(this.urlslug, c.events);
                } else {
                    // Calendar doesn't exist: bring back this browser's draft of it, once.
                    this.isExisting = false;
                    if (!this._draftRestored) {
                        this._draftRestored = true;
                        const n = LocalDraft.restoreInto(this.urlslug, this.calendar);
                        if (n) this.showToast(`Restored ${n} unsaved event${n === 1 ? '' : 's'} from this browser. Claim this URL to keep ${n === 1 ? 'it' : 'them'}.`, 'info');
                    }
                }
                this.isLoading = false;
            }, () => this.calendar);
        } else {
            // homepage - no remote calendar to load
            this.isExisting = false;
            this.calendar.id = Utils.randomID(8);
            this.isLoading = false;
        }

        // Syncfusion Schedule initialization removed for NativeCal
        /*
        const scheduleObj = window.scheduleObj = new ej.schedule.Schedule();
        ...
        scheduleObj.appendTo('#Schedule');
        */
       
        // Load and apply global settings after scheduleObj is fully initialized
        this.loadGlobalSettings();
        // Only apply settings immediately for homepage; remote calendars will apply after data loads
        if (!this.urlslug) {
            this.applyGlobalSettings();
        }
        this.applyTheme();

        // Apply custom colors CSS if any
        this.updateColorCSS();

        // The write gate refused a removal nobody declared (see CalendarDataService.sync),
        // so the screen is missing events the server still has. Same recovery as the main
        // app: REPLACE the events with the list handed over -- the server's copy plus this
        // write's own additions and edits, minus deletions the user named. Merging it
        // against the baseline would read the dropped rows as deleted-by-us and drop them
        // again. The service re-sends that list itself, so the watcher's echo is a no-op.
        CalendarDataService.onSyncRefused = ({ removing, recovered, events }) => {
            // Restore first: the service swallows a throw from here, and a missing toast
            // ref must not cost the user the recovery itself.
            if (Array.isArray(events)) {
                this.calendar.import({ events: JSON.parse(JSON.stringify(events)) });
            }
            // The rows put back, not the net shrink (an addition offsets the count).
            const n = recovered ?? removing;
            this.showToast(`Recovered ${n} event${n === 1 ? '' : 's'} that were about to be lost`, 'error');
        };

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
                var defaultEvent = CalendarFlow.markSample(this.calendar.defaultEvent(CalendarFlow.SAMPLE_TITLE));
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

        // An unclaimed /slug is saved only in this browser: say so before it is closed.
        window.addEventListener('beforeunload', (e) => {
            if (!this.hasUnsavedDraft) return;
            e.preventDefault();
            e.returnValue = '';
        });

        // Cmd/Ctrl+Z undoes this tab's own last action, as in the main app (the same
        // UndoService). Never while typing (the browser's text undo) or with a dialog up.
        this._undoStack = [];
        this._undoShortcutHandler = (e) => {
            const isZ = typeof e.key === 'string' && e.key.toLowerCase() === 'z';
            if (!((e.metaKey || e.ctrlKey) && isZ) || e.shiftKey) return;
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
            if (this.showEditor || this.showPopover || this.showQuickCreate
                || (this.$refs.quickAddDialog && this.$refs.quickAddDialog.dialogVisible)) return;
            const action = this._undoStack[this._undoStack.length - 1];
            if (!action) return;
            e.preventDefault();
            this.undoAction(action);
        };
        window.addEventListener('keydown', this._undoShortcutHandler);
    },

    watch: {
        showShare(newValue) {
            if (newValue) {
                this.updateCurrentViewURL();
                this.startUpdateLinkTimer();
            } else {
                this.stopUpdateLinkTimer();
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
            console.log("calendar.options.extended changed (stubbed)", val);
            // NativeCal handles this via props
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
             console.log('[applyDefaultView] NativeCal: Stubbed');
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
            // NativeCal handles theme via CSS variables on documentElement
            console.log('[NativeCal] Theme switched:', dark ? 'dark' : 'light');
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
             console.log('[updateCustomViewInSchedule] NativeCal: Stubbed');
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
            var defaultEvent = CalendarFlow.markSample(this.calendar.defaultEvent(CalendarFlow.SAMPLE_TITLE));
            this.calendar.setEvents([defaultEvent]);
            // Reset local settings to defaults
            this.initializeLocalSettings();
        },

        loadLocalStorage() {
            var c = Utils.safeReadJSON("calendar");
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
            // The homepage draft and an unclaimed /slug's draft are kept apart; before,
            // only the homepage was kept and events on an unclaimed /slug vanished on
            // reload (see services/LocalDraft.js, shared with the main app).
            if (this.isHomepageCalendar) {
                localStorage.setItem("calendar", JSON.stringify(this.calendar));
            } else if (this.urlslug && !this.isExisting && !this.isReadOnly && !this.isLoading) {
                LocalDraft.save(this.urlslug, this.calendar);
            }
        },

        updateCalendarView() {
            // NativeCal: Reactivity is handled by Vue props binding to <native-calendar :events="calendar.events">
            // No manual sync needed.
            console.log('[updateCalendarView] NativeCal: View updated via reactivity');
        },

        // ============================================================
        // REGION: NativeCal Interactions
        // ============================================================
        
        handleEventCreate({ start, end, isAllDay, event }) {
            this.quickCreateEvent = { start, end, isAllDay };
            
            // Position logic
            let top = 0, left = 0;
            if (event) {
                // Prefer mouse coordinates for creation
                if (event.clientX && event.clientY) {
                    top = event.clientY - 60; // Slightly above cursor to align with event
                    left = event.clientX + 20; // To the right
                } else if (event.target) {
                    const rect = event.target.getBoundingClientRect();
                    top = rect.top;
                    left = rect.right + 10;
                }
                
                // Flip if too far right
                if (left + 340 > window.innerWidth) {
                    left = (event.clientX || left) - 340;
                }
                // Flip up if near bottom
                if (top + 250 > window.innerHeight) {
                     top = window.innerHeight - 260;
                }
                // Clamp top
                if (top < 10) top = 10;
            } else {
                // Center screen fallback
                top = window.innerHeight / 2 - 100;
                left = window.innerWidth / 2 - 160;
            }

            this.quickCreatePosition = { top, left };
            this.showQuickCreate = true;
            this.closePopover();
            this.closeEditor();
        },

        closeQuickCreate() {
            this.showQuickCreate = false;
            this.quickCreateEvent = null;
        },

        handleQuickCreateSave(title) {
            if (!this.quickCreateEvent) return;
            
            const newEventData = {
                start: this.quickCreateEvent.start,
                end: this.quickCreateEvent.end,
                title: title && title.trim() ? title.trim() : UndoService.UNTITLED,
                isAllDay: this.quickCreateEvent.isAllDay,
                type: 1
            };
            
            this.handleSaveEvent(newEventData);
            this.closeQuickCreate();
        },

        handleQuickCreateMoreDetails(title) {
             if (!this.quickCreateEvent) return;
             
             this.editorEvent = {
                start: this.quickCreateEvent.start,
                end: this.quickCreateEvent.end,
                title: title || '',
                isAllDay: this.quickCreateEvent.isAllDay,
                type: 1
            };
            this.showEditor = true;
            this.closeQuickCreate();
        },

        handleEventClick({ event, occurrence, jsEvent }) {
            // Close other popups
            this.closeQuickCreate();
            this.closeEditor();

            // One occurrence of a series is shown as itself -- its own date -- and carries
            // which series and which slot it is, so delete and edit can offer "this event"
            // without guessing. It used to be swapped for the series, so the popover showed
            // the series' first date and the trash deleted every occurrence.
            this.popoverEvent = occurrence
                ? { ...event, start: occurrence.start, end: occurrence.end,
                    occurrenceStart: occurrence.start, isRecurringInstance: true }
                : event;

            // EventPopover.js widens itself past the default 320px for long descriptions
            // (see LONG_DESCRIPTION_THRESHOLD there) -- this positioning math has to use
            // the same width the popover will actually render at.
            const LONG_DESCRIPTION_THRESHOLD = 140;
            const isLong = (event?.description?.length || 0) > LONG_DESCRIPTION_THRESHOLD;
            const popoverWidth = isLong ? Math.min(480, window.innerWidth - 20) : 320;

            let top = 0, left = 0;
            if (jsEvent && jsEvent.currentTarget) {
                const rect = jsEvent.currentTarget.getBoundingClientRect();
                top = rect.bottom + 10;
                left = rect.left + (rect.width / 2) - (popoverWidth / 2);
                if (left < 10) left = 10;
                if (left + popoverWidth > window.innerWidth) left = window.innerWidth - popoverWidth - 10;
                if (top + 200 > window.innerHeight) top = rect.top - 210;
            } else {
                top = window.innerHeight / 2 - 100;
                left = window.innerWidth / 2 - (popoverWidth / 2);
            }

            this.popoverPosition = { top, left };
            this.showPopover = true;
        },

        // `scope` says what an edit of one occurrence applies to: 'this' (that occurrence
        // alone), 'following' (it and every later one) or 'all' (the series, as stored).
        openEditorForEvent(event, scope) {
            if (event && event.occurrenceStart !== undefined && scope && scope !== 'all') {
                this.editorEvent = { ...event, editScope: scope, seriesId: event.id };
            } else {
                const stored = event && this.calendar.events.find(e => e.id === event.id && !e.recurrenceID);
                const shown = stored && this.displayEvents.find(e => e.id === stored.id && !e.recurrenceID);
                this.editorEvent = { ...(shown || event) };
                delete this.editorEvent.occurrenceStart;
                delete this.editorEvent.isRecurringInstance;
            }
            this.showEditor = true;
            this.closePopover();
        },

        closePopover() {
            this.showPopover = false;
            this.popoverEvent = null;
        },

        closeEditor() {
            this.showEditor = false;
            this.editorEvent = null;
        },

        // Inverse of displayEvents for one event coming back from the grid or editor.
        // `stored` only counts if it was already all-day: a timed value is not a date.
        // Anything shown unchanged comes back as stored, byte for byte.
        toStoredEvent(shown, stored) {
            if (!shown || !shown.isAllDay) return shown;
            const prev = stored && stored.isAllDay ? stored : null;
            const out = { ...shown, ...Event.allDayStoredRange(shown.start, shown.end, prev) };
            if ('recurrencerule' in shown) {
                out.recurrencerule = Event.allDayRuleFromLocal(shown.recurrencerule,
                    prev ? prev.recurrencerule : undefined);
            }
            return out;
        },

        // The grid emits the whole display list after a drag.
        handleEventsUpdate(shownEvents) {
            const byId = new Map(this.calendar.events.map(e => [e.id, e]));
            this.calendar.setEvents(shownEvents.map(e => this.toStoredEvent(e, byId.get(e.id))));
        },

        handleSaveEvent(eventData) {
            const { editScope, seriesId, occurrenceStart } = eventData;
            const clean = { ...eventData };
            for (const k of ['editScope', 'seriesId', 'occurrenceStart', 'isRecurringInstance', 'originalEventId']) delete clean[k];
            if (!clean.title || !String(clean.title).trim()) clean.title = UndoService.UNTITLED;
            const events = [...this.calendar.events];

            if (editScope && seriesId) {
                // One occurrence, or it and the rest: the stored model Syncfusion uses too
                // (and the ICS feed reads), built from the shared Event helpers.
                const i = events.findIndex(e => e.id === seriesId && !e.recurrenceID);
                if (i === -1) return;
                const series = events[i];
                const removedKeys = [];
                if (editScope === 'this') {
                    events[i] = Event.withoutOccurrence(series, occurrenceStart);
                    const row = this.toStoredEvent({ ...clean, id: undefined, recurrencerule: series.recurrencerule }, null);
                    delete row.id;
                    events.push(new Event({ ...row, recurrenceID: series.id,
                        recurrenceException: Event.exceptionStampFor(series, occurrenceStart) }));
                } else {
                    const ended = Event.endSeriesBefore(series, occurrenceStart);
                    // Moved occurrences from here on belong to the series being replaced.
                    const later = events.filter(e => String(e.recurrenceID) === String(series.id)
                        && CalDate.toMs(e.start) >= CalDate.toMs(occurrenceStart));
                    removedKeys.push(...later.map(e => CalendarDataService._eventKey(e)));
                    const next = new Event(this.toStoredEvent({ ...clean, id: undefined, recurrenceException: null }, null));
                    next.id = Utils.uuidv4();
                    const kept = events.filter(e => !later.includes(e));
                    if (ended) kept[kept.indexOf(series)] = ended;
                    else { kept.splice(kept.indexOf(series), 1); removedKeys.push(CalendarDataService._eventKey(series)); }
                    events.length = 0;
                    events.push(...kept, next);
                }
                this.commitAction('edit', events, { removedKeys });
                this.closeEditor();
                return;
            }

            if (clean.id) {
                const index = events.findIndex(e => e.id === clean.id && !e.recurrenceID === !clean.recurrenceID);
                if (index !== -1) {
                    const merged = { ...events[index], ...clean };
                    events[index] = new Event(this.toStoredEvent(merged, events[index]));
                }
                this.commitAction('edit', events);
            } else {
                events.push(new Event(this.toStoredEvent(clean, null)));
                this.commitAction('add', events);
            }
            this.closeEditor();
        },

        // Delete from the popover or the editor. `target` is an id (the editor: the whole
        // event) or { event, scope }: for one occurrence of a series, scope is 'this' (an
        // exception date on the series), 'following' (the series ends the day before) or
        // 'all'. Every delete says what went, with Undo -- the same UndoService as the
        // main app. It used to delete the whole series on the trash of one occurrence,
        // silently, with no way back.
        handleDeleteEvent(target) {
            const all = this.calendar.events;
            const event = typeof target === 'object' && target ? target.event : null;
            const scope = (typeof target === 'object' && target && target.scope) || 'all';
            const id = event ? event.id : target;
            const row = event && event.recurrenceID
                ? all.find(e => e.id === id && String(e.recurrenceID) === String(event.recurrenceID))
                : all.find(e => e.id === id && !e.recurrenceID);

            let events, removed = [];
            if (row && !row.recurrenceID && event && event.occurrenceStart !== undefined && scope === 'this') {
                events = all.map(e => (e === row ? Event.withoutOccurrence(row, event.occurrenceStart) : e));
            } else if (row && !row.recurrenceID && event && event.occurrenceStart !== undefined && scope === 'following'
                && Event.endSeriesBefore(row, event.occurrenceStart)) {
                const later = all.filter(e => String(e.recurrenceID) === String(row.id)
                    && CalDate.toMs(e.start) >= CalDate.toMs(event.occurrenceStart));
                removed = later;
                events = all.filter(e => !later.includes(e))
                    .map(e => (e === row ? Event.endSeriesBefore(row, event.occurrenceStart) : e));
            } else {
                // The whole event. Deleting a series takes its edited occurrences (rows
                // whose recurrenceID names it) along; left behind, they would show as
                // stray one-off events.
                const series = !!row && !row.recurrenceID && !!row.recurrencerule;
                const gone = (e) => e === row
                    || (series && e.recurrenceID != null && String(e.recurrenceID) === String(id));
                removed = all.filter(gone);
                events = all.filter(e => !gone(e));
            }
            this.commitAction('delete', events,
                { removedKeys: removed.map(e => CalendarDataService._eventKey(e)) });
            this.closePopover();
            this.closeEditor();
        },

        // ============================================================
        // REGION: Calendar CRUD Operations
        // ============================================================

        // Enter in the title field. CalendarTitle emits 'enter' with no event, so this
        // reads the bound title rather than event.target (which threw on desktop).
        setTitle(event) {
            const typed = event && event.target ? event.target.value : this.calendar.title;
            const title = String(typed || '').trim();
            if (title) this.calendar.title = title;
            this.editTitle = false;
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

        updateCurrentViewURL() {
            // The view-only link, for editors too (see public/app.js). This used to be
            // window.location.href -- for an editor, the EDIT link.
            this.currentViewURL = SlugManager.getViewerBaseURL(this.calendar, true) || '';
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
            // Shared linkifier: escapes every piece, never re-scans its own markup.
            return Linkify.toHtml(this.calendar.options?.notes || '', { breaks: true });
        },

        startUpdateLinkTimer() {
            this.updateLinkTimer = setInterval(() => {
                this.updateCurrentViewURL();
            }, 100);
        },

        stopUpdateLinkTimer() {
            clearInterval(this.updateLinkTimer);
        },

        // Duplicate copyToClipboard removed from here.
        // See copyToClipboard with buttonElement feedback below.

        // ============================================================
        // REGION: Events & Search Management
        // ============================================================

        // Shared with the main app (services/EventSearch.js): title and notes, no crash on
        // an untitled event, and a series listed at its next occurrence.
        searchEvents() {
            this.searchResults = this.searchQuery.trim()
                ? EventSearch.search(this.calendar.events, this.searchQuery, {
                    occurrenceAfter: (e, ms) => this.occurrenceAfter(e, ms),
                })
                : [];
        },

        searchResultLabel(result) {
            return EventSearch.describe(result);
        },

        eventName(e) {
            return UndoService.eventName(e);
        },

        // The first occurrence of a series still in progress or to come at `fromMs`, from
        // the grid's own expansion (Event.expandOccurrences over what displayEvents
        // shows), a year at a time for at most ten. Null once the series is over.
        occurrenceAfter(event, fromMs) {
            if (!window.rrule) return null;
            const shown = this.displayEvents.find(e => e.id === event.id && !e.recurrenceID) || event;
            const start = CalDate.toMs(shown.start);
            const length = Math.max(0, CalDate.toMs(shown.end) - start) || 0;
            let from = Math.max(start, fromMs - length);
            for (let i = 0; i < 10; i++) {
                const to = from + 366 * 864e5;
                const hit = Event.expandOccurrences(shown, new Date(from), new Date(to), window.rrule)
                    .find(o => CalDate.toMs(o.end) > fromMs);
                if (hit) return { start: CalDate.toMs(hit.start), end: CalDate.toMs(hit.end) };
                from = to;
            }
            return null;
        },

        toggleColorFilter(index) {
            this.colorFilters[index] = !this.colorFilters[index];
        },

        resetColorFilters() {
            this.colorFilters = this.colorFilters.map(() => true);
        },

        getFilteredEventsQuery() {
            let query = new ej.data.Query();

            if (this.showSearch) {
                // Apply color filters from this.colorFilters
                const activeColorTypes = [];
                for (let i = 0; i < this.colorFilters.length; i++) {
                    if (this.colorFilters[i]) {
                        activeColorTypes.push(i + 1); // Event types are 1-based
                    }
                }

                if (activeColorTypes.length > 0 && activeColorTypes.length < this.COLORS.length) {
                    // If some, but not all, colors are selected, build a predicate.
                    let colorPredicate = null;
                    for (const typeId of activeColorTypes) {
                        if (colorPredicate === null) {
                            colorPredicate = new ej.data.Predicate('Type', 'equal', typeId);
                        } else {
                            colorPredicate = colorPredicate.or('Type', 'equal', typeId);
                        }
                    }
                    query = query.where(colorPredicate);
                } else if (activeColorTypes.length === 0 && this.COLORS.length > 0) {
                    // If no colors are selected (and there are colors to select from), filter out all events.
                    // Use a predicate that will never be true. Assuming 'Type' is always positive.
                    query = query.where('Type', 'equal', -1);
                }
                // If all colors are selected (activeColorTypes.length === this.COLORS.length),
                // no 'Type' predicate is added, effectively showing all events (respecting other query parts).
            }

            return query;
        },

        getFilteredEvents() {
            if (!this.showSearch) {
                return this.syncFusionEvents;
            }

            return this.syncFusionEvents;

            return this.syncFusionEvents.filter(event => {
                return true;

                const eventType = parseInt(event.Type || event.type);
                // If eventType is not a valid number, just keep the event.
                if (isNaN(eventType)) return true;
                // If the color filter for the event type is explicitly false, remove it.
                return this.colorFilters[eventType - 1] === true;
            });
        },

        jumpToEvent(result) {
            const cal = this.$refs.nativeCal;
            if (cal && typeof cal.goToDate === 'function') cal.goToDate(new Date(result.start), 'Week');
        },

        toggleRecents() {
            this.showRecents = !this.showRecents;
        },

        // Desktop logo and chevron. Hover had already opened the list, so a click that
        // toggled closed it again under the pointer -- the menu "didn't work". Opening is
        // idempotent; Escape, a click outside and leaving with the mouse close it.
        openRecents() {
            clearTimeout(this.hoverTimeout);
            this.showRecents = true;
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
                this.showNotes = false;
            } else {
                this.closeAllPanels();
                this.showNotes = true;
            }
        },

        toggleSearch() {
            if (this.showSearch) {
                this.showSearch = false;
                this.resetColorFilters();
            } else {
                this.closeAllPanels();
                this.showSearch = true;
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

        handleQuickAddEvent(event) {
            // A read-only (/view/) page has nothing to write to.
            if (!this.canEdit) return;
            // Event.fromQuickAdd is shared with the main app: one-hour default end, the
            // untitled default, and a repeat ("every weekday 9am").
            this.commitAction('add', [...this.calendar.events, Event.fromQuickAdd(event)]);
        },

        shareUrl(url, title) {
            if (navigator.share) {
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
            const settings = Utils.safeReadJSON('pastecal_global_settings');
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
             console.log('[applyGlobalSettingsAfterRemote] NativeCal: Stubbed');
        },

        applyGlobalSettings() {
            console.log('[applyGlobalSettings] NativeCal: Settings applied via props');
            // Syncfusion specific logic removed.
            // NativeCalendar component reacts to globalSettings prop changes.
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
            // if (window.scheduleObj) {
            //    scheduleObj.refresh();
            // }
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
            this.COLORS.forEach((raw, index) => {
                const num = index + 1;
                const color = Utils.safeCssColor(raw, (this.DEFAULT_COLORS || [])[index] || '#9e9e9e');
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
            // if (window.scheduleObj) {
            //    scheduleObj.refresh();
            // }
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

        copyToClipboard(textToCopy, buttonElement) {
            if (!textToCopy) {
                this.showToast('Nothing to copy', 'error');
                return;
            }

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

        // ---- Undo: the main app's machinery (services/UndoService.js) --------------------

        // Apply `events` as one user action: write it, remember how to take it back, and
        // say what happened with an Undo button (deletes and edits; adds stay quiet).
        // `removedKeys` are the rows the action deliberately deletes: the write gate
        // refuses any removal nobody declared.
        commitAction(kind, events, { removedKeys = [] } = {}) {
            const prior = this.calendar.events.map(e => new Event(e));
            if (removedKeys.length) CalendarDataService.declareIntent(removedKeys);
            const gesture = CalendarDataService.actionGesture();
            this.calendar.setEvents(events);
            const delta = UndoService.deltaBetween(prior, this.calendar.events);
            if (UndoService.isEmpty(delta)) return null;
            const action = { delta, gesture, done: false };
            this._undoStack.push(action);
            if (this._undoStack.length > 50) this._undoStack.shift();
            const message = kind === 'delete' ? UndoService.describeDelete(delta)
                : kind === 'edit' ? UndoService.describeEdit(delta) : null;
            if (message) {
                this.showToast(message, 'info', { actionLabel: 'Undo', action: () => this.undoAction(action) });
            }
            return action;
        },

        undoAction(action) {
            if (!action || action.done) return;
            const plan = UndoService.planUndo(this.calendar.events, [action.delta]);
            UndoService.commit(this.calendar, plan, action.gesture ? [action.gesture] : []);
            action.done = true;
            this._undoStack = this._undoStack.filter(a => a !== action);
            this.showToast(UndoService.describeUndo(plan), plan.noop ? 'info' : 'success');
        },
    }
};

const app = Vue.createApp(CalendarVueApp)
    .component('quick-add-button', QuickAddButton)
    .component('quick-add-dialog', QuickAddDialog);

window.vm = app.mount('#app');

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
        const vm = window.vm;
        if (!vm) return;
        if (typeof vm.canEdit === 'undefined') {
            console.warn('[sanity] vm.canEdit is undefined — computed block may be overwritten');
        } else if (vm.canEdit !== !Boolean(vm.isReadOnly)) {
            console.warn('[sanity] canEdit mismatch', { isReadOnly: vm.isReadOnly, canEdit: vm.canEdit });
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
