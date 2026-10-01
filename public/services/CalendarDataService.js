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

    // Observers for the write path, set by the app. Kept as hooks rather than direct
    // Analytics calls so this service stays free of a dependency it does not otherwise
    // have, and so tests can assert on them without a analytics stub.
    static onSyncMerged = null;    // a write reconciled with someone else's concurrent change
    static onSyncFailed = null;    // a write did not land at all
    static onSyncRefused = null;   // a write was refused by the gate below before reaching the network
    static onSyncShape = null;     // every write: how many events it carried vs the last snapshot

    // A user action that legitimately removes events says so here before the watcher
    // fires. The gate in sync() treats an undeclared removal as a bug, because every user
    // path that removes an event goes through the scheduler and declares itself.
    //
    // The declaration carries HOW MANY events the action removed, and is consumed by the
    // first write that follows. A bare time window was wrong: deleting one event opened a
    // 5s hole through which a buggy path could wipe the whole calendar unchallenged
    // (measured -- the server went to zero). Authorising a removal of exactly N means a
    // one-event delete cannot license a 40-event wipe. The short deadline remains only so
    // a declaration cannot sit around indefinitely waiting for an unrelated write.
    // Declarations ACCUMULATE until a write consumes them. The debounce coalesces every
    // edit inside a rolling 500ms window into one sync, so several deletions in quick
    // succession arrive as a single write removing N -- and a declaration that merely
    // overwrote would authorise only the last one and refuse the user's own deletions.
    static _intent = null;
    static declareIntent(removing = 1) {
        const now = Date.now();
        this._intent = (this._intent && now - this._intent.at < 5000)
            ? { removing: this._intent.removing + removing, at: now }
            : { removing, at: now };
    }
    static _takeIntent() {
        const i = this._intent;
        this._intent = null;
        return (i && Date.now() - i.at < 5000) ? i : null;
    }

    // `base` is the server's copy as of the last snapshot. An incomplete row the server
    // already holds (legacy data, written before this check existed) is carried through
    // as the SERVER's copy rather than dropped: the client merely cannot display it, and
    // leaving it out made the merge read it as deleted-by-us and the gate count it as a
    // removal -- so one old dateless event refused every write to that calendar. The
    // server copy, not ours, so an edit that blanked a complete event's dates is still
    // not saved (and is reported); the row just stays as it was.
    static _dropIncompleteEvents(calendar, base = []) {
        if (!calendar) return calendar;
        const events = this._eventList(calendar.events);
        const baseM = this._byKey(base);

        const kept = [], dropped = [];
        for (const e of events) {
            if (Event.isComplete(e)) { kept.push(e); continue; }
            const server = e.id ? baseM.get(this._eventKey(e)) : null;
            if (server) {
                kept.push(server);
                if (Event.isComplete(server)) dropped.push(e);
            } else {
                dropped.push(e);
            }
        }
        // And one the local copy never held at all: no screen can show it, so its absence
        // here cannot be a deliberate delete.
        const held = new Set(events.filter(e => e.id).map(e => this._eventKey(e)));
        for (const [k, e] of baseM) if (!held.has(k) && !Event.isComplete(e)) kept.push(e);

        if (!dropped.length) return { ...calendar, events: kept };

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

        return { ...calendar, events: kept };
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

    // The baseline as it stood BEFORE the snapshot currently being delivered. The inbound
    // merge needs it: by the time a subscription callback runs, _lastSeen has already been
    // advanced to the new snapshot, and diffing local against that makes every local row
    // look like an edit -- which reinstates our stale copy over the change that just
    // arrived, silently reverting the other person's work.
    static _previousSeen = {};

    // Remember what the server just told us. Called from every subscription callback.
    static _rememberSnapshot(calendar) {
        if (!calendar || !calendar.id) return;
        if (Object.prototype.hasOwnProperty.call(this._lastSeen, calendar.id)) {
            this._previousSeen[calendar.id] = this._lastSeen[calendar.id];
        }
        this._lastSeen[calendar.id] = JSON.parse(JSON.stringify(this._eventList(calendar.events)));
    }

    // Firebase returns an array with holes as an object keyed by index ({"0":A,"2":B}),
    // and arrays can carry null slots. Every event list this service stores or reads goes
    // through here: a raw object made the gate's count undefined (so the gate compared
    // NaN and let anything through) and made the merge throw "not iterable".
    static _eventList(events) {
        if (!events || typeof events !== 'object') return [];
        return (Array.isArray(events) ? events : Object.values(events))
            .filter(e => e && typeof e === 'object');
    }

    static _byKey(list) {
        const m = new Map();
        for (const e of this._eventList(list)) if (e.id) m.set(this._eventKey(e), e);
        return m;
    }

    // Compare on meaning, not on JSON text. Firebase does not store null-valued keys,
    // so an event read back from the server lacks recurrenceID/recurrenceException,
    // while the same event rebuilt through Event's constructor has them as null -- and
    // key order differs too. JSON.stringify called those unequal, so EVERY untouched
    // event looked "edited by me" and the merge overwrote the server wholesale. That is
    // last-write-wins again, i.e. precisely the bug the merge exists to prevent.
    static _sameEvent(a, b) {
        if (!a || !b) return a === b;
        const FIELDS = ['title', 'description', 'start', 'end', 'type', 'isAllDay',
            'repeat', 'recurrencerule', 'recurrenceID', 'recurrenceException'];
        const norm = (v) => (v === undefined || v === null || v === '') ? null : v;
        return FIELDS.every(f => {
            const x = norm(a[f]), y = norm(b[f]);
            // type is written as a number locally and can read back as a string.
            if (f === 'type') return String(x === null ? 1 : x) === String(y === null ? 1 : y);
            if (f === 'isAllDay') return !!x === !!y;
            // Same instant, any spelling: nativecal stores epoch numbers and this app
            // rewrites them as ISO strings, so === made every nativecal event look
            // edited-by-us and a stale copy overwrote its concurrent edit.
            if ((f === 'start' || f === 'end') && x !== null && y !== null) {
                const tx = new Date(x).getTime(), ty = new Date(y).getTime();
                if (!Number.isNaN(tx) && !Number.isNaN(ty)) return tx === ty;
            }
            return x === y;
        });
    }

    // What somebody else changed on the server between our baseline and this write --
    // the work the merge had to route around. Diffed base-to-remote, so this client's
    // own adds and deletes (local vs remote) never count as a collision.
    static _concurrentChanges(base, remote) {
        const baseM = this._byKey(base), remoteM = this._byKey(remote);
        let addedByOthers = 0, removedByOthers = 0, changedByOthers = 0;
        for (const [k, e] of remoteM) {
            if (!baseM.has(k)) addedByOthers++;
            else if (!this._sameEvent(baseM.get(k), e)) changedByOthers++;
        }
        for (const k of baseM.keys()) if (!remoteM.has(k)) removedByOthers++;
        return { addedByOthers, removedByOthers, changedByOthers };
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
    // Identity of a row, for every map and comparison below.
    //
    // NOT `e.id` alone. Editing one occurrence of a recurring event stores two rows that
    // deliberately share an id: the series master (recurrenceID null) and the exception
    // for that occurrence (recurrenceID pointing back at the master). Keyed on id alone
    // the two collapse into one -- the second row silently evicts the first -- so a user
    // who edits a single occurrence loses either that occurrence or the whole series.
    static _eventKey(e) {
        return `${e.id}|${e.recurrenceID ?? ''}`;
    }

    static _mergeEvents(base, local, remote) {
        const baseM = this._byKey(base), localM = this._byKey(local), remoteM = this._byKey(remote);
        const same = (a, b) => this._sameEvent(a, b);

        const merged = new Map(remoteM);

        // Ours: added or edited since the last snapshot.
        //
        // "Missing from remote" alone is not enough to mean "ours to add": an event that
        // was in base and is gone from remote was deleted by somebody else, and re-adding
        // it would resurrect their deletion. So an event absent from remote is only ours
        // if it was never in base -- i.e. we created it.
        for (const [id, ev] of localM) {
            if (!baseM.has(id)) { merged.set(id, ev); continue; }   // we created it
            if (!same(baseM.get(id), ev)) merged.set(id, ev);       // we edited it
        }
        // Ours: deleted since the last snapshot -- but only if nobody else has since
        // changed it, in which case their edit is newer information than our delete.
        for (const [id, baseEv] of baseM) {
            if (localM.has(id)) continue;
            const remoteEv = remoteM.get(id);
            if (!remoteEv || same(remoteEv, baseEv)) merged.delete(id);
        }

        // Keep the server's ordering, then append anything new from this client.
        // Keyed the same way as the maps above: on id alone, a recurring master and its
        // occurrence exception share a key, so the second one would be treated as already
        // emitted and dropped from the write.
        const out = [];
        const seen = new Set();
        for (const e of this._eventList(remote)) {
            if (!e.id) continue;
            const k = this._eventKey(e);
            if (merged.has(k)) { out.push(merged.get(k)); seen.add(k); }
        }
        for (const [k, ev] of merged) if (!seen.has(k)) out.push(ev);
        return out;
    }

    // only sync if we have existed
    static sync(calendar) {
        if (calendar && calendar.id && this.connected) {
            // console.log("CalendarDataService.sync()", calendar);

            // Merge the events under a transaction so a concurrent write cannot be lost
            // between the read and the write. Everything else on the calendar (title,
            // options, notes) stays last-write-wins: those are single fields where the
            // later edit is genuinely the intended one, unlike an events array where two
            // people are editing different rows.
            // No baseline means we have never seen this calendar's server state, so we
            // cannot tell "the user deleted this" from "this arrived after we loaded". An
            // empty base says "nothing existed before", which makes every local event an
            // addition (correct -- they still need uploading) and makes no deletion
            // detectable (correct -- we have no evidence anything was deleted). Deletes
            // start working as soon as the first snapshot lands, which is immediate in
            // practice since sync() only runs on a connected calendar.
            const known = Object.prototype.hasOwnProperty.call(this._lastSeen, calendar.id);
            const base = known ? this._eventList(this._lastSeen[calendar.id]) : [];
            // Filtered against the baseline, so incomplete rows the server already holds
            // are carried through untouched and both sides of the gate count them alike.
            const safe = this._dropIncompleteEvents(calendar, base);
            const localEvents = this._sanitizeForFirebase(safe.events);
            const rest = this._sanitizeForFirebase({ ...safe, events: undefined });
            delete rest.events;

            // Report the shape of every write, and refuse any removal the user did not
            // ask for. Every path that legitimately removes an event runs through the
            // scheduler and declares how many it is removing, so an undeclared shrink --
            // or one larger than was declared -- is a bug in a save path, which is exactly
            // what issues #42-#44 were.
            //
            // The refusal is deliberately not silent: it leaves the screen showing fewer
            // events than the server holds, so the caller is handed the server's copy to
            // put back (see onSyncRefused) rather than the user being stranded looking at
            // an empty calendar.
            const prevEvents = base;
            const prevCount = prevEvents.length;
            const nextCount = localEvents.length;
            const removing = prevCount - nextCount;
            const intent = removing > 0 ? this._takeIntent() : null;
            if (typeof this.onSyncShape === 'function') {
                try {
                    this.onSyncShape({ before: prevCount, after: nextCount, intent: !!intent });
                } catch (e) { /* never rethrow */ }
            }
            if (known && removing > 0 && (!intent || removing > intent.removing)) {
                console.error(`[CalendarDataService] refused to save: this write removes ${removing} of ${prevCount} events` +
                    (intent ? ` but only ${intent.removing} were deleted by the user` : ' and no deletion was made'));
                // The known-good events, so the app can restore what it was about to
                // lose instead of leaving the user to discover it on their next reload.
                //
                // Minus anything the user really did delete: the baseline is the last
                // SERVER snapshot, so when a legitimate delete is still in flight and a
                // buggy write arrives behind it, restoring the baseline verbatim would
                // resurrect the event they just removed. Events still present locally
                // are the ones that were never deleted on purpose.
                const localIds = new Set(localEvents.map(e => this._eventKey(e)));
                const deliberatelyGone = intent
                    ? new Set(prevEvents.filter(e => !localIds.has(this._eventKey(e)))
                        .slice(0, intent.removing).map(e => this._eventKey(e)))
                    : new Set();
                const restore = JSON.parse(JSON.stringify(
                    prevEvents.filter(e => !deliberatelyGone.has(this._eventKey(e)))));
                if (typeof this.onSyncRefused === 'function') {
                    // The caller REPLACES its events with this list (no merge: merging
                    // against the baseline reads every dropped row as deleted-by-us and
                    // drops it again), which also puts local back in step with the gate.
                    try {
                        this.onSyncRefused({ before: prevCount, removing, events: JSON.parse(JSON.stringify(restore)) });
                    } catch (e) { /* never rethrow */ }
                }
                // The deletions the user really made are still owed to the server, and the
                // refused write consumed their declaration. Re-declare exactly those and
                // send the corrected list now; otherwise local would sit permanently below
                // the baseline and every later edit would be refused until a reload.
                if (deliberatelyGone.size) {
                    this._intent = { removing: deliberatelyGone.size, at: Date.now() };
                    this.sync({ ...calendar, events: restore });
                }
                return;
            }

            // Filled by the transaction body, read once it commits. The body can run more
            // than once under contention, so only the committed run's value is reported.
            let pendingMerge = null;
            let bodyError = null;

            this.db.child(calendar.id).transaction((current) => {
                pendingMerge = null;
                bodyError = null;
                // A throw in here would escape into Firebase and the edit would vanish
                // without onSyncFailed ever hearing of it. Abort instead, and let the
                // completion callback report it.
                try {
                    // Writing the whole local calendar over a null node would recreate a
                    // calendar someone deleted or reset, so only take that path for one we
                    // have never received a snapshot for. With a live subscription the
                    // node is cached, so a null here means the server really has nothing.
                    if (current === null) {
                        if (known) return; // abort; reported by the completion callback
                        return this._sanitizeForFirebase(safe);
                    }
                    const remoteEvents = this._eventList(current.events);
                    // options is a bag of independent keys, not one field, so a shallow spread
                    // is wrong: a client whose local options predate another client's
                    // autoCreateReadOnlyLink would erase publicViewId, and every /view/ link
                    // already shared would stop resolving. Merge the keys instead.
                    const mergedOptions = (current.options || rest.options)
                        ? { ...(current.options || {}), ...(rest.options || {}) }
                        : undefined;

                    // Did this write actually have to reconcile with somebody else? Only
                    // changes made on the server since our baseline count; without a
                    // baseline everything would look foreign. Reported after commit.
                    pendingMerge = known ? this._concurrentChanges(base, remoteEvents) : null;

                    const next = {
                        ...current,
                        ...rest,
                        events: this._mergeEvents(base, localEvents, remoteEvents),
                    };
                    if (mergedOptions) next.options = mergedOptions;
                    return next;
                } catch (err) {
                    bodyError = err;
                    return;
                }
            }, (error, committed, snapshot) => {
                // An abort is not retried by Firebase: it arrives as (null, false), and
                // treating only `error` as failure lost the edit in silence.
                const failure = error || bodyError ||
                    (!committed ? new Error('sync transaction aborted: no calendar on the server to merge into') : null);
                if (failure) {
                    // A failed write is the one thing a user must never discover later.
                    // Surfaced to them, and counted, because the console is not a channel
                    // anybody watches.
                    console.error('[CalendarDataService] sync transaction failed', failure);
                    if (typeof this.onSyncFailed === 'function') {
                        try { this.onSyncFailed(failure); } catch (e) { /* never rethrow */ }
                    }
                } else if (snapshot) {
                    // Our write is now the baseline for the next diff.
                    this._rememberSnapshot({ id: calendar.id, events: snapshot.val()?.events });

                    const m = pendingMerge;
                    if (m && (m.addedByOthers || m.removedByOthers || m.changedByOthers)
                        && typeof this.onSyncMerged === 'function') {
                        try { this.onSyncMerged(m); } catch (e) { /* never rethrow */ }
                    }
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


    // The 500ms debounce is a real data-loss window: an edit followed by a reload or a
    // backgrounded mobile tab inside it never reaches the server (measured: a create
    // followed by reload 50ms later is lost). flush() lets the page send the pending write
    // immediately on pagehide/visibilitychange. _pending is cleared by whichever runs
    // first so the other becomes a no-op rather than a duplicate write.
    static _pending = null;
    static debounce_sync = (() => {
        const debounced = Utils.debounce((cal) => {
            if (CalendarDataService._pending !== cal) return;   // already flushed
            CalendarDataService._pending = null;
            CalendarDataService.sync(cal);
        }, 500);
        return (cal) => { CalendarDataService._pending = cal; debounced(cal); };
    })();
    static flush() {
        const cal = this._pending;
        if (!cal) return;
        this._pending = null;
        this.sync(cal);
    }

    static create(item) {
        return this.db.push(this._sanitizeForFirebase(item));
    }

    /**
     * Is this slug taken? Answered case-INSENSITIVELY, because that is how slugs resolve.
     *
     * Reading db.child(id) alone only sees the exact key, so claiming "n2u5h6ch" could not
     * see that "N2U5H6CH" already existed -- and the claim then created a second, empty
     * calendar whose id trigger took the shared mapping, leaving the original owner
     * looking at a blank calendar. lookupCalendar resolves the slug the same way the rest
     * of the app does, so it sees a twin under any casing.
     */
    static checkExists(id, callback_yes, callback_no) {
        this.db.child(id).once('value', async data => {
            if (data.val()) { callback_yes(); return; }
            try {
                const lookupCalendar = firebase.functions().httpsCallable('lookupCalendar');
                const result = await lookupCalendar({ slug: id });
                if (result?.data?.found) { callback_yes(); return; }
            } catch (err) {
                // A lookup failure must not block a legitimate claim: fall through to the
                // exact-key answer, which is what this method did before.
                console.warn('[CalendarDataService] case-insensitive existence check failed', err);
            }
            callback_no();
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
