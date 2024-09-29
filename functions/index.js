const functions = require('firebase-functions');
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

exports.generateICS = functions.https.onRequest((req, res) => {
    let id = req.path.split('/')[1]; // Extract the ID from the URL path
    id = id.replace(/[.]ICS.*/i, '');

    console.log('Generating ICS for calendar ID', req.path, id);

    // Fetch the calendar data for this ID from your database
    admin.database().ref('/calendars').child(id).once('value', snapshot => {
        const calendarData = snapshot.val();

        if (!calendarData) {
            res.status(404).send('Calendar not found');
            return;
        }

        const icsData = jsonToIcs(calendarData, id); // Call your jsonToIcs function

        res.set('Content-Type', 'text/calendar');
        res.send(icsData);
    });
});

/*
// local cleanup task: Update eventIDs to be GUIDs 
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