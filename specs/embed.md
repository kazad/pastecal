# PasteCal Embed Specification

## Overview
This specification outlines the plan to allow users to easily embed PasteCal calendars into other websites (e.g., Notion, personal sites, project management tools) via an `<iframe>`.

The goal is to provide a clean, focused view of the calendar that integrates well with various host environments, stripping away non-essential application UI (like the "PasteCal" branding header, create buttons, etc.) when in embed mode.

## Embedding Method
The primary method will be an **Iframe**.

**Example Code:**
```html
<iframe 
  src="https://pastecal.com/view/YOUR_CALENDAR_ID?embed=true&view=month" 
  width="100%" 
  height="600" 
  frameborder="0" 
  style="border: 1px solid #eee; border-radius: 8px;">
</iframe>
```

## URL Structure & Parameters

We will support a standard set of query parameters to customize the embedded view. These parameters should work on both read-only (`/view/ID`) and editable (`/ID`) links, though read-only is the primary use case.

### Base URL
*   **Read-Only:** `https://pastecal.com/view/<slug>`
*   **Editable:** `https://pastecal.com/<slug>`

### Query Parameters

| Parameter | Values | Default | Description |
| :--- | :--- | :--- | :--- |
| `embed` | `true`, `1` | `false` | Triggers "Embed Mode". Hides the top application bar (Logo, Help, Recents). |
| `view` / `v` | `month`, `week`, `day`, `agenda`, `year` | `month` (or cal default) | Sets the initial calendar view. |
| `date` / `d` | `YYYY-MM-DD` | Today | Sets the initial focused date. |
| `theme` | `light`, `dark`, `auto` | `auto` | Forces a specific color theme. |
| `header` | `true`, `false` | `true` | If `false`, hides the calendar title and internal navigation toolbar (extreme minimal mode). |
| `startDay` | `0` (Sun), `1` (Mon) | User/Locale default | Overrides the first day of the week. |
| `color` | Hex Code (e.g., `3b82f6`) | Default Blue | *Future:* Override the primary accent color to match host site. |

## UI/UX Adjustments for Embed Mode

When `?embed=true` is detected:

1.  **Hide Global Top Bar:** The main "PasteCal" logo, "Recent Calendars" dropdown, and top-right app actions (Help, Settings icon) should be hidden.
2.  **Simplified Calendar Header:**
    *   Keep the Title (e.g., "Marketing Schedule").
    *   Keep View Switcher (Month/Week/Day) and Date Navigation (< Today >).
    *   Add a small "Powered by PasteCal" link in the footer or corner if the top bar is removed, to maintain brand visibility.
3.  **Responsive Height:** The calendar should adapt to the iframe height.
    *   *Agenda View* needs infinite scroll or fit-to-container.
    *   *Month/Week View* should manage internal scrolling if the iframe is short.
4.  **Background:** Consider transparent background support (`theme=transparent`) so it blends into the host page.

## Technical Implementation Plan

### 1. Logic Updates (`public/index.html` & `index.js`)
*   **URL Parsing:** Update the `data()` function in `CalendarVueApp` to parse the new `embed`, `theme`, and `header` params.
*   **State:** Add `isEmbed` boolean to the Vue app state.
*   **Theme Handling:** Modify `applyTheme()` to prioritize the URL param over system preference/local storage.

### 2. Template Updates (`public/index.html`)
*   **Conditional Rendering:**
    *   Wrap the `<topbar>` element in `v-if="!isEmbed"`.
    *   Add a new minimal header component for Embed Mode (showing Title + Nav only) if standard header logic is too coupled with app navigation.
*   **CSS Classes:** Add a root class `.mode-embed` to `<body>` or `#app` to facilitate CSS overrides (e.g., removing padding/margins).

### 3. "Get Embed Code" Feature
*   Add an **"Embed"** tab/button to the **Share** modal.
*   **UI:** Provide a configuration interface:
    *   Preview of the embed.
    *   Toggles for "Show Title", "Dark Mode", "Default View".
    *   "Copy Code" button generating the `<iframe>` tag.

## Example Scenarios

**Scenario A: Notion Dashboard**
User wants to see their "Content Calendar" inside Notion.
*   URL: `https://pastecal.com/view/content-cal?embed=true&view=month&theme=light`
*   Result: A clean month grid. No PasteCal top bar.

**Scenario B: Personal Website (Sidebar)**
User wants to show their availability (Agenda) in a sidebar.
*   URL: `https://pastecal.com/view/my-availability?embed=true&view=agenda&header=false`
*   Result: A simple list of upcoming slots. Very minimal.

## Security
*   **X-Frame-Options:** Ensure `X-Frame-Options` is NOT set to `DENY` or `SAMEORIGIN` on the hosting provider (Firebase Hosting) for these routes.
*   **Content Security Policy (CSP):** Ensure `frame-ancestors` allows embedding (or is wildcard `*`).
