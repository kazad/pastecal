// EventSearch -- the search panel's results, shared by both UIs.
//
// What it replaced, in each app: `calendar.events.filter(e => e.title.toLowerCase()...)`.
// That threw on the first event with no title (Firebase drops an empty string, so an
// untitled event has none) and the whole panel stopped working; it never looked at
// notes; and a weekly series was listed (and jumped to) at the date it STARTED, months
// ago, rather than when it next happens. The grid's own expansion is the authority on
// when that is, and each UI has a different one (Syncfusion's generate(), rrule.js), so
// the caller passes it in as `occurrenceAfter(event, ms) -> { start, end } | null`.
//
// Pure. Reads Event and CalDate (for all-day dates) when called.

const EventSearch = {
    /** Does `event` match `query`: its title or notes, case-insensitively. */
    matches(event, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q || !event) return false;
        // An untitled event is found by the name it is shown under.
        const title = event.title && String(event.title).trim() ? event.title : 'Untitled event';
        const hay = `${title}\n${event.description || ''}`.toLowerCase();
        return q.split(/\s+/).every(word => hay.includes(word));
    },

    /**
     * Results for `query`: [{ key, event, start, end, recurring, hidden, ended }], soonest
     * upcoming first, then past ones most recent first. `start`/`end` are epoch ms of the
     * occurrence to show and jump to: a series' next one, an all-day event's local
     * midnight. `hidden` marks an event the color filter currently hides (`isVisible`).
     */
    search(events, query, { now = Date.now(), occurrenceAfter = null, isVisible = () => true, limit = 50 } = {}) {
        const out = [];
        for (const event of events || []) {
            if (!EventSearch.matches(event, query)) continue;
            const own = EventSearch.ownRange(event);
            let range = own;
            let recurring = false, ended = false;
            if (event.recurrencerule && !event.recurrenceID) {
                recurring = true;
                const next = typeof occurrenceAfter === 'function' ? occurrenceAfter(event, now) : null;
                if (next) range = next;
                else ended = true;
            }
            if (!range || isNaN(range.start)) continue;
            out.push({
                key: `${event.id}|${event.recurrenceID ?? ''}`,
                event, start: range.start, end: range.end, recurring, ended,
                hidden: !isVisible(event),
            });
        }
        const upcoming = out.filter(r => (r.end || r.start) > now).sort((a, b) => a.start - b.start);
        const past = out.filter(r => !((r.end || r.start) > now)).sort((a, b) => b.start - a.start);
        return [...upcoming, ...past].slice(0, limit);
    },

    /** An event's own start/end as epoch ms (all-day: the viewer's local midnights). */
    ownRange(event) {
        if (event.isAllDay) {
            const r = Event.allDayLocalRange(event);
            return r ? { start: r.start.getTime(), end: r.end.getTime() } : null;
        }
        const start = CalDate.toMs(event.start);
        const end = CalDate.toMs(event.end);
        return { start, end: isNaN(end) ? start : end };
    },

    /** "Tue, Oct 6, 2026 · 3:00 – 4:00 PM" / "Mon, Oct 12, 2026 · all day". Always the year. */
    describe(result) {
        const s = new Date(result.start);
        if (isNaN(s.getTime())) return '';
        const date = s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        if (result.event && result.event.isAllDay) {
            const lastDay = new Date(result.end - 1);
            const multi = result.end && lastDay.toDateString() !== s.toDateString();
            return multi
                ? `${date} – ${lastDay.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`
                : `${date} · all day`;
        }
        const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const e = new Date(result.end);
        if (!result.end || isNaN(e.getTime()) || result.end <= result.start) return `${date} · ${time(s)}`;
        const sameDay = e.toDateString() === s.toDateString();
        return sameDay ? `${date} · ${time(s)} – ${time(e)}`
            : `${date} · ${time(s)} – ${e.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time(e)}`;
    },
};

if (typeof window !== 'undefined') window.EventSearch = EventSearch;
if (typeof module === 'object' && module && module.exports) module.exports = EventSearch;
