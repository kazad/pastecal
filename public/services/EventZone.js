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
 *   toWallDate(date, tz)       a Date whose LOCAL fields read tz's wall clock (what a picker built on local
 *                              getters edits); fromWallDate is the way back
 *   floating(ms, tz) / unfloating(f, tz)   the same wall clock as a UTC-fields Date (rrule's floating frame)
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

    const toWallDate = (date, tz) => {
        const ms = new Date(date).getTime(), w = wall(ms, tz);
        return new Date(w.y, w.m, w.d, w.h, w.min, w.s, ((ms % 1000) + 1000) % 1000);
    };
    const fromWallDate = (date, tz) => {
        const d = new Date(date);
        return new Date(fromWall(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), tz) + d.getMilliseconds());
    };
    const floating = (ms, tz) => { const w = wall(new Date(ms).getTime(), tz); return new Date(Date.UTC(w.y, w.m, w.d, w.h, w.min, w.s)); };
    const unfloating = (f, tz) => new Date(fromWall(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), f.getUTCHours(), f.getUTCMinutes(), f.getUTCSeconds(), tz));

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

    const EventZone = { DAY_MS, COMMON, validZone, wall, offsetMin, fromWall, toWallDate, fromWallDate, floating, unfloating,
        localZone, zoneName, zoneCity, zoneLabel, zones, searchZones };
    if (typeof module !== 'undefined' && module.exports) module.exports = EventZone;
    else root.EventZone = EventZone;
})(typeof window !== 'undefined' ? window : globalThis);
