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

    // The calendar name a page path names, or null for the homepage / a path that cannot be one.
    // Any name a calendar can have is accepted: real calendars include "TEAM NUÑEZ", "d&d8",
    // "강아지봉사" and names ending in a space. (Until Oct 2026 only [a-zA-Z0-9_-] and under 40
    // characters were, so every other link silently opened a blank new calendar.) The path is
    // percent-encoded ("royal%20city%20"), so it is decoded first; a name may not hold the
    // characters a stored key cannot (. # $ [ ] / and control characters).
    static slugFromPath(pathname) {
        const first = String(pathname || '').split('/').filter(Boolean)[0];
        if (!first) return null;
        let name;
        try { name = decodeURIComponent(first); } catch { return null; }
        if (!name.trim() || name.length > 200 || /[.#$\[\]\/\u0000-\u001f\u007f]/.test(name)) return null;
        return name;
    }

    // Why a calendar can't be saved under this name, in words, or null. The server's rule (cloudflare/src validId):
    // 1 to 200 characters, none of . # $ [ ] / or control characters.
    static nameProblem(name) {
        const s = String(name ?? '');
        if (!s.trim()) return 'Type a name for the calendar.';
        if (s.length > 200) return 'That name is too long.';
        if (/[.#$\[\]\/\u0000-\u001f\u007f]/.test(s)) return 'A calendar name can’t contain . # $ [ ] or /';
        return null;
    }

    // Why a view-only link can't be renamed to this, in words, or null. The server's rule (SlugService.validateSlug):
    // 3 to 50 letters, numbers, dashes or underscores, and never a calendar's name -- this calendar's own least of all
    // (its edit link would then open the view: the July 2025 custom names allowed it, Oct 28 2026).
    static viewNameProblem(name, current, calendarId = null) {
        const s = String(name ?? '').trim();
        if (current && s.toLowerCase() === String(current).toLowerCase()) return 'That’s already this link’s name.';
        if (calendarId && s.toLowerCase() === String(calendarId).toLowerCase()) return this.OWN_NAME_MESSAGE;
        if (!/^[a-zA-Z0-9_-]{3,50}$/.test(s)) return 'Use 3 to 50 letters, numbers, dashes or underscores.';
        return null;
    }

    static OWN_NAME_MESSAGE = 'That’s this calendar’s edit link name. Pick a different one, so the view link can’t be used to edit.';

    // What a failed view-link request says to a person (createPublicLink's error: .code from the server).
    static linkErrorMessage(error) {
        const code = error && error.code;
        if (code === 'already-exists') return 'That name is taken. Try another.';
        if (code === 'invalid-argument') return 'That name won’t work. Use 3 to 50 letters, numbers, dashes or underscores.';
        if (code === 'resource-exhausted') return 'Too many tries. Wait a minute and try again.';
        if (code === 'locked' || code === 'paused') return (error && error.message) || 'This calendar is locked.';
        return 'Couldn’t reach pastecal. Check your connection and try again.';
    }

    // Alternatives to offer when a chosen name is taken, best first. Pure: the caller checks
    // which are actually free. A trailing number counts up ("team-2" -> "team-3"); otherwise
    // the usual ways people disambiguate (-2, -<year>, -team, -calendar).
    static suggestSlugs(slug, year = new Date().getFullYear()) {
        const base = String(slug || '').trim().toLowerCase().replace(/-+$/, '');
        if (!base) return [];
        const out = [];
        const counted = base.match(/^(.*)-(\d{1,3})$/);
        if (counted) {
            const n = parseInt(counted[2], 10);
            out.push(`${counted[1]}-${n + 1}`, `${counted[1]}-${n + 2}`);
        } else {
            out.push(`${base}-2`);
        }
        for (const tail of [String(year), 'team', 'calendar']) {
            if (!base.endsWith(`-${tail}`)) out.push(`${base}-${tail}`);
        }
        return [...new Set(out)].filter(c => c !== base && c.length <= 60);
    }

    // Core method - handles all read-only link creation scenarios
    static async createReadOnlyLink(calendar, options = {}) {
        const { customSlug = null, autoCreate = false } = options;
        try {
            const params = { sourceCalendarId: calendar.id };
            if (customSlug) {
                params.customSlug = customSlug.trim();
            }

            const result = await CalendarDataService.createPublicLink(params);
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
            // The caller says it where the person asked (never a browser alert): userMessage is the wording.
            if (error && typeof error === 'object') error.userMessage = this.linkErrorMessage(error);
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
        return slug ? window.location.origin + CalendarPath.view(slug) : null;
    }

    static getReadOnlyICSURL(calendar) {
        const slug = this.getReadOnlySlug(calendar);
        return slug ? window.location.origin + CalendarPath.feed(CalendarPath.view(slug)) : null;
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
            // An @link (pastecal.com/@handle/<name>) is itself the address to share.
            const at = window.location.pathname.match(/^\/@[^/?#]+\/[^/?#]+/);
            if (at && document.querySelector('meta[name="pc-view"]')) return at[0];
            const slug = this.getReadOnlySlug(calendar) || this._slugFromLocation();
            // Refuse to fall back to /${calendar.id} in read-only mode — that would leak
            // the editable id. Caller treats null as "no shareable base path"; UI should
            // fall back to window.location.href (which the viewer already sees).
            return slug ? CalendarPath.view(slug) : null;
        }
        return CalendarPath.of(calendar.id);   // encoded: "50% off", "a?b", "trail " (A03)
    }

    static getViewerBaseURL(calendar, isReadOnly) {
        const path = this.getViewerBasePath(calendar, isReadOnly);
        return path ? `${window.location.origin}${path}` : null;
    }

    // Extract a read-only slug from the current URL when the calendar payload
    // doesn't carry one yet (race window between createPublicLink and syncPublicView).
    static _slugFromLocation() {
        const match = window.location.pathname.match(/\/view\/([^/?#]+)/);
        if (!match) return null;
        try { return decodeURIComponent(match[1]); } catch { return match[1]; }   // (CalendarPath.view encodes it again)
    }
}
