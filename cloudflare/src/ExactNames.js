/**
 * Exact names first, as Firebase did.
 *
 * Firebase stored calendars by their exact key and its lookup read that key first, so "Foo" and "foo" were two
 * calendars, both reachable. Here each calendar's data is kept by its exact id too (a room per idFromName(id)), but the
 * directory keeps ONE row per lowercase name. The edit page followed that row, so the owner of "foo" was taken to
 * "Foo" (91 calendars, 904 events, Oct 28 2026: they saw and could edit someone else's calendar).
 *
 *   exactLookup   a lookup for an edit name: when a calendar exists at exactly the requested name, that is the answer
 *                 ({found, actualSlug: <name>, isReadOnly: false, exact}) even if the row points elsewhere. One HEAD,
 *                 only when the row's spelling differs from the request or the row is read-only. `exact` says why:
 *                 'case' (the row is another spelling's calendar) or 'view' (the row is a view link or an ended name).
 *                 Used by /api/lookup, /lookupCalendar and the edit feed /<name>.ics. Never by view links (/view/...),
 *                 and never inside the directory itself: a room's registerInDirectory reads the raw row.
 *   nameTakenByVariant   the new-name check for POST /cal/<id>: refused when another calendar has this name in another
 *                 spelling (case, surrounding spaces). Existing variants keep working; no new one is made.
 *   handleRoomsAdmin     /api/admin/rooms/* (Bearer IMPORT_SECRET, checked by index.js): the registry of exact ids.
 *     POST /api/admin/rooms/backfill {ids: [...], apply?}   dry run by default: for each id, whether it is registered
 *          and whether its calendar exists; apply registers the ones that exist. At most 300 ids a request.
 *          Script: scripts/backfill-rooms.mjs.
 *     GET  /api/admin/rooms/stats                            {rooms, editable, total}
 *     POST /api/admin/rooms/dev-forget {id}                  tests only (ACCOUNTS_DEV_MODE)
 */
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);

export async function calendarAt(env, id) {
    if (!env.CALENDARS || !validId(id)) return false;
    const r = await env.CALENDARS.get(env.CALENDARS.idFromName(id)).fetch(`http://internal/cal/${encodeURIComponent(id)}`, { method: 'HEAD' });
    return r.status === 200;
}

async function rawLookup(dir, slug) {
    return (await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(slug)}`)).json();
}

export async function exactLookup(env, dir, slug) {
    const row = await rawLookup(dir, slug);
    if (!row || !row.found || typeof slug !== 'string') return row;
    if (row.actualSlug === slug && !row.isReadOnly) return row;
    if (!(await calendarAt(env, slug).catch(() => false))) return row;
    return { found: true, actualSlug: slug, isReadOnly: false, targetId: slug, exact: row.isReadOnly ? 'view' : 'case' };
}

// Another calendar with this name in another spelling, or null. The directory row (lowercase key, and the trimmed
// name's) catches the variants made before the registry; the registry catches the rest. A name whose row or entry
// leads to no calendar any more (a stale row) does not block.
export async function nameTakenByVariant(env, dir, id) {
    const candidates = new Set();
    for (const key of new Set([id, id.trim()])) {
        if (!key) continue;
        const row = await rawLookup(dir, key).catch(() => null);
        if (row && row.found && !row.isReadOnly && row.actualSlug !== id) candidates.add(row.actualSlug);
    }
    const v = await (await dir.fetch(`http://internal/rooms/variants?slug=${encodeURIComponent(id)}`)).json().catch(() => ({ ids: [] }));
    for (const other of (v.ids || []).slice(0, 5)) candidates.add(other);
    for (const other of candidates) {
        if (other !== id && await calendarAt(env, other).catch(() => true)) return other;   // unreadable: taken (fail closed)
    }
    return null;
}

const BACKFILL_MAX = 300;   // one HEAD (a Durable Object subrequest) per new id: well under the per-request limit
const CONCURRENCY = 25;

export async function handleRoomsAdmin(request, env, dir, path) {
    if (path === '/api/admin/rooms/stats' && request.method === 'GET') {
        const s = await (await dir.fetch('http://internal/stats')).json();
        return Response.json({ rooms: s.rooms, editable: s.editable, total: s.total });
    }
    if (path === '/api/admin/rooms/backfill' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.ids)) return Response.json({ ok: false, error: 'send {ids: [...]}' }, { status: 400 });
        if (body.ids.length > BACKFILL_MAX) return Response.json({ ok: false, error: `at most ${BACKFILL_MAX} ids a request` }, { status: 400 });
        const ids = [...new Set(body.ids.filter((x) => typeof x === 'string'))];
        const invalid = ids.filter((id) => !validId(id));
        const valid = ids.filter(validId);
        const { known } = await (await dir.fetch('http://internal/rooms/known', { method: 'POST', body: JSON.stringify({ ids: valid }) })).json();
        const knownSet = new Set(known);
        const fresh = valid.filter((id) => !knownSet.has(id));
        const exists = [], missing = [], failed = [];
        for (let i = 0; i < fresh.length; i += CONCURRENCY) {
            const batch = fresh.slice(i, i + CONCURRENCY);
            const got = await Promise.all(batch.map((id) => calendarAt(env, id).then((ok) => (ok ? 'exists' : 'missing'), () => 'failed')));
            batch.forEach((id, j) => ({ exists, missing, failed })[got[j]].push(id));
        }
        let added = 0;
        if (body.apply && exists.length) {
            const r = await (await dir.fetch('http://internal/rooms/add', { method: 'POST', body: JSON.stringify({ ids: exists, source: 'backfill' }) })).json();
            added = r.added || 0;
        }
        return Response.json({ ok: true, dryRun: !body.apply, asked: ids.length, known: known.length, toAdd: exists.length, added,
            missing, invalid, failed });
    }
    // Tests only (ACCOUNTS_DEV_MODE): forget an id, as a calendar stored before the registry existed.
    if (path === '/api/admin/rooms/dev-forget' && request.method === 'POST') {
        if (env.ACCOUNTS_DEV_MODE !== '1') return new Response('not found', { status: 404 });
        return dir.fetch('http://internal/rooms/remove', { method: 'POST', body: await request.text() });
    }
    return new Response('not found', { status: 404 });
}
