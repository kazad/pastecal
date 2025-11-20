# Custom Calendar View Feature Specification

## Overview

PasteCal will introduce a configurable "Custom" view that allows users to define their preferred calendar duration. By default, the Custom view displays a 3-month period, but users can reconfigure it to show any N weeks or N months according to their preferences.

## Key Concepts

### The "Custom" View
- A new view type that appears alongside Day, Week, Month, Year, and Agenda
- Default configuration: 3 months (matching the recently added feature)
- User-configurable at two levels:
  - **Personal Custom View**: Applies across all calendars the user views
  - **Calendar Custom View**: Per-calendar override for specific calendar defaults

## Current Implementation Status

### Existing Features
- **Standard Views**: Day, Week, Month, Year, Agenda (index.html:1893-1903)
- **Recently Added**: 3 Month view using `{ option: 'Month', displayName: '3 Month', interval: 3 }`
- **Settings System**:
  - Personal defaults in `globalSettings` (localStorage)
  - Calendar-specific defaults in `calendar.options.defaultView` (Firebase)
- **URL Parameters**: View override via `?view=` or `?v=` query params

### View Priority Chain
1. URL parameter (`?view=custom`)
2. Calendar-specific default (`calendar.options.defaultView = "Custom"`)
3. Personal default (`globalSettings.defaultView = "Custom"`)

## Feature Requirements

### 1. Default View Change
- **Change global default from "Week" to "Custom"**
- New users will see 3-month view by default
- Existing users keep their current preferences (no migration needed)

### 2. View Types Configuration

#### Standard Views (Unchanged)
- Day
- Week
- Month
- Year
- Agenda

#### New: Custom View
The Custom view is configurable with:

**Duration Selector:**
- Number input (N): Integer from 1-52 for weeks, 1-24 for months
- Unit selector: Dropdown with options "Weeks" or "Months"
- Examples:
  - 3 + Months = 3-month view (default)
  - 12 + Weeks = 12-week view
  - 6 + Months = 6-month view

**View Type Options:**
- **Standard Interval View** (default): Multi-week or multi-month grid
- **Timeline View**: Syncfusion Timeline mode (checkbox/toggle)
  - Research Syncfusion Timeline capabilities
  - May require different configuration than interval-based views

### 3. User Interface Design

#### A. Personal Settings Dropdown
**Location:** index.html:1305-1310

**Current Structure:**
```html
<select v-model="globalSettings.defaultView">
  <option value="Day">Day</option>
  <option value="Week">Week</option>
  <option value="Month">Month</option>
  <option value="Year">Year</option>
  <option value="Agenda">Agenda</option>
</select>
```

**New Structure:**
```html
<select v-model="globalSettings.defaultView">
  <option value="Day">Day</option>
  <option value="Week">Week</option>
  <option value="Month">Month</option>
  <option value="Custom">Custom</option>
  <option value="Year">Year</option>
  <option value="Agenda">Agenda</option>
</select>

<!-- Show only when globalSettings.defaultView === "Custom" -->
<div v-if="globalSettings.defaultView === 'Custom'" class="custom-view-config">
  <label>Duration:</label>
  <input type="number"
         v-model.number="globalSettings.customViewDuration"
         :min="1"
         :max="globalSettings.customViewUnit === 'Weeks' ? 52 : 24">

  <select v-model="globalSettings.customViewUnit">
    <option value="Weeks">Weeks</option>
    <option value="Months">Months</option>
  </select>

  <label>
    <input type="checkbox" v-model="globalSettings.customViewTimeline">
    Use Timeline View
  </label>
</div>
```

#### B. Calendar Settings Dropdown
**Location:** index.html:1385-1390

Same structure as personal settings, but using `calendar.options.defaultView`, `calendar.options.customViewDuration`, `calendar.options.customViewUnit`, and `calendar.options.customViewTimeline`.

### 4. Data Structures

#### Global Settings Extension
**Location:** index.html:1775-1781

```javascript
globalSettings: {
    firstDayOfWeek: '0',
    timeFormat: '12',
    defaultView: 'Custom',                    // NEW DEFAULT
    customViewDuration: 3,                    // NEW: Number of intervals
    customViewUnit: 'Months',                 // NEW: 'Weeks' or 'Months'
    customViewTimeline: false,                // NEW: Use timeline mode
    startHour: '05:00',
    darkMode: 'auto'
}
```

#### Calendar Options Extension
**Location:** Calendar class (index.html:508-514)

```javascript
calendar.options = {
    defaultView: "Custom",
    customViewDuration: 12,                   // NEW
    customViewUnit: "Weeks",                  // NEW
    customViewTimeline: false,                // NEW
    extended: false,
    notes: "",
    publicViewId: "xyz123",
    typeLabels: ["Type 1", ...],
    colors: [...]
}
```

### 5. Syncfusion Views Array Configuration

**Location:** index.html:1893-1903

#### Current Implementation:
```javascript
scheduleObj.views = [
    'Day',
    'Week',
    'Month',
    { option: 'Month', displayName: '3 Month', interval: 3 },
    'Year',
    'Agenda'
];
```

#### New Implementation:
```javascript
// Build Custom view configuration dynamically
let customViewConfig = this.buildCustomViewConfig(
    this.calendar?.options?.customViewDuration || this.globalSettings.customViewDuration,
    this.calendar?.options?.customViewUnit || this.globalSettings.customViewUnit,
    this.calendar?.options?.customViewTimeline || this.globalSettings.customViewTimeline
);

scheduleObj.views = [
    'Day',
    'Week',
    'Month',
    customViewConfig,  // Dynamic custom view
    'Year',
    'Agenda'
];
```

#### Helper Method:
```javascript
buildCustomViewConfig(duration, unit, isTimeline) {
    if (isTimeline) {
        // Timeline view configuration
        // Research: Syncfusion Timeline syntax
        return {
            option: 'Timeline' + unit,  // e.g., 'TimelineMonth'
            displayName: 'Custom',
            interval: duration
        };
    } else {
        // Standard interval view
        const baseOption = unit === 'Weeks' ? 'Week' : 'Month';
        return {
            option: baseOption,
            displayName: 'Custom',
            interval: duration
        };
    }
}
```

### 6. URL Parameter Support

**Location:** index.html:1920-1944

#### Current URL Parsing:
```javascript
var view_param = url.searchParams.get("v") || url.searchParams.get("view");

switch(view_param_lower) {
    case 'd': case 'day': resolvedView = 'Day'; break;
    case 'w': case 'week': resolvedView = 'Week'; break;
    case 'm': case 'month': resolvedView = 'Month'; break;
    // ...
}
```

#### New URL Parameter Options:
```
?view=custom              # Use user's custom view config
?view=custom&dur=12&unit=weeks     # Override custom view temporarily
?view=custom&dur=6&unit=months&timeline=true  # Timeline custom view
```

**Implementation:**
```javascript
if (view_param_lower === 'custom' || view_param_lower === 'c') {
    resolvedView = 'Custom';

    // Allow URL to override custom view settings temporarily
    const dur = url.searchParams.get("dur") || url.searchParams.get("duration");
    const unit = url.searchParams.get("unit");
    const timeline = url.searchParams.get("timeline") === "true";

    if (dur && unit) {
        // Apply temporary custom config (don't save to settings)
        this.tempCustomViewDuration = parseInt(dur);
        this.tempCustomViewUnit = unit.charAt(0).toUpperCase() + unit.slice(1);
        this.tempCustomViewTimeline = timeline;
    }
}
```

### 7. Implementation Plan

#### Phase 1: Data Structure Updates
1. Add new fields to `globalSettings`:
   - `customViewDuration` (default: 3)
   - `customViewUnit` (default: 'Months')
   - `customViewTimeline` (default: false)
2. Update `loadGlobalSettings()` method (index.html:2594-2602)
3. Update `saveGlobalSettings()` method (index.html:2691-2708)
4. Add new fields to Calendar options structure

#### Phase 2: UI Components
1. Update personal settings dropdown (index.html:1305-1310)
   - Add "Custom" option
   - Add custom view configuration panel (hidden by default)
   - Wire up v-model bindings
2. Update calendar settings dropdown (index.html:1385-1390)
   - Same changes as personal settings
3. Add styling for custom view configuration panel

#### Phase 3: View Configuration Logic
1. Create `buildCustomViewConfig()` method
2. Update Syncfusion views array initialization (index.html:1893-1903)
3. Handle priority chain: calendar config → personal config → defaults
4. Research Syncfusion Timeline view syntax and configuration

#### Phase 4: URL Parameter Support
1. Extend URL parsing switch statement (index.html:1920-1944)
2. Add temporary config override support
3. Test URL sharing with custom view parameters

#### Phase 5: Default View Migration
1. Change default value: `defaultView: 'Week'` → `defaultView: 'Custom'`
2. Set `customViewDuration: 3` and `customViewUnit: 'Months'` as defaults
3. Ensure existing user preferences are preserved (no data migration needed)

#### Phase 6: Testing & Edge Cases
1. Test all view transitions (Custom ↔ Day/Week/Month/Year/Agenda)
2. Test settings persistence (localStorage + Firebase)
3. Test URL parameter overrides
4. Test read-only calendar view (ensure Custom view works)
5. Validate input ranges (1-52 weeks, 1-24 months)
6. Test Timeline view functionality
7. Cross-browser testing

### 8. Technical Considerations

#### Syncfusion Timeline View Research
- **Action Required**: Investigate Syncfusion v23.2.6 Timeline view capabilities
- Questions to answer:
  - What is the exact syntax for Timeline views?
  - Can Timeline views use intervals (e.g., 3-month timeline)?
  - Are there Timeline-specific options needed?
  - Does Timeline require different event rendering logic?

#### Backwards Compatibility
- Existing users with `defaultView: "Week"` keep their preference
- Existing calendars with `options.defaultView: "Month"` keep their setting
- New users get `defaultView: "Custom"` with 3-month default
- URL parameters like `?view=week` continue to work

#### Storage Considerations
- **localStorage** (personal settings): Already flexible, accepts any JSON
- **Firebase** (calendar settings): Schema is flexible, no migration needed
- Size impact: +3 fields per user, +3 fields per calendar (negligible)

#### Performance
- No performance impact: Custom view uses same Syncfusion rendering as "3 Month" view
- Dynamic view configuration happens once during initialization

#### Validation Rules
```javascript
function validateCustomView(duration, unit) {
    const maxWeeks = 52;
    const maxMonths = 24;

    if (unit === 'Weeks') {
        return duration >= 1 && duration <= maxWeeks;
    } else if (unit === 'Months') {
        return duration >= 1 && duration <= maxMonths;
    }
    return false;
}
```

### 9. User Experience Flow

#### Scenario 1: New User
1. User visits PasteCal for first time
2. Sees 3-month Custom view by default
3. Can switch to Day/Week/Month/Year/Agenda via toolbar
4. Can customize Custom view in Settings → "Personal Default View"

#### Scenario 2: Existing User
1. User already has preferred view (e.g., "Week")
2. No changes to their experience
3. Discovers new "Custom" option in settings dropdown
4. Can experiment with Custom view configurations

#### Scenario 3: Calendar Owner
1. User creates new calendar
2. Sets calendar-specific default: Custom → 12 Weeks
3. Shares calendar URL with team
4. All viewers see 12-week view by default (unless they have personal override)

#### Scenario 4: URL Sharing
1. User configures Custom view: 6 months
2. Switches to that view via toolbar
3. Shares URL: `pastecal.com/mycal?view=custom`
4. Recipients see 6-month view (using calendar or personal defaults)

#### Scenario 5: Temporary Override
1. User shares link: `pastecal.com/mycal?view=custom&dur=4&unit=weeks`
2. Recipients see 4-week Custom view
3. Recipients' saved preferences are not affected

### 10. Future Enhancements (Out of Scope)

- Multiple saved Custom view presets (e.g., "Custom 1", "Custom 2")
- Custom view naming (e.g., rename "Custom" to "Quarter" or "Sprint")
- Week/Month start day offset for Custom views
- Hybrid views (e.g., 2 months + 1 week)

### 11. Files to Modify

#### Primary File
- `/home/kalid/Projects/pastecal/public/index.html`
  - Lines 1775-1781: Update `globalSettings` structure
  - Lines 1305-1310: Update personal settings UI
  - Lines 1385-1390: Update calendar settings UI
  - Lines 1893-1903: Update Syncfusion views array
  - Lines 1920-1944: Update URL parameter parsing
  - Lines 2594-2602: Update `loadGlobalSettings()`
  - Lines 2691-2708: Update `saveGlobalSettings()`
  - Add new method: `buildCustomViewConfig()`
  - Add validation method: `validateCustomView()`

#### No Backend Changes Required
- Firebase schema is flexible enough
- No Cloud Functions updates needed
- No database migration necessary

### 12. Success Criteria

- [ ] New users see 3-month Custom view by default
- [ ] Existing users' preferences are preserved
- [ ] Users can configure Custom view duration (N weeks/months)
- [ ] Custom view settings persist in localStorage (personal)
- [ ] Custom view settings persist in Firebase (calendar-specific)
- [ ] URL parameter `?view=custom` works correctly
- [ ] URL parameters can temporarily override Custom view config
- [ ] Timeline view option works (if supported by Syncfusion)
- [ ] Settings UI is intuitive and responsive
- [ ] Input validation prevents invalid ranges
- [ ] View switching via toolbar works smoothly
- [ ] Read-only calendars respect Custom view settings

## Conclusion

This specification defines a flexible "Custom" view system that replaces the hard-coded 3-month view with a user-configurable duration view. The implementation leverages existing PasteCal architecture (localStorage for personal settings, Firebase for calendar settings, Syncfusion intervals for rendering) while introducing minimal new code and zero database migrations.

By defaulting new users to a 3-month Custom view, PasteCal provides a superior out-of-the-box experience while empowering users to tailor the interface to their specific needs (e.g., sprint planning with 2-week views, quarterly planning with 12-week views, annual planning with 12-month views).
