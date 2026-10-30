#!/usr/bin/env node
/**
 * Each new calendar's first two weeks, and the weekly funnel: created -> 1+ event -> 3+ events -> a second person
 * -> a calendar-app follower -> still used in days 8-14. Where do the ~87% of new calendars stall?
 *
 *   ./scripts/stats.sh firsttwo [-d 28] [-j]          (the usual way in; read-only)
 *   node scripts/firsttwo.mjs --base https://pastecal.com [--days 28] [--json]
 *
 * Read-only, from data that already exists (nothing new is recorded):
 *   - the newest daily full archive (R2 archive/daily/<date>.json.gz, via `cf r2 objects get`): every calendar's
 *     id, lastEditedAt and directory rows. Only used to pick candidates (edited since the window began).
 *   - each candidate's Recent changes (GET /cal/<id>/history, the newest 20 saves: when, kind, how many events
 *     added, and which browser wrote it) and its author signal (GET /cal/<id>/authors, admin: Firebase uids with
 *     first/last seen and the days they edited). Neither request counts as a view (index.js marks only GET /cal/<id>
 *     and /ws), so this report does not disturb the numbers it reads.
 *   - Analytics Engine `cal_hit` (RoomInsight.countHit): per calendar per UTC day, visits, new visitors and
 *     calendar-app followers, keyed by sha256("cal\n"+id)[:12]. It starts Oct 25 2026, so views and follows are
 *     only known from then on (see "Gaps" in the printed footer).
 *
 * A calendar is new when its history holds its 'created' save (so the 20-save window still reaches its birth) and
 * its directory row is no older than that. Busy calendars whose 'created' save has scrolled out are dated by their
 * directory row instead and counted as "dated by row". test-/zz- names (automated runs) are left out.
 *
 * Privacy: nothing names a calendar. Rows show the same 12-character hash as Analytics Engine; titles, events,
 * writer ids and uids are counted, never printed. The admin secret comes from IMPORT_SECRET, else the macOS
 * Keychain item pastecal-import-secret, and goes in a header only (as scripts/backfill-rooms.mjs).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import CalendarName from '../public/services/CalendarName.js';

export const DAY = 86400000;
export const WINDOW_DAYS = 14;
export const HIT_DATA_FROM = '2026-10-26';      // first whole UTC day of cal_hit (deployed during Oct 25)
export const NOT_CAL = /^(test-|zz-)/i;         // automated runs (stats.sh NOT_CAL_RE's bare prefixes)
const HISTORY_ROWS = 20;                        // GET /cal/<id>/history returns the newest 20

export const calHash = (id) => createHash('sha256').update(`cal\n${id}`).digest('hex').slice(0, 12);
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const midnight = (ms) => Date.parse(utcDay(ms));
export const dayIndex = (birth, ms) => Math.round((midnight(ms) - midnight(birth)) / DAY);
// Monday (UTC) of the ISO week holding ms.
export const weekOf = (ms) => { const m = midnight(ms); return utcDay(m - ((new Date(m).getUTCDay() + 6) % 7) * DAY); };

const changed = (e) => (e.added || 0) + (e.removed || 0) + (e.changed || 0) > 0 || e.kind === 'created';

/**
 * When was this calendar born, if it is new? history: GET /cal/<id>/history (any order). dirCreatedAt: its
 * editable directory row's created_at, or null. fbFirst: what the last Firebase backup knew (firebaseEvidence):
 * undefined = not there, 0 = there with no date, else its earliest save or author. -> {birth, how: 'created'|'row'}
 * or null: older than the Worker's history (the Oct 4 2026 backfill and later re-registrations stamped directory
 * rows of old calendars), or an old calendar that was emptied and refilled ('created' again).
 */
export function birthOf(history, dirCreatedAt = null, fbFirst = undefined) {
    const rows = (history || []).filter((e) => Number.isFinite(e.savedAt)).sort((a, b) => a.savedAt - b.savedAt);
    if (!rows.length) return null;
    const olderInFirebase = (birth) => fbFirst !== undefined && (fbFirst === 0 || fbFirst < birth - DAY);
    const first = rows.find(changed);
    if (first && first.kind === 'created') {
        // A row registered well before the 'created' save means an old calendar that was emptied and refilled.
        if (dirCreatedAt != null && dirCreatedAt < first.savedAt - DAY) return null;
        return olderInFirebase(first.savedAt) ? null : { birth: first.savedAt, how: 'created' };
    }
    // The 'created' save scrolls out of a busy calendar's newest 20. Then its row dates it, if nothing in the
    // history is older than the row and Firebase never had it earlier.
    if (rows.length >= HISTORY_ROWS && dirCreatedAt != null && rows[0].savedAt >= dirCreatedAt - 60000 && !olderInFirebase(dirCreatedAt)) {
        return { birth: dirCreatedAt, how: 'row' };
    }
    return null;
}

/**
 * From a Firebase backup (the calendars before the move to Cloudflare): name key (CalendarName.key) -> the earliest
 * dated save (history) or author (calendar_authors) of any calendar with that key, or 0 when one has no date. By
 * key, not exact id: the Oct 22 2026 repairs re-created case variants ("Foo" for "foo") as rooms with a fresh
 * 'created' save, and a new name can never share an old one's key (the directory opens the old calendar instead).
 */
export function firebaseEvidence(db) {
    const dated = new Map(), out = new Map();
    const note = (id, t) => { if (Number.isFinite(t) && t > 0) dated.set(id, Math.min(dated.get(id) ?? t, t)); };
    for (const [id, entries] of Object.entries((db && db.history) || {})) for (const e of Object.values(entries || {})) note(id, e && e.savedAt);
    for (const [id, uids] of Object.entries((db && db.calendar_authors) || {})) for (const a of Object.values(uids || {})) note(id, a && a.firstSeen);
    for (const id of Object.keys((db && db.calendars) || {})) {
        const k = CalendarName.key(id), t = dated.get(id) || 0;
        out.set(k, out.has(k) ? (out.get(k) === 0 || t === 0 ? 0 : Math.min(out.get(k), t)) : t);
    }
    return out;
}

/**
 * Births that came in bulk: `size` or more within `spanMs` of each other (site-wide, about ten calendars are made a
 * day). Seen Oct 14 05:00-06:00 and Oct 22 16:20 2026: one-event calendars made minutes apart, repairs and test runs,
 * not people. -> Set of indexes into births.
 */
export function bulkBirths(births, { size = 8, spanMs = 3600000 } = {}) {
    const order = births.map((t, i) => [t, i]).sort((a, b) => a[0] - b[0]);
    const out = new Set();
    for (let lo = 0, hi = 0; hi < order.length; hi++) {
        while (order[hi][0] - order[lo][0] > spanMs) lo++;
        if (hi - lo + 1 >= size) for (let j = lo; j <= hi; j++) out.add(order[j][1]);
    }
    return out;
}

/**
 * One calendar's first 14 days (day 0 = its birth's UTC day). hits: [{day:'YYYY-MM-DD', views, visitors, followers}]
 * from cal_hit. today: 'YYYY-MM-DD'. Days are UTC calendar days.
 */
export function firstTwoWeeks({ birth, how = 'created', history = [], authors = [], hits = [], today, hitsFrom = HIT_DATA_FROM }) {
    const inWin = (d) => d >= 0 && d < WINDOW_DAYS;
    const todayIdx = dayIndex(birth, Date.parse(today));
    const saves = history.filter((e) => Number.isFinite(e.savedAt) && e.savedAt >= birth && changed(e))
        .map((e) => ({ ...e, d: dayIndex(birth, e.savedAt) })).filter((e) => inWin(e.d)).sort((a, b) => a.savedAt - b.savedAt);
    const adds = saves.filter((e) => e.added > 0);
    // Second editor: two sources in different id spaces (writer = a browser id on every save; author = a Firebase
    // uid), so each is counted on its own and the earlier day wins. Never mixed: one person would count twice.
    const secondDay = (firsts) => { const s = [...firsts].sort((a, b) => a - b); return s.length >= 2 ? s[1] : null; };
    const writerFirst = new Map();
    for (const e of saves) if (e.writer && !writerFirst.has(e.writer)) writerFirst.set(e.writer, e.d);
    const authorFirst = authors.filter((a) => Number.isFinite(a.firstSeen)).map((a) => dayIndex(birth, Math.max(a.firstSeen, birth))).filter(inWin);
    const editorDays = [secondDay(writerFirst.values()), secondDay(authorFirst)].filter((d) => d != null);
    const hitRows = hits.map((h) => ({ ...h, d: dayIndex(birth, Date.parse(h.day)) })).filter((h) => inWin(h.d)).sort((a, b) => a.d - b.d);
    const viewerRow = hitRows.find((h) => h.visitors >= 2);
    const followRow = hitRows.find((h) => h.followers > 0);
    const wk2 = (d) => d >= 7 && d < WINDOW_DAYS;
    const authorWk2 = authors.some((a) => (a.days || []).some((day) => wk2(dayIndex(birth, Date.parse(day)))));
    // Views are known only from hitsFrom; days before it, and days not over yet, are unobserved.
    const firstHitIdx = Math.max(0, dayIndex(birth, Date.parse(hitsFrom)));
    return {
        hash: null,
        born: utcDay(birth),
        week: weekOf(birth),
        dated: how,
        age: todayIdx,                                               // whole days since birth
        complete: todayIdx >= WINDOW_DAYS,                           // all 14 days are over
        firstEventDay: adds.length ? adds[0].d : null,
        events: adds.reduce((n, e) => n + e.added, 0),
        eventsFloor: how !== 'created',                              // saves before the newest 20 are not visible
        secondEditorDay: editorDays.length ? Math.min(...editorDays) : null,
        secondViewerDay: viewerRow ? viewerRow.d : null,
        followerDay: followRow ? followRow.d : null,
        activeWeek2: saves.some((e) => wk2(e.d)) || authorWk2 || hitRows.some((h) => wk2(h.d) && h.views > 0),
        // Views/follows observed for days [hitsFromDay, min(today, 14)): the whole window only when both ends hold.
        hitsObservedFrom: firstHitIdx < WINDOW_DAYS ? firstHitIdx : null,
        hitsWhole: firstHitIdx === 0 && todayIdx >= WINDOW_DAYS,
    };
}

/** The weekly funnel from per-calendar rows (firstTwoWeeks output). */
export function funnel(rows) {
    const weeks = new Map();
    for (const r of rows) { if (!weeks.has(r.week)) weeks.set(r.week, []); weeks.get(r.week).push(r); }
    return [...weeks.keys()].sort().map((week) => {
        const c = weeks.get(week);
        const n = (f) => c.filter(f).length;
        const done = c.filter((r) => r.complete);
        return {
            week,
            created: c.length,
            datedByRow: n((r) => r.dated === 'row'),
            event1: n((r) => r.firstEventDay != null),
            event3: n((r) => r.events >= 3),
            secondPerson: n((r) => r.secondEditorDay != null || r.secondViewerDay != null),
            secondEditor: n((r) => r.secondEditorDay != null),
            follower: n((r) => r.followerDay != null),
            // Week-2 use, among calendars whose 14 days are over.
            week2Of: done.length,
            week2: done.filter((r) => r.activeWeek2).length,
            // Views/follows are floors unless every calendar's whole window was observed.
            hitsWhole: c.every((r) => r.hitsWhole),
            hitsSeen: n((r) => r.hitsObservedFrom != null),
        };
    });
}

const pct = (a, b) => (b ? `${a} (${Math.round((100 * a) / b)}%)` : `${a}`);
const pad = (rows) => {
    const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    return rows.map((r) => r.map((x, i) => String(x).padEnd(w[i])).join('  ').trimEnd()).join('\n');
};

/** The printed report (pure, for the test). */
export function render(rows, { today, days, bulk = 0 }) {
    const f = funnel(rows);
    const out = [];
    out.push(`New calendars' first two weeks -- born in the last ${days} days (to ${today}, UTC days; this week partial)`);
    out.push('');
    if (!f.length) { out.push('  (no new calendars found)'); return out.join('\n'); }
    const head = ['born week', 'created', '1+ event', '3+ events', '2nd person', 'follower', 'active wk2'];
    out.push(pad([head, ...f.map((w) => {
        const floor = w.hitsWhole ? '' : '+';
        return [w.week, String(w.created), pct(w.event1, w.created), pct(w.event3, w.created),
            pct(w.secondPerson, w.created) + floor, pct(w.follower, w.created) + floor,
            w.week2Of ? `${pct(w.week2, w.week2Of)}${w.week2Of < w.created ? ` of ${w.week2Of}` : ''}${floor}` : 'too young'];
    })]).replace(/^/gm, '  '));
    out.push('');
    out.push('  created            saved under a name (a draft never saved is not on the server, so it is not counted)');
    out.push('  1+ / 3+ event      events added in its first 14 days, d0-d13 (Recent changes)');
    out.push('  2nd person         a second browser edited it (writer id or uid), or a day with 2+ visitors; one person on two');
    out.push('                     devices counts too, as in stats.sh northstar');
    out.push('  follower           a calendar app fetched its feed in d0-d13');
    out.push("  active wk2         an edit, or a visit, in d7-d13 (visits include the creator's own), of calendars 14+ days old");
    out.push('  +                  a floor: visits and follows are only recorded from 2026-10-26, so part of these windows is unseen');
    const byRow = f.reduce((a, w) => a + w.datedByRow, 0);
    if (byRow) out.push(`  ${byRow} calendar(s) dated by their directory row (their created save scrolled out of the newest 20): event counts are floors`);
    if (bulk) out.push(`  ${bulk} calendar(s) left out: made in bulk (8+ within an hour: repairs and test runs, not people)`);
    out.push('');
    out.push('Per calendar (hash = Analytics Engine blob9; d = days after birth, 0 = the day it was made)');
    out.push('');
    const cell = (d) => (d == null ? '-' : `d${d}`);
    out.push(pad([['hash', 'born', 'age', 'first event', 'events', '2nd editor', '2nd viewer', 'follower', 'wk2', 'views seen'],
        ...rows.slice().sort((a, b) => (a.born < b.born ? -1 : a.born > b.born ? 1 : 0)).map((r) => [
            r.hash, r.born, `${r.age}d`, cell(r.firstEventDay), `${r.events}${r.eventsFloor ? '+' : ''}`,
            cell(r.secondEditorDay), cell(r.secondViewerDay), cell(r.followerDay),
            r.complete ? (r.activeWeek2 ? 'yes' : 'no') : (r.activeWeek2 ? 'yes' : '..'),
            r.hitsObservedFrom == null ? 'no' : `from d${r.hitsObservedFrom}`])]).replace(/^/gm, '  '));
    return out.join('\n');
}

// ---- I/O (not under test) ---------------------------------------------------------------------------------------

function cf(args, opts = {}) { return execFileSync('cf', args, { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }

function newestArchive() {
    const list = JSON.parse(cf(['r2', 'objects', 'list', '--bucket-name', 'pastecal-backups', '--prefix', 'archive/daily/']).toString());
    const keys = list.map((o) => o.key).filter((k) => /^archive\/daily\/\d{4}-\d{2}-\d{2}\.json\.gz$/.test(k)).sort();
    if (!keys.length) throw new Error('no daily archive in R2');
    const key = keys[keys.length - 1];
    const lines = gunzipSync(cf(['r2', 'objects', 'get', '--bucket-name', 'pastecal-backups', key])).toString('utf8').split('\n');
    return { key, lines };
}

// The newest Firebase backup (R2 firebase/, copies of the pre-Cloudflare database; the last is Oct 10 2026).
function newestFirebase() {
    const keys = [];
    for (const m of ['2026-10', '2026-11', '2026-12']) {
        const list = JSON.parse(cf(['r2', 'objects', 'list', '--bucket-name', 'pastecal-backups', '--prefix', `firebase/${m}`]).toString());
        keys.push(...list.map((o) => o.key).filter((k) => /_data\.json\.gz$/.test(k)));
    }
    if (!keys.length) throw new Error('no Firebase backup in R2');
    const key = keys.sort()[keys.length - 1];
    const db = JSON.parse(gunzipSync(cf(['r2', 'objects', 'get', '--bucket-name', 'pastecal-backups', key])).toString('utf8'));
    return { key, evidence: firebaseEvidence(db) };
}

function aeQuery(sql) {   // as scripts/ux.sh query(): the API token if set, else the cf CLI
    const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
    if (token && account) {
        return execFileSync('curl', ['-sS', `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
            '-H', '@-', '--data', `${sql} FORMAT JSON`], { input: `Authorization: Bearer ${token}\n` }).toString();
    }
    const dir = mkdtempSync(join(tmpdir(), 'firsttwo-'));
    try { writeFileSync(join(dir, 'q.sql'), `${sql} FORMAT JSON`); return cf(['analytics_engine', 'sql', 'query', '--file', join(dir, 'q.sql')]).toString(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
}

async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
}
async function getJson(url, headers = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': 'pastecal-stats/firsttwo (read-only)', ...headers }, signal: AbortSignal.timeout(20000) });
            if (r.status === 404) return [];
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (e) { if (attempt >= 3) throw e; await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const opt = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
    const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
    const base = (opt('--base') || '').replace(/\/+$/, '');
    const days = Number(opt('--days') || 28);
    const asJson = flag('--json');
    if (!base || !Number.isInteger(days) || days < 1 || args.length) {
        console.error('usage: firsttwo.mjs --base <url> [--days N] [--json]'); process.exit(2);
    }
    let secret = process.env.IMPORT_SECRET || '';
    if (!secret) {
        try { secret = execFileSync('security', ['find-generic-password', '-s', 'pastecal-import-secret', '-w'], { encoding: 'utf8' }).trim(); }
        catch { console.error('no IMPORT_SECRET and no Keychain item pastecal-import-secret'); process.exit(2); }
    }
    const now = Date.now(), today = utcDay(now);
    const from = midnight(now) - (days - 1) * DAY;

    process.stderr.write('reading the newest daily archive...\n');
    const { key, lines } = newestArchive();
    const lastEdited = new Map(), rowAt = new Map();
    for (const line of lines) {
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.t === 'cal') lastEdited.set(o.id, Number(o.calendar && o.calendar.lastEditedAt) || 0);
        else if (o.t === 'dir' && !o.row.is_readonly && !o.row.ended_at) {
            const id = o.row.target_id || o.row.actual_slug;
            if (Number.isFinite(o.row.created_at)) rowAt.set(id, Math.max(rowAt.get(id) || 0, o.row.created_at));
        }
    }
    // Born in the window means saved in it (the created save sets lastEditedAt). Directory rows are no filter: the
    // Oct 4 2026 backfill and later re-registrations stamped created_at on thousands of old calendars. Calendars made
    // after the archive ran (today's) are not in it yet, so the newest day is short.
    const ids = [...lastEdited].filter(([id, t]) => t >= from && !NOT_CAL.test(id)).map(([id]) => id);

    process.stderr.write('reading per-calendar visits and follows (Analytics Engine cal_hit)...\n');
    const span = Math.ceil((now - from) / DAY) + 1;
    const ae = JSON.parse(aeQuery(`SELECT blob9 AS cal, toDate(timestamp) AS day,
  SUM(_sample_interval * double1) AS views, SUM(_sample_interval * double2) AS visitors, SUM(_sample_interval * double3) AS followers
FROM pastecal_events WHERE blob1 = 'cal_hit' AND timestamp > NOW() - INTERVAL '${span}' DAY GROUP BY cal, day`));
    if (!Array.isArray(ae.data)) throw new Error('Analytics Engine query failed');
    const hitsBy = new Map();
    for (const r of ae.data) {
        if (!hitsBy.has(r.cal)) hitsBy.set(r.cal, []);
        hitsBy.get(r.cal).push({ day: String(r.day).slice(0, 10), views: Number(r.views) || 0, visitors: Number(r.visitors) || 0, followers: Number(r.followers) || 0 });
    }

    process.stderr.write('reading the last Firebase backup (to tell new calendars from old)...\n');
    const fb = newestFirebase();

    process.stderr.write(`reading Recent changes and authors for ${ids.length} candidate calendars...\n`);
    const auth = { Authorization: `Bearer ${secret}` };
    let done = 0, unread = 0;
    const found = (await mapLimit(ids, 6, async (id) => {
        if (++done % 50 === 0) process.stderr.write(`  ${done} of ${ids.length}\r`);
        try {
            const history = await getJson(`${base}/cal/${encodeURIComponent(id)}/history`);
            const b = birthOf(Array.isArray(history) ? history : [], rowAt.has(id) ? rowAt.get(id) : null, fb.evidence.get(CalendarName.key(id)));
            if (!b || b.birth < from) return null;
            const authors = await getJson(`${base}/cal/${encodeURIComponent(id)}/authors`, auth);
            return { id, ...b, history, authors: Array.isArray(authors) ? authors : [] };
        } catch { unread++; return null; }   // a room that never answers is reported, not fatal
    })).filter(Boolean);
    if (unread) process.stderr.write(`\n${unread} calendar(s) did not answer (4 tries, 20 s each) and are left out`);
    process.stderr.write('\n');

    const bulk = bulkBirths(found.map((c) => c.birth));
    const rows = found.filter((c, i) => !bulk.has(i))
        .map((c) => ({ ...firstTwoWeeks({ ...c, hits: hitsBy.get(calHash(c.id)) || [], today }), hash: calHash(c.id) }));
    if (asJson) { console.log(JSON.stringify({ today, days, archive: key, bulkLeftOut: bulk.size, funnel: funnel(rows), calendars: rows }, null, 2)); return; }
    console.log(render(rows, { today, days, bulk: bulk.size }));
    console.log('');
    console.log(`  Sources: ${key} (candidates), ${fb.key.replace(/_pastecal.*$/, '')} (Firebase: older calendars),`);
    console.log(`  /cal/<id>/history + /authors (${found.length} new of ${ids.length} edited in the window${unread ? `; ${unread} did not answer` : ''}),`);
    console.log('  Analytics Engine cal_hit. Gaps: visits/follows exist from 2026-10-26 only; uids only for saves made straight to');
    console.log('  Cloudflare; GA4 (EU visitors excluded) is not used here.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch((e) => { console.error(`firsttwo: ${e.message}`); process.exit(1); });
}
