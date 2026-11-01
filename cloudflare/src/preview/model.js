/**
 * From a calendar to what its preview shows: the link card's model and its description
 * line. Pure.
 *
 * `cal` is the room's preview data (CalendarRoom GET /cal/<id>/preview): {v, title, colors, events
 * (no descriptions: notes never leave the room for a preview), zoneSamples, pro, hideBranding}. Only
 * occurrences that have not ended are shown.
 */
import { clean, clip } from './text.js';
import { eventColor } from './svg.js';
import { occurrences, confidentZone, validZone, zoneLabel, fmtTime, fmtDay, startDay, dayOf, DAY_MS } from './time.js';

export const FALLBACK_TITLE = 'A shared calendar';
const HORIZON_DAYS = 366;

export function displayTitle(cal) {
    return clip(clean(cal && cal.title), 120) || FALLBACK_TITLE;
}

/**
 * The zone a preview uses: ?tz=, else the calendar's own (options.tz, stored from the browsers that edit it),
 * else a confident guess from its all-day events. None of those: {tz: 'UTC', noTimes: true}, and the
 * card shows dates and weekdays without clock times (a guessed time could be hours off).
 */
export function chooseZone(cal, tzParam) {
    const asked = validZone(tzParam);
    if (asked) return { tz: asked, source: 'param', noTimes: false };
    const own = validZone(cal && cal.tz);
    if (own) return { tz: own, source: 'calendar', noTimes: false };
    const samples = cal && Array.isArray(cal.zoneSamples) ? cal.zoneSamples.map((start) => ({ isAllDay: true, start })) : cal && cal.events;
    const guessed = confidentZone(samples);
    return guessed ? { tz: guessed, source: 'inferred', noTimes: false } : { tz: 'UTC', source: 'unknown', noTimes: true };
}

/** Upcoming occurrences from `now`: not ended yet (all-day: today or later, in tz). */
export function upcoming(cal, now, tz, limit = 3) {
    const occ = occurrences(cal.events, now, now + HORIZON_DAYS * DAY_MS, tz, { perSeries: 60 });
    const today = dayOf(now, tz);
    const list = occ.filter((o) => (o.allDay ? o.end > today : o.end > now || (o.end === o.start && o.start >= now)));
    return { shown: list.slice(0, limit), total: list.length };
}

/** "Sat Oct 25 · Sectionals · Tue Oct 28 · Full rehearsal", or "No upcoming events". */
export function describe(cal, now) {
    const { tz } = chooseZone(cal, null);
    const { shown } = upcoming(cal, now, tz, 3);
    if (!shown.length) return 'No upcoming events';
    const out = clip(shown.map((o) => `${fmtDay(startDay(o, tz))} · ${clip(o.title, 40) || '(No title)'}`).join(' · '), 200);
    return out;
}

/**
 * The countdown image's model (svg.countdownCard): how long until the calendar's next event, in the
 * words a person would use. `opts.tz` is the image link's ?tz=.
 *
 *   state 'none'  nothing upcoming
 *   state 'now'   an occurrence is under way: big "Now"
 *   state 'soon'  under a day away, counted in minutes (under an hour) or hours (the same calendar day)
 *   state 'days'  later: "Tomorrow", else "N days", by calendar date in the zone, never by 24-hour blocks
 *
 * `big` is the headline ("12", "Tomorrow", "Now"), `unit` the word after a number ("days"), and
 * `maxAge` how long the picture stays right, in seconds: counted-down states change within minutes,
 * a days count only at midnight.
 */
export function countdownModel(cal, now, opts = {}) {
    const { tz, noTimes } = chooseZone(cal, opts.tz);
    const { shown } = upcoming(cal, now, tz, 1);
    const base = { calendar: displayTitle(cal), branded: !(cal.pro && cal.hideBranding), tz };
    const o = shown[0];
    if (!o) return { ...base, state: 'none', big: '', unit: '', title: '', detail: '', color: null, maxAge: 1800 };

    const today = dayOf(now, tz);
    const day = startDay(o, tz);
    const underway = o.allDay ? o.start <= today : o.start <= now;
    const showTime = !o.allDay && !noTimes;
    const detail = [fmtDay(day), showTime ? `${fmtTime(o.start, tz)} ${zoneLabel(tz, o.start)}` : null].filter(Boolean).join(' · ');
    const out = { ...base, title: clip(o.title, 80) || '(No title)', detail, color: eventColor(o.type, cal.colors), stamp: String(o.start) };

    if (underway) {
        // Timed: until when (the date too if it runs past today). All-day: its date. No known zone: no clock times.
        const until = showTime ? (dayOf(o.end, tz) === today ? `Until ${fmtTime(o.end, tz)}` : `Until ${fmtDay(dayOf(o.end, tz))}`) : 'Happening now';
        return { ...out, state: 'now', big: 'Now', unit: '', detail: o.allDay ? detail : until, maxAge: 300 };
    }
    if (!o.allDay && !noTimes && day === today) {
        const mins = Math.max(1, Math.floor((o.start - now) / 60000));
        return mins < 60
            ? { ...out, state: 'soon', big: String(mins), unit: mins === 1 ? 'minute' : 'minutes', maxAge: 60 }
            : { ...out, state: 'soon', big: String(Math.floor(mins / 60)), unit: Math.floor(mins / 60) === 1 ? 'hour' : 'hours', maxAge: 300 };
    }
    const n = Math.round((day - today) / DAY_MS);
    // n is 0 only for a timed event today in a zone we only guessed (no clock times): say the day, not the hour.
    if (n <= 0) return { ...out, state: 'days', big: 'Today', unit: '', maxAge: 1800 };
    return n === 1
        ? { ...out, state: 'days', big: 'Tomorrow', unit: '', maxAge: 1800 }
        : { ...out, state: 'days', big: String(n), unit: 'days', maxAge: 1800 };
}

/** The link card's model (svg.calendarCard). */
export function cardModel(cal, now) {
    const { tz, noTimes } = chooseZone(cal, null);
    const { shown, total } = upcoming(cal, now, tz, 3);
    return {
        title: displayTitle(cal),
        events: shown.map((o) => ({ title: clip(o.title, 80), color: eventColor(o.type, cal.colors), day: startDay(o, tz), time: o.allDay || noTimes ? null : fmtTime(o.start, tz) })),
        more: Math.max(0, total - shown.length),
        branded: !(cal.pro && cal.hideBranding),
        tzLabel: noTimes ? '' : zoneLabel(tz, now),
    };
}

