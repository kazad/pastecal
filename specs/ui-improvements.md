# PasteCal - UI/UX Improvements

**Date:** November 2025
**Source:** Comprehensive usability review of `public/index.html`

## Summary

Total issues identified: **29**
- High Priority: **4** (Accessibility, Mobile UI, Error Handling, Hidden Features)
- Medium Priority: **11** (Keyboard nav, Loading states, Affordances)
- Low Priority: **14** (Polish, Edge cases, Minor improvements)

---

## HIGH PRIORITY - Critical Issues

### 1. Accessibility - Missing ARIA Labels & Alt Text
**Location:** Lines 787-830 (button icons)

**Issue:** Help, Search, and Settings buttons have no aria-labels or descriptive text for screen readers

**Impact:** Screen reader users cannot identify button purposes

**Fix:**
```html
<button aria-label="Show help" v-on:click="toggleHelp">
<button aria-label="Search events" v-on:click="toggleSearch">
<button aria-label="Settings" v-on:click="toggleSettings">
```

---

### 2. Confusing URL Claim Interface
**Location:** Lines 964-993

**Issue:** The unified pill for URL ixnput is visually cramped on mobile (domain text hidden on small screens with "md:hidden")

**Impact:** Users on mobile see "/your-name" without context about "pastecal.com"

**Fix:** Always show truncated domain or add icon; improve mobile layout

---

### 3. Poor Error Handling for Calendar Not Found
**Location:** Lines 2247-2256

**Issue:** Generic `alert()` messages for "Calendar not found" - not user-friendly

**Impact:** Jarring user experience, no actionable guidance

**Fix:** Replace alerts with in-app toast notifications or dedicated error states with helpful CTAs

---

### 4. Destructive Action Warning Missing
**Location:** Lines 1648-1669 (Remove from recent)

**Issue:** "Remove from recent" (X button) has no confirmation dialog

**Impact:** Users can accidentally remove calendars from their recent list

**Fix:** Add confirmation tooltip or undo mechanism

---

## MEDIUM PRIORITY - Important UX Issues

### 5. Keyboard Navigation - Modal Traps
**Location:** Lines 1556-1592 (Claim Dialog)

**Issue:** No visible focus management or escape key handler mentioned for claim dialog

**Impact:** Keyboard users may be trapped

**Fix:** Ensure Tab cycles through modal elements, first element gets focus, Escape closes (partially exists at line 1886-1888 for QuickAdd)

---

### 6. Unclear Loading States
**Location:** Lines 885-900

**Issue:** "Loading..." state is minimal - no spinner animation or progress indication

**Impact:** Users unsure if app is frozen or loading

**Fix:** Add animated spinner icon or skeleton loader

---

### 7. Inconsistent Button States
**Location:** Lines 1256-1259

**Issue:** Disabled button uses generic gray (`disabled:bg-gray-400`) without sufficient contrast

**Impact:** May not meet WCAG AA contrast requirements

**Fix:** Verify contrast ratio; consider more visible disabled state

---

### 8. Hidden Functionality - Quick Add
**Location:** Lines 832-834

**Issue:** "+Event" button is `hidden lg:block` - completely unavailable on mobile/tablet

**Impact:** Mobile users lose important quick-add feature (HIGH for mobile users)

**Fix:** Show on mobile with adjusted UI, or add to hamburger menu

---

### 9. Settings Icon Tooltip Text Cut-Off
**Location:** Lines 2526-2536

**Issue:** Tooltip "Customize labels in Settings" might overflow on small screens

**Impact:** Text truncation or visual awkwardness

**Fix:** Ensure tooltip has proper width constraints and wrapping

---

### 10. Color Picker Accessibility
**Location:** Lines 1466-1474

**Issue:** Color picker is a hidden `<input type="color">` over a div - no keyboard access clear

**Impact:** Keyboard users may struggle to access

**Fix:** Ensure color input is keyboard accessible or add visible button trigger

---

### 11. Calendar Title Edit Affordance
**Location:** Lines 842-858

**Issue:** Title is only editable on click with tooltip - no visual cue (no underline, icon, or cursor change visible in code)

**Impact:** Users may not discover they can edit the title

**Fix:** Add subtle visual cue: underline on hover, edit icon, or cursor: pointer (may be in CSS)

---

### 12. Recents Dropdown Discoverability
**Location:** Lines 750-780

**Issue:** Dropdown triggered by logo hover + small arrow - easy to miss

**Impact:** Users may not discover recent calendars feature

**Fix:** Make arrow more prominent or add "Recent" text label

---

### 13. Read-Only Mode Indicator
**Location:** Lines 902-927

**Issue:** "View Only" pill is clear but doesn't explain why it's read-only

**Impact:** Users might not understand they need the edit link

**Fix:** Tooltip is good; consider adding "Get Edit Link" CTA button

---

### 14. Extended Hours UI
**Location:** Lines 174-186

**Issue:** Extended hours triggered by clicking disabled cell with pseudo-content "12-4 AM" - very unclear affordance

**Impact:** Users unlikely to discover this feature

**Fix:** Move to settings panel or add visible toggle button

---

### 15. Search Results Truncation
**Location:** Lines 1030-1038

**Issue:** `max-h-64 overflow-auto` with no "showing X of Y results" counter

**Impact:** Users don't know how many results exist

**Fix:** Add result count header

---

## LOW PRIORITY - Polish & Minor Issues

### 16. Toast Notification Timing
**Location:** Lines 1814-1816

**Issue:** 3-second timeout might be too short for important messages

**Impact:** Users might miss critical feedback

**Fix:** Consider 5-7 seconds or user-dismissable only for errors

---

### 17. Empty State for Notes
**Location:** Lines 1009-1018

**Issue:** Textarea has placeholder "Notes..." but no guidance on what notes are for

**Impact:** Users unsure of purpose

**Fix:** Add descriptive label "Calendar Notes" above textarea

---

### 18. Mobile Responsiveness - Share Dialog
**Location:** Lines 1163-1350

**Issue:** 2x2 grid (`md:grid-cols-2`) - lots of content in sharing panel may be overwhelming on mobile

**Impact:** Scrolling fatigue, hard to compare options

**Fix:** Consider accordion or tabs for mobile

---

### 19. Inconsistent Link Truncation
**Location:** Lines 947-949

**Issue:** URL text truncates with `max-w-[150px] md:max-w-xs` but no tooltip on hover to see full URL

**Impact:** Users can't verify full URL without clicking share

**Fix:** Add tooltip showing full URL on hover

---

### 20. Copy Button Feedback
**Location:** Lines 1187-1191, 1225-1229

**Issue:** Copy buttons have no visible success feedback (no toast call visible in these sections)

**Impact:** Users unsure if copy worked

**Fix:** Add brief visual feedback (check icon, tooltip "Copied!", or toast)

---

### 21. Claim Dialog - No Auto-Focus
**Location:** Lines 1576-1577

**Issue:** `ref="claimInput"` but no explicit `@mounted="$refs.claimInput.focus()"` visible

**Impact:** User must click to start typing

**Fix:** Auto-focus input on modal open (may exist in Vue code)

---

### 22. QuickAdd Dialog - Enter Key Behavior
**Location:** Lines 1758-1759

**Issue:** Placeholder says "Hit Enter to create" but Shift+Enter for newlines is non-standard

**Impact:** Users may accidentally submit with newline intent

**Fix:** Consider making Enter = newline, Ctrl/Cmd+Enter = submit (more standard)

---

### 23. Settings Panel - No Save Button
**Location:** Lines 1353-1548

**Issue:** Settings auto-save on change (`@change="saveGlobalSettings"`) - no confirmation

**Impact:** User might not realize changes are instant

**Fix:** Add subtle "Saved" indicator after changes, or make it clear settings are instant

---

### 24. Help Panel Information Overload
**Location:** Lines 1058-1160

**Issue:** Large welcome hero + 2x2 grid can feel overwhelming

**Impact:** Users may skip reading

**Fix:** Consider progressive disclosure or onboarding tour

---

### 25. Color Filter Circles Small on Mobile
**Location:** Lines 1047-1054

**Issue:** `w-6 h-6` circles might be hard to tap on mobile (< 44px)

**Impact:** Touch target too small per iOS/Android guidelines

**Fix:** Increase to at least `w-10 h-10` or add padding

---

### 26. No Offline State
**Issue:** No visible handling for offline/network errors

**Impact:** App may appear broken when offline

**Fix:** Add offline detection and friendly message

---

### 27. Long Calendar Titles
**Location:** Lines 847-848, 856-857

**Issue:** Title truncates at `max-w-[150px] md:max-w-xs` with `text-center` - may cut off awkwardly

**Impact:** Users can't see full title

**Fix:** Add tooltip on hover OR allow title to wrap on small screens

---

### 28. Autogenerated ID Pattern
**Location:** Lines 2162-2168

**Issue:** Auto-generated IDs are 8 chars from specific alphabet - users may type invalid chars

**Impact:** Confusing error when custom slug fails

**Fix:** Add real-time validation feedback on slug input

---

### 29. Recent Calendars List Overflow
**Location:** Lines 1635

**Issue:** `max-h-[36rem]` can show many calendars but no search/filter

**Impact:** Hard to find specific calendar if list is long

**Fix:** Add quick search within recents dropdown

---

## Recommended Fix Order

1. **Add ARIA labels to all icon buttons** (accessibility)
2. **Fix mobile URL claim interface**
3. **Replace alert() with proper error UI**
4. **Make Quick Add available on mobile**
5. **Add copy success feedback**
6. **Improve loading states with spinners**
7. **Increase touch targets for color filters**
8. **Add confirmation for destructive actions**
9. **Improve extended hours discoverability**
10. **Add keyboard focus management to modals**

---

## Categories Summary

### Accessibility Issues
- Issues: #1, #5, #7, #10
- Critical for WCAG compliance and inclusive design

### Mobile UX Issues
- Issues: #2, #8, #18, #25
- Affects growing mobile user base

### Error Handling & Feedback
- Issues: #3, #6, #16, #20, #23
- Improves user confidence and reduces confusion

### Discoverability & Affordances
- Issues: #11, #12, #13, #14, #19, #21, #27
- Helps users find and understand features

### Edge Cases & Polish
- Issues: #4, #15, #17, #22, #24, #26, #28, #29
- Nice-to-have improvements for power users

---

*This review focuses on actionable, specific issues that can be addressed to significantly improve user experience.*
