# Code Cleanup & Improvement Status

This document tracks code cleanup and refactoring tasks for `public/index.html`.

## Cleanup Status Table

| Category | Task | Status | Notes |
| :--- | :--- | :--- | :--- |
| **HTML/Structure** | **Remove Duplicate `quick-add` (FAB)** | 🟢 **Done** | Verified removed. |
| **HTML/Structure** | **Consolidate Title Editing Logic** | 🟢 **Done** | Unified `handleTitleClick` logic in `CalendarTitle` component. |
| **HTML/Structure** | **Standardize Icons** | 🟢 **Done** | Created `HelpIcon`, `SearchIcon`, `ShareIcon`, `NotesIcon`, `ChevronDownIcon`, `CloseIcon` components and replaced inline SVGs. Consistent sizing applied to mobile menu icons. |
| **HTML/Structure** | **Standardize Custom Elements** | 🟢 **Done** | Replaced custom HTML tags (e.g., `<topbar>`, `<logo>`, `<buttonarea>`, `<panel>`) with standard `<div>` elements for improved architectural correctness and to prevent potential Vue rendering issues. |
| **HTML/Structure** | **Consolidate Share/Claim Logic** | 🟢 **Done** | Extracted share/claim UI logic into a single `ShareOrClaimUI` component. |
| **Styles** | **Consolidate `<style>` Blocks** | 🟢 **Done** | Merged all styles into a single block in `<head>`. |
| **Styles** | **Migrate Inline Styles to Tailwind** | 🟡 **In Progress** | Some inline styles remain, but major blocks cleaned up. |
| **JS/Logic** | **Refactor `CalendarVueApp`** | 🟡 **Partial** | Helpers extracted, `ShareOrClaimUI` component created, but `CalendarVueApp` is still large. |
| **JS/Logic** | **Modernize JS Syntax** | 🟢 **Done** | Replaced `var` with `let`/`const` in `data()` and helper functions. |
| **JS/Logic** | **Clean Up `console.log`** | 🟡 **Partial** | Left some critical debugging logs, removed/commented some verbose ones. |
| **JS/Logic** | **Extract Helper Functions** | 🟢 **Done** | Created `Utils` object (`debounce`, `sanitizeUrl`, `randomID`, `uuidv4`, `parseDate`). |
| **Feature** | **Mobile Header Implementation** | 🟢 **Done** | New layout with App Nav, Title Row, and Claim URL row implemented. Mobile title truncation fixed with Flexbox layout. |
| **Feature** | **Mobile Menu (...)** | 🟢 **Done** | Kebab menu added with consistent icon sizing. |
| **Prototype** | **NativeCal Implementation** | 🟢 **Done** | Functional prototype in `public/nativecal/`. |

## Recent Changes
*   **Consolidated Styles:** Merged theme, general, and component styles.
*   **Utils Object:** Namespace helper functions to avoid global pollution.
*   **Icon Components:** Standardized all header icons as Vue components.
*   **JS Modernization:** Switched to `let`/`const` for cleaner scope handling.
*   **Mobile Header Fix:** Refactored mobile header from absolute positioning to Flexbox, resolving title truncation issues.
*   **Share/Claim Component:** Centralized "Share vs Claim" logic into a dedicated `ShareOrClaimUI` component.
*   **Standardized Custom Elements:** Replaced non-standard HTML tags with `<div>` elements for improved architectural correctness.