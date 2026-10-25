/**
 * RoomInsight -- per-calendar stats COUNTING, kept apart from CalendarRoom's sync code. This is the
 * production subset of the Pro branch's RoomInsight.js: it only counts. Nothing here is shown to
 * anyone yet (no stats endpoint); the point is that history accumulates before Pro launches, and the
 * tables and counting are the same as the Pro branch's so its report reads them unchanged.
 *
 *   Stats: counts per UTC day, kept in the room's own SQLite. Counted for every calendar (cheap).
 *
 * Internal route (only Worker code reaches it; see INSIGHT_ROUTES in CalendarRoom.fetch):
 *   GET  http://internal/cal/<id>/stats-dump             -> every stats row, for tests (the Worker serves it in dev mode only)
 *
 * Privacy. Stored: counts, a country tally and a city tally per day, and three category tallies per day
 * (see "Breakdowns" below). Never stored: IPs, user agents, referrers, names, or which visitor saw what. To tell "the same visitor again today" from "someone new" the
 * room keeps, for the current UTC day only, a set of 8-byte hashes: 4 bytes of SHA-256(dailySalt +
 * network) then 4 bytes of SHA-256(dailySalt + network + UA). The salt is random, made the first time
 * the room is reached on a new day, and deleted with that set when the day rolls over -- so
 * yesterday's hashes can't be reversed or linked to today's. (The roll-over runs on the room's next
 * request: an idle calendar keeps its last active day's salt and hash set until someone reaches it again.)
 *
 * Who is a visitor. The network is the IP's prefix (IPv4 /24, IPv6 /64; an IPv4-mapped IPv6 address is
 * read as IPv4): one person can rotate user agents freely, and an IPv6 address within their /64, but
 * rarely their network. The user agent only tells apart up to maxUasPerPrefix people on one network
 * per day (a household, an office); past that, a new UA on that network counts as one of the people
 * already seen there (same view gap, same view cap). So 200 requests from one IP with 200 user agents
 * are at most 3 visitors, and at most 3 views per 30 minutes. Followers (ICS) are told apart the same way.
 * The cost: more than 3 real people behind one office NAT or carrier /24 on one day count as 3.
 *
 * A "view" is a visitor reaching the calendar (WebSocket connect, GET of the data, read-only link),
 * counted at most once per visitor per VIEW_GAP_MS: read-only tabs poll GET /cal/view/<id> every
 * few seconds and sockets reconnect after a network blip, so counting every request would count
 * one person dozens of times. And at most maxViewsPerVisitor views per visitor per day. A "follower"
 * is a distinct visitor (as above) fetching the ICS feed that day: roughly one per calendar app
 * subscribed (apps that fetch from shared servers, like Google Calendar, count once per network).
 *
 * The daily cap. Past maxSeenPerDay visitors in a day, the visitors number stops growing (the owner
 * sees a floor), but people keep being tracked up to maxTrackedPerDay hashes, so their views are still
 * deduplicated and capped like anyone's, and their country/city still counts once per new network.
 * Past maxTrackedPerDay (an attack, or a calendar far beyond any real one), new people's views are
 * not counted at all: counting them with no dedup would let a reload loop inflate views without bound.
 *
 * Places are shown only above a threshold of distinct visitors over the requested range (city 5,
 * country 3), so a place can't single out a handful of people. Distinct visitors can't be counted
 * across days without a cross-day identifier (which would make the hashes linkable), so the check uses
 * a conservative lower bound: the largest single-day count for that place in the range (distinct
 * networks that day). A place is shown only if some one day reached the threshold; the count shown is
 * the sum of daily counts (visitor-days).
 *
 * Breakdowns (per UTC day, counts only; each one is a fixed small set of categories, never a string the
 * visitor sent):
 *   - apps: {google, apple, outlook, other}, +1 in the follower's app each time a follower is counted
 *     (so the dedup, the 4th-UA collapse and the daily cap above apply to it unchanged: one app fetching
 *     the feed 5 times a day is 1). The app comes from appOf(User-Agent) at that moment; the UA is then
 *     dropped like always. Over a range the report sums days (follower-days): read it as a share, not
 *     as people -- one iPhone subscribed all month is 30 there and 1 in the followers headline.
 *   - hours: 24 numbers, counted views by UTC hour of day. The client shifts them to the owner's time
 *     zone (a whole-hour shift; half-hour zones round).
 *   - sources: {embed, search, site, direct}, +1 per counted view. The Worker derives it (sourceOf, from
 *     Sec-Fetch-Dest, the referrer host and an embed marker the page may send) and forwards only the
 *     category, as X-PC-Source; the room never sees which site or search engine it was.
 * None is thresholded like places: a category or an hour can't name a place or a person.
 */

export const STATS = {
    keepDays: 400,
    maxSeenPerDay: 5000,          // per kind ('v' visitors, 'f' followers): the daily count stops growing here
    maxTrackedPerDay: 20000,      // hashes kept per kind per day; past it, new people aren't counted at all
    maxUasPerPrefix: 3,           // people told apart (by user agent) on one network (/24, /64) per day
    maxViewsPerVisitor: 50,       // views counted per visitor per day
    viewGapMs: 30 * 60 * 1000,    // the same visitor again within this counts as the same view
    maxCitiesPerDay: 200,         // distinct cities stored per day; later new ones are dropped
    minCityVisitors: 5,           // a city is shown only if one day in the range had this many distinct visitors from it
    minCountryVisitors: 3,        // the same for a country
    top: 20,
};
export const APPS = ['google', 'apple', 'outlook', 'other'];
export const SOURCES = ['embed', 'search', 'site', 'direct'];
export const INSIGHT_ROUTES = new Set(['stats-dump']);

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
    // Per-visitor views today (capped at STATS.maxViewsPerVisitor); added after the table existed.
    try { sql.exec(`ALTER TABLE stats_seen ADD COLUMN views INTEGER NOT NULL DEFAULT 0`); } catch { /* already there */ }
    // Breakdowns (category tallies, JSON); added after the table existed. NULL (older rows) reads as empty.
    for (const col of ['apps_json', 'hours_json', 'sources_json']) {
        try { sql.exec(`ALTER TABLE stats_daily ADD COLUMN ${col} TEXT DEFAULT NULL`); } catch { /* already there */ }
    }
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

// The network an IP belongs to: "a.b.c" for IPv4 (/24), the first 4 groups for IPv6 (/64).
export function ipPrefix(ip) {
    ip = String(ip || '').trim().toLowerCase();
    const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}`;
    if (!ip.includes(':') || !/^[0-9a-f:]+$/.test(ip)) return ip;
    let [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

// Which calendar app a follower's User-Agent is (one of APPS). Real strings seen on ICS fetches:
//   google   Google-Calendar-Importer                    (Google's servers, for every Google Calendar user)
//   apple    iOS/26.6 (23G71) dataaccessd/1.0, macOS/26.6.2 (25G83) dataaccessd/1.0,
//            Mac OS X/10.15.7 (19H15) CalendarAgent/954, iOS/17.5 (21F79) accountsd/1.0
//   outlook  Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro), Outlook-iOS/1.0,
//            Microsoft.Exchange/15.20 (Windows NT 10.0), ExchangeWebServices/15.0, Microsoft Outlook Calendar
//   other    ICSx5/2.2.5 (ical4j/3.2.19 okhttp/4.12.0 Android/14), Thunderbird, Fastmail, DAVx5, Proton, ...
// Microsoft is tested before Apple: Outlook for Mac says "Macintosh; Mac OS X". Apple is keyed on its
// calendar daemons and the "<os>/<version> (<build>)" shape they lead with, never on OS words alone
// (Thunderbird on a Mac says "Intel Mac OS X" too).
export function appOf(ua) {
    ua = String(ua || '');
    if (/Google-?Calendar/i.test(ua)) return 'google';
    if (/Outlook|Microsoft[ .-]?Exchange|ExchangeWebServices|Microsoft Office\//i.test(ua)) return 'outlook';
    if (/dataaccessd|CalendarAgent|CalendarStore|accountsd|iCal\/|^(iOS|iPadOS|macOS|Mac[ _]OS[ _]X|watchOS|visionOS)\/[\d.]+ \(/i.test(ua)) return 'apple';
    return 'other';
}

// Where a view came from (one of SOURCES), for the Worker (Insight.hitHeaders); only the result is
// forwarded. dest: Sec-Fetch-Dest. embed: the page's own marker (?embed=1, when it runs in a frame).
// ref: the page's document.referrer host (?ref=), else the Referer header's host. host: this request's
// host, which counts as pastecal itself. The calendar's data and socket requests come from pastecal's
// page, so without the page's markers their Referer is pastecal: 'direct'.
const SEARCH_HOST = /(^|\.)(google\.[a-z.]{2,7}|bing\.com|duckduckgo\.com|search\.yahoo\.(com|co\.jp)|yahoo\.com|yandex\.[a-z.]{2,6}|ya\.ru|baidu\.com|ecosia\.org|search\.brave\.com|startpage\.com|qwant\.com|naver\.com|kagi\.com|seznam\.cz|sogou\.com)$/;
const NOT_SEARCH = /^(mail|calendar|docs|drive|sites|groups|classroom|meet|chat|maps)\.google\./;
// Mail and messaging on the web: a link someone sent you is "direct", as it is from apps that strip the referrer.
const MESSAGE_HOST = /(^|\.)(mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com|web\.whatsapp\.com|web\.telegram\.org|teams\.microsoft\.com|app\.slack\.com|discord\.com|messenger\.com|mail\.proton\.me)$/;
export function refHost(s) {
    s = String(s || '').trim().toLowerCase();
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]*:/.test(s)) { try { s = new URL(s).hostname; } catch { return ''; } }
    s = s.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return /^[a-z0-9.:-]{1,253}$/.test(s) ? s : '';
}
export function sourceOf({ dest = '', embed = '', ref = '', referer = '', host = '' } = {}) {
    if (embed === '1' || /^(iframe|frame|embed|object)$/i.test(dest)) return 'embed';
    const h = refHost(ref) || refHost(referer);
    if (!h) return 'direct';
    const self = refHost(host);
    if ((self && h === self) || /(^|\.)pastecal\.com$/.test(h) || /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(h)) return 'direct';
    if (MESSAGE_HOST.test(h)) return 'direct';
    if (SEARCH_HOST.test(h) && !NOT_SEARCH.test(h)) return 'search';
    return 'site';
}
const parseHours = (s) => { try { const a = JSON.parse(s || 'null'); if (Array.isArray(a) && a.length === 24) return a.map((n) => Number(n) || 0); } catch { /* bad row */ } return Array(24).fill(0); };

// Called by CalendarRoom.fetch when the Worker marked the request as a hit (X-PC-Hit: view|follow).
// The Worker strips any X-PC-* a client sent, sets the marker only on calendar reads by non-bots, and
// passes country/city as headers. IP and UA are read here, hashed, and dropped.
export async function countHit(room, request) {
    const kind = request.headers.get('X-PC-Hit') === 'follow' ? 'f' : request.headers.get('X-PC-Hit') === 'view' ? 'v' : null;
    if (!kind || !room.state.id) return;                     // no stats rows for names nobody created
    const now = Date.now(), today = dayOf(now);
    const salt = saltFor(room, today);
    const net = ipPrefix(request.headers.get('CF-Connecting-IP'));
    const ua = request.headers.get('User-Agent') || '';
    const netHash = (await sha(`${salt}\n${net}`)).slice(0, 8);
    let hash = netHash + (await sha(`${salt}\n${net}\n${ua}`)).slice(0, 8);
    // From here on nothing awaits: the seen-check and the write can't interleave with another hit.
    if (room.statsSalt?.salt !== salt) return;               // the day rolled over while hashing
    const sql = room.sql;
    let seen = sql.exec(`SELECT hash, last_at, views FROM stats_seen WHERE kind = ? AND hash = ?`, kind, hash).toArray()[0];
    let newNetwork = false;
    if (!seen) {
        const onNet = sql.exec(`SELECT hash, last_at, views FROM stats_seen WHERE kind = ? AND substr(hash, 1, 8) = ? ORDER BY hash LIMIT ?`,
            kind, netHash, STATS.maxUasPerPrefix).toArray();
        if (onNet.length >= STATS.maxUasPerPrefix) { seen = onNet[0]; hash = seen.hash; }   // a 4th UA here: one of those already seen
        newNetwork = onNet.length === 0;
    }
    const tracked = () => sql.exec(`SELECT COUNT(*) AS n FROM stats_seen WHERE kind = ?`, kind).one().n;
    let views = 0, visitors = 0, followers = 0;
    if (kind === 'f') {
        if (seen) return;                                     // this subscriber already counted today
        if (tracked() >= STATS.maxTrackedPerDay) return;
        sql.exec(`INSERT INTO stats_seen (kind, hash, last_at, views) VALUES ('f', ?, ?, 0)`, hash, now);
        followers = todayCount(sql, today, 'followers') < STATS.maxSeenPerDay ? 1 : 0;
        if (!followers) return;
    } else if (seen) {
        if (now - seen.last_at < STATS.viewGapMs) return;     // the same visit: a poll, a reconnect, a reload
        if ((seen.views || 0) >= STATS.maxViewsPerVisitor) return;
        sql.exec(`UPDATE stats_seen SET last_at = ?, views = views + 1 WHERE kind = 'v' AND hash = ?`, now, hash);
        views = 1;
    } else {
        if (tracked() >= STATS.maxTrackedPerDay) return;      // see "The daily cap" above
        sql.exec(`INSERT INTO stats_seen (kind, hash, last_at, views) VALUES ('v', ?, ?, 1)`, hash, now);
        views = 1;
        visitors = todayCount(sql, today, 'visitors') < STATS.maxSeenPerDay ? 1 : 0;
    }
    sql.exec(`INSERT INTO stats_daily (day, views, visitors, followers) VALUES (?, ?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET views = views + excluded.views, visitors = visitors + excluded.visitors, followers = followers + excluded.followers`,
        today, views, visitors, followers);
    // The breakdowns and places, in the same synchronous step (see "Breakdowns" and "Places" at the top).
    const row = sql.exec(`SELECT countries_json, cities_json, apps_json, hours_json, sources_json FROM stats_daily WHERE day = ?`, today).one();
    const set = {};
    const bump = (col, key) => { const o = parseObj(row[col]); o[key] = (o[key] || 0) + 1; set[col] = json(o); };
    if (followers) bump('apps_json', appOf(ua));
    if (views) {
        const hours = parseHours(row.hours_json);
        hours[new Date(now).getUTCHours()] += 1;
        set.hours_json = json(hours);
        const src = request.headers.get('X-PC-Source');
        bump('sources_json', SOURCES.includes(src) ? src : 'direct');
    }
    if (kind === 'v' && newNetwork) {
        // Places are tallied once per network per day, not per view or per user agent: one person
        // reloading, or switching browsers, must not move a city toward the threshold alone.
        const country = clean(request.headers.get('X-PC-Geo-Country'), 2).toUpperCase();
        let city = ''; try { city = clean(decodeURIComponent(request.headers.get('X-PC-Geo-City') || ''), 80); } catch { /* bad escape */ }
        const countries = parseObj(row.countries_json), cities = parseObj(row.cities_json);
        if (/^[A-Z]{2}$/.test(country)) { countries[country] = (countries[country] || 0) + 1; set.countries_json = json(countries); }
        if (city) {
            const key = `${city}|${/^[A-Z]{2}$/.test(country) ? country : ''}`;
            if (key in cities || Object.keys(cities).length < STATS.maxCitiesPerDay) { cities[key] = (cities[key] || 0) + 1; set.cities_json = json(cities); }
        }
    }
    const cols = Object.keys(set);
    if (cols.length) sql.exec(`UPDATE stats_daily SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE day = ?`, ...cols.map((c) => set[c]), today);
}
// Today's visitors/followers so far (the rows of that kind in stats_seen, up to maxSeenPerDay).
const todayCount = (sql, day, col) => sql.exec(`SELECT ${col} AS n FROM stats_daily WHERE day = ?`, day).toArray()[0]?.n || 0;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f|]/g, '').trim().slice(0, n);

// For tests (served by the Worker only in dev mode): everything the stats tables hold.
export function statsDump(room) {
    const sql = room.sql;
    return {
        daily: sql.exec(`SELECT * FROM stats_daily ORDER BY day`).toArray(),
        seen: sql.exec(`SELECT kind, hash, last_at FROM stats_seen`).toArray(),
        saltDays: sql.exec(`SELECT day FROM stats_salt`).toArray().map((r) => r.day),
    };
}

export async function insightRoute(room, op, request) {
    if (op === 'stats-dump' && request.method === 'GET') return Response.json(statsDump(room));
    return new Response('not found', { status: 404 });
}
