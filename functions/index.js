const functions = require('firebase-functions');
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onValueUpdated, onValueWritten, onValueDeleted } = require("firebase-functions/v2/database");
const { onSchedule } = require('firebase-functions/v2/scheduler');
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
// Recorded AFTER the response is sent: a subscriber's poll must not wait on our bookkeeping.
// The cost is that an instance recycled right after responding (observed: "Container
// terminated on signal 6" right after a served response) can drop that one write. For a
// popularity estimate an occasional lost increment is fine; slower feeds for everyone are
// not. A failure here is logged and swallowed — a stats write must never fail the request.

// A server-only secret, created once and stored where no client can read it (the root
// rules deny everything not explicitly opened). Shared by every instance, so one device
// hashes to the same bucket no matter which instance or cold start serves it -- a
// per-process random salt counted one phone as several. Never logged.
const DEVICE_SALT_PATH = 'internal/device_salt';
let deviceSaltSecretPromise = null;

/** The stored secret, created on first use with a transaction so concurrent cold starts agree. */
function deviceSaltSecret() {
    if (!deviceSaltSecretPromise) {
        deviceSaltSecretPromise = admin.database().ref(DEVICE_SALT_PATH)
            .transaction((current) => current || crypto.randomBytes(32).toString('base64'))
            .then((result) => Buffer.from(result.snapshot.val(), 'base64'))
            .catch((err) => {
                // Not cached: the next request retries instead of counting nothing for
                // the life of the instance.
                deviceSaltSecretPromise = null;
                throw err;
            });
    }
    return deviceSaltSecretPromise;
}

/**
 * A coarse, deliberately lossy device bucket for counting ICS subscribers.
 *
 * The ICS protocol has no client id -- polling is anonymous by design -- so the
 * only available signal is user-agent plus IP. Both are personal data, so neither
 * is stored: they are hashed with a DAILY salt (an HMAC of the UTC date under the
 * server-only secret above), truncated to 8 hex chars, and only the resulting
 * bucket name is written.
 *
 * Consequences of that design, all intentional:
 *   - without the secret, no IP can be tested against a stored bucket
 *   - the salt changes every day, so nothing links a device's buckets across days
 *   - 8 hex chars will collide occasionally at scale, which biases the estimate
 *     DOWN. Undercounting is the right failure direction for a vanity metric.
 *
 * Returns null for aggregators (see AGGREGATOR_UA): Google fetches feeds
 * server-side on behalf of every subscriber, so one Google IP may represent one
 * person or five hundred. Counting those as one device would be a lie; they are
 * tallied separately as "unknown reach" instead. Also null without a secret, so a
 * failed salt read skips the estimate rather than hashing with something guessable.
 */
const AGGREGATOR_UA = /Google-Calendar-Importer|WordPress|Microsoft Exchange|Outlook-iOS|feedburner|Yahoo/i;

function deviceBucket(userAgent, ip, secret, day = new Date().toISOString().slice(0, 10)) {
    if (!userAgent || AGGREGATOR_UA.test(userAgent) || !secret) return null;
    const dailySalt = crypto.createHmac('sha256', secret).update(day).digest();
    return crypto.createHmac('sha256', dailySalt)
        .update(`${userAgent}|${ip || ''}`)
        .digest('hex')
        .slice(0, 8);
}

/**
 * The subscriber's IP, for deviceBucket() only.
 *
 * The leftmost X-Forwarded-For entry (and so Express's req.ip under trust proxy) is
 * whatever the client sent, so one poller could pose as any number of devices.
 * Through the Hosting rewrite, Hosting's CDN sets Fastly-Client-IP from the TCP peer
 * and the XFF entries Google adds are CDN addresses; called directly, Google's front
 * end appends the real peer as the RIGHTMOST XFF entry. A direct caller can still
 * send its own Fastly-Client-IP -- that only adds noise to a vanity estimate, which
 * any caller can do anyway by varying its user-agent.
 */
function clientIpOf(req) {
    const fastly = String(req.headers['fastly-client-ip'] || '').trim();
    if (fastly) return fastly;
    const hops = String(req.headers['x-forwarded-for'] || '').split(',')
        .map((s) => s.trim()).filter(Boolean);
    return hops.length ? hops[hops.length - 1] : (req.socket?.remoteAddress || '');
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
    try {
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

        // Client mix, which carries no identity -- just which apps subscribe.
        update[`clients/${family}`] = admin.database.ServerValue.increment(1);

        if (AGGREGATOR_UA.test(userAgent || '')) {
            // An aggregator stands in for an unknown number of real people.
            update[`aggregatorHits/${day}`] = admin.database.ServerValue.increment(1);
        } else {
            let secret = null;
            try {
                secret = await deviceSaltSecret();
            } catch (err) {
                console.error('Device salt unavailable; skipping device bucket:', err.message);
            }
            const bucket = deviceBucket(userAgent, ip, secret, day);
            // Presence only. The value is the day, so a sweep can drop stale buckets
            // without reading anything else, and repeated polls from the same device
            // collapse into one key rather than accumulating.
            if (bucket) update[`devices/${day}/${bucket}`] = true;
        }

        await admin.database().ref(STATS_ROOT).child(id).update(update);
        await sweepOldDeviceBuckets(id, day);
    } catch (err) {
        console.error(`Failed to record ICS stat for ${id}:`, err);
    }
}

const expiredBefore = () => new Date(Date.now() - DEVICE_BUCKET_TTL_DAYS * 86400000)
    .toISOString().slice(0, 10);

// Calendars this instance has already confirmed swept today. A busy feed is polled
// thousands of times a day; without this every poll paid a marker read. Reset when
// the day changes, so it holds at most one day's worth of calendar ids.
let sweptOnDay = null;
let sweptIds = new Set();

/**
 * Drop device buckets older than the TTL, opportunistically, as a calendar is polled.
 *
 * Rate-limited to one sweep per calendar per day: in memory per instance first, then
 * via a marker in the database so other instances skip it too. sweepAllDeviceBuckets
 * covers feeds nobody polls any more. Failure is swallowed: retention housekeeping must
 * never break serving a calendar.
 */
async function sweepOldDeviceBuckets(id, today) {
    try {
        if (sweptOnDay !== today) { sweptOnDay = today; sweptIds = new Set(); }
        if (sweptIds.has(id)) return;

        const ref = admin.database().ref(STATS_ROOT).child(id);
        const marker = await ref.child('devicesSweptOn').once('value');
        if (marker.val() !== today) {
            const cutoff = expiredBefore();

            // Keys are ISO dates, so lexical ordering is chronological -- endBefore
            // gives exactly the expired days without reading the live ones.
            const stale = await ref.child('devices').orderByKey().endBefore(cutoff).once('value');

            const updates = { devicesSweptOn: today };
            stale.forEach((child) => { updates[`devices/${child.key}`] = null; });

            const aggStale = await ref.child('aggregatorHits').orderByKey().endBefore(cutoff).once('value');
            aggStale.forEach((child) => { updates[`aggregatorHits/${child.key}`] = null; });

            await ref.update(updates);
        }
        sweptIds.add(id);
    } catch (err) {
        console.error(`Device bucket sweep failed for ${id}:`, err);
    }
}

// The scheduled sweep reads calendars in pages and stops after this many per run,
// resuming from a cursor the next day, so its cost stays flat as calendars grow.
const SWEEP_PAGE_SIZE = 200;
const SWEEP_MAX_PER_RUN = 2000;
const SWEEP_CURSOR_PATH = 'internal/device_sweep_cursor';

/**
 * Enforce the TTL for every calendar, including ones no longer polled -- the
 * opportunistic sweep only runs when a feed is requested, so a feed dropped by its
 * subscribers kept its last 35 days of buckets forever. Bounded per run; returns how
 * many calendars it examined and whether it reached the end.
 */
async function sweepAllDeviceBuckets({ pageSize = SWEEP_PAGE_SIZE, maxPerRun = SWEEP_MAX_PER_RUN } = {}) {
    const db = admin.database();
    const cutoff = expiredBefore();
    let cursor = (await db.ref(SWEEP_CURSOR_PATH).once('value')).val() || null;
    let examined = 0;
    let reachedEnd = false;

    while (examined < maxPerRun) {
        let query = db.ref(STATS_ROOT).orderByKey();
        if (cursor) query = query.startAfter(cursor);
        const limit = Math.min(pageSize, maxPerRun - examined);
        const page = await query.limitToFirst(limit).once('value');

        const updates = {};
        let count = 0;
        page.forEach((cal) => {
            count++;
            cursor = cal.key;
            // The page already holds each calendar's buckets, so expired days are found
            // without a second read per calendar.
            for (const field of ['devices', 'aggregatorHits']) {
                Object.keys(cal.child(field).val() || {}).forEach((dayKey) => {
                    if (dayKey < cutoff) updates[`${cal.key}/${field}/${dayKey}`] = null;
                });
            }
        });
        if (Object.keys(updates).length) await db.ref(STATS_ROOT).update(updates);
        examined += count;

        if (count < limit) { reachedEnd = true; break; }
    }

    // Wrap to the start once the end is reached, so every calendar is visited in turn.
    await db.ref(SWEEP_CURSOR_PATH).set(reachedEnd ? null : cursor);
    return { examined, reachedEnd };
}

// Archived history (deleted calendars) is kept as long as the daily backups, then dropped.
// Without this the archive was the one store with no retention: deleting and recreating a
// calendar moved its whole log there each time, forever.
const HISTORY_ARCHIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

async function sweepHistoryArchive(db, now = Date.now(), limit = 500) {
    const expired = await db.ref(`/${HISTORY_ROOT}_archive_index`)
        .orderByKey().endAt(String(now - HISTORY_ARCHIVE_TTL_MS)).limitToFirst(limit).once('value');
    const update = {};
    expired.forEach(c => {
        const [at, ...rest] = c.key.split('_');
        const calendarId = rest.join('_');
        update[`/${HISTORY_ROOT}_archive/${calendarId}/${at}`] = null;
        update[`/${HISTORY_ROOT}_archive_index/${c.key}`] = null;
    });
    if (Object.keys(update).length) await db.ref().update(update);
    return Object.keys(update).length / 2;
}

exports.sweepHistoryArchive = onSchedule({ schedule: 'every day 03:41', timeZone: 'UTC' },
    () => sweepHistoryArchive(admin.database()));

exports.sweepDeviceBuckets = onSchedule({ schedule: 'every day 03:17', timeZone: 'UTC' }, async () => {
    const { examined, reachedEnd } = await sweepAllDeviceBuckets();
    console.log(`Device bucket sweep: examined=${examined} reachedEnd=${reachedEnd}`);
});

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
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ICSService = {
    // Line breaks are normalized to LF before escaping. A CR (bare, or the first half of a
    // pasted CRLF) would otherwise reach the feed raw, and a CR inside a content line ends
    // it early for strict parsers, truncating the text and garbling the next property.
    escapeText(text) {
        return String(text ?? '').replace(/\r\n?/g, '\n')
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\n/g, '\\n');
    },

    // RFC 5545 3.1: content lines longer than 75 octets are folded with CRLF + a space.
    // Counted in UTF-8 octets, not characters, and split only between code points --
    // cutting a multibyte character in half leaves invalid UTF-8 on both lines.
    foldLine(line) {
        if (Buffer.byteLength(line, 'utf8') <= 75) return line;
        const parts = [];
        let current = '', size = 0, limit = 75;
        for (const ch of line) {
            const n = Buffer.byteLength(ch, 'utf8');
            if (size + n > limit) {
                parts.push(current);
                // The leading space of a continuation line counts toward its 75 octets.
                current = ''; size = 0; limit = 74;
            }
            current += ch; size += n;
        }
        parts.push(current);
        return parts.join('\r\n ');
    },

    // Epoch ms for a stored date or an ICS stamp (20260921T170000Z or 20260921), or NaN.
    toMs(value) {
        if (value === null || value === undefined || value === '') return NaN;
        if (typeof value === 'string' && /^\d{8}T\d{6}Z$/.test(value)) {
            return Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
                `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
        }
        if (typeof value === 'string' && /^\d{8}$/.test(value)) {
            return Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8));
        }
        const d = value instanceof Date ? value : new Date(value);
        return d.getTime();
    },

    // Normalize a stored date into ICS basic format (YYYYMMDDTHHMMSSZ), or null if the
    // value isn't a usable date. Values reach us as ISO strings, but Date objects and epoch
    // numbers have both appeared in stored data, so accept anything Date can parse and
    // reject the rest rather than throwing.
    formatDateTime(dateTime) {
        if (dateTime === null || dateTime === undefined || dateTime === '') return null;

        // Always normalize through Date rather than string-editing the input. The old fast
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
    //
    // The app stores an all-day date as the user's LOCAL midnight converted to UTC, so
    // Sep 7 in Berlin arrives as 2026-09-06T22:00:00Z, and taking its UTC date moved every
    // all-day event a day early east of UTC. The server never learns the user's zone, but
    // local midnight falls in a known window around UTC midnight, so we take the date that
    // window points at. Populated offsets span 25 hours (UTC-11 to UTC+14) and a day holds
    // 24, so one end must give: the window runs from just east of UTC-11 through UTC+13,
    // covering New Zealand summer time, Samoa and Tonga at the cost of American Samoa and
    // Niue (UTC-11) and Kiribati's Line Islands (UTC+14), which have far fewer people.
    formatDate(dateTime) {
        const ms = this.toMs(dateTime);
        if (isNaN(ms)) return null;
        // The extra second reads nativecal's inclusive all-day end (local 23:59:59.999 of
        // the last day) as the next date even at UTC+13. Must match Event.allDayDateUTC.
        const d = new Date(Math.floor((ms + 13 * HOUR_MS + 1000) / DAY_MS) * DAY_MS);
        if (isNaN(d.getTime())) return null;
        const out = d.toISOString().slice(0, 10).replace(/-/g, '');
        return /^\d{8}$/.test(out) ? out : null;
    },

    // An event is only renderable if BOTH endpoints normalize to a real date. A truthiness
    // check is not enough: a Date object, an epoch number, or `{}` are all truthy but blow
    // up (or silently corrupt) downstream. Events missing dates entirely were written by
    // past client bugs; one such record used to throw in formatDateTime and take down the
    // whole feed, so unusable events are skipped individually instead. An end at or before
    // the start is repaired in createEventBlock rather than skipped: the event is real.
    isRenderable(event) {
        if (!event) return false;
        return this.formatDateTime(event.start) !== null
            && this.formatDateTime(event.end) !== null;
    },

    // Normalize one stored exception date to the iCalendar form. The app writes them as
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

    // What a series' own expansion produces: DATE instances for an all-day series, and
    // otherwise DATE-TIMEs that all share DTSTART's UTC time of day.
    seriesShape(event) {
        return { allDay: !!event.isAllDay, anchorMs: this.toMs(event.start) };
    },

    // Rewrite one exception stamp as the instance of `shape` it refers to, so EXDATE and
    // RECURRENCE-ID actually match something. The RRULE expands from a UTC DTSTART, so
    // every instance keeps the same UTC time of day -- but the app records an exception at
    // the occurrence's LOCAL wall-clock time, which after a DST change is an hour off from
    // the expanded instance. Unmatched, a deleted occurrence stays and a moved one shows up
    // twice. So snap to the nearest instance time (always within 12h); a series without a
    // usable anchor is left as recorded.
    seriesSlot(stamp, shape) {
        let ms = this.toMs(stamp);
        if (isNaN(ms)) return null;
        if (shape.allDay) return this.formatDate(ms);
        if (!isNaN(shape.anchorMs)) {
            const timeOfDay = ((shape.anchorMs % DAY_MS) + DAY_MS) % DAY_MS;
            const sameDay = Math.floor(ms / DAY_MS) * DAY_MS + timeOfDay;
            const nearest = [sameDay - DAY_MS, sameDay, sameDay + DAY_MS]
                .reduce((a, b) => (Math.abs(b - ms) < Math.abs(a - ms) ? b : a));
            if (Math.abs(nearest - ms) < 12 * HOUR_MS) ms = nearest;
        }
        return this.formatDateTime(new Date(ms));
    },

    // UNTIL must share DTSTART's value type (RFC 5545 3.3.10). The app writes a DATE-TIME
    // UNTIL even for all-day series, which strict clients reject, so convert it the same
    // way the all-day DTSTART is converted.
    seriesRule(rule, allDay) {
        if (!allDay) return rule;
        return rule.replace(/(^|;)UNTIL=(\d{8}T\d{6}Z?)/i, (match, sep, value) => {
            const date = this.allDayStampDate(value);
            return date ? `${sep}UNTIL=${date}` : match;
        });
    },

    // The DATE an all-day series' stamp names. A floating stamp (no Z) is a wall-clock
    // time, so its Y-M-D is the date: nativecal's editor writes UNTIL=20261025T235959 for
    // "through Oct 25", which the instant window read as Oct 26. Must match
    // Event.allDayStampDate in public/models/Event.js.
    allDayStampDate(value) {
        if (/^\d{8}T\d{6}$/i.test(value)) return value.slice(0, 8);
        return this.formatDate(/Z$/i.test(value) ? value : `${value}Z`);
    },

    // Best guess at which instance a moved occurrence replaces, from the event alone. Only
    // used when createEventBlock is called outside a feed; generateICS assigns slots across
    // a whole series (assignOccurrences) so that no two occurrences claim the same one.
    occurrenceOriginal(event) {
        const candidates = this.exceptionDates(event);
        if (!candidates.length) return null;
        if (candidates.length === 1) return candidates[0];

        const startMs = this.toMs(event.start);
        if (isNaN(startMs)) return candidates[0];

        let best = candidates[0], bestDelta = Infinity;
        for (const c of candidates) {
            const ms = this.toMs(c);
            if (isNaN(ms)) continue;
            const delta = Math.abs(ms - startMs);
            if (delta < bestDelta) { bestDelta = delta; best = c; }
        }
        return best;
    },

    // Which instance each moved occurrence replaces, one-to-one within each series. Returns
    // Map(child event -> { slot, allDay }); a child left out becomes a standalone event.
    //
    // A child records its original slot only in recurrenceException. Syncfusion's
    // EditOccurrence writes exactly one stamp there (the occurrence's own start), but
    // records saved through other paths carry the parent's accumulated list, so a child
    // with several candidates is ambiguous. Choosing each child's nearest candidate on its
    // own let two children claim one slot (9/21 -> 9/26 and 9/28 -> 9/23 both chose 9/21),
    // and a duplicate (UID, RECURRENCE-ID) makes clients drop one of the meetings. So
    // unambiguous children claim their slot first, then the remaining (child, slot) pairs
    // are taken greedily by distance, each slot used at most once.
    assignOccurrences(events) {
        const seriesById = new Map();
        const childrenOf = new Map();
        for (const event of events) {
            if (event.recurrenceID) {
                if (!childrenOf.has(event.recurrenceID)) childrenOf.set(event.recurrenceID, []);
                childrenOf.get(event.recurrenceID).push(event);
            } else if (event.recurrencerule) {
                seriesById.set(event.id, event);
            }
        }

        const assigned = new Map();
        for (const [seriesId, children] of childrenOf) {
            // RECURRENCE-ID takes the PARENT's value type and instance grid; the child's own
            // isAllDay or start time says nothing about the slot it came from.
            const parent = seriesById.get(seriesId);
            const parentShape = parent ? this.seriesShape(parent) : null;

            const pairs = [];
            children.forEach((child, index) => {
                const shape = parentShape || { allDay: !!child.isAllDay, anchorMs: NaN };
                const slots = [...new Set(this.exceptionDates(child)
                    .map(stamp => this.seriesSlot(stamp, shape))
                    .filter(Boolean))];
                const startMs = this.toMs(child.start);
                for (const slot of slots) {
                    const distance = Math.abs(this.toMs(slot) - startMs);
                    pairs.push({ child, index, slot, allDay: shape.allDay,
                        ambiguous: slots.length > 1 ? 1 : 0,
                        distance: isNaN(distance) ? Infinity : distance });
                }
            });
            pairs.sort((a, b) => a.ambiguous - b.ambiguous
                || a.distance - b.distance || a.index - b.index);

            const usedSlots = new Set();
            for (const pair of pairs) {
                if (assigned.has(pair.child) || usedSlots.has(pair.slot)) continue;
                assigned.set(pair.child, { slot: pair.slot, allDay: pair.allDay });
                usedSlots.add(pair.slot);
            }
        }
        return assigned;
    },

    // `occurrence` is the slot generateICS assigned this event ({ slot, allDay }), or null
    // if it assigned none. Left undefined (a block built outside a feed), the event's own
    // best guess is used.
    createEventBlock(event, dtstamp, overriddenSlots, occurrence) {
        // An edited occurrence is stored as its own record pointing at its parent through
        // recurrenceID, and it inherits the parent's RecurrenceRule in the process. Emitting
        // that rule would turn one moved occurrence into a second full series.
        //
        // Sharing the parent's UID is only valid when RECURRENCE-ID identifies which
        // instance this replaces. Without one, two VEVENTs share a UID and a client treats
        // the second as a redefinition of the series -- collapsing every other occurrence.
        // So a child with no usable exception date falls back to being a standalone event.
        if (occurrence === undefined && event.recurrenceID) {
            const stamp = this.occurrenceOriginal(event);
            const shape = { allDay: !!event.isAllDay, anchorMs: NaN };
            const slot = stamp ? this.seriesSlot(stamp, shape) : null;
            occurrence = slot ? { slot, allDay: shape.allDay } : null;
        }
        const isOccurrence = !!event.recurrenceID && !!occurrence;

        const allDay = !!event.isAllDay;
        const start = allDay ? this.formatDate(event.start) : this.formatDateTime(event.start);
        let end = allDay ? this.formatDate(event.end) : this.formatDateTime(event.end);
        const dateParam = allDay ? ";VALUE=DATE" : "";

        // An end before the start makes a negative-length event that strict clients reject,
        // and a clamped all-day DTEND equal to DTSTART spans no day at all. So an all-day
        // event lasts at least its own day, and a timed one becomes a zero-length event at
        // its start: DTEND equal to DTSTART is the form clients broadly accept for that (an
        // omitted DTEND is valid too, but Outlook reads it unpredictably).
        if (allDay && (!end || end <= start)) {
            end = this.formatDate(this.toMs(start) + DAY_MS);
        } else if (!allDay && this.toMs(end) < this.toMs(start)) {
            end = start;
        }

        // Syncfusion gives a moved occurrence the same id as its series, so a child that
        // falls back to standalone needs a UID of its own, or it redefines the series.
        let uid = event.id;
        if (isOccurrence) uid = event.recurrenceID;
        else if (event.recurrenceID && event.id === event.recurrenceID) uid = `${event.id}-${start}`;

        const eventLines = [
            "BEGIN:VEVENT",
            `UID:${uid}`,
            `DTSTAMP:${dtstamp}`,
            `DTSTART${dateParam}:${start}`,
            `DTEND${dateParam}:${end}`,
            `SUMMARY:${this.escapeText(event.title)}`,
            `DESCRIPTION:${this.escapeText(event.description)}`
        ];

        if (isOccurrence) {
            eventLines.push(`RECURRENCE-ID${occurrence.allDay ? ";VALUE=DATE" : ""}:${occurrence.slot}`);
        } else if (event.recurrencerule && !event.recurrenceID) {
            eventLines.push(`RRULE:${this.seriesRule(event.recurrencerule, allDay)}`);

            // Without EXDATE, an occurrence the user deleted in the app is still generated
            // by the rule, so every subscriber keeps seeing a meeting that was canceled.
            // Slots that a moved occurrence overrides are excluded from this list: those
            // instances are replaced, not removed, and EXDATE'ing one deletes the slot its
            // override was meant to fill. Each date must also take DTSTART's value type and
            // land on a real instance, or it matches nothing and is silently ignored.
            const shape = this.seriesShape(event);
            const exdates = [...new Set(this.exceptionDates(event)
                .map(stamp => this.seriesSlot(stamp, shape))
                .filter(slot => slot && !(overriddenSlots && overriddenSlots.has(slot))))];
            if (exdates.length) eventLines.push(`EXDATE${dateParam}:${exdates.join(",")}`);
        }

        eventLines.push("END:VEVENT");
        return eventLines.map(line => this.foldLine(line)).join("\r\n");
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
        const occurrences = this.assignOccurrences(renderable);
        const overridden = new Map();
        for (const [event, { slot }] of occurrences) {
            if (!overridden.has(event.recurrenceID)) overridden.set(event.recurrenceID, new Set());
            overridden.get(event.recurrenceID).add(slot);
        }

        const events = renderable.map(event => this.createEventBlock(event, dtstamp,
            event.recurrenceID ? null : overridden.get(event.id),
            event.recurrenceID ? (occurrences.get(event) || null) : undefined));

        // Without X-WR-CALNAME a subscription shows up in the user's calendar list
        // as the raw feed URL, or as "Untitled" -- so a shared roster is unlabelled
        // in the one place the subscriber actually looks. Fall back to the id
        // rather than emitting an empty name, which some clients render as blank.
        const name = this.escapeText(calendarData?.title || id);

        // REFRESH-INTERVAL is the RFC 7986 hint; X-PUBLISHED-TTL is the older
        // Microsoft equivalent that Outlook still honors. Clients that read
        // neither pick their own interval, and some default to once a day, which
        // makes a shared calendar feel broken when an edit doesn't show up.
        const header = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            `PRODID:-//PasteCal//${id}//EN`,
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            `X-WR-CALNAME:${name}`,
            `NAME:${name}`,
            "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
            "X-PUBLISHED-TTL:PT1H"
        ].map(line => this.foldLine(line));
        // Event blocks arrive already folded.
        return [...header, ...events, "END:VCALENDAR"].join("\r\n");
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

    /**
     * Whether a calendar holds anything its owner would miss: events, a title of their own,
     * or notes. A calendar used purely for notes is as much someone's as one full of events.
     * Reads at most one event, not the list -- this runs on every create of a case-twin.
     */
    async holdsData(db, actualSlug) {
        const root = db.ref(`/${DEFAULT_ROOT}/${actualSlug}`);
        const [events, title, notes] = await Promise.all([
            root.child('events').limitToFirst(1).once('value'),
            root.child('title').once('value'),
            root.child('options/notes').once('value'),
        ]);
        const t = title.val();
        return events.hasChildren()
            || (typeof t === 'string' && t.trim() !== '' && t !== 'New Calendar')
            || (typeof notes.val() === 'string' && notes.val().trim() !== '');
    },

    normalizeSlug(slug) {
        // Convert to lowercase for consistent storage and lookup
        return slug.toLowerCase();
    },

    // Free means nothing resolves to it: no view, no binding, and no mapping to an editable
    // calendar -- otherwise a view could be created at a name that already opens someone's
    // calendar, and one of the two would become unreachable.
    async isSlugAvailable(slug) {
        const normalizedSlug = this.normalizeSlug(slug);
        const db = admin.database();
        const [view, binding, mapping] = await Promise.all([
            db.ref(READONLY_ROOT).child(normalizedSlug).child('id').once('value'),
            db.ref(`/public_views/${normalizedSlug}`).once('value'),
            db.ref(`/slug_mappings/${normalizedSlug}`).once('value'),
        ]);
        const m = mapping.val();
        return !view.exists() && !binding.exists() && !(m && !m.notFound);
    },


    // A not-found result is cached for this long, then re-checked with a real lookup. Short
    // relative to how long a slug stays unclaimed, but long enough that a burst of requests
    // for the same dead/expired/guessed slug (the case that motivated this cache) only pays
    // for one full scan instead of one per request.
    NOT_FOUND_CACHE_MS: 10 * 60 * 1000,

    // Characters that are path syntax or illegal in an RTDB key. A slug containing `/` used
    // to be read as a path: "/" read the entire index, and "foo/x" wrote a negative-cache
    // entry under slug_mappings/foo that made `foo` look taken forever.
    isLookupable(slug) {
        return typeof slug === 'string' && slug.length > 0 && slug.length <= 100
            && !/[\/.#$\[\]\x00-\x1f\x7f]/.test(slug);
    },

    async lookupCalendar(requestedSlug) {
        if (!this.isLookupable(requestedSlug)) return { found: false };
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
        //
        // No negative-cache write any more. It existed because a miss used to cost a full
        // scan; with the index a miss is two tiny reads, and caching it wrote one permanent
        // row per guessed slug -- unbounded growth from an unauthenticated callable -- and
        // could overwrite a mapping indexSlug wrote meanwhile. Entries already cached still
        // expire through the branch above.
        return { found: false };
    }
};

// Read-only views
//
// /calendars_readonly/<publicViewId> is world-readable, so what goes into it is published.
// It used to be a verbatim copy of the calendar, `id` included -- and `id` IS the editable
// slug, so anyone holding a view-only link could read it and get full edit access. The
// mirror is now built from a whitelist and carries the view's own id.
//
// Which calendar may write a view is recorded in /public_views/<publicViewId>, a node only
// the Admin SDK can write. The calendar's own options.publicViewId cannot be the authority:
// anyone can write it, so pointing it at someone else's view used to make syncPublicView
// overwrite that view with the attacker's events.
const PublicViewService = {
    BINDINGS: '/public_views',                 // publicViewId -> calendarId
    BY_CALENDAR: '/public_views_by_calendar',  // calendarId -> { publicViewId: true }, for cleanup

    mirrorOf(cal, publicViewId) {
        // renamedFrom names the previous EDITABLE id, so it must never be published.
        const { renamedFrom, ...options } = cal.options || {};
        return {
            id: publicViewId,
            title: cal.title ?? '',
            events: cal.events ?? [],
            options: { ...options, publicViewId },
        };
    },

    /**
     * Whether calendarId may write the view. A view created before bindings existed is
     * claimed once, by the calendar its legacy mirror names in `id` -- the one place that
     * still records who made it. Everything else is refused.
     */
    async owns(db, calendarId, publicViewId, cal = null) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(publicViewId)) return false;
        const binding = db.ref(`${this.BINDINGS}/${publicViewId}`);
        const bound = (await binding.once('value')).val();
        if (bound === calendarId) return true;
        if (bound) return this.followRename(db, bound, calendarId, publicViewId, cal);
        const legacyOwner = (await db.ref(`/${READONLY_ROOT}/${publicViewId}/id`).once('value')).val();
        if (legacyOwner !== calendarId) return false;
        return this.claim(db, publicViewId, calendarId);
    },

    /**
     * Renaming copies a calendar to a new id, options.publicViewId included, so the view
     * has to follow the copy or its link and ICS feed freeze. The copy proves it came from
     * the bound calendar by naming it in options.renamedFrom -- an id only someone with edit
     * access to that calendar knows, now that views no longer publish it -- and the source
     * must still point at this view.
     */
    async followRename(db, bound, calendarId, publicViewId, cal) {
        if (!cal || !cal.options || cal.options.renamedFrom !== bound) return false;
        const source = (await db.ref(`/${DEFAULT_ROOT}/${bound}/options/publicViewId`).once('value')).val();
        if (source !== publicViewId) return false;
        const r = await updateExisting(db.ref(`${this.BINDINGS}/${publicViewId}`),
            cur => cur === bound ? calendarId : undefined);
        if (!r.committed) return false;
        await db.ref().update({
            [`${this.BY_CALENDAR}/${bound}/${publicViewId}`]: null,
            [`${this.BY_CALENDAR}/${calendarId}/${publicViewId}`]: true,
        });
        return true;
    },

    /** Atomically bind a view id to a calendar; false if another calendar holds it. */
    async claim(db, publicViewId, calendarId) {
        const r = await db.ref(`${this.BINDINGS}/${publicViewId}`)
            .transaction(cur => cur === null ? calendarId : undefined);
        if (!r.committed && r.snapshot.val() !== calendarId) return false;
        await db.ref(`${this.BY_CALENDAR}/${calendarId}/${publicViewId}`).set(true);
        return true;
    },
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

    // Lowercase only: views resolve case-insensitively through /slug_mappings, so mixed case
    // added no real entropy and let a new id collide with an existing one differing in case.
    // Ten characters (36^10) where five (effectively 36^5, ~6e7) was enumerable.
    generatePublicViewId(length = 10) {
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const out = [];
        while (out.length < length) {
            for (const b of crypto.getRandomValues(new Uint8Array(length))) {
                if (b < 252 && out.length < length) out.push(alphabet[b % 36]);  // no modulo bias
            }
        }
        return out.join('');
    },

    async generateUniquePublicId(attempts = 5) {
        for (let i = 0; i < attempts; i++) {
            const publicViewId = this.generatePublicViewId();
            if (await SlugService.isSlugAvailable(publicViewId)) return publicViewId;
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
// own destructive write from being recorded, or write to /history directly.
//
// What it does NOT guarantee: a hostile client can still push old entries out by making
// many recordable writes, because retention is bounded. Destructive entries younger than
// HISTORY_PROTECT_MS are kept up to HISTORY_HARD_CAP, which makes that a sustained effort
// rather than a 20-write script; past that, the daily backup (docs/backups.md) is the floor.
//
// Every entry is a DELTA -- the events it removed, the before/after of the ones it changed,
// the ones it added -- so the client can undo exactly that change without rolling the
// whole calendar back over everything done since. Writes that lost something also carry
// the full prior snapshot (`events`) for the operator's restore script. Additions carry no
// snapshot: nothing was lost, and a full copy per add is what let a burst of adds evict
// the snapshot that mattered.
// ---------------------------------------------------------------------------------------
/**
 * Transform a value that should already exist, atomically. A transaction's first pass runs
 * on the local cache, which is empty in a function, so `cur` is null there even when the
 * server holds a value; returning undefined then ABORTS instead of retrying on the real
 * value. That mistake was made three separate times, so it lives here once: a null pass
 * returns null (the server retries with its value if there is one), and `fn` returning
 * undefined aborts deliberately.
 */
function updateExisting(ref, fn) {
    return ref.transaction(cur => cur === null ? null : fn(cur));
}

const HISTORY_ROOT = "history";
const HISTORY_KEEP = 20;                         // destructive entries always kept, per calendar
const HISTORY_ADDED_KEEP = 20;                   // `added` entries kept, budgeted separately
const HISTORY_PROTECT_MS = 24 * 60 * 60 * 1000;  // destructive entries this young survive trimming...
const HISTORY_HARD_CAP = 100;                    // ...up to this many
const HISTORY_COALESCE_MS = 60 * 1000;           // a drag is one gesture, not one entry per save

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

    // The events this write removed, changed and added. Pure.
    diff(before, after) {
        const b = this.eventsOf(before), a = this.eventsOf(after);
        const beforeByKey = new Map(b.map(e => [this.key(e), e]));
        const afterByKey = new Map(a.map(e => [this.key(e), e]));
        const removed = [], changed = [];
        for (const e of b) {
            const x = afterByKey.get(this.key(e));
            if (!x) removed.push(e);
            else if (!this.sameEvent(x, e)) changed.push({ from: e, to: x });
        }
        const added = a.filter(e => !beforeByKey.has(this.key(e)));
        return { removed, changed, added };
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

        const d = this.diff(before, after);
        const removed = d.removed.length, changed = d.changed.length, added = d.added.length;

        const titleLost = !!before.title && !after.title;
        if (!removed && !changed && !added && !titleLost) return null;

        const kind = (b.length > 0 && removed === b.length) ? 'wiped'
            : removed ? 'shrunk'
                : changed ? 'edited'
                    : added ? 'added' : 'title-cleared';
        return { kind, removed, changed, added };
    },

    // Options minus the keys the app writes on its own. A visitor opening a legacy
    // calendar makes the client mint options.publicViewId; that is housekeeping, not
    // someone editing the calendar, and must not read as "Edited just now".
    userOptions(cal) {
        const o = (cal && cal.options) || {};
        const { publicViewId, ...rest } = o;
        return JSON.stringify(rest);
    },

    /**
     * Stamp when the calendar last changed at all -- including pure additions.
     *
     * One number per calendar, overwritten in place, so it costs nothing to keep current.
     * The client watches it directly, so the "Edited N ago" label needs no /history read.
     */
    async stampLastEdit(db, calendarId, before, after, at = Date.now()) {
        if (!after) return null;                       // deletion: nothing left to stamp
        const b = this.eventsOf(before), a = this.eventsOf(after);
        const changed = !before
            || b.length !== a.length
            || (before.title ?? '') !== (after.title ?? '')
            || this.userOptions(before) !== this.userOptions(after)
            || a.some((e, i) => !this.sameEvent(e, b[i] ?? {}));
        if (!changed) return null;
        // The write's own time, and only forward: triggers arrive out of order.
        return db.ref(`/${HISTORY_ROOT}_meta/${calendarId}/lastEditedAt`)
            .transaction(cur => (cur === null || cur < at) ? at : undefined);
    },

    /**
     * A deleted calendar's history leaves /history with it, into an archive only the Admin
     * SDK can read. Otherwise whoever next creates a calendar at the same slug would see the
     * old owner's events in Recent changes, with Restore buttons. Kept, not dropped: "I
     * deleted my calendar by mistake" is what the operator restore exists for.
     *
     * Done here, at deletion, and in ONE multi-path update. Archiving on re-creation instead
     * lost to trigger ordering -- Firebase does not deliver triggers in order, so a delayed
     * delete could push its full snapshot into the newcomer's history after the archive ran.
     * Only entries up to the deletion move, so a newcomer's own entries are never swept up.
     */
    async archiveOnDelete(db, calendarId, before, at) {
        const batch = `/${HISTORY_ROOT}_archive/${calendarId}/${at}`;
        // Late writes from before this deletion follow it into the archive (see record).
        await db.ref(`/${HISTORY_ROOT}_deleted/${calendarId}`)
            .transaction(cur => (cur === null || cur < at) ? at : undefined);
        // Time-ordered, so the retention sweep finds expired batches without reading them.
        await db.ref(`/${HISTORY_ROOT}_archive_index/${at}_${calendarId}`).set(true);
        const removed = this.eventsOf(before);
        await db.ref(`${batch}/${db.ref().push().key}`).set({
            savedAt: at, kind: 'deleted', removed: removed.length, changed: 0, added: 0,
            removedEvents: removed, changedEvents: [], addedEvents: [],
            eventCount: removed.length, title: before.title ?? null, options: before.options ?? null,
            events: removed,
        });

        // One entry at a time, chosen from the index: a single read of the whole log could
        // hold a hundred calendar-sized snapshots in memory and fail, leaving the log where
        // a newcomer at this slug would read it. Each move is one multi-path update, so an
        // entry is always in exactly one place.
        const index = await this.loadIndex(db, calendarId);
        for (const row of index) {
            if ((row.s ?? row.t) > at) continue;             // a newcomer's own entry
            const entry = (await db.ref(`/${HISTORY_ROOT}/${calendarId}/${row.key}`).once('value')).val();
            await db.ref().update({
                [`${batch}/${row.key}`]: entry,
                [`/${HISTORY_ROOT}/${calendarId}/${row.key}`]: null,
                [`/${HISTORY_ROOT}_index/${calendarId}/${row.key}`]: null,
            });
        }
        const meta = await db.ref(`/${HISTORY_ROOT}_meta/${calendarId}/lastEditedAt`).once('value');
        if ((meta.val() || 0) <= at) await db.ref(`/${HISTORY_ROOT}_meta/${calendarId}`).remove();
        return batch;
    },

    restorable(kind) { return kind !== 'added'; },

    // `at` is when the write happened (the trigger's event time), not when this invocation
    // runs: triggers arrive late and out of order, and ordering decisions must use the former.
    async record(db, calendarId, before, after, at = Date.now()) {
        if (!before) return null;                                   // brand-new calendar
        if (!after) return this.archiveOnDelete(db, calendarId, before, at);
        const why = this.changeKind(before, after);
        if (!why) return null;

        // History belongs to an incarnation of the calendar, not to its slug. A write made
        // before the calendar was deleted can reach this trigger after the deletion was
        // archived; it belongs with that archive, never in the /history a newcomer at the
        // same slug reads.
        const deletedAt = (await db.ref(`/${HISTORY_ROOT}_deleted/${calendarId}`).once('value')).val();
        const toArchive = typeof deletedAt === 'number' && at <= deletedAt;

        const d = this.diff(before, after);
        const ref = db.ref(`/${HISTORY_ROOT}/${calendarId}`);
        const indexRef = db.ref(`/${HISTORY_ROOT}_index/${calendarId}`);
        const index = await this.loadIndex(db, calendarId);
        const now = at;
        const changedKeys = d.changed.map(c => this.key(c.from)).sort().join(',');

        // Which browser made this write (CalendarDataService stamps `_writer`). Only that
        // browser's later saves may fold into its entry, and its Cmd+Z only undoes its own.
        const writer = typeof after._writer === 'string' ? after._writer.slice(0, 64) : null;
        // What the client says this write is: one save of a drag/resize gesture, or an undo
        // of named entries. Identities, so neither has to be guessed from timing later.
        const gesture = typeof after._gesture === 'string' ? after._gesture.slice(0, 64) : null;
        const undoOf = Array.isArray(after._undoOf)
            ? after._undoOf.filter(k => typeof k === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(k)).slice(0, 50)
            : [];

        // A drag or resize saves every 500ms, and each save is an edit of the same events.
        // Fold it into the entry the gesture started: that entry's `from` is the state
        // before the gesture, which is what undo should return to; only `to` moves on.
        //
        // Only a pure edit, by the same writer: folding a collaborator's move into my drag
        // made "undo" revert their work, and folding a write that also ADDED rows (an
        // occurrence edit adds an exception row) dropped those rows from history.
        // The window runs from the gesture's START, so one entry cannot absorb edits forever.
        // `to` is replaced in a transaction and only by a LATER write, so saves processed out
        // of order cannot leave it at an intermediate position.
        const newest = index.sort((x, y) => y.t - x.t)[0];
        // Same gesture when the client names one; the time window remains only for clients
        // that predate gesture ids, so two separate drags are never folded into one entry.
        const sameGesture = gesture
            ? newest && newest.g === gesture
            : newest && !newest.g && now - (newest.s ?? newest.t) < HISTORY_COALESCE_MS;
        if (!toArchive && why.kind === 'edited' && !why.added && !undoOf.length && writer && newest
            && newest.k === 'edited' && newest.w === writer && newest.ck === changedKeys && sameGesture) {
            const folded = await this.fold(db, calendarId, newest, d, now);
            if (folded !== undefined) return folded;
            // The entry vanished under us (a concurrent save returned the gesture to its
            // start and removed it): record this write on its own instead of losing it.
        }

        const entry = {
            savedAt: now,
            kind: why.kind,
            removed: why.removed,
            changed: why.changed,
            added: why.added || 0,
            removedEvents: d.removed,
            changedEvents: d.changed.map(c => ({ ...c, at: now })),
            addedEvents: d.added,
            eventCount: this.eventsOf(before).length,
            title: before.title ?? null,
            options: before.options ?? null,
            writer,
            ...(gesture ? { gesture } : {}),
            ...(undoOf.length ? { undoOf } : {}),
        };
        // The full prior state, for the operator's restore -- only where the delta does not
        // already hold it. A wipe's removedEvents IS the prior state, and an edit's `from`
        // values are what restoring it needs, so storing `events` too made each entry two or
        // three copies of the calendar; with up to HISTORY_HARD_CAP entries a day, that let
        // one writer multiply a calendar's storage a few hundredfold.
        //
        // At most one full checkpoint per calendar per day: the delta already reverses a
        // shrink, and a snapshot on every shrink let one-event remove/re-add loops turn a
        // 1MB calendar into 20MB of history.
        const lastCheckpoint = Math.max(0, ...index.filter(r => r.cp).map(r => r.t || 0));
        const checkpoint = (why.kind === 'shrunk' || why.kind === 'title-cleared')
            && now - lastCheckpoint >= HISTORY_PROTECT_MS;
        if (checkpoint) entry.events = this.eventsOf(before);

        if (toArchive) {
            await db.ref(`/${HISTORY_ROOT}_archive/${calendarId}/${deletedAt}/${db.ref().push().key}`).set(entry);
            return null;
        }

        const pushed = await ref.push(entry);
        const row = { k: why.kind, t: now, s: now, ck: changedKeys,
            ...(writer ? { w: writer } : {}), ...(gesture ? { g: gesture } : {}), ...(checkpoint ? { cp: 1 } : {}) };
        index.push({ key: pushed.key, ...row });
        await indexRef.child(pushed.key).set(row);
        await this.trim(db, calendarId, index, now);
        return pushed.key;
    },

    /**
     * Fold one more save of a gesture into its entry. Returns the entry key, null when the
     * gesture ended where it began (the entry is removed), or undefined when the entry no
     * longer exists and the caller should record the write on its own.
     */
    async fold(db, calendarId, newest, d, now) {
        const ref = db.ref(`/${HISTORY_ROOT}/${calendarId}/${newest.key}`);
        const indexRef = db.ref(`/${HISTORY_ROOT}_index/${calendarId}/${newest.key}`);
        const toByKey = new Map(d.changed.map(c => [this.key(c.to), c.to]));
        const r = await updateExisting(ref.child('changedEvents'), cur => {
            if (!Array.isArray(cur)) return undefined;
            return cur.map(c => {
                const next = toByKey.get(this.key(c.from));
                return next && (c.at ?? 0) <= now ? { ...c, to: next, at: now } : c;
            });
        });
        const merged = r.snapshot.val();
        if (!Array.isArray(merged) || !merged.length) {
            // Gone. Drop the index row too, or a row with no kind would count as a
            // destructive entry in toTrim forever.
            await indexRef.remove();
            return undefined;
        }
        // Back where the gesture started -- a drag returned to its origin, or an undo of
        // this very edit. A row reading "1 event edited" whose undo does nothing is noise.
        if (merged.every(c => this.sameEvent(c.from, c.to))) {
            await Promise.all([ref.remove(), indexRef.remove()]);
            return null;
        }
        // Only touch an index row that still exists: update() on a removed one would
        // recreate it without a kind.
        await updateExisting(indexRef, cur => ({ ...cur, t: Math.max(cur.t || 0, now) }));
        return newest.key;
    },

    /**
     * The index is a few bytes per entry, so trimming never downloads the snapshots it is
     * deciding about. Entries written before the index existed are folded in once, on the
     * first write that finds the index missing.
     */
    async loadIndex(db, calendarId) {
        const indexRef = db.ref(`/${HISTORY_ROOT}_index/${calendarId}`);
        const snap = await indexRef.once('value');
        const out = [];
        snap.forEach(c => { out.push({ key: c.key, ...c.val() }); });
        if (out.length) return out;

        const legacy = await db.ref(`/${HISTORY_ROOT}/${calendarId}`).once('value');
        if (!legacy.exists()) return out;
        const fill = {};
        legacy.forEach(c => {
            const v = c.val() || {};
            const row = { k: v.kind || 'edited', t: v.savedAt || 0, ck: '' };
            fill[c.key] = row;
            out.push({ key: c.key, ...row });
        });
        await indexRef.update(fill);
        return out;
    },

    // Which entries to delete. Pure.
    //   - `added` entries: the newest HISTORY_ADDED_KEEP. They never cost a destructive slot.
    //   - destructive entries: the newest HISTORY_KEEP, plus any younger than
    //     HISTORY_PROTECT_MS, up to HISTORY_HARD_CAP in all.
    toTrim(index, now) {
        const newestFirst = [...index].filter(e => e.k).sort((x, y) => y.t - x.t);
        const adds = newestFirst.filter(e => !this.restorable(e.k));
        const destructive = newestFirst.filter(e => this.restorable(e.k));
        const drop = adds.slice(HISTORY_ADDED_KEEP);
        destructive.forEach((e, i) => {
            const keep = i < HISTORY_KEEP || (i < HISTORY_HARD_CAP && now - e.t < HISTORY_PROTECT_MS);
            if (!keep) drop.push(e);
        });
        return drop.map(e => e.key);
    },

    async trim(db, calendarId, index, now) {
        const drop = this.toTrim(index, now);
        if (!drop.length) return;
        const del = {}, delIndex = {};
        for (const k of drop) { del[k] = null; delIndex[k] = null; }
        await db.ref(`/${HISTORY_ROOT}/${calendarId}`).update(del);
        await db.ref(`/${HISTORY_ROOT}_index/${calendarId}`).update(delIndex);
    },
};

// ETag for a generated feed: a hash of the body, minus the DTSTAMP values. DTSTAMP
// is "when this copy was generated" (a fresh timestamp per request), so hashing it
// would make every response unique and no poller would ever get a 304. Everything
// else in the body is a function of the calendar, so if it changed, subscribers
// must get it.
function icsEtag(icsBody) {
    const stable = String(icsBody).replace(/^DTSTAMP:[^\r\n]*/gm, 'DTSTAMP:');
    return '"' + crypto.createHash('sha1').update(stable).digest('hex') + '"';
}

exports.generateICSV2 = onRequest({ cors: true }, async (req, res) => {
    try {
        const pathWithoutICS = req.path.replace(/[.]ICS.*/i, '');
        //console.log('Path without ICS:', pathWithoutICS);
        const { rawSlug, isReadOnly: wantsView } = CalendarService.parseCalendarPath(pathWithoutICS);

        // Calendars are stored under their original casing, but URLs (and the naive
        // lowercase in parseCalendarPath) may not match it — resolve via the same
        // case-insensitive lookup the web app uses, instead of reading the lowercased
        // key directly, which silently 404s or returns an unrelated calendar (#37).
        const lookup = await SlugService.lookupCalendar(rawSlug);
        if (!lookup.found) {
            throw new functions.https.HttpsError('not-found', 'Calendar not found');
        }
        // A /view/ URL only ever serves a read-only view. Resolving it to whatever the slug
        // maps to let an editable calendar written at a view's key feed its subscribers.
        if (wantsView && !lookup.isReadOnly) {
            throw new functions.https.HttpsError('not-found', 'Calendar not found');
        }
        const cleanId = lookup.actualSlug;
        const isReadOnly = lookup.isReadOnly;

        const { data: calendarData } = await CalendarService.getCalendarData(cleanId, isReadOnly);

        // The ETag lets calendar-app pollers 304 instead of re-downloading the full feed
        // every few minutes. It is a hash of the generated feed itself (see icsEtag),
        // the one source of truth for what subscribers get. It used to hash only the
        // events, so a change that reaches the feed without touching an event -- renaming
        // the calendar (X-WR-CALNAME), or any change to how the feed is rendered -- 304'd
        // forever and never reached a subscriber.
        const icsData = ICSService.generateICS(calendarData, cleanId);
        const etag = icsEtag(icsData);
        // The raw user-agent and IP are only ever passed to recordIcsStat, which hashes
        // them into a device bucket. Neither is stored or logged: a full UA carries OS
        // build numbers, which together with a calendar id is close to identifying.
        const userAgent = req.headers['user-agent'] || '';
        const clientIp = clientIpOf(req);
        const family = clientFamily(userAgent);

        // Stats are recorded after responding; see the comment on recordIcsStat.
        if (req.headers['if-none-match'] === etag) {
            console.log(`ICS 304: id=${cleanId} readonly=${isReadOnly} client=${family}`);
            res.set('ETag', etag).set('Cache-Control', 'public, max-age=300').status(304).end();
            await recordIcsStat(cleanId, { wasNotModified: true, userAgent, ip: clientIp });
            return;
        }

        console.log(`ICS served: id=${cleanId} readonly=${isReadOnly} bytes=${icsData.length} client=${family}`);
        res.set('Content-Type', 'text/calendar')
            .set('ETag', etag)
            .set('Cache-Control', 'public, max-age=300')
            .send(icsData);
        await recordIcsStat(cleanId, {
            bytes: icsData.length, wasNotModified: false, userAgent, ip: clientIp,
        });
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
    const { sourceCalendarId, customSlug } = request.data || {};
    // A calendar id, never a path. "atk/<view id>" used to plant a binding under
    // public_views_by_calendar/atk/<view id>, which removePublicView then read as one of
    // atk's views -- deleting someone else's view so its URL and feed could be re-claimed.
    if (typeof sourceCalendarId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sourceCalendarId)) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid calendar id.');
    }

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

        // Claimed atomically: the availability check above and this write used to be
        // separate, so two concurrent claims of one custom slug both passed and the second
        // overwrote the first's view.
        if (!await PublicViewService.claim(admin.database(), publicViewId, sourceCalendarId)) {
            throw new functions.https.HttpsError('already-exists', 'Slug is already taken. Please choose a different one.');
        }

        await Promise.all([
            sourceCalRef.child('options/publicViewId').set(publicViewId),
            admin.database().ref(`${READONLY_ROOT}/${publicViewId}`)
                .set(PublicViewService.mirrorOf(calendarData, publicViewId)),
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
    // Ownership belongs to whoever has the data -- events, a title, or notes -- not whoever
    // wrote last. An empty incumbent is still replaced, so a genuinely abandoned placeholder does not hold a
    // slug hostage. The delete branch above already reasons this way; this is the same
    // rule applied to creation.
    // One name, one owner. Editable calendars and read-only views share a URL namespace but
    // live in two key spaces, so a live view's mapping is never handed to an editable
    // calendar -- not even one written at the view's own key, which is exactly what an
    // attacker does to take over its URL and ICS feed (database.rules.json also refuses
    // creating such a calendar; this holds for any that predate the rule).
    if (current && current.isReadOnly && current.actualSlug
        && (await admin.database().ref(`/${READONLY_ROOT}/${current.actualSlug}/id`).once('value')).exists()) {
        console.log(`indexSlug: ${calendarId} not taking /${normalized} from live view ${current.actualSlug}`);
        return null;
    }
    if (current && current.actualSlug && current.actualSlug !== calendarId && !current.isReadOnly
        && await SlugService.holdsData(admin.database(), current.actualSlug)) {
        console.log(`indexSlug: ${calendarId} not taking /${normalized} from ${current.actualSlug}, which holds data`);
        return null;
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

// onValueWritten, not onValueUpdated: a rename creates the copy as a NEW node, and the view
// has to move to it at once -- otherwise it stays bound to the old id until the copy's first
// edit, and deleting the old calendar in that window deletes the view.
exports.syncPublicView = onValueWritten(`/${DEFAULT_ROOT}/{calendarId}`, async (event) => {
    const afterData = event.data.after.val();
    const publicViewId = afterData && afterData.options?.publicViewId;
    if (!publicViewId) return null;

    const db = admin.database();
    if (!await PublicViewService.owns(db, event.params.calendarId, publicViewId, afterData)) {
        console.warn(`syncPublicView: ${event.params.calendarId} does not own view ${publicViewId}; not syncing`);
        return null;
    }
    // set(), not update(): update() only replaces keys present in the payload, and RTDB
    // drops empty arrays, so deleting every event left them all live on the view and its
    // ICS feed indefinitely.
    return db.ref(`/${READONLY_ROOT}/${publicViewId}`).set(PublicViewService.mirrorOf(afterData, publicViewId));
});

// A deleted calendar's view would otherwise keep serving its last state forever. Scoped to
// /id for the same payload reason as indexSlug; the binding names the view to remove.
exports.removePublicView = onValueDeleted(`/${DEFAULT_ROOT}/{calendarId}/id`, async (event) => {
    const db = admin.database();
    const calendarId = event.params.calendarId;
    const byCalendar = db.ref(`${PublicViewService.BY_CALENDAR}/${calendarId}`);
    const views = (await byCalendar.once('value')).val() || {};
    // The reverse map is a hint, not the authority: remove only views whose binding still
    // names this calendar (a renamed copy may have taken one over).
    const owned = [];
    for (const pvid of Object.keys(views)) {
        const bound = (await db.ref(`${PublicViewService.BINDINGS}/${pvid}`).once('value')).val();
        if (bound === calendarId) owned.push(pvid);
    }
    return Promise.all([
        ...owned.flatMap(pvid => [
            db.ref(`/${READONLY_ROOT}/${pvid}`).remove(),
            db.ref(`${PublicViewService.BINDINGS}/${pvid}`).remove(),
        ]),
        byCalendar.remove(),
    ]);
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
    const writeAt = Date.parse(event.time);
    await HistoryService.stampLastEdit(db, id, before, after, Number.isFinite(writeAt) ? writeAt : Date.now());
    const at = Date.parse(event.time);
    return HistoryService.record(db, id, before, after, Number.isFinite(at) ? at : Date.now());
});

// Case-insensitive calendar lookup function
exports.lookupCalendar = onCall(async (request) => {
    const requestedSlug = request.data?.slug;
    if (!requestedSlug) {
        throw new functions.https.HttpsError('invalid-argument', 'Slug is required.');
    }
    try {
        return await SlugService.lookupCalendar(requestedSlug);
    } catch (error) {
        // Logged here, not returned: the message names database paths, and the caller is
        // anyone on the internet.
        console.error('lookupCalendar failed for', JSON.stringify(String(requestedSlug).slice(0, 100)), error);
        throw new functions.https.HttpsError('internal', 'Failed to look up calendar.');
    }
});

// Exported for unit tests (test/unit/ics.test.js). Not used by deployed functions.
exports._internal = {
    ICSService, CalendarService, SlugService, HistoryService, PublicViewService, IDService,
    recordIcsStat, icsEtag, deviceBucket, clientFamily, clientIpOf, sweepOldDeviceBuckets,
    deviceSaltSecret, sweepAllDeviceBuckets, DEVICE_SALT_PATH, SWEEP_CURSOR_PATH,
    _resetDeviceSaltCache: () => { deviceSaltSecretPromise = null; },
    sweepHistoryArchive, HISTORY_ARCHIVE_TTL_MS,
    DEVICE_BUCKET_TTL_DAYS, HISTORY_ROOT, HISTORY_KEEP, HISTORY_ADDED_KEEP, HISTORY_HARD_CAP, HISTORY_PROTECT_MS,
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