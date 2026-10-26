/**
 * cardKit -- the pure parts of the native event card (EventCard.js): reading what people type into the
 * time and date pickers ("5p", "17:30", "fri", "oct 20"), times typed into a new event's title
 * ("Practice Thu 5-6"), the words the card shows ("5:30 PM", "1h 30m", "Monthly on the 21st", "5m ago"),
 * and repeat rules in Syncfusion's own form and key order (the same rules EventEditor.js writes, so both
 * calendars keep reading each other's events).
 *
 * No DOM, no Vue: test/unit/native-card-kit.test.js runs it in node.
 */
(function (root) {
    'use strict';

    const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const pad = (n) => String(n).padStart(2, '0');
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
    const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 864e5);

    // ---- words ------------------------------------------------------------------------------
    /** Minutes after midnight -> "5 PM" / "5:30 PM" (short) or "5:00 PM"; 24-hour: "17:00". 1440 is midnight. */
    function fmtMinutes(m, fmt = '12', short = false) {
        const h = Math.floor(m / 60) % 24, mm = m % 60;
        if (fmt === '24') return `${pad(h)}:${pad(mm)}`;
        const ap = h < 12 ? 'AM' : 'PM', h12 = ((h + 11) % 12) + 1;
        return short && !mm ? `${h12} ${ap}` : `${h12}:${pad(mm)} ${ap}`;
    }
    const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
    const fmtTime = (d, fmt, short) => fmtMinutes(minutesOf(d), fmt, short);
    /** "Tue, Oct 13" (or other Intl options). */
    const fmtDate = (d, o = { weekday: 'short', month: 'short', day: 'numeric' }) => d.toLocaleDateString('en-US', o);
    /** A length in minutes: "45m", "1h", "1h 30m", "2 days 3h". */
    function fmtLen(mins) {
        mins = Math.max(0, Math.round(mins));
        const d = Math.floor(mins / 1440), r = mins % 1440, h = Math.floor(r / 60), m = r % 60;
        const hm = [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
        return d ? `${d} day${d > 1 ? 's' : ''}${hm ? ' ' + hm : ''}` : (hm || '0m');
    }
    const fmtDays = (n) => (n === 7 ? '1 week' : `${n} day${n === 1 ? '' : 's'}`);
    /** "just now", "5m ago", "26h ago" (under two days), "2d ago". */
    function ago(t, now = Date.now()) {
        const m = Math.floor((now - t) / 60000);
        if (m < 1) return 'just now';
        if (m < 60) return `${m}m ago`;
        if (m < 48 * 60) return `${Math.floor(m / 60)}h ago`;
        return `${Math.floor(m / 1440)}d ago`;
    }
    function ordinal(n) {
        const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
        return `${n}${s}`;
    }

    // ---- typing a time or a date ---------------------------------------------------------------
    /**
     * "5p", "5 pm", "5:30", "530p", "17:30", "noon", "midnight" -> minutes after midnight, or null.
     * With no AM/PM on a 12-hour clock, 1-7 means the afternoon (events rarely start at 3 in the morning);
     * on a 24-hour clock the number is the hour.
     */
    function parseTime(s, fmt = '12') {
        const t = String(s || '').trim().toLowerCase().replace(/\./g, '');
        if (!t) return null;
        if (t === 'noon') return 720;
        if (t === 'midnight') return 0;
        const m = /^(\d{1,2})(?::?(\d{2}))?\s*(a|am|p|pm)?$/.exec(t);
        if (!m) return null;
        let h = +m[1]; const mm = +(m[2] || 0); const ap = m[3];
        if (mm > 59) return null;
        if (ap) {
            if (h < 1 || h > 12) return null;
            if (ap[0] === 'p' && h < 12) h += 12;
            if (ap[0] === 'a' && h === 12) h = 0;
        } else {
            if (h > 23) return null;
            if (fmt !== '24' && !/^0/.test(m[1]) && h >= 1 && h <= 7) h += 12;
        }
        return h * 60 + mm;
    }
    const WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    /**
     * "today", "tomorrow", "fri" (the next Friday after today), "oct 20", "20 oct", "10/20", "10/20/2027",
     * "2026-10-20", "20" (that day of `ref`'s month) -> a local midnight Date, or null.
     * A month and day without a year take `ref`'s year.
     */
    function parseDate(s, today = new Date(), ref = today) {
        const t = String(s || '').trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
        if (!t) return null;
        const T = startOfDay(today), R = startOfDay(ref);
        if (t === 'today') return T;
        if (t === 'tomorrow' || t === 'tmrw') return addDays(T, 1);
        if (t === 'yesterday') return addDays(T, -1);
        const w = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/.exec(t);
        if (w) { const want = WD[w[1]]; let d = addDays(T, 1); while (d.getDay() !== want) d = addDays(d, 1); return d; }
        const ok = (y, mo, d) => { const x = new Date(y, mo, d); return x.getMonth() === mo && x.getDate() === d ? x : null; };
        let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
        if (m) return ok(+m[1], +m[2] - 1, +m[3]);
        m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(t);
        if (m) return ok(m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : R.getFullYear(), +m[1] - 1, +m[2]);
        m = /^([a-z]{3})[a-z]* (\d{1,2})(?: (\d{4}))?$/.exec(t) || null;
        if (m && m[1] in MON) return ok(m[3] ? +m[3] : R.getFullYear(), MON[m[1]], +m[2]);
        m = /^(\d{1,2}) ([a-z]{3})[a-z]*(?: (\d{4}))?$/.exec(t);
        if (m && m[2] in MON) return ok(m[3] ? +m[3] : R.getFullYear(), MON[m[2]], +m[1]);
        m = /^(\d{1,2})$/.exec(t);
        if (m) return ok(R.getFullYear(), R.getMonth(), +m[1]);
        return null;
    }

    // ---- a time typed into a new event's title ---------------------------------------------------
    const DAYWORD = '(today|tomorrow|tmrw|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
    const TIME = '(\\d{1,2}(?::\\d{2})?(?:\\s*(?:am|pm|a|p)(?![a-z]))?|noon)';
    const SMART = new RegExp(`(?:^|\\s)(?:${DAYWORD}(?![a-z]))?\\s*(?:at\\s+)?(?:${TIME}(?:\\s*(?:-|–|to)\\s*${TIME})?)?\\s*$`, 'i');
    /**
     * "Practice Thu 5-6", "Snack run tomorrow 3:30pm", "Game fri 10-11:30", "Call 7-9pm" -> { at, day, start, end }
     * (at: where the words begin; day: a Date or null; start/end: minutes or null), else null.
     * Day words count only as whole words ("Monica", "Saturn" are titles). A number or a range with no day word and
     * no am/pm, colon or "noon" is not a time ("Room 5", "Grades 3-5", "Game 7-9").
     */
    function smartParse(title, today = new Date(), fmt = '12') {
        const txt = String(title || '');
        const m = SMART.exec(txt);
        if (!m || (!m[1] && !m[2])) return null;
        const at = m.index + (/^\s/.test(m[0]) ? 1 : 0);
        if (!txt.slice(0, at).trim()) return null;   // nothing left for a title
        const marked = (x) => !!x && /[ap:]|noon/i.test(x);
        if (!m[1] && !marked(m[2]) && !marked(m[3])) return null;
        let day = null;
        if (m[1]) { day = parseDate(m[1].toLowerCase().replace(/^(tue|thu)[a-z]*/, '$1'), today); if (!day) return null; }
        let start = null, end = null;
        if (m[2]) {
            const endAp = m[3] && /(am|pm|a|p)\s*$/i.exec(m[3].trim());
            const startHasAp = /(am|pm|a|p)\s*$/i.test(m[2].trim()) || /noon/i.test(m[2]);
            if (m[3]) {
                end = parseTime(m[3], fmt);
                if (end == null) return null;
                if (!startHasAp && endAp) {
                    // "7-9pm": both PM. "11-1pm": 11 AM to 1 PM (the start takes the end's half of the day if that
                    // keeps it before the end, else the other half).
                    const raw = parseTime(m[2] + endAp[1], fmt), other = parseTime(m[2] + (endAp[1][0] === 'p' ? 'am' : 'pm'), fmt);
                    start = raw != null && raw < end ? raw : other;
                } else start = parseTime(m[2], fmt);
                if (start == null) return null;
                if (end <= start) end += 720;
                if (end <= start) end = start + 60;
                end = Math.min(end, 1440);
            } else {
                start = parseTime(m[2], fmt);
                if (start == null) return null;
            }
        }
        return { at, day, start, end };
    }

    // ---- repeat rules (Syncfusion's form: "FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;") ---------------------
    const OWN = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'UNTIL', 'COUNT'];
    const MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    /** A rule -> the fields of the Custom panel (the same reading as EventEditor.parseRule). */
    function parseRule(rule, start) {
        const s = { freq: '', interval: 1, byDay: [start.getDay()], endMode: 'never', until: '', count: 10,
            monthMode: 'day', monthDay: start.getDate(), posDay: start.getDay(), month: start.getMonth() + 1,
            setPos: Math.ceil(start.getDate() / 7) > 4 ? -1 : Math.ceil(start.getDate() / 7), extra: [] };
        if (!rule) return s;
        const list = String(rule).replace(/^RRULE:/i, '').split(';').filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')).toUpperCase(), p.slice(p.indexOf('=') + 1)]);
        const parts = Object.fromEntries(list);
        s.extra = list.filter(([k]) => !OWN.includes(k)).map(([k, v]) => `${k}=${v}`);
        s.freq = parts.FREQ || '';
        s.interval = parseInt(parts.INTERVAL, 10) || 1;
        if (parts.BYDAY) {
            s.byDay = parts.BYDAY.split(',').map((d) => MAP[d.replace(/^[+-]?\d+/, '')]).filter((n) => n !== undefined);
            if (!s.byDay.length) s.byDay = [start.getDay()];
        }
        if (s.freq === 'MONTHLY' || s.freq === 'YEARLY') {
            if (parts.BYMONTH) s.month = parseInt(parts.BYMONTH, 10) || s.month;
            const lead = parts.BYDAY && /^([+-]?\d+)(\w\w)$/.exec(parts.BYDAY.split(',')[0]);
            if (parts.BYDAY && (parts.BYSETPOS || lead)) {
                s.monthMode = 'weekday';
                s.setPos = parseInt(parts.BYSETPOS || lead[1], 10) || 1;
                s.posDay = MAP[(lead ? lead[2] : parts.BYDAY.split(',')[0])] ?? s.posDay;
            } else if (parts.BYMONTHDAY) s.monthDay = parseInt(parts.BYMONTHDAY, 10) || s.monthDay;
        }
        if (parts.UNTIL) {
            const u = parts.UNTIL, t = /T(\d{2})(\d{2})(\d{2})/.exec(u) || [0, '00', '00', '00'];
            const at = new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +t[1], +t[2], +t[3]));
            s.endMode = 'until'; s.until = /Z$/.test(u) ? dateStr(at) : `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
        } else if (parts.COUNT) { s.endMode = 'count'; s.count = parseInt(parts.COUNT, 10) || 1; }
        return s;
    }
    /** The Custom panel's fields -> a rule, in EventEditor.buildRule's form. untilStamp(ymd, allDay) formats an all-day UNTIL. */
    function buildRule(s, { isAllDay = false, untilStamp = null } = {}) {
        if (!s.freq) return '';
        let r = `FREQ=${s.freq};`;
        if (s.freq === 'WEEKLY') r += `BYDAY=${[...s.byDay].sort().map((d) => DAYS[d]).join(',')};`;
        if (s.freq === 'MONTHLY' || s.freq === 'YEARLY') {
            r += s.monthMode === 'weekday' ? `BYDAY=${DAYS[s.posDay]};BYSETPOS=${s.setPos};`
                : `BYMONTHDAY=${Math.min(31, Math.max(1, parseInt(s.monthDay, 10) || 1))};`;
            if (s.freq === 'YEARLY') r += `BYMONTH=${s.month};`;
        }
        r += `INTERVAL=${Math.max(1, parseInt(s.interval, 10) || 1)};`;
        for (const p of s.extra || []) r += `${p};`;
        if (s.endMode === 'until' && s.until) {
            const [y, m, d] = s.until.split('-').map(Number);
            const grid = isAllDay && untilStamp ? untilStamp(s.until, true) : null;
            r += grid ? `UNTIL=${grid};` : `UNTIL=${new Date(y, m - 1, d, 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')};`;
        } else if (s.endMode === 'count') r += `COUNT=${Math.max(1, parseInt(s.count, 10) || 1)};`;
        return r;
    }
    /** The one-tap choices for an event starting on `d`: [{ id, rule }]. */
    function presets(d) {
        const wd = DAYS[d.getDay()];
        return [
            { id: 'none', rule: '' },
            { id: 'week', rule: `FREQ=WEEKLY;BYDAY=${wd};INTERVAL=1;` },
            { id: 'two', rule: `FREQ=WEEKLY;BYDAY=${wd};INTERVAL=2;` },
            { id: 'month', rule: `FREQ=MONTHLY;BYMONTHDAY=${d.getDate()};INTERVAL=1;` },
            { id: 'weekday', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=1;' },
        ];
    }
    const norm = (r) => String(r || '').replace(/^RRULE:/i, '').split(';').filter(Boolean).map((p) => p.toUpperCase()).join(';');
    /** Which preset a rule is ('none', 'week', ...), or 'custom'. */
    function presetOf(rule, d) {
        const n = norm(rule);
        const hit = presets(d).find((p) => norm(p.rule) === n);
        return hit ? hit.id : 'custom';
    }
    /** "Doesn't repeat", "Every Tuesday", "Every 2 weeks on Tuesday", "Monthly on the 21st", "Every weekday", ... */
    function describeRule(rule, d) {
        if (!rule) return "Doesn't repeat";
        const s = parseRule(rule, d);
        const n = s.interval, every = (u) => (n === 1 ? `Every ${u}` : `Every ${n} ${u}s`);
        let t;
        if (s.freq === 'DAILY') t = n === 1 ? 'Every day' : `Every ${n} days`;
        else if (s.freq === 'WEEKLY') {
            const days = [...s.byDay].sort();
            const names = days.map((x) => DAY_NAMES[x]);
            if (days.join() === '1,2,3,4,5') t = n === 1 ? 'Every weekday' : `Every ${n} weeks on weekdays`;
            else if (n === 1) t = `Every ${names.length > 1 ? names.map((x) => x.slice(0, 3)).join(', ') : names[0]}`;
            else t = `Every ${n} weeks on ${names.length > 1 ? names.map((x) => x.slice(0, 3)).join(', ') : names[0]}`;
        } else if (s.freq === 'MONTHLY' || s.freq === 'YEARLY') {
            const pos = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' }[s.setPos] || 'first';
            const on = s.monthMode === 'weekday' ? `the ${pos} ${DAY_NAMES[s.posDay]}` : `the ${ordinal(s.monthDay)}`;
            if (s.freq === 'MONTHLY') t = n === 1 ? `Monthly on ${on}` : `${every('month')} on ${on}`;
            else t = `${n === 1 ? 'Yearly' : every('year')} on ${s.monthMode === 'weekday' ? `${on} of ${MONTH_NAMES[s.month - 1]}` : `${MONTH_NAMES[s.month - 1]} ${s.monthDay}`}`;
        } else t = 'Repeats';
        if (s.endMode === 'until' && s.until) { const [y, m, dd] = s.until.split('-').map(Number); t += `, until ${fmtDate(new Date(y, m - 1, dd), { month: 'short', day: 'numeric' })}`; }
        if (s.endMode === 'count') t += `, ${s.count} times`;
        return t;
    }
    /** Syncfusion's checks on a repeat (its recurrenceValidation, as EventEditor makes them): a message, or ''. */
    function ruleProblem(s, start, end, isAllDay) {
        if (!s.freq) return '';
        if (s.endMode === 'until' && s.until && s.until < dateStr(start)) return 'The repeat ends before the event starts.';
        const gap = { DAILY: 1, WEEKLY: 7 }[s.freq];
        const every = Math.max(1, parseInt(s.interval, 10) || 1);
        if (gap && (end - start) / 864e5 > gap * every + (isAllDay ? 0.001 : 0)) return 'The event is longer than the time between its repeats. Shorten it, or change the repeat.';
        return '';
    }

    // ---- the date picker's month --------------------------------------------------------------------
    /** The days to draw for a month: leading blanks (null), then each date. */
    function monthCells(year, month, firstDay = 0) {
        const first = new Date(year, month, 1), lead = (first.getDay() - firstDay + 7) % 7;
        const n = new Date(year, month + 1, 0).getDate();
        return [...Array(lead).fill(null), ...Array.from({ length: n }, (_, i) => new Date(year, month, i + 1))];
    }

    const cardKit = { DAYS, DAY_NAMES, MONTH_NAMES, fmtMinutes, fmtTime, fmtDate, fmtLen, fmtDays, ago, ordinal, minutesOf,
        parseTime, parseDate, smartParse, parseRule, buildRule, presets, presetOf, describeRule, ruleProblem, monthCells,
        startOfDay, addDays, dayDiff, dateStr };
    if (typeof module !== 'undefined' && module.exports) module.exports = cardKit;
    else root.cardKit = cardKit;
})(typeof window !== 'undefined' ? window : globalThis);
