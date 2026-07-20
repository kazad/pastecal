# Calendar View Design Ideas

A live playground for exploring different architectural styles for the calendar grid itself.

## Interactive Demo
Open `public/demo/views.html` in your browser to interact with the layout variations.

## Concepts Explored

### 1. Classic (The Default)
-   **Structure:** Standard CSS Grid with explicit border collapsing (or simulated via negative margins).
-   **Aesthetic:** Familiar, utilitarian, dense.
-   **Use Case:** General purpose calendar applications.

### 2. Cards (Floating Cells)
-   **Structure:** Uses `gap` in the grid layout instead of borders.
-   **Background:** The container background color bleeds through the gaps to create visual separation.
-   **Aesthetic:** Modern, softer, friendly. "Each day is a container".
-   **Use Case:** Consumer apps, less dense schedules where whitespace is appreciated.

### 3. Linear (High Contrast / Dark)
-   **Structure:** Ultra-thin borders, high contrast text, dark mode default.
-   **Aesthetic:** Developer-centric, precise, "Pro" tool feel.
-   **Use Case:** Technical planning, engineering roadmaps.

### 4. Glass (Translucent)
-   **Structure:** Semi-transparent backgrounds with `backdrop-filter: blur()`.
-   **Aesthetic:** Premium, OS-native feel (macOS/iOS).
-   **Use Case:** Dashboards, personal home screens.

## Implementation Notes
The demo uses a `gapMode` boolean to switch between standard borders (where cells touch) and floating cells (where `grid-gap` creates separation). This is a powerful technique to radically change the feel of the calendar with minimal CSS changes.
