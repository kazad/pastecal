const functions = require('firebase-functions');
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onValueUpdated } = require("firebase-functions/v2/database");
const admin = require('firebase-admin');

const isLocal = process.env.FUNCTIONS_EMULATOR === 'true';
//console.log('Environment:', process.env);
console.log('Running in', isLocal ? 'local' : 'production', 'environment');

if (isLocal) {
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

// Calendar Data Service
const CalendarService = {
    parseCalendarPath(path) {
        //console.log('Parsing calendar path:', path);
        const parts = path.split('/').filter(x => x); // "/view/123" and "view/123"
        let ret = {
            isReadOnly: parts[0] === "view",
            id: parts[0] === "view" ? SlugService.normalizeSlug(parts[1]) : SlugService.normalizeSlug(parts[0])
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
        return text.replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\n/g, '\\n');
    },

    formatDateTime(dateTime) {
        return dateTime.replace(/[-:]/g, '').replace('.000Z', 'Z');
    },

    createEventBlock(event) {
        const eventLines = [
            "BEGIN:VEVENT",
            `UID:${event.id}`,
            `DTSTART:${this.formatDateTime(event.start)}`,
            `DTEND:${this.formatDateTime(event.end)}`,
            `SUMMARY:${this.escapeText(event.title)}`,
            `DESCRIPTION:${this.escapeText(event.description)}`
        ];

        if (event.recurrencerule) {
            eventLines.push(`RRULE:${event.recurrencerule}`);
        }

        eventLines.push("END:VEVENT");
        return eventLines.join("\n");
    },

    generateICS(calendarData, id) {
        const events = (calendarData?.events ?? []).map(event => this.createEventBlock(event));

        return [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            `PRODID:-//PasteCal//${id}//EN`,
            ...events,
            "END:VCALENDAR"
        ].join("\n");
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
        
        // Cache miss - scan both editable and read-only calendars
        
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
        const { id, isReadOnly } = CalendarService.parseCalendarPath(pathWithoutICS);
        const cleanId = id; //id.replace(/[.]ICS.*/i, '');

        console.log('Generating ICS for calendar ID: path, id, readonly', req.path, cleanId, isReadOnly);

        const { data: calendarData } = await CalendarService.getCalendarData(cleanId, isReadOnly);
        const icsData = ICSService.generateICS(calendarData, cleanId);

        res.set('Content-Type', 'text/calendar').send(icsData);
    } catch (err) {
        console.error('Error generating ICS:', err);
        res.status(500).send('Server error generating ICS');
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
exports.lookupCalendar = onCall(async (data, context) => {
    try {
        console.log('lookupCalendar called with slug:', data?.slug);
        console.log('Request context auth:', context.auth ? 'authenticated' : 'unauthenticated');
        
        const requestedSlug = data?.slug;
        
        if (!requestedSlug) {
            const errorMsg = `Slug is required. Received slug: ${data?.slug}`;
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
                slug: data?.slug,
                errorName: error.name
            }
        );
    }
});

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