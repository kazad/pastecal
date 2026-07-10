# PasteCal on iOS: PWA vs. Native App — Plan

**Recommendation: build the PWA, skip the native iOS app (for now).**
If App Store presence ever becomes worth it, wrap the finished PWA in Capacitor
rather than writing a Swift app.

## Why not a native iOS app

PasteCal's entire value proposition is *zero friction*: a calendar is a URL,
sharing is pasting a link, there is no login. A native app inverts that —
"download this app from the App Store" is more friction than the product's
core promise allows. Concretely:

- **Distribution friction contradicts the product.** A recipient of a
  `pastecal.com/xyz` link can use it instantly in Safari. An app can't make
  that faster; it can only add a step.
- **Cost/maintenance is disproportionate.** $99/yr developer account, App
  Store review on every release, a second codebase (or a wrapper build
  pipeline) — for a project that today has *no build step at all* (Vue 3 +
  Syncfusion + Firebase, all from CDNs, deployed as static files).
- **Nothing PasteCal does needs native APIs.** No camera, no HealthKit, no
  widgets (yet). The one thing users might want natively — the calendar in
  their calendar app — is already solved better by the existing **ICS feed**
  (`/{id}.ics` via `generateICSV2`), which subscribes a PasteCal into Apple
  Calendar, Google Calendar, etc.
- **iOS PWA support is now good enough.** Since iOS 16.4, home-screen web
  apps get Web Push + notifications; installed web apps get their own storage
  that is exempt from Safari's 7-day ITP eviction; standalone display and
  service workers work.

What a native app *would* buy — home-screen widgets, Siri/App Intents, Live
Activities, App Store discoverability — is real but is "phase 5" material,
and Capacitor gets us there from the same codebase if demand shows up.

## Current state (audit)

What already exists:

- `public/site.webmanifest` is linked from `index.html`, but **broken**:
  empty `name`/`short_name`, icon entry pointing at
  `web-app-manifest-384x384.png` (doesn't exist — the real file is
  `web-app-manifest-512x512.png`), a `//` path typo, no `start_url`, no `id`.
- Apple touch icon and `theme-color` meta are present.
- **No service worker** → no offline, no install eligibility on Android/desktop
  Chrome, nothing cached (hosting headers are `no-cache, no-store` for
  html/js/css).
- All runtime deps load from third-party CDNs (Vue, Syncfusion ~1.5MB+,
  Firebase compat) → an offline PWA must cache cross-origin assets or
  self-host them.
- Touch drag/resize is deliberately disabled on mobile (`app.js:430`) to
  prevent accidental edits — mobile editing today is tap→dialog only.
- Private calendars already persist to localStorage; shared calendars are
  Firebase RTDB with live sync. Firebase RTDB has a built-in in-memory offline
  queue but no disk persistence on web.
- `nativecal/` is an in-progress lightweight Vue replacement for Syncfusion —
  directly relevant, since Syncfusion is the main obstacle to a fast,
  touch-friendly mobile experience.

## Plan

### Phase 1 — Installable PWA (quick wins, ~1 day)

Goal: "Add to Home Screen" produces a real app-like experience. No behavior
change for regular web users.

1. **Fix the manifest** (`site.webmanifest`):
   - `name: "PasteCal"`, `short_name: "PasteCal"`, `description`
   - `start_url: "/"`, `id: "/"`, `scope: "/"`
   - `display: "standalone"`, `background_color`, `theme_color`
   - Correct icon entries: 192 + 512 (both exist in `public/img/icons/`),
     add a `purpose: "maskable"` variant of the 512 icon.
2. **iOS meta tags** in `index.html`:
   - `<meta name="apple-mobile-web-app-capable" content="yes">`
   - `<meta name="apple-mobile-web-app-status-bar-style" content="default">`
   - `<meta name="apple-mobile-web-app-title" content="PasteCal">`
   - `viewport-fit=cover` + CSS `env(safe-area-inset-*)` padding so the
     toolbar isn't under the notch/home indicator in standalone mode.
3. **Minimal service worker** (`public/sw.js`):
   - Network-first for navigations and same-origin js/css (respects the
     current "always fresh" deployment model), falling back to cache offline.
   - Cache-first (stale-while-revalidate) for CDN assets (Vue, Syncfusion,
     Firebase) and images — these are version-pinned URLs, safe to cache hard.
   - A small offline fallback page for cold offline navigations.
   - Registration guarded so it doesn't interfere with tests/emulator.
4. **Start-URL behavior**: launching from home screen should reopen the last
   calendar. `start_url: "/"` + a tiny redirect using the existing
   "recent/last calendar" localStorage state (or add it — it's already on the
   NOTES.md wishlist as "Remember recents").

Exit criteria: Lighthouse PWA installability passes; iOS Add-to-Home-Screen
opens standalone, correctly named/iconed, notch-safe; airplane-mode relaunch
shows the app shell with last-known data instead of a Safari error page.

### Phase 2 — Mobile UX polish (the actual payoff, ~3–5 days)

Installability is table stakes; feel is what makes it "an app."

1. **In-app navigation safety**: standalone mode has no browser back button.
   Audit dialogs/views so nothing traps the user (close buttons everywhere,
   handle `popstate`).
2. **Touch-native editing**: keep accidental-edit protection, but add
   deliberate gestures — long-press on a slot to create, long-press an event
   to move (Syncfusion permitting; this gets much easier post-nativecal).
3. **Bottom-reachable controls on phones**: quick-add button (exists) sized
   and placed for thumbs; consider a compact bottom toolbar in standalone
   mode.
4. **Default to Day/Agenda view on small screens** (respecting `?v=` param).
5. **`display-mode: standalone` media query** to hide web-only chrome
   (marketing header/footer, "open in app" hints) when installed.

### Phase 3 — Real offline (medium effort, ~1 week)

1. **Read offline**: mirror the active calendar's events to
   localStorage/IndexedDB on every RTDB sync; hydrate from the mirror on load
   before Firebase connects (also improves *online* perceived load time).
2. **Write offline (v1: safe + honest)**: queue writes in IndexedDB while
   offline, replay on reconnect, show a clear "offline — changes will sync"
   badge. Last-write-wins per event ID; NOTES.md already flags "safer
   writing / conflict avoidance" as future work — full conflict resolution is
   out of scope here.
3. Private (localStorage-only) calendars already work offline once assets are
   cached by Phase 1's service worker — verify and test.

### Phase 4 — Notifications & engagement (optional, after 1–3 prove out)

1. **Event reminders via Web Push** (iOS 16.4+ requires the PWA to be
   installed and permission requested from a user gesture): FCM + a scheduled
   Cloud Function scanning upcoming events for subscribed devices. This is the
   first feature that needs per-device identity — design it as opt-in
   per-calendar-per-device, no accounts.
2. **Badging API** for today's event count (supported on installed iOS PWAs
   since iOS 16.4/17).

### Phase 5 — Only if demand appears: Capacitor wrapper

If App Store presence, widgets, or Siri integration become worth it, wrap the
same `public/` app in Capacitor (~1–2 weeks incl. review): one codebase, real
push tokens, WidgetKit via a small native extension. Decide *after* PWA
metrics show installs/retention. A Swift rewrite is not on the table.

## Dependencies & risks

- **Syncfusion is the biggest drag on mobile** — heavy (slow first load,
  which caching mitigates but doesn't fix), and touch interactions fight it.
  Finishing **nativecal** multiplies the value of Phases 2–3; sequence it in
  parallel if possible, but don't block Phase 1 on it.
- **iOS install friction**: there's no install prompt on iOS — users must use
  Share → "Add to Home Screen." Mitigate with a small dismissible hint shown
  on iOS Safari (not in standalone mode).
- **Service worker vs. no-cache deployment model**: network-first for
  same-origin code keeps deploys instant; add a version bump + `skipWaiting`
  flow so stale SWs never pin an old app.
- **Multiple calendars per user**: offline mirroring and start-url handling
  should key off calendar ID from day one to avoid a single-calendar
  assumption baked into storage.
