/**
 * Dates for link previews and calendar images: which time zone to show, and which events fall in a range.
 *
 * pastecal stores no time zone for a calendar: timed events are UTC instants that each viewer's browser
 * shows in its own zone. A server-drawn image has no viewer, so it picks one zone:
 *   1. the image link's ?tz= (an IANA name), if valid;
 *   2. else the zone the calendar's authors work in, read from its all-day events: those are stored as
 *      the author's local midnight (Event.allDayDateUTC), so their UTC offsets name the zone. The zone
 *      whose offsets match the most of them, on their own dates (so daylight saving is right), wins;
 *   3. else UTC.
 * The image says which zone it used ("Times in PDT") whenever it shows times.
 *
 * Recurrence follows NativeCalendar.occurrencesBetween: the rule (rrule 2.8.1, the same version the app
 * loads) runs in "floating" wall-clock time in that zone, so 9:00 stays 9:00 across a DST change;
 * recurrenceException excludes occurrences compared to the minute (or by date); a row with recurrenceID
 * is one edited occurrence, never a second series. All-day dates use the app's read rule:
 * floor((ms + 13h + 1s) / 1 day).
 */
import rrulePkg from '../vendor/rrule-2.8.1.esm.js';
const { RRule } = rrulePkg;

export const DAY_MS = 86400000;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---- zones ----------------------------------------------------------------------------------
const dtfCache = new Map();
function dtf(tz) {
    if (!dtfCache.has(tz)) {
        dtfCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
    }
    return dtfCache.get(tz);
}
/** A valid IANA zone name (canonical spelling), or null. */
export function validZone(tz) {
    if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}
/** Wall-clock fields of instant ms in tz: {y, m (0-11), d, h, min, s, dow (0=Sun)}. */
export function wall(ms, tz) {
    const p = {};
    for (const x of dtf(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, dow: WEEKDAYS.indexOf(p.weekday) };
}
/** Offset of tz from UTC at instant ms, in minutes (PDT: -420). */
export function offsetMin(tz, ms) {
    const w = wall(ms, tz);
    return Math.round((Date.UTC(w.y, w.m, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000) / 60000);
}
/** The instant whose wall clock in tz reads these fields (a skipped DST hour moves forward). */
export function fromWall(y, m, d, h, min, tz) {
    const guess = Date.UTC(y, m, d, h, min);
    let ms = guess - offsetMin(tz, guess) * 60000;
    ms = guess - offsetMin(tz, ms) * 60000;
    return ms;
}
/** "PDT", "GMT+2", "UTC": the short name a reader recognizes. */
export function zoneLabel(tz, ms) {
    if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
    try {
        const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms));
        return (p.find((x) => x.type === 'timeZoneName') || {}).value || tz;
    } catch { return tz; }
}

// Zones tried when guessing from all-day events: the common ones, so the guess is a real place with real DST.
const CANDIDATE_ZONES = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York',
    'America/Halifax', 'America/St_Johns', 'America/Anchorage', 'Pacific/Honolulu', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
    'America/Mexico_City', 'America/Bogota', 'Europe/London', 'Europe/Paris', 'Europe/Athens', 'Europe/Moscow', 'Africa/Lagos',
    'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai',
    'Asia/Seoul', 'Asia/Tokyo', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'UTC'];

/**
 * The zone a calendar's authors work in, from its all-day events (see the header), or null.
 * Uses up to 40 all-day events, most recent first; needs at least one whose time is not UTC midnight
 * (UTC midnight is also what an all-day event from a UTC author or an unreleased build looks like).
 */
export function inferZone(events) {
    const samples = [];
    for (const e of events || []) {
        if (!e || !e.isAllDay || !e.start) continue;
        const ms = Date.parse(e.start);
        if (isNaN(ms)) continue;
        samples.push(ms);
    }
    if (!samples.length) return null;
    samples.sort((a, b) => b - a);
    const use = samples.slice(0, 40);
    // The author's local midnight at instant ms means offset = -(ms mod day) (or +day - that, east of UTC).
    const offs = use.map((ms) => {
        let o = -Math.round(((ms % DAY_MS) + DAY_MS) % DAY_MS / 60000);   // minutes, in (-1440, 0]
        if (o < -12 * 60) o += 1440;                                          // east of UTC
        return o;
    });
    if (offs.every((o) => o === 0)) return null;
    let best = null, bestScore = 0;
    for (const tz of CANDIDATE_ZONES) {
        let score = 0;
        for (let i = 0; i < use.length; i++) if (offsetMin(tz, use[i]) === offs[i]) score++;
        if (score > bestScore) { best = tz; bestScore = score; }
    }
    return bestScore >= Math.ceil(use.length / 2) ? best : null;
}
/**
 * The same guess, only when it can be trusted for clock times: at least 3 all-day samples and 80% of
 * them agreeing on one zone. A wrong time on a link card is worse than no time, so anything weaker is null.
 */
export function confidentZone(events) {
    const all = (events || []).filter((e) => e && e.isAllDay && e.start && !isNaN(Date.parse(e.start)));
    const use = all.map((e) => Date.parse(e.start)).sort((a, b) => b - a).slice(0, 40);
    if (use.length < 3) return null;
    const tz = inferZone(all);
    if (!tz) return null;
    const agree = use.filter((ms) => {
        let o = -Math.round(((ms % DAY_MS) + DAY_MS) % DAY_MS / 60000);
        if (o < -12 * 60) o += 1440;
        return offsetMin(tz, ms) === o;
    }).length;
    return agree >= Math.ceil(use.length * 0.8) ? tz : null;
}

// ---- dates as day numbers (UTC-midnight ms of a calendar date) ---------------------------------
export const dayKey = (y, m, d) => Date.UTC(y, m, d);
export const dayOf = (ms, tz) => { const w = wall(ms, tz); return dayKey(w.y, w.m, w.d); };
/** The calendar date an all-day stored instant names (the app's read rule). */
export const allDayDay = (v) => Math.floor((Date.parse(v) + 13 * 3600000 + 1000) / DAY_MS) * DAY_MS;
export const isoDay = (day) => new Date(day).toISOString().slice(0, 10);

const toFloat = (ms, tz) => { const w = wall(ms, tz); return new Date(Date.UTC(w.y, w.m, w.d, w.h, w.min, w.s)); };
const fromFloat = (f, tz) => fromWall(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), f.getUTCHours(), f.getUTCMinutes(), tz);
const stampMin = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 13);   // 20261025T1700

/**
 * Occurrences overlapping [fromMs, toMs) in zone tz, sorted by start:
 *   [{title, type, allDay, start, end (ms instants; all-day: day numbers, end exclusive), key}]
 * At most `perSeries` occurrences per recurring event (a guard, not a feature).
 */
export function occurrences(events, fromMs, toMs, tz, { perSeries = 400 } = {}) {
    const out = [];
    for (const ev of events || []) {
        if (!ev || !ev.start || !ev.end) continue;
        const allDay = !!ev.isAllDay;
        let start, end;
        if (allDay) {
            start = allDayDay(ev.start); end = allDayDay(ev.end);
            if (isNaN(start)) continue;
            if (isNaN(end) || end <= start) end = start + DAY_MS;
        } else {
            start = Date.parse(ev.start); end = Date.parse(ev.end);
            if (isNaN(start)) continue;
            if (isNaN(end) || end < start) end = start;
        }
        const base = { title: ev.title, type: ev.type, allDay, id: ev.id };
        // All-day ranges are compared as day numbers: the range's dates in tz.
        const rFrom = allDay ? dayOf(fromMs, tz) : fromMs;
        const rTo = allDay ? dayOf(toMs - 1, tz) + DAY_MS : toMs;

        if (ev.recurrencerule && !ev.recurrenceID) {
            const occ = expand(ev, start, end, allDay, rFrom, rTo, tz, perSeries);
            if (occ) { for (const o of occ) out.push({ ...base, ...o }); continue; }
        }
        if (end > rFrom && start < rTo || (start === end && start >= rFrom && start < rTo)) {
            out.push({ ...base, start, end, key: `${ev.id}|${ev.recurrenceID || ''}` });
        }
    }
    return out.sort((a, b) => (sortKey(a, tz) - sortKey(b, tz)) || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1));
}
// All-day events sort at the start of their date in tz, before that day's timed events.
const sortKey = (o, tz) => (o.allDay ? fromWall(new Date(o.start).getUTCFullYear(), new Date(o.start).getUTCMonth(), new Date(o.start).getUTCDate(), 0, 0, tz) - 1 : o.start);

function expand(ev, start, end, allDay, rFrom, rTo, tz, cap) {
    const duration = end - start;
    let rule;
    try {
        const clean = String(ev.recurrencerule).replace(/^RRULE:/i, '').split(';').filter((p) => p.includes('=')).join(';');
        const opts = RRule.parseString(clean);
        // UNTIL names a local day; the series runs through the end of it (Syncfusion's reading).
        if (opts.until) {
            const u = allDay ? new Date(allDayDay(opts.until.toISOString())) : toFloat(opts.until.getTime(), tz);
            opts.until = new Date(Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 23, 59, 59));
        }
        rule = new RRule({ ...opts, dtstart: allDay ? new Date(start) : toFloat(start, tz) });
    } catch { return null; }
    const excluded = new Set();
    const excludedDays = new Set();
    for (const raw of String(ev.recurrenceException || '').split(',')) {
        const s = raw.trim();
        if (!s) continue;
        const m = /^(\d{8})(T(\d{4})\d{0,2}Z?)?$/.exec(s);
        if (!m) continue;
        if (m[2]) {
            excluded.add(`${m[1]}T${m[3]}`);
            const ms = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13));
            if (allDay) excludedDays.add(allDayDay(new Date(ms).toISOString()));
        } else {
            excludedDays.add(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
        }
    }
    const out = [];
    let from, to;
    if (allDay) { from = new Date(rFrom - duration); to = new Date(rTo); }
    else { from = toFloat(rFrom - duration, tz); to = toFloat(rTo, tz); }
    rule.between(from, to, true, (f) => {
        let s;
        if (allDay) s = Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate());
        else s = fromFloat(f, tz);
        const stampSource = allDay ? fromWall(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), 0, 0, tz) : s;
        const st = stampMin(stampSource);
        if (excluded.has(st) || (allDay && excludedDays.has(s)) || (!allDay && excludedDays.has(Date.UTC(+st.slice(0, 4), +st.slice(4, 6) - 1, +st.slice(6, 8))))) return true;
        const e = s + duration;
        if (e > rFrom && s < rTo || (duration === 0 && s >= rFrom && s < rTo)) out.push({ start: s, end: e, key: `${ev.id}@${s}` });
        return out.length < cap;
    });
    return out;
}

// ---- formatting ----------------------------------------------------------------------------
/** "7pm", "7:30pm" (the brand's style for times), in tz. */
export function fmtTime(ms, tz) {
    const w = wall(ms, tz);
    const h = w.h % 12 || 12;
    return `${h}${w.min ? ':' + String(w.min).padStart(2, '0') : ''}${w.h < 12 ? 'am' : 'pm'}`;
}
/** "Sat Oct 25" for a day number. */
export function fmtDay(day) {
    const d = new Date(day);
    return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
/** The day number an occurrence starts on, in tz. */
export function startDay(o, tz) { return o.allDay ? o.start : dayOf(o.start, tz); }
