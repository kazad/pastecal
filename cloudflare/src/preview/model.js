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

