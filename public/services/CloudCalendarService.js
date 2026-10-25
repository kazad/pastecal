/**
 * CloudCalendarService -- CalendarDataService, but the calendar lives in a Cloudflare
 * Durable Object (cloudflare/src/CalendarRoom.js) and the tab talks to it over a WebSocket.
 *
 * It EXTENDS CalendarDataService so the write budget, intent gate, journal and merge helpers
 * the apps already use are the same code, and exposes the same static interface
 * (findAndSubscribe, subscribe_readonly, debounce_sync/sync, flush, checkExists,
 * createWithId, declareIntent, onSyncPaused/onSyncRefused/...). The apps are unchanged: at
 * the bottom of this file the ONE switch -- `CalendarDataService = CloudCalendarService` --
 * runs when the flag is on, so every `CalendarDataService.x` in the apps lands here.
 *
 * Flag: `?backend=cf` (remembered in localStorage), or one of our Cloudflare hosts: pastecal.com,
 *       www, new.pastecal.com, and the staging copy preview.pastecal.com (which must never fall back to Firebase).
 *       A local copy (localhost, *.test) is on by default; `?backend=firebase` (remembered) is the deliberate way
 *       to reach Firebase from a local copy, and turns it off. Off = this file does nothing at all.
 *
 * How a save works. The app hands us its whole calendar (as it does for Firebase); we diff
 * it against the last server copy with EventStore.changesBetween and send only the
 * commands. An empty diff sends nothing, so an idle tab writes nothing. One save is in
 * flight at a time. The server acks with its new version:
 *   ack.v == the version we sent + 1   nobody else saved in between: apply our commands to
 *                                      our copy of the server state, done.
 *   anything else, or an error         somebody else's save landed first (or the server
 *                                      refused ours): ask for the snapshot ({t:'hello'}) and
 *                                      let the app show the server's data.
 * Pushed `change`/`meta` messages update our copy and reach the app through the same
 * callback findAndSubscribe always used, so the app's echo guards keep working.
 *
 * Offline. Every debounced write is journaled first (CalendarDataService._journalWrite). On
 * each (re)connect the journal entry is REBUILT against the fresh snapshot (see `rebuild`):
 * only this tab's own changes, minus whatever the server already has, minus anything
 * someone else changed since -- so a replay can neither double-apply nor undo other people.
 *
 * Pro lock. Snapshots carry {locked, pro, canEdit}. On a locked calendar a tab without rights
 * is read-only: _push sends nothing (the server would refuse it, and a refused save is asked for
 * again on every snapshot). A tab holding an editor key (EditorKeys, from a #k= link) sends
 * {t:'auth', key} as soon as the socket opens; the first snapshot is held back until the answer
 * (or AUTH_WAIT_MS), so an editor never flashes the read-only view. Every change of access is
 * reported to the app through onLockState({id, locked, pro, paused, canEdit, reason}).
 * paused: Pro ended and the owner left the calendar read-only (not locked, and nobody edits):
 * blocked exactly like a locked calendar without rights.
 *
 * Pure decisions (planSave, rebuild, ackOutcome, metaDiff) are static and unit-tested in
 * test/unit/cloud-calendar-service.test.js; the socket code is exercised against
 * `wrangler dev` by cloudflare/test/cloud-service.test.mjs.
 *
 * Known gaps (docs/cloudflare-migration.md, Phase 3):
 *   - TODO(phase 3): case-insensitive name lookup. Names resolve by EXACT id here; the
 *     directory (lowercase -> real name) does not exist yet.
 *   - No history, author signal or auto read-only link in this mode.
 */
class CloudCalendarService extends CalendarDataService {
    // ---- the flag ---------------------------------------------------------------------------
    static enabled(loc = (typeof location !== 'undefined' ? location : null), store = CloudCalendarService._store()) {
        // On the live site it is always on: ?backend=firebase would open Firebase's stale, world-writable
        // copy, a way around a Pro lock. The query flag works only elsewhere (localhost, dev).
        if (loc && CloudCalendarService.HOSTS.includes(loc.hostname)) return true;
        let q = null;
        try { q = loc && new URLSearchParams(loc.search).get('backend'); } catch (e) { /* no query */ }
        if (q === 'firebase') { try { store && store.setItem('pastecal_backend', 'firebase'); } catch (e) { /* ignore */ } return false; }
        if (q === 'cf') { try { store && store.setItem('pastecal_backend', 'cf'); } catch (e) { /* ignore */ } return true; }
        let saved = null;
        try { saved = store ? store.getItem('pastecal_backend') : null; } catch (e) { /* storage blocked */ }
        // A local copy (localhost, *.test) runs on its own Cloudflare backend unless someone deliberately asked for
        // Firebase: Firebase there is PRODUCTION data, and a test or a stray click must never write it.
        if (loc && CloudCalendarService.isLocalHost(loc.hostname)) return saved !== 'firebase';
        return saved === 'cf';
    }
    static isLocalHost(h) { return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(h || '') || /\.(localhost|test)$/.test(h || ''); }
    // Our Cloudflare deployments. preview.pastecal.com is staging: Firebase there would be PRODUCTION data.
    static HOSTS = ['pastecal.com', 'www.pastecal.com', 'new.pastecal.com', 'preview.pastecal.com'];
    static _store() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }

    // Where the Worker is. Same origin as the page unless a test points it elsewhere.
    static baseUrl = null;
    static _base() { return this.baseUrl || (typeof location !== 'undefined' ? location.origin : 'http://localhost:8787'); }
    static _url(id, suffix = '') { return `${this._base()}/cal/${encodeURIComponent(id)}${suffix}`; }
    // Where this page was opened from, as a category the calendar's stats count: an embed, a search
    // engine, or another site. Only the category leaves the browser, never the other site's address.
    // '' means direct (typed, bookmarked, pastecal itself, or an app that strips the referrer).
    static _source() {
        try {
            if (typeof window !== 'undefined' && window.self !== window.top) return 'embed';
            const ref = typeof document !== 'undefined' && document.referrer;
            if (!ref) return '';
            const h = new URL(ref).hostname.toLowerCase();
            if (h === location.hostname || /(^|\.)pastecal\.com$/.test(h)) return '';
            if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|search\.brave|startpage|qwant)\./.test(h)) return 'search';
            return 'site';
        } catch (e) { return ''; }
    }
    static _wsUrl(id) {
        const q = new URLSearchParams();
        try {
            if (typeof AuthorSignal !== 'undefined' && typeof AuthorSignal.uid === 'function') {
                const uid = AuthorSignal.uid();
                if (uid) q.set('author', uid);
            }
        } catch (e) {}
        const src = this._source();
        if (src) q.set('src', src);
        const qs = q.toString();
        return this._url(id, '/ws' + (qs ? '?' + qs : '')).replace(/^http/, 'ws');
    }

    static RECONNECT = { baseMs: 500, maxMs: 30000 };
    static AUTH_WAIT_MS = 2500;
    static READONLY_POLL_MS = 15000;
    static _rooms = {};

    // ---- pure decisions ---------------------------------------------------------------------

    /** The commands a save should send: local events vs the last server copy. [] = send nothing. */
    static planSave(serverEvents, localEvents) {
        // A new event must carry the id the tab chose (the server refuses one without).
        const usable = (localEvents || []).filter((e) => e && !(e.id === undefined || e.id === null || e.id === ''));
        return EventStore.changesBetween(serverEvents || [], usable);
    }

    /** Title/options that differ from the server's. Options are sent as changed keys (the server merges by key). */
    static metaDiff(server, local) {
        const out = {};
        if (typeof local.title === 'string' && local.title !== (server.title ?? '')) out.title = local.title;
        if (local.options && typeof local.options === 'object') {
            const changed = {};
            for (const [k, v] of Object.entries(local.options)) {
                if (JSON.stringify(v ?? null) !== JSON.stringify((server.options || {})[k] ?? null)) changed[k] = v ?? null;
            }
            if (Object.keys(changed).length) out.options = changed;
        }
        return out;
    }

    /** What an ack means. `sentV` is the version the save carried. */
    static ackOutcome(sentV, ack) {
        if (ack.unchanged) return 'unchanged';
        return ack.v === sentV + 1 ? 'ok' : 'conflict';
    }

    /**
     * This tab's unsent changes (base -> local), rebuilt against what the server holds NOW
     * (fresh): drop what the server already has (a write whose ack we lost), drop changes to
     * rows someone else changed or deleted since base (theirs is newer, as in _mergeEvents'
     * yieldOnConflict). What is left can be applied to `fresh` without double-applying.
     */
    static rebuild(base, local, fresh) {
        const key = EventStore.keyOf;
        const freshM = new Map((fresh || []).map((e) => [key(e), e]));
        const baseM = new Map((base || []).map((e) => [key(e), e]));
        const untouchedByOthers = (k) => {
            const b = baseM.get(k), f = freshM.get(k);
            return !!b && !!f && Object.keys(EventStore.diff(b, EventStore.normalize(f))).length === 0;
        };
        const out = [];
        for (const c of EventStore.changesBetween(base || [], (local || []).filter((e) => e && e.id != null && e.id !== ''))) {
            if (c.type === 'add') { if (!freshM.has(key(c.event))) out.push(c); continue; }
            if (!freshM.has(c.key)) continue;                         // gone already (ours applied, or theirs)
            if (!untouchedByOthers(c.key)) continue;                  // someone changed it since: theirs stands
            if (c.type === 'update') {
                if (Object.keys(EventStore.diff(freshM.get(c.key), EventStore.normalize(c.changes))).length) out.push(c);
            } else out.push(c);
        }
        return out;
    }

    static errorKind(code) {
        if (code === 'rate_limited') return 'paused';
        return 'refused';                                             // too_big, bad_command, bad_json, unknown
    }

    // ---- live subscription ------------------------------------------------------------------

    // Open a calendar. Resolves case differences and read-only views via directory.
    static findAndSubscribe(slug, callback) {
        if (!slug) { console.warn('findAndSubscribe called with empty slug'); callback(null); return; }
        this.subscribe(slug, callback);
        (async () => {
            try {
                const lookup = await this.lookupCalendar(slug);
                // A Pro short name whose account was deleted: a neutral "This link has ended" page (the Worker's).
                if (lookup.data?.ended && typeof window !== 'undefined' && window.location) {
                    this.close(slug);
                    window.location.replace('/link-ended/' + encodeURIComponent(slug));
                    return;
                }
                if (lookup.data?.found) {
                    if (lookup.data.isReadOnly) {
                        if (typeof window !== 'undefined' && window.location) {
                            window.location.href = `/view/${lookup.data.actualSlug}`;
                            return;
                        }
                    }
                    if (lookup.data.actualSlug && lookup.data.actualSlug !== slug) {
                        this.close(slug);
                        this.subscribe(lookup.data.actualSlug, callback);
                    }
                }
            } catch (e) {
                console.warn('[CloudCalendarService] lookup in findAndSubscribe failed', e);
            }
        })();
    }
    static _subscribeExact(slug, callback) { this.subscribe(slug, callback); }

    static subscribe(slug, callback) {
        if (!slug) return;
        const room = this._rooms[slug] = {
            id: slug, callback, ws: null, v: 0, server: null, inflight: null, latest: null, seq: 0,
            retries: 0, timer: null, closed: false, unsent: false, force: null, sawSnapshot: false,
            lock: { locked: false, pro: false, canEdit: true }, authPending: false, authTimer: null, heldSnapshot: null,
        };
        this._open(room);
    }

    static _open(room) {
        if (room.closed) return;
        let ws;
        try { ws = new WebSocket(this._wsUrl(room.id)); } catch (e) { this._scheduleReconnect(room); return; }
        room.ws = ws;
        // An editor key goes first, before the app sees the snapshot (which says canEdit:false until it lands).
        ws.onopen = () => {
            if (room.ws !== ws) return;
            const key = this._editorKey(room.id);
            if (!key) return;
            room.authPending = true;
            clearTimeout(room.authTimer);
            room.authTimer = setTimeout(() => { if (room.ws === ws) this._releaseAuth(room); }, this.AUTH_WAIT_MS);
            this._send(room, { t: 'auth', key });
        };
        ws.onmessage = (ev) => { if (room.ws === ws) { try { this._onMessage(room, JSON.parse(ev.data)); } catch (e) { console.error('[CloudCalendarService]', e); } } };
        ws.onclose = () => { if (room.ws === ws) this._onClose(room); };
        ws.onerror = () => { /* onclose follows */ };
    }

    static _onClose(room) {
        room.ws = null;
        room.authPending = false; clearTimeout(room.authTimer); room.heldSnapshot = null;
        if (room.inflight) { room.inflight = null; room.unsent = true; }   // may or may not have landed; rebuild decides
        this._scheduleReconnect(room);
    }

    static _scheduleReconnect(room) {
        if (room.closed || room.timer) return;
        const { baseMs, maxMs } = this.RECONNECT;
        const delay = Math.min(maxMs, baseMs * 2 ** room.retries++) * (0.75 + Math.random() * 0.5);
        room.timer = setTimeout(() => { room.timer = null; this._open(room); }, delay);
    }

    /** Stop a subscription (tests, and a page that switches calendars). */
    static close(id) {
        const room = this._rooms[id]; if (!room) return;
        room.closed = true; clearTimeout(room.timer); clearTimeout(room.authTimer);
        try { room.ws && room.ws.close(); } catch (e) { /* gone */ }
        if (this.connected === id) this.connected = false;
        delete this._rooms[id];
    }

    static _send(room, msg) {
        if (!room.ws || room.ws.readyState !== 1) return false;
        room.ws.send(JSON.stringify(msg));
        return true;
    }

    static _onMessage(room, m) {
        switch (m.t) {
            case 'snapshot': return this._onSnapshot(room, m);
            case 'change': {
                if (!room.server || m.v !== room.v + 1) return this._send(room, { t: 'hello' });   // missed one: start over
                try { room.server.events = EventStore.apply(room.server.events, { type: 'batch', commands: m.commands }).events; }
                catch (e) { return this._send(room, { t: 'hello' }); }
                room.v = m.v; room.server.lastEditedAt = Date.now();
                return this._deliver(room);
            }
            case 'meta': {
                if (!room.server) return;
                room.server.title = m.title; room.server.options = m.options;
                room.v = m.v; room.server.lastEditedAt = Date.now();
                return this._deliver(room);
            }
            case 'ack': return this._onAck(room, m);
            case 'error': return this._onError(room, m);
            case 'auth': return this._onAuth(room, m);
            case 'pro': {                                // the owner changed the display settings
                room.lock = { ...room.lock, proSettings: m.settings || null };
                return this._notifyLock(room);
            }
        }
    }

    // ---- Pro lock ---------------------------------------------------------------------------

    static _editorKey(id) {
        try { return typeof EditorKeys !== 'undefined' ? EditorKeys.get(id) : null; } catch (e) { return null; }
    }
    static _forgetEditorKey(id) {
        try { if (typeof EditorKeys !== 'undefined') EditorKeys.forget(id); } catch (e) { /* storage blocked */ }
    }
    /** A locked calendar this tab may not change. */
    static _blocked(room) { return !!(room.lock && (room.lock.locked || room.lock.paused) && !room.lock.canEdit); }
    /** Access for the calendar this tab has open (the app's lock icon and read-only state). */
    static lockState(id) { const r = this._rooms[id]; return r ? { ...r.lock } : null; }

    static _notifyLock(room, reason) {
        if (typeof this.onLockState !== 'function') return;
        try { this.onLockState({ id: room.id, ...room.lock, ...(reason ? { reason } : {}) }); } catch (e) { /* never rethrow */ }
    }

    // The auth answer did not come in time: show what the snapshot said; a late answer still applies.
    static _releaseAuth(room) {
        room.authPending = false; clearTimeout(room.authTimer);
        const held = room.heldSnapshot; room.heldSnapshot = null;
        if (held) this._onSnapshot(room, held);
    }

    static _onAuth(room, m) {
        room.authPending = false; clearTimeout(room.authTimer);
        let reason = null;
        if (m.ok) {
            room.lock = { ...room.lock, locked: !!m.locked, canEdit: m.canEdit !== false };
        } else if (m.locked) {
            // Forget the key only when the server says the owner revoked or replaced it: it will not
            // start working again. Any other refusal keeps it (it costs nothing to send again).
            if (m.reason === 'key-rotated' || m.reason === 'link-revoked') {
                this._forgetEditorKey(room.id);
                if (!m.canEdit) reason = 'key-rotated';
            }
            room.lock = { ...room.lock, locked: true, canEdit: !!m.canEdit };
        }
        // (ok:false on a calendar that is not locked: keep the key. An unlock pauses editor links, and a
        // re-lock by the same owner turns them back on.)
        const held = room.heldSnapshot; room.heldSnapshot = null;
        if (held) return this._onSnapshot(room, { ...held, canEdit: room.lock.canEdit }, reason);
        this._notifyLock(room, reason);
        if (!this._blocked(room) && (room.unsent || room.latest)) { room.unsent = false; this._push(room); }
    }

    static _calendar(room) {
        const s = room.server;
        return { id: room.id, title: s.title, options: JSON.parse(JSON.stringify(s.options || {})), lastEditedAt: s.lastEditedAt ?? null, events: JSON.parse(JSON.stringify(s.events)) };
    }

    // Hand the server's current copy to the app, through the same path Firebase's 'value' event used.
    static _deliver(room, forced = false) {
        const cal = this._calendar(room);
        this.connected = room.id;
        this._rememberSnapshot(cal);
        // After a conflict the app's merge must not keep its losing copy: pretend the app's
        // view was the baseline, so only edits it made AFTER that save survive the merge.
        if (forced && room.force) this._previousSeen[room.id] = room.force;
        if (forced) room.force = null;
        room.callback(cal);
    }

    static _onSnapshot(room, m, reason = null) {
        room.retries = 0;
        if (m.calendar && m.calendar.id && room.authPending && m.locked && !m.canEdit) {
            room.heldSnapshot = m;                       // wait for the editor key's answer (or AUTH_WAIT_MS)
            return;
        }
        if (m.calendar && m.calendar.id) {
            room.lock = { locked: !!m.locked, pro: !!m.pro, paused: !!m.paused, canEdit: m.canEdit !== false, proSettings: m.proSettings || null };
        }
        if (!m.calendar || !m.calendar.id) {            // no such calendar: the app treats it as a new one
            room.closed = true;
            try { room.ws.close(); } catch (e) { /* gone */ }
            delete this._rooms[room.id];
            room.callback(null);
            return;
        }
        room.v = m.v;
        room.server = { title: m.calendar.title ?? '', options: m.calendar.options || {}, lastEditedAt: m.calendar.lastEditedAt ?? null, events: m.calendar.events || [] };
        room.inflight = null;
        // Replay what never reached the server, rebuilt against this snapshot, before the app sees it,
        // so the app's first view already includes the replay's result.
        const entry = this._journalRead(room.id);
        const stale = entry && entry.calendar && (Date.now() - entry.t > this.JOURNAL_MAX_AGE_MS);
        if (stale) this._journalClear(room.id, entry.t);
        const commands = entry && entry.calendar && !stale
            ? this.rebuild(entry.base || [], this._sanitizeForFirebase(entry.calendar.events || []), room.server.events) : [];
        if (entry && !stale && !commands.length) this._journalClear(room.id, entry.t);
        if (commands.length && !this._replayed[room.id + ':' + entry.t]) {
            this._replayed[room.id + ':' + entry.t] = true;
            if (typeof this.onJournalReplay === 'function') { try { this.onJournalReplay({ ageMs: Date.now() - entry.t }); } catch (e) { /* never rethrow */ } }
        }
        this._notifyLock(room, reason);
        this._deliver(room, true);
        if (this._blocked(room)) return;               // read-only here: the journal waits (an editor key may still land)
        if (commands.length) this._sendSave(room, commands, { journalT: entry.t, replay: true, localEvents: null });
        else if (room.unsent || room.latest) { room.unsent = false; this._push(room); }
    }

    // ---- saving -----------------------------------------------------------------------------

    static sync(calendar, opts = {}) {
        if (!calendar || !calendar.id || !this.connected) return;
        const room = this._rooms[calendar.id];
        if (!room || !room.server) return;
        room.latest = calendar;
        this._push(room, opts);
    }

    static _push(room, opts = {}) {
        if (room.inflight || !room.latest || !room.server || this._paused) return;
        if (this._blocked(room)) return;                 // locked and no rights: the server would refuse it
        const safe = this._dropIncompleteEvents(room.latest);
        const local = this._sanitizeForFirebase(safe.events || []);
        const commands = this.planSave(room.server.events, local);
        const meta = this.metaDiff(room.server, this._sanitizeForFirebase({ title: safe.title, options: safe.options }));
        if (!commands.length && !Object.keys(meta).length) { this._journalClear(room.id, opts.journalT); return; }   // idle: nothing to say
        if (this._overWriteBudget()) return;

        // The same gate as the Firebase path: a removal nobody declared is a bug in a save path.
        const before = room.server.events.length, removing = commands.filter((c) => c.type === 'remove').length;
        const intent = removing > 0 ? this._takeIntent() : null;
        if (typeof this.onSyncShape === 'function') { try { this.onSyncShape({ before, after: local.length, intent: !!intent }); } catch (e) { /* never rethrow */ } }
        if (removing > 0 && (!intent || removing > intent.removing)) {
            console.error(`[CloudCalendarService] refused to save: this write removes ${removing} of ${before} events` + (intent ? ` but only ${intent.removing} were deleted by the user` : ' and no deletion was made'));
            this._journalClear(room.id, opts.journalT);
            if (typeof this.onSyncRefused === 'function') {
                const localKeys = new Set(local.map((e) => EventStore.keyOf(e)));
                const gone = intent ? new Set(room.server.events.filter((e) => !localKeys.has(EventStore.keyOf(e))).slice(0, intent.removing).map((e) => EventStore.keyOf(e))) : new Set();
                const events = room.server.events.filter((e) => !gone.has(EventStore.keyOf(e)));
                try { this.onSyncRefused({ before, removing, events: JSON.parse(JSON.stringify(events)) }); } catch (e) { /* never rethrow */ }
            }
            return;
        }
        if (commands.length) this._sendSave(room, commands, { journalT: opts.journalT, localEvents: local });
        else this._sendMeta(room, meta, opts);
    }

    /** This browser's IANA time zone, which the server stores as the calendar's (options.tz) while it has
     *  none, so link previews show the right clock times. null if the browser can't say. */
    static _browserTz() {
        try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; return typeof tz === 'string' && tz ? tz : null; } catch (e) { return null; }
    }

    static _authorUid() {
        try {
            if (typeof AuthorSignal !== 'undefined' && typeof AuthorSignal.uid === 'function') {
                return AuthorSignal.uid();
            }
        } catch (e) {}
        return null;
    }

    static _sendSave(room, commands, { journalT, replay = false, localEvents } = {}) {
        if (replay && this._overWriteBudget()) return;
        const id = `s${++room.seq}`;
        const author = this._authorUid();
        const writer = this.writerId || null;   // never the author id: history is public, the id proves who made it
        room.inflight = { id, kind: 'save', v: room.v, commands, journalT, replay, localEvents };
        const tz = this._browserTz();
        if (!this._send(room, { t: 'save', id, v: room.v, commands, author, writer, ...(tz ? { tz } : {}) })) { room.inflight = null; room.unsent = true; }
    }

    static _sendMeta(room, meta, opts = {}) {
        const id = `m${++room.seq}`;
        const author = this._authorUid();
        const writer = this.writerId || null;   // never the author id: history is public, the id proves who made it
        room.inflight = { id, kind: 'meta', v: room.v, meta, journalT: opts.journalT };
        if (!this._send(room, { t: 'meta', id, ...meta, author, writer })) { room.inflight = null; room.unsent = true; }
    }

    static _onAck(room, m) {
        const f = room.inflight;
        if (!f || f.id !== m.id) return;
        room.inflight = null;
        const outcome = this.ackOutcome(f.v, m);
        if (outcome === 'conflict' || room.v !== f.v && outcome === 'ok') {
            // Someone else's save landed first. The server applied ours on top of theirs; its state is the truth.
            room.force = f.localEvents || null;
            this._journalClear(room.id, f.journalT);
            this._send(room, { t: 'hello' });
            return;
        }
        if (outcome === 'ok') {
            if (f.kind === 'save') room.server.events = EventStore.apply(room.server.events, { type: 'batch', commands: f.commands }).events;
            else { room.server.title = f.meta.title ?? room.server.title; room.server.options = { ...room.server.options, ...(f.meta.options || {}) }; }
            room.v = m.v; room.server.lastEditedAt = Date.now();
            // (A replay's result is remembered by _deliver below, so the app's merge baseline is the PRE-replay copy.)
            if (!f.replay) this._rememberSnapshot(this._calendar(room));
        }
        this._journalClear(room.id, f.journalT);
        if (f.replay) this._deliver(room);   // the app is showing the pre-replay copy; give it the result
        this._push(room);                    // anything edited while this was in flight
    }

    static _onError(room, m) {
        const f = room.inflight && (!m.id || room.inflight.id === m.id) ? room.inflight : null;
        room.inflight = null;
        const message = m.message || m.code;
        console.error(`[CloudCalendarService] server refused: ${m.code} ${message || ''}`);
        if (this.errorKind(m.code) === 'paused') {
            // The server's own rate limit: stop saving until reload. Nothing is lost: the journal has it.
            this._paused = true;
            if (typeof this.onSyncPaused === 'function') { try { this.onSyncPaused({ writes: this._writeTimes.length, code: m.code, message }); } catch (e) { /* never rethrow */ } }
            return;
        }
        // Refused for what it says: replaying it would be refused again, so drop it, and show the server's data.
        if (f) { this._journalClear(room.id, f.journalT); room.force = f.localEvents || null; }
        if (m.code === 'locked' || m.code === 'paused') {
            // Locked (or paused after Pro) under us, or the key stopped working: read-only from here,
            // and drop the refused edit so the next snapshot does not send it again.
            room.latest = null; room.unsent = false;
            room.lock = m.code === 'paused' ? { ...room.lock, locked: false, paused: true, canEdit: false } : { ...room.lock, locked: true, canEdit: false };
            this._notifyLock(room);
        }
        if (typeof this.onSyncRefused === 'function') {
            const events = room.server ? JSON.parse(JSON.stringify(room.server.events)) : null;
            try { this.onSyncRefused({ before: events ? events.length : 0, removing: 0, events, code: m.code, message }); } catch (e) { /* never rethrow */ }
        }
        this._send(room, { t: 'hello' });
    }

    // _replayJournal is part of the Firebase path; here the journal is replayed on every snapshot (above).
    static _replayJournal() { /* see _onSnapshot */ }

    // The debounce, re-declared here: the inherited one names CalendarDataService inside ITS class
    // body, which stays the Firebase class even after the switch at the bottom of this file.
    static debounce_sync = (() => {
        const debounced = Utils.debounce((cal) => {
            if (CloudCalendarService._pending !== cal) return;   // already flushed
            CloudCalendarService._pending = null;
            CloudCalendarService.sync(cal, { journalT: CloudCalendarService._pendingT });
        }, 500);
        return (cal) => {
            CloudCalendarService._pending = cal;
            CloudCalendarService._pendingT = CloudCalendarService._journalWrite(cal);   // journal first, as ever
            debounced(cal);
        };
    })();
    // flush() is inherited (it uses `this`): it calls sync() with the pending calendar; the socket is open, so it goes now.

    // ---- creating and checking --------------------------------------------------------------

    /** Is this name taken? First check directory, then HEAD /cal/<id>: 404 = free. */
    static async checkExists(id, callback_yes, callback_no) {
        if (['beta', 'nativecal', 'view', 'dev', 'api', 'cal', 'report', 'signin', 'pro', 'pricing', 'explore', 'privacy', 'terms', 'contact', 'account'].includes(String(id || '').toLowerCase()) || String(id || '').startsWith('@')) { callback_yes(); return; }
        try {
            const lookup = await this.lookupCalendar(id);
            if (lookup.data?.found) { callback_yes(); return; }
        } catch (e) {}
        fetch(this._url(id), { method: 'HEAD' }).then((r) => (r.status === 404 ? callback_no() : callback_yes()), (err) => {
            // Unreachable is not "free": claiming on a failed check could overwrite nothing (the server
            // refuses a non-empty room) but would tell the user a lie. Say taken-or-unknown as taken.
            console.warn('[CloudCalendarService] existence check failed', err);
            callback_yes();
        });
    }

    /** First save of a new calendar: POST /cal/<id>, accepted only into an empty room. */
    static createWithId(key, value, success) {
        const body = this._sanitizeForFirebase({ title: value.title, options: value.options, events: value.events });
        // The calendar's time zone, from the browser that makes it (never replacing one it already has).
        const tz = this._browserTz();
        if (tz && body.options && typeof body.options === 'object' && !body.options.tz) body.options = { ...body.options, tz };
        else if (tz && !body.options) body.options = { tz };
        // The creating browser's pastecal id: recorded as the creator, which is who may upgrade it (never shown).
        // Decided now (never null): a creation can't wait for a Firebase restore.
        let author = null;
        try { author = typeof AuthorSignal !== 'undefined' && AuthorSignal.uidNow ? AuthorSignal.uidNow() : this._authorUid(); } catch (e) { author = this._authorUid(); }
        if (author) body.author = author;
        return fetch(this._url(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(async (r) => {
                const out = await r.json().catch(() => ({}));
                if (!r.ok || !out.ok) { console.log('error creating calendar', r.status, out, key); return; }
                success();
            }, (err) => console.log('error creating calendar', err, key));
    }

    // ---- read-only views --------------------------------------------------------------------

    /**
     * A view link, live: a read-only WebSocket to /cal/view/<slug>/ws (the Worker finds the room through
     * the directory, so this tab never learns the edit name) streams the view copy -- snapshot, then each
     * change -- and the callback runs once per new version. Saves are never sent on it (the room refuses
     * them anyway). If the socket is down, GET /cal/view/<slug> is polled every READONLY_POLL_MS until it
     * is back; coming back to the tab fetches at once (a phone's socket can look open and be dead).
     * Idle sockets cost nothing: the room hibernates, and this sends nothing on its own.
     */
    static subscribe_readonly(slug, callback) {
        if (!slug) return;
        const enc = encodeURIComponent(slug), src = this._source(), qs = src ? '?src=' + src : '';
        const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
        let v = -1, cal = null, access = null, stopped = false, viewLink = true;
        let ws = null, live = false, retries = 0, wsTimer = null, connectTimer = null, pollTimer = null;
        const accessOf = (m) => ({ locked: !!m.locked, pro: !!m.pro, proSettings: m.proSettings || null });
        const deliver = () => { if (!stopped) callback(JSON.parse(JSON.stringify(cal)), { ...access }); };
        const fetchNow = async () => {
            try {
                let r = await fetch(`${this._base()}/cal/view/${enc}${qs}`);
                if (r.status === 404) { viewLink = false; r = await fetch(this._url(slug)); }
                if (!r.ok || stopped) return;
                const out = await r.json();
                // Never older than what the socket already gave us (versions only go up).
                if (out.calendar && out.calendar.id && out.v > v) { v = out.v; cal = out.calendar; access = accessOf(out); deliver(); }
            } catch (e) { /* offline: try again next time */ }
        };
        const tick = async () => {
            pollTimer = null;
            if (stopped) return;
            if (!live && !hidden()) await fetchNow();
            if (!stopped) pollTimer = setTimeout(tick, this.READONLY_POLL_MS);
        };
        const reconnect = () => {
            if (stopped || wsTimer || !viewLink) return;
            const { baseMs, maxMs } = this.RECONNECT;
            const delay = Math.min(maxMs, baseMs * 2 ** retries++) * (0.75 + Math.random() * 0.5);
            wsTimer = setTimeout(() => { wsTimer = null; open(); }, delay);
        };
        const hello = (sock) => { try { sock.send(JSON.stringify({ t: 'hello' })); } catch (e) { /* closing */ } };
        const onFrame = (sock, m) => {
            if (m.t === 'snapshot') {
                if (!m.calendar || !m.calendar.id) return;
                retries = 0; live = true;
                v = m.v; cal = m.calendar; access = accessOf(m);
                return deliver();
            }
            if (!cal) return;
            if ((m.t === 'change' || m.t === 'meta') && m.v !== v + 1) return hello(sock);   // missed one: start over
            if (m.t === 'change') {
                try { cal = { ...cal, events: EventStore.apply(cal.events || [], { type: 'batch', commands: m.commands }).events, lastEditedAt: Date.now() }; }
                catch (e) { return hello(sock); }
            } else if (m.t === 'meta') {
                cal = { ...cal, title: m.title, options: m.options || {}, lastEditedAt: Date.now() };
            } else if (m.t === 'pro') {
                access = { ...access, proSettings: m.settings || null };
                return deliver();
            } else return;                                 // errors and anything newer: nothing to show
            v = m.v;
            deliver();
        };
        const open = () => {
            if (stopped || ws || !viewLink || hidden()) return;        // a hidden tab connects when it comes back
            let sock;
            try { sock = new WebSocket(`${this._base()}/cal/view/${enc}/ws${qs}`.replace(/^http/, 'ws')); } catch (e) { return reconnect(); }
            ws = sock;
            // Some networks hang the handshake without closing it: give up on it and poll meanwhile.
            connectTimer = setTimeout(() => { if (ws === sock && sock.readyState === 0) { try { sock.close(); } catch (e) { /* gone */ } } }, 5000);
            sock.onopen = () => clearTimeout(connectTimer);
            sock.onmessage = (ev) => { if (ws !== sock) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onFrame(sock, m); };
            sock.onclose = () => { if (ws !== sock) return; clearTimeout(connectTimer); ws = null; live = false; reconnect(); };
            sock.onerror = () => { /* onclose follows */ };
        };
        const onVisibility = () => {
            if (stopped || hidden()) return;
            fetchNow();
            if (!ws) { clearTimeout(wsTimer); wsTimer = null; retries = 0; open(); }
        };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        tick();
        open();
        return () => {
            stopped = true;
            clearTimeout(pollTimer); clearTimeout(wsTimer); clearTimeout(connectTimer);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
            const sock = ws; ws = null;
            try { sock && sock.close(); } catch (e) { /* gone */ }
        };
    }

    // ---- directory & history APIs -----------------------------------------------------------

    static async lookupCalendar(slug) {
        if (!slug) return { data: { found: false } };
        try {
            const res = await fetch(`${this._base()}/api/lookup?slug=${encodeURIComponent(slug)}`);
            if (!res.ok) return { data: { found: false } };
            const data = await res.json();
            return { data };
        } catch (e) {
            console.warn('[CloudCalendarService] lookupCalendar failed', e);
            return { data: { found: false } };
        }
    }

    static async createPublicLink(params) {
        // A locked calendar's view link needs the owner (session cookie, sent automatically) or an editor key.
        const body = { ...params };
        const room = this._rooms[params && params.sourceCalendarId];
        const key = params && this._editorKey(params.sourceCalendarId);
        if (key && (!room || room.lock.locked)) body.editorKey = key;
        const res = await fetch(`${this._base()}/api/create-view`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) {
            const err = new Error(out.message || 'Failed to create read-only link');
            err.code = out.error || 'internal';
            throw err;
        }
        return { data: { publicViewId: out.publicViewId } };
    }

    static async loadUndoEntries(calendarId) {
        if (!calendarId) return [];
        try {
            const res = await fetch(this._url(calendarId, '/history'));
            if (!res.ok) return [];
            return await res.json();
        } catch (e) {
            console.warn('[CloudCalendarService] loadUndoEntries failed', e);
            return [];
        }
    }
}

// The ONE place the backend is chosen: from here on, every `CalendarDataService` in the apps
// is this class. With the flag off nothing changes.
if (CloudCalendarService.enabled()) CalendarDataService = CloudCalendarService;
