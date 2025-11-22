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
    'calendar-title': CalendarTitle,           // Mobile & desktop title component
    'navigation-dropdown': NavigationDropdown, // Recent calendars dropdown
    'custom-tooltip': Tooltip,                 // Tooltip wrapper
    'toast-notification': ToastNotification,   // Toast messages
    'quick-add-button': QuickAddButton,        // Quick Add trigger component (button/FAB)
    'quick-add-dialog': QuickAddDialog,        // Quick Add dialog (parsing & create)
    'native-calendar': NativeCalendar,         // Native Calendar component
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
            "#ff9800", "03a9f4", "#9e9e9e", "#27282f"
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
        // Initialize recents
        this.recentManager = new RecentCalendars();
        this.recentCalendars = this.recentManager.getAll();

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
                                this.recentManager.add(actualSlug, `${c.title} (View Only)`, true);
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
                    // Add to recents when calendar loads
                    this.recentManager.add(this.calendar.id, this.calendar.title);
                    this.recentCalendars = this.recentManager.getAll();

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
            // NativeCal: Reactivity is handled by Vue props binding to <native-calendar :events="calendar.events">
            // No manual sync needed.
            console.log('[updateCalendarView] NativeCal: View updated via reactivity');
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

            // check for existing
            CalendarDataService.checkExists(slug, () => {
                // Revert to alert for this validation as per user request
                alert("This URL is already taken. Please choose another.");
            }, () => {
                // does not exist, proceed
                this.isLoading = true;
                CalendarDataService.createWithId(slug, this.calendar, () => {
                    // success - clear localStorage so homepage starts fresh next time
                    this.clearLocalStorage();
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

                    CalendarDataService.createWithId(newId, newCalendar, () => {
                        // We don't delete the old one (safer, acts as a copy)
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

        updateCurrentViewURL() {
            console.log('[updateCurrentViewURL] NativeCal: Stubbed');
            this.currentViewURL = window.location.href; // Fallback
        },

        // ============================================================
        // REGION: URL Generation & Sharing
        // ============================================================

        getEditableURL() {
            return `${window.location.origin}/${this.calendar.id}`;
        },

        getEditableICSURL() {
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

        jumpToEvent(event) {
            let startDate = new Date(event.start);
            console.log('[jumpToEvent] NativeCal: Stubbed', startDate);
            // scheduleObj.selectedDate = startDate;
            // scheduleObj.currentView = 'Week';
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
            const newEvent = new Event({
                title: event.subject,
                start: event.startDateTime,
                end: event.endDateTime
            });
            this.calendar.events.push(newEvent);
            this.calendar.setEvents(this.calendar.events);
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

        showToast(message, type = 'info') {
            this.$refs.toast.display(message, type);
        },
    }
};

const app = Vue.createApp(CalendarVueApp)
    .component('quick-add-button', QuickAddButton)
    .component('quick-add-dialog', QuickAddDialog)
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
