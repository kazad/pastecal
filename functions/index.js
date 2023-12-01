const functions = require('firebase-functions');
const admin = require('firebase-admin');

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