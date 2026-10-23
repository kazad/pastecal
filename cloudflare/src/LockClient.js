/**
 * LockClient -- the one place accounts/billing talks to a calendar's lock (built inside CalendarRoom).
 *
 *   lock(id, ownerId)          -> {status, ok, editorKey?, error?}   409 locked-by-other, 404 no calendar
 *   unlock(id, ownerId)        -> {status, ok}
 *   rotateEditorKey(id, owner) -> {status, ok, editorKey?}
 *   lockStatus(id)             -> {status, locked, ownerId, plan, lockedAt}
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
    lock: (env, id, ownerId) => call(env, id, 'lock', 'POST', { ownerId, plan: 'pro' }),
    unlock: (env, id, ownerId) => call(env, id, 'unlock', 'POST', { ownerId }),
    rotateEditorKey: (env, id, ownerId) => call(env, id, 'rotate-editor-key', 'POST', { ownerId }),
    lockStatus: (env, id) => call(env, id, 'lock-status', 'GET'),
};
