/**
 * Global definition for Vue 3 (from CDN)
 * @typedef {import('vue')} Vue
 */

// Augment the global Window interface
interface Window {
    dateFns: any;
    rrule: {
        RRule: any;
        rrulestr: any;
    };
    RRule: any;
    rrulestr: any;
    CAL_BASE: string;
    __appMounted: boolean;
}

// Declare global variables that exist on window but are accessed directly
declare const dateFns: any;
declare const rrule: any;
declare const RRule: any;
declare const rrulestr: any;
declare const CAL_BASE: string;

// Declare global component variables (loaded via scripts)
declare const CalendarTitle: any;
declare const NavigationDropdown: any;
declare const Tooltip: any;
declare const ToastNotification: any;
declare const QuickAddButton: any;
declare const QuickAddDialog: any;
declare const Icon: any;
declare const CopyIcon: any;
declare const SettingsIcon: any;
declare const HelpIcon: any;
declare const SearchIcon: any;
declare const ShareIcon: any;
declare const NotesIcon: any;
declare const ChevronDownIcon: any;
declare const CloseIcon: any;
declare const clickOutside: any;
declare const RecentCalendars: any;
declare const firebase: any;
declare const ej: any;

// Define the Event Model with a distinct name to avoid DOM Event collision
declare class PasteCalEvent {
    id: string;
    title: string;
    start: number; // timestamp
    end: number; // timestamp
    isAllDay: boolean;
    type: number; // 1-8
    description?: string;
    recurrencerule?: string;
    
    // Runtime properties added by calendar
    style?: any;
    colIndex?: number;
    isRecurringInstance?: boolean;
    originalEventId?: string;
    
    constructor(data: Partial<PasteCalEvent>);
}

// Alias for backward compatibility if needed, but prefer PasteCalEvent in JSDoc
// declare class Event extends PasteCalEvent {} 
// ^ Be careful with shadowing DOM Event. 
// It's better to use PasteCalEvent in JSDoc.

/**
 * PasteCal Calendar Model
 */
declare class Calendar {
    id: string;
    title: string;
    events: PasteCalEvent[];
    options: {
        notes?: string;
        defaultView?: 'Day' | 'Week' | 'Month' | 'Custom' | 'Year' | 'Agenda' | null;
        customViewDuration?: number;
        customViewUnit?: 'Weeks' | 'Months';
        extended?: boolean;
        colors?: string[];
        typeLabels?: string[];
        publicViewId?: string;
        [key: string]: any;
    };
    
    constructor(id: string, title: string, events: any[]);
    import(data: any): void;
    setEvents(events: any[]): void;
    defaultEvent(title: string): PasteCalEvent;
}

/**
 * Global Vue instance for CDN build
 */
declare const Vue: {
    createApp: any;
    ref: any;
    computed: any;
    watch: any;
    onMounted: any;
    onUnmounted: any;
    nextTick: any;
    reactive: any;
};

/**
 * Global Utils
 */
declare const Utils: {
    randomID(length: number): string;
};

/**
 * Global CalendarDataService
 */
declare const CalendarDataService: {
    subscribe_readonly(slug: string, callback: (c: any) => void): void;
    findAndSubscribe(slug: string, callback: (c: any) => void): void;
    createWithId(slug: string, calendar: any, callback: () => void): void;
    checkExists(slug: string, onExists: () => void, onNotExists: () => void): void;
    debounce_sync(calendar: any): void;
};

/**
 * Global SlugManager
 */
declare const SlugManager: {
    normalizeSlug(slug: string): string;
    getReadOnlyICSURL(calendar: any): string;
    createReadOnlyLink(calendar: any): Promise<any>;
    customizeReadOnlyLink(calendar: any, slug: string): Promise<any>;
    getReadOnlySlug(calendar: any): string;
    getReadOnlyURL(calendar: any): string;
};

// Component Props Interfaces
interface NativeCalendarProps {
    events: PasteCalEvent[];
    timeFormat: string;
    creatingEvent: any;
}

interface EventEditorProps {
    event: PasteCalEvent;
    visible: boolean;
    colors: string[];
}
