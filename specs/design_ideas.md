# Design Ideas & Playground

A live playground for exploring UI/UX concepts for NativeCal components.

## Interactive Demo
Open `public/demo/ideas.html` in your browser to interact with the design variants for both **Event Popovers** and **Event Editors**.

## Variants Explored

The demo now supports toggling between two contexts: **Popover** (quick view) and **Editor** (full details).

### 1. Classic (Current)
-   **Popover:** Blue header, icon-heavy list.
-   **Editor:** Standard modal with gray header, grid layout for dates.
-   **Pros:** Consistent, familiar.
-   **Cons:** Can feel visually heavy.

### 2. Minimal (Apple/Clean)
-   **Popover:** All white, ample padding, bold typography.
-   **Editor:** Large headings, subtle borders, focus on input fields.
-   **Pros:** Very modern, reduces visual noise.
-   **Cons:** Requires careful spacing.

### 3. Modern (Notion/Linear)
-   **Popover:** Colorful tags, avatars, rich metadata layout.
-   **Editor:** Sidebar layout or split view, emphasizing structure and metadata.
-   **Pros:** Feels "Pro", attractive for teams.
-   **Cons:** Complex DOM.

### 4. Glass (iOS/macOS)
-   **Popover:** Translucent background, blur effect.
-   **Editor:** Centered glass panel, large inputs, icon-driven layout.
-   **Pros:** Premium aesthetic.
-   **Cons:** Legibility depends on background.

### 5. Dark (Developer/CLI)
-   **Popover:** Dark mode, monospace font, "json" style header.
-   **Editor:** Vim/Terminal inspired interface, high contrast.
-   **Pros:** Appeals to technical users.
-   **Cons:** Very niche.

## Recommendation
For the **Editor Modal**, the **Minimal** or **Modern** variants are strong contenders. The **Classic** modal is functional but dated. The **Modern** variant's use of a sidebar (if space permits) or structured sections helps manage complex event details (recurrence, attendees, etc.) effectively.