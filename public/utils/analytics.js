// Analytics — a thin, provider-agnostic seam.
//
// Call sites only ever use Analytics.track('name', {params}). Where those events
// end up is decided here, so swapping GA4 for Cloudflare Analytics Engine, Plausible,
// or a self-hosted collector is a change to SINKS below and nothing else.
//
// Design notes (why these events and not "calendar_created"):
//   - We track DECISIONS, not actions. An event earns its place only if it can
//     change a product decision.
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
        // Google Analytics 4, via the gtag shim GTM installs.
        ga4(name, params) {
            if (typeof window.gtag === 'function') {
                window.gtag('event', name, params);
            } else if (Array.isArray(window.dataLayer)) {
                // GTM without the gtag shim: push it as a dataLayer event instead.
                window.dataLayer.push(Object.assign({ event: name }, params));
            }
        },

        // Cloudflare Analytics Engine / any HTTP collector. Off until a URL is set.
        // Batched rather than one request per event: queue() only touches an
        // in-memory array, so the call site can never pay for or fail on network.
        http(name, params) {
            if (!Analytics.COLLECTOR_URL) return;
            Analytics.queue(name, params);
        },

        // Visible in devtools when debugging instrumentation.
        console(name, params) {
            if (Analytics.debug) console.log('[analytics]', name, params);
        },
    },

    // Which sinks are live. Order is irrelevant; all are best-effort.
    active: ['ga4', 'console'],

    COLLECTOR_URL: null,
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
     * away -- fetch() is cancelled on unload, sendBeacon() survives it, and most
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
        return {
            surface: window.__TEST__ ? 'test' : 'web',
        };
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

    /** An event was added, with the path that created it. */
    eventAdded(source, calendar) {
        this.track('event_added', {
            source, // 'quick_add' | 'grid' | 'popup' | 'paste'
            event_count_bucket: this.bucketEvents(calendar?.events?.length),
        });
    },

    /** The calendar was shared or its link copied — precedes most multi-user use. */
    calendarShared(method) {
        this.track('calendar_shared', { method }); // 'copy' | 'native' | 'ics'
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
    if (window.__TEST__ || window.location.search.includes('no-analytics')) {
        Analytics.enabled = false;
    }
    if (window.location.search.includes('debug-analytics')) {
        Analytics.debug = true;
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

    window.Analytics = Analytics;
}
