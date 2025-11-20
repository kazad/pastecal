# PasteCal Testing Strategy

## Overview
PasteCal is currently built as a lightweight, serverless application using direct CDN imports (Vue.js, Syncfusion) in a single HTML file. This architecture simplifies deployment but makes traditional component unit testing (like standard Vue CLI apps) harder.

Therefore, our primary testing strategy relies on **End-to-End (E2E) Testing** to verify user flows, supplemented by **Unit Tests** for backend logic (Firebase Functions) and complex frontend logic (NativeCal algorithms).

## 1. End-to-End (E2E) Testing
**Tool:** [Playwright](https://playwright.dev/)
**Scope:** `public/index.html` (Legacy/Current) and `public/nativecal/` (Prototype).

### Critical User Flows to Test:
1.  **Calendar Creation:**
    *   Load homepage.
    *   Enter a custom slug or click "Claim".
    *   Verify redirection to `/slug`.
    *   Verify "Welcome" state (empty calendar).
2.  **Event Management (CRUD):**
    *   Click to create an event (Month/Week view).
    *   Drag-and-drop event (move time/date).
    *   Resize event (duration).
    *   Edit event title.
3.  **View Switching:**
    *   Toggle between Month, Week, Day, Agenda.
    *   Verify correct date range is displayed.
4.  **Persistence:**
    *   Create event -> Reload page -> Verify event exists.
5.  **Read-Only Mode:**
    *   Access via `/view/slug`.
    *   Verify editing tools (drag handles, click-to-create) are disabled.

### Directory Structure
```
test/
  e2e/
    calendar-creation.spec.js
    event-interaction.spec.js
    read-only.spec.js
  playwright.config.js
```

## 2. Backend Unit Testing
**Tool:** [Mocha](https://mochajs.org/) / [Jest](https://jestjs.io/) + [Firebase Emulators](https://firebase.google.com/docs/emulator-suite)
**Scope:** `functions/`

### Key Scenarios:
*   **Calendar Lookup:** Verify case-insensitive slug handling.
*   **Public Link Creation:** Verify generation of read-only view IDs.
*   **Sanitization:** Ensure inputs are cleaned before database writes.

## 3. Frontend Logic Unit Testing (Future)
**Tool:** [Vitest](https://vitest.dev/)
**Scope:** `public/nativecal/` (Migrating logic to ES modules)

As we move logic out of the monolithic `index.html` into `NativeCal`, we should extract pure functions for testing:
*   **Date Math:** `getWeekCells(date)`, `isOverlapping(eventA, eventB)`.
*   **Coordinate Math:** `minutesToPixels(min)`, `pixelsToMinutes(px)`.

## 4. Visual Regression Testing
**Tool:** Playwright (Snapshots)

*   Capture screenshots of the Calendar Grid in different viewports (Mobile, Desktop).
*   Compare against baseline to detect CSS regressions (especially given the heavy overrides on Syncfusion styles).

## How to Run Tests (Proposed)

1.  **Start Local Server:**
    ```bash
    # Serves public/ directory on port 8000
    python3 -m http.server 8000 --directory public
    ```

2.  **Run Playwright:**
    ```bash
    npx playwright test
    ```

3.  **Run Firebase Tests:**
    ```bash
    cd functions && npm test
    ```
