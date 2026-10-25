/**
 * Waitlist -- the Pro waitlist and the ideas people send with it, in one Durable Object's SQLite.
 * One row per email: signing up again updates the plan and use, and adds any new idea.
 * Written by POST /api/waitlist; read by GET /api/waitlist/export (Bearer IMPORT_SECRET).
 *
 * Also the contact form's messages (POST /api/contact; read by GET /api/admin/messages, Bearer
 * IMPORT_SECRET), with its per-IP limit: 5 messages an hour. The IP is never stored: only
 * sha256(daily salt + IP), in contact_hits, kept one hour. The salt is random per UTC day and
 * earlier days' salts are deleted, so yesterday's hashes can't be matched to anyone.
 */
import { DurableObject } from 'cloudflare:workers';

export const PLANS = ['pro', 'unlimited', 'teams', 'unsure'];
export const CONTACT_TYPES = ['question', 'broken', 'idea', 'billing', 'report'];
export const CONTACT_LIMIT = 5;                 // messages per IP per hour
const HOUR = 3600 * 1000;

export class Waitlist extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS signups (
            email TEXT PRIMARY KEY, plan TEXT, use TEXT, ideas TEXT,
            country TEXT, page TEXT, created_at INTEGER, updated_at INTEGER)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, calendar TEXT, message TEXT, email TEXT,
            country TEXT, created_at INTEGER)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS contact_hits (ip_hash TEXT, at INTEGER)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS contact_salt (day TEXT PRIMARY KEY, salt TEXT)`);
    }

    // sha256(today's salt + ip), hex. Makes today's salt on first use and drops older ones.
    async ipHash(ip) {
        const day = new Date().toISOString().slice(0, 10);
        let row = this.sql.exec(`SELECT salt FROM contact_salt WHERE day = ?`, day).toArray()[0];
        if (!row) {
            const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
            this.sql.exec(`DELETE FROM contact_salt WHERE day <> ?`, day);
            this.sql.exec(`INSERT OR IGNORE INTO contact_salt (day, salt) VALUES (?, ?)`, day, salt);
            row = this.sql.exec(`SELECT salt FROM contact_salt WHERE day = ?`, day).toArray()[0];
        }
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.salt + '|' + ip));
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
        if (request.method === 'POST' && url.pathname === '/message') {
            const m = await request.json();
            const hash = await this.ipHash(m.ip || 'unknown');
            const now = Date.now();
            // Check and insert with no await in between: the object runs one request at a time.
            this.sql.exec(`DELETE FROM contact_hits WHERE at < ?`, now - HOUR);
            const used = this.sql.exec(`SELECT COUNT(*) AS n FROM contact_hits WHERE ip_hash = ?`, hash).one().n;
            if (used >= CONTACT_LIMIT) return Response.json({ ok: false, limited: true }, { status: 429 });
            this.sql.exec(`INSERT INTO contact_hits (ip_hash, at) VALUES (?, ?)`, hash, now);
            this.sql.exec(`INSERT INTO messages (type, calendar, message, email, country, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                m.type, m.calendar, m.message, m.email, m.country, now);
            return Response.json({ ok: true });
        }
        if (request.method === 'GET' && url.pathname === '/messages') {
            const rows = this.sql.exec(`SELECT * FROM messages ORDER BY created_at DESC LIMIT 500`).toArray()
                .map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
            return Response.json({ messages: rows });
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
