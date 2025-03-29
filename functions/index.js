const functions = require('firebase-functions');
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onValueUpdated } = require("firebase-functions/v2/database");
const admin = require('firebase-admin');

admin.initializeApp();

const DEFAULT_ROOT = "calendars";
const READONLY_ROOT = "calendars_readonly";

// Calendar Data Service
const CalendarService = {
    parseCalendarPath(path) {
        const parts = path.split('/');
        return {
            isReadOnly: parts[0] === "view",
            id: parts[0] === "view" ? parts[2] : parts[1]
        };
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
        const { id, isReadOnly } = CalendarService.parseCalendarPath(req.path);
        const cleanId = id.replace(/[.]ICS.*/i, '');

        console.log('Generating ICS for calendar ID', req.path, cleanId);

        const { data: calendarData } = await CalendarService.getCalendarData(cleanId, isReadOnly);
        const icsData = ICSService.generateICS(calendarData, cleanId);

        res.set('Content-Type', 'text/calendar').send(icsData);
    } catch (err) {
        console.error('Error generating ICS:', err);
        res.status(500).send('Server error generating ICS');
    }
});

exports.createPublicLink = onCall(async (request) => {
    const { sourceCalendarId } = request.data;

    try {
        const { data: calendarData, ref: sourceCalRef } = await CalendarService.getCalendarData(sourceCalendarId);
        const publicViewId = await IDService.generateUniquePublicId();

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