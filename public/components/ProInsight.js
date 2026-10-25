// Pro stats and history: two dialogs for the owner of a Pro (locked) calendar.
//
//   Stats   -- views, visitors and calendar-app followers per day, the places people came from.
//   History -- the calendar's saved versions (a daily snapshot, plus one written before every
//              restore), a read-only preview of each, and "Restore this version".
//
// Talks only to this site's JSON API (owner session cookie, cloudflare/src/Insight.js):
//   GET  /api/pro/stats?calendar=<id>&days=30|90|365
//   GET  /api/pro/versions?calendar=<id>
//   GET  /api/pro/versions/preview?calendar=<id>&date=<date>
//   POST /api/pro/versions/restore {calendarId, date}
// The server refuses all four unless the calendar is on Pro and this browser is its owner;
// free calendars never receive a number. Analytics get the surface, range and version kind only.
//
// ProInsightMath holds the pure parts (chart scaling, period comparison, date labels, the
// 7-day window for free calendars) so test/unit/pro-insight.test.js can check them in node.

const ProInsightMath = {
    RANGES: [30, 90, 365],
    DAY_MS: 86400000,

    // The range fetched alongside the shown one, so "this period vs the one before" needs no extra
    // server route: 90 days hold the 30 before the last 30. The server keeps about 400 days, so
    // a year has nothing to compare with.
    compareRange(days) { return days === 30 ? 90 : days === 90 ? 365 : null; },

    sum(rows, key) { return (rows || []).reduce((a, r) => a + (Number(r[key]) || 0), 0); },
    max(rows, key) { return (rows || []).reduce((a, r) => Math.max(a, Number(r[key]) || 0), 0); },

    // Headline numbers for the last `n` days of `rows` (oldest first) and the `n` before them.
    // Followers are the busiest day, as on the server: calendar apps don't all fetch every day.
    // `prev` is null when the longer series doesn't reach back a full period.
    periods(rows, n) {
        const list = Array.isArray(rows) ? rows : [];
        const now = list.slice(-n);
        const before = list.length >= 2 * n ? list.slice(-2 * n, -n) : null;
        const pick = (part) => part && {
            views: this.sum(part, 'views'),
            visitors: this.sum(part, 'visitors'),
            followers: this.max(part, 'followers'),
        };
        return { now: pick(now), prev: pick(before) };
    },

    // "+12%", "−8%" or "Same". null when there is nothing to compare with (a period of zeros
    // before is most often a calendar that didn't exist yet, not growth worth a badge).
    delta(now, prev) {
        if (prev === null || prev === undefined || !Number.isFinite(prev) || !prev) return null;
        const pct = Math.round(((now - prev) / prev) * 100);
        if (pct === 0) return { text: 'Same', dir: 'flat' };
        return { text: `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`, dir: pct > 0 ? 'up' : 'down' };
    },

    // A round axis top at or above `n`: 1, 2, 5, 10, 20, 50, ... (never 0, so bars never divide by it).
    niceMax(n) {
        const v = Math.max(1, Math.ceil(Number(n) || 0));
        const p = Math.pow(10, Math.floor(Math.log10(v)));
        for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
        return 10 * p;
    },

    // Bars for an SVG of width x height user units, one per day, oldest left. A day with a
    // count gets at least 1.5 units of height so a lone visit is visible next to a busy day.
    bars(rows, key, width, height) {
        const list = Array.isArray(rows) ? rows : [];
        const top = this.niceMax(this.max(list, key));
        const n = Math.max(1, list.length);
        const slot = width / n;
        const gap = slot >= 6 ? Math.min(slot * 0.25, 4) : 0;
        return {
            top,
            bars: list.map((r, i) => {
                const value = Number(r[key]) || 0;
                const h = value ? Math.max(1.5, (value / top) * height) : 0;
                return { day: r.day, value, x: +(i * slot + gap / 2).toFixed(2), w: +Math.max(0.5, slot - gap).toFixed(2), y: +(height - h).toFixed(2), h: +h.toFixed(2) };
            }),
        };
    },

    // Server days are UTC dates ("2026-10-23"); label them as that date wherever the reader is.
    dayLabel(day, opts) {
        const d = new Date(`${day}T00:00:00Z`);
        if (Number.isNaN(d.getTime())) return String(day || '');
        return d.toLocaleDateString(undefined, { ...(opts || { month: 'short', day: 'numeric' }), timeZone: 'UTC' });
    },

    // One sentence a screen reader (or anyone) can take instead of the chart.
    summary(rows, key, noun) {
        const list = Array.isArray(rows) ? rows : [];
        const total = this.sum(list, key);
        if (!total) return `No ${noun} in these ${list.length} days.`;
        if (key === 'followers') {
            // The same apps fetch day after day, so adding days up would count each one again.
            let peak = list[0];
            for (const r of list) if ((Number(r.followers) || 0) > (Number(peak.followers) || 0)) peak = r;
            const today = Number(list[list.length - 1].followers) || 0;
            return `Up to ${Number(peak.followers).toLocaleString()} calendar apps fetched it on one day (${this.dayLabel(peak.day, { weekday: 'short', month: 'short', day: 'numeric' })}). Today: ${today.toLocaleString()}.`;
        }
        let best = list[0];
        for (const r of list) if ((Number(r[key]) || 0) > (Number(best[key]) || 0)) best = r;
        const avg = total / Math.max(1, list.length);
        const per = avg >= 10 ? Math.round(avg) : Math.round(avg * 10) / 10;
        return `${total.toLocaleString()} ${noun} in ${list.length} days, about ${per.toLocaleString()} a day. Busiest day: ${this.dayLabel(best.day, { weekday: 'short', month: 'short', day: 'numeric' })}, ${Number(best[key]).toLocaleString()}.`;
    },

    // 🇺🇸 from "US". Anything that isn't two letters gets no flag.
    flag(code) {
        const c = String(code || '').toUpperCase();
        if (!/^[A-Z]{2}$/.test(c)) return '';
        return String.fromCodePoint(...[...c].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65));
    },
    countryName(code) {
        const c = String(code || '').toUpperCase();
        try {
            if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
                const name = new Intl.DisplayNames(undefined, { type: 'region' }).of(c);
                if (name && name !== c) return name;
            }
        } catch (e) { /* unknown code */ }
        return c;
    },

    // Entries (with savedAt in ms) from the last `days` days, by `now` (the server's clock).
    withinDays(entries, days, now) {
        const from = (Number(now) || Date.now()) - days * this.DAY_MS;
        return (entries || []).filter((e) => e && Number(e.savedAt) >= from);
    },

    // A version's moment: its save time when known, else the start of its UTC day.
    versionMs(v) {
        const t = v && v.savedAt ? Date.parse(v.savedAt) : NaN;
        if (Number.isFinite(t)) return t;
        const d = Date.parse(`${(v && v.day) || ''}T12:00:00Z`);   // midday UTC: the same date nearly everywhere
        return Number.isFinite(d) ? d : 0;
    },

    // Versions (newest first) grouped by the reader's local day of their save time.
    groupVersions(list, now) {
        const startOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
        const today = startOf(Number(now) || Date.now());
        const groups = [];
        for (const v of list || []) {
            const ms = this.versionMs(v), start = startOf(ms);
            let g = groups[groups.length - 1];
            if (!g || g.start !== start) {
                const ago = Math.round((today - start) / this.DAY_MS);
                const label = ago <= 0 ? 'Today' : ago === 1 ? 'Yesterday'
                    : new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(new Date(ms).getFullYear() !== new Date(today).getFullYear() ? { year: 'numeric' } : {}) });
                g = { start, label, items: [] };
                groups.push(g);
            }
            g.items.push(v);
        }
        return groups;
    },

    // "Wed, Oct 21 · 4:31 PM" for a version, in the reader's time zone.
    versionLabel(v) {
        const ms = this.versionMs(v);
        if (!ms) return String((v && v.date) || '');
        const d = new Date(ms);
        const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        if (!v.savedAt) return date;
        return `${date} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    },

    // The server labels a restore "Restored the version from 2026-10-21" or "... 2026-10-21 14:05 UTC".
    // Say the same in the reader's words.
    restoredLabel(label) {
        const s = String(label || '');
        const m = s.match(/(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2}) UTC)?/);
        if (!m) return s || 'Restored an earlier version';
        let when;
        if (m[2]) {
            const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
            when = `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
        } else {
            when = this.dayLabel(m[1], { month: 'short', day: 'numeric' });
        }
        return s.replace(m[0], when);
    },

    // A preview's events as date groups, soonest first: [{key, label, events:[{title, time, repeats}]}].
    eventsByDate(events) {
        const list = Array.isArray(events) ? events : (events && typeof events === 'object' ? Object.values(events) : []);
        const rows = list.filter((e) => e && typeof e === 'object').map((e) => {
            const start = new Date(e.start || e.StartTime || NaN);
            const allDay = !!(e.isAllDay || e.IsAllDay);
            const ok = !Number.isNaN(start.getTime());
            // An all-day event's stored instant is its author's local midnight (or UTC midnight);
            // its date is floor((ms + 13h + 1s) / 1 day), the mapping Event.js and the ICS feed use.
            const tz = allDay ? { timeZone: 'UTC' } : {};
            const dayStart = allDay && ok ? new Date(Math.floor((start.getTime() + 13 * 3600000 + 1000) / this.DAY_MS) * this.DAY_MS) : null;
            if (dayStart) start.setTime(dayStart.getTime());
            const key = ok ? (allDay ? start.toISOString().slice(0, 10)
                : `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`) : 'none';
            const title = String(e.title || e.Subject || '').trim() || 'Untitled event';
            return {
                key, ms: ok ? start.getTime() : Infinity, title,
                label: ok ? start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', ...tz }) : 'No date',
                time: !ok ? '' : allDay ? 'All day' : start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
                repeats: !!(e.recurrencerule || e.RecurrenceRule),
            };
        }).sort((a, b) => a.ms - b.ms || a.title.localeCompare(b.title));
        const groups = [];
        for (const r of rows) {
            let g = groups[groups.length - 1];
            if (!g || g.key !== r.key) { g = { key: r.key, label: r.label, events: [] }; groups.push(g); }
            g.events.push({ title: r.title, time: r.time, repeats: r.repeats });
        }
        return groups;
    },
};

const PRO_INSIGHT_NET = 'We couldn’t reach pastecal. Check your connection and try again.';

function proInsightTrack(fn) {
    try { if (typeof Analytics !== 'undefined' && Analytics) fn(Analytics); } catch (e) { /* observational only */ }
}
async function proInsightApi(method, path, body) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, init); } catch (e) { return { status: 0, data: {} }; }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}
// What a refusal means to the owner, in one line.
function proInsightError(r) {
    if (r.status === 0) return PRO_INSIGHT_NET;
    if (r.status === 401) return 'Sign in as the owner to see this. Use the email you paid with.';
    if (r.status === 403 && r.data && r.data.error === 'pro-only') return 'This is part of Pro. Lock the calendar to turn it on.';
    if (r.status === 403) return 'Only the calendar’s owner can see this.';
    if (r.status === 503 && r.data && r.data.error === 'stats-unavailable') return 'Stats start counting soon.';
    if (r.status === 503) return 'Saved versions aren’t available right now. Try again later.';
    return 'Something went wrong. Try again in a minute.';
}

// Set by the logo menu's "Stats" link for a calendar other than the open one; the calendar
// reopens the dialog once it loads. Holds the calendar id, the view and a time, nothing personal.
const PRO_INSIGHT_INTENT_KEY = 'pastecal_insight_intent';
const ProInsightIntent = {
    set(id, view) { try { localStorage.setItem(PRO_INSIGHT_INTENT_KEY, JSON.stringify({ id: String(id).toLowerCase(), view, t: Date.now() })); } catch (e) { /* storage blocked */ } },
    take(id) {
        try {
            const v = JSON.parse(localStorage.getItem(PRO_INSIGHT_INTENT_KEY) || 'null');
            if (!v || v.id !== String(id).toLowerCase() || Date.now() - v.t > 10 * 60 * 1000) return null;
            localStorage.removeItem(PRO_INSIGHT_INTENT_KEY);
            return v.view === 'history' ? 'history' : 'stats';
        } catch (e) { return null; }
    },
};
if (typeof window !== 'undefined') window.ProInsightIntent = ProInsightIntent;

const PRO_STAT_METRICS = [
    { key: 'views', label: 'Views', noun: 'views', note: 'Visits to the calendar' },
    { key: 'visitors', label: 'Visitors', noun: 'visitors', note: 'Daily, added up' },
    { key: 'followers', label: 'App followers', noun: 'followers', note: 'Calendar apps, busiest day' },
];

const ProStats = {
    template: /* html */ `
        <div class="pc-insight" data-testid="pro-stats">
            <div class="pc-insight-head">
                <h3 id="pro-stats-title" class="pc-insight-title">Stats</h3>
                <div class="pc-seg" role="group" aria-label="Range">
                    <button v-for="r in ranges" :key="r" type="button" class="pc-seg-btn" :class="{ on: days === r }"
                        :aria-pressed="days === r ? 'true' : 'false'" @click="setDays(r)">{{ r === 365 ? '1 year' : r + ' days' }}</button>
                </div>
            </div>

            <p v-if="loading && !report" class="pc-insight-muted" aria-live="polite">Loading…</p>
            <p v-else-if="error" class="pc-insight-err" role="alert">{{ error }}</p>

            <template v-else-if="report">
                <div v-if="empty" class="pc-insight-empty" data-testid="pro-stats-empty">
                    <p class="pc-insight-empty-title">Stats start counting today. Check back tomorrow.</p>
                    <p class="pc-insight-muted">You’ll see views, visitors, calendar apps following along, and where people are.</p>
                </div>

                <template v-else>
                    <div class="pc-stat-cards">
                        <button v-for="m in metrics" :key="m.key" type="button" class="pc-card pc-card--flat pc-card--pad pc-stat-card" :class="{ on: metric === m.key }"
                            :aria-pressed="metric === m.key ? 'true' : 'false'" @click="metric = m.key" :data-testid="'pro-stat-' + m.key">
                            <span class="pc-stat-label">{{ m.label }}</span>
                            <span class="pc-stat-num">{{ fmt(headline.now[m.key]) }}</span>
                            <span class="pc-stat-note">{{ m.note }}</span>
                            <span v-if="deltas[m.key]" class="pc-stat-delta" :class="'pc-stat-delta--' + deltas[m.key].dir">
                                {{ deltas[m.key].text }} <span class="pc-stat-vs">vs previous {{ days }} days</span>
                            </span>
                        </button>
                    </div>

                    <figure class="pc-chart">
                        <div class="pc-chart-plot">
                            <div class="pc-chart-y" aria-hidden="true"><span>{{ fmt(chart.top) }}</span><span>0</span></div>
                            <svg class="pc-chart-svg" :viewBox="'0 0 ' + W + ' ' + H" preserveAspectRatio="none" role="img" :aria-label="summary">
                                <line x1="0" :x2="W" y1="0.5" y2="0.5" class="pc-chart-grid" vector-effect="non-scaling-stroke"></line>
                                <line x1="0" :x2="W" :y1="H / 2" :y2="H / 2" class="pc-chart-grid" vector-effect="non-scaling-stroke"></line>
                                <line x1="0" :x2="W" :y1="H - 0.5" :y2="H - 0.5" class="pc-chart-base" vector-effect="non-scaling-stroke"></line>
                                <rect v-for="b in chart.bars" :key="b.day" :x="b.x" :y="b.y" :width="b.w" :height="b.h" class="pc-chart-bar" :class="{ today: b.day === todayKey }">
                                    <title>{{ dayLong(b.day) }}: {{ fmt(b.value) }} {{ metricInfo.noun }}</title>
                                </rect>
                            </svg>
                        </div>
                        <div class="pc-chart-x" aria-hidden="true">
                            <span>{{ firstDay }}</span><span>{{ lastDay }}</span>
                        </div>
                        <figcaption class="pc-insight-muted pc-chart-cap">{{ summary }}</figcaption>
                    </figure>

                    <div class="pc-places">
                        <section>
                            <h4 class="pc-insight-h">Top countries</h4>
                            <ol v-if="countries.length" class="pc-place-list">
                                <li v-for="c in countries" :key="c.code">
                                    <span class="pc-place-name"><span class="pc-flag" aria-hidden="true">{{ c.flag }}</span>{{ c.name }}</span>
                                    <span class="pc-place-bar" aria-hidden="true"><i :style="{ width: c.pct + '%' }"></i></span>
                                    <span class="pc-place-num">{{ fmt(c.count) }}</span>
                                </li>
                            </ol>
                            <p v-else class="pc-insight-muted">No places yet.</p>
                        </section>
                        <section>
                            <h4 class="pc-insight-h">Top cities</h4>
                            <ol v-if="cities.length" class="pc-place-list">
                                <li v-for="c in cities" :key="c.name + c.country">
                                    <span class="pc-place-name">{{ c.name }}<span v-if="c.country" class="pc-place-cc">{{ c.country }}</span></span>
                                    <span class="pc-place-bar" aria-hidden="true"><i :style="{ width: c.pct + '%' }"></i></span>
                                    <span class="pc-place-num">{{ fmt(c.count) }}</span>
                                </li>
                            </ol>
                            <p v-else class="pc-insight-muted">A city shows once at least 3 visitors come from it.</p>
                        </section>
                    </div>
                    <p class="pc-insight-muted pc-insight-fine">Countries and cities count visitors, once per day each.</p>
                </template>
            </template>

            <p class="pc-insight-privacy">Counts only. We never record who viewed your calendar.</p>
        </div>
    `,
    props: { calendarId: String, where: { type: String, default: 'share_panel' } },
    data() {
        return { ranges: ProInsightMath.RANGES, days: 30, metric: 'views', report: null, longer: null, loading: false, error: '',
            metrics: PRO_STAT_METRICS, W: 600, H: 150 };
    },
    computed: {
        empty() { const t = this.report && this.report.totals; return !t || (!t.views && !t.visitors && !t.followers); },
        headline() {
            const days = (this.report && this.report.days) || [];
            const now = ProInsightMath.periods(days, this.days).now;
            const prev = this.longer ? ProInsightMath.periods(this.longer.days, this.days).prev : null;
            return { now, prev };
        },
        deltas() {
            const out = {}, h = this.headline;
            for (const m of this.metrics) out[m.key] = h.prev ? ProInsightMath.delta(h.now[m.key], h.prev[m.key]) : null;
            return out;
        },
        metricInfo() { return this.metrics.find((m) => m.key === this.metric) || this.metrics[0]; },
        chart() { return ProInsightMath.bars((this.report && this.report.days) || [], this.metric, this.W, this.H); },
        summary() { return ProInsightMath.summary((this.report && this.report.days) || [], this.metric, this.metricInfo.noun); },
        todayKey() { const d = this.report && this.report.days; return d && d.length ? d[d.length - 1].day : ''; },
        firstDay() { const d = this.report && this.report.days; return d && d.length ? ProInsightMath.dayLabel(d[0].day, this.days === 365 ? { month: 'short', year: 'numeric' } : undefined) : ''; },
        lastDay() { return this.todayKey ? 'Today' : ''; },
        countries() {
            const list = (this.report && this.report.countries) || [];
            const top = Math.max(1, ...list.map((c) => c.count));
            return list.slice(0, 8).map((c) => ({ ...c, flag: ProInsightMath.flag(c.code), name: ProInsightMath.countryName(c.code), pct: Math.round((c.count / top) * 100) }));
        },
        cities() {
            const list = (this.report && this.report.cities) || [];
            const top = Math.max(1, ...list.map((c) => c.count));
            return list.slice(0, 8).map((c) => ({ ...c, pct: Math.round((c.count / top) * 100) }));
        },
    },
    mounted() { this.load(true); },
    methods: {
        fmt(n) { return (Number(n) || 0).toLocaleString(); },
        dayLong(day) { return ProInsightMath.dayLabel(day, { weekday: 'short', month: 'short', day: 'numeric' }); },
        setDays(d) { if (d !== this.days) { this.days = d; this.load(false); } },
        async load(first) {
            const seq = (this._seq = (this._seq || 0) + 1);
            const id = encodeURIComponent(this.calendarId || '');
            this.loading = true; this.error = '';
            const longer = ProInsightMath.compareRange(this.days);
            const [r, l] = await Promise.all([
                proInsightApi('GET', `/api/pro/stats?calendar=${id}&days=${this.days}`),
                longer ? proInsightApi('GET', `/api/pro/stats?calendar=${id}&days=${longer}`) : Promise.resolve(null),
            ]);
            if (seq !== this._seq) return;
            this.loading = false;
            if (r.status !== 200 || !r.data || !Array.isArray(r.data.days)) { this.report = null; this.error = proInsightError(r); return; }
            this.report = r.data;
            this.longer = l && l.status === 200 && l.data && Array.isArray(l.data.days) ? l.data : null;
            const where = first ? this.where : 'range';
            proInsightTrack((a) => a.proStatsViewed(where, this.days));
        },
    },
};

const ProHistory = {
    template: /* html */ `
        <div class="pc-insight" data-testid="pro-history">
            <!-- The list of versions -->
            <template v-if="!preview">
                <h3 id="pro-history-title" class="pc-insight-title">History</h3>
                <p class="pc-insight-muted pc-insight-lead">A copy is saved each day the calendar changes, and before every restore.
                    Restoring brings back that version’s events, title and notes.</p>

                <p v-if="loading && !versions" class="pc-insight-muted" aria-live="polite">Loading…</p>
                <p v-else-if="error" class="pc-insight-err" role="alert">{{ error }}</p>
                <p v-else-if="versions && !versions.length" class="pc-insight-empty-title" data-testid="pro-history-empty">
                    No saved versions yet. The first is saved after the next change.</p>

                <div v-for="g in groups" :key="g.start" class="pc-ver-group">
                    <div class="pc-insight-h">{{ g.label }}</div>
                    <ul class="pc-ver-list">
                        <li v-for="v in g.items" :key="v.date" class="pc-ver" data-testid="pro-version">
                            <div class="pc-ver-main">
                                <span class="pc-ver-kind">{{ v.kind === 'restore-point' ? 'Before a restore' : 'Daily snapshot' }}</span>
                                <span class="pc-insight-muted">{{ eventCount(v) }}<template v-if="v.savedAt"> · {{ timeOf(v) }}</template></span>
                            </div>
                            <div class="pc-ver-actions">
                                <button type="button" class="pc-btn pc-btn--sm" @click="openPreview(v)" :disabled="busy">Preview</button>
                                <button type="button" class="pc-btn pc-btn--sm" @click="askRestore(v)" :disabled="busy">Restore</button>
                            </div>
                            <div v-if="confirming && confirming.date === v.date" class="pc-confirm" role="alertdialog" :aria-label="'Restore the version from ' + label(v)">
                                <p class="pc-confirm-title">Restore the version from {{ label(v) }}?</p>
                                <p class="pc-insight-muted">Everyone with the link sees this version right away. You can undo by restoring the version saved just before.</p>
                                <div class="pc-confirm-row">
                                    <button type="button" class="pc-btn pc-btn--primary" @click="restore(v)" :disabled="busy" data-testid="pro-restore-confirm">{{ busy ? 'Restoring…' : 'Restore this version' }}</button>
                                    <button type="button" class="pc-btn" @click="confirming = null" :disabled="busy">Cancel</button>
                                </div>
                            </div>
                        </li>
                    </ul>
                </div>
            </template>

            <!-- One version, read-only -->
            <template v-else>
                <div class="pc-preview-bar" data-testid="pro-preview">
                    <span class="pc-preview-label">Previewing {{ label(preview) }}</span>
                    <span class="pc-preview-actions">
                        <button v-if="!confirming" type="button" class="pc-btn pc-btn--primary" @click="askRestore(preview)" :disabled="busy || !preview.calendar">Restore this version</button>
                        <button type="button" class="pc-btn" @click="closePreview" :disabled="busy">Exit preview</button>
                    </span>
                </div>
                <div v-if="confirming" class="pc-confirm" role="alertdialog" :aria-label="'Restore the version from ' + label(confirming)">
                    <p class="pc-confirm-title">Restore the version from {{ label(confirming) }}?</p>
                    <p class="pc-insight-muted">Everyone with the link sees this version right away. You can undo by restoring the version saved just before.</p>
                    <div class="pc-confirm-row">
                        <button type="button" class="pc-btn pc-btn--primary" @click="restore(confirming)" :disabled="busy" data-testid="pro-restore-confirm">{{ busy ? 'Restoring…' : 'Restore this version' }}</button>
                        <button type="button" class="pc-btn" @click="confirming = null" :disabled="busy">Cancel</button>
                    </div>
                </div>

                <p v-if="!preview.calendar" class="pc-insight-muted" aria-live="polite">Loading…</p>
                <template v-else>
                    <p class="pc-preview-cal">{{ preview.calendar.title || 'Untitled calendar' }}
                        <span class="pc-insight-muted">· {{ previewCount }} {{ previewCount === 1 ? 'event' : 'events' }}</span></p>
                    <p v-if="!previewGroups.length" class="pc-insight-muted">This version has no events.</p>
                    <div v-for="g in shownGroups" :key="g.key" class="pc-prev-day">
                        <div class="pc-insight-h">{{ g.label }}</div>
                        <ul class="pc-prev-list">
                            <li v-for="(e, i) in g.events" :key="i">
                                <span class="pc-prev-time">{{ e.time }}</span>
                                <span class="pc-prev-title">{{ e.title }}<span v-if="e.repeats" class="pc-place-cc">Repeats</span></span>
                            </li>
                        </ul>
                    </div>
                    <button v-if="shownGroups.length < previewGroups.length" type="button" class="pc-link pc-prev-more" @click="showAll = true">
                        Show all {{ previewGroups.length }} dates</button>
                </template>
            </template>
            <p v-if="previewError" class="pc-insight-err" role="alert">{{ previewError }}</p>
        </div>
    `,
    props: { calendarId: String, where: { type: String, default: 'share_panel' } },
    emits: ['restored'],
    data() {
        return { versions: null, loading: false, error: '', preview: null, previewError: '', confirming: null, busy: false, showAll: false };
    },
    computed: {
        groups() { return this.versions ? ProInsightMath.groupVersions(this.versions, Date.now()) : []; },
        previewGroups() { return this.preview && this.preview.calendar ? ProInsightMath.eventsByDate(this.preview.calendar.events) : []; },
        shownGroups() { return this.showAll ? this.previewGroups : this.previewGroups.slice(0, 60); },
        previewCount() { const e = this.preview && this.preview.calendar && this.preview.calendar.events; return Array.isArray(e) ? e.length : e ? Object.keys(e).length : 0; },
    },
    mounted() { this.load(); proInsightTrack((a) => a.proHistoryViewed(this.where)); },
    methods: {
        label(v) { return ProInsightMath.versionLabel(v); },
        timeOf(v) { return new Date(ProInsightMath.versionMs(v)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); },
        eventCount(v) { return v.events === null || v.events === undefined ? 'Saved copy' : `${v.events} ${v.events === 1 ? 'event' : 'events'}`; },
        async load() {
            const seq = (this._seq = (this._seq || 0) + 1);
            this.loading = true; this.error = '';
            const r = await proInsightApi('GET', `/api/pro/versions?calendar=${encodeURIComponent(this.calendarId || '')}`);
            if (seq !== this._seq) return;
            this.loading = false;
            if (r.status !== 200 || !Array.isArray(r.data)) { this.error = proInsightError(r); return; }
            this.versions = r.data;
        },
        async openPreview(v) {
            this.confirming = null; this.previewError = ''; this.showAll = false;
            this.preview = { ...v, calendar: null };
            const r = await proInsightApi('GET', `/api/pro/versions/preview?calendar=${encodeURIComponent(this.calendarId || '')}&date=${encodeURIComponent(v.date)}`);
            if (!this.preview || this.preview.date !== v.date) return;
            if (r.status !== 200 || !r.data || !r.data.calendar) {
                this.preview = null;
                this.previewError = r.status === 404 ? 'That version is no longer saved.' : proInsightError(r);
                return;
            }
            this.preview = { ...v, ...r.data, kind: v.kind };
            proInsightTrack((a) => a.proVersionPreviewed(v.kind));
        },
        closePreview() { this.preview = null; this.confirming = null; this.previewError = ''; },
        askRestore(v) { this.previewError = ''; this.confirming = { date: v.date, day: v.day, kind: v.kind, savedAt: v.savedAt }; },
        async restore(v) {
            if (this.busy) return;
            this.busy = true; this.previewError = '';
            try {
                const r = await proInsightApi('POST', '/api/pro/versions/restore', { calendarId: this.calendarId, date: v.date });
                if (r.status === 200 && r.data && r.data.ok) {
                    proInsightTrack((a) => a.proVersionRestored(v.kind, r.data.unchanged));
                    // A daily snapshot is named by its day; a restore point needs its time to be told apart.
                    const name = v.kind === 'restore-point' ? this.label(v) : new Date(ProInsightMath.versionMs(v)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                    this.$emit('restored', { label: name, unchanged: !!r.data.unchanged, events: r.data.events });
                    this.confirming = null; this.preview = null;
                    this.load();             // today's snapshot is rewritten and a restore point appears
                    return;
                }
                this.previewError = r.status === 404 ? 'That version is no longer saved.' : r.status === 422 ? 'That version can’t be restored: it’s damaged or too large.' : proInsightError(r);
            } finally { this.busy = false; }
        },
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { ProInsightMath };
