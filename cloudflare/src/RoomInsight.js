/**
 * RoomInsight -- the calendar-room half of two Pro features, kept apart from CalendarRoom's lock
 * and sync code so the two can change independently:
 *
 *   1. Stats: counts per UTC day, kept in the room's own SQLite. Counted for every calendar (cheap),
 *      shown only to a Pro calendar's owner (Insight.js decides who may read them).
 *   2. Restore an earlier version: replace the calendar with one of its R2 snapshots, as one
 *      history entry, after writing the current state to R2 as a restore point.
 *
 * Internal routes (only Worker code reaches them; see INSIGHT_ROUTES in CalendarRoom.fetch):
 *   GET  http://internal/cal/<id>/stats?days=30|90|365  -> {days:[{day, views, visitors, followers}], countries, cities, totals}
 *   POST http://internal/cal/<id>/restore-version {version}   -> {ok, v} | {ok:false, error}
 *   GET  http://internal/cal/<id>/stats-dump             -> every stats row, for tests (the Worker serves it in dev mode only)
 *
 * Privacy. Stored: counts, a country tally and a city tally per day. Never stored: IPs, user agents,
 * names, or which visitor saw what. To tell "the same visitor again today" from "someone new" the
 * room keeps, for the current UTC day only, a set of SHA-256(dailySalt + IP + UA) truncated to
 * 8 bytes. The salt is random, made the first time the room is reached on a new day, and deleted
 * with that set when the day rolls over -- so yesterday's hashes can't be reversed or linked to
 * today's. (The roll-over runs on the room's next request: an idle calendar keeps its last active
 * day's salt and hash set until someone reaches it again.)
 *
 * A "view" is a visitor reaching the calendar (WebSocket connect, GET of the data, read-only link),
 * counted at most once per visitor per VIEW_GAP_MS: read-only tabs poll GET /cal/view/<id> every
 * few seconds and sockets reconnect after a network blip, so counting every request would count
 * one person dozens of times. A "follower" is a distinct (salted IP + UA) fetching the ICS feed
 * that day: roughly one per calendar app subscribed (apps that fetch from shared servers, like
 * Google Calendar, count once per server).
 */

export const STATS = {
    keepDays: 400,
    maxSeenPerDay: 5000,          // per kind ('v' visitors, 'f' followers); past it, new people aren't told apart
    viewGapMs: 30 * 60 * 1000,    // the same visitor again within this counts as the same view
    maxCitiesPerDay: 200,         // distinct cities stored per day; later new ones are dropped
    minCityCount: 3,              // a city is shown only with at least this many visitor-days in the range
    top: 20,
};
export const INSIGHT_ROUTES = new Set(['stats', 'stats-dump', 'restore-version']);
// A version is a daily snapshot (2026-10-23) or a restore point written just before a restore (2026-10-23T140509Z).
export const VERSION_RE = /^\d{4}-\d{2}-\d{2}(T\d{6}Z)?$/;

const json = (x) => JSON.stringify(x);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const parseObj = (s) => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };

export function initInsight(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS stats_daily (day TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0, visitors INTEGER NOT NULL DEFAULT 0,
        followers INTEGER NOT NULL DEFAULT 0, countries_json TEXT, cities_json TEXT)`);
    // Today only: deleted, with the salt, when the day rolls over.
    sql.exec(`CREATE TABLE IF NOT EXISTS stats_seen (kind TEXT NOT NULL, hash TEXT NOT NULL, last_at INTEGER, PRIMARY KEY (kind, hash))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS stats_salt (k INTEGER PRIMARY KEY CHECK (k = 1), day TEXT NOT NULL, salt TEXT NOT NULL)`);
}

// Today's salt, rolling the day over first if needed: a new day drops yesterday's salt and hash set
// (only the counts stay) and anything older than keepDays.
function saltFor(room, today) {
    const sql = room.sql;
    let row = room.statsSalt;
    if (!row) row = room.statsSalt = sql.exec(`SELECT day, salt FROM stats_salt`).toArray()[0] || null;
    if (row && row.day === today) return row.salt;
    sql.exec(`DELETE FROM stats_seen`);
    sql.exec(`DELETE FROM stats_salt`);
    sql.exec(`DELETE FROM stats_daily WHERE day < ?`, dayOf(Date.parse(today) - STATS.keepDays * 86400000));
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    sql.exec(`INSERT INTO stats_salt (k, day, salt) VALUES (1, ?, ?)`, today, salt);
    room.statsSalt = { day: today, salt };
    return salt;
}
// Roll over without counting anything (on reads, so a stats read also discards an old salt).
function rollover(room) { saltFor(room, dayOf(Date.now())); }

// Called by CalendarRoom.fetch when the Worker marked the request as a hit (X-PC-Hit: view|follow).
// The Worker strips any X-PC-* a client sent, sets the marker only on calendar reads by non-bots, and
// passes country/city as headers. IP and UA are read here, hashed, and dropped.
export async function countHit(room, request) {
    const kind = request.headers.get('X-PC-Hit') === 'follow' ? 'f' : request.headers.get('X-PC-Hit') === 'view' ? 'v' : null;
    if (!kind || !room.state.id) return;                     // no stats rows for names nobody created
    const now = Date.now(), today = dayOf(now);
    const salt = saltFor(room, today);
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ua = request.headers.get('User-Agent') || '';
    const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\n${ip}\n${ua}`))).slice(0, 16);
    // From here on nothing awaits: the seen-check and the write can't interleave with another hit.
    if (room.statsSalt?.salt !== salt) return;               // the day rolled over while hashing
    const sql = room.sql;
    const seen = sql.exec(`SELECT last_at FROM stats_seen WHERE kind = ? AND hash = ?`, kind, hash).toArray()[0];
    let views = 0, visitors = 0, followers = 0;
    if (kind === 'f') {
        if (seen) return;                                     // this subscriber already counted today
        if (todayCount(sql, today, 'followers') >= STATS.maxSeenPerDay) return;
        sql.exec(`INSERT INTO stats_seen (kind, hash, last_at) VALUES ('f', ?, ?)`, hash, now);
        followers = 1;
    } else if (seen) {
        if (now - seen.last_at < STATS.viewGapMs) return;     // the same visit: a poll, a reconnect, a reload
        sql.exec(`UPDATE stats_seen SET last_at = ? WHERE kind = 'v' AND hash = ?`, now, hash);
        views = 1;
    } else {
        views = 1;
        if (todayCount(sql, today, 'visitors') < STATS.maxSeenPerDay) {
            sql.exec(`INSERT INTO stats_seen (kind, hash, last_at) VALUES ('v', ?, ?)`, hash, now);
            visitors = 1;
        }
    }
    sql.exec(`INSERT INTO stats_daily (day, views, visitors, followers) VALUES (?, ?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET views = views + excluded.views, visitors = visitors + excluded.visitors, followers = followers + excluded.followers`,
        today, views, visitors, followers);
    if (!visitors) return;
    // Places are tallied per new visitor, not per view: one person reloading must not reach the
    // city threshold alone.
    const country = clean(request.headers.get('X-PC-Geo-Country'), 2).toUpperCase();
    let city = ''; try { city = clean(decodeURIComponent(request.headers.get('X-PC-Geo-City') || ''), 80); } catch { /* bad escape */ }
    if (!country && !city) return;
    const row = sql.exec(`SELECT countries_json, cities_json FROM stats_daily WHERE day = ?`, today).one();
    const countries = parseObj(row.countries_json), cities = parseObj(row.cities_json);
    if (/^[A-Z]{2}$/.test(country)) countries[country] = (countries[country] || 0) + 1;
    if (city) {
        const key = `${city}|${/^[A-Z]{2}$/.test(country) ? country : ''}`;
        if (key in cities || Object.keys(cities).length < STATS.maxCitiesPerDay) cities[key] = (cities[key] || 0) + 1;
    }
    sql.exec(`UPDATE stats_daily SET countries_json = ?, cities_json = ? WHERE day = ?`, json(countries), json(cities), today);
}
// Today's visitors/followers equal the rows of that kind in stats_seen (one is added with each).
const todayCount = (sql, day, col) => sql.exec(`SELECT ${col} AS n FROM stats_daily WHERE day = ?`, day).toArray()[0]?.n || 0;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f|]/g, '').trim().slice(0, n);

// What the owner sees: one row per day (oldest first, days with no visits as zeros), the top
// countries, and the top cities that reached minCityCount over the whole range.
export function statsReport(room, days) {
    rollover(room);
    const today = dayOf(Date.now());
    const from = dayOf(Date.parse(today) - (days - 1) * 86400000);
    const rows = room.sql.exec(`SELECT day, views, visitors, followers, countries_json, cities_json FROM stats_daily WHERE day >= ? ORDER BY day`, from).toArray();
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out = [], countries = {}, cities = {};
    for (let i = days - 1; i >= 0; i--) {
        const day = dayOf(Date.parse(today) - i * 86400000), r = byDay.get(day);
        out.push({ day, views: r ? r.views : 0, visitors: r ? r.visitors : 0, followers: r ? r.followers : 0 });
        if (!r) continue;
        for (const [k, n] of Object.entries(parseObj(r.countries_json))) countries[k] = (countries[k] || 0) + n;
        for (const [k, n] of Object.entries(parseObj(r.cities_json))) cities[k] = (cities[k] || 0) + n;
    }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, STATS.top);
    return {
        days: out,
        countries: top(countries).map(([code, count]) => ({ code, count })),
        cities: top(Object.fromEntries(Object.entries(cities).filter(([, n]) => n >= STATS.minCityCount)))
            .map(([k, count]) => { const [name, country] = k.split('|'); return { name, country: country || null, count }; }),
        totals: {
            views: out.reduce((a, d) => a + d.views, 0),
            visitors: out.reduce((a, d) => a + d.visitors, 0),        // a sum of daily uniques: one person on 3 days counts 3
            followers: out.reduce((a, d) => Math.max(a, d.followers), 0),   // the busiest day: apps don't all fetch every day
            followersToday: out[out.length - 1].followers,
        },
    };
}

// For tests (served by the Worker only in dev mode): everything the stats tables hold.
export function statsDump(room) {
    const sql = room.sql;
    return {
        daily: sql.exec(`SELECT * FROM stats_daily ORDER BY day`).toArray(),
        seen: sql.exec(`SELECT kind, hash, last_at FROM stats_seen`).toArray(),
        saltDays: sql.exec(`SELECT day FROM stats_salt`).toArray().map((r) => r.day),
    };
}

// ---- restore an earlier version -------------------------------------------------------------

export const snapshotPrefix = (id) => `snapshots/${encodeURIComponent(id)}/`;
const versionLabel = (version) => version.length > 10 ? `${version.slice(0, 10)} ${version.slice(11, 13)}:${version.slice(13, 15)} UTC` : version;
const restorePointName = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/^(\d{4})(\d{2})(\d{2})T(\d{6})\.\d{3}Z$/, '$1-$2-$3T$4Z');

// Replace the calendar's events, title and notes with a snapshot's. Everything else stays: the lock
// (its own table), every other option (Pro settings, publicViewId, ...). One history entry (counts and
// a label only), and -- first -- the pre-restore state goes to R2 as a restore point: that is the undo,
// since the day's backup is about to be overwritten with the restored state.
// Runs inside blockConcurrencyWhile, so no save can land between reading the state and replacing it;
// errors are caught there, because a throw out of it resets the object (and drops every open tab).
export function restoreVersion(room, version) {
    return room.ctx.blockConcurrencyWhile(async () => {
        try { return await restoreNow(room, version); }
        catch (e) {
            console.error('[restore] failed:', e && e.message);
            room.load();                                       // memory back in step with what SQLite holds
            return { ok: false, status: 502, error: 'unavailable' };
        }
    });
}
async function restoreNow(room, version) {
    const s = room.state, env = room.env;
    const no = (status, error) => ({ ok: false, status, error });
    if (!s.id) return no(404, 'not-found');
    if (!env.BACKUPS) return no(503, 'no-backups');
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return no(400, 'bad-version');
    const obj = await env.BACKUPS.get(`${snapshotPrefix(s.id)}${version}.json`);
    if (!obj) return no(404, 'no-such-version');
    let snap; try { snap = await obj.json(); } catch { return no(422, 'bad-snapshot'); }
    const cal = snap && snap.calendar;
    if (!cal || typeof cal !== 'object') return no(422, 'bad-snapshot');
    const { events } = room.dedupe(cal);
    const why = room.tooBig(events);
    const title = typeof cal.title === 'string' ? cal.title : '';
    if (why || title.length > 2000) return no(422, why || 'title too long');
    const notes = cal.options && typeof cal.options === 'object' ? cal.options.notes : undefined;
    const options = { ...s.options };
    if (notes === undefined || notes === null) delete options.notes; else options.notes = notes;
    if (title === s.title && json(options) === json(s.options) && json(events) === json(s.events)) return { ok: true, unchanged: true, v: s.v };

    const now = Date.now();
    await env.BACKUPS.put(`${snapshotPrefix(s.id)}${restorePointName(now)}.json`,
        json({ v: s.v, savedAt: new Date(now).toISOString(), restorePointFor: version, calendar: room.calendar() }), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { id: s.id, v: String(s.v), events: String(s.events.length), savedAt: new Date(now).toISOString(), kind: 'restore-point' },
        });

    const beforeEvents = s.events, beforeTitle = s.title, beforeOptions = s.options;
    room.sql.exec(`DELETE FROM events`);
    s.events = [];
    room.storeEvents(events, 'all');
    s.title = title; room.setMeta('title', title);
    s.options = options; room.setMeta('options', options);
    room.bump('restore', [{ type: 'restore', version, events: events.length }],
        { beforeEvents, beforeTitle, beforeOptions, kind: 'restored', label: `Restored the version from ${versionLabel(version)}`, countsOnly: true });
    room.broadcast({ t: 'snapshot', v: s.v, calendar: room.calendar() });
    await room.scheduleCopyBack();                         // a no-op while locked; kept for symmetry with other writes
    return { ok: true, v: s.v, events: events.length };
}

export async function insightRoute(room, op, request) {
    const url = new URL(request.url);
    if (op === 'stats' && request.method === 'GET') {
        if (!room.state.id) return Response.json({ error: 'not-found' }, { status: 404 });
        const days = Number(url.searchParams.get('days')) || 30;
        return Response.json(statsReport(room, Math.min(Math.max(Math.floor(days), 1), STATS.keepDays)));
    }
    if (op === 'stats-dump' && request.method === 'GET') return Response.json(statsDump(room));
    if (op === 'restore-version' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const r = await restoreVersion(room, body && body.version);
        return Response.json(r, { status: r.ok ? 200 : r.status });
    }
    return new Response('not found', { status: 404 });
}
