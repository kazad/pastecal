// CalendarDataService - Firebase database operations for calendars
class CalendarDataService {
    static connected = false;
    static db = firebase.database().ref('/calendars');
    static db_readonly = firebase.database().ref('/calendars_readonly');

    // Firebase Realtime Database rejects any payload containing `undefined` — the *entire*
    // write fails. Historically this caused silent save failures (notably the IsAllDay field
    // commented out in Calendar.getSyncFusionEvents because an early version produced
    // `IsAllDay: undefined`). Event/Calendar constructors strip undefined to null, but this
    // is a final belt-and-suspenders pass right before every write — so a future code path
    // that hands us a plain object with stray undefined fields still saves cleanly instead
    // of breaking the whole calendar.
    static _sanitizeForFirebase(value) {
        if (value === undefined) return null;
        if (value === null) return null;
        if (Array.isArray(value)) return value.map(v => this._sanitizeForFirebase(v));
        if (typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = v === undefined ? null : this._sanitizeForFirebase(v);
            }
            return out;
        }
        return value;
    }

    // Drop events that can never be rendered (missing/invalid start or end) before they
    // reach Firebase. Incident: one dateless event persisted here, and the ICS feed for that
    // whole calendar returned 500 to every subscriber until the data was repaired.
    //
    // Dropping rather than rejecting the write: sync() persists the ENTIRE calendar on a
    // debounced watcher, so refusing the whole payload over one bad event would throw away
    // the user's other edits.
    //
    // The drop is reported to the user via onIncompleteEvents, not just the console. It
    // leaves local memory holding an event that Firebase does not have, so the screen says
    // saved while the next reload says gone -- indistinguishable, from the user's side, from
    // the app losing their data. Whoever is watching deserves to know which event and why.
    static onIncompleteEvents = null;

    static _dropIncompleteEvents(calendar) {
        if (!calendar || !Array.isArray(calendar.events)) return calendar;

        const complete = calendar.events.filter(e => Event.isComplete(e));
        if (complete.length === calendar.events.length) return calendar;

        const dropped = calendar.events.filter(e => !Event.isComplete(e));
        console.warn(
            `[CalendarDataService] Refusing to save ${dropped.length} event(s) with a ` +
            `missing/invalid start or end — they would break this calendar's ICS feed.`,
            dropped);

        if (typeof this.onIncompleteEvents === 'function') {
            try {
                this.onIncompleteEvents(dropped);
            } catch (err) {
                console.error('[CalendarDataService] onIncompleteEvents handler failed', err);
            }
        }

        return { ...calendar, events: complete };
    }

    // subscribe to live updates
    static subscribe(slug, callback) {
        if (!slug) return;

        // First try exact case match
        this.db.child(slug).on('value', async data => {
            var calendar = data.val();
            if (calendar && calendar.id) {
                this.connected = slug;
                this._rememberSnapshot(calendar);

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
                    this._rememberSnapshot(calendar);

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

        // First do a lookup to determine calendar type and location
        try {
            console.log('Looking up calendar for slug:', slug);
            console.log('Calling function with data:', { slug: slug });
            const lookupCalendar = firebase.functions().httpsCallable('lookupCalendar');
            const result = await lookupCalendar({ slug: slug });
            console.log('Function result:', result);

            if (result.data.found) {
                if (result.data.isReadOnly) {
                    // Found as read-only calendar - redirect to view URL
                    window.location.href = `/view/${result.data.actualSlug}`;
                    return; // Don't call callback, we're redirecting
                } else {
                    // Found as editable calendar - subscribe with correct case
                    this._subscribeExact(result.data.actualSlug, callback);
                }
            } else {
                // Calendar doesn't exist in any case - try direct subscription (might be new)
                this._subscribeExact(slug, callback);
            }
        } catch (error) {
            console.error('Calendar lookup failed:', error);
            console.error('Error details:', {
                message: error.message,
                code: error.code,
                details: error.details,
                stack: error.stack
            });
            // Fall back to direct subscription
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


    // The server state as of the last snapshot we received, keyed by calendar id. sync()
    // diffs against this to work out what THIS client actually changed, so a write carries
    // one person's edit instead of their entire view of the calendar.
    static _lastSeen = {};

    // Remember what the server just told us. Called from every subscription callback.
    static _rememberSnapshot(calendar) {
        if (!calendar || !calendar.id) return;
        this._lastSeen[calendar.id] = JSON.parse(JSON.stringify(calendar.events || []));
    }

    // Merge local events over the server's current events, instead of overwriting them.
    //
    // sync() used to `set()` the whole calendar. Two people editing at once -- the entire
    // point of a link-shared calendar -- then raced: whoever wrote last replaced the other's
    // array wholesale, so an event someone created seconds earlier simply stopped existing.
    // The same happened with one person in two tabs, or one flaky connection landing a
    // queued write late.
    //
    // The fix is to write a merge rather than a snapshot. We know three sets: what the
    // server had when we last heard from it (base), what we hold now (local), and what the
    // server holds at write time (remote). Anything we added or changed since base is ours
    // to apply; anything we deleted since base we remove by id; everything else in remote
    // is somebody else's work and is left exactly as it is.
    static _mergeEvents(base, local, remote) {
        const byId = (list) => {
            const m = new Map();
            for (const e of list || []) if (e && e.id) m.set(e.id, e);
            return m;
        };
        const baseM = byId(base), localM = byId(local), remoteM = byId(remote);
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

        const merged = new Map(remoteM);

        // Ours: added or edited since the last snapshot.
        for (const [id, ev] of localM) {
            const wasInBase = baseM.has(id);
            if (!wasInBase || !same(baseM.get(id), ev)) merged.set(id, ev);
        }
        // Ours: deleted since the last snapshot -- but only if nobody else has since
        // changed it, in which case their edit is newer information than our delete.
        for (const [id, baseEv] of baseM) {
            if (localM.has(id)) continue;
            const remoteEv = remoteM.get(id);
            if (!remoteEv || same(remoteEv, baseEv)) merged.delete(id);
        }

        // Keep the server's ordering, then append anything new from this client.
        const out = [];
        const seen = new Set();
        for (const e of remote || []) {
            if (e && e.id && merged.has(e.id)) { out.push(merged.get(e.id)); seen.add(e.id); }
        }
        for (const [id, ev] of merged) if (!seen.has(id)) out.push(ev);
        return out;
    }

    // only sync if we have existed
    static sync(calendar) {
        if (calendar && calendar.id && this.connected) {
            // console.log("CalendarDataService.sync()", calendar);
            const safe = this._dropIncompleteEvents(calendar);

            // Merge the events under a transaction so a concurrent write cannot be lost
            // between the read and the write. Everything else on the calendar (title,
            // options, notes) stays last-write-wins: those are single fields where the
            // later edit is genuinely the intended one, unlike an events array where two
            // people are editing different rows.
            const base = this._lastSeen[calendar.id] || [];
            const localEvents = this._sanitizeForFirebase(safe.events || []);
            const rest = this._sanitizeForFirebase({ ...safe, events: undefined });
            delete rest.events;

            this.db.child(calendar.id).transaction((current) => {
                if (current === null) return this._sanitizeForFirebase(safe);
                const remoteEvents = Array.isArray(current.events)
                    ? current.events
                    : Object.values(current.events || {});
                return {
                    ...current,
                    ...rest,
                    events: this._mergeEvents(base, localEvents, remoteEvents),
                };
            }, (error, committed, snapshot) => {
                if (error) {
                    console.error('[CalendarDataService] sync transaction failed', error);
                } else if (committed && snapshot) {
                    // Our write is now the baseline for the next diff.
                    this._rememberSnapshot({ id: calendar.id, events: snapshot.val()?.events });
                }
            });

            // NOT recorded here. sync() runs from a deep Vue watcher on `calendar`, and
            // that watcher also fires when the live subscription imports data from the
            // server -- so every VIEWER echoed the calendar back and looked like an
            // editor. Observed in production: 27 of 31 browsers on /rldispatch had
            // exactly editCount=1, the signature of a write on load rather than a real
            // edit. (The same hazard is documented for visitCount in app.js.)
            //
            // Authorship is recorded from the user-initiated paths instead, via
            // AuthorSignal.touch() at the call sites that represent a real edit.

            console.log('CalendarDataService.sync()');
        }
    }


    static debounce_sync = Utils.debounce((cal) => (CalendarDataService.sync(cal)), 500);

    static create(item) {
        return this.db.push(this._sanitizeForFirebase(item));
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
        return this.db.child(key).set(this._sanitizeForFirebase(value), (error) => {
            if (error) {
                console.log("error creating calendar", error, key, value);
            } else {
                // The strongest ownership signal there is: whoever was present when the
                // calendar first existed. Flagged separately from ordinary edits so a
                // later prolific editor can never outrank the creator by volume alone.
                if (typeof AuthorSignal !== 'undefined') {
                    AuthorSignal.touch(key, { created: true });
                }
                success();
            }
        });
    }

    static update(key, value) {
        return this.db.child(key).update(this._sanitizeForFirebase(value));
    }

    static delete(key) {
        return this.db.child(key).remove();
    }
}
