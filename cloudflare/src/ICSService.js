/**
 * ICSService -- RFC 5545 iCalendar generation for calendar subscriptions.
 * Ported from functions/index.js to run in Cloudflare Workers and Node.js.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const byteLength = (s) => (typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).length);

export const ICSService = {
    // Line breaks are normalized to LF before escaping. A CR (bare, or the first half of a
    // pasted CRLF) would otherwise reach the feed raw, and a CR inside a content line ends
    // it early for strict parsers, truncating the text and garbling the next property.
    escapeText(text) {
        return String(text ?? '').replace(/\r\n?/g, '\n')
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\n/g, '\\n');
    },

    // RFC 5545 3.1: content lines longer than 75 octets are folded with CRLF + a space.
    // Counted in UTF-8 octets, not characters, and split only between code points --
    // cutting a multibyte character in half leaves invalid UTF-8 on both lines.
    foldLine(line) {
        if (byteLength(line) <= 75) return line;
        const parts = [];
        let current = '', size = 0, limit = 75;
        for (const ch of line) {
            const n = byteLength(ch);
            if (size + n > limit) {
                parts.push(current);
                // The leading space of a continuation line counts toward its 75 octets.
                current = ''; size = 0; limit = 74;
            }
            current += ch; size += n;
        }
        parts.push(current);
        return parts.join('\r\n ');
    },

    // Epoch ms for a stored date or an ICS stamp (20260921T170000Z or 20260921), or NaN.
    toMs(value) {
        if (value === null || value === undefined || value === '') return NaN;
        if (typeof value === 'string' && /^\d{8}T\d{6}Z$/.test(value)) {
            return Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
                `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
        }
        if (typeof value === 'string' && /^\d{8}$/.test(value)) {
            return Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8));
        }
        const d = value instanceof Date ? value : new Date(value);
        return d.getTime();
    },

    // Normalize a stored date into ICS basic format (YYYYMMDDTHHMMSSZ), or null if the
    // value isn't a usable date. Values reach us as ISO strings, but Date objects and epoch
    // numbers have both appeared in stored data, so accept anything Date can parse and
    // reject the rest rather than throwing.
    formatDateTime(dateTime) {
        if (dateTime === null || dateTime === undefined || dateTime === '') return null;
        const d = dateTime instanceof Date ? dateTime : new Date(dateTime);
        if (isNaN(d.getTime())) return null;

        const out = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        return /^\d{8}T\d{6}Z$/.test(out) ? out : null;
    },

    // Date-only form (YYYYMMDD) for all-day events. RFC 5545 3.8.2.4 requires DTSTART to be
    // a DATE for an all-day event, and 3.8.5.1 requires EXDATE to use the same value type;
    // emitting a DATE-TIME instead means a deleted all-day occurrence never matches its
    // EXDATE and keeps appearing for subscribers.
    formatDate(dateTime) {
        const ms = this.toMs(dateTime);
        if (isNaN(ms)) return null;
        const d = new Date(Math.floor((ms + 13 * HOUR_MS + 1000) / DAY_MS) * DAY_MS);
        if (isNaN(d.getTime())) return null;
        const out = d.toISOString().slice(0, 10).replace(/-/g, '');
        return /^\d{8}$/.test(out) ? out : null;
    },

    // An event is only renderable if BOTH endpoints normalize to a real date.
    isRenderable(event) {
        if (!event) return false;
        return this.formatDateTime(event.start) !== null
            && this.formatDateTime(event.end) !== null;
    },

    // Normalize one stored exception date to the iCalendar form.
    exceptionDates(event) {
        const raw = event && event.recurrenceException;
        if (!raw || typeof raw !== 'string') return [];
        return raw.split(',')
            .map(s => s.trim())
            .filter(s => /^\d{8}T\d{6}Z?$/.test(s))
            .map(s => (s.endsWith('Z') ? s : `${s}Z`));
    },

    seriesShape(event) {
        return { allDay: !!event.isAllDay, anchorMs: this.toMs(event.start) };
    },

    seriesSlot(stamp, shape) {
        let ms = this.toMs(stamp);
        if (isNaN(ms)) return null;
        if (shape.allDay) return this.formatDate(ms);
        if (!isNaN(shape.anchorMs)) {
            const timeOfDay = ((shape.anchorMs % DAY_MS) + DAY_MS) % DAY_MS;
            const sameDay = Math.floor(ms / DAY_MS) * DAY_MS + timeOfDay;
            const nearest = [sameDay - DAY_MS, sameDay, sameDay + DAY_MS]
                .reduce((a, b) => (Math.abs(b - ms) < Math.abs(a - ms) ? b : a));
            if (Math.abs(nearest - ms) < 12 * HOUR_MS) ms = nearest;
        }
        return this.formatDateTime(new Date(ms));
    },

    seriesRule(rule, allDay) {
        if (!allDay) return rule;
        return rule.replace(/(^|;)UNTIL=(\d{8}T\d{6}Z?)/i, (match, sep, value) => {
            const date = this.allDayStampDate(value);
            return date ? `${sep}UNTIL=${date}` : match;
        });
    },

    allDayStampDate(value) {
        if (/^\d{8}T\d{6}$/i.test(value)) return value.slice(0, 8);
        return this.formatDate(/Z$/i.test(value) ? value : `${value}Z`);
    },

    occurrenceOriginal(event) {
        const candidates = this.exceptionDates(event);
        if (!candidates.length) return null;
        if (candidates.length === 1) return candidates[0];

        const startMs = this.toMs(event.start);
        if (isNaN(startMs)) return candidates[0];

        let best = candidates[0], bestDelta = Infinity;
        for (const c of candidates) {
            const ms = this.toMs(c);
            if (isNaN(ms)) continue;
            const delta = Math.abs(ms - startMs);
            if (delta < bestDelta) { bestDelta = delta; best = c; }
        }
        return best;
    },

    assignOccurrences(events) {
        const seriesById = new Map();
        const childrenOf = new Map();
        for (const event of events) {
            if (event.recurrenceID) {
                if (!childrenOf.has(event.recurrenceID)) childrenOf.set(event.recurrenceID, []);
                childrenOf.get(event.recurrenceID).push(event);
            } else if (event.recurrencerule) {
                seriesById.set(event.id, event);
            }
        }

        const assigned = new Map();
        for (const [seriesId, children] of childrenOf) {
            const parent = seriesById.get(seriesId);
            const parentShape = parent ? this.seriesShape(parent) : null;

            const pairs = [];
            children.forEach((child, index) => {
                const shape = parentShape || { allDay: !!child.isAllDay, anchorMs: NaN };
                const slots = [...new Set(this.exceptionDates(child)
                    .map(stamp => this.seriesSlot(stamp, shape))
                    .filter(Boolean))];
                const startMs = this.toMs(child.start);
                for (const slot of slots) {
                    const distance = Math.abs(this.toMs(slot) - startMs);
                    pairs.push({ child, index, slot, allDay: shape.allDay,
                        ambiguous: slots.length > 1 ? 1 : 0,
                        distance: isNaN(distance) ? Infinity : distance });
                }
            });
            pairs.sort((a, b) => a.ambiguous - b.ambiguous
                || a.distance - b.distance || a.index - b.index);

            const usedSlots = new Set();
            for (const pair of pairs) {
                if (assigned.has(pair.child) || usedSlots.has(pair.slot)) continue;
                assigned.set(pair.child, { slot: pair.slot, allDay: pair.allDay });
                usedSlots.add(pair.slot);
            }
        }
        return assigned;
    },

    createEventBlock(event, dtstamp, overriddenSlots, occurrence) {
        if (occurrence === undefined && event.recurrenceID) {
            const stamp = this.occurrenceOriginal(event);
            const shape = { allDay: !!event.isAllDay, anchorMs: NaN };
            const slot = stamp ? this.seriesSlot(stamp, shape) : null;
            occurrence = slot ? { slot, allDay: shape.allDay } : null;
        }
        const isOccurrence = !!event.recurrenceID && !!occurrence;

        const allDay = !!event.isAllDay;
        const start = allDay ? this.formatDate(event.start) : this.formatDateTime(event.start);
        let end = allDay ? this.formatDate(event.end) : this.formatDateTime(event.end);
        const dateParam = allDay ? ';VALUE=DATE' : '';

        if (allDay && (!end || end <= start)) {
            end = this.formatDate(this.toMs(start) + DAY_MS);
        } else if (!allDay && this.toMs(end) < this.toMs(start)) {
            end = start;
        }

        let uid = event.id;
        if (isOccurrence) uid = event.recurrenceID;
        else if (event.recurrenceID && event.id === event.recurrenceID) uid = `${event.id}-${start}`;

        const eventLines = [
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `DTSTAMP:${dtstamp}`,
            `DTSTART${dateParam}:${start}`,
            `DTEND${dateParam}:${end}`,
            `SUMMARY:${this.escapeText(event.title)}`,
            `DESCRIPTION:${this.escapeText(event.description)}`
        ];

        if (isOccurrence) {
            eventLines.push(`RECURRENCE-ID${occurrence.allDay ? ';VALUE=DATE' : ''}:${occurrence.slot}`);
        } else if (event.recurrencerule && !event.recurrenceID) {
            eventLines.push(`RRULE:${this.seriesRule(event.recurrencerule, allDay)}`);

            const shape = this.seriesShape(event);
            const exdates = [...new Set(this.exceptionDates(event)
                .map(stamp => this.seriesSlot(stamp, shape))
                .filter(slot => slot && !(overriddenSlots && overriddenSlots.has(slot))))];
            if (exdates.length) eventLines.push(`EXDATE${dateParam}:${exdates.join(',')}`);
        }

        eventLines.push('END:VEVENT');
        return eventLines.map(line => this.foldLine(line)).join('\r\n');
    },

    generateICS(calendarData, id) {
        const raw = calendarData?.events;
        const allEvents = Array.isArray(raw)
            ? raw
            : (raw && typeof raw === 'object' ? Object.values(raw) : []);

        const renderable = allEvents.filter(event => this.isRenderable(event));
        const dtstamp = this.formatDateTime(new Date());

        const occurrences = this.assignOccurrences(renderable);
        const overridden = new Map();
        for (const [event, { slot }] of occurrences) {
            if (!overridden.has(event.recurrenceID)) overridden.set(event.recurrenceID, new Set());
            overridden.get(event.recurrenceID).add(slot);
        }

        const events = renderable.map(event => this.createEventBlock(event, dtstamp,
            event.recurrenceID ? null : overridden.get(event.id),
            event.recurrenceID ? (occurrences.get(event) || null) : undefined));

        const name = this.escapeText(calendarData?.title || id);

        const header = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            `PRODID:-//PasteCal//${id}//EN`,
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            `X-WR-CALNAME:${name}`,
            `NAME:${name}`,
            'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
            'X-PUBLISHED-TTL:PT1H'
        ].map(line => this.foldLine(line));

        return [...header, ...events, 'END:VCALENDAR'].join('\r\n');
    }
};

export default ICSService;
