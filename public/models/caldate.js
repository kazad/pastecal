/*
 * caldate.js -- the ONE place that decides what calendar date a stored value names.
 *
 * SOURCE OF TRUTH: functions/caldate.js. public/models/caldate.js is a byte-identical copy
 * (only functions/ is uploaded as the Cloud Functions source, and hosting only serves
 * public/), made by scripts/sync-shared.sh, which deploy.sh runs before every deploy.
 * test/unit/caldate.test.js fails if the two copies differ. Edit this file, then run
 * scripts/sync-shared.sh.
 *
 * Why it exists: the grid (public/models/Event.js) and the ICS feed (functions/index.js)
 * each had their own copy of this mapping, and the copies drifted -- a floating EXDATE
 * "20261009T120000" on an all-day series read as Oct 9 in the grid and Oct 10 in the feed.
 * Both now call this module, so they cannot disagree.
 *
 * Pure: no DOM, no Node APIs. Every function that says "local" uses the JS runtime's zone
 * (the viewer's, in a browser); everything else is zone-independent.
 *
 * Formats:
 *   ymd       "2026-10-02"           a calendar date
 *   stamp     "20261002T150000Z"     an instant (RRULE UNTIL / EXDATE, as Syncfusion writes)
 *             "20261002T000000"      FLOATING: a wall-clock time with no zone. Its Y-M-D is
 *                                    the date it names, everywhere (decided once, here).
 *             "20261002"             a DATE
 *   instant   ISO string, epoch ms or Date
 */
(function (root, factory) {
    if (typeof module === 'object' && module && module.exports) module.exports = factory();
    else root.CalDate = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const HOUR = 3600000;
    const DAY = 24 * HOUR;
    const pad = (n, w = 2) => String(n).padStart(w, '0');

    // ---- calendar dates ------------------------------------------------------------------

    function isYmd(s) {
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
        return ymdFromUTC(utcOfYmd(s)) === s; // rejects 2026-02-30
    }

    // UTC midnight (ms) of a ymd, or NaN.
    function utcOfYmd(ymd) {
        const m = typeof ymd === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
    }

    // The UTC calendar date of an instant, or null.
    function ymdFromUTC(ms) {
        const d = new Date(ms);
        if (isNaN(d.getTime())) return null;
        return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }

    function addDays(ymd, n) {
        const ms = utcOfYmd(ymd);
        return isNaN(ms) ? null : ymdFromUTC(ms + n * DAY);
    }

    // "2026-10-02" -> "20261002" (an iCalendar DATE).
    function compact(ymd) {
        return typeof ymd === 'string' ? ymd.replace(/-/g, '') : null;
    }

    // The LOCAL calendar date of an instant (the viewer's wall clock), or null.
    function localYmd(value) {
        const ms = toMs(value);
        if (isNaN(ms)) return null;
        const d = new Date(ms);
        return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // LOCAL midnight of a ymd (plus n days), as a Date, or null.
    function localMidnight(ymd, n = 0) {
        const m = typeof ymd === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
        return m ? new Date(+m[1], +m[2] - 1, +m[3] + n) : null;
    }

    // ---- stamps --------------------------------------------------------------------------

    // { ms, utc, dateOnly } for a stamp, or null. A floating or DATE stamp's ms is its wall
    // clock read as UTC fields (so its UTC Y-M-D is the date it names).
    function parseStamp(stamp) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(String(stamp ?? '').trim());
        if (!m) return null;
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
        if (isNaN(ms)) return null;
        return { ms, utc: !!m[7], dateOnly: !m[4] };
    }

    // An instant -> "YYYYMMDDTHHMMSSZ", or null.
    function utcStamp(value) {
        const ms = toMs(value);
        if (isNaN(ms)) return null;
        const out = new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        return /^\d{8}T\d{6}Z$/.test(out) ? out : null;
    }

    // A date -> the floating stamp at its start ("20261002T000000"). How an all-day series
    // stores EXDATE and UNTIL: every reader takes the same date from it -- this module,
    // Syncfusion (parses it as the viewer's local midnight of that date, as it does an old
    // tab), and the ICS feed -- in every zone, which a UTC instant cannot do.
    function floatingStamp(ymd) {
        return isYmd(ymd) ? `${compact(ymd)}T000000` : null;
    }

    // Epoch ms for anything stored: Date, epoch number, ISO string, or a stamp (floating
    // stamps read as UTC fields). NaN if unusable.
    function toMs(value) {
        if (value === null || value === undefined || value === '') return NaN;
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const s = parseStamp(value);
            if (s) return s.ms;
            return new Date(value).getTime();
        }
        return NaN;
    }

    // ---- the mapping ---------------------------------------------------------------------

    // The date a stored all-day INSTANT names. Legacy all-day values are the WRITER's local
    // midnight as a UTC instant (Tokyo's Oct 2 is 2026-10-01T15:00Z) and the writer's zone
    // was never stored, but local midnight falls in a known window around UTC midnight, so
    // floor((ms + 13h + 1s) / 1 day) is the date for writers from just east of UTC-11
    // through UTC+13. The extra second reads nativecal's inclusive end (local 23:59:59.999
    // of the last day) as the next date even at UTC+13. Offsets span 25 hours and a day has
    // 24, so UTC-11 and UTC+14 fall outside: that is why all-day events now also store
    // their dates (allDayDates), and why this is only the fallback for rows without them.
    function instantDate(value) {
        const ms = toMs(value);
        if (isNaN(ms)) return null;
        return ymdFromUTC(Math.floor((ms + 13 * HOUR + 1000) / DAY) * DAY);
    }

    // The date an all-day series' stamp (EXDATE / UNTIL) names, or null. A floating or DATE
    // stamp is a wall-clock date: its own Y-M-D. A UTC stamp is an instant: instantDate.
    function stampDate(stamp) {
        const s = parseStamp(stamp);
        if (!s) return null;
        return s.utc ? instantDate(s.ms) : ymdFromUTC(s.ms);
    }

    // Do stored dates describe this start/end? Each instant must be some writer's local
    // midnight of its date (UTC-12 .. UTC+14), the end possibly 1ms short (nativecal's
    // inclusive end). Clients that predate the field drop it when they save, so presence
    // implies consistency; this check is the backstop for any write that changed start/end
    // and carried stale dates along.
    function datesMatch(dates, start, end) {
        if (!dates || !isYmd(dates.start) || !isYmd(dates.end) || dates.end <= dates.start) return false;
        const near = (ms, ymd) => {
            const off = ms - utcOfYmd(ymd);
            return off >= -14 * HOUR - 1000 && off <= 12 * HOUR + 1000;
        };
        const s = toMs(start), e = toMs(end);
        if (isNaN(s) || !near(s, dates.start)) return false;
        if (isNaN(e)) return true;
        // A zero-length stored range reads as its one day.
        if (e <= s) return dates.end === addDays(dates.start, 1);
        return near(e, dates.end);
    }

    // The dates an all-day event covers: { start, end } ymd, end EXCLUSIVE, or null if it
    // has no usable start. Stored dates win when they match start/end; otherwise each
    // instant goes through instantDate. An end at or before the start reads as one day.
    function allDayDates(event) {
        if (!event) return null;
        const stored = event.allDayDates;
        if (stored && datesMatch(stored, event.start, event.end)) {
            return { start: stored.start, end: stored.end };
        }
        const start = instantDate(event.start);
        if (!start) return null;
        let end = instantDate(event.end);
        if (!end || end <= start) end = addDays(start, 1);
        return { start, end };
    }

    // A comparable key for "which days does this event cover", or null for a timed event.
    // For merge/history equality: a row with dates and the same row without them (as an old
    // client writes it) are the same event when they name the same days.
    function allDayKey(event) {
        if (!event || !event.isAllDay) return null;
        const d = allDayDates(event);
        return d ? `${d.start}/${d.end}` : null;
    }

    return {
        HOUR, DAY,
        isYmd, utcOfYmd, ymdFromUTC, addDays, compact, localYmd, localMidnight,
        parseStamp, utcStamp, floatingStamp, toMs,
        instantDate, stampDate, datesMatch, allDayDates, allDayKey,
    };
}));
