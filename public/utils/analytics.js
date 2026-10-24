// Analytics — a thin, provider-agnostic seam.
//
// Call sites only ever use Analytics.track('name', {params}). Where those events
// end up is decided here, so swapping GA4 for Cloudflare Analytics Engine, Plausible,
// or a self-hosted collector is a change to SINKS below and nothing else.
//
// Design notes:
//   - We track DECISIONS, not actions. An event earns its place only if it can
//     change a product decision. `search_opened` would not earn it; `notes_edited`
//     does, because nobody currently knows whether notes are used at all.
//   - `calendar_created` was originally left out, on the grounds that
//     slug_claimed + slug_autoassigned already fire at persist time. In practice
//     that derivation is fragile: the read-only-link flow emits the same two
//     names (separated only by `where`), so summing them without filtering
//     overcounts. It is also the one number pro.md's whole model rests on. It is
//     now its own event.
//   - The open question is whether the ~8% custom-slug rate is a discoverability
//     failure. Counting claims can't answer that; you need the denominator of
//     people who were auto-assigned a name and never asked. Hence
//     `slug_autoassigned` and `slug_prompt_shown`.
//   - Calendar shape rides along as PARAMS on a few events rather than spawning
//     many event names, so questions like "do deep users claim names more?" are
//     a segmentation instead of a new metric.

const Analytics = {
    // ---- configuration -------------------------------------------------------

    // Set false to silence everything (tests, local dev, internal browsing).
    enabled: true,

    // Sinks receive (name, params). Add or remove freely; each is independent and
    // a throwing sink must never break the caller.
    SINKS: {
        /**
         * Google Analytics 4.
         *
         * Sends via gtag(), defining it if nothing else has. The obvious-looking
         * alternative -- dataLayer.push({event: name, ...}) -- does NOT reach GA4
         * on its own: a dataLayer push is only an event GTM can listen for, and
         * forwarding it requires a matching trigger and GA4 event tag configured
         * in the GTM container for every event name. Without those it lands in
         * the dataLayer and stops there.
         *
         * That is exactly what happened here: verified against production, the
         * custom events reached window.dataLayer while the only hit sent to
         * /g/collect was page_view. GTM loads gtm.js but does not define
         * window.gtag, so the old preference order silently chose the path that
         * never delivered.
         *
         * The gtag shim below is the standard snippet. It shares the same
         * dataLayer GTM already created, so both continue to work.
         */
        ga4(name, params) {
            // index.html defines the shim and configures the stream before this
            // ever runs. The guard is for the case where that block was skipped
            // (test mode, ?no-analytics) -- there, dropping the event is correct.
            if (typeof window.gtag === 'function') {
                window.gtag('event', name, params);
            }
        },

        // Cloudflare Analytics Engine / any HTTP collector. Off until a URL is set.
        // Batched rather than one request per event: queue() only touches an
        // in-memory array, so the call site can never pay for or fail on network.
        http(name, params) {
            if (!Analytics.COLLECTOR_URL) return;
            Analytics.queue(name, params);
        },

        /**
         * Microsoft Clarity (loaded by GTM, project fu7pi5a92j). Each event becomes a Clarity
         * custom event, so recordings and heatmaps can be filtered by it and the buying steps
         * form a funnel. Names only: params stay with GA4 and /api/collect. A few moments
         * also 'upgrade' the session so Clarity keeps that recording even when it samples.
         * Calls before Clarity loads wait in the queue its own snippet drains (stub below).
         */
        clarity(name) {
            if (typeof window.clarity !== 'function') return;
            window.clarity('event', name);
            if (Analytics.CLARITY_KEEP.includes(name)) window.clarity('upgrade', name);
        },

        // Visible in devtools when debugging instrumentation.
        console(name, params) {
            if (Analytics.debug) console.log('[analytics]', name, params);
        },
    },

    // Which sinks are live. Order is irrelevant; all are best-effort.
    active: ['ga4', 'clarity', 'http', 'console'],

    // Sessions Clarity should always keep: the paid funnel and the editor leak.
    CLARITY_KEEP: ['pricing_getpro_picked', 'pro_lock_shown', 'pro_checkout_started', 'pro_checkout_failed', 'editor_abandoned'],

    /**
     * Label this visit's recording in Clarity (filters: hv, page, role). Values must be a few
     * fixed words; never a calendar name or anything typed, since a calendar's path is its key.
     */
    tag(key, value) {
        try {
            if (!this.enabled || typeof window.clarity !== 'function') return;
            window.clarity('set', key, String(value));
        } catch (e) { /* observational only */ }
    },

    COLLECTOR_URL: '/api/collect',
    debug: false,

    // ---- core ----------------------------------------------------------------

    // HARD RULE: this function must never throw and must never block.
    //
    // Analytics is strictly observational -- a broken sink, a malformed param, or a
    // missing global must not affect a single calendar operation. Everything below
    // is wrapped, and delivery is deferred off the caller's stack so a slow sink
    // can't stall a save or a render.
    track(name, params = {}) {
        try {
            if (!this.enabled) return;

            let enriched;
            try {
                enriched = Object.assign({}, this.baseParams(), params);
            } catch (err) {
                enriched = params || {}; // baseParams failing must not lose the event
            }

            this.defer(() => {
                for (const key of this.active) {
                    const sink = this.SINKS[key];
                    if (typeof sink !== 'function') continue;
                    try {
                        sink(name, enriched);
                    } catch (err) {
                        if (this.debug) console.warn('[analytics] sink failed:', key, err);
                    }
                }
            });
        } catch (err) {
            // Absolute backstop. Never rethrow.
            if (this.debug) console.warn('[analytics] track failed:', name, err);
        }
    },

    // ---- batching (HTTP sink only) -------------------------------------------
    //
    // GA4 does its own batching, so this exists for the HTTP/Cloudflare path.
    // Enqueueing is pure memory -- no network, nothing that can throw at the call
    // site. Delivery happens on a timer, at a size threshold, or on page-hide.

    _queue: [],
    _flushTimer: null,
    BATCH_SIZE: 12,
    BATCH_MS: 10000,
    MAX_QUEUE: 200, // hard cap: never grow unbounded on a long-lived tab

    queue(name, params) {
        if (this._queue.length >= this.MAX_QUEUE) return; // drop, don't leak
        this._queue.push({ name, params, ts: Date.now(), path: location.pathname });

        if (this._queue.length >= this.BATCH_SIZE) {
            this.flush();
        } else if (!this._flushTimer && typeof setTimeout === 'function') {
            this._flushTimer = setTimeout(() => this.flush(), this.BATCH_MS);
        }
    },

    /**
     * Send everything queued. `beacon` must be true when the page may be going
     * away -- fetch() is canceled on unload, sendBeacon() survives it, and most
     * calendar sessions end with a tab close right after the interesting action.
     */
    flush(beacon) {
        try {
            if (this._flushTimer) {
                clearTimeout(this._flushTimer);
                this._flushTimer = null;
            }
            if (!this._queue.length || !this.COLLECTOR_URL) return;

            const batch = this._queue.splice(0, this._queue.length);
            const body = JSON.stringify({ events: batch });

            if (beacon && typeof navigator.sendBeacon === 'function') {
                navigator.sendBeacon(this.COLLECTOR_URL, new Blob([body], { type: 'application/json' }));
                return;
            }
            if (typeof fetch === 'function') {
                fetch(this.COLLECTOR_URL, {
                    method: 'POST',
                    body,
                    headers: { 'Content-Type': 'application/json' },
                    keepalive: true,
                }).catch(() => { /* dropped telemetry is never worth surfacing */ });
            }
        } catch (err) {
            if (this.debug) console.warn('[analytics] flush failed:', err);
        }
    },

    // Run work off the caller's stack so analytics can never add latency to, or
    // throw into, a calendar operation. Falls back to sync-in-try if neither
    // scheduler exists.
    defer(fn) {
        const safe = () => {
            try { fn(); } catch (err) {
                if (this.debug) console.warn('[analytics] deferred work failed:', err);
            }
        };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(safe, { timeout: 2000 });
        } else if (typeof setTimeout === 'function') {
            setTimeout(safe, 0);
        } else {
            safe();
        }
    },

    // Params attached to every event, so segmentation works without the call
    // sites having to remember to pass them.
    baseParams() {
        const base = { surface: window.__TEST__ ? 'test' : 'web' };
        // The native renderer (/beta, /nativecal) is on trial against Syncfusion: tag every
        // event so its error rate and usage can be segmented.
        if (/^\/(beta|nativecal)(\/|$)/.test(window.location.pathname)) base.renderer = 'native';
        if (this._hv) base.hv = this._hv;
        return base;
    },

    // ---- homepage experiment -------------------------------------------------
    //
    // One experiment at a time, to see which homepage leads more people to make and share a
    // calendar. None is running now; the next test adds a letter below. A
    // browser is put in a variant once and stays there, and every later event carries
    // it as `hv` -- so a calendar made under variant B still reports hv=b when its owner
    // comes back weeks later. That is what makes retention, not just clicks, comparable.
    // ?hv=<letter> previews a variant without changing the stored one.
    HOMEPAGE_VARIANTS: ['a'], // one homepage for now; add letters to run the next test
    _hv: null,

    homepageVariant() {
        try {
            if (this._hv) return this._hv;
            const forced = new URLSearchParams(location.search).get('hv');
            if (this.HOMEPAGE_VARIANTS.includes(forced)) return forced;
            let v = null;
            try { v = localStorage.getItem('pc_hv'); } catch (e) { /* storage blocked */ }
            if (!this.HOMEPAGE_VARIANTS.includes(v)) {
                v = this.HOMEPAGE_VARIANTS[Math.floor(Math.random() * this.HOMEPAGE_VARIANTS.length)];
                try { localStorage.setItem('pc_hv', v); } catch (e) { /* in-memory for this visit */ }
            }
            this._hv = v;
            this.tag('hv', v);
            if (typeof window.gtag === 'function') window.gtag('set', 'user_properties', { homepage_variant: v });
            return v;
        } catch (err) {
            return 'a';
        }
    },

    // Read the stored variant on every page, so returning owners keep reporting it.
    loadHomepageVariant() {
        try {
            const v = localStorage.getItem('pc_hv');
            if (this.HOMEPAGE_VARIANTS.includes(v)) { this._hv = v; this.tag('hv', v); }
        } catch (e) { /* storage blocked */ }
    },

    // ---- bucketing -----------------------------------------------------------

    // Raw counts blow up dimension cardinality in every analytics system and are
    // useless as a breakdown. Buckets are what you actually segment on.
    bucketEvents(n) {
        if (!n) return '0';
        if (n < 3) return '1-2';
        if (n < 5) return '3-4';
        if (n < 20) return '5-19';
        if (n < 50) return '20-49';
        return '50+';
    },

    bucketVisits(n) {
        if (n <= 1) return '1';
        if (n <= 2) return '2';
        if (n <= 5) return '3-5';
        if (n <= 10) return '6-10';
        return '11+';
    },

    // How many calendars this browser has CREATED. Bucketed around the pricing
    // question rather than evenly: the only boundaries that matter are 1 vs 2+
    // (does anyone run more than one calendar at all) and 10 (the point a
    // bundled plan would stop covering them).
    bucketOwned(n) {
        if (!n) return '0';
        if (n === 1) return '1';
        if (n <= 3) return '2-3';
        if (n <= 10) return '4-10';
        return '11+';
    },

    // ---- the events ----------------------------------------------------------
    // Named helpers rather than raw track() calls, so the schema lives in one
    // place and call sites can't drift on param names.

    /**
     * A calendar silently received a generated slug. This is the denominator for
     * the whole naming question: how many people got a name they never chose.
     */
    slugAutoAssigned(calendar) {
        this.track('slug_autoassigned', {
            event_count_bucket: this.bucketEvents(calendar?.events?.length),
        });
    },

    /** A naming affordance was actually shown. Pairs with slug_claimed to give a rate. */
    slugPromptShown(where, calendar) {
        this.track('slug_prompt_shown', {
            where,
            event_count_bucket: this.bucketEvents(calendar?.events?.length),
        });
    },

    /** The user saw the naming affordance and moved on without naming. */
    slugPromptDismissed(where) {
        this.track('slug_prompt_dismissed', { where });
    },

    /** A custom name was successfully claimed. */
    slugClaimed(slug, calendar) {
        this.track('slug_claimed', {
            slug_length: slug ? slug.length : 0,
            event_count_bucket: this.bucketEvents(calendar?.events?.length),
        });
    },

    /** A claim was attempted and refused — high `taken` counts argue for suggestions. */
    slugClaimFailed(reason) {
        this.track('slug_claim_failed', { reason });
    },

    /**
     * Someone opened a calendar they've opened before. Return depth is the single
     * best predictor of willingness to pay -- see /kazumichi: 4 users, 1,261 views.
     */
    calendarReturned(calendar, visitNumber) {
        this.track('calendar_returned', {
            visit_bucket: this.bucketVisits(visitNumber),
            has_custom_slug: !!calendar?.options?.publicViewId
                && !this.looksGenerated(calendar.options.publicViewId),
            event_count_bucket: this.bucketEvents(calendar?.events?.length),
        });
    },

    /**
     * How many calendars this browser has created, reported once per session.
     *
     * Everything else here counts calendars; this counts PEOPLE who run more
     * than one. That distinction is the whole question behind a bundled plan:
     * if almost nobody owns a second calendar, a "10 calendars for $99" tier is
     * priced for a customer who doesn't exist, and per-calendar is the honest
     * model. Read off localStorage's `myCalendars`, which is never evicted, so
     * this is a true lifetime count for the browser rather than a 30-day window.
     *
     * Session-scoped deliberately: firing per page load would weight the number
     * toward whoever browses most, which is the opposite of what it measures.
     */
    calendarsOwned(count) {
        if (this._ownedReported) return;
        this._ownedReported = true;
        this.track('calendars_owned', {
            owned_bucket: this.bucketOwned(count),
        });
    },

    /** An event was added, with the path that created it. */
    eventAdded(source, calendar) {
        // Seconds from page load to the first event this session: how long the first minute takes.
        const first = !this._firstEventSent && typeof performance !== 'undefined';
        this._firstEventSent = true;
        this.track('event_added', {
            ...(first ? { first_event_seconds: Math.round(performance.now() / 1000) } : {}),
            source, // 'quick_add' | 'grid' | 'popup' | 'paste'
            event_count_bucket: this.bucketEvents(calendar?.events?.length),
        });
    },

    /** The event editor was closed without saving. */
    editorAbandoned() {
        this.track('editor_abandoned', {});
    },

    /** The calendar was shared or its link copied — precedes most multi-user use. */
    calendarShared(method) {
        this.track('calendar_shared', { method }); // 'copy' | 'native' | 'ics'
    },

    /**
     * A calendar was persisted to the server. THE top-of-funnel number, and the
     * one pro.md's MAU -> conversion model is built on.
     *
     * Deliberately separate from slug_claimed/slug_autoassigned even though all
     * three fire at the same moment: those two answer "did they choose a name",
     * this one answers "how many calendars exist", and the read-only-link flow
     * reuses the slug event names for something that is NOT a new calendar.
     */
    /** The homepage pitch was shown, and which section of it scrolled into view. */
    // The denominator for homepage conversion: one per visit, before anything else is read.
    // `where` is new or returning (has calendars in this browser).
    homepageViewed(kind) {
        this.track('homepage_viewed', { where: kind });
    },

    tourSeen(section) {
        this.track('tour_seen', { where: section });
    },

    calendarCreated(named, calendar) {
        this.track('calendar_created', {
            named: !!named,
            event_count_bucket: this.bucketEvents(calendar?.events?.length),
            kind: this.calendarKind(calendar),
        });
    },

    /**
     * What a calendar is for, from words in its title and event titles, so we learn which uses are
     * common. Only the category leaves the browser, never the title or any event text.
     */
    CALENDAR_KINDS: [
        ['guests', /\b(guest|visit|cabin|cottage|lake house|beach house|villa|airbnb|rental)/i],
        ['space', /\b(room|rooftop|roof|space|hall|bookings?|reserv|studio|court|gym|lounge|common|garden|pool|bbq|grill|terrace|desk|parking|laundry)/i],
        ['out', /\b(ooo|out of office|vacation|pto|wfh|leave|holiday|away|sick)/i],
        ['shifts', /\b(shift|roster|rota|volunteer|on.?call|duty|coverage|schedule)/i],
        ['sports', /\b(soccer|football|team|league|swim|tennis|hockey|baseball|basketball|rugby|cricket|volleyball|practice|game|tournament|match)/i],
        ['family', /\b(family|kids?|mom|dad|custody|parent|baby|nanny|grandma|grandpa|pickup)/i],
        ['school', /\b(school|class|course|tutor|homework|exam|college|student|lesson|semester)/i],
        ['community', /\b(church|choir|mosque|temple|parish|ministry|community|club|meetup|association)/i],
        ['care', /\b(care|caregiv|hospital|nurse|therapy|doctor|appointment|meds?)\b/i],
        ['music', /\b(band|music|gig|concert|rehears|choir|recital|show)/i],
        ['trip', /\b(trip|travel|wedding|itinerary|flight|reunion|party)/i],
        ['work', /\b(work|office|meeting|project|sprint|release|deadline|client|team sync)/i],
    ],
    calendarKind(calendar) {
        try {
            const title = String(calendar?.title || '');
            const events = (calendar?.events || []).slice(0, 40).map((e) => e.title || e.Subject || '').join(' ');
            for (const [kind, rx] of this.CALENDAR_KINDS) if (rx.test(title)) return kind;
            for (const [kind, rx] of this.CALENDAR_KINDS) if (rx.test(events)) return kind;
            return 'other';
        } catch (e) { return 'other'; }
    },

    /**
     * A feature outside the create/add/share funnel was actually used.
     *
     * One event name with a `feature` param rather than one name per feature:
     * these are all the same question ("is this used at all, and by whom"), and
     * a dozen near-empty event names makes that harder to read, not easier.
     * Registering one custom dimension unlocks every feature at once.
     */
    // ---- Pro funnel ------------------------------------------------------------
    //
    // Offer shown -> sign-in asked/sent -> checkout started (or failed, and why). `where`
    // says which surface; no email, calendar name or key ever goes in here.
    proLockShown(where) { this.track('pro_lock_shown', { where }); },
    proSignInShown(where) { this.track('pro_signin_shown', { where }); },
    proSignInSent(where) { this.track('pro_signin_sent', { where }); },
    proCheckoutStarted(interval) { this.track('pro_checkout_started', { where: 'share_panel', interval: interval === 'month' ? 'month' : 'year' }); },
    proCheckoutFailed(reason) { this.track('pro_checkout_failed', { where: 'share_panel', reason: String(reason).slice(0, 40) }); },
    proEditorLinkMade(kind) { this.track('pro_editor_link', { where: kind === 'reset' ? 'reset' : 'create' }); },
    proPortalOpened() { this.track('pro_portal_opened', { where: 'share_panel' }); },
    // The "Lock this calendar" line on your own calendar after someone else changed it.
    proUpsellShown() { this.track('pro_upsell_shown', { where: 'changed_since_visit' }); },
    proUpsellClicked() { this.track('pro_upsell_clicked', { where: 'changed_since_visit' }); },
    proUpsellDismissed() { this.track('pro_upsell_dismissed', { where: 'changed_since_visit' }); },
    // The logo menu's Pro account section. The state only: never the email or a calendar.
    accountMenuShown(state) { this.track('account_menu_shown', { state: state === 'signed_in' ? 'signed_in' : 'signed_out' }); },
    accountSignInSent() { this.track('pro_signin_sent', { where: 'logo_menu' }); },
    accountPortalOpened() { this.track('pro_portal_opened', { where: 'logo_menu' }); },
    accountSignedOut() { this.track('account_signed_out', { where: 'logo_menu' }); },
    // Pro stats and history (owner only), and the free calendar's teaser. Counts and surfaces only:
    // never the calendar name, a version date, or anything about visitors.
    proStatsViewed(where, days) { this.track('pro_stats_viewed', { where: String(where).slice(0, 20), days: [30, 90, 365].includes(days) ? days : 30 }); },
    proHistoryViewed(where) { this.track('pro_history_viewed', { where: String(where).slice(0, 20) }); },
    proVersionPreviewed(kind) { this.track('pro_version_previewed', { kind: kind === 'restore-point' ? 'restore-point' : 'daily' }); },
    proVersionRestored(kind, unchanged) { this.track('pro_version_restored', { kind: kind === 'restore-point' ? 'restore-point' : 'daily', unchanged: !!unchanged }); },
    proStatsTeaserShown() { this.track('pro_stats_teaser_shown', { where: 'stats_tab' }); },
    proStatsTeaserClicked() { this.track('pro_stats_teaser_clicked', { where: 'stats_tab' }); },

    featureUsed(feature, detail) {
        this.track('feature_used', {
            feature,               // 'notes' | 'colors' | 'settings' | 'event_type'
            ...(detail ? { detail } : {}),
        });
    },

    // ---- reliability ---------------------------------------------------------
    //
    // Everything above answers "is this used". Nothing answered "is it working",
    // and for a shared calendar that is the more important question: the product
    // promise is that what you type stays typed and what you share stays shared.
    //
    // Every bug found in the #41 investigation was silent in production -- events
    // destroyed by concurrent writes, events dropped at the write boundary, a feed
    // serving wrong recurrence to subscribers who are not even on the site. The
    // only detection channel was one user filing a GitHub issue. These events give
    // the failures a voice, and are deliberately counts rather than payloads: they
    // say "this is happening, go look", never what anyone's calendar contains.

    /**
     * A write had to reconcile someone else's concurrent change. Not an error --
     * merging is the intended behavior -- but the rate is the only visibility into
     * how often real editing collides, and a sudden jump means the merge is
     * thrashing rather than settling.
     *
     * Every count is somebody else's change since this client's baseline. The old
     * `removed_by_us` counted our own local-only ids -- i.e. our ADDS -- so an
     * ordinary single-person edit reported a collision.
     */
    syncMerged(counts) {
        this.track('sync_merged', {
            added_by_others: counts?.addedByOthers ?? 0,
            removed_by_others: counts?.removedByOthers ?? 0,
            changed_by_others: counts?.changedByOthers ?? 0,
        });
    },

    /**
     * The write path refused an event because it had no usable start/end. The user
     * sees a toast, but this is the count that says whether the entry paths are
     * still producing unsaveable events at all.
     */
    eventsDropped(count, reason) {
        this.track('events_dropped', { count: count || 0, reason: reason || 'incomplete' });
    },

    /**
     * A calendar's ICS feed failed to generate. Subscribers experience this as a
     * feed that silently stops updating, and they have no way to report it -- they
     * are not on the site to notice.
     */
    icsFailed(reason) {
        this.track('ics_failed', { reason: reason || 'unknown' });
    },

    /**
     * An uncaught error or rejected promise reached the top of the stack. Names the
     * failure and where it came from, never the user's data.
     */
    jsError(kind, message, where) {
        this.track('js_error', {
            kind,                                   // 'error' | 'unhandledrejection'
            message: String(message || '').slice(0, 200),
            where: String(where || '').slice(0, 120),
        });
    },

    /**
     * The shape of every calendar write: events carried vs events in the last server
     * snapshot. Success-with-wrong-content is invisible to error hooks -- the Sept 2026
     * save bug committed cleanly for three days -- so this is the signal that catches it:
     * a negative delta with no declared intent is the fingerprint of a buggy save path.
     */
    syncShape(shape) {
        const before = shape?.before ?? 0, after = shape?.after ?? 0;
        this.track('sync_shape', {
            before, after, delta: after - before,
            intent: shape?.intent ? 'declared' : 'none',
        });
    },

    /**
     * The write gate refused to empty a calendar, or the server rejected a save.
     */
    syncRefused(shape) {
        this.track('sync_refused', { before: shape?.before ?? 0, removing: shape?.removing ?? 0 });
    },

    // Generated ids come from IDService.generateNanoId(5): 5 alphanumeric chars.
    // Human slugs are lowercased at claim time and usually longer.
    looksGenerated(id) {
        return !!id && id.length === 5 && /^[a-z0-9]+$/i.test(id) && id !== id.toLowerCase();
    },
};

// Silence analytics wherever the page itself is silenced, so the seam and the
// GTM loader in index.html can never disagree.
if (typeof window !== 'undefined') {
    // The staging copy (preview.pastecal.com) is silenced too.
    if (window.__TEST__ || window.location.search.includes('no-analytics') || window.location.hostname === 'preview.pastecal.com') {
        Analytics.enabled = false;
    }
    if (window.location.search.includes('debug-analytics')) {
        Analytics.debug = true;
    }
    // Clarity's queue, the same stub its snippet defines: events and tags sent before GTM
    // loads Clarity wait here, and Clarity drains them. Only where analytics is on.
    if (Analytics.enabled && typeof window.clarity !== 'function') {
        window.clarity = function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    }

    // Flush on page-hide. `visibilitychange` is the only event that fires reliably
    // on mobile Safari (which often skips `unload`/`beforeunload` entirely), and
    // most sessions end right after the action worth recording.
    try {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') Analytics.flush(true);
        });
        window.addEventListener('pagehide', () => Analytics.flush(true));
    } catch (err) {
        /* listener registration must never break page load */
    }

    // Links say where they are with data-from ("home-plans") instead of ?from= in the address:
    // the label is kept for this tab and read once by the page it leads to (pricing).
    try {
        document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('a[data-from]');
            if (a) try { sessionStorage.setItem('pc_from', a.getAttribute('data-from')); } catch (err) { /* storage blocked */ }
        }, true);
    } catch (err) { /* never break page load */ }

    Analytics.loadHomepageVariant();
    // The page kind, never the path: a calendar's path is its edit key.
    const path = window.location.pathname;
    Analytics.tag('page', path === '/' ? 'home' : /^\/pricing/.test(path) ? 'pricing' : /^\/view\//.test(path) ? 'view'
        : /^\/(beta|nativecal)(\/|$)/.test(path) ? 'beta' : 'calendar');
    window.Analytics = Analytics;

    // Real-user page speed, one `page_perf` event per page view, sent when the page is
    // first hidden so LCP/CLS have settled. Lets us see the slow tail by browser/device.
    try {
        let lcp = 0, cls = 0, sent = false;
        const observe = (type, cb) => {
            try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true }); } catch (e) { /* unsupported (older Safari) */ }
        };
        observe('largest-contentful-paint', (e) => { lcp = e.startTime; });
        observe('layout-shift', (e) => { if (!e.hadRecentInput) cls += e.value; });
        const sendPerf = (force) => {
            if (sent || (force !== true && document.visibilityState !== 'hidden')) return;
            sent = true;
            const nav = performance.getEntriesByType('navigation')[0];
            const fcp = performance.getEntriesByName('first-contentful-paint')[0];
            const ua = navigator.userAgent;
            const browser = /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\/|CriOS/.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
            const ms = (v) => (v > 0 ? Math.round(v) : undefined);
            // Straight to the sinks, not via track()'s requestIdleCallback: a hidden page
            // (iOS Safari especially) may never run the idle callback.
            const send = (name, params) => {
                let enriched; try { enriched = Object.assign({}, Analytics.baseParams(), params); } catch (e) { enriched = params; }
                if (!Analytics.enabled) return;
                for (const key of Analytics.active) {
                    try { Analytics.SINKS[key](name, enriched); } catch (e) { /* sinks must not throw */ }
                }
            };
            send('page_perf', {
                ttfb_ms: ms(nav && nav.responseStart),
                fcp_ms: ms(fcp && fcp.startTime),
                lcp_ms: ms(lcp),
                load_ms: ms(nav && nav.loadEventEnd),
                cls: Math.round(cls * 1000) / 1000,
                browser,
                cached: nav && nav.transferSize === 0 ? 'yes' : 'no',
                device: window.matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop',
            });
            Analytics.flush(true); // the page-hide flush above already ran, before this was queued
        };
        document.addEventListener('visibilitychange', () => sendPerf());
        window.addEventListener('pagehide', () => sendPerf(true));
    } catch (err) {
        /* perf reporting must never break page load */
    }
}
