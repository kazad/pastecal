/**
 * Parser module - Node.js compatible version of the parser functions
 * from public/utils/utils.js for testing with coverage
 *
 * This mirrors the browser version but uses the npm chrono-node package
 */

const chrono = require('chrono-node');

/**
 * Extracts duration from text and returns the subject with duration removed
 * @param {string} text - Input text that may contain a duration
 * @returns {{subject: string, duration: number|null}} - Subject and duration in milliseconds
 */
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

/**
 * Parses a human-written calendar entry and extracts subject, start, and end times
 * @param {string} entry - Human-written calendar entry like "meeting tomorrow at 2pm"
 * @returns {{subject: string, startDateTime: string|null, endDateTime: string|null}}
 */
function parseHumanWrittenCalendar(entry) {
    const parsedResults = chrono.parse(entry, new Date(), { forwardDate: true });

    if (parsedResults.length === 0) {
        return { subject: entry, startDateTime: null, endDateTime: null };
    }

    const result = parsedResults[0];
    let startDate = result.start.date();
    let endDate = result.end ? result.end.date() : null;

    const parsedText = result.text;
    let remainingText = entry.replace(parsedText, '').trim();

    const { subject, duration } = extractDuration(remainingText);

    if (duration && !endDate) {
        endDate = new Date(startDate.getTime() + duration);
    } else if (!endDate && !duration) {
        const defaultDuration = 60 * 60 * 1000;
        endDate = new Date(startDate.getTime() + defaultDuration);
    }

    return {
        subject: subject || 'Untitled Event',
        startDateTime: startDate.toISOString(),
        endDateTime: endDate ? endDate.toISOString() : null
    };
}

module.exports = {
    extractDuration,
    parseHumanWrittenCalendar
};
