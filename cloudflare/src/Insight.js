/**
 * Insight -- the Worker half of Pro stats and "restore an earlier version" (the room half is
 * RoomInsight.js). Every route is for a Pro calendar's signed-in owner only.
 *
 *   GET  /api/pro/stats?calendar=<id>&days=30|90|365
 *        -> {days:[{day, views, visitors, followers}], countries:[{code, count}],
 *            cities:[{name, country, count}],
 *            apps:{google, apple, outlook, other},       follower-days by calendar app (a share, not people)
 *            hours:[24 numbers],                         counted views by UTC hour; the client shifts to the owner's zone
 *            sources:{embed, search, site, direct},      counted views by where they came from
 *            totals:{views, visitors, followers, followersToday}}
 *   GET  /api/pro/versions?calendar=<id>
 *        -> [{date, day, kind:'daily'|'restore-point', v, events, savedAt}]  newest first
 *   GET  /api/pro/versions/preview?calendar=<id>&date=<date>
 *        -> {date, day, kind, v, savedAt, calendar:{id, title, options, events, ...}}
 *   POST /api/pro/versions/restore {calendarId, date}   (session + CSRF, like other /api/pro POSTs)
 *        -> {ok:true, v, events} | {ok:true, unchanged:true, v}
 *
 * Errors: 400 {error:'bad-calendar'|'bad-days'|'bad-version'}, 401 {error:'signed-out'},
 * 403 {error:'pro-only'} (calendar not on Pro), 403 {error:'not-owner'}, 403 {error:'forbidden-origin'},
 * 404 {error:'no-calendar'|'no-such-version'}, 503 {error:'no-backups'}.
 * Restore also: 429 {error:'too-soon'} (within 5 s of the previous restore), 429 {error:'too-many-restores'}
 * (10 per calendar per hour), 409 {error:'busy'} (the calendar kept changing during the restore).
 * `date` names a version: a daily snapshot (YYYY-MM-DD) or a restore point written just before a
 * restore (YYYY-MM-DDTHHMMSSmmmZ-xxxxxx, UTC, or YYYY-MM-DDTHHMMSSZ for older ones). `day` is its
 * YYYY-MM-DD. Pass `date` back to preview/restore.
 *
 * Whose history. Only versions saved at or after the current lock's lockedAt are listed, previewed or
 * restored, so a calendar reassigned to someone else, or bought by a new owner after the previous
 * subscription ended, starts with a clean history: the new owner never sees what the calendar held
 * under the previous one. Earlier snapshots stay in R2 as backups; Pro routes just don't expose them.
 * lockedAt is per lock, not per owner: an owner who unlocks (or whose subscription ends) and locks
 * again also starts over, seeing only versions saved since the new lock -- anyone could have edited
 * the calendar while it was unlocked, so the gap is not theirs to browse either.
 *
 * Free stats (no Pro, no sign-in): the headline counts for anyone holding an unlocked calendar's
 * edit link -- on an unlocked calendar, knowing its real id is what lets anyone change it (view
 * links name a different id, and the directory never tells a view link's holder the real one).
 *   GET  /api/stats?calendar=<id>  -> {views, viewsPrev, followers}
 * views: the last 7 days (today included); viewsPrev: the 7 before them; followers: calendar apps on
 * the busiest of the last 7 days (as the Pro headline: apps don't all fetch every day). Totals only:
 * per-day rows, places, apps, hours and sources stay Pro. Errors: 400 bad-calendar, 404 no-calendar, 403 locked (a Pro
 * calendar: its owner reads /api/pro/stats), 503 {ok:false, error:'stats-unavailable'} (the room isn't counting
 * yet: it runs code from before stats, as production rooms do for preview until production deploys).
 * /api/pro/stats answers the same 503 then. Never zeros in place of a missing answer.
 *
 * Also here, because the Worker is the only one that may say so: hitHeaders(), which marks a
 * forwarded calendar read as a countable hit for RoomInsight.countHit.
 */
import { LockClient } from './LockClient.js';
import { sameSite } from './Accounts.js';
import { VERSION_RE, snapshotPrefix, savedAtMs, sourceOf } from './RoomInsight.js';

const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const devMode = (env) => env.ACCOUNTS_DEV_MODE === '1';
const DAYS = new Set([30, 90, 365]);

// Crawlers, link previews, monitors, scripts. Calendar apps (Google-Calendar-Importer, Outlook,
// iOS dataaccessd) don't match. The uptime check and GitHub Actions use curl.
const BOT_UA = /bot\b|bot\/|crawler|spider|preview|monitor|uptime|headless|lighthouse|curl\/|wget|python-requests|go-http-client|github/i;
export function isBot(request) {
    const bm = request.cf && request.cf.botManagement;
    if (bm && (bm.verifiedBot === true || (typeof bm.score === 'number' && bm.score > 0 && bm.score < 30))) return true;
    const ua = request.headers.get('User-Agent') || '';
    return !ua || BOT_UA.test(ua);
}

// Headers that mark a forwarded calendar read as a hit ('view' or 'follow'), with the place it came
// from (request.cf; wrangler dev fills it with this machine's place). null for bots. City is
// URI-encoded: header values must be Latin-1. A view also carries where it came from, as a category
// only (RoomInsight.sourceOf): the Referer and the page's ?ref= host stop here.
export function hitHeaders(request, env, kind) {
    if (isBot(request)) return null;
    const country = (request.cf && request.cf.country) || '', city = (request.cf && request.cf.city) || '';
    const h = { 'X-PC-Hit': kind, 'X-PC-Geo-Country': String(country).slice(0, 2), 'X-PC-Geo-City': encodeURIComponent(String(city).slice(0, 80)) };
    if (kind === 'view') {
        const url = new URL(request.url);
        // The page sends where it was opened from as a category only (?src=embed|search|site), so no other
        // site's hostname reaches a URL or a log. ?embed / ?ref still work for older pages.
        const src = url.searchParams.get('src') || '';
        h['X-PC-Source'] = /^(embed|search|site|direct)$/.test(src) ? src : sourceOf({ dest: request.headers.get('Sec-Fetch-Dest') || '', embed: url.searchParams.get('embed') || '',
            ref: url.searchParams.get('ref') || '', referer: request.headers.get('Referer') || '', host: url.host });
    }
    return h;
}
// The page's source markers (?embed=1, ?ref=<host>), removed from a URL before it goes to a room.
export const SOURCE_PARAMS = ['embed', 'ref', 'src'];
export function withoutSourceParams(u) {
    const url = new URL(u);
    if (!SOURCE_PARAMS.some((k) => url.searchParams.has(k))) return u;   // forwarded exactly as it came (from prod-counting-live)
    for (const k of SOURCE_PARAMS) url.searchParams.delete(k);
    return url.toString();
}

// Who may read: a Pro calendar's owner. Returns {userId} or {res} (a refusal).
async function ownerOnly(request, env, id, sessionUserId) {
    if (!validId(id)) return { res: json({ error: 'bad-calendar' }, 400) };
    const [st, userId] = await Promise.all([LockClient.lockStatus(env, id), sessionUserId(request, env)]);
    if (st.status === 404) return { res: json({ error: 'no-calendar' }, 404) };
    if (!st.ok && st.status >= 500) return { res: json({ error: 'unavailable' }, 502) };
    if (!st.locked) return { res: json({ error: 'pro-only' }, 403) };
    if (!userId) return { res: json({ error: 'signed-out' }, 401) };
    if (st.ownerId !== userId) return { res: json({ error: 'not-owner' }, 403) };
    return { userId, lockedAt: typeof st.lockedAt === 'number' ? st.lockedAt : 0 };   // no lockedAt (an old lock): all history
}
const room = (env, id) => env.CALENDARS.get(env.CALENDARS.idFromName(id));
const roomUrl = (id, op) => `http://internal/cal/${encodeURIComponent(id)}/${op}`;

// Every snapshot of a calendar in R2 saved at or after `since` (the lock's lockedAt), newest first
// (by day, then save time), from the listing's metadata. Objects written before `events`/`savedAt`
// were in the metadata are read (up to 20) to fill them in; past that, events is null and savedAt is
// the upload time. A body's savedAt is never later than its upload, so an object uploaded before
// `since` is skipped without reading it.
async function listVersions(env, id, since) {
    const prefix = snapshotPrefix(id), out = [];
    let cursor;
    do {
        const page = await env.BACKUPS.list({ prefix, cursor, include: ['customMetadata'] });
        for (const o of page.objects) {
            const version = o.key.slice(prefix.length).replace(/\.json$/, '');
            if (!VERSION_RE.test(version)) continue;
            const m = o.customMetadata || {};
            if (savedAtMs(null, o) < since || (o.uploaded && new Date(o.uploaded).getTime() < since)) continue;
            out.push({
                date: version, day: version.slice(0, 10), kind: version.length > 10 ? 'restore-point' : 'daily',
                v: m.v !== undefined ? Number(m.v) : null,
                events: m.events !== undefined ? Number(m.events) : null,
                savedAt: m.savedAt || (o.uploaded ? new Date(o.uploaded).toISOString() : null),
            });
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const newestFirst = (a, b) => b.day.localeCompare(a.day) || (b.savedAt || '').localeCompare(a.savedAt || '') || b.date.localeCompare(a.date);
    out.sort(newestFirst);
    await Promise.all(out.filter((x) => x.events === null).slice(0, 20).map(async (x) => {
        const snap = await (await env.BACKUPS.get(`${prefix}${x.date}.json`))?.json().catch(() => null);
        const ev = snap && snap.calendar && snap.calendar.events;
        if (ev) x.events = Array.isArray(ev) ? ev.length : Object.keys(ev).length;
        if (x.v === null && snap && typeof snap.v === 'number') x.v = snap.v;
        if (snap && typeof snap.savedAt === 'string') x.savedAt = snap.savedAt;
    }));
    return out.filter((x) => (x.savedAt ? Date.parse(x.savedAt) : 0) >= since).sort(newestFirst);
}

// A room's stats answer, or null when it isn't one: a non-200, or a body without days[] and totals{}.
// A room running older code (preview's Worker reaches production rooms until production deploys)
// has no stats route and answers the path with the calendar itself; summing that would show zeros.
async function statsPayload(r) {
    if (!r.ok) return null;
    const body = await r.json().catch(() => null);
    return body && Array.isArray(body.days) && body.totals && typeof body.totals === 'object' ? body : null;
}
const statsUnavailable = () => json({ ok: false, error: 'stats-unavailable' }, 503);

// The free headline counts (see the top). The room is reached by the exact id, never through the
// directory, so a view link's id finds no calendar. The lock is read from the room itself, which is
// what decides whether the edit link may write.
async function freeStats(env, id) {
    if (!validId(id)) return json({ error: 'bad-calendar' }, 400);
    const ls = await room(env, id).fetch(roomUrl(id, 'lock-status'));
    if (ls.status === 404) return json({ error: 'no-calendar' }, 404);
    if (!ls.ok) return json({ error: 'unavailable' }, 502);
    if ((await ls.json()).locked) return json({ error: 'locked' }, 403);
    const r = await room(env, id).fetch(`${roomUrl(id, 'stats')}?days=14`);
    const stats = await statsPayload(r);              // lock-status found the calendar: anything else is "not counting yet"
    if (!stats) return statsUnavailable();
    const days = stats.days;
    const last = days.slice(-7), prev = days.slice(-14, -7);
    const sum = (rows) => rows.reduce((a, d) => a + (Number(d.views) || 0), 0);
    return json({ views: sum(last), viewsPrev: sum(prev), followers: last.reduce((a, d) => Math.max(a, Number(d.followers) || 0), 0) });
}

// Returns a Response for the routes above, or null for every other path. `sessionUserId` is the
// Worker's (index.js), so the dev session header works in tests exactly as for the lock routes.
export async function handleInsight(request, env, url, sessionUserId) {
    const path = url.pathname, m = request.method;

    // Test hook (dev mode + admin secret): everything a room's stats tables hold.
    const dump = path.match(/^\/api\/admin\/cal\/([^/]+)\/stats-dump$/);
    if (dump) {
        if (!devMode(env) || !env.IMPORT_SECRET || request.headers.get('Authorization') !== `Bearer ${env.IMPORT_SECRET}`) return new Response('forbidden', { status: 403 });
        let id = null; try { id = decodeURIComponent(dump[1]); } catch { /* bad escape */ }
        if (!validId(id)) return new Response('not found', { status: 404 });
        return room(env, id).fetch(roomUrl(id, 'stats-dump'));
    }

    if (path === '/api/stats') {
        if (m !== 'GET') return json({ error: 'method' }, 405);
        try { return await freeStats(env, url.searchParams.get('calendar')); } catch (err) {
            console.error('[insight]', path, err && err.message);
            return json({ error: 'internal' }, 500);
        }
    }
    if (path !== '/api/pro/stats' && path !== '/api/pro/versions' && path !== '/api/pro/versions/preview' && path !== '/api/pro/versions/restore') return null;
    try {
        if (path === '/api/pro/versions/restore') {
            if (m !== 'POST') return json({ error: 'method' }, 405);
            if (!sameSite(request, env)) return json({ error: 'forbidden-origin' }, 403);
            const body = await request.json().catch(() => null) || {};
            const gate = await ownerOnly(request, env, body.calendarId, sessionUserId);
            if (gate.res) return gate.res;
            if (typeof body.date !== 'string' || !VERSION_RE.test(body.date)) return json({ error: 'bad-version' }, 400);
            if (!env.BACKUPS) return json({ error: 'no-backups' }, 503);
            const r = await room(env, body.calendarId).fetch(roomUrl(body.calendarId, 'restore-version'), { method: 'POST', body: JSON.stringify({ version: body.date }) });
            const out = await r.json().catch(() => ({ ok: false, error: 'unavailable' }));
            delete out.status;
            return json(out, r.status);
        }
        if (m !== 'GET') return json({ error: 'method' }, 405);
        const id = url.searchParams.get('calendar');
        const gate = await ownerOnly(request, env, id, sessionUserId);
        if (gate.res) return gate.res;

        if (path === '/api/pro/stats') {
            const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 30;
            if (!DAYS.has(days)) return json({ error: 'bad-days' }, 400);
            const r = await room(env, id).fetch(`${roomUrl(id, 'stats')}?days=${days}`);
            const stats = await statsPayload(r);
            return stats ? json(stats) : statsUnavailable();
        }
        if (!env.BACKUPS) return json({ error: 'no-backups' }, 503);
        if (path === '/api/pro/versions') return json(await listVersions(env, id, gate.lockedAt));
        // preview
        const version = url.searchParams.get('date') || '';
        if (!VERSION_RE.test(version)) return json({ error: 'bad-version' }, 400);
        const obj = await env.BACKUPS.get(`${snapshotPrefix(id)}${version}.json`);
        if (!obj) return json({ error: 'no-such-version' }, 404);
        const snap = await obj.json().catch(() => null);
        if (!snap || !snap.calendar) return json({ error: 'bad-snapshot' }, 422);
        if (savedAtMs(snap, obj) < gate.lockedAt) return json({ error: 'no-such-version' }, 404);   // before this lock: not this owner's
        return json({ date: version, day: version.slice(0, 10), kind: version.length > 10 ? 'restore-point' : 'daily',
            v: typeof snap.v === 'number' ? snap.v : null, savedAt: snap.savedAt || null, calendar: snap.calendar });
    } catch (err) {
        console.error('[insight]', path, err && err.message);
        return json({ error: 'internal' }, 500);
    }
}
