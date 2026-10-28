/**
 * Re-key the directory: move every row stored under a key from before CalendarName.key to its key now.
 *
 * Until Oct 2026 the directory keyed a name by its lowercase only, so "royal city " had its own row at "royal city ",
 * apart from "royal city", while the registry (rooms.name_key) already trimmed. CalendarName.key (trimmed, lowercase,
 * NFC) is now the one rule. A calendar's stored id never changes (its room is idFromName(exact id)); only the key a
 * row sits under moves. Until a row is moved, CalendarDirectory reads it at its legacy key too (rowAt), so nothing
 * breaks between the deploy and this.
 *
 *   POST /api/admin/directory/rekey {apply?}   (Bearer IMPORT_SECRET, index.js) dry run by default. Idempotent: a second
 *        run finds nothing to move. Script: scripts/rekey-directory.mjs (saves every row it will change first).
 *
 * Two or more rows that land on one key (a collision) keep ONE row:
 *   1. a row that leads to a calendar that exists, over a stale one (editable: its own calendar; view: its target)
 *   2. an editable calendar's row over a view link's (that view link, /view/<name>, then ends: listed in viewLinksEnded)
 *   3. between editables, the canonical spelling (no surrounding spaces, NFC), else the older row, else the row
 *      already at the key
 * The other spellings stay reachable at their exact names (ExactNames.js: the exact name first); each losing calendar
 * is added to the registry (rooms) first, so the daily archive still finds it. Rows that are the same name leading to
 * the same place (duplicates) keep one. A group with a tombstone (a deleted account's short name) is skipped and listed.
 */
import { calendarAt } from './ExactNames.js';

const kindOf = (r) => (r.ended_at ? 'ended' : r.is_readonly ? 'view' : 'editable');
const canonical = (s) => s === s.trim().normalize('NFC');
const brief = (r, extra = {}) => ({ actual_slug: r.actual_slug, normalized: r.normalized, kind: kindOf(r), target_id: r.target_id ?? null,
    created_at: r.created_at ?? null, ...extra });

// Lower ranks first: the row a collision keeps.
function rank(r, live, key) {
    return [live ? 0 : 1, r.is_readonly ? 1 : 0, !r.is_readonly && canonical(r.actual_slug) ? 0 : 1,
        Number.isFinite(r.created_at) ? r.created_at : Infinity, r.normalized === key ? 0 : 1];
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };

export async function handleRekey(request, env, dir) {
    const body = await request.json().catch(() => ({}));
    const apply = !!(body && body.apply);
    const plan = await (await dir.fetch('http://internal/rekey/plan')).json();
    const moves = [], duplicates = [], collisions = [], viewLinksEnded = [], skipped = [];
    const drop = [], move = [], register = new Set();

    for (const { key, rows } of plan.groups) {
        if (rows.some((r) => r.ended_at)) { skipped.push({ key, reason: 'a tombstone holds this name', rows: rows.map((r) => brief(r)) }); continue; }
        // Duplicates: one name leading to one place (a calendar's own row at both keys). Keep the one at the key, else the oldest.
        const byPlace = new Map();
        for (const r of rows) {
            const id = JSON.stringify([r.actual_slug, r.is_readonly ? 1 : 0, r.target_id ?? r.actual_slug]);
            const have = byPlace.get(id);
            if (!have) { byPlace.set(id, r); continue; }
            const keep = cmp(rank(have, true, key), rank(r, true, key)) <= 0 ? have : r;
            const gone = keep === have ? r : have;
            byPlace.set(id, keep);
            drop.push(gone);
            duplicates.push({ key, kept: brief(keep), dropped: brief(gone) });
        }
        const distinct = [...byPlace.values()];
        if (distinct.length === 1) {
            const r = distinct[0];
            if (r.normalized !== key) { move.push(r); moves.push({ from: r.normalized, to: key, actualSlug: r.actual_slug, kind: kindOf(r), row: brief(r) }); }
            continue;
        }
        // A collision: which rows still lead to a calendar.
        const live = await Promise.all(distinct.map((r) => calendarAt(env, r.is_readonly ? r.target_id : r.actual_slug).catch(() => true)));
        const order = distinct.map((r, i) => ({ r, live: live[i] })).sort((a, b) => cmp(rank(a.r, a.live, key), rank(b.r, b.live, key)));
        const [win, ...lose] = order;
        if (win.r.normalized !== key) { move.push(win.r); moves.push({ from: win.r.normalized, to: key, actualSlug: win.r.actual_slug, kind: kindOf(win.r), row: brief(win.r) }); }
        const why = (l) => (win.live && !l.live ? 'leads to no calendar' : !win.r.is_readonly && l.r.is_readonly ? 'a view link; the editable calendar keeps the name'
            : !win.r.is_readonly && canonical(win.r.actual_slug) && !canonical(l.r.actual_slug) ? 'not the canonical spelling' : 'newer');
        for (const l of lose) {
            drop.push(l.r);
            if (!l.r.is_readonly && l.live) register.add(l.r.actual_slug);
            if (l.r.is_readonly) viewLinksEnded.push({ key, viewId: l.r.actual_slug, opened: l.r.target_id, nowOpens: win.r.actual_slug });
        }
        if (!win.r.is_readonly && win.live) register.add(win.r.actual_slug);
        collisions.push({ key, kept: brief(win.r, { live: win.live }), dropped: lose.map((l) => brief(l.r, { live: l.live, why: why(l) })) });
    }

    const out = { ok: true, dryRun: !apply, scanned: plan.scanned, moves, duplicates, collisions, viewLinksEnded, skipped,
        anomalies: plan.anomalies.map((r) => brief(r)), roomsStale: plan.roomsStale.length };
    if (!apply) return Response.json(out);
    if (register.size) {
        const r = await dir.fetch('http://internal/rooms/add', { method: 'POST', body: JSON.stringify({ ids: [...register], source: 'rekey' }) });
        if (!r.ok) return Response.json({ ...out, ok: false, error: 'could not register the colliding calendars; nothing changed' }, { status: 502 });
    }
    const res = await (await dir.fetch('http://internal/rekey/apply', { method: 'POST', body: JSON.stringify({ drop, move, rooms: true }) })).json();
    return Response.json({ ...out, applied: res });
}
