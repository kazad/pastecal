import { DurableObject } from 'cloudflare:workers';
import { SlugService } from './SlugService.js';

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
        });
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
            const rows = this.sql.exec(`SELECT actual_slug, is_readonly, target_id FROM directory WHERE normalized = ?`, norm).toArray();
            if (!rows.length) return Response.json({ found: false });
            const r = rows[0];
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
            const sourceCalendarId = String(body.sourceCalendarId).trim();
            if (!/^[A-Za-z0-9_-]{1,100}$/.test(sourceCalendarId)) {
                return Response.json({ ok: false, error: 'invalid-argument', message: 'Invalid calendar id' }, { status: 400 });
            }
            let publicViewId = null;
            if (body.customSlug) {
                const customSlug = String(body.customSlug).trim();
                if (!SlugService.validateSlug(customSlug)) {
                    return Response.json({ ok: false, error: 'invalid-argument', message: 'Invalid slug format. Use 3-50 alphanumeric characters, hyphens, or underscores.' }, { status: 400 });
                }
                const norm = SlugService.normalizeSlug(customSlug);
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
            const actualSlug = String(body.actualSlug).trim();
            const norm = SlugService.normalizeSlug(actualSlug);
            const isReadOnly = body.isReadOnly ? 1 : 0;
            const targetId = body.targetId ? String(body.targetId).trim() : actualSlug;
            const now = Date.now();

            // Check if existing mapping exists
            const existing = this.sql.exec(`SELECT actual_slug, is_readonly FROM directory WHERE normalized = ?`, norm).toArray();
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
            const existing = this.sql.exec(`SELECT actual_slug FROM directory WHERE normalized = ?`, norm).toArray();
            if (existing.length) {
                return Response.json({ ok: false, error: 'already-exists', message: 'Slug is already taken' }, { status: 409 });
            }
            const isReadOnly = body.isReadOnly ? 1 : 0;
            const targetId = String(body.targetId).trim();
            const now = Date.now();

            this.sql.exec(`INSERT INTO directory (normalized, actual_slug, is_readonly, target_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                norm, slug, isReadOnly, targetId, now);
            return Response.json({ ok: true, slug, actualSlug: slug, isReadOnly: !!isReadOnly, targetId });
        }

        if (request.method === 'POST' && path === '/remove') {
            const body = await request.json().catch(() => null);
            if (!body || !body.slug) return Response.json({ ok: false }, { status: 400 });
            const norm = SlugService.normalizeSlug(body.slug);
            const actualSlug = body.actualSlug ? String(body.actualSlug).trim() : null;
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
            const now = Date.now();
            for (const item of items) {
                if (!item || !item.actualSlug) continue;
                const actualSlug = String(item.actualSlug).trim();
                const norm = SlugService.normalizeSlug(actualSlug);
                const isReadOnly = item.isReadOnly ? 1 : 0;
                const targetId = item.targetId ? String(item.targetId).trim() : actualSlug;
                this.sql.exec(`INSERT OR REPLACE INTO directory (normalized, actual_slug, is_readonly, target_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                    norm, actualSlug, isReadOnly, targetId, now);
                inserted++;
            }
            return Response.json({ ok: true, count: inserted });
        }

        if (request.method === 'GET' && path === '/stats') {
            const total = this.sql.exec(`SELECT count(*) as c FROM directory`).toArray()[0]?.c || 0;
            const readOnly = this.sql.exec(`SELECT count(*) as c FROM directory WHERE is_readonly = 1`).toArray()[0]?.c || 0;
            return Response.json({ total, readOnly, editable: total - readOnly });
        }

        return new Response('not found', { status: 404 });
    }
}
