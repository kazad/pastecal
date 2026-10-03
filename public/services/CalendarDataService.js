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
    static META_KEYS = ['_writer', '_undoOf', '_gesture'];
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

    // A user action that removes events NAMES the rows it removes (by _eventKey) here,
    // before the watcher fires. The gate in sync() refuses any row that leaves the
    // calendar without being named: every user path that removes an event declares it,
    // so an unnamed removal is a bug in a save path (issues #42-#44).
    //
    // By name, never by count. A count authorised the NET shrink, so a write that dropped
    // B while adding D passed, declaring A licensed losing B, and a delete+add netting
    // zero left the declaration live for the next buggy write to spend.
    //
    // A declared key belongs to the pending change, not to a clock: it stays until a
    // write that was computed with it COMMITS, which either carried the deletion to the
    // server or (the row being back, e.g. undone) superseded it. A 5s expiry instead
    // refused the user's own delete whenever they kept typing past it -- the debounce
    // restarts on every keystroke -- and then lost the typing too.
    static _pendingDeletes = new Set();
    static declareIntent(keys) {
        if (!Array.isArray(keys)) {
            console.error('[CalendarDataService] declareIntent takes the removed rows\' keys');
            return;
        }
        for (const k of keys) this._pendingDeletes.add(String(k));
    }

    // What a write IS, for the history trigger, which copies these onto the entry:
    //   _undoOf  -- the history entry keys (or, for this session's own action whose entry
    //               key is not known yet, its gesture id) that this write reverses. Cmd+Z
    //               reads it back from /history, so "that was an undo" survives a reload
    //               instead of being guessed from timing.
    //   _gesture -- one user action: a drag/resize from its start to its final save, or a
    //               single scheduler action. The server folds saves of one gesture into one
    //               entry, instead of folding anything inside a 60s window.
    // Like _writer, every write sets both, null when absent: the node keeps the last
    // value, so a write that left them out would inherit the previous write's.
    static _pendingUndoOf = [];
    static markUndo(ids) {
        for (const id of ids || []) {
            if (id && !this._pendingUndoOf.includes(String(id))) this._pendingUndoOf.push(String(id));
        }
    }
    static _gesture = null;   // { id, ending }
    static _newId(prefix) {
        return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    /** A drag or resize started: its saves, through the final one, carry this id. */
    static beginGesture() {
        this._gesture = { id: this._newId('g'), ending: false };
        return this._gesture.id;
    }
    /** The gesture ended: the next write is its final save, and then it is cleared. */
    static endGesture() {
        if (this._gesture) this._gesture.ending = true;
    }
    /** The gesture a user action belongs to -- the open drag, or a one-save gesture. */
    static actionGesture() {
        if (!this._gesture) this._gesture = { id: this._newId('g'), ending: true };
        return this._gesture.id;
    }
    // Read once per write that is actually sent; an ended gesture and the undo marks are
    // spent by it.
    static _takeWriteMeta() {
        const g = this._gesture;
        const meta = {
            _gesture: g ? g.id : null,
            _undoOf: this._pendingUndoOf.length ? [...this._pendingUndoOf] : null,
        };
        if (g && g.ending) this._gesture = null;
        this._pendingUndoOf = [];
        return meta;
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

    // subscribe to live updates.
    //
    // `localCopy` returns the calendar the app is showing (and editing). Each snapshot is
    // delivered already merged with it -- see _receive -- so an app only ever imports
    // what it is handed. Without it, snapshots arrive as the server sent them.
    static subscribe(slug, callback, localCopy = null) {
        if (!slug) return;

        // First try exact case match
        this.db.child(slug).on('value', async data => {
            var calendar = this._withoutMeta(data.val());
            if (calendar && calendar.id) {
                this.connected = slug;
                calendar = this._receive(calendar, localCopy);

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
                        this._subscribeExact(result.data.actualSlug, callback, localCopy);
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
    static _subscribeExact(slug, callback, localCopy = null) {
        if (slug) {
            this.db.child(slug).on('value', data => {
                var calendar = this._withoutMeta(data.val());
                if (calendar && calendar.id) {
                    this.connected = slug;
                    calendar = this._receive(calendar, localCopy);

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
    static async findAndSubscribe(slug, callback, localCopy = null) {
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
                    this._subscribeExact(result.data.actualSlug, callback, localCopy);
                }
            } else {
                // Calendar doesn't exist in any case - try direct subscription (might be new)
                this._subscribeExact(slug, callback, localCopy);
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
            this._subscribeExact(slug, callback, localCopy);
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


    // The baseline: per calendar id, the server's events as the LOCAL COPY last
    // incorporated them. Both 3-way merges diff against it -- the outbound one in sync()
    // (what did this client change?) and the inbound one in _receive (what did the
    // server change?) -- because both ask what the local copy derives from.
    //
    // There used to be two globals instead: _lastSeen, advanced by every snapshot, and
    // _previousSeen, "the one before", which each app had to remember to use. nativecal
    // never did -- it imported snapshots bare, overwriting edits still in the debounce
    // window and resurrecting deletions not yet sent -- and the main app's own merge read
    // whichever baseline happened to be current when its callback ran. The baseline now
    // moves only when the local copy actually takes in a server state.
    static _base = {};

    // Calendars whose server state reaches the local copy through a live subscription.
    // For those, every state a write commits is also delivered as a snapshot (Firebase
    // raises the value event for a transaction's result), and _receive moves the
    // baseline. Without one, the commit itself is the only news, so sync() records it.
    static _live = new Set();

    static _hasBase(id) {
        return Object.prototype.hasOwnProperty.call(this._base, id);
    }

    // Record a server state as the baseline without merging (no local copy to merge:
    // a write's commit with no subscription, or a test standing in for one).
    static _rememberSnapshot(calendar) {
        if (!calendar || !calendar.id) return;
        this._base[calendar.id] = JSON.parse(JSON.stringify(this._eventList(calendar.events)));
    }

    // One inbound snapshot, as the local copy should take it in: the 3-way merge of the
    // baseline, the local copy (with any edits not yet written), and the incoming
    // server state. The incoming state becomes the baseline, because after the merge the
    // local copy holds all of it plus only its own pending changes.
    //
    // Only events are merged. Title and options are single fields whose later write is
    // the intended one, as on the write path.
    static _receive(calendar, localCopy = null) {
        const id = calendar.id;
        this._live.add(id);
        const incoming = this._eventList(calendar.events);
        let local = null;
        try { local = typeof localCopy === 'function' ? localCopy() : null; } catch (e) { local = null; }
        let events = incoming;
        // Same calendar only: an app still showing its homepage draft has no edits to
        // this one. And no baseline means nothing to diff against -- the first snapshot.
        if (local && local.id === id && this._hasBase(id)) {
            events = this._mergeEvents(this._base[id], this._eventList(local.events), incoming);
        }
        this._base[id] = JSON.parse(JSON.stringify(incoming));
        return { ...calendar, events: JSON.parse(JSON.stringify(events)) };
    }

    // Firebase returns an array with holes as an object keyed by index ({"0":A,"2":B}),
    // and arrays can carry null slots. Every event list this service stores or reads goes
    // through here: a raw object made the gate's count undefined (so the gate compared
    // NaN and let anything through) and made the merge throw "not iterable".
    // Every event has an identity, including rows stored without one (written by old
    // clients or by hand). An id-less row used to be invisible to _byKey and the merge but
    // counted by the write gate as "undefined|" -- so it read as an unnamed removal on every
    // save, the refusal restored it, the retry dropped it again, and the calendar could
    // never be saved (an infinite refusal loop). Such rows now get an id derived from their
    // content, the same on every client, at the one place stored events enter the service;
    // the next save writes it back, healing the data.
    static _eventList(events) {
        if (!events || typeof events !== 'object') return [];
        const seen = new Map();
        return (Array.isArray(events) ? events : Object.values(events))
            .filter(e => e && typeof e === 'object')
            .map(e => (e.id ? e : { ...e, id: this._contentId(e, seen) }));
    }

    static _contentId(e, seen) {
        const text = JSON.stringify([e.title ?? '', e.start ?? '', e.end ?? '', e.description ?? '',
            e.recurrencerule ?? '', e.recurrenceID ?? '']);
        let h = 0x811c9dc5;                                  // FNV-1a, 32-bit
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        const base = `legacy-${h.toString(36)}`;
        const n = seen.get(base) || 0;                       // identical rows stay distinct
        seen.set(base, n + 1);
        return n ? `${base}-${n}` : base;
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
        // allDayDates is compared by the days it names (CalDate.allDayKey), not as a
        // field: the same row with and without it (as a client that predates it writes)
        // is one event when it covers the same days, and a correction that changes only
        // the dates (possible at UTC-11/UTC+14, where the instants stay put) is an edit.
        if (CalDate.allDayKey(a) !== CalDate.allDayKey(b)) return false;
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
    static sync(calendar, { isRetry = false } = {}) {
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
            const known = this._hasBase(calendar.id);
            const base = known ? this._eventList(this._base[calendar.id]) : [];
            // Filtered against the baseline, so incomplete rows the server already holds
            // are carried through untouched and both sides of the gate count them alike.
            const safe = this._dropIncompleteEvents(calendar, base);
            const localEvents = this._sanitizeForFirebase(safe.events);
            const rest = this._sanitizeForFirebase({ ...this._withoutMeta(safe), events: undefined });
            delete rest.events;
            rest._writer = this.writerId;

            // Report the shape of every write, and refuse any removal the user did not
            // name. Every path that legitimately removes an event declares the rows it
            // removes (declareIntent), so a row that leaves without being named is a bug
            // in a save path -- exactly what issues #42-#44 were.
            //
            // Row by row: `gone` is the baseline's rows the local copy no longer holds.
            // Counting (before - after) let an addition hide a loss and let any declared
            // row license any other.
            //
            // The refusal is deliberately not silent: it leaves the screen showing fewer
            // events than the server holds, so the caller is handed the server's copy to
            // put back (see onSyncRefused) rather than the user being stranded looking at
            // an empty calendar.
            const key = (e) => this._eventKey(e);
            const prevEvents = base;
            const localByKey = new Map(localEvents.map(e => [key(e), e]));
            const gone = prevEvents.map(key).filter(k => !localByKey.has(k));
            // The declarations this write is computed with -- and resolves, once it commits.
            const declared = new Set(this._pendingDeletes);
            const unnamed = gone.filter(k => !declared.has(k));
            if (typeof this.onSyncShape === 'function') {
                try {
                    this.onSyncShape({ before: prevEvents.length, after: localEvents.length,
                        intent: gone.length > 0 && !unnamed.length });
                } catch (e) { /* never rethrow */ }
            }
            if (known && unnamed.length && isRetry) {
                // The corrected re-send was refused too. It removes only declared rows, so
                // this means the gate and the corrected list disagree about identity -- a bug,
                // but recursing again would loop forever. Stop and say so.
                console.error('[CalendarDataService] corrected write refused again; not retrying');
                if (typeof this.onSyncFailed === 'function') {
                    try { this.onSyncFailed(new Error('save refused twice')); } catch (e) { /* never rethrow */ }
                }
                return;
            }
            if (known && unnamed.length) {
                console.error(`[CalendarDataService] refused to save: this write removes ${unnamed.length} of ` +
                    `${prevEvents.length} events that no deletion named`);
                // Only the unnamed removals are reverted; everything else this write
                // carried is the user's work and is kept: rows it added, its edits to
                // rows that still exist, and the deletions the user named.
                const lost = new Set(unnamed);
                const kept = prevEvents.filter(e => localByKey.has(key(e)) || lost.has(key(e)))
                    .map(e => localByKey.get(key(e)) || e);
                const baseKeys = new Set(prevEvents.map(key));
                const added = localEvents.filter(e => !baseKeys.has(key(e)));
                const restore = JSON.parse(JSON.stringify([...kept, ...added]));
                if (typeof this.onSyncRefused === 'function') {
                    // The caller REPLACES its events with this list (no merge: merging
                    // against the baseline reads every dropped row as deleted-by-us and
                    // drops it again), which also puts local back in step with the gate.
                    try {
                        this.onSyncRefused({ before: prevEvents.length, removing: gone.length,
                            recovered: unnamed.length, events: JSON.parse(JSON.stringify(restore)) });
                    } catch (e) { /* never rethrow */ }
                }
                // What the user really did is still owed to the server: named deletions,
                // additions, edits, and title/options. Send the corrected list now --
                // ALWAYS, not only when events differ: a refused write also carried
                // everything else typed in its debounce window (notes, title), and that
                // must not be lost with the bad removal. The declarations were not spent
                // (nothing committed), and the corrected list removes only named rows, so
                // it should not be refused again -- and if it is, isRetry stops the loop.
                this.sync({ ...calendar, events: restore }, { isRetry: true });
                return;
            }

            // Stamped on the write that is actually sent, so a refused attempt does not
            // spend them.
            Object.assign(rest, this._takeWriteMeta());

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
                        return this._sanitizeForFirebase({ ...this._withoutMeta(safe), ...rest, events: safe.events });
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
                    // A write that changes nothing else leaves the bookkeeping as it was.
                    // Nothing happened to attribute -- and nativecal echoes every snapshot
                    // it imports back through sync(), so two open browsers would otherwise
                    // flip the id back and forth, each flip a fresh snapshot, forever.
                    const noMeta = (n) => {
                        const o = { ...n };
                        for (const k of this.META_KEYS) o[k] = null;
                        return o;
                    };
                    if (this._sameNode(noMeta(next), noMeta(current))) {
                        for (const k of this.META_KEYS) next[k] = current[k] ?? null;
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
                    // The declarations this write was computed with are settled: each
                    // deletion it named is now on the server, or the row was back in the
                    // write and the deletion is moot. Declarations made since stay.
                    for (const k of declared) this._pendingDeletes.delete(k);
                    // Without a live subscription the commit is the only news of the
                    // server's state; with one, the value event for this very state has
                    // already been merged into the local copy and moved the baseline.
                    if (!this._live.has(calendar.id)) {
                        this._rememberSnapshot({ id: calendar.id, events: snapshot.val()?.events });
                    }

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

    /**
     * `asCreator: false` is for copies (rename): the browser writing a copy did not
     * create the original, so it is recorded as an ordinary editor of the new id.
     */
    static createWithId(key, value, success, { asCreator = true } = {}) {
        const data = this._sanitizeForFirebase({ ...this._withoutMeta(value), _writer: this.writerId });
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
        // Not an undo and not part of a gesture: clear what the previous write said.
        return this.db.child(key).update(this._sanitizeForFirebase(
            { ...value, _writer: this.writerId, _undoOf: null, _gesture: null }));
    }

    static delete(key) {
        return this.db.child(key).remove();
    }
}
