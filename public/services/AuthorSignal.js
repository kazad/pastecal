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
    _seeded: {},      // calendarId -> true once firstSeen has been established

    /** The current browser's Firebase uid, or null if sign-in has not completed/failed. */
    uid() {
        try {
            const user = firebase.auth().currentUser;
            return user ? user.uid : null;
        } catch (err) {
            return null;
        }
    },

    /**
     * Note that this browser touched a calendar.
     *
     * `created` marks the one call that happens at creation time, which is the strongest
     * signal available -- whoever was present when the calendar first existed is the
     * best owner candidate by a wide margin.
     *
     * Never throws and never blocks: this is observational, and a calendar edit must
     * succeed whether or not the signal is recorded.
     */
    touch(calendarId, { created = false } = {}) {
        try {
            if (!calendarId) return;

            // The e2e suite creates and edits throwaway calendars on every run. Recording
            // those would fill the ownership data with browsers that are not people --
            // and this data exists to be read by a human during an incident, so noise in
            // it is worse than a gap. Same gate analytics.js already uses.
            if (typeof window !== 'undefined' && window.__TEST__) return;

            const uid = this.uid();
            if (!uid) return; // not signed in yet; the next edit will catch it

            const now = Date.now();
            // `created` bypasses the throttle: it happens once and must not be dropped.
            if (!created && this._lastWrite[calendarId] &&
                now - this._lastWrite[calendarId] < this.THROTTLE_MS) {
                return;
            }
            this._lastWrite[calendarId] = now;

            const ref = firebase.database().ref(`calendar_authors/${calendarId}/${uid}`);
            const day = new Date().toISOString().slice(0, 10);

            // Distinct DAYS is the metric that separates an owner from a drive-by editor:
            // 400 edits in one afternoon is a busy visitor, 400 edits across 90 days is
            // whoever runs the calendar. Stored as a set of date keys so it cannot be
            // inflated by editing rapidly.
            const update = {
                lastSeen: now,
                editCount: firebase.database.ServerValue.increment(1),
                [`days/${day}`]: true,
            };
            if (created) update.createdHere = true;

            // firstSeen must never move, or an owner's start date could be overwritten by
            // their own later visit.
            //
            // A transaction would be the obvious way to write-once, but transactions READ
            // before they write and this node is deliberately unreadable from the client
            // (a public calendar_authors would be a list of who edits what). So instead:
            // write firstSeen ONLY on the first touch of a session, and let the rules'
            // `firstSeenImmutable` validation reject it if a value already exists. The
            // rejection is expected and harmless -- the rest of the update still lands.
            if (!this._seeded[calendarId]) {
                this._seeded[calendarId] = true;
                ref.child('firstSeen').set(now).catch(function () {
                    /* already set by an earlier session: exactly what we want */
                });
            }

            ref.update(update);
        } catch (err) {
            /* observational only: never surface, never rethrow */
        }
    },
};

if (typeof window !== 'undefined') {
    window.AuthorSignal = AuthorSignal;
}
