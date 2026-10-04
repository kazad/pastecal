/**
 * Records which browser has been editing a calendar, so "who most likely created this"
 * has an answer if a slug is ever leaked or taken over.
 *
 * This is NOT access control. Calendars stay open read/write to anyone with the link --
 * that is the product, not an oversight. This only leaves a trail, and the trail is
 * consulted by a human running internal/scripts/authors.js, never by the app.
 *
 * Why Firebase anonymous auth rather than a random id in localStorage: a localStorage id
 * is a number the client claims about itself, so anyone could send someone else's and the
 * records would be worthless as evidence precisely when they mattered. `auth.uid` is
 * asserted by Firebase, and the security rules only let a browser write under its own uid.
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

    /** The current browser's Firebase uid, or null if sign-in has not completed/failed. */
    uid() {
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
        return this.uid(); // null if not signed in yet; the next edit will catch it
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
            if (!uid) return;

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
