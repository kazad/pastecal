/**
 * Name collisions: a read-only directory row (a view link) whose name is an editable calendar's.
 *
 * The directory keeps one row per name key (CalendarName.key). July 2025's custom view names were checked only against other
 * view links, so a person could name a calendar's view link after the calendar itself; at the Oct 4 2026 cutover
 * the view took the row, and that calendar's edit link then forwarded to /view/<name> (45 calendars, Oct 28 2026).
 * The directory now refuses every such write (CalendarDirectory.js EDITABLE_TAKEN); this finds and repairs the old ones.
 *
 * Admin (Bearer IMPORT_SECRET, index.js):
 *   GET  /api/admin/directory/collisions?scope=self       view rows named after their own calendar, that calendar
 *                                                          confirmed (cheap: SQL, then one HEAD per row; scripts/health.py)
 *   GET  /api/admin/directory/collisions?after=&limit=    every view row, a page at a time (limit <= 1000, default 300),
 *                                                          its name checked against the calendars (one HEAD each, 25 at a
 *                                                          time): {collisions, scanned, next}
 *   POST /api/admin/directory/make-editable {name, calendarId}   the repair: the row becomes calendarId's edit row
 *                                                          (calendarId must exist and be this name in any case)
 *   POST /api/admin/directory/dev-plant {actualSlug, isReadOnly, targetId}   tests only (ACCOUNTS_DEV_MODE)
 *   POST /api/admin/directory/dev/{register,claim,remove}   tests only (ACCOUNTS_DEV_MODE): the directory's own routes
 * A collision: {name, normalized, kind, calendarId, row}. kind 'self': the view opens the calendar of that name
 * (repairing it keeps its view link working: index.js serves /view/<name> from a calendar whose own view id it is);
 * 'cross': the view opens ANOTHER calendar, whose view link a repair would end.
 */
import CalendarName from '../../public/services/CalendarName.js';

const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);

export async function calendarExists(env, id) {
    if (!validId(id)) return false;
    const r = await env.CALENDARS.get(env.CALENDARS.idFromName(id)).fetch(`http://internal/cal/${encodeURIComponent(id)}`, { method: 'HEAD' });
    return r.status === 200;
}

function collisionOf(row) {
    const self = CalendarName.same(row.target_id, row.normalized);
    return {
        name: row.actual_slug,
        normalized: row.normalized,
        kind: self ? 'self' : 'cross',
        calendarId: self ? row.target_id : row.actual_slug,   // the editable calendar this name should open
        row: { actual_slug: row.actual_slug, is_readonly: row.is_readonly, target_id: row.target_id, created_at: row.created_at },
    };
}

// The rows whose calendar exists, CONCURRENCY at a time (every check is a Durable Object request).
const CONCURRENCY = 25;
async function confirmed(env, rows) {
    const out = [];
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const batch = rows.slice(i, i + CONCURRENCY).map(collisionOf);
        const ok = await Promise.all(batch.map((c) => calendarExists(env, c.calendarId).catch(() => false)));
        batch.forEach((c, j) => { if (ok[j]) out.push(c); });
    }
    return out;
}

export async function handleCollisionAdmin(request, env, dir, path, url) {
    if (path === '/api/admin/directory/collisions' && request.method === 'GET') {
        if (url.searchParams.get('scope') === 'self') {
            const { rows } = await (await dir.fetch('http://internal/self-named-views')).json();
            return Response.json({ collisions: await confirmed(env, rows), scanned: rows.length, next: null });
        }
        const after = url.searchParams.get('after') || '';
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 300, 1), 1000);
        const page = await (await dir.fetch(`http://internal/list?after=${encodeURIComponent(after)}&limit=${limit}`)).json();
        const views = page.rows.filter((r) => r.is_readonly && !r.ended_at && r.target_id);
        return Response.json({ collisions: await confirmed(env, views), scanned: page.rows.length, next: page.next });
    }
    if (path === '/api/admin/directory/make-editable' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const calendarId = body && typeof body.calendarId === 'string' ? body.calendarId : '';
        if (!body || !body.name || !validId(calendarId)) return Response.json({ ok: false, error: 'name and calendarId are required' }, { status: 400 });
        if (!(await calendarExists(env, calendarId))) return Response.json({ ok: false, error: 'no such calendar' }, { status: 404 });
        return dir.fetch('http://internal/make-editable', { method: 'POST', body: JSON.stringify({ slug: String(body.name), calendarId }) });
    }
    // Tests only (ACCOUNTS_DEV_MODE): the directory's own write routes, called as the rooms and Names.js call them, so
    // each guard is tested by itself (the callers refuse most of these before they reach it).
    const dev = path.match(/^\/api\/admin\/directory\/dev\/(register|claim|remove)$/);
    if (dev && request.method === 'POST') {
        if (env.ACCOUNTS_DEV_MODE !== '1') return new Response('not found', { status: 404 });
        return dir.fetch(`http://internal/${dev[1]}`, { method: 'POST', body: await request.text() });
    }
    if (path === '/api/admin/directory/dev-plant' && request.method === 'POST') {
        return dir.fetch('http://internal/dev-plant', { method: 'POST', body: await request.text() });
    }
    return new Response('not found', { status: 404 });
}
