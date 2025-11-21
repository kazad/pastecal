import { uuidv4, debounce } from './utils.js';

export class Event {
    // may be created from JSON object or DHTMLX internal calendar event
    constructor(options) {
        this.id = options.Id || options.id || uuidv4();
        this.title = options.Subject || options.text || options.title || "";
        this.description = options.Description || options.description || "";
        this.repeat = options.Recurrence || options.repeat || "";
        this.recurrencerule = options.RecurrenceRule || options.recurrencerule || "";
        this.start = options.start || null;
        this.end = options.end || null;
        this.type = parseInt(options.Type || options.type || 1);

        this.recurrenceID = options.RecurrenceID || options.recurrenceID || null;
        this.recurrenceException = options.RecurrenceException || options.recurrenceException || null;

        // for SyncFusion Internal Object
        if (options.StartTime) {
            this.start = new Date(options.StartTime).toISOString() || null;
            this.end = new Date(options.EndTime).toISOString() || null;
        }

        // Firebase saves fail with undefined properties, ensure they are null instead
        for (let prop in this) {
            if (this[prop] === undefined) {
                this[prop] = null;
            }
        }
    }
}

export class Calendar {
    constructor(id, title, events, options) {
        this.id = id;
        this.title = title || "";
        this.events = events || [];
        this.options = options || {};
    }

    getSyncFusionEvents() {
        return this.events.map(e => {
            return {
                Id: e.id,
                Subject: e.title,
                StartTime: e.start,
                EndTime: e.end,
                Description: e.description,
                RecurrenceRule: e.recurrencerule,
                Type: parseInt(e.type || 1),

                //                        IsAllDay: e.allday,
                Recurrence: e.repeat,
                RecurrenceID: e.recurrenceID,
                RecurrenceException: e.recurrenceException
            }
        });
    }

    defaultEvent(title) {
        var e = new Event({ title: title });

        // sample 1-hour event in local timezone 
        var d = new Date();
        d.setHours(12, 0, 0, 0);
        e.start = d.toISOString();
        d.setHours(13, 0, 0, 0);
        e.end = d.toISOString();

        return e;
    }

    import(c) {
        Object.assign(this, c);
    }

    setEvents(events) {
        console.log(`[app] setEvents ${events.length}`, events);
        this.events = events.map(e => {
            return new Event(e);
        });
        CalendarDataService.debounce_sync(this);
    }
}

export class CalendarDataService {
    static connected = false;
    // Assume firebase global is available
    static db = firebase.database().ref('/calendars');
    static db_readonly = firebase.database().ref('/calendars_readonly');

    // subscribe to live updates
    static subscribe(slug, callback) {
        if (!slug) return;

        // First try exact case match
        this.db.child(slug).on('value', async data => {
            var calendar = data.val();
            if (calendar && calendar.id) {
                this.connected = slug;
                this.validateCalendarData(calendar);
                callback(calendar);
            } else {
                // Calendar not found with exact case - try case-insensitive lookup for editable calendars only
                try {
                    console.log('Fallback lookup for slug:', slug);
                    console.log('Calling function with data:', { slug: slug });
                    const lookupCalendar = firebase.functions().httpsCallable('lookupCalendar');
                    const result = await lookupCalendar({ slug: slug });

                    if (result.data.found && !result.data.isReadOnly) {
                        // Found as editable calendar - subscribe with correct case
                        this._subscribeExact(result.data.actualSlug, callback);
                    } else {
                        // Calendar doesn't exist as editable
                        callback(null);
                    }
                } catch (error) {
                    console.error('Case-insensitive lookup failed:', error);
                    console.error('Error details:', {
                        message: error.message,
                        code: error.code,
                        details: error.details,
                        stack: error.stack
                    });
                    // Fall back to treating as new calendar
                    callback(null);
                }
            }
        });
    }

    // internal method for exact subscription without fallback
    static _subscribeExact(slug, callback) {
        if (slug) {
            this.db.child(slug).on('value', data => {
                var calendar = data.val();
                if (calendar && calendar.id) {
                    this.connected = slug;
                    this.validateCalendarData(calendar);
                    callback(calendar);
                } else {
                    callback(null);
                }
            })
        }
    }

    // validate and fix calendar data
    static validateCalendarData(calendar) {
        if (!calendar || !calendar.id) return;

        // Auto-create read-only link if it doesn't exist
        SlugManager.autoCreateReadOnlyLink(calendar);

        // Future validation steps can be added here:
        // - Ensure required fields exist
        // - Fix malformed data
        // - Apply data migrations
        // - Validate event formats
    }

    // find calendar (with redirect logic) and subscribe
    static async findAndSubscribe(slug, callback) {
        if (!slug) {
            console.warn('findAndSubscribe called with empty slug');
            callback(null);
            return;
        }

        // OPTIMISTIC STRATEGY: Try direct subscription first.
        // This covers the 99% case where the URL matches the DB key exactly.
        // It avoids the Cloud Function overhead/latency/failure-points for valid URLs.

        console.log('Attempting direct subscription for:', slug);

        // We need a way to "try" subscribing and if it returns null quickly, then fallback.
        // Since .on() is persistent, we'll use .once() for the check.

        try {
            const snapshot = await this.db.child(slug).once('value');
            const calendar = snapshot.val();

            if (calendar && calendar.id) {
                console.log('Direct subscription successful for:', slug);
                // Found directly! Subscribe and return.
                this._subscribeExact(slug, callback);
                return;
            }
        } catch (e) {
            console.warn('Direct subscription check failed (network?):', e);
            // We'll continue to the fallback logic just in case it was a permission issue 
            // that the function might resolve (unlikely but safe).
        }

        // FALLBACK STRATEGY: Case-insensitive lookup via Cloud Function.
        // Only reached if direct exact-match lookup failed.
        console.log('Direct lookup failed. Falling back to cloud function lookup for:', slug);

        try {
            const lookupCalendar = firebase.functions().httpsCallable('lookupCalendar');
            const result = await lookupCalendar({ slug: slug });
            console.log('Lookup result:', result);

            if (result.data.found) {
                if (result.data.isReadOnly) {
                    // Found as read-only calendar - redirect to view URL
                    window.location.href = `/view/${result.data.actualSlug}`;
                    return; // Don't call callback, we're redirecting
                } else {
                    // Found as editable calendar - subscribe with correct case
                    console.log('Found case-insensitive match:', result.data.actualSlug);
                    this._subscribeExact(result.data.actualSlug, callback);
                }
            } else {
                // Calendar doesn't exist in any case - treating as new
                console.log('No calendar found. Treating as new.');
                // We subscribe to the ORIGINAL slug so if they create it, it uses the URL they typed.
                this._subscribeExact(slug, callback);
            }
        } catch (error) {
            console.error('Calendar lookup failed:', error);
            // Fall back to direct subscription on original slug (it will likely be empty/new)
            this._subscribeExact(slug, callback);
        }
    }

    // subscribe to live updates for read-only calendars
    static subscribe_readonly(slug, callback) {
        if (slug) {
            this.db_readonly.child(slug).on('value', data => {
                var calendar = data.val();
                if (calendar && calendar.id) {
                    // don't set connected
                    callback(calendar);
                }
            })
        }
    }


    // only sync if we have existed
    static sync(calendar) {
        if (calendar && calendar.id && this.connected) {
            // console.log("CalendarDataService.sync()", calendar);
            this.db.child(calendar.id).set(calendar);
            console.log('CalendarDataService.sync()');
        }
    }


    static debounce_sync = debounce((cal) => (CalendarDataService.sync(cal)), 500);

    static create(item) {
        return this.db.push(item);
    }

    static checkExists(id, callback_yes, callback_no) {
        this.db.child(id).once('value', data => {
            if (data.val()) {
                callback_yes();
            } else {
                callback_no();
            }
        });
    }

    static createWithId(key, value, success) {
        return this.db.child(key).set(value, (error) => {
            if (error) {
                console.log("error creating calendar", error, key, value);
            } else {
                success();
            }
        });
    }

    static update(key, value) {
        return this.db.child(key).update(value);
    }

    static delete(key) {
        return this.db.child(key).remove();
    }
}

// SlugManager static class for centralized read-only link operations
export class SlugManager {
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
