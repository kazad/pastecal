# Native Vue.js Calendar Component Spec

## Objective
Replace the dependency on the heavy Syncfusion Schedule component with a lightweight, native Vue.js implementation (`NativeCal`) that replicates the specific features used in PasteCal.

## Motivation
-   **Performance:** Reduce bundle size and initial load time.
-   **Control:** Full control over rendering, styling, and behavior without fighting vendor overrides.
-   **Simplicity:** Remove unused features and complexity.

## Features to Support (Parity with Current Usage)

### 1. Views
The component must support the following views, switchable via a toolbar or prop:
-   **Day:** Vertical time grid for a single day.
-   **Week:** Vertical time grid for 7 days.
-   **Month:** Standard grid, 7 columns x 5-6 rows. Events as bars (multi-day) or dots/text.
-   **Custom:** Support for variable duration views (e.g., "3 Months", "12 Weeks").
    -   *Logic:* Essentially a variation of Month or Week view with a custom date range.
-   **Year:** High-level overview (heatmap or 12 mini-months).
-   **Agenda:** List of events in chronological order.

### 2. Event Rendering & Data
-   **Data Source:** Accept an array of Event objects.
    -   Properties: `id`, `title`, `start` (ISO string), `end` (ISO string), `isAllDay`, `type` (color category), `recurrenceRule`.
-   **Color Coding:** Events must be styled based on their `type` (1-8), mapping to CSS variables or a prop-defined palette.
-   **Reactivity:** Updates to the data source must immediately reflect in the UI.

### 3. Interactions
-   **Navigation:** Next/Prev/Today buttons.
-   **Selection:** Click empty cell to create event (opens dialog).
-   **Edit:** Click existing event to edit (opens dialog).
-   **Drag & Drop (Desktop):**
    -   Move event to different time/day.
    -   *Collision Detection:* Prevent overlap or handle visual stacking (cascading events).
-   **Resize (Desktop):**
    -   Extend/shorten event duration from bottom handle.

### 4. Editor (Popup)
A custom modal replacement for the Syncfusion editor.
-   **Fields:**
    -   Subject (Text)
    -   Start/End Time (Date/Time pickers)
    -   All Day (Checkbox)
    -   Type (Color picker/Dropdown)
    -   Description (Textarea)
    -   Recurrence (Basic RRULE generator: Daily, Weekly, Monthly).

### 5. Configuration (Props)
-   `currentView`: String ('Month', 'Week', etc.)
-   `selectedDate`: Date object.
-   `startHour`: String (e.g., '05:00') for vertical views.
-   `firstDayOfWeek`: Number (0=Sun, 1=Mon).
-   `timeFormat`: String ('12' or '24').
-   `readOnly`: Boolean (disables drag/drop, add/edit).

## Architecture & Tech Stack

-   **Framework:** Vue.js 3 (Composition API).
-   **Styling:** Tailwind CSS (Grid/Flexbox for layout).
-   **Date Math:** Native `Date` or lightweight lib like `date-fns` (already using `chrono-node` for parsing, but `date-fns` is good for grid math).
-   **Recurrence:** `rrule.js` (standard for RRULE handling).

## Implementation Complexity Analysis

| Feature | Difficulty | Notes |
| :--- | :--- | :--- |
| **Month Grid** | Low | CSS Grid makes this easy. Logic for multi-day event bars crossing rows is the tricky part. |
| **Week/Day Grid** | Medium | Absolute positioning for events based on time. |
| **Event Stacking** | High | Calculating `left` and `width` for overlapping events in vertical views (the "Tetris" packing problem). |
| **Drag & Drop** | High | Mapping mouse coordinates to time slots + shadow preview. Use `useDraggable` or HTML5 DnD. |
| **Recurrence** | Medium | Expanding RRULEs into instances for the visible range. |
| **Custom Views** | Low | If Grid logic is generic, "12 Weeks" is just "Week View" with `days = 84`. |

## Prototype Roadmap

1.  **Scaffold:** Basic `NativeCalendar.vue` component.
2.  **Month View:** Render a static grid of days.
3.  **Navigation:** Switch months.
4.  **Week View:** Render vertical time slots.
5.  **Event Rendering:** Place absolute divs for events.
6.  **Interactions:** Click to log time/event.