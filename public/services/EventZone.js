/**
 * EventZone -- an event's own time zone (event.tz, an IANA name such as "Asia/Tokyo").
 *
 * Events store instants (UTC ISO start/end); each viewer sees them in their own zone. An event may also name the
 * zone it is planned in: the card then shows and edits its times in that zone ("2:00 PM" with Tokyo picked means
 * 2 PM in Tokyo), a repeating one repeats in that zone's wall clock (a weekly 2 PM Tokyo meeting stays 2 PM Tokyo
 * across every DST change elsewhere), and the calendar feed names it (DTSTART;TZID=Asia/Tokyo). No tz (absent or
 * '') is most events: an instant each viewer sees in their own zone, and, if it repeats, repeating in the CALENDAR's
 * zone (calendarZone; none known: each viewer's own), the same in the feed and both calendars. All-day events ignore it.
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
 *   occurrences(ev, from, to, RRule, max, calZone)  a series in its zone, expanded there (both calendars draw this)
 *   calendarZone(cal)          the calendar's zone: options.tz, else a confident guess from its all-day events, or null
 *   seriesZone(ev, calZone)    where a timed event repeats: its own zone, else the calendar's, or null
 *   untilDay(stamp, zone, own) the day a series' UNTIL names (it runs through its end there)
 *   inferZone / confidentZone  the guess from all-day events (link previews use it too)
 *   vtimezone(tz, from, through)  a VTIMEZONE for the calendar feed, from Intl
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
     * calZone: the calendar's zone (calendarZone), for a series without its own (seriesZone); its UNTIL is read as
     * untilDay says.
     */
    function occurrences(ev, rangeStart, rangeEnd, RRule, max = 2000, calZone = null) {
        const own = ev && !ev.isAllDay && validZone(ev.tz);
        const zone = seriesZone(ev, calZone);
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
            const rawUntil = (/(?:^|;)UNTIL=([^;]+)/i.exec(clean) || [])[1];
            if (opts.until) { const k = untilDay(rawUntil || opts.until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), zone, !!own); if (k) opts.until = new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), 23, 59, 59)); }
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

    // ---- the calendar's zone: where a series without its own zone repeats -----------------------------------
    // A repeat rule is wall-clock: "every Tuesday at 5 PM" means Tuesday 5 PM where it was planned, across DST. An event
    // stores an instant; the rule only says Tuesday and 5 PM in SOME zone. Expanding it in the wrong one put a Los
    // Angeles practice on Mondays for every feed subscriber (UTC, stress A02) and on other days for a viewer abroad
    // (their own zone). One answer, used by the feed (ICSService), both calendars (NativeCalendar, ScheduleAdapter's
    // grid) and link previews: the event's own zone, else the calendar's (calendarZone), else none (each viewer's own
    // zone in the app; UTC in the feed: what both did before, when nothing says where the calendar is).

    // Zones tried when guessing from all-day events: the common ones, so the guess is a real place with real DST.
    const CANDIDATE_ZONES = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York',
        'America/Halifax', 'America/St_Johns', 'America/Anchorage', 'Pacific/Honolulu', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
        'America/Mexico_City', 'America/Bogota', 'Europe/London', 'Europe/Paris', 'Europe/Athens', 'Europe/Moscow', 'Africa/Lagos',
        'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai',
        'Asia/Seoul', 'Asia/Tokyo', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'UTC'];
    // An all-day event is stored as its author's local midnight, so its UTC offset names the author's zone.
    const midnightOffset = (ms) => { let o = -Math.round((((ms % DAY_MS) + DAY_MS) % DAY_MS) / 60000); if (o < -12 * 60) o += 1440; return o; };
    const allDayStarts = (events) => {
        const out = [];
        for (const e of events || []) {
            if (!e || !e.isAllDay || !e.start) continue;
            const ms = new Date(e.start).getTime();
            if (!isNaN(ms)) out.push(ms);
        }
        return out.sort((a, b) => b - a).slice(0, 40);
    };
    /**
     * The zone a calendar's authors work in, from its all-day events (up to 40, most recent first), or null. Needs one
     * whose time is not UTC midnight (that is also what an all-day event from a UTC author looks like).
     */
    function inferZone(events) {
        const use = allDayStarts(events);
        if (!use.length) return null;
        const offs = use.map(midnightOffset);
        if (offs.every((o) => o === 0)) return null;
        let best = null, bestScore = 0;
        for (const tz of CANDIDATE_ZONES) {
            let score = 0;
            for (let i = 0; i < use.length; i++) if (offsetMin(tz, use[i]) === offs[i]) score++;
            if (score > bestScore) { best = tz; bestScore = score; }
        }
        return bestScore >= Math.ceil(use.length / 2) ? best : null;
    }
    /** The same guess, only when it can be trusted: at least 3 all-day samples and 80% of them agreeing on one zone. */
    function confidentZone(events) {
        const use = allDayStarts(events);
        if (use.length < 3) return null;
        const tz = inferZone(events);
        if (!tz) return null;
        const agree = use.filter((ms) => offsetMin(tz, ms) === midnightOffset(ms)).length;
        return agree >= Math.ceil(use.length * 0.8) ? tz : null;
    }
    const guessed = typeof WeakMap === 'function' ? new WeakMap() : null;
    /**
     * The calendar's zone: options.tz (an IANA name stored by the first browser that edits it, since Oct 25 2026), else a
     * confident guess from its all-day events (the calendars made before that), else null. cal: { options, events }.
     */
    function calendarZone(cal) {
        if (!cal) return null;
        const own = validZone(cal.options && cal.options.tz);
        if (own) return own;
        const events = cal.events;
        if (!events || typeof events !== 'object') return null;
        if (guessed && guessed.has(events)) return guessed.get(events);
        const tz = confidentZone(Array.isArray(events) ? events : Object.values(events));
        if (guessed) guessed.set(events, tz);
        return tz;
    }
    /** The zone a timed event's times repeat in: its own, else the calendar's (calZone), else null. All-day: null. */
    function seriesZone(ev, calZone) {
        if (!ev || ev.isAllDay) return null;
        return validZone(ev.tz) || validZone(calZone) || null;
    }
    /**
     * The day (YYYYMMDD) a series' UNTIL names, in `zone`; the series runs through its end there. A date or floating
     * stamp names its written date. A UTC stamp: for a series in its OWN zone (own: event.tz), the writer's local midnight
     * (stampDay: the card writes the day picked in the viewer's zone, who may be elsewhere); for a series in the
     * calendar's zone, the date of that instant in the zone (Syncfusion's reading, as the calendar's own viewers see it).
     */
    function untilDay(stamp, zone, own) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(String(stamp || '').trim());
        if (!m) return null;
        if (!m[4] || !m[7]) return m[1] + m[2] + m[3];
        if (own || !validZone(zone)) return stampDay(stamp);
        const w = wall(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), zone);
        return ymdKey(w.y, w.m, w.d);
    }

    // ---- VTIMEZONE: a zone's rules for a calendar feed ------------------------------------------------------
    // A feed that names TZID=Europe/London must define it: ical.js (Thunderbird, and the tests' reader) and Outlook
    // resolve a TZID only from the feed's own VTIMEZONE, and read an undefined one as floating, in the reader's zone.
    // Built from Intl: every offset change from `fromYear` through `throughYear`, then, when the last year's two
    // changes follow a yearly "nth (or last) weekday of a month" rule that Intl confirms for 20 more years, that rule.
    const vtzCache = new Map();
    const fmtOffset = (min) => { const s = min < 0 ? '-' : '+', a = Math.abs(min); return `${s}${pad2(Math.floor(a / 60))}${pad2(a % 60)}`; };
    const wallStamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`; };
    const offsetAt = (tz, ms) => offsetMin(tz, ms);
    /** Each offset change in [from, to): [{ ms, from, to }] (minutes). Weekly steps, then halved to the minute. */
    function transitions(tz, from, to) {
        const out = [], WEEK = 7 * DAY_MS;
        let t = from, o = offsetAt(tz, t);
        while (t < to) {
            const n = Math.min(t + WEEK, to), on = offsetAt(tz, n);
            if (on !== o) {
                let lo = t, hi = n;
                while (hi - lo > 60000) { const mid = lo + Math.floor((hi - lo) / 120000) * 60000; if (offsetAt(tz, mid) === o) lo = mid; else hi = mid; }
                out.push({ ms: hi, from: o, to: offsetAt(tz, hi) });
                o = offsetAt(tz, hi); t = hi;
                continue;
            }
            t = n;
        }
        return out;
    }
    const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    /** A transition as a yearly rule: { month, day: 'BYDAY' value, h, min } of its wall clock in the old offset. */
    function yearlyRule(t) {
        const local = new Date(t.ms + t.from * 60000);
        const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
        const last = d + 7 > new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        return { month: m, nth: last ? -1 : Math.ceil(d / 7), dow: local.getUTCDay(), h: local.getUTCHours(), min: local.getUTCMinutes(), from: t.from, to: t.to };
    }
    /** The instant a yearly rule fires in year y. */
    function ruleInstant(r, y) {
        let day;
        if (r.nth > 0) { const first = new Date(Date.UTC(y, r.month, 1)).getUTCDay(); day = 1 + ((r.dow - first + 7) % 7) + 7 * (r.nth - 1); }
        else { const lastD = new Date(Date.UTC(y, r.month + 1, 0)).getUTCDate(), lastDow = new Date(Date.UTC(y, r.month, lastD)).getUTCDay(); day = lastD - ((lastDow - r.dow + 7) % 7); }
        return Date.UTC(y, r.month, day, r.h, r.min) - r.from * 60000;
    }
    /** The VTIMEZONE lines for tz, covering fromYear through throughYear (and on, by rule, when one holds). */
    function vtimezone(tz, fromYear, throughYear) {
        const zone = validZone(tz);
        if (!zone) return [];
        const key = `${zone}|${fromYear}|${throughYear}`;
        if (vtzCache.has(key)) return vtzCache.get(key);
        const start = Date.UTC(fromYear, 0, 1), end = Date.UTC(throughYear + 1, 0, 1);
        const list = transitions(zone, start, end);
        const lastYear = list.filter((t) => new Date(t.ms).getUTCFullYear() === throughYear);
        let rules = null;
        if (lastYear.length === 2 && lastYear[0].from === lastYear[1].to && lastYear[0].to === lastYear[1].from) {
            const rs = lastYear.map(yearlyRule);
            const later = transitions(zone, end, Date.UTC(throughYear + 21, 0, 1));
            const want = [];
            for (let y = throughYear + 1; y <= throughYear + 20; y++) for (const r of rs) want.push(ruleInstant(r, y));
            want.sort((a, b) => a - b);
            if (later.length === want.length && later.every((t, i) => t.ms === want[i])) rules = rs;
        }
        const std = (o, other) => o <= other;   // the larger offset of a pair is daylight time
        const block = (kind, dt, from, to, rrule) => [`BEGIN:${kind}`, `DTSTART:${dt}`, ...(rrule ? [rrule] : []),
            `TZOFFSETFROM:${fmtOffset(from)}`, `TZOFFSETTO:${fmtOffset(to)}`, `END:${kind}`];
        const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
        const first = offsetAt(zone, start);
        // The offset in force at the start (and before it: a reader uses the first change's TZOFFSETFROM).
        lines.push(...block('STANDARD', wallStamp(start + first * 60000), first, first));
        for (const t of list) lines.push(...block(std(t.to, t.from) ? 'STANDARD' : 'DAYLIGHT', wallStamp(t.ms + t.from * 60000), t.from, t.to));
        if (rules) {
            for (const r of rules) {
                const at = ruleInstant(r, throughYear + 1);
                lines.push(...block(std(r.to, r.from) ? 'STANDARD' : 'DAYLIGHT', wallStamp(at + r.from * 60000), r.from, r.to,
                    `RRULE:FREQ=YEARLY;BYMONTH=${r.month + 1};BYDAY=${r.nth}${WEEKDAYS[r.dow]}`));
            }
        } else {
            // No yearly rule holds (no DST, or an irregular one): the next 20 years' changes, listed.
            for (const t of transitions(zone, end, Date.UTC(throughYear + 21, 0, 1))) lines.push(...block(std(t.to, t.from) ? 'STANDARD' : 'DAYLIGHT', wallStamp(t.ms + t.from * 60000), t.from, t.to));
        }
        lines.push('END:VTIMEZONE');
        vtzCache.set(key, lines);
        return lines;
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
        localZone, zoneName, zoneCity, zoneLabel, zones, searchZones,
        inferZone, confidentZone, calendarZone, seriesZone, untilDay, vtimezone };
    if (typeof module !== 'undefined' && module.exports) module.exports = EventZone;
    else root.EventZone = EventZone;
})(typeof window !== 'undefined' ? window : globalThis);
