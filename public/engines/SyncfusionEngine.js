// Syncfusion calendar engine.
//
// This is the code that used to live inline in app.js's mounted(), moved behind
// the CalendarEngine contract (see engines/README.md) so the shell can run either
// engine. The body is a faithful extraction: `scheduleObj` became `self.obj` and
// the Vue instance became `self.app`, and nothing else about the logic changed.
// The `window.scheduleObj` global is still published, because debugging sessions,
// the console, and older notes all reach for it.
//
// One thing did move out: parsing ?d= / ?v= out of the URL. That is shell work,
// not engine work -- both engines need it, so it lives in app.js and arrives here
// as the `selectedDate` / `currentView` mount options.

class SyncfusionEngine {

    // What index.html must load before this engine can mount. The shell injects
    // these on demand, so a native-engine page never pays for the 5 MB bundle.
    static assets = {
        scripts: ['https://cdn.syncfusion.com/ej2/23.2.6/dist/ej2.min.js'],
        styles: [
            { id: 'syncfusion-base-theme', light: 'https://cdn.syncfusion.com/ej2/ej2-base/styles/material.css', dark: 'https://cdn.syncfusion.com/ej2/ej2-base/styles/material-dark.css' },
            { id: 'syncfusion-theme', light: 'https://cdn.syncfusion.com/ej2/material.css', dark: 'https://cdn.syncfusion.com/ej2/material-dark.css' },
            { id: 'syncfusion-schedule-theme', light: 'https://cdn.syncfusion.com/ej2/ej2-schedule/styles/material.css', dark: 'https://cdn.syncfusion.com/ej2/ej2-schedule/styles/material-dark.css' },
        ],
        license: 'Ngo9BigBOggjHTQxAR8/V1NHaF1cW2hIfEx1RHxQdld5ZFRHallYTnNWUj0eQnxTdEZiW39fcXJXR2JUV0NyWg==',
    };

    static get id() { return 'syncfusion'; }

    constructor(app) {
        this.app = app;
        this.obj = null;
        this.host = null;
    }

    mount(host, options = {}) {
        this.host = host;
        const self = this;
        self.obj = window.scheduleObj = new ej.schedule.Schedule();
        const scheduleInitTimestamp = performance.now();
        console.log('[schedule-init] Schedule constructed at', scheduleInitTimestamp.toFixed(1), 'ms');
        self.obj.on('actionComplete', (args) => {
            if (args?.requestType === 'toolBarRendered') {
                console.log('[schedule-init] toolBarRendered at', (performance.now() - scheduleInitTimestamp).toFixed(1), 'ms since init');
            }
        });
        self.obj.addEventListener('dataBound', () => {
            console.log('[schedule-init] dataBound at', (performance.now() - scheduleInitTimestamp).toFixed(1), 'ms since init');
        });
        self.obj.on('eventsLoaded', () => {
            console.log('[schedule-init] eventsLoaded at', (performance.now() - scheduleInitTimestamp).toFixed(1), 'ms since init');
        });

        // Apply globalSettings BEFORE appendTo — these properties bake into Syncfusion's
        // first render and won't reactively update if set later. (See applyGlobalSettings
        // for the post-render path used when settings change at runtime.)
        self.obj.startHour = self.app.calendar?.options?.extended ? "00:00" : (self.app.globalSettings.startHour || "05:00");
        self.obj.timeFormat = self.app.globalSettings.timeFormat === '24' ? 'HH:mm' : 'hh:mm a';
        self.obj.firstDayOfWeek = parseInt(self.app.globalSettings.firstDayOfWeek) || 0;

        // Build custom view configuration dynamically
        const customViewDuration = self.app.calendar?.options?.customViewDuration || self.app.globalSettings.customViewDuration;
        const customViewUnit = self.app.calendar?.options?.customViewUnit || self.app.globalSettings.customViewUnit;
        const customViewConfig = self.app.buildCustomViewConfig(customViewDuration, customViewUnit);

        self.obj.views = [
            'Day',
            'Week',
            'Month',
            customViewConfig,
            'Year',
            'Agenda'
        ];
        self.obj.enableAdaptiveUI = false;

        self.obj.readonly = self.app.isReadOnly;

        // Initial date and view, parsed out of the URL by the shell. A ?v=12w or
        // ?v=q asks for a differently-sized custom view than the settings chose,
        // so it replaces the one built above rather than adding a seventh button.
        if (options.customView) {
            const index = self.obj.views.findIndex(v => v === customViewConfig);
            if (index !== -1) self.obj.views[index] = options.customView;
        }
        if (options.selectedDate) self.obj.selectedDate = options.selectedDate;
        if (options.currentView) self.obj.currentView = options.currentView;

        // disable drag and drop / resizing for touch devices
        let touchDevice = ('ontouchstart' in document.documentElement);
        self.obj.allowDragAndDrop = !touchDevice;
        self.obj.allowResizing = !touchDevice;

        // live binding to events
        self.obj.eventSettings.dataSource = self.app.syncFusionEvents;
        self.obj.actionComplete = (ev) => {
            switch (ev.requestType) {
                case 'eventChanged':
                case 'eventCreated':
                case 'eventRemoved':
                    console.log("[app] actionComplete()", "event", ev);
                    console.log(` - syncFusionEvents ${self.app.syncFusionEvents.length}`, self.app.syncFusionEvents);
                    console.log(` - eventsData ${self.obj.eventsData.length}`, self.obj.eventsData);
                    self.app.calendar.setEvents(self.app.syncFusionEvents);
                    // A real, user-initiated change to this calendar. Recorded here
                    // rather than in CalendarDataService.sync(), because sync() also
                    // runs when the live subscription echoes back someone else's edit --
                    // which made every viewer look like an editor.
                    if (typeof AuthorSignal !== 'undefined') {
                        AuthorSignal.touch(self.app.calendar.id);
                    }
                    if (ev.requestType === 'eventCreated') {
                        // Everything the scheduler itself creates: grid drag, the
                        // built-in editor, and the cell popup all land here.
                        track(a => a.eventAdded('grid', self.app.calendar));
                    }
                    break;
            }
            // console.log(ev);
        };

        // color events based on type
        self.obj.eventRendered = (args) => {
            // change color as needed
            // Declared, not implied. In app.js this was an accidental global, which
            // sloppy-mode script scope tolerated; a class body is strict mode, so the
            // same line threw ReferenceError and Syncfusion silently rendered no
            // appointments at all.
            const categoryColor = self.app.COLORS[args.data.Type - 1] || self.app.COLORS[0];
            if (self.obj.currentView === 'Agenda') {
                args.element.firstChild.style.borderLeftColor = categoryColor;
            } else {
                args.element.style.backgroundColor = categoryColor;
            }
        }

        // custom display for types
        self.obj.popupOpen = (args) => {

            if (args.type === 'Editor') {
                // console.log("Editor call");

                // Configure datetime pickers with strictMode and the user's chosen date format.
                // Syncfusion's default is en-US (M/d/yy) which is ambiguous internationally
                // (1/7/26 = Jan 7 in US, July 1 elsewhere). resolveDateFormat() picks a
                // pattern from globalSettings.dateFormat, falling back to navigator.language.
                const startElement = args.element.querySelector('[name="StartTime"]');
                const endElement = args.element.querySelector('[name="EndTime"]');
                const dateFmt = self.app.resolveDateFormat();
                const timeFmt = self.app.globalSettings.timeFormat === '24' ? 'HH:mm' : 'hh:mm a';
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

                    window.btnObj.element.style.background = self.app.COLORS[id - 1];
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
                    let items = self.app.getTypes();

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
                            self.app.dropdownOpen = true;
                            updateTooltipVisibility();
                        },
                        close: () => {
                            self.app.dropdownOpen = false;
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
                    const isDefaultLabels = self.app.localSettings.typeLabels.every((label, i) => label === `Type ${i + 1}`);
                    const shouldShow = self.app.dropdownOpen && isDefaultLabels && window.innerWidth >= 768;

                    if (window.typeTooltip) {
                        // Append tooltip to dropdown popup if not already there
                        if (self.app.dropdownOpen && !window.typeTooltip.parentElement) {
                            const dropdownPopup = document.querySelector('.e-dropdown-popup.e-popup-open ul');
                            if (dropdownPopup) {
                                dropdownPopup.parentElement.appendChild(window.typeTooltip);
                            }
                        }

                        window.typeTooltip.classList.toggle('hidden', !shouldShow);
                    }
                };

                // Initialize dropdown state
                self.app.dropdownOpen = false;
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

        self.obj.appendTo(self.host);

        // Add event listener to mark month-start dates and colorize year view dots
        self.obj.dataBound = function () {
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
            if (self.obj.currentView === 'Year') {
                const cells = document.querySelectorAll('.e-year-view td.e-cell[data-date]');
                const allEvents = self.obj.eventsData || [];

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
                            const color = self.app.COLORS[types[0] - 1] || self.app.COLORS[0];
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
                                const color = self.app.COLORS[type - 1] || self.app.COLORS[0];
                                dot.style.cssText = `width: 4px; height: 4px; border-radius: 50%; background-color: ${color};`;
                                dotsContainer.appendChild(dot);
                            });

                            cell.appendChild(dotsContainer);
                        }
                    }
                });
            }
        };

    }

    // ---- CalendarEngine contract ----------------------------------------

    // The shell owns the master event list; we take a Syncfusion-shaped copy plus
    // whatever query the colour filters produced.
    setEvents(events, query) {
        if (!this.obj) return;
        this.obj.setProperties({
            eventSettings: {
                dataSource: new ej.data.DataManager(events),
                query: query,
            },
        });
        this.obj.dataBind();
    }

    getView() { return this.obj ? this.obj.currentView : null; }

    setView(name) { if (this.obj) this.obj.currentView = name; }

    getDate() { return this.obj ? this.obj.selectedDate : null; }

    setDate(date) { if (this.obj) this.obj.selectedDate = date; }

    // The names as they appear on the toolbar, in toolbar order -- the custom view
    // reports its display name ("3 Months"), not "Custom".
    getViewNames() {
        if (!this.obj || !this.obj.views) return [];
        return this.obj.views.map(v => (typeof v === 'string' ? v : v.displayName));
    }

    // Syncfusion will not reliably switch view by assignment before its toolbar has
    // rendered, so the historical approach -- click the toolbar button once it
    // exists -- is preserved here rather than in the shell. Returns false when the
    // button is not there yet; the shell retries on dataBound.
    activateView(name) {
        if (!this.obj) return false;
        const index = this.getViewNames().findIndex(v => v === name);
        if (index === -1) return false;
        const buttons = document.querySelectorAll('.e-toolbar-item.e-views button');
        const target = buttons[index];
        if (!target) return false;
        const label = (target.getAttribute('aria-label') || target.textContent || '').trim();
        if (label && label.toLowerCase().includes(name.toLowerCase())) {
            target.click();
            return true;
        }
        return false;
    }

    // Called again whenever a view finishes binding, so the shell can retry an
    // activation that was too early.
    onViewBound(handler) {
        if (!this.obj) return () => {};
        this.obj.addEventListener('dataBound', handler);
        return () => this.obj.removeEventListener('dataBound', handler);
    }

    setOptions(options = {}) {
        if (!this.obj) return;
        const o = options;
        if (o.firstDayOfWeek !== undefined) this.obj.firstDayOfWeek = parseInt(o.firstDayOfWeek) || 0;
        if (o.timeFormat !== undefined) this.obj.timeFormat = o.timeFormat === '24' ? 'HH:mm' : 'hh:mm a';
        if (o.startHour !== undefined) this.obj.startHour = o.startHour;
        if (o.readOnly !== undefined) this.obj.readonly = Boolean(o.readOnly);
        if (o.customView !== undefined) this.setCustomView(o.customView, o.refreshCustomView);
    }

    // Swap the custom view (e.g. "3 Months" -> "12 Weeks") in place, keeping it at
    // the same toolbar position and following it if it is the active view.
    setCustomView(config, shouldRefresh = false) {
        if (!this.obj || !this.obj.views) return;
        const index = this.obj.views.findIndex(v => typeof v === 'object' && v.interval !== undefined);
        if (index === -1) return;
        const previousName = this.obj.views[index].displayName;
        const wasActive = this.obj.currentView === previousName;
        this.obj.views[index] = config;
        if (wasActive) this.obj.currentView = config.displayName;
        if (shouldRefresh) this.obj.refresh();
    }

    refresh() { if (this.obj) this.obj.refresh(); }

    // Syncfusion ships separate light and dark CSS bundles, so the theme is a
    // stylesheet swap rather than a class on <html>.
    setTheme(dark) {
        SyncfusionEngine.assets.styles.forEach(sheet => {
            const el = document.getElementById(sheet.id);
            if (el) el.href = dark ? sheet.dark : sheet.light;
        });
    }

    destroy() {
        if (this.obj) this.obj.destroy();
        this.obj = null;
        window.scheduleObj = null;
    }
}

window.SyncfusionEngine = SyncfusionEngine;
