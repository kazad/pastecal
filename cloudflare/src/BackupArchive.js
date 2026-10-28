/**
 * BackupArchive -- once a day, every calendar (free and Pro) into one file kept forever:
 * R2 archive/daily/YYYY-MM-DD.json.gz (format: archive-format.js), with customMetadata
 * {version, date, count, dirRows, absent, failed, bytes, gzBytes, parts, startedAt, finishedAt}.
 *
 * Why chunked. The per-calendar snapshots (CalendarRoom.backupToR2) only cover calendars changed since
 * Oct 22 2026. The full-database cron before them (94ad206's BackupService) read every calendar in ONE
 * invocation and never completed a nightly run, and its hourlies stopped silently at a deploy. So:
 *   - The job is a singleton Durable Object driven by its own alarm. Each alarm does one small step (one
 *     directory page, one page of the snapshot list, or ARCHIVE_CHUNK calendars with 8 reads at a time)
 *     and writes it as a part under archive/parts/<date>/<run>/, then re-arms. Every step is a fresh
 *     invocation with its own CPU and subrequest budget, so the job finishes at any size.
 *   - The last step joins the parts into the day's file (one gzip stream) and deletes the parts.
 *   - A failure is noticed: GET /api/admin/backup/health (scripts/health.py) is red when the newest file is
 *     missing, older than 26 hours, or short of 95% of the directory's calendars. Logs: [backup:archive].
 * A thrown step is retried by the alarm (Cloudflare retries failed alarms with backoff).
 *
 * Which calendars. Every edit name in the directory (CalendarDirectory /list, keyset pages), plus every id
 * with a per-calendar snapshot (a calendar whose directory row is missing or was trimmed before Oct 26),
 * deduplicated by exact id. A name that leads to no calendar (404) is counted as `absent`, not written.
 * The directory rows themselves are archived too (view links, short names, tombstones): that is what
 * restores /view/ and short-name links. Accounts (owners, emails, @handles) are NOT archived here.
 *
 * Idempotent: start(date) begins a new run (a new run id) and its file overwrites that date's. Daily files
 * are never pruned. firebase/ (the lead's copies of the Firebase backups) is never read, written or pruned.
 *
 * Worker side (bottom of this file): the cron handler and the admin routes (Bearer IMPORT_SECRET):
 *   POST /api/admin/backup/run[?date=YYYY-MM-DD]   start a run now (the cron runs one daily at 09:00 UTC)
 *   GET  /api/admin/backup/status                  the current or last run
 *   GET  /api/admin/backup/list                    every daily file, with its metadata
 *   GET  /api/admin/backup/health                  {ok, problems[], newest, editable}; 503 when not ok
 *   POST /api/admin/backup/restore {calendarId, date, apply?, force?}
 *        dry run (default): {dryRun, archived, live, diff}. apply: through the room's normal restore (a
 *        restore point first, one "Restored the full backup from <date>" history entry, undoable); a calendar
 *        that no longer exists is recreated through /import. A locked (Pro) calendar needs force.
 *        Script: scripts/restore-from-archive.mjs.
 */
import { DurableObject } from 'cloudflare:workers';
import { ARCHIVE_VERSION, DATE_RE, dailyKey, partsPrefix, DAILY_PREFIX, utcDate, evaluateHealth, diffCalendars, findInArchive } from './archive-format.js';
import { timingSafeEqual } from './Stripe.js';

const json = (x) => JSON.stringify(x);
const DEFAULT_CHUNK = 200;
const READS_AT_ONCE = 8;
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);

async function gzip(bytes) {
    return new Response(new Response(bytes).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}
async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
}
async function listAll(bucket, prefix) {
    const objs = []; let cursor;
    do {
        const page = await bucket.list({ prefix, cursor });
        objs.push(...page.objects);
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objs;
}

export class BackupArchive extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        ctx.blockConcurrencyWhile(async () => {
            this.sql.exec(`CREATE TABLE IF NOT EXISTS job (k INTEGER PRIMARY KEY CHECK (k = 1), data TEXT NOT NULL)`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS todo (id TEXT PRIMARY KEY)`);   // this run's calendar ids, deduplicated
        });
    }
    job() { const r = this.sql.exec(`SELECT data FROM job`).toArray()[0]; return r ? JSON.parse(r.data) : null; }
    saveJob(j) { this.sql.exec(`INSERT OR REPLACE INTO job (k, data) VALUES (1, ?)`, json(j)); }
    chunk() { const n = Number(this.env.ARCHIVE_CHUNK); return Number.isInteger(n) && n > 0 && n <= 500 ? n : DEFAULT_CHUNK; }

    // RPC: begin a run for `date` (any earlier run, finished or not, is superseded).
    async start(date) {
        if (!DATE_RE.test(date || '')) throw new Error('bad date');
        const run = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
        const j = { version: ARCHIVE_VERSION, run, date, phase: 'directory', cursor: '', part: 0, steps: 0,
            count: 0, dirRows: 0, absent: 0, failed: 0, bytes: 0, startedAt: new Date().toISOString(), done: false };
        this.sql.exec(`DELETE FROM todo`);
        this.saveJob(j);
        await this.ctx.storage.setAlarm(Date.now());
        console.log(`[backup:archive] start ${date} run ${run}`);
        return j;
    }
    async status() { return this.job(); }

    async alarm() {
        const j = this.job();
        if (!j || j.done) return;
        try {
            await this.step(j);
        } catch (e) {
            const cur = this.job();
            if (cur && cur.run === j.run) { cur.lastError = String(e && e.message); this.saveJob(cur); }
            console.error(`[backup:archive] FAILED ${j.date} run ${j.run} at ${j.phase} (step ${j.steps}): ${e && e.message}`);
            throw e;                                                    // the alarm is retried
        }
    }

    async step(j) {
        const env = this.env, chunk = this.chunk(), lines = [];
        const add = (id) => { if (validId(id)) this.sql.exec(`INSERT OR IGNORE INTO todo (id) VALUES (?)`, id); };
        if (j.phase === 'directory') {
            if (j.part === 0 && !j.cursor) lines.push({ t: 'archive', version: ARCHIVE_VERSION, date: j.date, startedAt: j.startedAt });
            const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
            const res = await dir.fetch(`http://internal/list?after=${encodeURIComponent(j.cursor)}&limit=${chunk}`);
            if (!res.ok) throw new Error(`directory list HTTP ${res.status}`);
            const { rows, next } = await res.json();
            for (const row of rows) {
                lines.push({ t: 'dir', row });
                if (!row.is_readonly && !row.ended_at) { add(row.target_id || row.actual_slug); add(row.actual_slug); }
            }
            j.dirRows += rows.length;
            if (next) j.cursor = next; else { j.phase = 'snapshots'; j.cursor = ''; }
        } else if (j.phase === 'snapshots') {
            const page = await env.BACKUPS.list({ prefix: 'snapshots/', delimiter: '/', cursor: j.cursor || undefined });
            for (const p of page.delimitedPrefixes || []) {
                try { add(decodeURIComponent(p.slice('snapshots/'.length, -1))); } catch { /* not ours */ }
            }
            if (page.truncated) j.cursor = page.cursor; else { j.phase = 'calendars'; j.cursor = ''; }
        } else if (j.phase === 'calendars') {
            const ids = this.sql.exec(`SELECT id FROM todo WHERE id > ? ORDER BY id LIMIT ?`, j.cursor, chunk).toArray().map((r) => r.id);
            const got = await mapLimit(ids, READS_AT_ONCE, (id) => this.read(id));
            ids.forEach((id, i) => {
                const g = got[i];
                if (g.calendar) { lines.push({ t: 'cal', id, v: g.v, locked: g.locked, calendar: g.calendar }); j.count++; }
                else if (g.absent) j.absent++;
                else { lines.push({ t: 'failed', id, error: g.error }); j.failed++; console.error(`[backup:archive] could not read ${id}: ${g.error}`); }
            });
            if (ids.length === chunk) j.cursor = ids[ids.length - 1]; else j.phase = 'join';
        } else if (j.phase === 'join') {
            return this.join(j);
        }
        if (lines.length) {
            const text = lines.map(json).join('\n') + '\n';
            await env.BACKUPS.put(`${partsPrefix(j.date)}${j.run}/${String(j.part).padStart(6, '0')}.jsonl`, text,
                { httpMetadata: { contentType: 'application/x-ndjson' } });
            j.part++; j.bytes += text.length;
        }
        j.steps++;
        const cur = this.job();
        if (!cur || cur.run !== j.run) return;                          // a new run started meanwhile: stop this one
        this.saveJob(j);
        await this.ctx.storage.setAlarm(Date.now());
    }

    // One calendar as its room serves it (two tries). -> {v, locked, calendar} | {absent} | {error}
    async read(id) {
        let error = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const res = await this.env.CALENDARS.get(this.env.CALENDARS.idFromName(id)).fetch(`http://internal/cal/${encodeURIComponent(id)}`);
                if (res.status === 404) return { absent: true };
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const d = await res.json();
                if (!d || !d.calendar) throw new Error('no calendar in the reply');
                return { v: d.v, locked: !!d.locked, calendar: d.calendar };
            } catch (e) { error = String(e && e.message); }
        }
        return { error };
    }

    // The parts, in order, become one gzip stream at archive/daily/<date>.json.gz; then the parts go.
    async join(j) {
        const env = this.env, key = dailyKey(j.date);
        const parts = (await listAll(env.BACKUPS, `${partsPrefix(j.date)}${j.run}/`)).sort((a, b) => (a.key < b.key ? -1 : 1));
        if (parts.length !== j.part) throw new Error(`expected ${j.part} parts, found ${parts.length}`);
        const finishedAt = new Date().toISOString();
        const end = json({ t: 'end', count: j.count, dirRows: j.dirRows, absent: j.absent, failed: j.failed, finishedAt }) + '\n';
        const cs = new CompressionStream('gzip'), w = cs.writable.getWriter();
        const out = new Response(cs.readable).arrayBuffer();
        for (const p of parts) {
            const obj = await env.BACKUPS.get(p.key);
            if (!obj) throw new Error(`part ${p.key} vanished`);
            await w.write(new Uint8Array(await obj.arrayBuffer()));
        }
        await w.write(new TextEncoder().encode(end));
        await w.close();
        const gz = await out;
        const meta = { version: String(ARCHIVE_VERSION), date: j.date, run: j.run, count: String(j.count), dirRows: String(j.dirRows),
            absent: String(j.absent), failed: String(j.failed), bytes: String(j.bytes + end.length), gzBytes: String(gz.byteLength),
            parts: String(parts.length), startedAt: j.startedAt, finishedAt };
        const cur = this.job();
        if (!cur || cur.run !== j.run) return;                          // superseded: the newer run writes the file
        await env.BACKUPS.put(key, gz, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: meta });
        // Every part of this date, this run's and any abandoned run's.
        const stale = (await listAll(env.BACKUPS, partsPrefix(j.date))).map((o) => o.key);
        for (let i = 0; i < stale.length; i += 1000) await env.BACKUPS.delete(stale.slice(i, i + 1000));
        Object.assign(j, { done: true, phase: 'done', key, finishedAt, gzBytes: gz.byteLength, steps: j.steps + 1 });
        delete j.lastError;
        if (this.job()?.run !== j.run) return;
        this.saveJob(j);
        this.sql.exec(`DELETE FROM todo`);
        console.log(`[backup:archive] ok ${key}: ${j.count} calendars, ${j.dirRows} directory rows, ${j.absent} absent, ${j.failed} failed, ` +
            `${j.bytes} bytes (${gz.byteLength} gzipped) in ${j.steps} steps`);
    }
}

// ---- Worker side ------------------------------------------------------------------------------

const archiver = (env) => env.BACKUP_ARCHIVE.get(env.BACKUP_ARCHIVE.idFromName('daily'));

// Cron (wrangler.jsonc triggers): start today's run.
export async function scheduledArchive(env, scheduledTime = Date.now()) {
    if (!env.BACKUP_ARCHIVE || !env.BACKUPS || !env.DIRECTORY || !env.CALENDARS) {
        console.error('[backup:archive] FAILED: not configured (BACKUP_ARCHIVE, BACKUPS, DIRECTORY, CALENDARS)');
        return;
    }
    try { await archiver(env).start(utcDate(scheduledTime)); }
    catch (e) { console.error(`[backup:archive] FAILED to start: ${e && e.message}`); }
}

// The newest daily file (today's, else yesterday's) against the directory's calendar count.
export async function backupHealth(env, now = Date.now()) {
    let newest = null;
    for (const date of [utcDate(now), utcDate(now - 86400000)]) {
        const o = await env.BACKUPS.head(dailyKey(date));
        if (o) { newest = { key: o.key, date, uploaded: o.uploaded, size: o.size, meta: o.customMetadata }; break; }
    }
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
    const stats = await (await dir.fetch('http://internal/stats')).json();
    return evaluateHealth({ newest, now, editable: stats.editable });
}

async function listArchives(env) {
    const out = []; let cursor;
    do {
        const page = await env.BACKUPS.list({ prefix: DAILY_PREFIX, cursor, include: ['customMetadata'] });
        for (const o of page.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded, ...o.customMetadata });
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
}

async function restoreFromArchive(env, body) {
    const id = body && body.calendarId, date = body && body.date;
    if (!validId(id) || !DATE_RE.test(date || '')) return [400, { ok: false, error: 'calendarId and date (YYYY-MM-DD) are required' }];
    const obj = await env.BACKUPS.get(dailyKey(date));
    if (!obj) return [404, { ok: false, error: 'no-archive', message: `no archive for ${date}` }];
    const found = await findInArchive(obj.body, id);
    if (!found) return [404, { ok: false, error: 'not-in-archive', message: `${id} is not in the ${date} archive` }];
    const room = env.CALENDARS.get(env.CALENDARS.idFromName(id));
    const roomUrl = (suffix = '') => `http://internal/cal/${encodeURIComponent(id)}${suffix}`;
    const res = await room.fetch(roomUrl());
    if (!res.ok && res.status !== 404) return [502, { ok: false, error: `live calendar unreadable (HTTP ${res.status})` }];
    const live = res.ok ? await res.json() : null;
    const summary = (x) => x && { v: x.v, locked: !!x.locked, title: x.calendar.title, events: (x.calendar.events || []).length };
    const report = { calendarId: id, date, archived: summary(found), live: summary(live), diff: diffCalendars(found.calendar, live && live.calendar) };
    if (!body.apply) return [200, { ok: true, dryRun: true, ...report }];
    if (!live) {
        // The calendar is gone: recreate it (and its names) through the full-calendar import.
        const r = await room.fetch(roomUrl('/import'), { method: 'PUT', body: json(found.calendar) });
        const out = await r.json().catch(() => ({ ok: false }));
        console.log(`[backup:restore] ${id} from ${date}: recreated (${r.status})`);
        return [r.status, { ...out, ...report, applied: !!out.ok, recreated: true }];
    }
    if (live.locked && !body.force) {
        return [409, { ok: false, error: 'locked', message: 'a locked (Pro) calendar: pass force to restore it from the archive', ...report }];
    }
    const r = await room.fetch(roomUrl('/restore-version'), { method: 'POST', body: json({ version: date, fromArchive: { calendar: found.calendar } }) });
    const out = await r.json().catch(() => ({ ok: false, error: 'unavailable' }));
    delete out.status;
    console.log(`[backup:restore] ${id} from ${date}: ${out.ok ? (out.unchanged ? 'unchanged' : `restored v${out.v}`) : `refused ${out.error}`}`);
    return [r.status, { ...out, ...report, applied: !!out.ok && !out.unchanged }];
}

// /api/admin/backup/* (Bearer IMPORT_SECRET). null: not one of these paths.
export async function handleBackupAdmin(request, env, url) {
    const path = url.pathname;
    if (!path.startsWith('/api/admin/backup/')) return null;
    if (!env.IMPORT_SECRET || !timingSafeEqual(request.headers.get('Authorization') || '', `Bearer ${env.IMPORT_SECRET}`)) {
        return new Response('forbidden', { status: 403 });
    }
    if (!env.BACKUP_ARCHIVE || !env.BACKUPS) return Response.json({ ok: false, error: 'not configured' }, { status: 503 });
    const m = request.method;
    try {
        if (path === '/api/admin/backup/run' && m === 'POST') {
            const date = url.searchParams.get('date') || utcDate(Date.now());
            if (!DATE_RE.test(date)) return Response.json({ ok: false, error: 'bad date' }, { status: 400 });
            return Response.json({ ok: true, job: await archiver(env).start(date) });
        }
        if (path === '/api/admin/backup/status' && m === 'GET') return Response.json({ ok: true, job: await archiver(env).status() });
        if (path === '/api/admin/backup/list' && m === 'GET') return Response.json({ ok: true, archives: await listArchives(env) });
        if (path === '/api/admin/backup/health' && m === 'GET') {
            const h = await backupHealth(env);
            return Response.json(h, { status: h.ok ? 200 : 503 });
        }
        if (path === '/api/admin/backup/restore' && m === 'POST') {
            const [status, out] = await restoreFromArchive(env, await request.json().catch(() => null));
            return Response.json(out, { status });
        }
    } catch (e) {
        console.error(`[backup:admin] ${path} failed: ${e && e.message}`);
        return Response.json({ ok: false, error: String(e && e.message) }, { status: 500 });
    }
    return new Response('not found', { status: 404 });
}
