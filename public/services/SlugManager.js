// Null-safe analytics for this module. analytics.js is a separate <script>, so
// an ad blocker or CDN failure leaves the global undefined -- and a helper that
// throws must not abort a slug operation half-way. Mirrors track() in app.js.
function trackSafely(fn, when = true) {
    try {
        if (!when) return;
        if (typeof Analytics === 'undefined' || !Analytics) return;
        fn(Analytics);
    } catch (err) {
        /* observational only: never surface, never rethrow */
    }
}

// SlugManager static class for centralized read-only link operations
class SlugManager {
    // Normalize slug for consistent lookup (matches backend)
    static normalizeSlug(slug) {
        return slug?.toLowerCase();
    }

    // Core method - handles all read-only link creation scenarios
    static async createReadOnlyLink(calendar, options = {}) {
        const { customSlug = null, autoCreate = false } = options;
        const createPublicLink = firebase.functions().httpsCallable('createPublicLink');

        try {
            const params = { sourceCalendarId: calendar.id };
            if (customSlug) {
                params.customSlug = customSlug.trim();
            }

            const result = await createPublicLink(params);
            const { publicViewId } = result.data;

            // Update calendar options
            if (!calendar.options) {
                calendar.options = {};
            }
            calendar.options.publicViewId = publicViewId;

            // Auto-save for auto-creation. Route through sync() so the Firebase sanitizer applies.
            if (autoCreate) {
                CalendarDataService.sync(calendar);
            }

            console.log(`${autoCreate ? 'Auto-created' : 'Created'} read-only link:`, publicViewId);
            // `where` separates this from claiming the calendar's own URL in
            // app.js -- same event name, different user action, and conflating
            // them would make the claim rate unreadable.
            trackSafely(a => a.track('slug_claimed', {
                where: 'readonly_link',
                slug_length: publicViewId ? publicViewId.length : 0,
                event_count_bucket: a.bucketEvents(calendar?.events?.length),
            }), customSlug);
            return publicViewId;

        } catch (error) {
            console.error('Error creating read-only link:', error);
            // 'already-exists' vs 'invalid-argument' tells you whether to build
            // name suggestions or fix the validation copy.
            trackSafely(a => a.track('slug_claim_failed', {
                where: 'readonly_link',
                reason: error?.code || 'unknown',
            }), customSlug);
            if (!autoCreate) {
                alert('Failed to create read-only link: ' + (error.message || 'Please try again.'));
            }
            throw error;
        }
    }

    // Specific read-only link operations with clear naming
    static autoCreateReadOnlyLink(calendar) {
        if (!calendar.options?.publicViewId) {
            // The moment a calendar silently gets a name nobody chose. This is the
            // denominator for "was the low custom-slug rate a discoverability
            // problem?" -- without it, claims have no base to be a rate of.
            trackSafely(a => a.track('slug_autoassigned', {
                where: 'readonly_link',
                event_count_bucket: a.bucketEvents(calendar?.events?.length),
            }));
            return this.createReadOnlyLink(calendar, { autoCreate: true });
        }
    }

    static createReadOnlyLinkWithCustomSlug(calendar, customSlug) {
        return this.createReadOnlyLink(calendar, { customSlug });
    }

    static customizeReadOnlyLink(calendar, customSlug) {
        return this.createReadOnlyLink(calendar, { customSlug });
    }

    // Helper methods - distinguish between slug and full URL
    static getReadOnlySlug(calendar) {
        return calendar.options?.publicViewId;
    }

    static hasReadOnlyLink(calendar) {
        return !!(calendar.options?.publicViewId);
    }

    static getReadOnlyURL(calendar) {
        const slug = this.getReadOnlySlug(calendar);
        return slug ? `${window.location.origin}/view/${slug}` : null;
    }

    static getReadOnlyICSURL(calendar) {
        const slug = this.getReadOnlySlug(calendar);
        return slug ? `${window.location.origin}/view/${slug}.ics` : null;
    }

    // Viewer-context-aware URL construction.
    //
    // A calendar has up to two share artifacts: the editable id (/<id>) and an
    // optional read-only slug (/view/<slug>). Anything that generates a URL for
    // "the current viewer to share" — deep links, "share this view", future
    // affordances — must go through here so the editable id is never leaked to a
    // read-only viewer. Owner-only helpers (getEditableURL etc.) bypass this
    // because their call sites are template-gated by canEdit.
    static getViewerBasePath(calendar, isReadOnly) {
        if (isReadOnly) {
            const slug = this.getReadOnlySlug(calendar) || this._slugFromLocation();
            // Refuse to fall back to /${calendar.id} in read-only mode — that would leak
            // the editable id. Caller treats null as "no shareable base path"; UI should
            // fall back to window.location.href (which the viewer already sees).
            return slug ? `/view/${slug}` : null;
        }
        return `/${calendar.id}`;
    }

    static getViewerBaseURL(calendar, isReadOnly) {
        const path = this.getViewerBasePath(calendar, isReadOnly);
        return path ? `${window.location.origin}${path}` : null;
    }

    // Extract a read-only slug from the current URL when the calendar payload
    // doesn't carry one yet (race window between createPublicLink and syncPublicView).
    static _slugFromLocation() {
        const match = window.location.pathname.match(/\/view\/([^/?#]+)/);
        return match ? match[1] : null;
    }
}
