/**
 * cardKit -- the pure parts of the native event card (EventCard.js): reading what people type into the
 * time and date pickers ("5p", "17:30", "fri", "oct 20"), the words the card shows ("5:30 PM", "1h 30m", "Monthly on the 21st", "5m ago"),
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
    // Everything a person may type into the time and date pickers is a row of TIME_FORMS or DATE_FORMS, and nowhere
    // else: one table per kind, read top to bottom, the first row that matches wins. A form that is not a row is
    // refused (the field turns red), never guessed at. What a form leaves open -- which year, which Friday, which
    // day an end time falls on -- is decided by the look-ahead rules below the tables, also in one place.
    // test/unit/typed-forms.test.js holds the whole table as rows of (input, locale, today, expected).

    /** A clock time's text, lowercased, dots dropped ("5 p.m." -> "5 pm"; "17.30" -> "1730"). */
    const timeText = (s) => String(s || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
    /** h (0-23) and minutes -> minutes after midnight, or null. */
    const hm = (h, m) => (h >= 0 && h <= 23 && m >= 0 && m <= 59 ? h * 60 + m : null);
    /** A 12-hour hour with "a"/"p" -> 0-23, or -1. */
    const h12 = (h, ap) => (h < 1 || h > 12 ? -1 : (h % 12) + (ap[0] === 'p' ? 12 : 0));
    /**
     * The clock times people type. read(match, fmt) -> minutes after midnight, or null.
     * With no AM/PM on a 12-hour clock, 1-7 means the afternoon (events rarely start at 3 in the morning); a leading
     * zero ("07") or a 24-hour clock keeps the number as the hour.
     */
    const TIME_FORMS = [
        { form: 'noon', re: /^noon$/, read: () => 720 },
        { form: 'midnight', re: /^midnight$/, read: () => 0 },
        { form: '5p, 5 pm, 5:30 pm, 530p, 11 PM', re: /^(\d{1,2})(?::?(\d{2}))? ?(a|am|p|pm)$/, read: (m) => hm(h12(+m[1], m[3]), +(m[2] || 0)) },
        { form: '17:30, 5:30, 0730, 17.30 (dots dropped), 9', re: /^(\d{1,2})(?::?(\d{2}))?$/, read: (m, fmt) => {
            const h = +m[1];
            return hm(fmt !== '24' && !/^0/.test(m[1]) && h >= 1 && h <= 7 ? h + 12 : h, +(m[2] || 0));
        } },
    ];
    /** "5p", "5 pm", "5:30", "530p", "17:30", "noon", "midnight" -> minutes after midnight, or null. */
    function parseTime(s, fmt = '12') {
        const t = timeText(s);
        if (!t) return null;
        for (const f of TIME_FORMS) { const m = f.re.exec(t); if (m) return f.read(m, fmt); }
        return null;
    }

    const WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    /**
     * The order a locale writes a numeric date in: 'dmy' (en-GB, de-DE, fr-FR: 28/10/2026), 'mdy' (en-US) or
     * 'ymd' (ja-JP, zh-CN: 2026/10/28, whose "10/28" is month first too). From Intl, so no list of countries.
     */
    function dateOrder(locale) {
        try {
            const parts = new Intl.DateTimeFormat(locale || undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(2026, 9, 28));
            const seq = parts.filter((p) => p.type === 'year' || p.type === 'month' || p.type === 'day').map((p) => p.type[0]).join('');
            return seq === 'dmy' || seq === 'ymd' ? seq : 'mdy';
        } catch (e) { return 'mdy'; }
    }
    const yearOf = (y) => (!y ? 0 : y.length === 2 ? 2000 + +y : +y);
    /** Two numbers without a year's help: month/day, or day/month when the locale writes day first or only that reads. */
    function numeric(c, a, b, y) {
        if (a > 12 && b <= 12) return c.at(y, b - 1, a);         // 13/10: only day-first makes sense, anywhere
        if (b > 12 && a <= 12) return c.at(y, a - 1, b);         // 10/13: only month-first makes sense, anywhere
        return c.order === 'dmy' ? c.at(y, b - 1, a) : c.at(y, a - 1, b);   // 5/10: the locale's own order
    }
    /**
     * The dates people type. read(match, c) -> a local midnight Date, or null. `c` carries today (T), the month shown
     * (R), the locale's order, and at(y, monthIndex, day) -- y 0 when no year was typed (the look-ahead below).
     * The text is lowercased with commas and runs of spaces made one space; dots are kept (they are a form: "28.10.").
     */
    const DATE_FORMS = [
        { form: 'today', re: /^today$/, read: (m, c) => c.T },
        { form: 'tomorrow, tmrw', re: /^(tomorrow|tmrw)$/, read: (m, c) => addDays(c.T, 1) },
        { form: 'yesterday', re: /^yesterday$/, read: (m, c) => addDays(c.T, -1) },
        { form: 'fri, friday (the next one)', re: /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/, read: (m, c) => nextWeekday(c.T, WD[m[1]]) },
        { form: '2026-10-28 (ISO)', re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, read: (m, c) => c.at(+m[1], +m[2] - 1, +m[3]) },
        { form: '28.10., 28.10, 28.10.2026, 28.10.26 (day first, as German, Polish, Russian... write it)', re: /^(\d{1,2})\.(\d{1,2})\.?(?:(\d{2}|\d{4}))?$/,
            read: (m, c) => c.at(yearOf(m[3]), +m[2] - 1, +m[1]) },
        { form: '10/28, 28/10, 10/28/2026, 10-28', re: /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/, read: (m, c) => numeric(c, +m[1], +m[2], yearOf(m[3])) },
        { form: 'oct 28, october 28 2026', re: /^([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/, read: (m, c) => (m[1] in MON ? c.at(yearOf(m[3]), MON[m[1]], +m[2]) : null) },
        { form: '28 oct, 28. oktober (the month in English), 28 october 2026', re: /^(\d{1,2})(?:st|nd|rd|th|\.)? ([a-z]{3})[a-z]*(?: (\d{4}))?$/, read: (m, c) => (m[2] in MON ? c.at(yearOf(m[3]), MON[m[2]], +m[1]) : null) },
        { form: '28 (that day of the month shown)', re: /^(\d{1,2})$/, read: (m, c) => validDate(c.R.getFullYear(), c.R.getMonth(), +m[1]) },
    ];

    // ---- look-ahead: what a typed form leaves open -------------------------------------------------
    /** y, monthIndex, day -> that date, or null when there is no such day (Feb 30). */
    function validDate(y, mo, d) { const x = new Date(y, mo, d); return x.getMonth() === mo && x.getDate() === d ? x : null; }
    /** A weekday is the next one after today, never today ("sat" typed on a Saturday is a week on). */
    function nextWeekday(T, want) { let d = addDays(T, 1); while (d.getDay() !== want) d = addDays(d, 1); return d; }
    /**
     * A month and day without a year: the coming one ("jan 5" typed in October is next January), or one in the last
     * few weeks ("oct 20" typed on Oct 24): the first on or after a month before today (or before the month shown,
     * when that is later). Feb 29 is the next leap year's.
     */
    function nearYear(mo, d, T, R) {
        const from = addDays(R > T ? R : T, -31), y = from.getFullYear();
        return [0, 1, 2, 3, 4].map((k) => validDate(y + k, mo, d)).find((x) => x && x >= from) || null;
    }
    /**
     * An end time typed for an event shorter than a day: the first such clock time after the start ("11:30p" for an
     * 11 PM - midnight event is 11:30 that night, not the next; "1a" for an 11 PM event is 1 AM the next day). A longer
     * event keeps the day it ends on (Mon 10 AM - Wed 3 PM, "4p" is Wed 4 PM), or, when that would not be after the
     * start, the first after it. -> a Date, or null when the time is the start's own (a zero-length or a day-long end).
     */
    function typedEnd(start, end, minutes) {
        const at = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(minutes / 60), minutes % 60);
        if (end - start >= 864e5) { const e = at(end); if (e > start) return e; }
        if (minutes === minutesOf(start)) return null;
        const e = at(start);
        return e > start ? e : at(addDays(startOfDay(start), 1));
    }

    /**
     * "today", "tomorrow", "fri", "oct 20", "20 oct", "10/20", "28/10", "28.10.", "2026-10-20", "20" -> a local
     * midnight Date, or null. `today` is today, `ref` the month the picker shows, `locale` the reader's
     * (navigator.language): it decides only a numeric date both ways could read ("5/10").
     */
    function parseDate(s, today = new Date(), ref = today, locale) {
        const t = String(s || '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
        if (!t) return null;
        const T = startOfDay(today), R = startOfDay(ref);
        const c = { T, R, order: dateOrder(locale), at: (y, mo, d) => (y ? validDate(y, mo, d) : nearYear(mo, d, T, R)) };
        for (const f of DATE_FORMS) { const m = f.re.exec(t); if (m) return f.read(m, c); }
        return null;
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
        if (parts.BYDAY && (!parts.FREQ || parts.FREQ === 'WEEKLY' || parts.FREQ === 'DAILY')) {   // (a monthly or yearly BYDAY is "the Nth weekday", below)
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
    /**
     * The Custom panel's fields -> a rule, character for character as classic's repeat editor (Syncfusion 23.2.6
     * RecurrenceEditor.getRecurrenceRule) writes it: the weekdays in the order its buttons show them (from the first
     * day of the week: MO,WE,SU when weeks start on Monday), and UNTIL as the chosen date's local midnight, a UTC
     * stamp (its date picker's value), timed or all day. Both calendars read that UNTIL as running through its day.
     */
    function buildRule(s, { firstDay = 0 } = {}) {
        if (!s.freq) return '';
        const f = Number(firstDay) || 0;
        let r = `FREQ=${s.freq};`;
        if (s.freq === 'WEEKLY') r += `BYDAY=${[...new Set(s.byDay)].sort((a, b) => ((a - f + 7) % 7) - ((b - f + 7) % 7)).map((d) => DAYS[d]).join(',')};`;
        if (s.freq === 'MONTHLY' || s.freq === 'YEARLY') {
            r += s.monthMode === 'weekday' ? `BYDAY=${DAYS[s.posDay]};BYSETPOS=${s.setPos};`
                : `BYMONTHDAY=${Math.min(31, Math.max(1, parseInt(s.monthDay, 10) || 1))};`;
            if (s.freq === 'YEARLY') r += `BYMONTH=${s.month};`;
        }
        r += `INTERVAL=${Math.min(999, Math.max(1, parseInt(s.interval, 10) || 1))};`;
        for (const p of s.extra || []) r += `${p};`;
        if (s.endMode === 'until' && s.until) {
            const [y, m, d] = s.until.split('-').map(Number);
            r += `UNTIL=${new Date(y, m - 1, d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')};`;
        } else if (s.endMode === 'count') r += `COUNT=${Math.min(999, Math.max(1, parseInt(s.count, 10) || 1))};`;
        return r;
    }
    /** The one-tap choices for an event starting on `d`: [{ id, rule }]. */
    function presets(d) {
        const wd = DAYS[d.getDay()];
        return [
            { id: 'none', rule: '' },
            { id: 'day', rule: 'FREQ=DAILY;INTERVAL=1;' },
            { id: 'week', rule: `FREQ=WEEKLY;BYDAY=${wd};INTERVAL=1;` },
            { id: 'two', rule: `FREQ=WEEKLY;BYDAY=${wd};INTERVAL=2;` },
            { id: 'month', rule: `FREQ=MONTHLY;BYMONTHDAY=${d.getDate()};INTERVAL=1;` },
            { id: 'year', rule: `FREQ=YEARLY;BYMONTHDAY=${d.getDate()};BYMONTH=${d.getMonth() + 1};INTERVAL=1;` },
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
        // The days a rule names: "Tuesday", "Mon and Wed", "Sun, Mon, Thu".
        const days = [...new Set(s.byDay)].sort(), short = days.map((x) => DAY_NAMES[x].slice(0, 3));
        const dayList = days.length === 1 ? DAY_NAMES[days[0]] : short.join(days.length === 2 ? ' and ' : ', ');
        const weekdays = days.join() === '1,2,3,4,5';
        let t;
        // (A daily rule limited to some weekdays, as imports write it, is those days each week.)
        const dailyDays = s.freq === 'DAILY' && /(^|;)BYDAY=/i.test(String(rule)) && days.length < 7;
        if (dailyDays) t = n === 1 ? (weekdays ? 'Every weekday' : `Every ${dayList}`) : `Every ${n} days, on ${weekdays ? 'weekdays' : dayList}`;
        else if (s.freq === 'DAILY') t = n === 1 ? 'Every day' : `Every ${n} days`;
        else if (s.freq === 'WEEKLY') {
            if (weekdays) t = n === 1 ? 'Every weekday' : `Every ${n} weeks on weekdays`;
            else t = n === 1 ? `Every ${dayList}` : `Every ${n} weeks on ${dayList}`;
        } else if (s.freq === 'MONTHLY' || s.freq === 'YEARLY') {
            const pos = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' }[s.setPos] || 'first';
            const on = s.monthMode === 'weekday' ? `the ${pos} ${DAY_NAMES[s.posDay]}` : `the ${ordinal(s.monthDay)}`;
            if (s.freq === 'MONTHLY') t = n === 1 ? `Monthly on ${on}` : `${every('month')} on ${on}`;
            else t = `${n === 1 ? 'Yearly' : every('year')} on ${s.monthMode === 'weekday' ? `${on} of ${MONTH_NAMES[s.month - 1]}` : `${MONTH_NAMES[s.month - 1]} ${s.monthDay}`}`;
        } else t = 'Repeats';
        if (s.endMode === 'until' && s.until) { const [y, m, dd] = s.until.split('-').map(Number); t += `, until ${fmtDate(new Date(y, m - 1, dd), { month: 'short', day: 'numeric' })}`; }
        if (s.endMode === 'count') t += `, ${s.count} time${s.count === 1 ? '' : 's'}`;
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
        parseTime, parseDate, typedEnd, dateOrder, TIME_FORMS, DATE_FORMS, parseRule, buildRule, presets, presetOf, describeRule, ruleProblem, monthCells,
        startOfDay, addDays, dayDiff, dateStr };
    if (typeof module !== 'undefined' && module.exports) module.exports = cardKit;
    else root.cardKit = cardKit;
})(typeof window !== 'undefined' ? window : globalThis);
