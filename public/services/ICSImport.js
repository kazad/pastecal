/**
 * ICSImport -- a calendar file (.ics) into this calendar's events, without duplicates.
 *
 * Settings' "Import .ics" (app.js icsImport*): the person picks a file, plan() works out what it would add, change and
 * skip, they confirm, and the plan's one batch command goes through the EventStore like any edit (saved, synced, one
 * Undo). Parsed here in the browser: the file never leaves the page until its events are saved, it works on a draft,
 * and the zone math is EventZone's, the same the calendars draw with.
 *
 * Two kinds of file:
 *   - pastecal's own backup (Download .ics: ICSService.backupRow): each event carries its stored row as JSON
 *     (X-PASTECAL-ROW). That row is used as it is (EventStore.normalize), so a backup restores exactly what was stored.
 *   - any other calendar file (Google, Apple, Outlook, a feed): SUMMARY, DESCRIPTION (+ LOCATION), DTSTART, DTEND or
 *     DURATION (TZID, UTC, floating, VALUE=DATE), RRULE, EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED. An override
 *     is stored as the editor stores an edited occurrence (ScheduleAdapter EditOccurrence): its original start skipped
 *     in the series, and a row pointing at the series.
 *
 * Never a duplicate, in this order:
 *   1. the same row: a backup's id, or a UID that is an event's id (a feed of this calendar), or the id an earlier import
 *      of the same UID gave it (idFor: derived from UID + RECURRENCE-ID, so a second import finds it). Identical: skipped;
 *      different: only the fields that differ are written (EventStore.diff).
 *   2. the same event: same title, start, end and repeat rule (sameEvent) though the ids differ: skipped.
 * Import adds and changes; it never deletes an event or brings back a skipped date.
 *
 * Pure: no page. Loaded as a script (window.ICSImport) after EventZone and EventStore; required by node tests.
 *   parse(text)                         { name, zone, events: [{ props }] } or throws ImportError (code, message)
 *   plan(existing, text, { calZone, localZone })   { commands, add, update, skip, unreadable } or throws ImportError
 */
(function (root) {
    'use strict';

    const EventStore = root.EventStore || (typeof require === 'function' ? require('./EventStore.js') : null);
    const EventZone = root.EventZone || (typeof require === 'function' ? require('./EventZone.js') : null);

    const MAX_BYTES = 2 * 1024 * 1024;
    const MAX_EVENTS = 5000;          // the server's own limit for a whole calendar (CalendarRoom LIMITS.maxEvents)
    const MAX_TITLE = 2000, MAX_TEXT = 20000, MAX_ID = 200;   // CalendarRoom LIMITS.maxTitle / maxField / maxId
    const MAX_CALENDAR = 2 * 1024 * 1024;   // CalendarRoom LIMITS.maxCalendar: the whole calendar's JSON
    const DAY_MS = 86400000;

    class ImportError extends Error {
        constructor(code, message) { super(message); this.name = 'ImportError'; this.code = code; }
    }

    // ---- the parser: one, with a table test (test/unit/ics-import.test.js) -------------------------------------

    /** TEXT value (RFC 5545 3.3.11): \n \N \, \; \\ unescaped. */
    function unescapeText(v) {
        return String(v).replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
    }

    /** One content line: name, params ({ NAME: value }, quotes removed), raw value. null if it is not one. */
    function contentLine(line) {
        let i = 0;
        const n = line.length;
        while (i < n && line[i] !== ';' && line[i] !== ':') i++;
        const name = line.slice(0, i).trim().toUpperCase();
        if (!name || i >= n) return null;
        const params = {};
        while (line[i] === ';') {
            i++;
            let k = i;
            while (k < n && line[k] !== '=' && line[k] !== ';' && line[k] !== ':') k++;
            const pname = line.slice(i, k).trim().toUpperCase();
            let val = '';
            if (line[k] === '=') {
                k++;
                while (k < n && line[k] !== ';' && line[k] !== ':') {
                    if (line[k] === '"') { const q = line.indexOf('"', k + 1); if (q < 0) return null; val += line.slice(k + 1, q); k = q + 1; }
                    else val += line[k++];
                }
            }
            if (pname) params[pname] = val;
            i = k;
        }
        if (line[i] !== ':') return null;
        return { name, params, value: line.slice(i + 1) };
    }

    /**
     * The file's events, each as { props: { NAME: [{ params, value }] } } (only the VEVENT's own lines, not an alarm's
     * inside it), and the calendar's name and zone (X-WR-CALNAME, X-WR-TIMEZONE). Lines may end in CRLF, LF or CR;
     * folded lines (a leading space or tab) are joined.
     */
    function parse(text) {
        const src = String(text || '').replace(/^﻿/, '');
        if (!/^\s*BEGIN:VCALENDAR\s*$/im.test(src)) throw new ImportError('not_calendar', 'That file isn’t a calendar (.ics).');
        const lines = [];
        for (const raw of src.split(/\r\n|\n|\r/)) {
            if ((raw[0] === ' ' || raw[0] === '\t') && lines.length) lines[lines.length - 1] += raw.slice(1);
            else if (raw.trim()) lines.push(raw);
        }
        const out = { name: '', zone: '', events: [] };
        const stack = [];
        let ev = null;
        for (const line of lines) {
            const p = contentLine(line);
            if (!p) continue;
            if (p.name === 'BEGIN') {
                const what = p.value.trim().toUpperCase();
                stack.push(what);
                if (what === 'VEVENT' && stack.length === 2 && stack[0] === 'VCALENDAR') ev = { props: {} };
                continue;
            }
            if (p.name === 'END') {
                const what = stack.pop();
                if (what === 'VEVENT' && ev && stack.length === 1) { out.events.push(ev); ev = null; }
                continue;
            }
            const top = stack[stack.length - 1];
            if (top === 'VEVENT' && ev) (ev.props[p.name] = ev.props[p.name] || []).push({ params: p.params, value: p.value });
            else if (top === 'VCALENDAR' && stack.length === 1) {
                if (p.name === 'X-WR-CALNAME') out.name = unescapeText(p.value);
                if (p.name === 'X-WR-TIMEZONE') out.zone = p.value.trim();
            }
        }
        return out;
    }

    // ---- times ---------------------------------------------------------------------------------------------

    // Outlook and Exchange write Windows zone names; the common ones, as IANA.
    const WINDOWS = {
        'pacific standard time': 'America/Los_Angeles', 'mountain standard time': 'America/Denver', 'us mountain standard time': 'America/Phoenix',
        'central standard time': 'America/Chicago', 'eastern standard time': 'America/New_York', 'alaskan standard time': 'America/Anchorage',
        'hawaiian standard time': 'Pacific/Honolulu', 'atlantic standard time': 'America/Halifax', 'gmt standard time': 'Europe/London',
        'w. europe standard time': 'Europe/Berlin', 'romance standard time': 'Europe/Paris', 'central europe standard time': 'Europe/Budapest',
        'e. europe standard time': 'Europe/Bucharest', 'india standard time': 'Asia/Kolkata', 'china standard time': 'Asia/Shanghai',
        'tokyo standard time': 'Asia/Tokyo', 'aus eastern standard time': 'Australia/Sydney', 'utc': 'UTC',
    };
    /** A TZID as an IANA zone: as written, the tail of a prefixed one ("/mozilla.org/20070129_1/America/New_York"), a Windows name; or null. */
    function zoneOf(tzid) {
        const t = String(tzid || '').trim();
        if (!t) return null;
        const direct = EventZone.validZone(t);
        if (direct) return direct;
        const parts = t.split('/').filter(Boolean);
        for (const n of [3, 2]) if (parts.length > n) { const z = EventZone.validZone(parts.slice(-n).join('/')); if (z) return z; }
        return WINDOWS[t.toLowerCase()] || null;
    }

    const pad = (n, l = 2) => String(n).padStart(l, '0');
    /** A stored exception stamp (the editor's form): an instant as YYYYMMDDTHHMMSSZ. */
    const stampOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`; };
    const isoOf = (ms) => new Date(ms).toISOString();

    /**
     * One date or date-time value: { date: { y, m, d } } for a DATE, else { ms, zone } (zone: the IANA zone it was
     * written in, null for UTC). TZID: that zone's wall clock; Z: UTC; floating: ctx.floatZone. null if unreadable.
     * ctx.unknownZone is set when a TZID names no zone we know (it is then read as floating).
     */
    function readValue(value, params, ctx) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(String(value || '').trim());
        if (!m) return null;
        const y = +m[1], mo = +m[2] - 1, d = +m[3];
        if (mo > 11 || d < 1 || d > 31) return null;
        if (!m[4] || String(params.VALUE || '').toUpperCase() === 'DATE') return { date: { y, m: mo, d } };
        const h = +m[4], mi = +m[5], s = +(m[6] || 0);
        if (m[7]) return { ms: Date.UTC(y, mo, d, h, mi, s), zone: null, utc: true };
        let zone = params.TZID ? zoneOf(params.TZID) : null;
        if (params.TZID && !zone) ctx.unknownZone = true;
        const explicit = !!zone;
        zone = zone || ctx.floatZone;
        return { ms: EventZone.fromWall(y, mo, d, h, mi, s, zone), zone, explicit: explicit || ctx.floatExplicit };
    }

    /** DURATION (RFC 5545 3.3.6) as { days, ms }, or null. */
    function readDuration(v) {
        const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(v || '').trim());
        if (!m || String(v).trim().toUpperCase() === 'P' || /T$/i.test(String(v).trim())) return null;
        const sign = m[1] === '-' ? -1 : 1;
        return { days: sign * ((+m[2] || 0) * 7 + (+m[3] || 0)), ms: sign * (((+m[4] || 0) * 60 + (+m[5] || 0)) * 60 + (+m[6] || 0)) * 1000 };
    }

    // An all-day event is stored as its author's local midnight (models/Event.js); an import's author is this browser.
    const midnight = (date, zone) => EventZone.fromWall(date.y, date.m, date.d, 0, 0, 0, zone);
    const addDays = (date, n) => { const t = new Date(Date.UTC(date.y, date.m, date.d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() }; };

    /** The day (YYYYMMDD) an exception stamp names in a series: an all-day one's date as stored (writer's local midnight), a timed one's day in zone. */
    function slotDay(stamp, allDay, zone) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(String(stamp || '').trim());
        if (!m) return null;
        if (!m[4] || !m[7]) return m[1] + m[2] + m[3];
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        if (allDay) { const d = new Date(Math.floor((ms + 13 * 3600000 + 1000) / DAY_MS) * DAY_MS); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`; }
        const w = EventZone.wall(ms, zone);
        return `${w.y}${pad(w.m + 1)}${pad(w.d)}`;
    }
    const stampsOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

    // ---- one VEVENT -> a row -------------------------------------------------------------------------------

    const first = (ev, name) => (ev.props[name] || [])[0] || null;
    const text = (ev, name) => { const p = first(ev, name); return p ? unescapeText(p.value) : ''; };
    const WEEK = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

    /**
     * A weekly rule written against a UTC start names UTC weekdays; pastecal repeats a series in its zone's wall clock
     * (EventZone.seriesZone), where the start may fall on the day before or after. Its BYDAY moves by that gap (the
     * inverse of ICSService.weeklyDaysInUtc).
     */
    function utcDaysTo(rule, startMs, zone) {
        if (!zone || !/(^|;)FREQ=WEEKLY(;|$)/i.test(rule)) return rule;
        const w = EventZone.wall(startMs, zone);
        const gap = (new Date(Date.UTC(w.y, w.m, w.d)).getUTCDay() - new Date(startMs).getUTCDay() + 7) % 7;
        if (!gap) return rule;
        return rule.replace(/(^|;)BYDAY=([A-Za-z,]+)(?=;|$)/i, (all, sep, days) => {
            const list = days.toUpperCase().split(',');
            if (list.some((d) => !WEEK.includes(d))) return all;
            return `${sep}BYDAY=${list.map((d) => WEEK[(WEEK.indexOf(d) + gap) % 7]).join(',')}`;
        });
    }

    /**
     * "The last Monday" as the editor writes it (BYDAY=MO;BYSETPOS=-1), which both calendars expand, from the form other
     * apps write (BYDAY=-1MO; ICSService.plainPositions writes the feed that way). One weekday with a position only.
     */
    function editorPositions(rule) {
        if (!/(^|;)FREQ=(MONTHLY|YEARLY)(;|$)/i.test(rule) || /(^|;)BYSETPOS=/i.test(rule)) return rule;
        return rule.replace(/(^|;)BYDAY=([+-]?[1-5])(MO|TU|WE|TH|FR|SA|SU)(?=;|$)/i, (all, sep, n, d) => `${sep}BYDAY=${d.toUpperCase()};BYSETPOS=${+n}`);
    }

    /**
     * A standard VEVENT as a pastecal row (no id yet) plus how to find it again: { row, uid, rid (the RECURRENCE-ID's
     * stamp, for an override), cancelled, why (unreadable) }. ctx: { calZone, localZone, floatZone }.
     */
    function fromVevent(ev, ctx) {
        const uid = text(ev, 'UID').trim();
        const cancelled = /^CANCELLED$/i.test(text(ev, 'STATUS').trim());
        const ds = first(ev, 'DTSTART');
        const start = ds && readValue(ds.value, ds.params, ctx);
        if (!start) return { uid, why: 'no start' };
        const allDay = !!start.date;
        const effective = ctx.calZone || ctx.localZone;   // where a series without its own zone repeats
        // The event's own zone only when its file named one other than the calendar's (a TZID equal to the calendar's
        // zone is what a feed writes for every event there: ICSService.zoneOf).
        const tz = !allDay && start.explicit && start.zone && start.zone !== effective ? start.zone : null;
        let startMs, endMs;
        const de = first(ev, 'DTEND'), dur = first(ev, 'DURATION') && readDuration(first(ev, 'DURATION').value);
        if (allDay) {
            startMs = midnight(start.date, ctx.localZone);
            const end = de && readValue(de.value, de.params, ctx);
            const endDate = end && end.date ? end.date : end ? (() => { const w = EventZone.wall(end.ms, end.zone || 'UTC'); return { y: w.y, m: w.m, d: w.d }; })()
                : dur ? addDays(start.date, Math.max(1, dur.days + (dur.ms > 0 ? 1 : 0))) : addDays(start.date, 1);
            endMs = midnight(endDate, ctx.localZone);
            if (endMs <= startMs) endMs = midnight(addDays(start.date, 1), ctx.localZone);
        } else {
            startMs = start.ms;
            const end = de && readValue(de.value, de.params, ctx);
            if (end && !end.date) endMs = end.ms;
            else if (end && end.date) endMs = EventZone.fromWall(end.date.y, end.date.m, end.date.d, 0, 0, 0, start.zone || 'UTC');
            else if (dur) {
                // Days are calendar days in the event's zone (RFC 5545 3.3.6: a day across DST is not 24 hours), the rest exact.
                const z = start.zone || 'UTC', w = EventZone.wall(startMs, z);
                endMs = EventZone.fromWall(w.y, w.m, w.d + dur.days, w.h, w.min, w.s, z) + dur.ms;
            } else endMs = startMs;
            if (!(endMs >= startMs)) endMs = startMs;
        }
        if (isNaN(startMs) || isNaN(endMs)) return { uid, why: 'bad date' };

        // Where this series repeats (EventZone.seriesZone), for its rule's weekdays and its skipped dates.
        const zone = allDay ? null : (tz || effective);
        let rule = '';
        const rr = first(ev, 'RRULE');
        if (rr) {
            rule = rr.value.trim().replace(/^RRULE:/i, '');
            if (start.utc) rule = utcDaysTo(rule, startMs, zone);
            rule = editorPositions(rule);
            if (EventStore.unsafeRecurrence(rule)) return { uid, why: 'repeats too often' };
        }
        // A skipped date, or an override's original start, as the editor stores it (ScheduleAdapter EditOccurrence):
        // the occurrence's start as a UTC stamp; an all-day series' as this browser's midnight that day.
        const toStamp = (value, params) => {
            const v = readValue(value, params, ctx);
            if (!v) return null;
            if (allDay) return stampOf(midnight(v.date || (() => { const w = EventZone.wall(v.ms, v.zone || 'UTC'); return { y: w.y, m: w.m, d: w.d }; })(), ctx.localZone));
            if (v.date) { const w = EventZone.wall(startMs, zone); return stampOf(EventZone.fromWall(v.date.y, v.date.m, v.date.d, w.h, w.min, w.s, zone)); }
            return stampOf(v.ms);
        };
        const exdates = [];
        for (const p of ev.props.EXDATE || []) for (const v of p.value.split(',')) { const s = toStamp(v, p.params); if (s && !exdates.includes(s)) exdates.push(s); }
        const ridProp = first(ev, 'RECURRENCE-ID');
        const rid = ridProp ? toStamp(ridProp.value, ridProp.params) : null;
        if (ridProp && !rid) return { uid, why: 'bad date' };

        // The notes: DESCRIPTION, then LOCATION. A feed's last line is the calendar's view link (its URL:
        // ICSService.createEventBlock), which is not part of the notes.
        let description = text(ev, 'DESCRIPTION');
        const url = text(ev, 'URL').trim();
        if (url && description.endsWith(url)) description = description.slice(0, -url.length).replace(/\n*$/, '');
        const location = text(ev, 'LOCATION').trim();
        if (location && !description.includes(location)) description = description ? `${description}\n\n${location}` : location;

        const type = parseInt(text(ev, 'X-PASTECAL-TYPE'), 10);
        const row = {
            title: text(ev, 'SUMMARY').trim().slice(0, MAX_TITLE),
            description: description.slice(0, MAX_TEXT),
            start: isoOf(startMs), end: isoOf(endMs), isAllDay: allDay,
            recurrencerule: rid ? '' : rule,
            recurrenceException: !rid && exdates.length ? exdates.join(',') : null,
        };
        if (type >= 1) row.type = type;
        if (tz) row.tz = tz;
        return { row, uid, rid, cancelled, zone: start.zone || null, explicit: !!start.explicit };
    }

    /** A backup's stored row (X-PASTECAL-ROW), normalized; null when absent or unreadable (the standard properties are used). */
    function backupRow(ev) {
        const p = first(ev, 'X-PASTECAL-ROW');
        if (!p) return null;
        try {
            const raw = JSON.parse(unescapeText(p.value));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
            const row = EventStore.normalize(raw);
            if (row.id === null || row.id === undefined || row.id === '') return null;
            if (typeof row.id !== 'string' && typeof row.id !== 'number') return null;
            if (String(row.id).length > MAX_ID || String(row.recurrenceID ?? '').length > MAX_ID) return null;
            if (!('tz' in raw)) delete row.tz;
            row.title = row.title.slice(0, MAX_TITLE);
            row.description = row.description.slice(0, MAX_TEXT);
            return row;
        } catch (e) { return null; }
    }

    // ---- identity ------------------------------------------------------------------------------------------

    /** A stable id for an imported event: from its UID (and RECURRENCE-ID), so importing the same file again finds it. */
    function idFor(uid, rid = '') {
        const s = `${uid}|${rid || ''}`;
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return `ics-${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
    }
    /** A UID as a feed writes an event id (ICSService.safeUid percent-encodes a few characters). */
    const uidId = (uid) => { try { return decodeURIComponent(uid); } catch (e) { return uid; } };

    /** A repeat rule by meaning: case, part order, a trailing ';', INTERVAL=1 and "the last Monday" spelled two ways. */
    function ruleKey(rule) {
        let parts = String(rule || '').replace(/^RRULE:/i, '').toUpperCase().split(';').map((p) => p.trim()).filter((p) => p.includes('=') && p !== 'INTERVAL=1');
        const pos = parts.find((p) => p.startsWith('BYSETPOS=')), day = parts.find((p) => p.startsWith('BYDAY='));
        if (pos && day && /^-?[1-5]$/.test(pos.slice(9)) && /^(MO|TU|WE|TH|FR|SA|SU)$/.test(day.slice(6))) {
            parts = parts.filter((p) => p !== pos).map((p) => (p === day ? `BYDAY=${pos.slice(9)}${day.slice(6)}` : p));
        }
        return parts.map((p) => p.replace(/^UNTIL=(\d{8}).*$/, 'UNTIL=$1')).sort().join(';');
    }
    /** The same event to a person: title, when (an all-day event's dates, a timed one's instants) and repeat rule. */
    function sameEventKey(e) {
        const day = (v) => slotDay(stampOf(new Date(v).getTime()), true);
        const when = e.isAllDay ? `${day(e.start)}-${day(e.end)}` : `${new Date(e.start).getTime()}-${new Date(e.end).getTime()}`;
        return `${String(e.title || '').trim()}|${!!e.isAllDay}|${when}|${ruleKey(e.recurrencerule)}`;
    }

    /**
     * An imported row made to say what it means in an existing row's own spelling, wherever the meaning is the same
     * (an all-day date, a rule, a zone the calendar implies, a type the file doesn't name), so EventStore.diff finds
     * only real changes. Skipped dates are added to, never taken away.
     */
    function inTermsOf(existing, row, ctx, imported) {
        const out = { ...row };
        for (const f of EventStore.FIELDS) if (!(f in out) && f !== 'tz') out[f] = existing[f];
        if (!('type' in row)) out.type = existing.type;
        out.repeat = existing.repeat;
        out.recurrenceID = existing.recurrenceID;
        const day = (v) => slotDay(stampOf(new Date(v).getTime()), true);
        if (row.isAllDay && existing.isAllDay) {
            if (day(row.start) === day(existing.start)) out.start = existing.start;
            if (day(row.end) === day(existing.end)) out.end = existing.end;
        }
        if (ruleKey(row.recurrencerule) === ruleKey(existing.recurrencerule)) out.recurrencerule = existing.recurrencerule;
        // No zone of its own in the file: an event here keeps its zone, unless the file names another (the calendar's).
        const own = EventZone.validZone(existing.tz);
        if (!row.tz && !own) delete out.tz;
        else if (!row.tz) out.tz = imported && imported.explicit && imported.zone && imported.zone !== own ? null : existing.tz;
        // Skipped dates: the existing ones, plus each the file adds on a day not already skipped.
        const zone = EventZone.seriesZone(out, ctx.calZone) || ctx.localZone;
        const have = stampsOf(existing.recurrenceException);
        const days = new Set(have.map((s) => slotDay(s, !!out.isAllDay, zone)));
        const more = stampsOf(row.recurrenceException).filter((s) => { const d = slotDay(s, !!out.isAllDay, zone); if (days.has(d)) return false; days.add(d); return true; });
        out.recurrenceException = more.length ? [...have, ...more].join(',') : existing.recurrenceException;
        return out;
    }

    // ---- the plan ------------------------------------------------------------------------------------------

    /**
     * What importing `text` into a calendar holding `existing` would do: { commands (one batch for EventStore.dispatch),
     * add, update, skip, unreadable, name }. Throws ImportError for a file that cannot be imported at all.
     * opts: { calZone (EventZone.calendarZone), localZone (EventZone.localZone) }.
     */
    function plan(existing, text, opts = {}) {
        if (typeof text === 'string' && text.length > MAX_BYTES) throw new ImportError('too_big', 'That file is over 2 MB.');
        const file = parse(text);
        if (!file.events.length) throw new ImportError('empty', 'No events in that file.');
        if (file.events.length > MAX_EVENTS) throw new ImportError('too_many', `That file has more than ${MAX_EVENTS} events.`);
        const localZone = EventZone.validZone(opts.localZone) || EventZone.localZone();
        const calZone = EventZone.validZone(opts.calZone) || null;
        const fileZone = zoneOf(file.zone);
        const ctx = { calZone, localZone, floatZone: fileZone || calZone || localZone, floatExplicit: !!fileZone };

        const rows = (existing || []).filter((e) => e && typeof e === 'object');
        const byKey = new Map(rows.map((e) => [EventStore.keyOf(e), e]));
        const series = new Map();   // id -> existing row with no recurrenceID
        for (const e of rows) if (e.recurrenceID === null || e.recurrenceID === undefined || e.recurrenceID === '') series.set(String(e.id), e);
        const seen = new Map();     // sameEventKey -> true, for existing rows and what this import adds
        for (const e of rows) if (!e.recurrenceID && e.start && e.end) seen.set(sameEventKey(e), String(e.id));

        const adds = new Map();     // key -> row to add (parents first: insertion order)
        const updates = new Map();  // key -> { target, row (what it should become) }
        const touched = new Set();  // keys this import already decided (a row twice in one file counts once)
        const idMap = new Map();    // a file's series id or UID -> the id it has here
        let skip = 0, unreadable = 0;

        const current = (key) => (updates.has(key) ? updates.get(key).row : adds.get(key) || byKey.get(key));
        const skipStamp = (parentId, stamp) => {   // an override's original start, skipped in its series
            const key = EventStore.keyOf({ id: parentId, recurrenceID: null });
            const parent = current(key);
            if (!parent) return;
            const zone = EventZone.seriesZone(parent, calZone) || localZone;
            const have = stampsOf(parent.recurrenceException);
            if (have.some((s) => slotDay(s, !!parent.isAllDay, zone) === slotDay(stamp, !!parent.isAllDay, zone))) return;
            const next = { ...parent, recurrenceException: [...have, stamp].join(',') };
            if (adds.has(key)) adds.set(key, next);
            else updates.set(key, { target: byKey.get(key), row: next });
        };
        // One incoming row against what is here: the same row (identical: skip; else update), the same event (skip), or new.
        const consider = (row, imported) => {
            const key = EventStore.keyOf(row);
            if (touched.has(key)) { skip++; return; }
            touched.add(key);
            const have = byKey.get(key);
            if (have) {
                const next = imported ? inTermsOf(have, row, ctx, imported) : row;
                const diff = EventStore.diff(EventStore.normalize(have), EventStore.normalize(next));
                if (!Object.keys(diff).length) { skip++; return; }
                updates.set(key, { target: have, row: { ...(updates.has(key) ? updates.get(key).row : have), ...diff } });
                return;
            }
            if (!row.recurrenceID) {
                const same = seen.get(sameEventKey(row));
                if (same !== undefined) { skip++; return same; }
                seen.set(sameEventKey(row), String(row.id));
            }
            adds.set(key, row);
        };

        // Backup rows and standard events, series before their edited occurrences.
        const backups = [], masters = [], overrides = [];
        for (const ev of file.events) {
            const row = backupRow(ev);
            if (row) { backups.push(row); continue; }
            const x = fromVevent(ev, ctx);
            if (!x.row) { unreadable++; continue; }
            if (!x.uid) x.uid = idFor(JSON.stringify(x.row));   // no UID: its content is its identity
            (x.rid ? overrides : masters).push(x);
        }
        backups.sort((a, b) => (a.recurrenceID ? 1 : 0) - (b.recurrenceID ? 1 : 0));
        const fileSeries = new Set(backups.filter((r) => !r.recurrenceID).map((r) => String(r.id)));

        for (const row of backups) {
            if (EventStore.unsafeRecurrence(row.recurrencerule) || !row.start || !row.end || new Date(row.end) < new Date(row.start)) { unreadable++; continue; }
            if (row.recurrenceID) {
                const parent = idMap.get(String(row.recurrenceID)) ?? (series.has(String(row.recurrenceID)) || fileSeries.has(String(row.recurrenceID)) ? row.recurrenceID : null);
                // Its series is neither here nor in the file: kept as an event of its own (a row pointing at nothing is refused).
                const r = parent === null ? { ...row, ...EventStore.COPY_RESETS } : { ...row, recurrenceID: parent };
                consider(r, null);
                continue;
            }
            const same = consider(row, null);
            idMap.set(String(row.id), same !== undefined ? same : row.id);
        }
        for (const x of masters) {
            if (x.cancelled) { skip++; continue; }
            const asId = uidId(x.uid);
            const here = series.has(asId) ? series.get(asId).id : series.has(idFor(x.uid)) ? idFor(x.uid) : null;
            const row = { ...x.row, id: here !== null ? here : idFor(x.uid), recurrenceID: null };
            const same = consider(row, x);
            idMap.set(x.uid, same !== undefined ? same : row.id);
        }
        for (const x of overrides) {
            const parentId = idMap.has(x.uid) ? idMap.get(x.uid) : series.has(uidId(x.uid)) ? series.get(uidId(x.uid)).id : null;
            const parentKey = parentId === null ? null : EventStore.keyOf({ id: parentId, recurrenceID: null });
            const parent = parentKey && current(parentKey);
            if (!parent || !parent.recurrencerule) {
                // An occurrence of a series that is not here: an event of its own (a cancelled one: nothing).
                if (x.cancelled) { skip++; continue; }
                consider({ ...x.row, id: idFor(x.uid, x.rid), recurrenceID: null }, x);
                continue;
            }
            skipStamp(parentId, x.rid);
            if (x.cancelled) continue;
            // Its edited row here already: the one of this series on the same original day.
            const zone = EventZone.seriesZone(parent, calZone) || localZone;
            const day = slotDay(x.rid, !!parent.isAllDay, zone);
            const mine = rows.find((e) => e.recurrenceID !== null && e.recurrenceID !== undefined && String(e.recurrenceID) === String(parentId)
                && stampsOf(e.recurrenceException).some((s) => slotDay(s, !!parent.isAllDay, zone) === day));
            const id = mine ? mine.id : idFor(x.uid, x.rid);
            const row = { ...x.row, id, recurrenceID: parentId, recurrencerule: parent.recurrencerule, recurrenceException: x.rid };
            // (An edited occurrence keeps its series' zone, as the editor's does.)
            if (!x.row.tz && parent.tz && (!x.explicit || x.zone === parent.tz)) row.tz = parent.tz;
            if (mine) row.recurrenceException = mine.recurrenceException;
            consider(row, x);
        }

        if (rows.length + adds.size > MAX_EVENTS) throw new ImportError('too_many', `That would put more than ${MAX_EVENTS} events in this calendar.`);
        // What the calendar's events would weigh (the server refuses a calendar over 2 MB); bytes: for a draft's first save.
        const bytes = JSON.stringify(rows).length + JSON.stringify([...adds.values()]).length;
        if (bytes > MAX_CALENDAR) throw new ImportError('too_big', 'That would make this calendar larger than 2 MB.');
        const commands = [];
        for (const row of adds.values()) commands.push({ type: 'add', event: row });
        for (const [key, u] of updates) {
            const changes = EventStore.diff(EventStore.normalize(u.target), EventStore.normalize(u.row));
            if (Object.keys(changes).length) commands.push({ type: 'update', key, changes });
        }
        return { commands, add: adds.size, update: commands.length - adds.size, skip, unreadable, name: file.name, bytes };
    }

    /** "Add 12 events, update 2, skip 30 already here." The plan in one line. */
    function summary(p) {
        const n = (k, one, many) => (k === 1 ? one : many.replace('#', k));
        const parts = [];
        if (p.add) parts.push(n(p.add, 'Add 1 event', 'Add # events'));
        if (p.update) parts.push(parts.length ? `update ${p.update}` : n(p.update, 'Update 1 event', 'Update # events'));
        if (p.skip) parts.push(parts.length ? `skip ${p.skip} already here` : `All ${p.skip} already here`);
        if (p.unreadable) parts.push(`${p.unreadable} can’t be read`);
        return parts.length ? `${parts.join(', ')}.` : 'Nothing to import.';
    }

    const ICSImport = { parse, plan, summary, idFor, ruleKey, unescapeText, ImportError, MAX_BYTES, MAX_EVENTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = ICSImport;
    else root.ICSImport = ICSImport;
})(typeof window !== 'undefined' ? window : globalThis);
