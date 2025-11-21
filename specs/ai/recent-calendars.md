# Recent Calendars Navigation - Design Specification

## Problem Statement
Users creating calendars have difficulty navigating back to their work after leaving. The current history icon is not discoverable enough, and the homepage doesn't surface recent work prominently.

## Current State Analysis

### Existing Components
- **Logo/Home Link**: Takes users to homepage (pastecal.com)
- **History Icon**: Opens dropdown with recent calendars (exists but not discoverable)
- **Calendar URL Display**: Shows current calendar URL with share button
- **RecentCalendars Class**: Already tracks visited calendars in localStorage with:
  - Auto-save on calendar load
  - Pin/unpin functionality
  - Last 10 calendars retained
  - Last visited timestamps

## Proposed Solution

### 1. Integrated Calendar Navigation Dropdown

Replace the separate history icon with an integrated dropdown in the calendar URL area:

```
[pastecal.com/calendar-id ▼] [Share]
```

**Behavior:**
- Clicking the URL copies it (current behavior maintained)
- Hovering over the URL area shows a dropdown arrow
- Clicking the dropdown arrow or hovering for 500ms opens recent calendars list
- List shows:
  - "Current Calendar" section (if on a calendar page)
  - "Recent Calendars" section with last 10 visited
  - "Create New Calendar" option at bottom

**Visual Design:**
- Subtle dropdown arrow appears on hover
- Dropdown panel matches existing panel styling (bg-1, shadow-md, rounded-md)
- Each calendar shows:
  - Title (truncated if too long)
  - Calendar ID in smaller text
  - Last visited (relative time: "2 hours ago", "yesterday")
  - Pin icon for favorites
  - Delete (×) to remove from history

### 2. Homepage Recent Calendars Section

When visiting pastecal.com (no calendar ID):

**Layout:**
```
Welcome to PasteCal
[Create New Calendar] button

Your Recent Calendars:
┌─────────────────────────────────┐
│ 📌 Team Meeting Schedule        │
│    /abc123 • 2 hours ago        │
├─────────────────────────────────┤
│ Project Timeline                │
│    /xyz789 • yesterday          │
├─────────────────────────────────┤
│ [Show all 8 calendars...]       │
└─────────────────────────────────┘
```

**Features:**
- Show up to 5 recent calendars initially
- "Show all" expands to show all stored calendars
- Each card is clickable to navigate to that calendar
- Empty state: "No recent calendars. Create your first calendar to get started!"

### 3. Enhanced Navigation Feedback

**Auto-save indication:**
- When a new calendar is created, show toast: "Calendar created and saved to history"
- Visual pulse animation on the dropdown when calendar is added to recents

**First-time user guidance:**
- On first visit, show tooltip on dropdown: "Access your recent calendars here"
- Dismiss on first interaction or after 5 seconds

## Implementation Details

### HTML Structure Changes

```html
<!-- Current -->
<div class="relative" v-click-outside="closeRecents">
  <button @click.stop="toggleRecents">...</button>
  <div v-if="showRecents">...</div>
</div>

<!-- Proposed -->
<div class="calendar-url-container relative" 
     @mouseenter="showDropdownArrow = true"
     @mouseleave="handleMouseLeave">
  <div class="flex items-center">
    <a :href="'/' + calendar.id" class="calendar-url">
      pastecal.com/{{ calendar.id }}
    </a>
    <button v-show="showDropdownArrow || showRecents" 
            @click="toggleRecents"
            class="dropdown-arrow">
      ▼
    </button>
  </div>
  <div v-if="showRecents" class="dropdown-panel">
    <!-- Recent calendars list -->
  </div>
</div>
```

### JavaScript Changes

```javascript
// Add to Vue instance
data: {
  showDropdownArrow: false,
  hoverTimeout: null,
  // ... existing data
},

methods: {
  handleMouseEnter() {
    this.showDropdownArrow = true;
    this.hoverTimeout = setTimeout(() => {
      this.showRecents = true;
    }, 500);
  },
  
  handleMouseLeave() {
    clearTimeout(this.hoverTimeout);
    setTimeout(() => {
      if (!this.showRecents) {
        this.showDropdownArrow = false;
      }
    }, 200);
  },
  
  // ... existing methods
}
```

### Homepage Detection

```javascript
mounted() {
  if (!this.urlslug) {
    // Homepage view
    this.showHomepage = true;
    this.loadRecentCalendars();
  }
}
```

## User Journey

### New User
1. Arrives at pastecal.com
2. Sees "Create New Calendar" prominently
3. Creates calendar, sees toast confirmation
4. Can easily return via browser history or recent calendars

### Returning User
1. Arrives at pastecal.com
2. Immediately sees their recent calendars
3. One click to return to any previous work
4. Can pin frequently used calendars

### Active User
1. Working on a calendar
2. Hovers over URL to copy/share
3. Sees dropdown arrow, discovers calendar list
4. Can quickly switch between multiple calendars

## Success Metrics

- Reduced bounce rate from homepage
- Increased return visits to created calendars
- Higher engagement with multiple calendars per user
- Positive user feedback on navigation

## Alternative Considerations

### Rejected: Confirmation Dialog
- Not needed since all changes auto-save
- Would add friction to navigation

### Rejected: Separate Navigation Bar
- Takes up valuable vertical space
- Duplicates existing UI elements

### Rejected: Browser Storage Only
- localStorage is sufficient for this use case
- No need for backend sync complexity

## Next Steps

1. Implement dropdown integration with calendar URL
2. Add homepage recent calendars section
3. Test hover interactions and timing
4. Add first-time user tooltips
5. Monitor usage analytics post-launch