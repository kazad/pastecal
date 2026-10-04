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
    static onSyncPaused = null;    // this tab went over its write budget and stopped saving

    // Write budget. A person saves a few times a minute; a bug that saves in a loop saves
    // twice a second, forever -- Sep 26, one tab did that for 17 hours (14 GB of downloads).
    // Past the budget this tab stops writing until reload. Unsaved work is not lost: every
    // pending write is in the local journal first (debounce_sync), and replays on reload.
    static WRITE_BUDGET = { max: 40, windowMs: 60 * 1000 };
    static _writeTimes = [];
    static _paused = false;
    static _overWriteBudget(now) {
        if (this._paused) return true;
        if (now === undefined) now = Date.now();
        const { max, windowMs } = this.WRITE_BUDGET;
        this._writeTimes = this._writeTimes.filter((t) => now - t < windowMs);
        this._writeTimes.push(now);
        if (this._writeTimes.length <= max) return false;
        this._paused = true;
        console.error(`[CalendarDataService] saving paused: ${this._writeTimes.length} writes in ${windowMs / 1000}s`);
        if (typeof this.onSyncPaused === 'function') {
            try { this.onSyncPaused({ writes: this._writeTimes.length }); } catch (e) { /* never rethrow */ }
        }
        return true;
    }

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
    //
    // `keys` names WHICH rows (by _eventKey) the action removed. A count alone cannot say
    // which of the missing rows were deleted on purpose, and the refusal path below once
    // guessed by baseline order -- re-sending a deletion of an event the user never
    // touched. Without keys (null), nothing is treated as a deliberate removal there.
    // Which browser made a write. Stamped as top-level `_writer` on every calendar write,
    // and the history trigger copies it onto the entry: Cmd+Z then only reaches for this
    // browser's own entries, and the server only coalesces a drag's writes when one
    // browser made them all. Per browser rather than per tab, so a reload or a second tab
    // can still undo what this browser did.
    //
    // Every write sets it, never only some: the node keeps the last value, so a write
    // that left it out would be attributed to whoever wrote before.
    static WRITER_KEY = 'pastecal_writer_id';
    static _writerId = null;
    static get writerId() {
        if (this._writerId) return this._writerId;
        let id = null;
        try { id = localStorage.getItem(this.WRITER_KEY); } catch (e) { /* storage blocked */ }
        if (!id || typeof id !== 'string') {
            id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            // Unpersisted (private mode, blocked storage) it still identifies this page.
            try { localStorage.setItem(this.WRITER_KEY, id); } catch (e) { /* in memory only */ }
        }
        return (this._writerId = id);
    }

    // Server bookkeeping on the calendar node, not calendar data. Stripped from every
    // snapshot before the app sees it: import() would otherwise copy `_writer` onto the
    // calendar, and every later write would carry another browser's id back as ours.
    static META_KEYS = ['_writer'];
    static _withoutMeta(calendar) {
        if (!calendar || typeof calendar !== 'object') return calendar;
        if (!this.META_KEYS.some(k => k in calendar)) return calendar;
        const out = { ...calendar };
        for (const k of this.META_KEYS) delete out[k];
        return out;
    }

    // Equal as Firebase would store them: null, undefined and empty containers are absent
    // there, and key order is not data.
    static _sameNode(a, b) {
        const canon = (v) => {
            if (v === undefined || v === null) return undefined;
            if (typeof v !== 'object') return v;
            const out = {};
            for (const k of Object.keys(v).sort()) {
                const c = canon(v[k]);
                if (c !== undefined) out[k] = c;
            }
            return Object.keys(out).length ? out : undefined;
        };
        return JSON.stringify(canon(a) ?? null) === JSON.stringify(canon(b) ?? null);
    }

    static _intent = null;
    static declareIntent(removing = 1, keys = null) {
        const now = Date.now();
        const live = this._intent && now - this._intent.at < 5000 ? this._intent : null;
        const ours = Array.isArray(keys) ? keys.map(String) : null;
        // One declaration with unknown keys makes the whole accumulated set unknown.
        const merged = !live ? ours
            : (live.keys && ours ? [...live.keys, ...ours] : null);
        this._intent = { removing: (live ? live.removing : 0) + removing, keys: merged, at: now };
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
            var calendar = this._withoutMeta(data.val());
            if (calendar && calendar.id) {
                this.connected = slug;
                this._rememberSnapshot(calendar);
                this._replayJournal(calendar && calendar.id);

                this.validateCalendarData(calendar);
                callback(calendar);
            } else {
                // Calendar not found with exact case - try case-insensitive lookup for editable calendars only
                try {
                    console.log('Fallback lookup for slug:', slug);
                    console.log('Calling function with data:', { slug: slug });
                    const result = await this.lookupCalendar(slug);

                    if (result.data?.found && !result.data.isReadOnly) {
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
                var calendar = this._withoutMeta(data.val());
                if (calendar && calendar.id) {
                    this.connected = slug;
                    this._rememberSnapshot(calendar);
                    this._replayJournal(calendar && calendar.id);

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
            const result = await this.lookupCalendar(slug);
            console.log('Function result:', result);

            if (result.data?.found) {
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
                var calendar = this._withoutMeta(data.val());
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
    /**
     * When the calendar was last really edited, stored ON the calendar (lastEditedAt), so the
     * header's "Edited N ago" comes with the data every viewer already has -- no extra read,
     * and live when someone else edits. The rule is the server's own (HistoryService.
     * stampLastEdit): an edit is a change to the events, the title or the options. A write
     * that changes none of those (settings defaults, a viewer's echo) keeps the SERVER's
     * value -- never the local copy's, which may be older and would move the label backwards.
     */
    static _lastEditedAt(current, next, now) {
        const events = (c) => { const v = c && c.events; return (Array.isArray(v) ? v : Object.values(v || {})).filter(Boolean); };
        const F = ['title', 'description', 'start', 'end', 'type', 'isAllDay', 'repeat', 'recurrencerule', 'recurrenceID', 'recurrenceException'];
        const norm = (v) => (v === undefined || v === null || v === '') ? null : String(v);
        // A date compares by instant: an epoch number and its ISO string are the same value.
        const when = (v) => { const n = norm(v); if (n === null) return null; const t = new Date(v).getTime(); return Number.isNaN(t) ? n : String(t); };
        const sig = (e) => F.map((f) => (f === 'type' ? String(parseInt(e[f], 10) || 1)
            : (f === 'start' || f === 'end') ? when(e[f]) : norm(e[f]))).join('\u0001');
        // Compared as a sorted list, not a map by id: a calendar holding two events with the
        // same id (old data has them) made one of them look changed on EVERY write, so each
        // echo stamped a new time, the new time came back as a change, and an open NativeCal
        // tab re-saved twice a second for 17 hours (Sep 26: 9 GB of downloads in a day).
        const all = (c) => events(c).map((e) => this._eventKey(e) + '\u0002' + sig(e)).sort().join('\u0003');
        const changed = (current.title ?? '') !== (next.title ?? '')
            || JSON.stringify(current.options ?? null) !== JSON.stringify(next.options ?? null)
            || all(current) !== all(next);
        return changed ? now : (current.lastEditedAt ?? null);
    }

    // Server time, estimated from Firebase's measured clock offset, so a laptop with a wrong
    // clock cannot stamp an edit hours into the future.
    static _serverNow() {
        if (this._timeOffset === undefined && typeof firebase !== 'undefined' && firebase.database) {
            this._timeOffset = 0;
            try { firebase.database().ref('.info/serverTimeOffset').on('value', (s) => { this._timeOffset = s.val() || 0; }); } catch (e) { /* keep 0 */ }
        }
        return Date.now() + (this._timeOffset || 0);
    }

    static _eventKey(e) {
        return `${e.id}|${e.recurrenceID ?? ''}`;
    }

    static _mergeEvents(base, local, remote, { yieldOnConflict = false } = {}) {
        // Old calendars can hold two events with the same id. Keyed on the id alone, the
        // second evicted the first and the write stored the second one TWICE -- the first
        // event was gone (found Sep 27). The nth repeat of a key is its own key, "#n".
        const keysOf = (list) => {
            const count = new Map();
            return list.map((e) => {
                if (!e.id) return null;
                const k = this._eventKey(e), n = count.get(k) || 0;
                count.set(k, n + 1);
                return n ? `${k}#${n}` : k;
            });
        };
        const byId = (events) => {
            const list = this._eventList(events);
            const m = new Map(), keys = keysOf(list);
            list.forEach((e, i) => { if (keys[i]) m.set(keys[i], e); });
            return m;
        };
        const baseM = byId(base), localM = byId(local), remoteM = byId(remote);
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
            if (same(baseM.get(id), ev)) continue;                  // untouched by us
            // We edited it. A REPLAYED write (see _replayJournal) can be hours or days
            // old, so if anyone else has changed or deleted this event since, theirs is
            // the newer intent and it stands. A live write is the newest thing that
            // happened, so it applies as before.
            if (yieldOnConflict && !same(remoteM.get(id), baseM.get(id))) continue;
            merged.set(id, ev);
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
        const remoteList = this._eventList(remote), remoteKeys = keysOf(remoteList);
        for (const k of remoteKeys) {
            if (k && merged.has(k)) { out.push(merged.get(k)); seen.add(k); }
        }
        for (const [k, ev] of merged) if (!seen.has(k)) out.push(ev);
        return out;
    }

    // only sync if we have existed
    static sync(calendar, opts = {}) {
        if (calendar && calendar.id && this.connected) {
            if (this._overWriteBudget()) return;
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
            // A replay (see _replayJournal) carries the baseline it was made against, so the
            // merge applies only what THIS user changed, on top of whatever others did since.
            const replay = Array.isArray(opts.base) || opts.base === null;
            const known = replay
                ? opts.base !== null
                : Object.prototype.hasOwnProperty.call(this._lastSeen, calendar.id);
            const base = known ? this._eventList(replay ? opts.base : this._lastSeen[calendar.id]) : [];
            // Filtered against the baseline, so incomplete rows the server already holds
            // are carried through untouched and both sides of the gate count them alike.
            const safe = this._dropIncompleteEvents(calendar, base);
            const localEvents = this._sanitizeForFirebase(safe.events);
            const rest = this._sanitizeForFirebase({ ...this._withoutMeta(safe), events: undefined });
            delete rest.events;
            rest._writer = this.writerId;

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
            const intent = removing > 0
                ? (replay ? (opts.intentRemoving > 0 ? { removing: opts.intentRemoving } : null) : this._takeIntent())
                : null;
            if (typeof this.onSyncShape === 'function') {
                try {
                    this.onSyncShape({ before: prevCount, after: nextCount, intent: !!intent });
                } catch (e) { /* never rethrow */ }
            }
            if (known && removing > 0 && (!intent || removing > intent.removing)) {
                console.error(`[CalendarDataService] refused to save: this write removes ${removing} of ${prevCount} events` +
                    (intent ? ` but only ${intent.removing} were deleted by the user` : ' and no deletion was made'));
                // A refused write will be refused every time; never replay it.
                this._journalClear(calendar.id, opts.journalT);
                // Only the unexplained REMOVALS are reverted; everything else this write
                // carried is the user's work and is kept: rows it added, and its edits to
                // rows that still exist. Restoring the bare baseline silently dropped an
                // event quick-added or a title typed in the same 500ms debounce window.
                //
                // A removal is deliberate only if the delete that declared it named that
                // row. Guessing from the count (the first N missing rows in baseline
                // order) re-sent a deletion of an event the user never touched and
                // resurrected the one they did; with no names, restore everything and let
                // the user redo the delete.
                const key = (e) => this._eventKey(e);
                const localByKey = new Map(localEvents.map(e => [key(e), e]));
                const baseKeys = new Set(prevEvents.map(key));
                const declared = new Set(intent && intent.keys ? intent.keys : []);
                const deliberatelyGone = new Set(prevEvents.map(key)
                    .filter(k => !localByKey.has(k) && declared.has(k)));
                const recovered = prevEvents.filter(e => !localByKey.has(key(e)) && !deliberatelyGone.has(key(e)));
                const kept = prevEvents.filter(e => !deliberatelyGone.has(key(e)))
                    .map(e => localByKey.get(key(e)) || e);
                const added = localEvents.filter(e => !baseKeys.has(key(e)));
                const restore = JSON.parse(JSON.stringify([...kept, ...added]));
                // A replay runs on page load with the server's copy already on screen, so there
                // is nothing to restore -- and handing back its OLD baseline would.
                if (!replay && typeof this.onSyncRefused === 'function') {
                    // The caller REPLACES its events with this list (no merge: merging
                    // against the baseline reads every dropped row as deleted-by-us and
                    // drops it again), which also puts local back in step with the gate.
                    try {
                        this.onSyncRefused({ before: prevCount, removing, recovered: recovered.length,
                            events: JSON.parse(JSON.stringify(restore)) });
                    } catch (e) { /* never rethrow */ }
                }
                // What the user really did -- named deletions, additions, edits -- is still
                // owed to the server, and the refused write consumed the declaration.
                // Re-declare exactly the named deletions and send the corrected list now;
                // otherwise the work is lost, or local sits below the baseline and every
                // later edit is refused until a reload.
                const edited = prevEvents.some(e => localByKey.has(key(e))
                    && !this._sameEvent(e, localByKey.get(key(e))));
                if (!replay && (deliberatelyGone.size || added.length || edited)) {
                    this._intent = prevCount > restore.length
                        ? { removing: prevCount - restore.length, keys: [...deliberatelyGone], at: Date.now() }
                        : null;
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
                        return this._sanitizeForFirebase({ ...this._withoutMeta(safe), lastEditedAt: this._serverNow(), _writer: this.writerId });
                    }
                    const remoteEvents = this._eventList(current.events);
                    // options is a bag of independent keys, not one field, so a shallow spread
                    // is wrong: a client whose local options predate another client's
                    // autoCreateReadOnlyLink would erase publicViewId, and every /view/ link
                    // already shared would stop resolving. Merge the keys instead.
                    const mergedOptions = (!replay) && (current.options || rest.options)
                        ? { ...(current.options || {}), ...(rest.options || {}) }
                        : undefined;

                    // Did this write actually have to reconcile with somebody else? Only
                    // changes made on the server since our baseline count; without a
                    // baseline everything would look foreign. Reported after commit.
                    pendingMerge = known ? this._concurrentChanges(base, remoteEvents) : null;

                    const next = {
                        ...current,
                        // A replay restores lost EVENT changes only; the calendar's title,
                        // notes and settings are single fields whose server copy is newer.
                        ...(replay ? { _writer: rest._writer } : rest),
                        events: this._mergeEvents(base, localEvents, remoteEvents, { yieldOnConflict: replay }),
                    };
                    if (mergedOptions) next.options = mergedOptions;
                    next.lastEditedAt = this._lastEditedAt(current, next, this._serverNow());
                    // A write that changes nothing else leaves `_writer` as it was. Nothing
                    // happened to attribute -- and nativecal echoes every snapshot it
                    // imports back through sync(), so two open browsers would otherwise
                    // flip the id back and forth, each flip a fresh snapshot, forever.
                    if (this._sameNode({ ...next, _writer: null }, { ...current, _writer: null })) {
                        next._writer = current._writer ?? null;
                    }
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
                    // The server has it: the unsent-write record is no longer needed.
                    this._journalClear(calendar.id, opts.journalT);

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
    static _pendingT = null;
    static debounce_sync = (() => {
        const debounced = Utils.debounce((cal) => {
            if (CalendarDataService._pending !== cal) return;   // already flushed
            CalendarDataService._pending = null;
            CalendarDataService.sync(cal, { journalT: CalendarDataService._pendingT });
        }, 500);
        return (cal) => {
            CalendarDataService._pending = cal;
            // Record it locally FIRST. See _journalWrite.
            CalendarDataService._pendingT = CalendarDataService._journalWrite(cal);
            debounced(cal);
        };
    })();
    static flush() {
        const cal = this._pending;
        if (!cal) return;
        this._pending = null;
        this.sync(cal, { journalT: this._pendingT });
    }

    // ---- Unsent-write journal ----------------------------------------------------------
    //
    // flush() on pagehide cannot save anything: sync() is a Firebase transaction, which
    // needs a round trip, and the page is gone before the reply. Measured on live
    // pastecal.com (Sep 24): an event created and then the tab closed within ~0.5s was
    // LOST, every time -- flush or no flush. On a phone, switching apps does the same.
    //
    // So every pending write is first recorded in localStorage, which is synchronous and
    // survives the tab closing. It is removed once the server confirms. The next time
    // this calendar opens, anything still recorded is replayed through the same three-way
    // merge, against the baseline it was made from -- so only this user's own changes are
    // applied, on top of whatever others did in between. Replaying something that DID
    // arrive is harmless: adds and edits land on the same rows, deletes find nothing.
    static JOURNAL_PREFIX = 'pastecal_unsent:';
    static JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    static _replayed = {};

    static _journalWrite(calendar) {
        try {
            if (!calendar || !calendar.id || typeof localStorage === 'undefined') return null;
            const id = calendar.id;
            if (!this.connected) return null;   // a homepage draft: nothing on the server yet
            const known = Object.prototype.hasOwnProperty.call(this._lastSeen, id);
            const pendingIntent = (this._intent && Date.now() - this._intent.at < 5000) ? this._intent.removing : 0;
            const t = Date.now();
            localStorage.setItem(this.JOURNAL_PREFIX + id, JSON.stringify({
                v: 1, t,
                base: known ? this._lastSeen[id] : null,
                calendar: this._sanitizeForFirebase(calendar),
                intentRemoving: pendingIntent,
            }));
            return t;
        } catch (e) {
            // Quota or disabled storage: the write still goes out normally, it just has
            // no safety net if the tab closes in the next half second.
            return null;
        }
    }

    static _journalRead(id) {
        try {
            const raw = localStorage.getItem(this.JOURNAL_PREFIX + id);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    // Clear the record only if it is not NEWER than the write that just committed --
    // otherwise an edit made while an earlier write was in flight would lose its net.
    static _journalClear(id, t) {
        try {
            const entry = this._journalRead(id);
            if (!entry) return;
            if (t == null || entry.t <= t) localStorage.removeItem(this.JOURNAL_PREFIX + id);
        } catch (e) { /* never rethrow */ }
    }

    static _replayJournal(id) {
        if (!id || this._replayed[id]) return;
        this._replayed[id] = true;
        const entry = this._journalRead(id);
        if (!entry || !entry.calendar) return;
        if (Date.now() - entry.t > this.JOURNAL_MAX_AGE_MS) { this._journalClear(id, entry.t); return; }
        console.log('[CalendarDataService] replaying a write that never reached the server, from', new Date(entry.t).toISOString());
        if (typeof this.onJournalReplay === 'function') {
            try { this.onJournalReplay({ ageMs: Date.now() - entry.t }); } catch (e) { /* never rethrow */ }
        }
        this.sync(entry.calendar, { base: entry.base, intentRemoving: entry.intentRemoving, journalT: entry.t });
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
        // Names the site itself routes (pastecal.com/beta/..., /view/..., /nativecal/...) are
        // "taken": a calendar claimed under one would have an address that opens something else.
        if (['beta', 'nativecal', 'view', 'dev'].includes(String(id || '').toLowerCase())) { callback_yes(); return; }
        this.db.child(id).once('value', async data => {
            if (data.val()) { callback_yes(); return; }
            try {
                const result = await this.lookupCalendar(id);
                if (result?.data?.found) { callback_yes(); return; }
            } catch (err) {
                // A lookup failure must not block a legitimate claim: fall through to the
                // exact-key answer, which is what this method did before.
                console.warn('[CalendarDataService] case-insensitive existence check failed', err);
            }
            callback_no();
        });
    }

    /**
     * `asCreator: false` is for copies (rename): the browser writing a copy did not
     * create the original, so it is recorded as an ordinary editor of the new id.
     */
    static createWithId(key, value, success, { asCreator = true } = {}) {
        // Born edited: the header's "Edited N ago" reads lastEditedAt (see _lastEditedAt).
        const data = this._sanitizeForFirebase({ ...this._withoutMeta(value), lastEditedAt: this._serverNow(), _writer: this.writerId });
        const plainSet = () => this.db.child(key).set(data, (error) => {
            if (error) {
                console.log("error creating calendar", error, key, value);
            } else {
                if (!asCreator && typeof AuthorSignal !== 'undefined') {
                    AuthorSignal.touch(key);
                }
                success();
            }
        });

        // The strongest ownership signal there is: whoever was present when the
        // calendar first existed. Written in the same update as the calendar because
        // the rules accept createdHere only in the write that creates it.
        const authorRecord = asCreator && typeof AuthorSignal !== 'undefined'
            ? AuthorSignal.creationRecord(key) : null;
        if (!authorRecord) return plainSet();

        return firebase.database().ref()
            .update(Object.assign({ [`calendars/${key}`]: data }, authorRecord))
            .then(() => success(), (error) => {
                // The update is atomic, so a rejected author record would also drop the
                // calendar. Authorship is observational: create it without one instead.
                console.warn('[CalendarDataService] creating with author record failed; retrying without', error);
                return plainSet();
            });
    }

    static update(key, value) {
        return this.db.child(key).update(this._sanitizeForFirebase({ ...value, _writer: this.writerId }));
    }

    static delete(key) {
        return this.db.child(key).remove();
    }

    static async lookupCalendar(slug) {
        if (typeof CloudCalendarService !== 'undefined' && CloudCalendarService.enabled()) {
            return await CloudCalendarService.lookupCalendar(slug);
        }
        const fn = firebase.functions().httpsCallable('lookupCalendar');
        return await fn({ slug });
    }

    static async createPublicLink(params) {
        if (typeof CloudCalendarService !== 'undefined' && CloudCalendarService.enabled()) {
            return await CloudCalendarService.createPublicLink(params);
        }
        const fn = firebase.functions().httpsCallable('createPublicLink');
        return await fn(params);
    }

    static async loadUndoEntries(calendarId) {
        if (typeof CloudCalendarService !== 'undefined' && CloudCalendarService.enabled()) {
            return await CloudCalendarService.loadUndoEntries(calendarId);
        }
        return null;
    }
}
