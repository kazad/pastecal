const functions = require('firebase-functions');
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onValueUpdated } = require("firebase-functions/v2/database");
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
async function recordIcsStat(id, { bytes, wasNotModified }) {
    const update = {
        lastServedAt: admin.database.ServerValue.TIMESTAMP,
        icsRequestCount: admin.database.ServerValue.increment(1),
    };
    if (wasNotModified) {
        update.ics304Count = admin.database.ServerValue.increment(1);
    } else {
        update.bytesServedTotal = admin.database.ServerValue.increment(bytes);
    }
    try {
        await admin.database().ref(STATS_ROOT).child(id).update(update);
    } catch (err) {
        console.error(`Failed to record ICS stat for ${id}:`, err);
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

        if (typeof dateTime === 'string') {
            const parsed = new Date(dateTime);
            if (isNaN(parsed.getTime())) return null;
            return dateTime.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        }

        const d = dateTime instanceof Date ? dateTime : new Date(dateTime);
        if (isNaN(d.getTime())) return null;
        return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
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

    createEventBlock(event, dtstamp) {
        const eventLines = [
            "BEGIN:VEVENT",
            `UID:${event.id}`,
            `DTSTAMP:${dtstamp}`,
            `DTSTART:${this.formatDateTime(event.start)}`,
            `DTEND:${this.formatDateTime(event.end)}`,
            `SUMMARY:${this.escapeText(event.title)}`,
            `DESCRIPTION:${this.escapeText(event.description)}`
        ];

        if (event.recurrencerule) {
            eventLines.push(`RRULE:${event.recurrencerule}`);
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
        const events = renderable.map(event => this.createEventBlock(event, dtstamp));

        return [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            `PRODID:-//PasteCal//${id}//EN`,
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
        const reservedWords = ['view', 'api', 'admin', 'www', 'app', 'calendar', 'cal'];
        
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

    async lookupCalendar(requestedSlug) {
        const normalizedSlug = this.normalizeSlug(requestedSlug);
        
        // Check cache first
        const cacheRef = admin.database().ref(`/slug_mappings/${normalizedSlug}`);
        const cached = await cacheRef.once('value');
        
        if (cached.val()) {
            // Found in cache
            const cacheData = cached.val();
            if (typeof cacheData === 'string') {
                // Legacy cache format - assume editable
                return { found: true, actualSlug: cacheData, isReadOnly: false };
            } else {
                // New cache format with type
                return { found: true, actualSlug: cacheData.actualSlug, isReadOnly: cacheData.isReadOnly };
            }
        }
        
        // Cache miss - try an exact-key read on the caller's original casing before falling
        // back to a full scan. Callers pass the raw, non-lowercased slug (see
        // CalendarService.parseCalendarPath), which matches the stored key in the vast
        // majority of cases, so this single-key read resolves most cache misses immediately.
        //
        // The full-tree scan below used to run on every cache miss regardless — a bounded read
        // of one key ballooned into pulling the entire calendars (~15MB) and, on a second miss,
        // calendars_readonly (~15MB+) tree into a 256MiB function instance. That repeatedly
        // exceeded the memory limit and crashed the instance (OOM crashes starting 2026-07-20,
        // 'Memory limit of 256 MiB exceeded'), and each crash-triggered instance restart's
        // fresh Admin SDK connection is what was driving a sustained RTDB bandwidth spike —
        // not any single popular calendar or external scraping, which the bandwidth
        // investigation had otherwise ruled out.
        const exactEditable = await admin.database().ref(DEFAULT_ROOT).child(requestedSlug).once('value');
        if (exactEditable.exists()) {
            const key = requestedSlug;
            await cacheRef.set({ actualSlug: key, isReadOnly: false });
            return { found: true, actualSlug: key, isReadOnly: false };
        }

        const exactReadOnly = await admin.database().ref(READONLY_ROOT).child(requestedSlug).once('value');
        if (exactReadOnly.exists()) {
            const key = requestedSlug;
            await cacheRef.set({ actualSlug: key, isReadOnly: true });
            return { found: true, actualSlug: key, isReadOnly: true };
        }

        // Still not found — the slug's casing must actually differ from the stored key (e.g.
        // a URL typed in a different case than the calendar was created with). This is the
        // rare path; fall back to the full case-insensitive scan to find it.

        // First check editable calendars
        const calendarsRef = admin.database().ref(`/${DEFAULT_ROOT}`);
        const editableSnapshot = await calendarsRef.once('value');
        const editableCalendars = editableSnapshot.val() || {};

        // Find case-insensitive match in editable calendars
        for (const key of Object.keys(editableCalendars)) {
            if (this.normalizeSlug(key) === normalizedSlug) {
                // Cache the mapping for future lookups
                await cacheRef.set({ actualSlug: key, isReadOnly: false });
                return { found: true, actualSlug: key, isReadOnly: false };
            }
        }

        // Then check read-only calendars
        const readOnlyRef = admin.database().ref(`/${READONLY_ROOT}`);
        const readOnlySnapshot = await readOnlyRef.once('value');
        const readOnlyCalendars = readOnlySnapshot.val() || {};

        // Find case-insensitive match in read-only calendars
        for (const key of Object.keys(readOnlyCalendars)) {
            if (this.normalizeSlug(key) === normalizedSlug) {
                // Cache the mapping for future lookups
                await cacheRef.set({ actualSlug: key, isReadOnly: true });
                return { found: true, actualSlug: key, isReadOnly: true };
            }
        }

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

        if (req.headers['if-none-match'] === etag) {
            console.log(`ICS 304: id=${cleanId} readonly=${isReadOnly} ua="${userAgent}"`);
            await recordIcsStat(cleanId, { wasNotModified: true });
            res.set('ETag', etag).set('Cache-Control', 'public, max-age=300').status(304).end();
            return;
        }

        const icsData = ICSService.generateICS(calendarData, cleanId);

        console.log(`ICS served: id=${cleanId} readonly=${isReadOnly} bytes=${icsData.length} ua="${userAgent}"`);
        await recordIcsStat(cleanId, { bytes: icsData.length, wasNotModified: false });

        res.set('Content-Type', 'text/calendar')
            .set('ETag', etag)
            .set('Cache-Control', 'public, max-age=300')
            .send(icsData);
    } catch (err) {
        // A missing calendar is a client error, not a server fault. Returning 500 here made
        // subscribed calendar apps retry a deleted feed forever; 404 tells them to stop.
        const status = err?.httpErrorCode?.status ?? 500;

        if (status >= 500) {
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


exports.syncPublicView = onValueUpdated(`/${DEFAULT_ROOT}/{calendarId}`, (event) => {
    const afterData = event.data.after.val();
    const publicViewId = afterData.options?.publicViewId;

    if (!publicViewId) return null;

    const updatedData = JSON.parse(JSON.stringify(afterData));
    return admin.database().ref(`/${READONLY_ROOT}/${publicViewId}`).update(updatedData);
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
exports._internal = { ICSService, CalendarService, SlugService };

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