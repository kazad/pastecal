import { DurableObject } from 'cloudflare:workers';
import { SlugService } from './SlugService.js';

// Same as index.js: any name a calendar can have ("TEAM NUÑEZ", "d&d8", "sign-up!x"), not only [A-Za-z0-9_-].
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);

// Editable always wins. One row per lowercase name, and an edit name is somebody's calendar: no write may turn it
// into a view row. A view link named after a calendar (July 2025's custom view names checked only other views) took
// the row at the Oct 4 2026 cutover, and 45 calendars' edit links then forwarded to /view/<name> (Oct 28 2026).
// The spellings that read as one name ("Foo", "foo", "foo "): a NEW calendar may not take one whose key another has.
const nameKey = (id) => String(id ?? '').trim().toLowerCase();

const EDITABLE_TAKEN = { ok: false, conflict: true, editable: true, error: 'already-exists', reason: 'calendar', message: 'That is a calendar’s name' };

export class CalendarDirectory extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        ctx.blockConcurrencyWhile(async () => {
            this.sql.exec(`CREATE TABLE IF NOT EXISTS directory (
                normalized TEXT PRIMARY KEY,
                actual_slug TEXT NOT NULL,
                is_readonly INTEGER DEFAULT 0,
                target_id TEXT,
                created_at INTEGER
            )`);
            this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_actual ON directory (actual_slug)`);
            this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_target ON directory (target_id)`);
            // ended_at: a tombstone. A Pro short name whose account was deleted keeps its row (read-only, no
            // target) until the 90-day release, so nobody can make a calendar there or point it anywhere.
            const cols = this.sql.exec(`PRAGMA table_info(directory)`).toArray().map((c) => c.name);
            if (!cols.includes('ended_at')) this.sql.exec(`ALTER TABLE directory ADD COLUMN ended_at INTEGER`);
            // Every calendar that exists, by its EXACT id (case and spaces kept: "Foo", "foo" and "foo " are three).
            // The directory above has one row per lowercase name, so a case variant or a spaced name has no row of its
            // own; the daily archive and the new-name check read this instead (Oct 28 2026: 54 calendars, 4,974 events,
            // were missing from the archive). Written by a room when it first stores a calendar, and by /rooms/add.
            // name_key: lowercase with surrounding spaces trimmed (nameKey), the spellings that read as one name.
            this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                name_key TEXT NOT NULL,
                source TEXT,
                created_at INTEGER
            )`);
            this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_rooms_key ON rooms (name_key)`);
        });
    }

    // The row at this lowercase name is an editable calendar's.
    isEditable(norm) {
        return this.sql.exec(`SELECT 1 FROM directory WHERE normalized = ? AND is_readonly = 0`, norm).toArray().length > 0;
    }

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/api/, '');

        if ((request.method === 'GET' || request.method === 'POST') && path === '/lookup') {
            let slug = url.searchParams.get('slug');
            if (!slug && request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                slug = body?.slug;
            }
            if (!slug || !SlugService.isLookupable(slug)) {
                return Response.json({ found: false });
            }
            const norm = SlugService.normalizeSlug(slug);
            const rows = this.sql.exec(`SELECT actual_slug, is_readonly, target_id, ended_at FROM directory WHERE normalized = ?`, norm).toArray();
            if (!rows.length) return Response.json({ found: false });
            const r = rows[0];
            // A tombstone leads nowhere: no targetId (callers must not fall back to the name itself).
            if (r.ended_at) return Response.json({ found: true, actualSlug: r.actual_slug, isReadOnly: true, ended: true, targetId: null });
            return Response.json({
                found: true,
                actualSlug: r.actual_slug,
                isReadOnly: !!r.is_readonly,
                targetId: r.target_id || r.actual_slug
            });
        }

        if (request.method === 'POST' && path === '/create-view') {
            const body = await request.json().catch(() => null);
            if (!body || !body.sourceCalendarId) {
                return Response.json({ ok: false, error: 'invalid-argument', message: 'sourceCalendarId is required' }, { status: 400 });
            }
            const sourceCalendarId = String(body.sourceCalendarId);   // not trimmed: a name may end in a space
            if (!validId(sourceCalendarId)) {
                return Response.json({ ok: false, error: 'invalid-argument', message: 'Invalid calendar id' }, { status: 400 });
            }
            let publicViewId = null;
            if (body.customSlug) {
                const customSlug = String(body.customSlug).trim();
                if (!SlugService.validateSlug(customSlug)) {
                    return Response.json({ ok: false, error: 'invalid-argument', message: 'Invalid slug format. Use 3-50 alphanumeric characters, hyphens, or underscores.' }, { status: 400 });
                }
                const norm = SlugService.normalizeSlug(customSlug);
                if (norm === SlugService.normalizeSlug(sourceCalendarId)) return Response.json(EDITABLE_TAKEN, { status: 409 });   // its own edit name
                const existing = this.sql.exec(`SELECT actual_slug FROM directory WHERE normalized = ?`, norm).toArray();
                if (existing.length) {
                    return Response.json({ ok: false, error: 'already-exists', message: 'Slug is already taken' }, { status: 409 });
                }
                publicViewId = norm;
            } else {
                for (let i = 0; i < 5; i++) {
                    const candidate = SlugService.generatePublicViewId(10);
                    const norm = SlugService.normalizeSlug(candidate);
                    const existing = this.sql.exec(`SELECT actual_slug FROM directory WHERE normalized = ?`, norm).toArray();
                    if (!existing.length) {
                        publicViewId = norm;
                        break;
                    }
                }
                if (!publicViewId) {
                    return Response.json({ ok: false, error: 'internal', message: 'Failed to generate unique view id' }, { status: 500 });
                }
            }
            const now = Date.now();
            this.sql.exec(`INSERT INTO directory (normalized, actual_slug, is_readonly, target_id, created_at) VALUES (?, ?, 1, ?, ?)`,
                publicViewId, publicViewId, sourceCalendarId, now);
            return Response.json({ ok: true, publicViewId, targetId: sourceCalendarId });
        }

        if (request.method === 'POST' && path === '/register') {
            const body = await request.json().catch(() => null);
            if (!body || !body.actualSlug) return Response.json({ ok: false, error: 'bad body' }, { status: 400 });
            // Names are exact: never trimmed (a calendar may be called "royal city ", stress A19).
            const actualSlug = String(body.actualSlug);
            const norm = SlugService.normalizeSlug(actualSlug);
            const isReadOnly = body.isReadOnly ? 1 : 0;
            const targetId = body.targetId ? String(body.targetId) : actualSlug;
            const now = Date.now();

            // Check if existing mapping exists
            const existing = this.sql.exec(`SELECT actual_slug, is_readonly, ended_at FROM directory WHERE normalized = ?`, norm).toArray();
            if (existing.length && existing[0].ended_at) return Response.json({ ok: false, conflict: true, ended: true });
            if (isReadOnly && existing.length && !existing[0].is_readonly) return Response.json(EDITABLE_TAKEN);   // even forced
            if (existing.length && existing[0].actual_slug !== actualSlug) {
                // If the incumbent is read-only and incoming is editable (or vice versa), don't silently overwrite unless specified
                if (!body.force && body.hasData === false) {
                    return Response.json({ ok: false, conflict: true, incumbent: existing[0].actual_slug });
                }
            }

            this.sql.exec(`INSERT OR REPLACE INTO directory (normalized, actual_slug, is_readonly, target_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                norm, actualSlug, isReadOnly, targetId, now);
            return Response.json({ ok: true, actualSlug, normalized: norm });
        }

        if (request.method === 'POST' && path === '/claim') {
            const body = await request.json().catch(() => null);
            if (!body || !body.slug || !body.targetId) {
                return Response.json({ ok: false, error: 'bad body' }, { status: 400 });
            }
            const slug = String(body.slug).trim();
            if (!SlugService.validateSlug(slug)) {
                return Response.json({ ok: false, error: 'invalid-argument', message: 'Invalid slug or reserved word' }, { status: 400 });
            }
            const norm = SlugService.normalizeSlug(slug);
            const isReadOnly = body.isReadOnly ? 1 : 0;
            const targetId = String(body.targetId);   // a calendar's name: exact
            if (isReadOnly && norm === SlugService.normalizeSlug(targetId)) return Response.json(EDITABLE_TAKEN, { status: 409 });
            const existing = this.sql.exec(`SELECT actual_slug FROM directory WHERE normalized = ?`, norm).toArray();
            if (existing.length) {
                return Response.json({ ok: false, error: 'already-exists', message: 'Slug is already taken' }, { status: 409 });
            }
            const now = Date.now();

            this.sql.exec(`INSERT INTO directory (normalized, actual_slug, is_readonly, target_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                norm, slug, isReadOnly, targetId, now);
            return Response.json({ ok: true, slug, actualSlug: slug, isReadOnly: !!isReadOnly, targetId });
        }

        // A read-only name now opens another calendar (a Pro Unlimited short name remapped by its owner).
        if (request.method === 'POST' && path === '/retarget') {
            const body = await request.json().catch(() => null);
            if (!body || !body.slug || !body.targetId) return Response.json({ ok: false }, { status: 400 });
            const norm = SlugService.normalizeSlug(body.slug);
            this.sql.exec(`UPDATE directory SET target_id = ? WHERE normalized = ? AND is_readonly = 1 AND ended_at IS NULL`, String(body.targetId), norm);
            return Response.json({ ok: true });
        }

        // A short name whose account was deleted: keep the row as a tombstone (read-only, no target) until
        // its release removes it (/remove). Lookups answer {found, ended}; nothing can be made there.
        if (request.method === 'POST' && path === '/end') {
            const body = await request.json().catch(() => null);
            if (!body || !body.slug) return Response.json({ ok: false }, { status: 400 });
            const norm = SlugService.normalizeSlug(body.slug);
            this.sql.exec(`UPDATE directory SET ended_at = ?, target_id = NULL WHERE normalized = ? AND is_readonly = 1`, Date.now(), norm);
            return Response.json({ ok: true });
        }

        if (request.method === 'POST' && path === '/remove') {
            const body = await request.json().catch(() => null);
            if (!body || !body.slug) return Response.json({ ok: false }, { status: 400 });
            const norm = SlugService.normalizeSlug(body.slug);
            const actualSlug = body.actualSlug ? String(body.actualSlug) : null;
            if (actualSlug) {
                this.sql.exec(`DELETE FROM directory WHERE normalized = ? AND actual_slug = ?`, norm, actualSlug);
            } else {
                this.sql.exec(`DELETE FROM directory WHERE normalized = ?`, norm);
            }
            return Response.json({ ok: true });
        }

        if (request.method === 'POST' && path === '/backfill') {
            const items = await request.json().catch(() => []);
            if (!Array.isArray(items)) return Response.json({ ok: false }, { status: 400 });
            let inserted = 0;
            const skipped = [];   // view rows refused because the name is an editable calendar's
            const now = Date.now();
            for (const item of items) {
                if (!item || !item.actualSlug) continue;
                const actualSlug = String(item.actualSlug);
                const norm = SlugService.normalizeSlug(actualSlug);
                const isReadOnly = item.isReadOnly ? 1 : 0;
                const targetId = item.targetId ? String(item.targetId) : actualSlug;
                if (this.sql.exec(`SELECT 1 FROM directory WHERE normalized = ? AND ended_at IS NOT NULL`, norm).toArray().length) continue;   // a tombstone stays
                if (isReadOnly && this.isEditable(norm)) { skipped.push(actualSlug); continue; }                                        // editable wins
                this.sql.exec(`INSERT OR REPLACE INTO directory (normalized, actual_slug, is_readonly, target_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                    norm, actualSlug, isReadOnly, targetId, now);
                inserted++;
            }
            return Response.json({ ok: true, count: inserted, skipped });
        }

        // View rows named after the calendar they open (a view link whose name is its calendar's edit name): the cheap
        // half of the collision check, SQL only. The Worker's /api/admin/directory/collisions confirms each calendar exists.
        if (request.method === 'GET' && path === '/self-named-views') {
            const rows = this.sql.exec(`SELECT normalized, actual_slug, is_readonly, target_id, created_at FROM directory
                WHERE is_readonly = 1 AND ended_at IS NULL AND lower(target_id) = normalized ORDER BY normalized LIMIT 1000`).toArray();
            return Response.json({ rows });
        }

        // The repair for a collision (scripts/fix-name-collisions.mjs, through the Worker's admin route, which first checks
        // that the calendar exists): this name's row becomes the editable calendar's. Only a live view row changes; the
        // row before and after are returned (the script keeps them for undo).
        if (request.method === 'POST' && path === '/make-editable') {
            const body = await request.json().catch(() => null);
            if (!body || !body.slug || !validId(String(body.calendarId || ''))) return Response.json({ ok: false, error: 'bad body' }, { status: 400 });
            const norm = SlugService.normalizeSlug(body.slug);
            const calendarId = String(body.calendarId);
            if (SlugService.normalizeSlug(calendarId) !== norm) return Response.json({ ok: false, error: 'not this name' }, { status: 400 });
            const row = () => this.sql.exec(`SELECT normalized, actual_slug, is_readonly, target_id, created_at, ended_at FROM directory WHERE normalized = ?`, norm).toArray()[0] || null;
            const before = row();
            if (!before || !before.is_readonly || before.ended_at) return Response.json({ ok: false, error: 'not a view row', before }, { status: 409 });
            this.sql.exec(`UPDATE directory SET actual_slug = ?, is_readonly = 0, target_id = ? WHERE normalized = ? AND is_readonly = 1 AND ended_at IS NULL`,
                calendarId, calendarId, norm);
            return Response.json({ ok: true, before, after: row() });
        }

        // Test hook (ACCOUNTS_DEV_MODE only; the Worker also requires the admin secret): write a row as the pre-fix
        // directory could, so the collision check and its repair can be tested. Every real path refuses this now.
        if (request.method === 'POST' && path === '/dev-plant') {
            if (this.env.ACCOUNTS_DEV_MODE !== '1') return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
            const b = await request.json().catch(() => null);
            if (!b || !b.actualSlug) return Response.json({ ok: false }, { status: 400 });
            this.sql.exec(`INSERT OR REPLACE INTO directory (normalized, actual_slug, is_readonly, target_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                SlugService.normalizeSlug(b.actualSlug), String(b.actualSlug), b.isReadOnly ? 1 : 0, String(b.targetId || b.actualSlug), Date.now());
            return Response.json({ ok: true });
        }

        // Every row, a page at a time in key order (keyset: ?after=<last normalized>), for the daily
        // full archive (BackupArchive.js). Rows hold no secrets: names, where they lead, and when.
        if (request.method === 'GET' && path === '/list') {
            const after = url.searchParams.get('after') || '';
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 1000);
            const rows = this.sql.exec(`SELECT normalized, actual_slug, is_readonly, target_id, created_at, ended_at FROM directory
                WHERE normalized > ? ORDER BY normalized LIMIT ?`, after, limit).toArray();
            return Response.json({ rows, next: rows.length === limit ? rows[rows.length - 1].normalized : null });
        }

        if (request.method === 'GET' && path === '/stats') {
            const total = this.sql.exec(`SELECT count(*) as c FROM directory`).toArray()[0]?.c || 0;
            const readOnly = this.sql.exec(`SELECT count(*) as c FROM directory WHERE is_readonly = 1`).toArray()[0]?.c || 0;
            const rooms = this.sql.exec(`SELECT count(*) as c FROM rooms`).toArray()[0]?.c || 0;
            return Response.json({ total, readOnly, editable: total - readOnly, rooms });
        }

        // ---- the registry of exact calendar ids (rooms) ----
        // Add ids (idempotent): {ids: [...], source}. -> {added, known}
        if (request.method === 'POST' && path === '/rooms/add') {
            const body = await request.json().catch(() => null);
            const ids = body && Array.isArray(body.ids) ? body.ids.filter(validId) : null;
            if (!ids) return Response.json({ ok: false, error: 'bad body' }, { status: 400 });
            const source = typeof body.source === 'string' ? body.source.slice(0, 20) : null;
            let added = 0;
            const now = Date.now();
            for (const id of ids) {
                const before = this.sql.exec(`SELECT 1 FROM rooms WHERE id = ?`, id).toArray().length;
                if (before) continue;
                this.sql.exec(`INSERT INTO rooms (id, name_key, source, created_at) VALUES (?, ?, ?, ?)`, id, nameKey(id), source, now);
                added++;
            }
            return Response.json({ ok: true, added, known: ids.length - added });
        }
        if (request.method === 'POST' && path === '/rooms/remove') {
            const body = await request.json().catch(() => null);
            if (!body || !validId(body.id)) return Response.json({ ok: false }, { status: 400 });
            this.sql.exec(`DELETE FROM rooms WHERE id = ?`, body.id);
            return Response.json({ ok: true });
        }
        // Which of these ids are registered: {ids} -> {known: [...]}
        if (request.method === 'POST' && path === '/rooms/known') {
            const body = await request.json().catch(() => null);
            const ids = body && Array.isArray(body.ids) ? body.ids.filter(validId) : [];
            const known = ids.filter((id) => this.sql.exec(`SELECT 1 FROM rooms WHERE id = ?`, id).toArray().length);
            return Response.json({ known });
        }
        // The registered calendars with this name in another spelling (case, surrounding spaces): ?slug=<exact>
        if (request.method === 'GET' && path === '/rooms/variants') {
            const slug = url.searchParams.get('slug') || '';
            const rows = this.sql.exec(`SELECT id FROM rooms WHERE name_key = ? AND id != ? LIMIT 20`, nameKey(slug), slug).toArray();
            return Response.json({ ids: rows.map((r) => r.id) });
        }
        // Every registered id, a page at a time in key order (keyset: ?after=<last id>), for the daily archive.
        if (request.method === 'GET' && path === '/rooms/list') {
            const after = url.searchParams.get('after') || '';
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 1000);
            const rows = this.sql.exec(`SELECT id FROM rooms WHERE id > ? ORDER BY id LIMIT ?`, after, limit).toArray();
            const ids = rows.map((r) => r.id);
            return Response.json({ ids, next: ids.length === limit ? ids[ids.length - 1] : null });
        }

        return new Response('not found', { status: 404 });
    }
}
