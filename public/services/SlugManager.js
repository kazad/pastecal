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

            // Auto-save for auto-creation
            if (autoCreate) {
                CalendarDataService.db.child(calendar.id).set(calendar);
            }

            console.log(`${autoCreate ? 'Auto-created' : 'Created'} read-only link:`, publicViewId);
            return publicViewId;

        } catch (error) {
            console.error('Error creating read-only link:', error);
            if (!autoCreate) {
                alert('Failed to create read-only link: ' + (error.message || 'Please try again.'));
            }
            throw error;
        }
    }

    // Specific read-only link operations with clear naming
    static autoCreateReadOnlyLink(calendar) {
        if (!calendar.options?.publicViewId) {
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
}
