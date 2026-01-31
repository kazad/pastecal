/**
 * Parser Tests for Utils.parseHumanWrittenCalendar and extractDuration
 *
 * Run with: npm run test:parser
 * Coverage: npm run test:parser:coverage
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { extractDuration, parseHumanWrittenCalendar } = require('../lib/parser');

// ============================================================
// TEST SUITE: extractDuration
// ============================================================

describe('extractDuration', () => {
    test('extracts hours from "for X hours"', () => {
        const result = extractDuration('meeting for 2 hours');
        assert.strictEqual(result.duration, 2 * 60 * 60 * 1000);
        assert.strictEqual(result.subject, 'meeting');
    });

    test('extracts hours from "X hr"', () => {
        const result = extractDuration('call 1 hr');
        assert.strictEqual(result.duration, 1 * 60 * 60 * 1000);
        assert.strictEqual(result.subject, 'call');
    });

    test('extracts minutes from "X minutes"', () => {
        const result = extractDuration('standup 15 minutes');
        assert.strictEqual(result.duration, 15 * 60 * 1000);
        assert.strictEqual(result.subject, 'standup');
    });

    test('extracts minutes from "X min"', () => {
        const result = extractDuration('quick sync 30 min');
        assert.strictEqual(result.duration, 30 * 60 * 1000);
        assert.strictEqual(result.subject, 'quick sync');
    });

    test('extracts days from "X days"', () => {
        const result = extractDuration('vacation for 3 days');
        assert.strictEqual(result.duration, 3 * 24 * 60 * 60 * 1000);
        assert.strictEqual(result.subject, 'vacation');
    });

    test('extracts single day', () => {
        const result = extractDuration('holiday 1 day');
        assert.strictEqual(result.duration, 1 * 24 * 60 * 60 * 1000);
        assert.strictEqual(result.subject, 'holiday');
    });

    test('handles decimal durations', () => {
        const result = extractDuration('meeting 1.5 hours');
        assert.strictEqual(result.duration, 1.5 * 60 * 60 * 1000);
        assert.strictEqual(result.subject, 'meeting');
    });

    test('handles "in X" duration format', () => {
        const result = extractDuration('finish task in 2 hours');
        assert.strictEqual(result.duration, 2 * 60 * 60 * 1000);
        assert.strictEqual(result.subject, 'finish task');
    });

    test('returns null duration when no duration found', () => {
        const result = extractDuration('meeting with team');
        assert.strictEqual(result.duration, null);
        assert.strictEqual(result.subject, 'meeting with team');
    });

    test('handles empty string', () => {
        const result = extractDuration('');
        assert.strictEqual(result.duration, null);
        assert.strictEqual(result.subject, '');
    });

    test('preserves subject when duration is at start', () => {
        const result = extractDuration('2 hours team meeting');
        assert.strictEqual(result.duration, 2 * 60 * 60 * 1000);
        assert.strictEqual(result.subject, 'team meeting');
    });

    test('handles duration in middle of text', () => {
        const result = extractDuration('team 2 hours meeting');
        assert.strictEqual(result.duration, 2 * 60 * 60 * 1000);
        assert.strictEqual(result.subject, 'team meeting');
    });
});

// ============================================================
// TEST SUITE: parseHumanWrittenCalendar
// ============================================================

describe('parseHumanWrittenCalendar', () => {
    describe('basic date/time parsing', () => {
        test('parses "tomorrow at 2pm"', () => {
            const result = parseHumanWrittenCalendar('meeting tomorrow at 2pm');
            assert.ok(result.startDateTime, 'should have startDateTime');
            assert.ok(result.endDateTime, 'should have endDateTime');
            assert.strictEqual(result.subject, 'meeting');
        });

        test('parses "today at 3pm"', () => {
            const result = parseHumanWrittenCalendar('call today at 3pm');
            assert.ok(result.startDateTime);
            assert.ok(result.endDateTime);
            assert.strictEqual(result.subject, 'call');
        });

        test('parses "next monday"', () => {
            const result = parseHumanWrittenCalendar('standup next monday');
            assert.ok(result.startDateTime);
            assert.ok(result.endDateTime);
            assert.strictEqual(result.subject, 'standup');
        });

        test('parses specific date "Jan 15"', () => {
            const result = parseHumanWrittenCalendar('deadline Jan 15');
            assert.ok(result.startDateTime);
            assert.ok(result.endDateTime);
            assert.strictEqual(result.subject, 'deadline');
        });

        test('parses time range "2pm to 4pm"', () => {
            const result = parseHumanWrittenCalendar('workshop tomorrow 2pm to 4pm');
            assert.ok(result.startDateTime);
            assert.ok(result.endDateTime);

            const start = new Date(result.startDateTime);
            const end = new Date(result.endDateTime);
            assert.ok(end > start, 'end should be after start');
        });
    });

    describe('duration handling', () => {
        test('uses explicit duration when no end time', () => {
            const result = parseHumanWrittenCalendar('meeting tomorrow at 2pm for 2 hours');
            assert.ok(result.startDateTime);
            assert.ok(result.endDateTime);

            const start = new Date(result.startDateTime);
            const end = new Date(result.endDateTime);
            const durationMs = end - start;

            assert.strictEqual(durationMs, 2 * 60 * 60 * 1000);
        });

        test('uses minute duration', () => {
            const result = parseHumanWrittenCalendar('sync tomorrow at 10am 30 minutes');
            const start = new Date(result.startDateTime);
            const end = new Date(result.endDateTime);
            const durationMs = end - start;

            assert.strictEqual(durationMs, 30 * 60 * 1000);
        });

        test('defaults to 1 hour when no duration or end time', () => {
            const result = parseHumanWrittenCalendar('meeting tomorrow at 2pm');
            const start = new Date(result.startDateTime);
            const end = new Date(result.endDateTime);
            const durationMs = end - start;

            assert.strictEqual(durationMs, 60 * 60 * 1000);
        });
    });

    describe('subject extraction', () => {
        test('extracts subject from beginning', () => {
            const result = parseHumanWrittenCalendar('dentist appointment tomorrow at 9am');
            assert.strictEqual(result.subject, 'dentist appointment');
        });

        test('extracts subject from end', () => {
            const result = parseHumanWrittenCalendar('tomorrow at 9am dentist');
            assert.strictEqual(result.subject, 'dentist');
        });

        test('returns "Untitled Event" for empty subject', () => {
            const result = parseHumanWrittenCalendar('tomorrow at 2pm');
            assert.strictEqual(result.subject, 'Untitled Event');
        });

        test('extracts subject with duration removed', () => {
            const result = parseHumanWrittenCalendar('team meeting tomorrow at 2pm for 2 hours');
            assert.strictEqual(result.subject, 'team meeting');
        });
    });

    describe('edge cases', () => {
        test('handles text with no date/time', () => {
            const result = parseHumanWrittenCalendar('random text here');
            assert.strictEqual(result.subject, 'random text here');
            assert.strictEqual(result.startDateTime, null);
            assert.strictEqual(result.endDateTime, null);
        });

        test('handles empty string', () => {
            const result = parseHumanWrittenCalendar('');
            assert.strictEqual(result.subject, '');
            assert.strictEqual(result.startDateTime, null);
            assert.strictEqual(result.endDateTime, null);
        });

        test('handles only duration text', () => {
            const result = parseHumanWrittenCalendar('2 hours');
            // "2 hours" might be parsed as a relative time by chrono
            // or might not be parsed at all - either is acceptable
            assert.ok(typeof result.subject === 'string');
        });

        test('handles complex sentence', () => {
            const result = parseHumanWrittenCalendar('Schedule a review meeting with John next Tuesday at 3pm for 1.5 hours');
            assert.ok(result.startDateTime);
            assert.ok(result.endDateTime);
            assert.ok(result.subject.length > 0);
        });
    });

    describe('ISO format output', () => {
        test('returns valid ISO date strings', () => {
            const result = parseHumanWrittenCalendar('meeting tomorrow at 2pm');

            // Check that dates are valid ISO strings
            const start = new Date(result.startDateTime);
            const end = new Date(result.endDateTime);

            assert.ok(!isNaN(start.getTime()), 'startDateTime should be valid date');
            assert.ok(!isNaN(end.getTime()), 'endDateTime should be valid date');

            // Check ISO format
            assert.ok(result.startDateTime.includes('T'), 'should be ISO format');
            assert.ok(result.endDateTime.includes('T'), 'should be ISO format');
        });
    });
});

// ============================================================
// TEST SUITE: Integration scenarios
// ============================================================

describe('Integration scenarios', () => {
    test('calendar quick-add: "Lunch with Sarah tomorrow at noon"', () => {
        const result = parseHumanWrittenCalendar('Lunch with Sarah tomorrow at noon');
        assert.ok(result.startDateTime);
        assert.ok(result.endDateTime);
        assert.ok(result.subject.includes('Lunch'));
    });

    test('calendar quick-add: "Doctor appointment Friday 9:30am 45 min"', () => {
        const result = parseHumanWrittenCalendar('Doctor appointment Friday 9:30am 45 min');
        assert.ok(result.startDateTime);
        assert.ok(result.endDateTime);

        const start = new Date(result.startDateTime);
        const end = new Date(result.endDateTime);
        const durationMs = end - start;

        assert.strictEqual(durationMs, 45 * 60 * 1000);
    });

    test('calendar quick-add: "Flight to NYC Jan 20 6pm to 9pm"', () => {
        const result = parseHumanWrittenCalendar('Flight to NYC Jan 20 6pm to 9pm');
        assert.ok(result.startDateTime);
        assert.ok(result.endDateTime);

        const start = new Date(result.startDateTime);
        const end = new Date(result.endDateTime);

        assert.ok(end > start);
    });

    test('calendar quick-add: "Weekly team sync every Monday 10am"', () => {
        const result = parseHumanWrittenCalendar('Weekly team sync every Monday 10am');
        // chrono may or may not parse "every Monday" - check we get reasonable output
        assert.ok(typeof result.subject === 'string');
    });
});
