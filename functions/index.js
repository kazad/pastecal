const functions = require('firebase-functions');
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onValueUpdated } = require("firebase-functions/v2/database");
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid'); // Import uuid for generating GUIDs

admin.initializeApp();

function escapeIcsText(text) {
    return text.replace(/\\/g, '\\\\') // Escape backslashes
        .replace(/;/g, '\\;')   // Escape semicolons
        .replace(/,/g, '\\,')   // Escape commas
        .replace(/\n/g, '\\n'); // Escape newlines
}

function jsonToIcs(json, id) {
    let icsEvents = [];

    json.events.forEach(event => {
        let icsEvent = [
            "BEGIN:VEVENT",
            `UID:${event.id}`,
            `DTSTART:${event.start.replace(/[-:]/g, '').replace('.000Z', 'Z')}`,
            `DTEND:${event.end.replace(/[-:]/g, '').replace('.000Z', 'Z')}`,
            `SUMMARY:${escapeIcsText(event.title)}`,
            `DESCRIPTION:${escapeIcsText(event.description)}`,
        ];

        if (event.recurrencerule) {
            icsEvent.push(`RRULE:${event.recurrencerule}`);
        }

        icsEvent.push("END:VEVENT");

        icsEvents.push(icsEvent.join("\n"));
    });

    let icsFile = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//PasteCal//" + id + "//EN",
        ...icsEvents,
        "END:VCALENDAR"
    ].join("\n");

    return icsFile;
}

exports.generateICSV2 = onRequest({ cors: true }, async (req, res) => {
    let id = req.path.split('/')[1];
    id = id.replace(/[.]ICS.*/i, '');

    console.log('Generating ICS for calendar ID', req.path, id);

    try {
        const snapshot = await admin.database().ref('/calendars').child(id).once('value');
        const calendarData = snapshot.val();

        if (!calendarData) {
            res.status(404).send('Calendar not found');
            return;
        }

        const icsData = jsonToIcs(calendarData, id);
        res.set('Content-Type', 'text/calendar');
        res.send(icsData);
    } catch (err) {
        console.error('Error generating ICS:', err);
        res.status(500).send('Server error generating ICS');
    }
});

let nanoid = (t = 21) => {
    let e = "",
        r = crypto.getRandomValues(new Uint8Array(t));
    for (; t--;) {
        let n = 63 & r[t];
        e +=
            n < 36
                ? n.toString(36)
                : n < 62
                    ? (n - 26).toString(36).toUpperCase()
                    : n < 63
                        ? nanoid(1) // replace with another random character
                        : nanoid(1);
    }
    return e;
};

var Utils = {};
Utils.nanoid = nanoid;

exports.createPublicLink = onCall(async (request) => {
    const { sourceCalendarId } = request.data;

    console.log(JSON.stringify(request.data));

    // Generate a unique public ID
    const publicViewId = Utils.nanoid(6);

    // Get the source calendar data
    const sourceCalRef = admin.database().ref(`/calendars/${sourceCalendarId}`);
    const snapshot = await sourceCalRef.once('value');
    const calendarData = snapshot.val();

    console.log("caldata", calendarData);

    if (!calendarData) {
        throw new functions.https.HttpsError('not-found', 'Calendar not found');
    }

    // Create a deep copy to avoid reference issues
    const publicCalData = JSON.parse(JSON.stringify(calendarData));

    // Store the publicViewId in the original calendar
    await sourceCalRef.child('options/publicViewId').set(publicViewId);

    // Create the public view calendar
    await admin.database().ref(`/calendars_readonly/${publicViewId}`).set(publicCalData);

    return { publicViewId };
});

// This function triggers when a calendar with a publicViewId is updated
exports.syncPublicView = onValueUpdated('/calendars/{calendarId}', (event) => {
    // Get the updated data
    const afterData = event.data.after.val();

    // Check if this calendar has a public view
    const publicViewId = afterData.options?.publicViewId;

    if (publicViewId) {
        // Get the updated calendar data and create a copy
        const updatedData = JSON.parse(JSON.stringify(afterData));

        // Update the public view in the readonly collection
        // Must return the Promise for proper function execution
        return admin.database().ref(`/calendars_readonly/${publicViewId}`).update(updatedData);
    }

    return null;
}
);

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