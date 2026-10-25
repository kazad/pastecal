/**
 * LockClient -- the one place accounts/billing talks to a calendar's lock (built inside CalendarRoom).
 *
 *   lock(id, ownerId)          -> {status, ok, error?}   409 locked-by-other, 404 no calendar (makes no editor link)
 *   unlock(id, ownerId, {lapse}) -> {status, ok, paused}  lapse: billing ended it, so it pauses unless the owner chose 'open'
 *   setLapsedMode(id, owner, mode) -> {status, ok, mode, paused}  'readonly' | 'open' (locked owner, or the paused calendar's owner)
 *   rotateEditorKey(id, owner) -> {status, ok, editorKey?}     revokes every editor link, makes one 'Editors' link
 *   lockStatus(id)             -> {status, locked, ownerId, plan, lockedAt, title, lapsed:{ownerId, mode, at}|null, lapsedMode, lapsedModeChosen}
 *   editorOfRecord(id, uid)    -> {status, ok, known, editor, creator}   made it, or edited on 2+ days (else the top author)
 *   createEditorLink(id, owner, label) -> {status, ok, id, label, createdAt, editorKey}   409 too-many-links / not-locked, 403 not-owner
 *   listEditorLinks(id, owner)         -> {status, ok, links:[{id, label, createdAt, lastUsedAt}]}
 *   revokeEditorLink(id, owner, linkId) -> {status, ok}                                   404 no-link
 *   setProSettings(id, owner, settings) -> {status, ok, settings}                         400 bad-settings (+message)
 *
 * Calls go to the calendar's Durable Object. In local tests, ACCOUNTS_DEV_MODE=1 plus
 * LOCK_API_BASE=http://127.0.0.1:<port> sends them to a fake instead; any other host is refused,
 * so a stray var can never send owner ids elsewhere.
 */
// A test-only base URL is honored only for this machine: http://localhost or http://127.0.0.1.
export function localBase(raw) {
    try {
        const u = new URL(raw);
        if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.origin + u.pathname.replace(/\/$/, '');
    } catch { /* not a URL */ }
    return null;
}

async function call(env, id, action, method, body) {
    const path = `/cal/${encodeURIComponent(id)}/${action}`;
    const init = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) init.body = JSON.stringify(body);
    let res;
    const base = env.ACCOUNTS_DEV_MODE === '1' && env.LOCK_API_BASE ? localBase(env.LOCK_API_BASE) : null;
    if (base) res = await fetch(base + path, init);
    else res = await env.CALENDARS.get(env.CALENDARS.idFromName(id)).fetch('http://internal' + path, init);
    const data = await res.json().catch(() => ({}));
    return { ...data, status: res.status, ok: res.ok && data.ok !== false };
}

export const LockClient = {
    // Billing has no browser to show a key to: no 'Editors' link is made (the owner makes links later).
    // takeover: support only (reassign), may lock a calendar paused for its previous owner.
    lock: (env, id, ownerId, { takeover = false } = {}) => call(env, id, 'lock', 'POST', { ownerId, plan: 'pro', createLink: false, ...(takeover ? { takeover: true } : {}) }),
    // trial: a trial ended unpaid, so it ends open unless the owner chose read-only.
    // undo: the 7-day undo of someone else's upgrade (Activity says "Upgrade undone").
    unlock: (env, id, ownerId, { lapse = false, trial = false, undo = false } = {}) => call(env, id, 'unlock', 'POST', { ownerId, ...(lapse ? { lapse: true } : {}), ...(trial ? { trial: true } : {}), ...(undo ? { undo: true } : {}) }),
    setLapsedMode: (env, id, ownerId, mode) => call(env, id, 'set-lapsed-mode', 'POST', { ownerId, mode }),
    rotateEditorKey: (env, id, ownerId) => call(env, id, 'rotate-editor-key', 'POST', { ownerId }),
    lockStatus: (env, id) => call(env, id, 'lock-status', 'GET'),
    // Has this author uid run the calendar (created it, or edited it on 2+ days; else the top author)?
    editorOfRecord: (env, id, uid) => call(env, id, 'editor-of-record', 'POST', { uid: typeof uid === 'string' ? uid : '' }),
    createEditorLink: (env, id, ownerId, label) => call(env, id, 'create-editor-link', 'POST', { ownerId, label }),
    listEditorLinks: (env, id, ownerId) => call(env, id, 'list-editor-links', 'POST', { ownerId }),
    revokeEditorLink: (env, id, ownerId, linkId) => call(env, id, 'revoke-editor-link', 'POST', { ownerId, id: linkId }),
    setProSettings: (env, id, ownerId, settings) => call(env, id, 'set-pro-settings', 'POST', { ownerId, settings }),
};
