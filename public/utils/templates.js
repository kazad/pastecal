/**
 * CalendarTemplates: "Start from" on the homepage draft (index.html, .pc-tpl). One click fills the
 * draft with a believable month for a common use, so a first-time visitor sees what their calendar
 * could look like instead of an empty grid, then changes or clears it.
 *
 * Pure: build(templateId, today) -> { title, notes, typeLabels, events } for the month `today` is in,
 * in local time, and the same output for the same date (test/unit/templates.test.js). The app adds
 * the events through the EventStore, so undo and saving treat them like any others.
 *
 * Event ids are "tpl-<template>-<n>": EventStore keeps only its own fields, so the id is how the app
 * tells a template's untouched events from ones the visitor added or changed. Only on the draft: Save
 * & share gives each a fresh id (app.js create()), so saved calendars never share iCal UIDs.
 */
const CalendarTemplates = {
    PREFIX: 'tpl-',

    // Chip order on the homepage. Types are slots in the default palette (app.js DEFAULT_COLORS):
    // 1 indigo, 2 pink, 3 coral, 4 green, 5 orange, 6 light blue, 7 gray.
    // Shared space first: the most common named use (Clarity, Oct 2026) and the one people write in about.
    TEMPLATES: {
        space: { label: 'Shared space' },
        out: { label: "Who's out" },
        family: { label: 'Family' },
        team: { label: 'Sports team' },
        shifts: { label: 'Volunteer shifts' },
        guests: { label: 'Guest visits' },
        club: { label: 'Club or class' },
    },

    list() {
        return Object.keys(CalendarTemplates.TEMPLATES).map((id) => ({ id, label: CalendarTemplates.TEMPLATES[id].label }));
    },

    label(id) {
        return (CalendarTemplates.TEMPLATES[id] || {}).label || '';
    },

    // The template an event came from, if its id says so ("tpl-team-3" -> "team").
    templateOf(event) {
        const m = event && /^tpl-([a-z]+)-\d+$/.exec(String(event.id || ''));
        return m && CalendarTemplates.TEMPLATES[m[1]] ? m[1] : null;
    },

    build(templateId, today) {
        const recipe = CalendarTemplates._recipes[templateId];
        if (!recipe) return null;
        const base = today instanceof Date ? today : new Date(today);
        const y = base.getFullYear(), m = base.getMonth();
        const out = [];
        // Days of the month on one weekday (0 = Sunday), in order.
        const on = (dow) => {
            const days = [];
            for (let d = 1; d <= 31; d++) {
                const date = new Date(y, m, d);
                if (date.getMonth() !== m) break;
                if (date.getDay() === dow) days.push(d);
            }
            return days;
        };
        // Local wall-clock times, so a daylight-saving change mid-month moves nothing.
        const timed = (day, h, min, minutes, title, type, description) => {
            const start = new Date(y, m, day, h, min);
            const end = new Date(y, m, day, h, min + minutes);
            out.push({ title, start: start.toISOString(), end: end.toISOString(), type, isAllDay: false, description: description || '' });
        };
        // All day, stored as the editor stores it: local midnight to the midnight after the last day.
        const allDay = (day, days, title, type) => {
            out.push({ title, start: new Date(y, m, day).toISOString(), end: new Date(y, m, day + days).toISOString(), type, isAllDay: true, description: '' });
        };
        const meta = recipe({ on, timed, allDay });
        const labels = Array.from({ length: 8 }, (_, i) => `Type ${i + 1}`);
        for (const [type, name] of Object.entries(meta.labels)) labels[type - 1] = name;
        out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
        return {
            title: meta.title,
            notes: meta.notes.join('\n'),
            typeLabels: labels,
            events: out.map((e, i) => ({ id: `${CalendarTemplates.PREFIX}${templateId}-${i + 1}`, ...e })),
        };
    },

    _recipes: {
        // A rooftop that residents book: evenings and weekends, one maintenance day, one building event.
        space({ on, timed, allDay }) {
            const sats = on(6), suns = on(0), fris = on(5);
            timed(fris[0], 18, 0, 180, 'Apt 4B: birthday dinner', 1, 'About 12 people. Grill booked too.');
            timed(sats[0], 11, 0, 120, 'Apt 2A: brunch', 1);
            timed(sats[0], 16, 0, 180, 'Apt 7C: BBQ', 1, 'Will clean the grill after.');
            timed(suns[1], 9, 0, 60, 'Morning yoga (open to all)', 5, 'Bring a mat.');
            timed(on(3)[1], 19, 0, 120, 'Apt 5D: book club', 1);
            allDay(on(2)[2], 1, 'Closed: deck maintenance', 7);
            timed(sats[2], 18, 0, 180, 'Building potluck', 5, 'Everyone welcome. Bring a dish to share.');
            timed(fris[fris.length - 1], 19, 0, 120, 'Apt 3B: movie night', 1, 'Projector from the office.');
            return {
                title: 'Rooftop bookings',
                labels: { 1: 'Booked', 5: 'Building event', 7: 'Closed' },
                notes: ['Book the rooftop: add an event with your apartment and what it is for.',
                    'Quiet hours start at 10pm. Leave it as you found it.', 'Grill propane is in the cabinet by the door.'],
            };
        },

        // Who is staying in the guest room, with cleaning between visits.
        guests({ on, allDay }) {
            const fris = on(5), mons = on(1);
            allDay(fris[0], 3, 'Grandma and Grandpa', 1);
            allDay(mons[1], 1, 'Cleaning', 7);
            allDay(on(4)[1], 4, 'Chris and Jamie', 1);
            allDay(fris[2], 2, 'Hold: maybe Aunt Rose', 5);
            allDay(mons[mons.length - 1], 1, 'Cleaning', 7);
            return {
                title: 'Guest room',
                labels: { 1: 'Staying', 5: 'Hold', 7: 'Cleaning' },
                notes: ['Planning a visit? Add your dates as Hold, then change it to Staying once it is set.',
                    'Wi-Fi: GuestRoom / password on the fridge.', 'Fresh sheets are in the hall closet.'],
            };
        },

        // Practice twice a week, a game every Saturday, two team events.
        team({ on, timed }) {
            const teams = ['Hawks', 'Lions', 'Rockets', 'Comets', 'Owls'];
            const snacks = ['Miller', 'Garcia', 'Brooks', 'Nguyen', 'Carter'];
            on(2).concat(on(4)).forEach((d) => timed(d, 17, 0, 75, 'Practice', 1));
            on(6).forEach((d, i) => timed(d, [9, 10, 11][i % 3], 0, 60,
                i % 2 ? `Game at ${teams[i]}` : `Game vs ${teams[i]}`, 2, `Snacks: ${snacks[i]} family`));
            timed(on(6)[1], 8, 30, 30, 'Team photos', 5, 'Wear the home jersey.');
            const sundays = on(0);
            timed(sundays[sundays.length - 1], 13, 0, 120, 'End-of-season party', 5, 'Pizza at the park pavilion.');
            return {
                title: 'Tigers U10 Soccer',
                labels: { 1: 'Practice', 2: 'Game', 5: 'Team event' },
                notes: ['Home field: Lincoln Park, Field 3', 'Rainouts decided by 7am. Check here before you drive.',
                    'Bring water, shin guards and a ball.', 'Snacks: the family named on each game brings them.'],
            };
        },

        // Two kids' weekly lessons, a few appointments, family time.
        family({ on, timed, allDay }) {
            on(1).forEach((d) => timed(d, 17, 0, 45, 'Swim: Sam', 1));
            on(3).forEach((d) => timed(d, 16, 0, 45, 'Piano: Maya', 1));
            timed(on(5)[0], 8, 0, 60, 'Car service', 3);
            timed(on(2)[1], 15, 30, 60, 'Dentist: Sam', 3);
            timed(on(4)[2], 18, 0, 30, 'Parent-teacher conference', 3);
            timed(on(5)[1], 19, 0, 180, 'Date night', 4, 'Sitter: Jess, 6:30pm');
            allDay(on(6)[2], 2, 'Grandma visits', 4);
            const fridays = on(5);
            timed(fridays[fridays.length - 1], 19, 0, 120, 'Movie night', 4);
            return {
                title: 'Our family',
                labels: { 1: 'Kids', 3: 'Appointments', 4: 'Family' },
                notes: ['Pickup: whoever is free first, say so in the group chat.', 'Emergency contact: Aunt Rose, 555-0142',
                    'Add anything that needs a driver.'],
            };
        },

        // Who is away, all-day events; nobody works from home on the offsite.
        out({ on, allDay }) {
            const mondays = on(1), fridays = on(5);
            allDay(mondays[1], 3, 'Alex: vacation', 4);
            allDay(on(4)[2], 2, 'Team offsite', 2);
            allDay(fridays[fridays.length - 1], 1, 'Jordan: vacation', 4);
            on(2).forEach((d) => allDay(d, 1, 'Sam: WFH', 6));
            allDay(mondays[0], 1, 'Taylor: WFH', 6);
            allDay(mondays[mondays.length - 1], 1, 'Taylor: WFH', 6);
            allDay(on(4)[1], 1, 'Taylor: sick', 3);
            return {
                title: "Who's out: Design team",
                labels: { 2: 'Offsite', 3: 'Sick', 4: 'Vacation', 6: 'WFH' },
                notes: ["Add yourself when you'll be out, even for half a day.", 'Out sick? Add it by 9am and say so in the team chat.',
                    'Offsite: Oakwood Lodge. Details in the team folder.'],
            };
        },

        // Two Saturday shifts and a Wednesday evening; about one in four still open.
        shifts({ on, timed }) {
            const names = ['Maria', 'Tom', 'Jo', 'Sam', 'Priya', 'Dev', 'Ana'];
            let k = 0;
            const shift = (d, h, min, minutes) => {
                const open = k % 4 === 1;
                timed(d, h, min, minutes, open ? 'Open shift' : `Shift: ${names[k % names.length]}`, open ? 7 : 1,
                    open ? 'Put your name in the title to take it.' : '');
                k++;
            };
            const days = on(3).map((d) => [d, 'wed']).concat(on(6).map((d) => [d, 'sat'])).sort((a, b) => a[0] - b[0]);
            for (const [d, kind] of days) {
                if (kind === 'wed') shift(d, 17, 0, 150);
                else { shift(d, 9, 0, 180); shift(d, 12, 0, 180); }
            }
            return {
                title: 'Food bank shifts',
                labels: { 1: 'Filled', 7: 'Open' },
                notes: ['Shifts: Wednesdays 5-7:30pm, Saturdays 9-12 and 12-3.', 'Take an open shift: put your name in its title.',
                    "Can't make it? Change it back to Open shift so someone else can.", 'Where: 120 Main St, side door.'],
            };
        },

        // Meetings every other Thursday, reading checkpoints, one outing.
        club({ on, timed, allDay }) {
            const thursdays = on(4);
            allDay(on(1)[0], 1, 'Start: The Remains of the Day', 5);
            timed(thursdays[1], 19, 0, 90, 'Meeting: ch. 1-12', 1, "At Sam's. Bring a snack if you can.");
            allDay(on(1)[2], 1, 'Read ch. 13 to the end', 5);
            timed(on(6)[2], 14, 0, 60, 'Author talk at the library', 1);
            timed(thursdays[3], 19, 0, 90, 'Meeting: finish + pick next book', 1, "At Ana's.");
            return {
                title: 'Book club',
                labels: { 1: 'Meeting', 5: 'Reading' },
                notes: ['We meet every other Thursday at 7pm, at a different house each time.',
                    'This month: The Remains of the Day, by Kazuo Ishiguro.', 'Suggest the next book in the notes before the last meeting.'],
            };
        },
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = CalendarTemplates;
