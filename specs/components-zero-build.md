# Zero-Build Component Architecture for PasteCal

## Objective
Refactor the monolithic `public/index.html` into smaller, manageable files **without introducing a Node.js build step** (Webpack, Vite, etc.). We want to maintain the simplicity of "View Source -> Edit" while improving developer ergonomics.

## Strategy: Native ES Modules + Vue 3 SFC Loader (Runtime)

We will leverage modern browser support for ES Modules (`<script type="module">`) and Vue 3's capability to load components at runtime.

### Core Technologies
1.  **ES Modules (ESM):** Split JavaScript logic into `.js` files imported natively.
2.  **`vue3-sfc-loader`:** A library that allows loading `.vue` Single File Components directly in the browser without a build step.
    *   *Pros:* Keeps the familiar `<template>`, `<script>`, `<style>` structure.
    *   *Cons:* Slight runtime performance hit (compilation happens in browser), but acceptable for this scale.
3.  **Alternative (Simpler):** Global Component Registration via `.js` files containing template strings.

## Proposed Directory Structure

```
public/
├── index.html          # Main entry point (skeleton)
├── css/
│   ├── main.css        # Global styles
│   └── syncfusion.css  # Vendor overrides
├── js/
│   ├── app.js          # Main Vue app initialization
│   ├── store.js        # Shared state (reactive)
│   ├── utils.js        # Helper functions (date, uuid)
│   ├── firebase.js     # Firebase init & service
│   └── components/     # Vue Components
│       ├── TopBar.js
│       ├── CalendarView.js
│       ├── SettingsPanel.js
│       └── ...
└── nativecal/          # (Separate prototype, remains as is)
```

## Implementation Plan

### Step 1: Extract Styles
Move the massive `<style>` blocks from `index.html` into `public/css/main.css`.
*   *Benefit:* Immediate reduction of ~500 lines from `index.html`.

### Step 2: Extract Helper Logic
Move pure functions (`uuidv4`, `parseDate`, `debounce`) to `public/js/utils.js`.
*   *Export:* `export const uuidv4 = ...`
*   *Import:* `import { uuidv4 } from './utils.js'`

### Step 3: Extract Firebase Service
Move `CalendarDataService` and `SlugManager` to `public/js/firebase.js`.

### Step 4: Component Extraction (The "JS Template" Pattern)
Since we want to avoid `vue3-sfc-loader` complexity if possible, we can use standard JS files that export Vue component objects with template strings.

**Example: `public/js/components/TopBar.js`**
```javascript
export default {
    name: 'TopBar',
    template: `
        <nav class="flex justify-between ...">
            <!-- HTML content -->
        </nav>
    `,
    props: ['title', 'isReadOnly'],
    emits: ['toggle-share'],
    setup(props, { emit }) {
        // Logic
        return { ... }
    }
}
```

**Example: `public/js/app.js`**
```javascript
import { createApp } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js';
import TopBar from './components/TopBar.js';
import { CalendarDataService } from './firebase.js';

const app = createApp({
    components: { TopBar },
    setup() {
        // Root logic
    }
});

app.mount('#app');
```

### Step 5: Refactor `index.html`
The `index.html` should eventually look like this:

```html
<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="/css/main.css">
    <!-- CDNs -->
</head>
<body>
    <div id="app">
        <top-bar ...></top-bar>
        <router-view></router-view> <!-- If we add simple routing -->
        <!-- OR -->
        <main-calendar ...></main-calendar>
    </div>

    <script type="module" src="/js/app.js"></script>
</body>
</html>
```

## Migration Checklist

1.  [ ] Create `public/css/main.css` and move styles.
2.  [ ] Create `public/js/utils.js` and move helpers.
3.  [ ] Create `public/js/firebase.js` and move `CalendarDataService`.
4.  [ ] Refactor `index.html` to use `<script type="module">`.
5.  [ ] Extract `TopBar` component first as a proof of concept.
6.  [ ] Extract `SettingsPanel` and `QuickAdd`.
7.  [ ] Leave the main Syncfusion Scheduler logic in `app.js` initially, then move to `CalendarView.js`.

## Risks & Mitigations

*   **Caching:** Browsers cache ES modules aggressively.
    *   *Mitigation:* Not an issue for local dev. For production, we might need a simple version query string (manual or tiny script) if updates aren't reflecting.
*   **Network Requests:** Many small files = many HTTP requests (HTTP/1.1 waterfall).
    *   *Mitigation:* HTTP/2 handles this well. PasteCal is simple enough that ~10-15 files won't hurt significantly.
*   **Syncfusion Global:** Syncfusion relies on global `ej` namespace.
    *   *Mitigation:* Keep Syncfusion script in `<head>` (non-module) so `window.ej` is available to modules.
