/**
 * Model Tests
 * Tests for data models in public/models/
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock dependencies
// ============================================================

global.Utils = {
    uuidv4: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9)
};

global.CalendarDataService = {
    debounce_sync: vi.fn()
};

// ============================================================
// Event Model
// ============================================================

class Event {
    constructor(options) {
        this.id = options.Id || options.id || Utils.uuidv4();
        this.title = options.Subject || options.text || options.title || "";
        this.description = options.Description || options.description || "";
        this.repeat = options.Recurrence || options.repeat || "";
        this.recurrencerule = options.RecurrenceRule || options.recurrencerule || "";
        this.start = options.start || null;
        this.end = options.end || null;
        this.type = parseInt(options.Type || options.type || 1);

        this.recurrenceID = options.RecurrenceID || options.recurrenceID || null;
        this.recurrenceException = options.RecurrenceException || options.recurrenceException || null;
        this.isAllDay = options.IsAllDay || options.isAllDay || false;

        if (options.StartTime) {
            this.start = new Date(options.StartTime).toISOString() || null;
            this.end = new Date(options.EndTime).toISOString() || null;
        }

        for (let prop in this) {
            if (this[prop] === undefined) {
                this[prop] = null;
            }
        }
    }
}

// Make Event globally available for Calendar tests
global.Event = Event;

// ============================================================
// Calendar Model
// ============================================================

class Calendar {
    constructor(id, title, events, options) {
        this.id = id;
        this.title = title || "";
        this.events = events || [];
        this.options = options || {};
    }

    getSyncFusionEvents() {
        return this.events.map(e => {
            return {
                Id: e.id,
                Subject: e.title,
                StartTime: e.start,
                EndTime: e.end,
                Description: e.description,
                RecurrenceRule: e.recurrencerule,
                Type: parseInt(e.type || 1),
                Recurrence: e.repeat,
                RecurrenceID: e.recurrenceID,
                RecurrenceException: e.recurrenceException
            }
        });
    }

    defaultEvent(title) {
        var e = new Event({ title: title });
        var d = new Date();
        d.setHours(12, 0, 0, 0);
        e.start = d.toISOString();
        d.setHours(13, 0, 0, 0);
        e.end = d.toISOString();
        return e;
    }

    import(c) {
        Object.assign(this, c);
    }

    setEvents(events) {
        this.events = events.map(e => {
            return new Event(e);
        });
        CalendarDataService.debounce_sync(this);
    }
}

// ============================================================
// TEST SUITE: Event Model
// ============================================================

describe('Event Model', () => {
    describe('constructor', () => {
        test('creates event with default values', () => {
            const event = new Event({});
            expect(event.id).toBeDefined();
            expect(event.title).toBe("");
            expect(event.description).toBe("");
            expect(event.type).toBe(1);
            expect(event.isAllDay).toBe(false);
        });

        test('uses provided id', () => {
            const event = new Event({ id: 'custom-id' });
            expect(event.id).toBe('custom-id');
        });

        test('uses Id (SyncFusion format) when provided', () => {
            const event = new Event({ Id: 'syncfusion-id' });
            expect(event.id).toBe('syncfusion-id');
        });

        test('prefers Id over id', () => {
            const event = new Event({ Id: 'uppercase-id', id: 'lowercase-id' });
            expect(event.id).toBe('uppercase-id');
        });

        test('maps Subject to title', () => {
            const event = new Event({ Subject: 'Meeting' });
            expect(event.title).toBe('Meeting');
        });

        test('maps text to title', () => {
            const event = new Event({ text: 'Task' });
            expect(event.title).toBe('Task');
        });

        test('prioritizes Subject over text and title', () => {
            const event = new Event({ Subject: 'A', text: 'B', title: 'C' });
            expect(event.title).toBe('A');
        });

        test('maps Description to description', () => {
            const event = new Event({ Description: 'Details here' });
            expect(event.description).toBe('Details here');
        });

        test('parses type as integer', () => {
            const event = new Event({ type: '5' });
            expect(event.type).toBe(5);
        });

        test('handles SyncFusion StartTime/EndTime format', () => {
            const startTime = new Date('2024-01-15T10:00:00');
            const endTime = new Date('2024-01-15T11:00:00');

            const event = new Event({
                StartTime: startTime,
                EndTime: endTime
            });

            expect(event.start).toBe(startTime.toISOString());
            expect(event.end).toBe(endTime.toISOString());
        });

        test('preserves start/end when StartTime not provided', () => {
            const event = new Event({
                start: '2024-01-15T10:00:00.000Z',
                end: '2024-01-15T11:00:00.000Z'
            });

            expect(event.start).toBe('2024-01-15T10:00:00.000Z');
            expect(event.end).toBe('2024-01-15T11:00:00.000Z');
        });

        test('converts undefined properties to null', () => {
            const event = new Event({});
            expect(event.start).toBeNull();
            expect(event.end).toBeNull();
            expect(event.recurrenceID).toBeNull();
            expect(event.recurrenceException).toBeNull();
        });

        test('sets recurrence properties', () => {
            const event = new Event({
                Recurrence: 'weekly',
                RecurrenceRule: 'FREQ=WEEKLY;BYDAY=MO'
            });

            expect(event.repeat).toBe('weekly');
            expect(event.recurrencerule).toBe('FREQ=WEEKLY;BYDAY=MO');
        });

        test('sets all-day flag', () => {
            const event = new Event({ IsAllDay: true });
            expect(event.isAllDay).toBe(true);
        });

        test('sets recurrence exception data', () => {
            const event = new Event({
                RecurrenceID: 'parent-id',
                RecurrenceException: '20240115T100000Z'
            });

            expect(event.recurrenceID).toBe('parent-id');
            expect(event.recurrenceException).toBe('20240115T100000Z');
        });
    });
});

// ============================================================
// TEST SUITE: Calendar Model
// ============================================================

describe('Calendar Model', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        test('creates calendar with provided values', () => {
            const calendar = new Calendar('cal-1', 'My Calendar', [], { theme: 'dark' });

            expect(calendar.id).toBe('cal-1');
            expect(calendar.title).toBe('My Calendar');
            expect(calendar.events).toEqual([]);
            expect(calendar.options).toEqual({ theme: 'dark' });
        });

        test('uses empty string for undefined title', () => {
            const calendar = new Calendar('cal-1');
            expect(calendar.title).toBe("");
        });

        test('uses empty array for undefined events', () => {
            const calendar = new Calendar('cal-1', 'Title');
            expect(calendar.events).toEqual([]);
        });

        test('uses empty object for undefined options', () => {
            const calendar = new Calendar('cal-1', 'Title', []);
            expect(calendar.options).toEqual({});
        });
    });

    describe('getSyncFusionEvents', () => {
        test('transforms events to SyncFusion format', () => {
            const events = [
                new Event({
                    id: 'evt-1',
                    title: 'Meeting',
                    start: '2024-01-15T10:00:00.000Z',
                    end: '2024-01-15T11:00:00.000Z',
                    description: 'Team sync',
                    type: 2
                })
            ];

            const calendar = new Calendar('cal-1', 'Work', events);
            const sfEvents = calendar.getSyncFusionEvents();

            expect(sfEvents).toHaveLength(1);
            expect(sfEvents[0]).toEqual({
                Id: 'evt-1',
                Subject: 'Meeting',
                StartTime: '2024-01-15T10:00:00.000Z',
                EndTime: '2024-01-15T11:00:00.000Z',
                Description: 'Team sync',
                RecurrenceRule: '',
                Type: 2,
                Recurrence: '',
                RecurrenceID: null,
                RecurrenceException: null
            });
        });

        test('handles multiple events', () => {
            const events = [
                new Event({ id: '1', title: 'Event 1' }),
                new Event({ id: '2', title: 'Event 2' }),
                new Event({ id: '3', title: 'Event 3' })
            ];

            const calendar = new Calendar('cal-1', 'Test', events);
            const sfEvents = calendar.getSyncFusionEvents();

            expect(sfEvents).toHaveLength(3);
            expect(sfEvents.map(e => e.Subject)).toEqual(['Event 1', 'Event 2', 'Event 3']);
        });

        test('returns empty array for calendar with no events', () => {
            const calendar = new Calendar('cal-1', 'Empty');
            expect(calendar.getSyncFusionEvents()).toEqual([]);
        });

        test('defaults type to 1 when not specified', () => {
            const events = [new Event({ id: '1', title: 'Test' })];
            const calendar = new Calendar('cal-1', 'Test', events);
            const sfEvents = calendar.getSyncFusionEvents();

            expect(sfEvents[0].Type).toBe(1);
        });
    });

    describe('defaultEvent', () => {
        test('creates event with provided title', () => {
            const calendar = new Calendar('cal-1', 'Test');
            const event = calendar.defaultEvent('New Meeting');

            expect(event.title).toBe('New Meeting');
        });

        test('creates 1-hour event at noon', () => {
            const calendar = new Calendar('cal-1', 'Test');
            const event = calendar.defaultEvent('Test');

            const start = new Date(event.start);
            const end = new Date(event.end);

            expect(start.getHours()).toBe(12);
            expect(start.getMinutes()).toBe(0);
            expect(end.getHours()).toBe(13);
            expect(end.getMinutes()).toBe(0);
        });

        test('returns Event instance', () => {
            const calendar = new Calendar('cal-1', 'Test');
            const event = calendar.defaultEvent('Test');

            expect(event).toBeInstanceOf(Event);
        });
    });

    describe('import', () => {
        test('imports properties from object', () => {
            const calendar = new Calendar('cal-1', 'Original');
            calendar.import({
                title: 'Imported',
                events: [{ id: '1', title: 'Event' }],
                customProp: 'value'
            });

            expect(calendar.title).toBe('Imported');
            expect(calendar.events).toHaveLength(1);
            expect(calendar.customProp).toBe('value');
        });

        test('preserves id when not in import object', () => {
            const calendar = new Calendar('cal-1', 'Original');
            calendar.import({ title: 'New Title' });

            expect(calendar.id).toBe('cal-1');
        });

        test('overwrites id when in import object', () => {
            const calendar = new Calendar('cal-1', 'Original');
            calendar.import({ id: 'cal-2' });

            expect(calendar.id).toBe('cal-2');
        });
    });

    describe('setEvents', () => {
        test('converts raw events to Event instances', () => {
            const calendar = new Calendar('cal-1', 'Test');
            calendar.setEvents([
                { id: '1', title: 'Event 1' },
                { id: '2', title: 'Event 2' }
            ]);

            expect(calendar.events).toHaveLength(2);
            expect(calendar.events[0]).toBeInstanceOf(Event);
            expect(calendar.events[1]).toBeInstanceOf(Event);
        });

        test('calls CalendarDataService.debounce_sync', () => {
            const calendar = new Calendar('cal-1', 'Test');
            calendar.setEvents([{ id: '1', title: 'Event' }]);

            expect(CalendarDataService.debounce_sync).toHaveBeenCalledWith(calendar);
        });

        test('replaces existing events', () => {
            const calendar = new Calendar('cal-1', 'Test', [
                new Event({ id: 'old', title: 'Old Event' })
            ]);

            calendar.setEvents([{ id: 'new', title: 'New Event' }]);

            expect(calendar.events).toHaveLength(1);
            expect(calendar.events[0].id).toBe('new');
        });
    });
});
