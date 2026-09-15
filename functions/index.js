const functions = require('firebase-functions');
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onValueUpdated, onValueWritten } = require("firebase-functions/v2/database");
const admin = require('firebase-admin');
const crypto = require('crypto');

const isLocal = process.env.FUNCTIONS_EMULATOR === 'true';
// Set by `firebase emulators:start --only database` and by our own test harness
// (test/unit/lookup-calendar.emulator.test.js) — when present, the Admin SDK routes
// all admin.database() calls at this host instead of databaseURL below, so tests never
// touch production data even though databaseURL still points at the real project.
const usingDatabaseEmulator = !!process.env.FIREBASE_DATABASE_EMULATOR_HOST;
//console.log('Environment:', process.env);
console.log('Running in', isLocal ? 'local' : 'production', 'environment',
    usingDatabaseEmulator ? `(database emulator: ${process.env.FIREBASE_DATABASE_EMULATOR_HOST})` : '');

if (usingDatabaseEmulator) {
    // Emulator ignores credentials entirely; a real service account isn't needed and
    // shouldn't be required to run tests (e.g. in CI where internal/keys/ doesn't exist).
    admin.initializeApp({ databaseURL: "https://pastecal-web-default-rtdb.firebaseio.com" });
} else if (isLocal) {
    var serviceAccount = require("../internal/keys/pastecal-web-firebase-adminsdk-scf60-24fc54f2df.json");

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://pastecal-web-default-rtdb.firebaseio.com"
    });
} else {
    admin.initializeApp();
}


const DEFAULT_ROOT = "calendars";
const READONLY_ROOT = "calendars_readonly";
const STATS_ROOT = "calendar_stats";

// Records ICS feed popularity/bandwidth per calendar so a bandwidth spike can be traced to a
// specific calendar without digging through Cloud Logging (see the bandwidth investigation
// that motivated this — RTDB egress jumped ~15x with no matching rise in request counts, and
// there was no per-calendar breakdown anywhere to narrow it down).
//
// Must be awaited before the response is sent, not fire-and-forget: this function's instances
// get frozen/recycled immediately after the HTTP response completes (observed directly —
// "Container terminated on signal 6" landed right after a served response, and the write
// initiated alongside it never reached the database), so anything not awaited can be silently
// dropped. A failure here is logged but swallowed — a stats write must never fail the request.
// A per-process salt, regenerated every time an instance starts and never stored.
// It makes the device hashes below un-reversible even by us: without the salt no
// IP can be tested against a stored hash, and the salt does not outlive the
// process. This is the difference between "an estimate of how many devices poll
// this feed" and "a log of who reads this calendar."
const DEVICE_SALT = crypto.randomBytes(32);

/**
 * A coarse, deliberately lossy device bucket for counting ICS subscribers.
 *
 * The ICS protocol has no client id -- polling is anonymous by design -- so the
 * only available signal is user-agent plus IP. Both are personal data, so neither
 * is stored: they are hashed together with a per-process salt and the UTC date,
 * then truncated to 8 hex chars, and only the resulting bucket name is written.
 *
 * Consequences of that design, all intentional:
 *   - the hash cannot be reversed or matched against a known IP
 *   - it rotates daily, so nothing tracks a device across days
 *   - 8 hex chars will collide occasionally at scale, which biases the estimate
 *     DOWN. Undercounting is the right failure direction for a vanity metric.
 *
 * Returns null for aggregators (see AGGREGATOR_UA): Google fetches feeds
 * server-side on behalf of every subscriber, so one Google IP may represent one
 * person or five hundred. Counting those as one device would be a lie; they are
 * tallied separately as "unknown reach" instead.
 */
const AGGREGATOR_UA = /Google-Calendar-Importer|WordPress|Microsoft Exchange|Outlook-iOS|feedburner|Yahoo/i;

function deviceBucket(userAgent, ip) {
    if (!userAgent || AGGREGATOR_UA.test(userAgent)) return null;
    const day = new Date().toISOString().slice(0, 10);
    return crypto.createHash('sha256')
        .update(DEVICE_SALT)
        .update(`${day}|${userAgent}|${ip || ''}`)
        .digest('hex')
        .slice(0, 8);
}

/** Which family of client this is, for a breakdown that needs no identity at all. */
function clientFamily(userAgent) {
    const ua = userAgent || '';
    if (/dataaccessd/i.test(ua)) return /^iOS/i.test(ua) ? 'apple_ios' : 'apple_macos';
    if (/Google-Calendar-Importer/i.test(ua)) return 'google';
    if (/ICSx5|ical4j|Android/i.test(ua)) return 'android';
    if (/Microsoft Exchange|Outlook/i.test(ua)) return 'outlook';
    if (/WordPress/i.test(ua)) return 'wordpress';
    if (/Thunderbird|Evolution|Lightning/i.test(ua)) return 'desktop_linux';
    if (/Mozilla|Chrome|Safari|curl|wget/i.test(ua)) return 'browser_or_script';
    return 'other';
}

// Buckets are kept for this long, then swept. Long enough for a weekly-unique
// estimate and a month-over-month trend; short enough that the store does not
// become a de-facto history of who reads what.
const DEVICE_BUCKET_TTL_DAYS = 35;

async function recordIcsStat(id, { bytes, wasNotModified, userAgent, ip }) {
    const update = {
        lastServedAt: admin.database.ServerValue.TIMESTAMP,
        icsRequestCount: admin.database.ServerValue.increment(1),
    };
    if (wasNotModified) {
        update.ics304Count = admin.database.ServerValue.increment(1);
    } else {
        update.bytesServedTotal = admin.database.ServerValue.increment(bytes);
    }

    const day = new Date().toISOString().slice(0, 10);
    const family = clientFamily(userAgent);
    const bucket = deviceBucket(userAgent, ip);

    // Client mix, which carries no identity -- just which apps subscribe.
    update[`clients/${family}`] = admin.database.ServerValue.increment(1);

    if (bucket) {
        // Presence only. The value is the day, so a sweep can drop stale buckets
        // without reading anything else, and repeated polls from the same device
        // collapse into one key rather than accumulating.
        update[`devices/${day}/${bucket}`] = true;
    } else {
        // An aggregator stands in for an unknown number of real people.
        update[`aggregatorHits/${day}`] = admin.database.ServerValue.increment(1);
    }

    try {
        await admin.database().ref(STATS_ROOT).child(id).update(update);
        await sweepOldDeviceBuckets(id, day);
    } catch (err) {
        console.error(`Failed to record ICS stat for ${id}:`, err);
    }
}

/**
 * Drop device buckets older than the TTL.
 *
 * Opportunistic rather than scheduled: a busy feed is polled every few hours, so
 * its own traffic keeps it swept, and a feed nobody polls has nothing arriving to
 * expire. That avoids standing up Cloud Scheduler for a job with no deadline.
 *
 * Rate-limited to one sweep per calendar per day via a marker, so a feed polled
 * 8,000 times does not pay for 8,000 range reads. Failure is swallowed: retention
 * housekeeping must never break serving a calendar.
 */
async function sweepOldDeviceBuckets(id, today) {
    try {
        const ref = admin.database().ref(STATS_ROOT).child(id);
        const marker = await ref.child('devicesSweptOn').once('value');
        if (marker.val() === today) return;

        const cutoff = new Date(Date.now() - DEVICE_BUCKET_TTL_DAYS * 86400000)
            .toISOString().slice(0, 10);

        // Keys are ISO dates, so lexical ordering is chronological -- endBefore
        // gives exactly the expired days without reading the live ones.
        const stale = await ref.child('devices').orderByKey().endBefore(cutoff).once('value');

        const updates = { devicesSweptOn: today };
        stale.forEach((child) => { updates[`devices/${child.key}`] = null; });

        const aggStale = await ref.child('aggregatorHits').orderByKey().endBefore(cutoff).once('value');
        aggStale.forEach((child) => { updates[`aggregatorHits/${child.key}`] = null; });

        await ref.update(updates);
    } catch (err) {
        console.error(`Device bucket sweep failed for ${id}:`, err);
    }
}

// Calendar Data Service
const CalendarService = {
    parseCalendarPath(path) {
        //console.log('Parsing calendar path:', path);
        const parts = path.split('/').filter(x => x); // "/view/123" and "view/123"
        const isReadOnly = parts[0] === "view";
        const rawSlug = isReadOnly ? parts[1] : parts[0];
        let ret = {
            isReadOnly,
            rawSlug,
            id: SlugService.normalizeSlug(rawSlug)
        };
        //console.log('Parsed calendar path:', ret);
        return ret;
    },

    async getCalendarData(id, isReadOnly = false) {
        const rootNode = isReadOnly ? READONLY_ROOT : DEFAULT_ROOT;
        const calendarRef = admin.database().ref(rootNode).child(id);
        const snapshot = await calendarRef.once('value');
        const calendarData = snapshot.val();

        if (!calendarData) {
            throw new functions.https.HttpsError('not-found', 'Calendar not found');
        }

        return { data: calendarData, ref: calendarRef };
    }
};

// ICS Generation Service
const ICSService = {
    escapeText(text) {
        return String(text ?? '').replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\n/g, '\\n');
    },

    // Normalize a stored date into ICS basic format (YYYYMMDDTHHMMSSZ), or null if the
    // value isn't a usable date. Values reach us as ISO strings, but Date objects and epoch
    // numbers have both appeared in stored data, so accept anything Date can parse and
    // reject the rest rather than throwing.
    formatDateTime(dateTime) {
        if (dateTime === null || dateTime === undefined || dateTime === '') return null;

        // Always normalise through Date rather than string-editing the input. The old fast
        // path stripped separators without converting the zone, so an offset stamp like
        // "2026-09-07T17:00:00-04:00" became "20260907T1700000400" and a naive
        // "2026-09-07T17:00:00" kept a local wall time as though it were UTC. Both are
        // invalid DTSTART values, and a strict subscriber rejects the WHOLE calendar over
        // one of them -- the same blast radius as the malformed-event incident that
        // isRenderable was added for.
        const d = dateTime instanceof Date ? dateTime : new Date(dateTime);
        if (isNaN(d.getTime())) return null;

        const out = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        // Emit only a well-formed UTC stamp; anything else is treated as unusable so the
        // event is skipped individually instead of corrupting the feed.
        return /^\d{8}T\d{6}Z$/.test(out) ? out : null;
    },

    // Date-only form (YYYYMMDD) for all-day events. RFC 5545 3.8.2.4 requires DTSTART to be
    // a DATE for an all-day event, and 3.8.5.1 requires EXDATE to use the same value type;
    // emitting a DATE-TIME instead means a deleted all-day occurrence never matches its
    // EXDATE and keeps appearing for subscribers.
    formatDate(dateTime) {
        if (dateTime === null || dateTime === undefined || dateTime === '') return null;
        const d = dateTime instanceof Date ? dateTime : new Date(dateTime);
        if (isNaN(d.getTime())) return null;
        const out = d.toISOString().slice(0, 10).replace(/-/g, '');
        return /^\d{8}$/.test(out) ? out : null;
    },

    // An event is only renderable if BOTH endpoints normalize to a real date. A truthiness
    // check is not enough: a Date object, an epoch number, or `{}` are all truthy but blow
    // up (or silently corrupt) downstream. Events missing dates entirely were written by
    // past client bugs; one such record used to throw in formatDateTime and take down the
    // whole feed, so unusable events are skipped individually instead.
    isRenderable(event) {
        if (!event) return false;
        return this.formatDateTime(event.start) !== null
            && this.formatDateTime(event.end) !== null;
    },

    // Normalise one stored exception date to the iCalendar form. The app writes them as
    // comma-separated UTC stamps (20260424T160000Z); anything unparseable is dropped
    // rather than emitted, since a malformed EXDATE can invalidate the whole calendar for
    // a strict client.
    exceptionDates(event) {
        const raw = event && event.recurrenceException;
        if (!raw || typeof raw !== "string") return [];
        return raw.split(",")
            .map(s => s.trim())
            .filter(s => /^\d{8}T\d{6}Z?$/.test(s))
            .map(s => (s.endsWith("Z") ? s : `${s}Z`));
    },

    // Which instance a moved occurrence replaces. Syncfusion accumulates the parent's whole
    // exception list onto each child, so the first entry is not necessarily this child's own
    // original slot -- using it made every child after the first emit the SAME
    // RECURRENCE-ID, and a duplicate (UID, RECURRENCE-ID) pair makes clients keep one and
    // discard the rest. That deletes meetings, which is worse than the duplication it
    // replaced. Pick the exception whose time-of-day matches this occurrence, falling back
    // to the one nearest its start.
    occurrenceOriginal(event) {
        const candidates = this.exceptionDates(event);
        if (!candidates.length) return null;
        if (candidates.length === 1) return candidates[0];

        const startMs = new Date(event.start).getTime();
        if (isNaN(startMs)) return candidates[0];

        const toMs = (stamp) => Date.parse(
            `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
            `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);

        let best = candidates[0], bestDelta = Infinity;
        for (const c of candidates) {
            const ms = toMs(c);
            if (isNaN(ms)) continue;
            const delta = Math.abs(ms - startMs);
            if (delta < bestDelta) { bestDelta = delta; best = c; }
        }
        return best;
    },

    createEventBlock(event, dtstamp, overriddenSlots) {
        // An edited occurrence is stored as its own record pointing at its parent through
        // recurrenceID, and it inherits the parent's RecurrenceRule in the process. Emitting
        // that rule would turn one moved occurrence into a second full series.
        //
        // Sharing the parent's UID is only valid when RECURRENCE-ID identifies which
        // instance this replaces. Without one, two VEVENTs share a UID and a client treats
        // the second as a redefinition of the series -- collapsing every other occurrence.
        // So a child with no usable exception date falls back to being a standalone event.
        const original = event.recurrenceID ? this.occurrenceOriginal(event) : null;
        const isOccurrence = !!event.recurrenceID && !!original;

        const allDay = !!event.isAllDay;
        const start = allDay ? this.formatDate(event.start) : this.formatDateTime(event.start);
        const end = allDay ? this.formatDate(event.end) : this.formatDateTime(event.end);
        const dateParam = allDay ? ";VALUE=DATE" : "";

        const eventLines = [
            "BEGIN:VEVENT",
            `UID:${isOccurrence ? event.recurrenceID : event.id}`,
            `DTSTAMP:${dtstamp}`,
            `DTSTART${dateParam}:${start}`,
            `DTEND${dateParam}:${end}`,
            `SUMMARY:${this.escapeText(event.title)}`,
            `DESCRIPTION:${this.escapeText(event.description)}`
        ];

        // EXDATE must use the same value type as DTSTART, or it matches no instance and the
        // exclusion is silently ignored.
        const asValue = (stamp) => allDay ? stamp.slice(0, 8) : stamp;

        if (isOccurrence) {
            eventLines.push(`RECURRENCE-ID${dateParam}:${asValue(original)}`);
        } else if (event.recurrencerule) {
            eventLines.push(`RRULE:${event.recurrencerule}`);

            // Without EXDATE, an occurrence the user deleted in the app is still generated
            // by the rule, so every subscriber keeps seeing a meeting that was cancelled.
            // Slots that a moved occurrence overrides are excluded from this list: those
            // instances are replaced, not removed, and EXDATE'ing one deletes the slot its
            // override was meant to fill.
            const exdates = this.exceptionDates(event)
                .filter(stamp => !(overriddenSlots && overriddenSlots.has(stamp)))
                .map(asValue);
            if (exdates.length) eventLines.push(`EXDATE${dateParam}:${exdates.join(",")}`);
        }

        eventLines.push("END:VEVENT");
        return eventLines.join("\r\n");
    },

    generateICS(calendarData, id) {
        // Firebase renders an events map as an object (not an array) when keys are sparse
        // or non-numeric, so never assume Array here.
        const raw = calendarData?.events;
        const allEvents = Array.isArray(raw)
            ? raw
            : (raw && typeof raw === 'object' ? Object.values(raw) : []);

        const renderable = allEvents.filter(event => this.isRenderable(event));

        const skipped = allEvents.length - renderable.length;
        if (skipped > 0) {
            console.warn(`Skipped ${skipped} malformed event(s) missing start/end in calendar ${id}`);
        }

        // DTSTAMP is "when this representation of the calendar was generated," not an
        // event property in our data model, so every VEVENT in a given export shares one.
        const dtstamp = this.formatDateTime(new Date());

        // Which instances of each series are replaced by a moved occurrence rather than
        // deleted. A moved occurrence is expressed as an override (same UID, a
        // RECURRENCE-ID naming the slot it replaces) -- but the app records the move in the
        // parent's exception list too, exactly as it records a deletion. EXDATE'ing that
        // slot removes the instance the override was meant to fill, so the moved event
        // disappears from the feed entirely. Verified against a real iCalendar parser:
        // with the EXDATE present the occurrence is gone; without it, it resolves at its
        // new time. So EXDATE must carry only the genuinely deleted dates.
        const overridden = new Map();
        for (const event of renderable) {
            if (!event.recurrenceID) continue;
            const slot = this.occurrenceOriginal(event);
            if (!slot) continue;
            if (!overridden.has(event.recurrenceID)) overridden.set(event.recurrenceID, new Set());
            overridden.get(event.recurrenceID).add(slot);
        }

        const events = renderable.map(event =>
            this.createEventBlock(event, dtstamp, overridden.get(event.id)));

        // Without X-WR-CALNAME a subscription shows up in the user's calendar list
        // as the raw feed URL, or as "Untitled" -- so a shared roster is unlabelled
        // in the one place the subscriber actually looks. Fall back to the id
        // rather than emitting an empty name, which some clients render as blank.
        const name = this.escapeText(calendarData?.title || id);

        // REFRESH-INTERVAL is the RFC 7986 hint; X-PUBLISHED-TTL is the older
        // Microsoft equivalent that Outlook still honours. Clients that read
        // neither pick their own interval, and some default to once a day, which
        // makes a shared calendar feel broken when an edit doesn't show up.
        return [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            `PRODID:-//PasteCal//${id}//EN`,
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            `X-WR-CALNAME:${name}`,
            `NAME:${name}`,
            "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
            "X-PUBLISHED-TTL:PT1H",
            ...events,
            "END:VCALENDAR"
        ].join("\r\n");
    }
};

// Slug Validation Service
const SlugService = {
    validateSlug(slug) {
        // Allow alphanumeric characters, hyphens, and underscores
        // Must be 3-50 characters long
        // Cannot be 'view' or other reserved words
        const slugRegex = /^[a-zA-Z0-9-_]{3,50}$/;
        const reservedWords = [
            'view', 'api', 'admin', 'administrator', 'www', 'app', 'apps', 'calendar', 'cal',
            'about', 'account', 'accounts', 'assets', 'auth', 'bin', 'billing', 'blog', 'bot',
            'cache', 'careers', 'cgi-bin', 'config', 'contact', 'cpanel', 'css', 'dashboard',
            'dev', 'docs', 'download', 'downloads', 'enterprise', 'faq', 'favicon.ico', 'ftp',
            'ghost', 'guide', 'help', 'home', 'hostmaster', 'images', 'img', 'imap', 'index',
            'jobs', 'js', 'legal', 'login', 'logout', 'mail', 'manage', 'media', 'me',
            'moderator', 'mx', 'news', 'ns', 'ns1', 'ns2', 'null', 'oauth', 'password', 'pop',
            'pop3', 'postmaster', 'press', 'pricing', 'privacy', 'pro', 'profile', 'public',
            'recover', 'register', 'reset', 'robots.txt', 'root', 'settings', 'setup', 'signin',
            'signout', 'signup', 'sitemap.xml', 'smtp', 'ssl', 'static', 'status',
            'subscriptions', 'superuser', 'support', 'sys', 'sysadmin', 'system', 'team',
            'terms', 'tos', 'undefined', 'user', 'users', 'v1', 'v2', 'webhooks', 'webmail',
            'wiki', 'wp-admin', 'wp-content', 'wp-login',
        ];

        return slugRegex.test(slug) && !reservedWords.includes(slug.toLowerCase());
    },

    normalizeSlug(slug) {
        // Convert to lowercase for consistent storage and lookup
        return slug.toLowerCase();
    },

    async isSlugAvailable(slug) {
        // Check if normalized slug exists in readonly calendars
        const normalizedSlug = this.normalizeSlug(slug);
        const slugRef = admin.database().ref(READONLY_ROOT).child(normalizedSlug);
        const snapshot = await slugRef.once('value');
        return !snapshot.exists();
    },

    // A not-found result is cached for this long, then re-checked with a real lookup. Short
    // relative to how long a slug stays unclaimed, but long enough that a burst of requests
    // for the same dead/expired/guessed slug (the case that motivated this cache) only pays
    // for one full scan instead of one per request.
    NOT_FOUND_CACHE_MS: 10 * 60 * 1000,

    async lookupCalendar(requestedSlug) {
        const normalizedSlug = this.normalizeSlug(requestedSlug);

        // Check cache first
        const cacheRef = admin.database().ref(`/slug_mappings/${normalizedSlug}`);
        const cached = await cacheRef.once('value');
        const cacheData = cached.val();

        if (cacheData) {
            if (typeof cacheData === 'string') {
                // Legacy cache format - assume editable
                return { found: true, actualSlug: cacheData, isReadOnly: false };
            } else if (cacheData.notFound) {
                // Negative cache entry — a calendar can be created later under a slug that
                // was previously not found, so this must expire rather than cache forever
                // (see the full-scan comment below for why an uncached miss is expensive).
                if (Date.now() - cacheData.cachedAt < this.NOT_FOUND_CACHE_MS) {
                    return { found: false };
                }
                // Expired — fall through and re-check for real.
            } else {
                // New cache format with type
                return { found: true, actualSlug: cacheData.actualSlug, isReadOnly: cacheData.isReadOnly };
            }
        }

        // Cache miss. Try an exact-key read on the caller's original casing: callers pass the
        // raw, non-lowercased slug (see CalendarService.parseCalendarPath), which matches the
        // stored key in the vast majority of cases.
        //
        // Read `id` rather than the calendar node itself. Existence is the only question here,
        // and `.once('value')` on the node would pull the entire event list -- megabytes for a
        // busy calendar -- to answer a yes/no. Every calendar record has an `id`.
        const exactEditable = await admin.database().ref(DEFAULT_ROOT).child(requestedSlug).child('id').once('value');
        if (exactEditable.exists()) {
            const key = requestedSlug;
            await cacheRef.set({ actualSlug: key, isReadOnly: false });
            return { found: true, actualSlug: key, isReadOnly: false };
        }

        const exactReadOnly = await admin.database().ref(READONLY_ROOT).child(requestedSlug).child('id').once('value');
        if (exactReadOnly.exists()) {
            const key = requestedSlug;
            await cacheRef.set({ actualSlug: key, isReadOnly: true });
            return { found: true, actualSlug: key, isReadOnly: true };
        }

        // Not found under the caller's exact casing.
        //
        // There used to be a full case-insensitive scan here, reading /calendars and
        // /calendars_readonly in their entirety to find a key that differed only in case.
        // That is what a database index is for, and this one already exists: /slug_mappings,
        // maintained by the indexSlug trigger below, holds normalized-slug -> actual-key for
        // every calendar. Anything the scan could have found is in the index, so reaching
        // this line means the slug genuinely does not exist.
        //
        // Removing it is the actual fix for the OOM crash loop: the scan pulled ~15MB
        // (calendars) + ~15MB (calendars_readonly) into a 256MiB instance on every miss,
        // died before reaching the negative-cache write below, and so re-ran on the next
        // request forever. Because a nonexistent slug is exactly what a brand-new calendar
        // looks like, creating a calendar by typing a URL was impossible on production
        // (verified 2026-08-25: nonexistent slugs returned HTTP 500/503, existing ones 200).
        // Paging or shallow-reading the scan would only have made an O(all-calendars)
        // operation cheaper; the index makes it O(1).
        await cacheRef.set({ notFound: true, cachedAt: Date.now() });
        return { found: false };
    }
};

// ID Generation Service
const IDService = {
    generateNanoId(length = 21) {
        const generateChar = (n) => {
            if (n < 36) return n.toString(36);
            if (n < 62) return (n - 26).toString(36).toUpperCase();
            return this.generateNanoId(1);
        };

        const randomValues = crypto.getRandomValues(new Uint8Array(length));
        return Array.from(randomValues)
            .map(val => generateChar(val & 63))
            .join('');
    },

    async generateUniquePublicId(attempts = 5) {
        for (let i = 0; i < attempts; i++) {
            const publicViewId = this.generateNanoId(5);
            try {
                await CalendarService.getCalendarData(publicViewId, true);
            } catch (error) {
                if (error.code === 'not-found') return publicViewId;
                throw error;
            }
        }
        throw new functions.https.HttpsError('internal', 'Failed to generate a unique public view ID');
    }
};

// Cloud Functions
// ---------------------------------------------------------------------------------------
// History: a server-written record of what every calendar looked like BEFORE any write
// that removed or changed events.
//
// Why this exists, and why it is a trigger rather than client code: in Sept 2026 a bug in
// the app's save path wrote a calendar's pre-edit state back over its post-edit state, and
// in the worst case wrote [] over a user's entire history (issues #42-#44). Every defence
// that lived in the client -- merge logic, gates, local copies -- shares one weakness: it
// only works when the client is correct, and the client is exactly the thing that was
// wrong. Anyone with a link can also write anything with the SDK directly.
//
// So the recovery data is produced here, by the Admin SDK, into /history -- a node the
// security rules make unwritable by clients. No client, buggy or hostile, can prevent its
// own destructive write from being recorded, and none can erase the record afterwards.
// That is the property that makes data loss recoverable rather than merely unlikely.
//
// Only writes that could have LOST something are recorded (an event removed or changed,
// a title cleared, the calendar deleted). Adds and notes edits are not: nothing was lost,
// and recording them would bury the entries that matter.
// ---------------------------------------------------------------------------------------
const HISTORY_ROOT = "history";
const HISTORY_KEEP = 20;   // per calendar; older entries are trimmed

const HistoryService = {
    eventsOf(cal) {
        const e = cal && cal.events;
        if (Array.isArray(e)) return e.filter(Boolean);
        return (e && typeof e === 'object') ? Object.values(e) : [];
    },

    // Same identity as the client's merge: a recurring master and its occurrence
    // exception share an id and differ only by recurrenceID.
    key(e) { return `${e.id}|${e.recurrenceID ?? ''}`; },

    // Compare on meaning, not on JSON text -- the same rule CalendarDataService._mergeEvents
    // applies, and for the same reason. Firebase does not store null- or ''-valued keys, so
    // an event written by an older client comes back without description/repeat/
    // recurrencerule/isAllDay, while the current client rebuilds it through Event's
    // constructor with those set to ''/false. JSON.stringify calls that a change, so a
    // notes-only edit on a legacy calendar would record every event as "edited" and push a
    // full snapshot -- on the largest real calendar, ~743KB of history for a write that
    // lost nothing.
    FIELDS: ['title', 'description', 'start', 'end', 'type', 'isAllDay',
        'repeat', 'recurrencerule', 'recurrenceID', 'recurrenceException'],

    sameEvent(a, b) {
        const norm = (v) => (v === undefined || v === null || v === '') ? null : v;
        return this.FIELDS.every(f => {
            const x = norm(a[f]), y = norm(b[f]);
            if (f === 'type') return String(x === null ? 1 : x) === String(y === null ? 1 : y);
            if (f === 'isAllDay') return !!x === !!y;
            return x === y;
        });
    },

    // What this write did, or null if it did nothing. Pure, so it is unit-testable
    // without a database.
    //
    // Additions are recorded too, even though there is nothing to restore from them: the
    // panel is a list of recent CHANGES, and a user who adds an event and then sees no
    // trace of it reasonably concludes the list is broken. They are marked `added` so the
    // UI can list them without offering a Restore button that would do nothing.
    changeKind(before, after) {
        if (!before) return null;                                   // brand-new calendar
        const b = this.eventsOf(before);
        if (!after) return { kind: 'deleted', removed: b.length, changed: 0, added: 0 };

        const beforeKeys = new Map(b.map(e => [this.key(e), e]));
        const afterEvents = this.eventsOf(after);
        const a = new Map(afterEvents.map(e => [this.key(e), e]));

        let removed = 0, changed = 0;
        for (const e of b) {
            const x = a.get(this.key(e));
            if (!x) removed++;
            else if (!this.sameEvent(x, e)) changed++;
        }
        const added = afterEvents.filter(e => !beforeKeys.has(this.key(e))).length;

        const titleLost = !!before.title && !after.title;
        if (!removed && !changed && !added && !titleLost) return null;

        const kind = (b.length > 0 && removed === b.length) ? 'wiped'
            : removed ? 'shrunk'
                : changed ? 'edited'
                    : added ? 'added' : 'title-cleared';
        return { kind, removed, changed, added };
    },

    /**
     * Stamp when the calendar last changed at all -- including pure additions.
     *
     * Separate from the snapshot log below because the two answer different questions.
     * /history exists to RESTORE, so it only records writes that lost something; recording
     * every add would bloat it with full event arrays and bury the entries worth
     * recovering. But "Edited N ago" is asking whether anything happened, and adding an
     * event is plainly editing the calendar -- a user who adds two events and sees the
     * label unchanged has been told something false.
     *
     * One number per calendar, overwritten in place, so it costs nothing to keep current.
     */
    async stampLastEdit(db, calendarId, before, after) {
        if (!after) return null;                       // deletion: nothing left to stamp
        const b = this.eventsOf(before), a = this.eventsOf(after);
        const changed = !before
            || b.length !== a.length
            || (before.title ?? '') !== (after.title ?? '')
            || JSON.stringify(before.options ?? null) !== JSON.stringify(after.options ?? null)
            || a.some((e, i) => !this.sameEvent(e, b[i] ?? {}));
        if (!changed) return null;
        return db.ref(`/${HISTORY_ROOT}_meta/${calendarId}/lastEditedAt`).set(Date.now());
    },

    async record(db, calendarId, before, after) {
        const why = this.changeKind(before, after);
        if (!why) return null;

        const ref = db.ref(`/${HISTORY_ROOT}/${calendarId}`);
        // For an addition, name what arrived -- the snapshot in `events` is the state
        // BEFORE, so it cannot answer "what was added" on its own.
        const beforeKeys = new Set(this.eventsOf(before).map(e => this.key(e)));
        const addedEvents = after
            ? this.eventsOf(after).filter(e => !beforeKeys.has(this.key(e)))
            : [];

        const pushed = await ref.push({
            savedAt: Date.now(),
            kind: why.kind,
            removed: why.removed,
            changed: why.changed,
            added: why.added || 0,
            addedEvents,
            eventCount: this.eventsOf(before).length,
            title: before.title ?? null,
            options: before.options ?? null,
            events: this.eventsOf(before),
        });

        // Trim to the newest HISTORY_KEEP. Push ids are time-ordered, so key order is
        // savedAt order without needing an index.
        //
        // Ask only for the OLDEST few keys rather than the whole node. Reading every
        // retained entry just to count them would pull ~14.5MB into the function on the
        // largest real calendar, on every recorded write -- the payloads are full event
        // arrays. limitToFirst caps that at the handful that might need deleting.
        //
        // Only the keys are used, so a concurrent trigger trimming at the same time is
        // harmless: deletes are by explicit push key and idempotent, and the newest
        // entries are never in this window. The window is wider than one write's growth,
        // so any backlog drains over the next few writes rather than persisting.
        const oldest = await ref.orderByKey().limitToFirst(HISTORY_KEEP * 2).once('value');
        const keys = [];
        oldest.forEach(c => { keys.push(c.key); });
        if (keys.length > HISTORY_KEEP) {
            const del = {};
            for (const k of keys.slice(0, keys.length - HISTORY_KEEP)) del[k] = null;
            await ref.update(del);
        }
        return pushed.key;
    },
};

exports.generateICSV2 = onRequest({ cors: true }, async (req, res) => {
    try {
        const pathWithoutICS = req.path.replace(/[.]ICS.*/i, '');
        //console.log('Path without ICS:', pathWithoutICS);
        const { rawSlug } = CalendarService.parseCalendarPath(pathWithoutICS);

        // Calendars are stored under their original casing, but URLs (and the naive
        // lowercase in parseCalendarPath) may not match it — resolve via the same
        // case-insensitive lookup the web app uses, instead of reading the lowercased
        // key directly, which silently 404s or returns an unrelated calendar (#37).
        const lookup = await SlugService.lookupCalendar(rawSlug);
        if (!lookup.found) {
            throw new functions.https.HttpsError('not-found', 'Calendar not found');
        }
        const cleanId = lookup.actualSlug;
        const isReadOnly = lookup.isReadOnly;

        const { data: calendarData } = await CalendarService.getCalendarData(cleanId, isReadOnly);

        // ETag is a hash of the events data only, so it's stable across requests when
        // nothing has changed and busts automatically the moment an event is added/edited/
        // removed — this is what lets calendar-app pollers 304 instead of re-downloading the
        // full feed every few minutes (the previous bandwidth spike investigation showed this
        // route had no caching at all).
        const etag = '"' + crypto.createHash('sha1').update(JSON.stringify(calendarData?.events ?? null)).digest('hex') + '"';
        const userAgent = req.headers['user-agent'] || 'unknown';

        // Only ever passed to deviceBucket(), which salts and hashes it. Never stored,
        // never logged -- see the comment on DEVICE_SALT.
        const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';

        if (req.headers['if-none-match'] === etag) {
            console.log(`ICS 304: id=${cleanId} readonly=${isReadOnly} ua="${userAgent}"`);
            await recordIcsStat(cleanId, { wasNotModified: true, userAgent, ip: clientIp });
            res.set('ETag', etag).set('Cache-Control', 'public, max-age=300').status(304).end();
            return;
        }

        const icsData = ICSService.generateICS(calendarData, cleanId);

        console.log(`ICS served: id=${cleanId} readonly=${isReadOnly} bytes=${icsData.length} ua="${userAgent}"`);
        await recordIcsStat(cleanId, {
            bytes: icsData.length, wasNotModified: false, userAgent, ip: clientIp,
        });

        res.set('Content-Type', 'text/calendar')
            .set('ETag', etag)
            .set('Cache-Control', 'public, max-age=300')
            .send(icsData);
    } catch (err) {
        // A missing calendar is a client error, not a server fault. Returning 500 here made
        // subscribed calendar apps retry a deleted feed forever; 404 tells them to stop.
        const status = err?.httpErrorCode?.status ?? 500;

        if (status >= 500) {
            // Structured so this is queryable and alertable in Cloud Logging, not just
            // readable. Subscribers experience an ICS failure as a feed that quietly stops
            // updating -- they are not on the site and cannot report it, so the log is the
            // only place this failure can ever be noticed.
            // req.path, not the resolved slug: that is declared inside the try and is out
            // of scope here, and a ReferenceError raised while reporting a failure would
            // replace the real error with a worse one.
            console.error(JSON.stringify({
                severity: 'ERROR',
                event: 'ics_failed',
                path: String(req.path || '').slice(0, 120),
                reason: err?.message || 'unknown',
            }));
            console.error('Error generating ICS:', err);
            res.status(status).send('Server error generating ICS');
        } else {
            console.log(`ICS request failed with ${status}: ${err.message}`);
            res.status(status).send(err.message || 'Calendar not found');
        }
    }
});

exports.createPublicLink = onCall(async (request) => {
    const { sourceCalendarId, customSlug } = request.data;

    try {
        const { data: calendarData, ref: sourceCalRef } = await CalendarService.getCalendarData(sourceCalendarId);
        let publicViewId;

        // Use custom slug if provided, otherwise generate random ID
        if (customSlug) {
            if (!SlugService.validateSlug(customSlug)) {
                throw new functions.https.HttpsError('invalid-argument', 'Invalid slug format. Use 3-50 alphanumeric characters, hyphens, or underscores.');
            }
            
            const isAvailable = await SlugService.isSlugAvailable(customSlug);
            if (!isAvailable) {
                throw new functions.https.HttpsError('already-exists', 'Slug is already taken. Please choose a different one.');
            }
            
            publicViewId = SlugService.normalizeSlug(customSlug);
        } else {
            publicViewId = await IDService.generateUniquePublicId();
        }

        const publicCalData = JSON.parse(JSON.stringify(calendarData));
        // Embed publicViewId in the mirror at creation so a viewer who arrives before
        // the next syncPublicView fires can still resolve the read-only path. Without
        // this, the client's getViewerBasePath would fall through to /${calendar.id}.
        publicCalData.options = publicCalData.options || {};
        publicCalData.options.publicViewId = publicViewId;

        await Promise.all([
            sourceCalRef.child('options/publicViewId').set(publicViewId),
            admin.database().ref(`${READONLY_ROOT}/${publicViewId}`).set(publicCalData)
        ]);

        return { publicViewId };
    } catch (error) {
        throw error;
    }
});


/**
 * Keep /slug_mappings in step with the calendars themselves.
 *
 * lookupCalendar resolves a URL slug to the actual stored key, which can differ in casing.
 * That used to be answered by scanning every calendar; it is now answered by this index, so
 * the index has to exist for a calendar the moment the calendar does. The client writes
 * straight to /calendars/<slug> and knows nothing about the index, so maintaining it here
 * keeps that a server-side concern and works no matter which client did the write.
 *
 * onValueWritten (not onValueUpdated) so this fires on creation, not only on later edits --
 * creation is the case that matters. Writes only the mapping, never the calendar, so there
 * is no trigger loop.
 */
// Scoped to /id, not the calendar node. A trigger on the whole node would receive every
// calendar's full before+after payload on every edit -- megabytes per keystroke-debounced
// save on a busy calendar, which is the same mistake that OOMed lookupCalendar. `id` is
// written once when the calendar is created and never changes, so watching it fires exactly
// when the mapping needs to change (create and delete) and carries almost no data.
exports.indexSlug = onValueWritten(`/${DEFAULT_ROOT}/{calendarId}/id`, async (event) => {
    const calendarId = event.params.calendarId;
    const normalized = SlugService.normalizeSlug(calendarId);
    const mappingRef = admin.database().ref(`/slug_mappings/${normalized}`);

    if (!event.data.after.exists()) {
        // Calendar deleted -- drop the mapping so the slug reads as free again, but only if
        // it still points here. A case-twin may legitimately own the slug (see the backfill
        // script's ambiguous list); deleting one must not strand the other.
        const current = (await mappingRef.once('value')).val();
        if (current && current.actualSlug !== calendarId) return null;
        return mappingRef.remove();
    }

    // Skip a no-op rewrite so ordinary edits don't churn the index.
    const current = (await mappingRef.once('value')).val();
    if (current && current.actualSlug === calendarId && current.isReadOnly === false) return null;

    // Do not take a slug away from a case-twin that holds data.
    //
    // Firebase keys are case-sensitive but slugs are resolved case-insensitively, so
    // `N2U5H6CH` and `n2u5h6ch` are two calendars competing for one mapping. This write
    // used to be last-wins: whoever was created most recently owned the slug. That is how
    // a user with a full calendar ended up looking at a blank one -- somebody opened the
    // other casing, an empty calendar was created there, and the mapping followed it.
    //
    // Ownership belongs to whoever has the events, not whoever wrote last. An empty
    // incumbent is still replaced, so a genuinely abandoned placeholder does not hold a
    // slug hostage. The delete branch above already reasons this way; this is the same
    // rule applied to creation.
    if (current && current.actualSlug && current.actualSlug !== calendarId) {
        const incumbent = await admin.database()
            .ref(`/${DEFAULT_ROOT}/${current.actualSlug}/events`).once('value');
        if (incumbent.exists() && incumbent.numChildren() > 0) {
            console.log(`indexSlug: ${calendarId} not taking /${normalized} from ` +
                `${current.actualSlug}, which has ${incumbent.numChildren()} event(s)`);
            return null;
        }
    }

    // Overwrites any negative-cache entry, so a slug that was looked up before it existed
    // resolves immediately instead of waiting out NOT_FOUND_CACHE_MS.
    return mappingRef.set({ actualSlug: calendarId, isReadOnly: false });
});

/** Same, for read-only calendars, which lookupCalendar also resolves. Scoped to /id for the
 *  same reason: syncPublicView rewrites the whole read-only node on every edit of its parent
 *  calendar, so a node-level trigger here would fire constantly with a full payload. */
exports.indexReadOnlySlug = onValueWritten(`/${READONLY_ROOT}/{calendarId}/id`, async (event) => {
    const calendarId = event.params.calendarId;
    const normalized = SlugService.normalizeSlug(calendarId);
    const mappingRef = admin.database().ref(`/slug_mappings/${normalized}`);

    const existing = (await mappingRef.once('value')).val();

    if (!event.data.after.exists()) {
        // Only drop the mapping if it actually points at this view.
        if (existing && existing.actualSlug !== calendarId) return null;
        return mappingRef.remove();
    }

    // An editable calendar and a read-only view never share a slug, but if one somehow did,
    // the editable mapping is the more useful one -- don't clobber it.
    if (existing && existing.isReadOnly === false) return null;

    // Skip no-op rewrites.
    if (existing && existing.actualSlug === calendarId && existing.isReadOnly === true) return null;

    return mappingRef.set({ actualSlug: calendarId, isReadOnly: true });
});

exports.syncPublicView = onValueUpdated(`/${DEFAULT_ROOT}/{calendarId}`, (event) => {
    const afterData = event.data.after.val();
    const publicViewId = afterData.options?.publicViewId;

    if (!publicViewId) return null;

    const updatedData = JSON.parse(JSON.stringify(afterData));
    return admin.database().ref(`/${READONLY_ROOT}/${publicViewId}`).update(updatedData);
});

// Record the prior state of any calendar write that removed or changed events. Fires on
// the whole calendar node so a cleared title is caught too, and so a single trigger sees
// both the events and the settings that were lost together in issue #44.
exports.recordHistory = onValueWritten(`/${DEFAULT_ROOT}/{calendarId}`, async (event) => {
    const db = admin.database();
    const id = event.params.calendarId;
    const before = event.data.before.val();
    const after = event.data.after.val();
    // Stamped for every change, snapshotted only for the destructive ones.
    await HistoryService.stampLastEdit(db, id, before, after);
    return HistoryService.record(db, id, before, after);
});

// Case-insensitive calendar lookup function
exports.lookupCalendar = onCall(async (request) => {
    try {
        console.log('lookupCalendar called with request.data:', request.data);
        console.log('Request context auth:', request.auth ? 'authenticated' : 'unauthenticated');
        
        const requestedSlug = request.data?.slug;
        
        if (!requestedSlug) {
            const errorMsg = `Slug is required. Received slug: ${request.data?.slug}`;
            console.error(errorMsg);
            throw new functions.https.HttpsError('invalid-argument', errorMsg);
        }
        
        console.log('Looking up calendar for slug:', requestedSlug);
        const result = await SlugService.lookupCalendar(requestedSlug);
        console.log('Lookup result:', JSON.stringify(result));
        
        return result;
    } catch (error) {
        console.error('Calendar lookup error:', error);
        
        // If it's already an HttpsError, re-throw it
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        
        // Otherwise, wrap it in an HttpsError with details
        throw new functions.https.HttpsError('internal', 
            `Failed to lookup calendar: ${error.message}`, 
            { 
                originalError: error.message || error.toString(), 
                slug: request.data?.slug,
                errorName: error.name
            }
        );
    }
});

// Exported for unit tests (test/unit/ics.test.js). Not used by deployed functions.
exports._internal = {
    ICSService, CalendarService, SlugService, HistoryService,
    recordIcsStat, deviceBucket, clientFamily, sweepOldDeviceBuckets,
    DEVICE_BUCKET_TTL_DAYS, HISTORY_ROOT, HISTORY_KEEP,
};

/*
// local cleanup task: Update eventIDs to be GUIDs
// uncomment, run locally:  
// curl -X GET http://localhost:8081/pastecal-web/us-central1/updateEventIds
exports.updateEventIds = functions.https.onRequest(async (req, res) => {
    try {
        const db = admin.database(); // Use this line for Realtime Database
        const calendarsRef = db.ref('/calendars');
        const snapshot = await calendarsRef.once('value');

        const promises = [];

        snapshot.forEach(childSnapshot => {
            const calendarKey = childSnapshot.key; // Get the root node key
            const calendarData = childSnapshot.val();

            // Check if there are events
            if (calendarData.events && calendarData.events.length > 0) {
                let replacedCount = 0; // Counter for replaced IDs

                // Iterate through all events
                calendarData.events.forEach(event => {
                    // Check if the id is a string containing a "-"
                    const isGuid = (id) => typeof id === 'string' && id.includes('-');

                    // Check if the id is not a number and not a GUID
                    if (typeof event.id === 'number' || !isGuid(event.id)) {
                        // Replace the event's id with a GUID
                        event.id = uuidv4();
                        replacedCount++; // Increment the counter
                    }
                });

                // Update the calendar entry in the database
                promises.push(calendarsRef.child(calendarKey).set(calendarData));

                // Log the number of replaced entries for the calendar
                console.log(`Calendar "${calendarKey}" processed: ${replacedCount} event IDs replaced.`);
            }
        });

        await Promise.all(promises); // Wait for all updates to complete
        res.send('Successfully updated event IDs');
    } catch (error) {
        console.error('Error updating event IDs:', error);
        res.status(500).send('Error updating event IDs');
    }
});
*/