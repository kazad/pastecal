/**
 * Records which browser has been editing a calendar, so "who most likely created this"
 * has an answer if a slug is ever leaked or taken over.
 *
 * This is NOT access control. Calendars stay open read/write to anyone with the link --
 * that is the product, not an oversight. This only leaves a trail, and the trail is
 * consulted by a human running internal/scripts/authors.js, never by the app.
 *
 * On the Firebase backend these records are keyed by the Firebase anonymous uid (`auth.uid`
 * is asserted by Firebase, and the security rules only let a browser write under its own uid).
 * On the Cloudflare backend the author is this browser's pastecal id (uid() below): a random
 * id kept in localStorage, adopting an existing Firebase uid once for continuity.
 * The rules also pin every timestamp to the server clock and every write to one edit --
 * see docs/author-signal.md for exactly what that does and does not prevent.
 *
 * What this can and cannot show, stated plainly because it decides how much weight the
 * output deserves:
 *   - it identifies a BROWSER, not a person: it dies on cache clear and does not follow
 *     someone to their phone
 *   - it proves CONTINUITY (same browser, editing since March, on 87 separate days),
 *     which is strong circumstantial evidence of ownership, not proof of it
 *   - it starts from deploy day, so a calendar made in 2025 has no history until its
 *     owner next visits
 */
const AuthorSignal = {
    // Written at most once per calendar per this interval, so a debounced editing session
    // costs one write rather than one per keystroke. Long enough to be cheap, short enough
    // that a session spanning hours still refreshes lastSeen.
    THROTTLE_MS: 5 * 60 * 1000,

    _lastWrite: {},   // calendarId -> timestamp of our last write
    _seeded: {},      // calendarId -> true once firstSeen has been attempted this page load

    // ---- This browser's pastecal id (owner decision, Oct 2026) ----
    // What the Cloudflare backend records as a calendar's author (the creator, editors of record) and
    // what trial, checkout, Pro locks and the 7-day undo send: a random id pastecal makes once and keeps
    // in localStorage. Not the Firebase anonymous uid: on the Cloudflare backend the uid is client-sent
    // anyway, and Firebase being blocked (an ad blocker, no third-party storage, a slow restore) must
    // never leave a creator unrecognizable. Continuity: a browser that already has a Firebase uid adopts
    // it, once, as its pastecal id, so calendars it created (recorded under that uid) stay its own.
    STORAGE_KEY: 'pastecal_browser_id',
    WAIT_MS: 2000,     // the longest the Firebase restore is waited for before a fresh id is made
    _id: null,         // the id, also when localStorage can't keep it (then it lasts this page load)
    _waiters: null,    // [resolve] while the Firebase restore is pending
    _fbState: 'unknown',   // 'unknown' -> 'pending' (listening) -> 'settled'

    _store() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } },
    _keep(id) {
        this._id = id;
        try { const ls = this._store(); if (ls) ls.setItem(this.STORAGE_KEY, id); } catch (e) { /* this page load only */ }
        const w = this._waiters; this._waiters = null;
        if (w) w.forEach((r) => r(id));
        return id;
    },
    _fresh() {
        try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* older browser */ }
        return 'pc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    },
    /** A Firebase uid this browser already has, read without waiting: a restored user, or Firebase's own
     *  localStorage record (firebase:authUser:<key>:[DEFAULT]). null if none. */
    _legacyUidNow() {
        const fb = this.firebaseUid();
        if (fb) return fb;
        try {
            const ls = this._store();
            for (let i = 0; ls && i < ls.length; i++) {
                const k = ls.key(i);
                if (k && k.indexOf('firebase:authUser:') === 0) { const u = JSON.parse(ls.getItem(k) || 'null'); if (u && typeof u.uid === 'string' && u.uid) return u.uid; }
            }
        } catch (e) { /* unreadable: none */ }
        return null;
    },
    /** Firebase is loaded here and may still be restoring a user from IndexedDB: listen once. */
    _watchFirebase() {
        if (this._fbState !== 'unknown') return this._fbState === 'pending';
        this._fbState = 'settled';
        try {
            // No Firebase app here (pastecal.com since Oct 25 2026, staging, a local Cloudflare copy): read its old
            // user straight from IndexedDB instead, which reaches nothing remote.
            if ((typeof window !== 'undefined' && window.pcNoProdSideEffects)
                || typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length || !firebase.auth) return this._watchFirebaseStore();
            const auth = firebase.auth();
            this._fbState = 'pending';
            const settle = (user) => {
                if (this._fbState !== 'pending') return;
                this._fbState = 'settled';
                if (!this._id) this._keep(user && user.uid ? user.uid : this._fresh());
            };
            const off = auth.onAuthStateChanged((user) => { settle(user); try { off && off(); } catch (e) {} });
            setTimeout(() => settle(null), this.WAIT_MS);
            return true;
        } catch (e) { this._fbState = 'settled'; return false; }
    },
    /**
     * Firebase is no longer loaded on pastecal.com (Oct 25 2026), but a browser that signed in to it before
     * keeps its user in IndexedDB (firebaseLocalStorageDb). Read it directly, once, so that browser still
     * adopts its old uid and the calendars it created stay its own. Only an existing database is opened
     * (indexedDB.databases()), so a new visitor gets nothing created. Answers within WAIT_MS, like the SDK path.
     */
    _watchFirebaseStore() {
        try {
            if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return false;
            this._fbState = 'pending';
            const settle = (uid) => {
                if (this._fbState !== 'pending') return;
                this._fbState = 'settled';
                if (!this._id) this._keep(uid || this._fresh());
            };
            setTimeout(() => settle(null), this.WAIT_MS);
            indexedDB.databases().then((dbs) => {
                if (!(dbs || []).some((d) => d && d.name === 'firebaseLocalStorageDb')) return settle(null);
                const req = indexedDB.open('firebaseLocalStorageDb');
                req.onerror = () => settle(null);
                req.onsuccess = () => {
                    try {
                        const db = req.result;
                        const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
                        all.onsuccess = () => {
                            const row = (all.result || []).find((r) => r && String(r.fbase_key || '').indexOf('firebase:authUser:') === 0);
                            settle(row && row.value && typeof row.value.uid === 'string' ? row.value.uid : null);
                            db.close();
                        };
                        all.onerror = () => { settle(null); db.close(); };
                    } catch (e) { settle(null); }
                };
            }, () => settle(null));
            return true;
        } catch (e) { this._fbState = 'settled'; return false; }
    },
    /**
     * This browser's pastecal id, or null for a moment on the first visit while an existing Firebase
     * user may still be restoring (ready() waits for it; idNow() decides at once).
     */
    uid() {
        if (this._id) return this._id;
        try { const ls = this._store(); const v = ls && ls.getItem(this.STORAGE_KEY); if (v) return (this._id = v); } catch (e) { /* none kept */ }
        const legacy = this._legacyUidNow();
        if (legacy) return this._keep(legacy);
        if (this._watchFirebase()) return null;
        return this._keep(this._fresh());
    },
    /** The id now, making one if the Firebase restore hasn't answered yet (creating a calendar can't wait). */
    uidNow() { return this.uid() || this._keep(this._fresh()); },
    /** The id, waiting up to WAIT_MS for an existing Firebase user to restore. Always resolves to an id. */
    ready() {
        const id = this.uid();
        if (id) return Promise.resolve(id);
        return new Promise((resolve) => {
            (this._waiters = this._waiters || []).push(resolve);
            const t0 = Date.now();
            const tick = () => {
                const v = this.uid();
                if (v) return resolve(v);
                if (Date.now() - t0 >= this.WAIT_MS) return resolve(this.uidNow());
                setTimeout(tick, 100);
            };
            setTimeout(tick, 100);
        });
    },

    /** The current browser's Firebase uid (the Firebase backend's calendar_authors records, which the
     *  database rules key by auth.uid), or null if sign-in has not completed/failed. */
    firebaseUid() {
        try {
            const user = firebase.auth().currentUser;
            return user ? user.uid : null;
        } catch (err) {
            return null;
        }
    },

    /** Today's key under `days/`. Informational only: the rules cannot check a key, so
     *  distinct days are counted from the server timestamp stored as its value. */
    _dayKey() {
        return new Date().toISOString().slice(0, 10);
    },

    /** The uid to record under, or null when nothing should be recorded. */
    _recordingUid(calendarId) {
        if (!calendarId) return null;
        // The e2e suite creates and edits throwaway calendars on every run. Recording
        // those would fill the ownership data with browsers that are not people --
        // and this data exists to be read by a human during an incident, so noise in
        // it is worse than a gap. Same gate analytics.js already uses.
        if (typeof window !== 'undefined' && window.__TEST__) return null;
        return this.firebaseUid(); // the rules key these records by auth.uid; null if not signed in yet
    },

    /**
     * The author record to write in the SAME multi-path update that creates a calendar,
     * keyed by path from the database root, or null if nothing should be recorded.
     *
     * Presence at creation is the strongest signal available, so it is the one most
     * worth forging. The rules only accept `createdHere` in the write that brings the
     * calendar into existence (and only if it never had history), which is why this is
     * part of that write rather than a follow-up touch.
     */
    creationRecord(calendarId) {
        try {
            const uid = this._recordingUid(calendarId);
            if (!uid) return null;
            const TS = firebase.database.ServerValue.TIMESTAMP;
            this._lastWrite[calendarId] = Date.now();
            this._seeded[calendarId] = true;
            return {
                [`calendar_authors/${calendarId}/${uid}`]: {
                    firstSeen: TS,
                    lastSeen: TS,
                    editCount: 1,
                    createdHere: true,
                    days: { [this._dayKey()]: TS },
                },
            };
        } catch (err) {
            return null;
        }
    },

    /**
     * Note that this browser edited a calendar that exists on the server.
     *
     * Never throws and never blocks: this is observational, and a calendar edit must
     * succeed whether or not the signal is recorded.
     */
    touch(calendarId) {
        try {
            const uid = this._recordingUid(calendarId);
            if (!uid || (typeof window !== 'undefined' && window.pcNoProdSideEffects)) return;   // staging/local CF: no production writes

            const now = Date.now();
            if (this._lastWrite[calendarId] &&
                now - this._lastWrite[calendarId] < this.THROTTLE_MS) {
                return;
            }
            this._lastWrite[calendarId] = now;

            const ref = firebase.database().ref(`calendar_authors/${calendarId}/${uid}`);
            const TS = firebase.database.ServerValue.TIMESTAMP;

            // Server values throughout: the rules require lastSeen and each day's stamp
            // to equal the server's `now` and editCount to move by exactly 1, so nothing
            // here can claim a past this browser did not have. Distinct DAYS is the metric
            // that separates an owner from a drive-by editor -- 400 edits in one afternoon
            // is a busy visitor, 400 across 90 days is whoever runs the calendar -- and
            // counting it from server stamps means it takes real days to earn.
            const update = {
                lastSeen: TS,
                editCount: firebase.database.ServerValue.increment(1),
                [`days/${this._dayKey()}`]: TS,
            };

            // firstSeen is set once, to the server clock, and never moves. The record is
            // unreadable from the client (a public calendar_authors would be a list of who
            // edits what), so it cannot ask whether one exists: the first touch of a page
            // load sends firstSeen too, and if the rules reject that because a record
            // already exists, the plain touch follows. Two writes at most, once per load.
            if (!this._seeded[calendarId]) {
                this._seeded[calendarId] = true;
                ref.update(Object.assign({ firstSeen: TS }, update)).catch(function () {
                    ref.update(update).catch(function () { /* observational only */ });
                });
                return;
            }

            ref.update(update).catch(function () { /* observational only */ });
        } catch (err) {
            /* observational only: never surface, never rethrow */
        }
    },
};

if (typeof window !== 'undefined') {
    window.AuthorSignal = AuthorSignal;
}
if (typeof module !== 'undefined' && module.exports) module.exports = AuthorSignal;
