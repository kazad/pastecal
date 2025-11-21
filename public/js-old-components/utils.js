export function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

export function sanitizeUrl(url) {
    let sanitized = url.replaceAll("amp;", "&").replace(/&+/g, '&')
    return sanitized;
}

export function randomID(size = 21) {
    let alphabet = '123456789abcdefghjklmnpqrstuvwxyz';
    let id = '';
    let i = size;
    while (i--) {
        id += alphabet[(Math.random() * alphabet.length) | 0]
    }
    return id;
}

export function uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

export function parseDate(str) {
    let date = null;
    if (!str) return date;
    if (str.match(/\D/)) {
        let parts = str.split(/\D/);
        date = new Date((parts[0].length == 2 ? "20" : 0) + parts[0], parts[1] - 1, parts[2]);
    } else {
        if (str.length === 6) date = new Date("20" + str.substring(0, 2), str.substring(2, 4) - 1, str.substring(4, 6));
        if (str.length === 8) date = new Date(str.substring(0, 4), str.substring(4, 6) - 1, str.substring(6, 8));
    }
    return date.toString() == 'Invalid Date' ? null : date;
}

export function parseHumanWrittenCalendar(entry) {
    if (typeof chrono === 'undefined') {
        console.error('chrono library not loaded');
        return null;
    }
    const parsedResults = chrono.parse(entry, new Date(), { forwardDate: true });

    if (parsedResults.length === 0) {
        return { subject: entry, startDateTime: null, endDateTime: null };
    }

    const result = parsedResults[0];
    let startDate = result.start.date();
    let endDate = result.end ? result.end.date() : null;

    // Extract the parsed text and the remaining text
    const parsedText = result.text;
    let remainingText = entry.replace(parsedText, '').trim();

    // Process duration in the remaining text
    const { subject, duration } = extractDuration(remainingText);

    // Apply duration if found
    if (duration && !endDate) {
        endDate = new Date(startDate.getTime() + duration);
    } else if (!endDate && !duration) {
        // Set default duration to 1 hour
        const defaultDuration = 60 * 60 * 1000; // 1 hour in milliseconds
        endDate = new Date(startDate.getTime() + defaultDuration);
    }

    return {
        subject: subject || 'Untitled Event',
        startDateTime: startDate.toISOString(),
        endDateTime: endDate ? endDate.toISOString() : null
    };
}

function extractDuration(text) {
    const durationRegex = /(?:(?:for|in)\s+)?(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day)s?/i;
    const match = text.match(durationRegex);

    if (!match) {
        return { subject: text, duration: null };
    }

    const [fullMatch, amount, unit] = match;
    let durationMs;

    switch (unit.toLowerCase()) {
        case 'hour':
        case 'hr':
            durationMs = parseFloat(amount) * 60 * 60 * 1000;
            break;
        case 'minute':
        case 'min':
            durationMs = parseFloat(amount) * 60 * 1000;
            break;
        case 'day':
            durationMs = parseFloat(amount) * 24 * 60 * 60 * 1000;
            break;
        default:
            durationMs = 0;
    }

    const subject = text.replace(fullMatch, '').replace(/\s+/g, ' ').trim();

    return { subject, duration: durationMs };
}