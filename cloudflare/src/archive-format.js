/**
 * The daily full archive's format and checks -- pure functions, no bindings, so the unit tests import them
 * (test/unit/backup-archive.test.js). The archive itself is written by BackupArchive.js.
 *
 * archive/daily/YYYY-MM-DD.json.gz: one gzip stream of JSON lines (one object per line):
 *   {"t":"archive","version":1,"date":"2026-10-28","startedAt":"..."}            first line
 *   {"t":"dir","row":{normalized, actual_slug, is_readonly, target_id, created_at, ended_at}}
 *                                                    every directory row: edit names, view links, short names, tombstones
 *   {"t":"cal","id":"<exact id>","v":12,"locked":false,"calendar":{id, title, options, lastEditedAt, events}}
 *                                                    the same calendar the per-calendar snapshot holds (CalendarRoom.backupToR2)
 *   {"t":"failed","id":"...","error":"..."}           a calendar that could not be read (two tries)
 *   {"t":"end","count":N,"dirRows":M,"absent":A,"failed":F,"finishedAt":"..."}   last line: a cut-off file has none
 * No editor keys, key hashes, owner ids, Pro settings, stats or history: the per-calendar snapshot keeps none either.
 */
export const ARCHIVE_VERSION = 1;
export const DAILY_PREFIX = 'archive/daily/';
export const PARTS_PREFIX = 'archive/parts/';       // scratch, deleted once the day's file is written
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HEALTH = { maxAgeHours: 26, minShare: 0.95 };

export const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dailyKey = (date) => `${DAILY_PREFIX}${date}.json.gz`;
export const partsPrefix = (date) => `${PARTS_PREFIX}${date}/`;

// Is the newest archive fresh and whole? newest: {key, date, uploaded, size, meta: customMetadata} or null;
// editable: the directory's count of edit names (its calendars). -> {ok, problems[], newest, editable}
export function evaluateHealth({ newest, now, editable, maxAgeHours = HEALTH.maxAgeHours, minShare = HEALTH.minShare }) {
    const problems = [];
    if (!newest) {
        problems.push('no daily full archive for today or yesterday');
        return { ok: false, problems, newest: null, editable };
    }
    const m = newest.meta || {};
    const finished = Date.parse(m.finishedAt) || new Date(newest.uploaded).getTime();
    const ageHours = (now - finished) / 3600000;
    const count = Number(m.count), failed = Number(m.failed) || 0, absent = Number(m.absent) || 0;
    if (!(ageHours <= maxAgeHours)) problems.push(`the newest full archive (${newest.date}) is ${ageHours.toFixed(1)} hours old, over ${maxAgeHours}`);
    if (!Number.isFinite(count)) problems.push(`the newest full archive (${newest.date}) has no calendar count`);
    // A directory name that leads to no calendar (a stale or once-trimmed row) was looked up and counted
    // as absent: it covers its row, so dead rows never keep the check red. Many of them is its own problem.
    else if (editable > 0 && count + absent < minShare * editable) {
        problems.push(`the newest full archive (${newest.date}) holds ${count} calendars (+${absent} absent names), under ${Math.round(minShare * 100)}% of the directory's ${editable}`);
    } else if (absent > count) {
        problems.push(`the newest full archive (${newest.date}) found more names leading nowhere (${absent}) than calendars (${count})`);
    }
    if (failed > 0) problems.push(`${failed} calendar(s) could not be read into the ${newest.date} archive`);
    return {
        ok: !problems.length, problems, editable,
        newest: { key: newest.key, date: newest.date, ageHours: Math.round(ageHours * 10) / 10, count, failed,
            absent, dirRows: Number(m.dirRows) || 0, gzBytes: newest.size || 0 },
    };
}

const keyOf = (e) => `${e && e.id}|${(e && e.recurrenceID) || ''}`;
const titles = (list) => list.slice(0, 10).map((e) => String((e && e.title) || '(untitled)').slice(0, 60));
const eventsOf = (cal) => (cal && Array.isArray(cal.events) ? cal.events : Object.values((cal && cal.events) || {})).filter(Boolean);

// What restoring `archived` over `live` changes. A restore replaces events, title and notes; other options stay.
export function diffCalendars(archived, live) {
    const a = eventsOf(archived), l = eventsOf(live);
    const lByKey = new Map(l.map((e) => [keyOf(e), e])), aKeys = new Set(a.map(keyOf));
    const added = a.filter((e) => !lByKey.has(keyOf(e)));                    // back again after the restore
    const removed = l.filter((e) => !aKeys.has(keyOf(e)));                    // gone after the restore
    const changed = a.filter((e) => lByKey.has(keyOf(e)) && JSON.stringify(e) !== JSON.stringify(lByKey.get(keyOf(e))));
    const notes = (c) => (c && c.options && c.options.notes) || '';
    return {
        archivedEvents: a.length, liveEvents: live ? l.length : null,
        added: added.length, removed: removed.length, changed: changed.length,
        addedTitles: titles(added), removedTitles: titles(removed), changedTitles: titles(changed),
        titleChanged: !!live && (archived.title || '') !== (live.title || ''),
        notesChanged: !!live && notes(archived) !== notes(live),
        same: !!live && !added.length && !removed.length && !changed.length && (archived.title || '') === (live.title || '') && notes(archived) === notes(live),
    };
}

// The one calendar `id` in an archive's body (a ReadableStream of the .json.gz), or null.
export async function findInArchive(body, id) {
    const reader = body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
    const needle = `"id":${JSON.stringify(id)}`;
    let buf = '', found = null;
    const scan = (line) => {
        if (!line.startsWith('{"t":"cal"') || !line.includes(needle)) return;
        const o = JSON.parse(line);
        if (o.id === id) found = o;
    };
    for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { scan(buf.slice(0, i)); buf = buf.slice(i + 1); }
        if (done) break;
    }
    if (buf) scan(buf);
    return found;
}
