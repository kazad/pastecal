/**
 * EventZone -- an event's own time zone (event.tz, an IANA name such as "Asia/Tokyo").
 *
 * Events store instants (UTC ISO start/end); each viewer sees them in their own zone. An event may also name the
 * zone it is planned in: the card then shows and edits its times in that zone ("2:00 PM" with Tokyo picked means
 * 2 PM in Tokyo), a repeating one repeats in that zone's wall clock (a weekly 2 PM Tokyo meeting stays 2 PM Tokyo
 * across every DST change elsewhere), and the calendar feed names it (DTSTART;TZID=Asia/Tokyo). No tz (absent or
 * '') is every event before this: shown and repeated in each viewer's own zone. All-day events ignore it.
 *
 * Pure: no page, no app. Loaded as a script (window.EventZone) and required by node tests; the Worker imports it.
 *
 *   validZone(tz)              the canonical IANA name, or null
 *   wall(ms, tz)               { y, m (0-11), d, h, min, s } of an instant in tz
 *   fromWall(y, m, d, h, min, s, tz)   the instant whose wall clock in tz reads that. A time skipped by DST moves
 *                              forward by the gap (2:30 on spring-forward is 3:30); a repeated one is the first.
 *   floating(ms, tz) / unfloating(f, tz)   the wall clock in tz as a Date whose UTC fields read it, and back: the one
 *                              wall-time frame (rrule's floating frame; the event card's values, nativecal/cardKit.js).
 *                              Never a Date whose LOCAL fields read it: the viewer's zone has its own DST gaps, and
 *                              2:30 AM on the day Los Angeles springs forward became 3:30 there (stress S01).
 *   occurrences(ev, from, to, RRule)  a series in its own zone, expanded there (both calendars draw this)
 *   shiftBy(from, to, tz)      a function moving a time by as many wall-clock days and minutes in tz as from -> to
 *   localZone()                this browser's zone
 *   zoneName(tz) "Japan Time", zoneCity(tz) "Tokyo", zoneLabel(tz) "Tokyo — Japan Time"
 *   zones()                    every zone the browser knows, labeled, for search (cached)
 *   COMMON                     the zones offered before searching
 */
(function (root) {
    'use strict';

    const DAY_MS = 86400000;
    const dtfs = new Map();
    const dtf = (tz) => {
        let f = dtfs.get(tz);
        if (!f) {
            f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
            dtfs.set(tz, f);
        }
        return f;
    };

    /** A valid IANA zone name (canonical spelling), or null. The same rule as the calendar's own zone (CalendarRoom). */
    function validZone(tz) {
        if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
        try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; } catch (e) { return null; }
    }

    function wall(ms, tz) {
        const p = {};
        for (const x of dtf(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
        return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second };
    }
    /** Minutes tz is ahead of UTC at instant ms (Tokyo: 540, Los Angeles in summer: -420). */
    function offsetMin(tz, ms) {
        const w = wall(ms, tz);
        return Math.round((Date.UTC(w.y, w.m, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000) / 60000);
    }
    function fromWall(y, m, d, h, min, s, tz) {
        const guess = Date.UTC(y, m, d, h, min, s || 0);
        const before = offsetMin(tz, guess - DAY_MS / 2), after = offsetMin(tz, guess + DAY_MS / 2);
        const hits = [];
        for (const o of new Set([before, after])) {
            const ms = guess - o * 60000;
            const w = wall(ms, tz);
            if (Date.UTC(w.y, w.m, w.d, w.h, w.min, w.s) === guess) hits.push(ms);
        }
        if (hits.length) return Math.min(...hits);
        return guess - before * 60000;   // skipped by DST: read with the offset before the change, i.e. moved forward
    }

    const floating = (ms, tz) => { const t = new Date(ms).getTime(), w = wall(t, tz); return new Date(Date.UTC(w.y, w.m, w.d, w.h, w.min, w.s) + (((t % 1000) + 1000) % 1000)); };
    const unfloating = (f, tz) => new Date(fromWall(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), f.getUTCHours(), f.getUTCMinutes(), f.getUTCSeconds(), tz) + f.getUTCMilliseconds());

    /**
     * Moving `from` to `to` as wall-clock days and minutes in zone tz (none: this browser's), applied to another time:
     * a series moved with one of its occurrences, its skipped dates with it. Across a DST change the clock time stays.
     */
    function shiftBy(from, to, tz) {
        const z = validZone(tz) || localZone();
        const a = floating(new Date(from).getTime(), z), b = floating(new Date(to).getTime(), z);
        const day = (f) => Math.floor(f.getTime() / DAY_MS), mins = (f) => f.getUTCHours() * 60 + f.getUTCMinutes();
        const by = (day(b) - day(a)) * DAY_MS + (mins(b) - mins(a)) * 60000;
        return (t) => unfloating(new Date(floating(new Date(t).getTime(), z).getTime() + by), z);
    }

    // ---- a series in its own zone ---------------------------------------------------------------------------
    const pad2 = (n) => String(n).padStart(2, '0');
    const ymdKey = (y, m, d) => `${y}${pad2(m + 1)}${pad2(d)}`;
    /**
     * The DATE ('YYYYMMDD') a day stamp names: a floating stamp or a bare date as written; a UTC one as its WRITER's
     * local midnight ("20261012T150000Z" is Tokyo's Oct 13), from just east of UTC-11 to UTC+13 (models/Event.js).
     */
    function stampDay(s) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(String(s).trim());
        if (!m) return null;
        if (!m[4] || !m[7]) return m[1] + m[2] + m[3];
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        const d = new Date(Math.floor((ms + 13 * 3600000 + 1000) / DAY_MS) * DAY_MS);
        return ymdKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    /**
     * The occurrences of a timed series in its own zone (ev.tz) overlapping [rangeStart, rangeEnd): [{ start, end }]
     * instants. It repeats in THAT zone's wall clock: a weekly 2 PM Tokyo meeting stays 2 PM Tokyo across DST and lands
     * on Tokyo's weekday, wherever it is viewed. A skipped date is the zone's day of its stamp; UNTIL names a day (its
     * writer's local midnight), through its end in the zone. RRule: rrule.js's class (the page's window.rrule.RRule).
     * The one expansion both calendars draw: NativeCalendar, and classic's grid (ScheduleAdapter.toView), which would
     * otherwise repeat it in the VIEWER's zone, on other days (stress S09). null if it cannot be expanded.
     */
    function occurrences(ev, rangeStart, rangeEnd, RRule, max = 2000) {
        const zone = ev && !ev.isAllDay && validZone(ev.tz);
        if (!zone || !ev.recurrencerule || !RRule) return null;
        const start = new Date(ev.start), duration = new Date(ev.end) - start;
        if (isNaN(start) || isNaN(duration)) return null;
        const zoneDay = (ms) => { const w = wall(ms, zone); return ymdKey(w.y, w.m, w.d); };
        const excluded = new Set(String(ev.recurrenceException || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
            const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(x);
            if (!m) return null;
            return !m[4] || !m[7] ? m[1] + m[2] + m[3] : zoneDay(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
        }).filter(Boolean));
        let rule;
        try {
            const clean = String(ev.recurrencerule).replace(/^RRULE:/i, '').split(';').filter((p) => p.includes('=')).join(';');
            const opts = RRule.parseString(clean);
            if (opts.until) { const k = stampDay(opts.until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')); if (k) opts.until = new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), 23, 59, 59)); }
            rule = new RRule({ ...opts, dtstart: floating(start.getTime(), zone) });
        } catch (e) { return null; }
        const out = [];
        const from = floating(new Date(rangeStart).getTime() - duration - DAY_MS, zone), to = floating(new Date(rangeEnd).getTime() + DAY_MS, zone);
        for (const f of rule.between(from, to, true, (d, i) => i < max)) {
            if (excluded.has(ymdKey(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate()))) continue;
            const s = unfloating(f, zone), e = new Date(s.getTime() + duration);
            if (e <= rangeStart || s >= rangeEnd) continue;
            out.push({ start: s, end: e });
        }
        return out;
    }

    function localZone() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
    }

    // ---- names ----------------------------------------------------------------------------------------------
    // The zones offered before anything is typed (the rest are a search away).
    const COMMON = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York',
        'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo',
        'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Lagos', 'Africa/Johannesburg', 'Asia/Dubai',
        'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'];

    const names = new Map();
    /** "Pacific Time", "Japan Time", "Central European Time". Outside the Americas, Intl's "Standard" is dropped
     *  ("Japan Standard Time" reads as "Japan Time"); there it says which half of a DST pair a place keeps
     *  (Phoenix: "Mountain Standard Time"). */
    function zoneName(tz) {
        if (!tz) return '';
        if (names.has(tz)) return names.get(tz);
        let n = '';
        if (tz === 'UTC' || tz === 'Etc/UTC') n = 'UTC';
        else {
            try {
                const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
                n = (p && p.value) || '';
            } catch (e) { n = ''; }
            if (!n || /^GMT[+-]/.test(n)) n = n || zoneCity(tz);
            else if (!/^America\//.test(tz)) n = n.replace(/ Standard Time$/, ' Time');
        }
        names.set(tz, n);
        return n;
    }
    /** "Tokyo", "Los Angeles", "Buenos Aires" (the zone's last part, readable). */
    function zoneCity(tz) {
        if (!tz) return '';
        if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
        return String(tz).split('/').pop().replace(/_/g, ' ');
    }
    /** "Tokyo — Japan Time" (a list row: the place, then what its clocks are called). */
    function zoneLabel(tz) {
        const c = zoneCity(tz), n = zoneName(tz);
        return !n || c === n ? c : `${c} — ${n}`;
    }
    let all = null;
    /** Every zone this browser knows, as { id, label, search } (search: lowercase words to match), cached. */
    function zones() {
        if (all) return all;
        let ids = [];
        try { ids = Intl.supportedValuesOf('timeZone'); } catch (e) { ids = COMMON.slice(); }
        if (!ids.includes('UTC')) ids = [...ids, 'UTC'];
        all = ids.map((id) => {
            const label = zoneLabel(id);
            return { id, label, search: `${id.replace(/[_/]/g, ' ')} ${label}`.toLowerCase() };
        });
        return all;
    }
    /** The zones matching what was typed ("tok", "japan", "new york", "pacific"), best first, at most `max`. */
    function searchZones(text, max = 50) {
        const q = String(text || '').trim().toLowerCase();
        if (!q) return [];
        const words = q.split(/\s+/);
        const hits = zones().filter((z) => words.every((w) => z.search.includes(w)));
        const rank = (z) => (z.label.toLowerCase().startsWith(q) ? 0 : z.search.split(/\s+/).some((w) => w.startsWith(words[0])) ? 1 : 2);
        return hits.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)).slice(0, max);
    }

    const EventZone = { DAY_MS, COMMON, validZone, wall, offsetMin, fromWall, floating, unfloating, shiftBy, stampDay, occurrences,
        localZone, zoneName, zoneCity, zoneLabel, zones, searchZones };
    if (typeof module !== 'undefined' && module.exports) module.exports = EventZone;
    else root.EventZone = EventZone;
})(typeof window !== 'undefined' ? window : globalThis);
