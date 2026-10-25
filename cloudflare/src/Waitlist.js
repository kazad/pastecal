/**
 * Waitlist -- the Pro waitlist and the ideas people send with it, in one Durable Object's SQLite.
 * One row per email: signing up again updates the plan and use, and adds any new idea.
 * Written by POST /api/waitlist; read by GET /api/waitlist/export (Bearer IMPORT_SECRET).
 */
import { DurableObject } from 'cloudflare:workers';

export const PLANS = ['pro', 'unlimited', 'teams', 'unsure'];

export class Waitlist extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS signups (
            email TEXT PRIMARY KEY, plan TEXT, use TEXT, ideas TEXT,
            country TEXT, page TEXT, created_at INTEGER, updated_at INTEGER)`);
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/add') {
            const s = await request.json();
            const now = Date.now();
            const prev = this.sql.exec(`SELECT ideas FROM signups WHERE email = ?`, s.email).toArray()[0];
            const ideas = [prev && prev.ideas, s.ideas].filter(Boolean).join('\n---\n').slice(0, 8000);
            this.sql.exec(`INSERT INTO signups (email, plan, use, ideas, country, page, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET plan = excluded.plan, use = excluded.use, ideas = ?, updated_at = ?`,
                s.email, s.plan, s.use, ideas, s.country, s.page, now, now, ideas, now);
            return Response.json({ ok: true, returning: !!prev });
        }
        if (request.method === 'GET' && url.pathname === '/export') {
            const rows = this.sql.exec(`SELECT * FROM signups ORDER BY created_at`).toArray();
            const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const cols = ['email', 'plan', 'use', 'ideas', 'country', 'page', 'created_at', 'updated_at'];
            const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(c.endsWith('_at') ? new Date(r[c]).toISOString() : r[c])).join(','))].join('\n');
            return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="pastecal-waitlist.csv"' } });
        }
        return new Response('not found', { status: 404 });
    }
}
