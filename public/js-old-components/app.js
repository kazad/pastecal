import { createApp } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js';
import { HelpIcon, SearchIcon, ShareIcon, NotesIcon, ChevronDownIcon, CloseIcon, CopyIcon, StarIcon, TrashIcon, DropdownIcon, CheckIcon, XIcon, InfoIcon, EditIcon, DoneIcon, KebabIcon, LockIcon, MobileIcon, SwitchIcon, EyeIcon, LinkIcon, DeviceIcon, ExportIcon, SettingsIcon } from './components/Icons.js';
import CalendarTitle from './components/CalendarTitle.js';
import NavigationDropdown from './components/NavigationDropdown.js';
import ShareOrClaimUI from './components/ShareOrClaimUI.js';
import QuickAddDialog from './components/QuickAddDialog.js';
import ToastNotification from './components/ToastNotification.js';
import Tooltip from './components/Tooltip.js';
import { Calendar, Event, CalendarDataService, SlugManager } from './firebase.js';
import * as Utils from './utils.js';
import RecentCalendars from './RecentCalendars.js';

// Click outside directive
const clickOutside = {
    mounted(el, binding) {
        el._clickOutside = (event) => {
            if (!(el === event.target || el.contains(event.target))) {
                binding.value(event);
            }
        };
        document.addEventListener('click', el._clickOutside);
    },
    unmounted(el) {
        document.removeEventListener('click', el._clickOutside);
    }
};

const CalendarVueApp = {
    components: {
        'calendar-title': CalendarTitle,
        'navigation-dropdown': NavigationDropdown,
        'share-or-claim-ui': ShareOrClaimUI,
        'quick-add-dialog': QuickAddDialog,
        'toast-notification': ToastNotification,
        'custom-tooltip': Tooltip,
        // Icons
        'help-icon': HelpIcon,
        'search-icon': SearchIcon,
        'share-icon': ShareIcon,
        'notes-icon': NotesIcon,
        'chevron-down-icon': ChevronDownIcon,
        'close-icon': CloseIcon,
        'copy-icon': CopyIcon,
        'star-icon': StarIcon,
        'trash-icon': TrashIcon,
        'dropdown-icon': DropdownIcon,
        'check-icon': CheckIcon,
        'x-icon': XIcon,
        'info-icon': InfoIcon,
        'edit-icon': EditIcon,
        'done-icon': DoneIcon,
        'kebab-icon': KebabIcon,
        'lock-icon': LockIcon,
        'mobile-icon': MobileIcon,
        'switch-icon': SwitchIcon,
        'eye-icon': EyeIcon,
        'link-icon': LinkIcon,
        'device-icon': DeviceIcon,
        'export-icon': ExportIcon,
        'settings-icon': SettingsIcon
    },
    directives: {
        'click-outside': clickOutside
    },
    data() {
        let urlslug = window.location.pathname.split("/")[1];

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
            showNotes: false,
            showHelp: false,
            showShare: false,
            showSettings: false,
            showRecents: false,
            showSearch: false,
            searchQuery: '',
            searchResults: [],
            colorFilters: Array(8).fill(true),
            showMobileMenu: false,
            showClaimDialog: false,
            userHasEditedSlug: false,
            isEditingNotes: false,

            // URL & Link State
            currentViewURL: '',
            updateLinkTimer: null,
            showReadOnlySlug: false,
            readOnlySlugInput: '',
            newCalendarId: '',

            // Global Settings (localStorage)
            globalSettings: {
                darkMode: 'auto',
                firstDayOfWeek: '0', // 0=Sunday, 1=Monday
                timeFormat: '12', // 12 or 24
                defaultView: 'Week', // Personal default view preference
                startHour: '08:00', // Default start hour
                customViewDuration: 3, // For custom view
                customViewUnit: 'Weeks', // Weeks or Months
                autoDetectedFromLocale: false
            },

            // Local Settings (transient state for UI)
            localSettings: {
                colors: [...COLORS],
                typeLabels: [] // Will be populated from calendar options
            },

            // Constants
            COLORS: COLORS,
            DEFAULT_COLORS: DEFAULT_COLORS,

            // Helper class instance
            recentManager: new RecentCalendars()
        }
    },
    computed: {
        // Computed properties for UI text
        personalCustomViewLabel() {
            return `${this.globalSettings.customViewDuration} ${this.globalSettings.customViewUnit}`;
        },
        calendarAutoViewLabel() {
            // Shows what "Auto" will resolve to based on user's personal settings
            return this.globalSettings.defaultView === 'Custom'
                ? this.personalCustomViewLabel
                : this.globalSettings.defaultView;
        },
        calendarCustomViewLabel() {
            const duration = this.calendar.options.customViewDuration || 3;
            const unit = this.calendar.options.customViewUnit || 'Weeks';
            return `${duration} ${unit}`;
        },
        hasCustomColors() {
            return JSON.stringify(this.COLORS) !== JSON.stringify(this.DEFAULT_COLORS);
        },
        isAutogeneratedId() {
            // Simple heuristic: if ID is 8 random chars (alphanumeric) it might be auto-generated
            // But users can claim anything. This was for the Danger Zone check.
            return this.calendar.id && this.calendar.id.length === 8; 
        }
    },
    watch: {
        // Watch for changes to calendar title/id to update recents
        'calendar.title': function (newTitle) {
            if (this.isExisting && this.calendar.id) {
                this.recentManager.add(this.calendar.id, newTitle);
                this.recentCalendars = this.recentManager.getAll();
            }
            // update document title
            document.title = (newTitle || 'PasteCal') + (this.isReadOnly ? ' (View Only)' : '');
        },
        'calendar.id': function (newId) {
            if (this.isExisting && newId) {
                this.recentManager.add(newId, this.calendar.title);
                this.recentCalendars = this.recentManager.getAll();
            }
        },
        // Watch for changes to calendar options to sync theme/settings
        'calendar.options': {
            handler(newOptions) {
                if (newOptions) {
                    // Apply calendar-specific settings (colors, labels)
                    this.loadCustomColors();
                    // Type labels are handled via binding but we ensure they are in sync
                    if (newOptions.typeLabels) {
                        this.localSettings.typeLabels = [...newOptions.typeLabels];
                    }
                    
                    // Sync logic is handled by the calendar object watcher or explicit saves
                }
            },
            deep: true
        }
    },
    mounted() {
        this.recentCalendars = this.recentManager.getAll();
        this.loadGlobalSettings();

        // Initialize default color filters
        this.colorFilters = Array(this.COLORS.length).fill(true);

        if (this.urlslug) {
            // Load existing calendar
            CalendarDataService.findAndSubscribe(this.urlslug, (calendar) => {
                if (calendar) {
                    this.isExisting = true;
                    this.isLoading = false;
                    this.calendar.import(calendar); // this will update this.calendar internal properties

                    // Check if this is a view-only calendar based on URL pattern or internal property
                    // Note: The findAndSubscribe method handles redirection for view-only slugs, 
                    // so if we are here, it's either an editable calendar OR we are on the /view/ path
                    // (though /view/ path logic is handled by server/routing usually, or we check pathname)
                    if (window.location.pathname.startsWith('/view/')) {
                        this.isReadOnly = true;
                    }

                    // Update recents
                    this.recentManager.add(calendar.id, calendar.title);
                    this.recentCalendars = this.recentManager.getAll();

                    // Initialize settings
                    this.initializeLocalSettings();
                    
                    // Refresh UI events
                    this.syncFusionEvents = this.calendar.getSyncFusionEvents();
                    
                    // Apply settings
                    this.applyGlobalSettingsAfterRemote();
                } else {
                    // Calendar not found, create new one with this slug
                    this.calendar.id = this.urlslug;
                    this.isLoading = false;
                    this.isExisting = false;
                }
            });
        } else {
            // New calendar on homepage
            this.isLoading = false;
            // Check if user came from a redirect or just opened homepage
            // If homepage, maybe show a welcome or just empty state
        }

        // Start URL updater
        this.startUpdateLinkTimer();
    },
    beforeUnmount() {
        this.stopUpdateLinkTimer();
    },
    methods: {
        // ... All methods from original index.html ...
        // I will copy them over now.
        
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
                    // this.clearLocalStorage(); // Not defined in original methods list, probably meant local state reset
                    this.showToast('Calendar created!', 'success');
                    window.location.href = "/" + slug;
                });
            });
        },

        handleSlugInput(val) {
             // Update value if passed (from event)
             if (val && typeof val === 'string') {
                 this.calendar.id = val;
             }
             this.userHasEditedSlug = true;
        },

        setTitle(event) {
            if (event.target.value.trim()) {
                this.editTitle = false;
                this.calendar.title = event.target.value.trim();
            }
        },

        updateCurrentViewURL() {
            if (typeof scheduleObj === 'undefined') return;
            
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

            this.currentViewURL = `${window.location.origin}/${this.calendar.id}?date=${currentDate}&view=${viewParam}`;
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
            return SlugManager.getReadOnlyICSURL(this.calendar);
        },

        createReadOnlyLink() {
            return SlugManager.createReadOnlyLink(this.calendar);
        },

        customizeExistingLink() {
            if (!this.readOnlySlugInput.trim()) return;

            SlugManager.customizeReadOnlyLink(this.calendar, this.readOnlySlugInput.trim())
                .then(() => {
                    this.readOnlySlugInput = '';
                    this.showReadOnlySlug = false;
                });
        },

        getReadOnlySlug() {
            return SlugManager.getReadOnlySlug(this.calendar) || '';
        },

        getReadOnlyURL() {
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
            notes = notes.replace(/(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%?=~_|])/ig,
                '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

            notes = notes.replace(/(^|\s)(www.[\S]+(\b|$))/ig,
                '$1<a href="http://$2" target="_blank" rel="noopener noreferrer">$2</a>');

            // Convert line breaks to <br> tags
            notes = notes.replace(/\n/g, "<br>");

            if (notes.trim() === '') {
                return '<span class="text-color-1 italic">No notes yet.</span>';
            }

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

        copyToClipboard(textToCopy, buttonElement) {
            if (!textToCopy) {
                this.showToast('Nothing to copy', 'error');
                return;
            }

            navigator.clipboard.writeText(textToCopy).then(() => {
                if(buttonElement) {
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
                    }, 1500);
                } else {
                    this.showToast('Copied to clipboard!', 'success');
                }

            }).catch(err => {
                console.error('Failed to copy: ', err);
                this.showToast('Failed to copy link', 'error');
            });
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
            // Refresh schedule to apply filters
            if (window.scheduleObj) {
                window.scheduleObj.refresh();
            }
        },

        resetColorFilters() {
            this.colorFilters = this.colorFilters.map(() => true);
            if (window.scheduleObj) {
                window.scheduleObj.refresh();
            }
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

        toggleHelp() {
            if (this.showHelp) {
                this.showHelp = false;
            } else {
                this.closeAllPanels();
                this.showHelp = true;
            }
        },

        toggleNotes() {
            if (this.showNotes) {
                this.showNotes = false;
            } else {
                this.closeAllPanels();
                this.showNotes = true;

                if (!this.isReadOnly) {
                    const hasNotes = this.calendar.options.notes && this.calendar.options.notes.trim().length > 0;
                    this.isEditingNotes = !hasNotes;
                } else {
                    this.isEditingNotes = false;
                }
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

        toggleSettings() {
            if (this.showSettings) {
                this.showSettings = false;
            } else {
                this.closeAllPanels();
                this.showSettings = true;
                this.importTypeLabelsFromNotes();
            }
        },

        closeAllPanels() {
            if (this.showHelp) this.toggleHelp();
            if (this.showNotes) this.toggleNotes();
            if (this.showSearch) this.toggleSearch();
            if (this.showShare) this.toggleShare();
            if (this.showSettings) this.toggleSettings();
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

        // ============================================================ 
        // REGION: Settings & Preferences Management
        // ============================================================ 

        loadGlobalSettings() {
            const settings = JSON.parse(localStorage.getItem('pastecal_global_settings'));
            if (settings) {
                this.globalSettings = { ...this.globalSettings, ...settings };
                if (this.globalSettings.customViewDuration === undefined) {
                    this.globalSettings.customViewDuration = 3;
                }
                if (this.globalSettings.customViewUnit === undefined) {
                    this.globalSettings.customViewUnit = 'Months';
                }
            } else {
                this.autoImportLocaleSettings();
            }
        },

        autoImportLocaleSettings() {
            try {
                const locale = navigator.language || navigator.userLanguage;
                const formatter = new Intl.DateTimeFormat(locale, {
                    hour: 'numeric',
                    hour12: undefined 
                });
                const timeFormatSample = formatter.format(new Date(2023, 0, 1, 13, 0, 0));
                const is12Hour = timeFormatSample.match(/am|pm|a.m.|p.m.|AM|PM|A.M.|P.M./i) !== null;
                this.globalSettings.timeFormat = is12Hour ? '12' : '24';

                let firstDay = 0;
                try {
                    if (typeof Intl !== 'undefined' && typeof Intl.Locale !== 'undefined' && typeof Intl.Locale.prototype.getWeekInfo === 'function') {
                        const weekInfo = new Intl.Locale(locale).getWeekInfo();
                        firstDay = weekInfo.firstDay === 7 ? 0 : weekInfo.firstDay;
                    }
                } catch (e) {
                    console.warn("Error in first day detection:", e);
                }

                this.globalSettings.firstDayOfWeek = firstDay.toString();
                this.globalSettings.autoDetectedFromLocale = true;
                this.saveGlobalSettings();
            } catch (error) {
                console.error("Error auto-importing locale settings:", error);
            }
        },

        saveGlobalSettings() {
            try {
                localStorage.setItem('pastecal_global_settings', JSON.stringify(this.globalSettings));
            } catch (error) {
                console.warn('Unable to save settings', error);
            }
            this.applyGlobalSettings();
            this.applyTheme();
        },

        applyGlobalSettingsAfterRemote() {
            if (typeof window.scheduleObj === 'undefined' || !window.scheduleObj) return;
            this.applyDefaultView();
        },

        applyGlobalSettings() {
            if (typeof window.scheduleObj === 'undefined' || !window.scheduleObj) return;

            try {
                scheduleObj.firstDayOfWeek = parseInt(this.globalSettings.firstDayOfWeek);
                
                const timeFormat = this.globalSettings.timeFormat === '24' ? 'HH:mm' : 'hh:mm a';
                scheduleObj.timeFormat = timeFormat;

                this.applyDefaultView();

                if (!this.calendar?.options?.extended) {
                    scheduleObj.startHour = this.globalSettings.startHour;
                }
            } catch (error) {
                console.error('Error applying global settings:', error);
            }
        },
        
        applyDefaultView() {
            // Placeholder for applyDefaultView logic found in original file, 
            // usually it checks globalSettings.defaultView or calendar default view
            // and sets scheduleObj.currentView
        },
        
        applyTheme() {
            // Placeholder for theme application
            const darkMode = this.globalSettings.darkMode;
            const isDark = darkMode === 'dark' || (darkMode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
            if (isDark) {
                document.documentElement.classList.add('dark');
            } else {
                document.documentElement.classList.remove('dark');
            }
        },

        initializeLocalSettings() {
            const defaultLabels = Array(this.COLORS.length).fill().map((_, i) => `Type ${i + 1}`);
            if (!this.localSettings.typeLabels || !Array.isArray(this.localSettings.typeLabels)) {
                this.localSettings.typeLabels = [...defaultLabels];
            }
            if (this.calendar?.options?.typeLabels?.length > 0) {
                this.localSettings.typeLabels = [...this.calendar.options.typeLabels];
            } else {
                const imported = this.importTypeLabelsFromNotes();
                if (!imported) {
                    this.localSettings.typeLabels = [...defaultLabels];
                    if (!this.calendar.options) this.calendar.options = {};
                    this.calendar.options.typeLabels = [...defaultLabels];
                }
            }
            this.loadCustomColors();
        },

        updateTypeLabel(typeId, value) {
            const index = typeId - 1;
            if (index >= 0 && index < this.COLORS.length) {
                let sanitizedValue = value.trim().substring(0, 70);
                if (sanitizedValue === '') {
                    sanitizedValue = `Type ${typeId}`;
                }
                this.localSettings.typeLabels[index] = sanitizedValue;
                this.storeTypeLabelsInCalendarOptions();
            }
        },

        updateEventColor(index, color) {
            if (index >= 0 && index < this.COLORS.length) {
                this.localSettings.colors[index] = color;
                this.COLORS[index] = color;
                this.storeColorsInCalendarOptions();
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
            if (!this.calendar.options) this.calendar.options = {};
            this.calendar.options.colors = [...this.localSettings.colors];
            if (window.scheduleObj) scheduleObj.refresh();
        },

        updateColorCSS() {
            const existingStyle = document.getElementById('dynamic-color-styles');
            if (existingStyle) existingStyle.remove();

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
            if (this.calendar.options && this.calendar.options.colors && Array.isArray(this.calendar.options.colors)) {
                this.localSettings.colors = [...this.calendar.options.colors];
                this.COLORS = [...this.calendar.options.colors];
                this.updateColorCSS();
            }
        },

        getTypeColor(typeId) {
            typeId = parseInt(typeId);
            return this.COLORS[typeId - 1] || this.COLORS[0];
        },

        storeTypeLabelsInCalendarOptions() {
            if (!this.calendar.options) this.calendar.options = {};
            this.calendar.options.typeLabels = [...this.localSettings.typeLabels];
            if (window.scheduleObj) scheduleObj.refresh();
        },

        importTypeLabelsFromNotes() {
            try {
                if (!this.calendar.options) this.calendar.options = {};
                if (this.calendar?.options?.typeLabels?.length > 0) {
                    this.localSettings.typeLabels = [...this.calendar.options.typeLabels];
                    return true;
                }
                const notes = this.calendar?.options?.notes || '';
                const typeRegex = /\b(Type)\s*(\d)\s*[=](.*)\b/ig;
                const matches = [...notes.matchAll(typeRegex)];

                if (matches.length > 0) {
                    const labels = Array(this.COLORS.length).fill().map((_, i) => `Type ${i + 1}`);
                    matches.forEach(m => {
                        const index = parseInt(m[2]) - 1;
                        if (index >= 0 && index < this.COLORS.length) {
                            labels[index] = m[3].trim().substring(0, 70);
                        }
                    });
                    this.localSettings.typeLabels = labels;
                    this.calendar.options.typeLabels = [...labels];
                    this.cleanTypeDefinitionsFromNotes(notes, matches);
                    return true;
                }
                return false;
            } catch (error) {
                console.error('Error importing type labels from notes:', error);
                return false;
            }
        },

        cleanTypeDefinitionsFromNotes(notes, matches) {
            const stringsToRemove = matches.map(match => match[0]);
            let newNotes = notes;
            stringsToRemove.forEach(str => {
                newNotes = newNotes.replace(new RegExp(str + '\\n?\\n?', 'g'), '');
                newNotes = newNotes.replace(new RegExp('\\n?\\n?' + str.replace(/[.*+?^${}()|[\\]/g, '\\$&'), 'g'), '');
            });
            newNotes = newNotes.replace(/\n{3,}/g, '\n\n').trim();
            this.calendar.options.notes = newNotes;
        },
        
        confirmClaim() {
            if (this.calendar.id) {
                this.create();
                this.showClaimDialog = false;
            }
        },

        showToast(message, type = 'info') {
            this.$refs.toast.display(message, type);
        }
    }
};

const app = createApp(CalendarVueApp);
app.mount('#app');
