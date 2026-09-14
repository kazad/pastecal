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

    /**
     * A calendar was persisted to the server. THE top-of-funnel number, and the
     * one pro.md's MAU -> conversion model is built on.
     *
     * Deliberately separate from slug_claimed/slug_autoassigned even though all
     * three fire at the same moment: those two answer "did they choose a name",
     * this one answers "how many calendars exist", and the read-only-link flow
     * reuses the slug event names for something that is NOT a new calendar.
     */
    calendarCreated(named, calendar) {
        this.track('calendar_created', {
            named: !!named,
            event_count_bucket: this.bucketEvents(calendar?.events?.length),
        });
    },

    /**
     * A feature outside the create/add/share funnel was actually used.
     *
     * One event name with a `feature` param rather than one name per feature:
     * these are all the same question ("is this used at all, and by whom"), and
     * a dozen near-empty event names makes that harder to read, not easier.
     * Registering one custom dimension unlocks every feature at once.
     */
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
     * merging is the intended behaviour -- but the rate is the only visibility into
     * how often real editing collides, and a sudden jump means the merge is
     * thrashing rather than settling.
     */
    syncMerged(counts) {
        this.track('sync_merged', {
            added_by_others: counts?.addedByOthers ?? 0,
            removed_by_us: counts?.removedByUs ?? 0,
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
     * The write gate refused to empty a calendar. Should be ~zero; any rate at all means
     * a save path is producing empty arrays again.
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
