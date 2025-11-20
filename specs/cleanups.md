# Code Cleanup & Improvement Status

This document tracks code cleanup and refactoring tasks for `public/index.html`.

## Cleanup Status Table

| Category | Task | Status | Notes |
| :--- | :--- | :--- | :--- |
| **HTML/Structure** | **Remove Duplicate `quick-add` (FAB)** | 🟢 **Done** | Verified removed. |
| **HTML/Structure** | **Consolidate Title Editing Logic** | 🟢 **Done** | Unified `handleTitleClick` logic in new `TopBar` component (future) or existing methods. |
| **HTML/Structure** | **Standardize Icons** | 🟢 **Done** | Created `HelpIcon`, `SearchIcon`, `ShareIcon`, `NotesIcon`, `ChevronDownIcon`, `CloseIcon` components and replaced inline SVGs. |
| **Styles** | **Consolidate `<style>` Blocks** | 🟢 **Done** | Merged all styles into a single block in `<head>`. |
| **Styles** | **Migrate Inline Styles to Tailwind** | 🟡 **In Progress** | Some inline styles remain, but major blocks cleaned up. |
| **JS/Logic** | **Refactor `CalendarVueApp`** | 🟡 **Partial** | Helpers extracted, but `CalendarVueApp` is still large. |
| **JS/Logic** | **Modernize JS Syntax** | 🟢 **Done** | Replaced `var` with `let`/`const` in `data()` and helper functions. |
| **JS/Logic** | **Clean Up `console.log`** | 🟡 **Partial** | Left some critical debugging logs, removed/commented some verbose ones. |
| **JS/Logic** | **Extract Helper Functions** | 🟢 **Done** | Created `Utils` object (`debounce`, `sanitizeUrl`, `randomID`, `uuidv4`, `parseDate`). |
| **Feature** | **Mobile Header Implementation** | 🟢 **Done** | New layout with App Nav, Title Row, and Claim URL row implemented. |
| **Feature** | **Mobile Menu (...)** | 🟢 **Done** | Kebab menu added. |
| **Prototype** | **NativeCal Implementation** | 🟢 **Done** | Functional prototype in `public/nativecal/`. |

## Recent Changes
*   **Consolidated Styles:** Merged theme, general, and component styles.
*   **Utils Object:** Namespace helper functions to avoid global pollution.
*   **Icon Components:** Standardized all header icons as Vue components.
*   **JS Modernization:** Switched to `let`/`const` for cleaner scope handling.