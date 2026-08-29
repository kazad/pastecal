// Native calendar engine.
//
// Thin adapter between the shell and the NativeCalendar Vue component. It owns a
// reactive options object that index.html binds straight onto the component, so
// "the shell sets an option" and "the component re-renders" are the same thing --
// no imperative sync, and no second copy of the view/date to drift.
//
// The component is controlled: it never mutates currentView or selectedDate
// itself, it emits, and the shell writes back here.

class NativeEngine {

    // date-fns for the grid maths, rrule for expanding recurrences. Together
    // ~36 KB gzipped, against Syncfusion's ~5 MB.
    static assets = {
        scripts: [
            'https://cdn.jsdelivr.net/npm/date-fns@3.6.0/cdn.min.js',
            'https://cdn.jsdelivr.net/npm/rrule@2.8.1/dist/es5/rrule.min.js',
        ],
        // Themed entirely through the CSS variables in style.css, so there is no
        // light/dark bundle to swap.
        styles: [],
    };

    static get id() { return 'native'; }

    constructor(app) {
        this.app = app;
        this.viewBoundHandlers = [];

        // Bound into <native-calendar> by index.html. Vue.reactive rather than a
        // plain object so that writes here reach the component.
        this.state = Vue.reactive({
            events: [],
            currentView: 'Month',
            selectedDate: new Date(),
            views: ['Day', 'Week', 'Month', 'Year', 'Agenda'],
            timeFormat: '12',
            firstDayOfWeek: 0,
            startHour: '05:00',
            colors: [],
            readOnly: false,
            allowDrag: true,
            allowResize: true,
        });
    }

    mount(host, options = {}) {
        // Nothing to append: the component is already in the shell's template and
        // renders as soon as the engine is selected. Mounting is just the initial
        // options push.
        this.host = host;
        this.setOptions({
            timeFormat: this.app.globalSettings.timeFormat,
            firstDayOfWeek: this.app.globalSettings.firstDayOfWeek,
            startHour: this.app.calendar?.options?.extended
                ? '00:00'
                : (this.app.globalSettings.startHour || '05:00'),
            readOnly: this.app.isReadOnly,
            colors: this.app.COLORS,
            customView: options.customView || this.app.buildCustomViewConfig(
                this.app.calendar?.options?.customViewDuration ?? this.app.globalSettings.customViewDuration,
                this.app.calendar?.options?.customViewUnit ?? this.app.globalSettings.customViewUnit,
            ),
        });
        if (options.selectedDate) this.state.selectedDate = options.selectedDate;
        if (options.currentView) this.state.currentView = options.currentView;
    }

    // ---- CalendarEngine contract ----------------------------------------

    // The native component reads the app's own Event model directly, so unlike
    // Syncfusion there is no field renaming step. The colour-filter query is a
    // Syncfusion DataManager concept and does not apply -- production does not
    // filter the grid either, only the search list.
    setEvents(events) {
        this.state.events = events || [];
    }

    getView() { return this.state.currentView; }

    setView(name) { this.state.currentView = name; }

    getDate() { return this.state.selectedDate; }

    setDate(date) { this.state.selectedDate = date; }

    getViewNames() { return this.state.views.slice(); }

    // Nothing to wait for: the toolbar is ours and setting the view is enough.
    activateView(name) {
        if (!this.state.views.includes(name)) return false;
        this.state.currentView = name;
        return true;
    }

    // Kept so the shell can treat both engines the same. Syncfusion needs to
    // retry a view switch after its toolbar renders; we never do, so this hands
    // back a no-op unsubscribe.
    onViewBound() { return () => {}; }

    setOptions(options = {}) {
        const o = options;
        if (o.firstDayOfWeek !== undefined) this.state.firstDayOfWeek = parseInt(o.firstDayOfWeek) || 0;
        if (o.timeFormat !== undefined) this.state.timeFormat = o.timeFormat;
        if (o.startHour !== undefined) this.state.startHour = o.startHour;
        if (o.readOnly !== undefined) this.state.readOnly = Boolean(o.readOnly);
        if (o.colors !== undefined) this.state.colors = (o.colors || []).slice();
        if (o.allowDrag !== undefined) this.state.allowDrag = o.allowDrag;
        if (o.allowResize !== undefined) this.state.allowResize = o.allowResize;
        if (o.customView !== undefined) this.setCustomView(o.customView);
    }

    // The custom view is a name in the toolbar list ("3 Months", "12 Weeks"); the
    // component parses its own step size back out of that name. Replacing it in
    // place keeps it at the same toolbar position, and follows it if it is active.
    setCustomView(config) {
        if (!config || !config.displayName) return;
        const builtIn = ['Day', 'Week', 'Month', 'Year', 'Agenda'];
        const previous = this.state.views.find(v => !builtIn.includes(v));
        const next = this.state.views.map(v => (v === previous ? config.displayName : v));
        if (!next.includes(config.displayName)) {
            // First time: slot it where Syncfusion puts it, after Month.
            next.splice(next.indexOf('Month') + 1, 0, config.displayName);
        }
        this.state.views = next;
        if (previous && this.state.currentView === previous) {
            this.state.currentView = config.displayName;
        }
    }

    // Everything is reactive, so there is nothing to force.
    refresh() {}

    // Theme is CSS variables on <html>, which the shell already sets.
    setTheme() {}

    destroy() {
        this.state.events = [];
    }
}

window.NativeEngine = NativeEngine;
