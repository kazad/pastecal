/**
 * Names -- Pro Unlimited's names, and /account's data.
 *
 *   pastecal.com/@handle             a public page listing the calendars its owner chose to show (else a
 *                                    neutral "@handle on pastecal" page); a friendly 404 for an unknown one
 *   pastecal.com/@handle/<name>      that calendar's VIEW page (never edit); .ics: its view feed
 *   pastecal.com/<name>              a top-level short name: a read-only directory row, so the app's
 *                                    usual lookup opens the view page (/view/<name>) and /<name>.ics works
 *
 * A link under a handle reaches its calendar through a hidden read-only directory name (alias), so
 * neither the page, its headers, the app nor the feed ever sees the calendar's edit id.
 *
 * Signed in (session cookie; POSTs need same-site JSON, like Accounts.js):
 *   GET  /api/account                          -> everything /account shows (below)
 *   POST /api/names/handle   {handle}          -> {ok, handle}      claim @handle, once. 409 taken / has-handle
 *   POST /api/names/calendar {name, title?}    -> {ok, calendarId, path}  a new calendar at @handle/<name>,
 *                                                 locked under Pro Unlimited and owned by the account
 *   POST /api/names/link     {calendarId, name} -> {ok, path}       give (or rename) one of your calendars' @name; a free
 *                                                 calendar (unlocked) moves under the handle and is locked there
 *   POST /api/names/unlink   {calendarId}       -> {ok}             remove it (409 unlimited-full if it would
 *                                                 then count past the 10)
 *   POST /api/names/show     {calendarId, show} -> {ok}             list it on pastecal.com/@handle (default off)
 *   POST /api/names/short    {name, calendarId} -> {ok}             claim pastecal.com/<name> for a calendar (10 at most)
 *   POST /api/names/short/remap   {name, calendarId} -> {ok}        point it at another of your calendars
 *   POST /api/names/short/release {name}             -> {ok}        let it go
 * Rules: names follow SlugService.nameProblem (reserved words and site pages refused); a top-level name
 * also must not be any calendar's or view link's name. Adding, renaming and remapping need an active Pro
 * Unlimited (403 unlimited-ended); removing, releasing and show/hide work after a lapse too. At most
 * NAME_CHANGES_PER_HOUR claims/links/remaps an hour per account (429 slow-down). Each is logged.
 * Errors: 401 signed-out, 400 bad-name {message} / bad-calendar, 403 not-owner, 404 no-handle.
 *
 * Lookups for the public pages are cached for 60 seconds (caches.default) and purged on change; the
 * purge reaches only the data center that made the change, so others may be up to 60 seconds behind.
 */
import { sessionUserId, sameSite, UNLIMITED_TOP_LEVEL, lockForOwner } from './Accounts.js';
import { LockClient } from './LockClient.js';
import { SlugService, nameProblem } from './SlugService.js';
import { applySecurityHeaders } from './SecurityHeaders.js';

export const NAME_CHANGES_PER_HOUR = 20;
export const SHORT_HOLD_DAYS = 90;
const CACHE_TTL = 60;
const ACTIVE = new Set(['active', 'trialing', 'past_due']);

const accounts = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));
const directory = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[.#$\[\]\/\u0000-\u001f\u007f]/.test(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- cache (public lookups) ----
const cacheKey = (kind, ...parts) => `https://names.pastecal.internal/${kind}/${parts.map(encodeURIComponent).join('/')}`;
async function cached(key, load) {
    const c = typeof caches !== 'undefined' ? caches.default : null;
    if (c) {
        const hit = await c.match(key).catch(() => null);
        if (hit) return hit.json();
    }
    const value = await load();
    if (c) await c.put(key, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_TTL}` } })).catch(() => {});
    return value;
}
export async function purgeNames(handle, names = []) {
    const c = typeof caches !== 'undefined' ? caches.default : null;
    if (!c || !handle) return;
    await Promise.all([c.delete(cacheKey('page', handle)), ...names.map((n) => c.delete(cacheKey('at', handle, n)))]).catch(() => {});
}

// ---- directory ----
async function directoryLookup(env, slug) {
    return (await directory(env).fetch(`http://internal/lookup?slug=${encodeURIComponent(slug)}`)).json();
}
async function directoryClaim(env, slug, targetId) {
    const r = await directory(env).fetch('http://internal/claim', { method: 'POST', body: JSON.stringify({ slug, targetId, isReadOnly: true }) });
    return r.ok;
}
export async function removeDirectoryName(env, slug) {
    await directory(env).fetch('http://internal/remove', { method: 'POST', body: JSON.stringify({ slug }) });
}
// A deleted account's short name: a tombstone until its release (the directory answers {found, ended}).
export async function endDirectoryName(env, slug) {
    await directory(env).fetch('http://internal/end', { method: 'POST', body: JSON.stringify({ slug }) });
}
async function roomExists(env, id) {
    if (!validId(id)) return false;
    const r = await env.CALENDARS.get(env.CALENDARS.idFromName(id)).fetch(`http://internal/cal/${encodeURIComponent(id)}`, { method: 'HEAD' });
    return r.status === 200;
}
// A random hidden read-only name for a link under a handle.
async function newAlias(env, calendarId) {
    for (let i = 0; i < 5; i++) {
        const alias = 'a' + SlugService.generatePublicViewId(11);
        if (await directoryClaim(env, alias, calendarId)) return alias;
    }
    return null;
}

// ---- /api/account and /api/names/* ----
export async function handleNames(request, env, url) {
    const path = url.pathname;
    if (path !== '/api/account' && !path.startsWith('/api/names/')) return null;
    if (!env.ACCOUNTS || !env.DIRECTORY) return json({ error: 'not-available' }, 503);
    try {
        if (path === '/api/account') {
            if (request.method !== 'GET') return json({ error: 'method' }, 405);
            const userId = await sessionUserId(request, env);
            if (!userId) return json({ error: 'signed-out' }, 401);
            return json(await accountData(env, userId));
        }
        if (request.method !== 'POST') return json({ error: 'method' }, 405);
        if (!sameSite(request, env)) return json({ error: 'forbidden-origin' }, 403);
        const userId = await sessionUserId(request, env);
        if (!userId) return json({ error: 'signed-out' }, 401);
        const body = (await request.json().catch(() => null)) || {};
        const op = NAME_OPS[path];
        if (!op) return json({ error: 'not-found' }, 404);
        return await op(request, env, userId, body);
    } catch (err) {
        console.error('[names]', path, err && err.message);
        return json({ error: 'internal' }, 500);
    }
}

async function accountData(env, userId) {
    const acc = accounts(env);
    const view = await acc.accountView(userId);
    if (!view) return { error: 'signed-out' };
    const ids = view.owned.slice(0, 60);
    const statuses = await Promise.all(ids.map((id) => LockClient.lockStatus(env, id).catch(() => ({ status: 0 }))));
    const linkOf = Object.fromEntries(view.links.map((l) => [l.calendarId, l]));
    const singleOf = Object.fromEntries(view.singles.map((x) => [x.calendarId, x]));
    const calendars = [];
    ids.forEach((id, i) => {
        const st = statuses[i];
        if (st.status === 404) return;
        let state = 'open';
        if (st.ok && st.locked && st.ownerId === userId) state = view.covered.includes(id) ? 'unlimited' : singleOf[id] && singleOf[id].status === 'trialing' ? 'trial' : 'locked';
        else if (st.ok && !st.locked && st.lapsed && st.lapsed.ownerId === userId && st.lapsed.mode === 'readonly') state = 'paused';
        else if (!st.ok) state = 'unknown';
        const l = linkOf[id];
        calendars.push({ id, title: st.title || id, state, atName: l ? l.name : null, show: !!(l && l.show),
            shortNames: view.shortNames.filter((x) => x.calendarId === id).map((x) => x.name),
            trialEnd: singleOf[id] ? singleOf[id].trialEnd : null });
    });
    return {
        email: view.email, plan: view.plan, unlimited: view.unlimited, singles: view.singles, hasBilling: view.hasBilling,
        handle: view.handle, active: view.plan === 'unlimited',
        proCount: view.proCount, proLimit: UNLIMITED_TOP_LEVEL,
        shortNames: view.shortNames.map((x) => ({ name: x.name, calendarId: x.calendarId, endedAt: x.endedAt })),
        shortLimit: UNLIMITED_TOP_LEVEL, holdDays: SHORT_HOLD_DAYS,
        calendars,
    };
}

// The account's state for a name change: {active, handle} or a Response.
async function gate(env, userId, { needActive = true, changes = true } = {}) {
    const acc = accounts(env);
    const active = !!(await acc.activeUnlimited(userId));
    if (needActive && !active) return { res: json({ error: 'unlimited-ended', message: 'Your Pro plan has ended. Renew it to add or change names; your links keep working.' }, 403) };
    if (changes && (await acc.nameEventsLastHour(userId)) >= NAME_CHANGES_PER_HOUR) return { res: json({ error: 'slow-down', message: 'That\'s a lot of changes. Try again in an hour.' }, 429) };
    return { acc, active, handle: (await acc.handleOf(userId)) };
}
// One of the account's calendars: locked by them (any plan), or paused for them.
async function ownCalendar(env, userId, calendarId) {
    if (!validId(calendarId)) return json({ error: 'bad-calendar' }, 400);
    const st = await LockClient.lockStatus(env, calendarId);
    if (st.status === 404) return json({ error: 'no-calendar' }, 404);
    if (!st.ok) return json({ error: 'unavailable' }, 502);
    const mine = (st.locked && st.ownerId === userId) || (!st.locked && st.lapsed && st.lapsed.ownerId === userId);
    return mine ? null : json({ error: 'not-owner' }, 403);
}
const bad = (message) => json({ error: 'bad-name', message }, 400);
const clean = (raw) => String(raw ?? '').trim().toLowerCase();

const NAME_OPS = {
    async '/api/names/handle'(request, env, userId, body) {
        const g = await gate(env, userId);
        if (g.res) return g.res;
        const handle = clean(body.handle), problem = nameProblem(handle, 'handle');
        if (problem) return bad(problem);
        const r = await g.acc.claimHandle(userId, handle);
        if (r.error === 'has-handle') return json({ error: 'has-handle', message: 'You already have a name. It can\'t be changed.' }, 409);
        if (r.error) return json({ error: 'taken', message: 'That name is taken. Try another.' }, 409);
        await g.acc.noteNameEvent(userId, 'handle', handle);
        console.log('[names] handle claimed');
        await purgeNames(handle);
        return json({ ok: true, handle });
    },

    async '/api/names/calendar'(request, env, userId, body) {
        const g = await gate(env, userId);
        if (g.res) return g.res;
        if (!g.handle) return json({ error: 'no-handle', message: 'Claim your name first.' }, 404);
        const name = clean(body.name), problem = nameProblem(name, 'link');
        if (problem) return bad(problem);
        if (await g.acc.linkByName(g.handle.handle, name)) return json({ error: 'name-taken', message: `You already have @${g.handle.handle}/${name}.` }, 409);
        // A fresh calendar id nobody has: the edit link only the owner knows.
        let id = null;
        for (let i = 0; i < 5 && !id; i++) { const c = SlugService.generatePublicViewId(12); if (!(await roomExists(env, c)) && !(await directoryLookup(env, c)).found) id = c; }
        if (!id) return json({ error: 'internal' }, 500);
        const title = (typeof body.title === 'string' && body.title.trim() ? body.title.trim() : name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())).slice(0, 80);
        const made = await env.CALENDARS.get(env.CALENDARS.idFromName(id)).fetch(`http://internal/cal/${encodeURIComponent(id)}`,
            { method: 'POST', body: JSON.stringify({ title, options: {}, events: [] }) });
        if (made.status !== 201) return json({ error: 'unavailable' }, 502);
        const alias = await newAlias(env, id);
        if (!alias) return json({ error: 'internal' }, 500);
        const set = await g.acc.setLink(g.handle.handle, name, id, alias);
        if (set.error) { await removeDirectoryName(env, alias); return json({ error: 'name-taken', message: `You already have @${g.handle.handle}/${name}.` }, 409); }
        // Living under the handle, it never counts toward the 10.
        const lock = await lockForOwner(env, new URL(request.url).hostname, id, userId, title);
        if (lock.error) {
            await g.acc.removeLink(id); await removeDirectoryName(env, alias);
            return json({ error: lock.error, ...(lock.message ? { message: lock.message } : {}) }, lock.status || 502);
        }
        await g.acc.noteNameEvent(userId, 'calendar', name);
        console.log('[names] calendar created under handle');
        await purgeNames(g.handle.handle, [name]);
        return json({ ok: true, calendarId: id, path: `/@${g.handle.handle}/${name}` });
    },

    async '/api/names/link'(request, env, userId, body) {
        const g = await gate(env, userId);
        if (g.res) return g.res;
        if (!g.handle) return json({ error: 'no-handle', message: 'Claim your name first.' }, 404);
        const name = clean(body.name), problem = nameProblem(name, 'link');
        if (problem) return bad(problem);
        // One of theirs, or a free calendar they can lock: it moves under the handle and is locked there.
        if (!validId(body.calendarId)) return json({ error: 'bad-calendar' }, 400);
        const st = await LockClient.lockStatus(env, body.calendarId);
        if (st.status === 404) return json({ error: 'no-calendar' }, 404);
        if (!st.ok) return json({ error: 'unavailable' }, 502);
        const mine = (st.locked && st.ownerId === userId) || (!st.locked && st.lapsed && st.lapsed.ownerId === userId);
        const free = !st.locked && !(st.lapsed && st.lapsed.mode === 'readonly');
        if (!mine && !free) return json({ error: 'not-owner' }, 403);
        const existing = await g.acc.linkFor(body.calendarId);
        const alias = existing ? existing.alias : await newAlias(env, body.calendarId);
        if (!alias) return json({ error: 'internal' }, 500);
        const set = await g.acc.setLink(g.handle.handle, name, body.calendarId, alias);
        if (set.error) { if (!existing) await removeDirectoryName(env, alias); return json({ error: 'name-taken', message: `You already have @${g.handle.handle}/${name}.` }, 409); }
        if (!st.locked) {
            const lock = await lockForOwner(env, new URL(request.url).hostname, body.calendarId, userId, st.title);
            if (lock.error) {
                if (!existing) { await g.acc.removeLink(body.calendarId); await removeDirectoryName(env, alias); }
                return json({ error: lock.error, ...(lock.message ? { message: lock.message } : {}) }, lock.status || 502);
            }
        }
        await g.acc.noteNameEvent(userId, existing ? 'rename' : 'link', name);
        console.log(`[names] link ${existing ? 'renamed' : 'added'}`);
        await purgeNames(g.handle.handle, [name, ...(set.previous ? [set.previous.name] : [])]);
        return json({ ok: true, path: `/@${g.handle.handle}/${name}` });
    },

    async '/api/names/unlink'(request, env, userId, body) {
        const g = await gate(env, userId, { needActive: false, changes: false });
        if (g.res) return g.res;
        if (!validId(body.calendarId)) return json({ error: 'bad-calendar' }, 400);
        const l = await g.acc.linkFor(body.calendarId);
        if (!l || !g.handle || l.handle !== g.handle.handle) return json({ error: 'no-link' }, 404);
        // Out from under the handle it would count toward the 10.
        if (g.active && (await g.acc.coveredByUnlimited(body.calendarId, userId)) && (await g.acc.proCount(userId)) >= UNLIMITED_TOP_LEVEL) {
            return json({ error: 'unlimited-full', message: `You've used your ${UNLIMITED_TOP_LEVEL}. This calendar can only stay upgraded under @${g.handle.handle}.` }, 409);
        }
        await g.acc.removeLink(body.calendarId);
        await removeDirectoryName(env, l.alias);
        await g.acc.noteNameEvent(userId, 'unlink', l.name);
        await purgeNames(l.handle, [l.name]);
        return json({ ok: true });
    },

    async '/api/names/show'(request, env, userId, body) {
        const g = await gate(env, userId, { needActive: false, changes: false });
        if (g.res) return g.res;
        if (!validId(body.calendarId)) return json({ error: 'bad-calendar' }, 400);
        const l = await g.acc.linkFor(body.calendarId);
        if (!l || !g.handle || l.handle !== g.handle.handle) return json({ error: 'no-link' }, 404);
        await g.acc.setShow(body.calendarId, !!body.show);
        await purgeNames(l.handle, [l.name]);
        return json({ ok: true, show: !!body.show });
    },

    async '/api/names/short'(request, env, userId, body) {
        const g = await gate(env, userId);
        if (g.res) return g.res;
        const name = clean(body.name), problem = nameProblem(name, 'short');
        if (problem) return bad(problem);
        const notMine = await ownCalendar(env, userId, body.calendarId);
        if (notMine) return notMine;
        if ((await g.acc.shortNamesOf(userId)).length >= UNLIMITED_TOP_LEVEL) return json({ error: 'short-limit', message: `You have all ${UNLIMITED_TOP_LEVEL} short links. Release one first.` }, 409);
        // Free everywhere: no short name, view link or calendar by that name (a calendar always keeps its address).
        const taken = json({ error: 'taken', message: 'That name is taken. Try another.' }, 409);
        if (await g.acc.shortRow(name)) return taken;
        if ((await directoryLookup(env, name)).found || await roomExists(env, name)) return taken;
        if (!(await directoryClaim(env, name, body.calendarId))) return taken;
        const r = await g.acc.addShort(userId, name, body.calendarId, UNLIMITED_TOP_LEVEL);
        if (r.error) { await removeDirectoryName(env, name); return r.error === 'taken' ? taken : json({ error: r.error }, 409); }
        await g.acc.noteNameEvent(userId, 'short', name);
        console.log('[names] short name claimed');
        return json({ ok: true, name });
    },

    async '/api/names/short/remap'(request, env, userId, body) {
        const g = await gate(env, userId);
        if (g.res) return g.res;
        const name = clean(body.name), row = await g.acc.shortRow(name);
        if (!row || row.user_id !== userId) return json({ error: 'no-link' }, 404);
        const notMine = await ownCalendar(env, userId, body.calendarId);
        if (notMine) return notMine;
        await directory(env).fetch('http://internal/retarget', { method: 'POST', body: JSON.stringify({ slug: name, targetId: body.calendarId }) });
        await g.acc.remapShort(name, body.calendarId);
        await g.acc.noteNameEvent(userId, 'remap', name);
        console.log('[names] short name remapped');
        return json({ ok: true });
    },

    async '/api/names/short/release'(request, env, userId, body) {
        const g = await gate(env, userId, { needActive: false, changes: false });
        if (g.res) return g.res;
        const name = clean(body.name), row = await g.acc.shortRow(name);
        if (!row || row.user_id !== userId) return json({ error: 'no-link' }, 404);
        await removeDirectoryName(env, name);
        await g.acc.removeShort(name);
        await g.acc.noteNameEvent(userId, 'release', name);
        return json({ ok: true });
    },
};

// ---- public pages: /@handle, /@handle/<name>, /@handle/<name>.ics ----
const AT_RE = /^\/@([^/]+?)(?:\/([^/]*?))?(\.ics)?\/?$/;

// -> Response, or null to fall through (an old calendar whose id starts with "@").
export async function serveAt(request, env, url, { serveFeed }) {
    const m = AT_RE.exec(url.pathname);
    if (!m || (request.method !== 'GET' && request.method !== 'HEAD')) return notFound(env, url);
    let handle, name;
    try { handle = decodeURIComponent(m[1]).toLowerCase(); name = m[2] ? decodeURIComponent(m[2]).toLowerCase() : null; } catch { return notFound(env, url); }
    const ics = !!m[3];
    if (ics && !name) return null;                                         // /@x.ics: an old calendar named "@x" keeps its feed
    if (!/^[a-z0-9-]{1,40}$/.test(handle) || (name !== null && !/^[a-z0-9-]{1,40}$/.test(name))) return notFound(env, url);
    const acc = accounts(env);
    if (!name) {
        const page = await cached(cacheKey('page', handle), async () => {
            const p = await acc.handlePage(handle);
            if (!p) return null;
            const titles = await Promise.all(p.links.map((l) => LockClient.lockStatus(env, l.calendarId).then((s) => s.title || l.name).catch(() => l.name)));
            return { handle, links: p.links.map((l, i) => ({ name: l.name, title: titles[i] })) };    // never a calendar id
        });
        if (!page) {
            if (await roomExists(env, '@' + handle)) return null;              // an old calendar named "@<handle>"
            return notFound(env, url);
        }
        return handlePageResponse(env, url, page);
    }
    const hit = await cached(cacheKey('at', handle, name), async () => (await acc.resolveLink(handle, name)) || { none: true });
    if (!hit || hit.none) return notFound(env, url);
    if (ics) {
        const look = await directoryLookup(env, hit.alias);
        if (!look.found || !look.isReadOnly) return new Response('Calendar not found', { status: 404 });
        return serveFeed(request, env, look.targetId, hit.alias, `${handle}-${name}`);
    }
    // The app's view page, told which read-only name to open; the address stays /@handle/<name>.
    const page = await env.ASSETS.fetch(new Request(new URL('/', url), { headers: { Accept: 'text/html' } }));
    const meta = `<meta name="pc-view" content="${esc(hit.alias)}"><meta name="pc-at" content="${esc('@' + handle + '/' + name)}">`;
    const out = new HTMLRewriter().on('head', { element(e) { e.prepend(meta, { html: true }); } }).transform(page);
    const res = new Response(out.body, out);
    res.headers.set('Cache-Control', 'no-cache');
    res.headers.delete('X-Robots-Tag');
    applySecurityHeaders(res.headers, '/view/');
    return res;
}

async function sitePage(env, url, fill, status = 200, title = 'pastecal') {
    const page = await env.ASSETS.fetch(new Request(new URL('/handle', url), { headers: { Accept: 'text/html' } }));
    const out = new HTMLRewriter()
        .on('title', { element(e) { e.setInnerContent(title); } })
        .on('#handle-main', { element(e) { e.setInnerContent(fill, { html: true }); } })
        .transform(page);
    const res = new Response(out.body, { status, headers: out.headers });
    res.headers.set('Cache-Control', 'no-cache');
    applySecurityHeaders(res.headers, '/@');
    return res;
}

function handlePageResponse(env, url, page) {
    const h = esc(page.handle);
    const list = page.links.length
        ? `<ul class="h-list" data-testid="handle-list">${page.links.map((l) =>
            `<li><a href="/@${h}/${esc(l.name)}" data-testid="handle-link"><span class="h-title">${esc(l.title)}</span><span class="h-path">pastecal.com/@${h}/${esc(l.name)}</span></a></li>`).join('')}</ul>`
        : `<p class="h-muted" data-testid="handle-empty">Calendars shared here will show up on this page.</p>`;
    return sitePage(env, url, `<h1 data-testid="handle-name">@${h}</h1><p class="h-sub">on pastecal</p>${list}`, 200, `@${page.handle} · pastecal`);
}

function notFound(env, url) {
    return sitePage(env, url, `<h1 data-testid="handle-404">Nothing here</h1><p class="h-muted">There's no calendar at this address. Check the link, or ask the person who shared it.</p><p><a class="h-btn" href="/">Make a calendar</a></p>`, 404, 'Not found · pastecal');
}

// ---- /link-ended/<name>: where the app sends a short name whose account was deleted ----
// The calendar pages are static (they never reach the Worker), so the app's lookup sees {ended} and comes
// here. Only a real tombstone (until its 90-day release) gets "This link has ended"; anything else is the
// plain not-found page, so this address can't be used to say any other link has ended.
const ENDED_RE = /^\/link-ended\/([^/]+)\/?$/;
export async function serveNamePage(request, env, url) {
    const m = ENDED_RE.exec(url.pathname);
    if (!m) return null;
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !env.DIRECTORY) return notFound(env, url);
    let slug;
    try { slug = decodeURIComponent(m[1]); } catch { return notFound(env, url); }
    if (!SlugService.isLookupable(slug)) return notFound(env, url);
    const look = await directoryLookup(env, slug).catch(() => null);
    if (!look || !look.found || !look.ended) return notFound(env, url);
    const res = await sitePage(env, url, `<h1 data-testid="link-ended">This link has ended</h1><p class="h-muted">The calendar that was shared here isn't at this address anymore. Ask the person who shared it for a new link.</p><p><a class="h-btn" href="/">Make a calendar</a></p>`, 410, 'This link has ended · pastecal');
    res.headers.set('X-Robots-Tag', 'noindex');
    return res;
}
