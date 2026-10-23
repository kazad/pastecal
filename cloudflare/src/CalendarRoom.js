/**
 * CalendarRoom -- one calendar, as a Durable Object.
 *
 * Cloudflare runs exactly one instance of this per calendar name, anywhere in the world,
 * and hands it every request for that calendar one at a time. So there is no merge: saves
 * are applied in the order they arrive, by the same EventStore code the browser uses.
 *
 * It is the only thing that decides what is stored. Browsers send COMMANDS ("update these
 * fields of that event"), never a whole calendar, and everything that bounds cost lives
 * here, where no browser bug can skip it:
 *   - a save rate limit per calendar and per connection (Sep 26: one tab saved twice a
 *     second for 17 hours; here the 61st save in a minute is refused before it is stored
 *     or broadcast);
 *   - size limits on events and fields;
 *   - "a save that changes nothing stores nothing and tells no one".
 *
 * Protocol (JSON over one WebSocket per tab):
 *   server -> tab   {t:'snapshot', v, calendar}          on connect, and after an import
 *   tab -> server   {t:'save', id, v, commands:[...]}    v = version the tab had
 *                   {t:'meta', id, title?, options?}
 *                   {t:'hello'}                           "send me the snapshot again" (after a conflict or reconnect)
 *   server -> tab   {t:'ack', id, v}                      to the sender
 *                   {t:'change', v, commands}             to every other tab
 *                   {t:'error', id, code, message}        refused; nothing was stored (code 'locked': a Pro lock)
 *   tab -> server   {t:'auth', key}                       an editor link's key for a locked calendar (never in a URL)
 *   server -> tab   {t:'auth', ok, canEdit, locked, role} the answer; also sent (ok:false, reason) when that link
 *                                                         is revoked ('link-revoked') or all are replaced ('key-rotated')
 *   server -> tab   {t:'pro', settings}                   the owner changed proSettings (sent to every tab, views too)
 * Snapshots also carry {locked, pro, canEdit, role, proSettings}. role is 'owner' | 'editor' | 'viewer'
 * (an unlocked calendar: 'editor' for everyone with the edit name). proSettings is null unless locked.
 *
 * HTTP: GET /cal/<id> the calendar (404 = no such calendar); HEAD /cal/<id> same, no body;
 * POST /cal/<id> creates the calendar from {title, options, events} -- ONLY when the room
 * is empty (409 otherwise), names and events validated, size-limited (the Worker also
 * rate-limits it per IP). PUT /cal/<id>/import replaces everything (secret required).
 *
 * Pro lock: while `lock` holds a row, only the owner (X-PC-User on the WebSocket upgrade, set by
 * the Worker from a session, never by a client) and sockets that sent a live editor link's key may
 * change the calendar; every other write path (saves, meta, /import, /from-firebase) is refused. Lock
 * routes (see LOCK_ROUTES) answer only http://internal/... requests from Worker code; the Worker's
 * public /cal/ forwarder never passes them.
 *
 * Roles on a locked calendar:
 *   owner  -- everything: events, notes, title, categories, options, AND the owner-only list:
 *             editor links, proSettings, lock/unlock, billing (the last two live in Accounts/Stripe).
 *   editor -- holds an editor link: events, notes, title, categories, options (calendar content).
 *             Title is content, so editors may change it. Never the owner-only list.
 *   viewer -- everyone else (edit name without a key, or a view link): read only.
 * Owner-only operations never travel over the socket: they are internal routes the Worker calls
 * only after checking the owner's session (Accounts.js), and the room re-checks ownerId itself.
 * Unlocked calendars: anyone with the edit name edits everything, as always.
 *
 * Editor links: up to 20 live links per calendar, each with a label and only its key's SHA-256
 * stored. Revoking one drops the sockets that used it to read-only at once. A socket's attachment
 * holds the link id in `keyId` (the name predates links: a legacy single key became a link with
 * the same id, so sockets authorized before the migration keep working).
 *
 * proSettings: owner-written display settings ({theme, branding, hideBranding}, see
 * mergeProSettings), stored in pro_settings, NOT in `options` (any tab writes options). Sent at the
 * top level of snapshots and GET /cal while locked; never accepted from a save or meta.
 *
 * Storage (this object's own SQLite): meta(k, v), events(k, pos, data), history(v, at,
 * source, commands), lock(owner, plan, locked_at, key_hash, key_id), editor_links(id, label,
 * key_hash, created_at, last_used_at, revoked_at), pro_settings(owner, data, updated_at). The lock
 * lives apart from `options` because any tab can write options; owner ids and key hashes never leave
 * these tables. lock.key_hash/key_id are the legacy single key, moved into editor_links on load.
 */
import { DurableObject } from 'cloudflare:workers';
import EventStore from '../../public/services/EventStore.js';

export const LIMITS = {
    savesPerMinute: 60,          // per calendar: far above people, far below a loop
    savesPerMinutePerTab: 40,
    maxEvents: 5000,             // largest real calendar: 2,442 (Sep 27 survey)
    maxField: 20000,             // longest real description: 5,641 chars
    maxTitle: 2000,
    maxMessage: 512 * 1024,      // one save message
    copyBackDelayMs: 3000,       // after the last save, before writing to Firebase
    maxCreate: 1024 * 1024,      // the body of a first save (POST /cal/<id>)
};

const json = (x) => JSON.stringify(x);

// Option keys only the server may decide. Tabs write options through ordinary saves, so a client
// that sent {pro:true} would hide branding, and {locked:false} would read as unlocked.
// The Pro display settings (theme, branding) are owner-only: they live in proSettings, so the same
// names in options are dropped from every tab, editor or not.
const SERVER_ONLY_OPTIONS = /^(locked|lock|pro|plan|owner|ownerId|editorKey.*|editorLinks?|proSettings|theme|branding|hideBranding)$/i;
function clientOptions(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    if (!Object.keys(o).some((k) => SERVER_ONLY_OPTIONS.test(k))) return o;
    return Object.fromEntries(Object.entries(o).filter(([k]) => !SERVER_ONLY_OPTIONS.test(k)));
}

const LOCK_ROUTES = new Set(['lock', 'unlock', 'rotate-editor-key', 'lock-status', 'can-edit', 'set-view-id',
    'create-editor-link', 'list-editor-links', 'revoke-editor-link', 'set-pro-settings', 'dev-legacy-key']);
export const MAX_EDITOR_LINKS = 20;
const LINK_TOUCH_MS = 3600 * 1000;          // last_used_at is written at most once an hour per link

// ---- Pro display settings (owner-only) ----
export const DEFAULT_PRO_SETTINGS = Object.freeze({
    theme: Object.freeze({ accent: null, font: null, embedMode: 'auto' }),
    branding: Object.freeze({ name: null, logoUrl: null }),
    hideBranding: true,
});
const FONTS = ['figtree', 'system', 'serif', 'rounded'];
const EMBED_MODES = ['auto', 'light', 'dark'];
const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// A PARTIAL patch merged onto the current settings, field by field; every field present is
// validated strictly and anything unknown is refused (nothing is stored on any error).
// -> {ok:true, settings} | {ok:false, error}
export function mergeProSettings(current, patch) {
    if (!isPlainObject(patch)) return { ok: false, error: 'settings must be an object' };
    const cur = current || DEFAULT_PRO_SETTINGS;
    const out = { theme: { ...DEFAULT_PRO_SETTINGS.theme, ...cur.theme }, branding: { ...DEFAULT_PRO_SETTINGS.branding, ...cur.branding },
        hideBranding: typeof cur.hideBranding === 'boolean' ? cur.hideBranding : true };
    const bad = (error) => ({ ok: false, error });
    for (const k of Object.keys(patch)) if (!['theme', 'branding', 'hideBranding'].includes(k)) return bad(`unknown setting: ${k}`);
    if ('theme' in patch) {
        const t = patch.theme;
        if (!isPlainObject(t)) return bad('theme must be an object');
        for (const k of Object.keys(t)) if (!['accent', 'font', 'embedMode'].includes(k)) return bad(`unknown setting: theme.${k}`);
        if ('accent' in t) {
            if (t.accent !== null && !(typeof t.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.accent))) return bad('theme.accent must be #rrggbb or null');
            out.theme.accent = t.accent === null ? null : t.accent.toLowerCase();
        }
        if ('font' in t) {
            if (t.font !== null && !FONTS.includes(t.font)) return bad(`theme.font must be one of ${FONTS.join(', ')} or null`);
            out.theme.font = t.font;
        }
        if ('embedMode' in t) {
            if (!EMBED_MODES.includes(t.embedMode)) return bad(`theme.embedMode must be one of ${EMBED_MODES.join(', ')}`);
            out.theme.embedMode = t.embedMode;
        }
    }
    if ('branding' in patch) {
        const b = patch.branding;
        if (!isPlainObject(b)) return bad('branding must be an object');
        for (const k of Object.keys(b)) if (!['name', 'logoUrl'].includes(k)) return bad(`unknown setting: branding.${k}`);
        if ('name' in b) {
            if (b.name !== null && typeof b.name !== 'string') return bad('branding.name must be a string or null');
            const name = b.name === null ? '' : b.name.trim();
            if (name.length > 60) return bad('branding.name is longer than 60 characters');
            if (CONTROL_CHARS.test(name)) return bad('branding.name has control characters');
            out.branding.name = name || null;
        }
        if ('logoUrl' in b) {
            if (b.logoUrl === null || b.logoUrl === '') out.branding.logoUrl = null;
            else {
                if (typeof b.logoUrl !== 'string' || b.logoUrl.length > 500) return bad('branding.logoUrl must be an https URL (500 characters at most)');
                let u; try { u = new URL(b.logoUrl); } catch { return bad('branding.logoUrl must be an https URL'); }
                if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return bad('branding.logoUrl must be an https URL');
                out.branding.logoUrl = u.href;
            }
        }
    }
    if ('hideBranding' in patch) {
        if (typeof patch.hideBranding !== 'boolean') return bad('hideBranding must be true or false');
        out.hideBranding = patch.hideBranding;
    }
    return { ok: true, settings: out };
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Equal-length hex digests; no early exit, so timing says nothing about how much matched.
function sameHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

export class CalendarRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.saves = [];             // times of recent saves (memory: resets on hibernation, which only happens when idle)
        ctx.blockConcurrencyWhile(async () => {
            this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS events (k TEXT PRIMARY KEY, pos INTEGER, data TEXT)`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS history (v INTEGER PRIMARY KEY, at INTEGER, source TEXT, commands TEXT, entry TEXT)`);
            try { this.sql.exec(`ALTER TABLE history ADD COLUMN entry TEXT`); } catch (_) {}
            this.sql.exec(`CREATE TABLE IF NOT EXISTS authors (uid TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, edit_count INTEGER, created_here INTEGER, days TEXT)`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS lock (k INTEGER PRIMARY KEY CHECK (k = 1), owner TEXT NOT NULL, plan TEXT, locked_at INTEGER, key_hash TEXT, key_id TEXT)`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS editor_links (id TEXT PRIMARY KEY, label TEXT NOT NULL, key_hash TEXT NOT NULL, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER)`);
            // suspended_for: the owner whose unlock paused this link; a re-lock by that owner turns it back on.
            try { this.sql.exec(`ALTER TABLE editor_links ADD COLUMN suspended_for TEXT`); } catch (_) {}
            this.sql.exec(`CREATE TABLE IF NOT EXISTS pro_settings (k INTEGER PRIMARY KEY CHECK (k = 1), owner TEXT, data TEXT, updated_at INTEGER)`);
            this.load();
        });
    }

    // ---- state ----------------------------------------------------------------------------
    load() {
        const meta = Object.fromEntries(this.sql.exec(`SELECT k, v FROM meta`).toArray().map((r) => [r.k, JSON.parse(r.v)]));
        this.mirrored = meta.mirrored || null;
        this.state = {
            v: meta.v || 0,
            id: meta.id || null,
            title: meta.title ?? '',
            options: meta.options || {},
            lastEditedAt: meta.lastEditedAt || null,
            events: this.sql.exec(`SELECT data FROM events ORDER BY pos`).toArray().map((r) => JSON.parse(r.data)),
        };
        const l = this.sql.exec(`SELECT owner, plan, locked_at, key_hash, key_id FROM lock`).toArray()[0];
        this.lock = l ? { ownerId: l.owner, plan: l.plan, lockedAt: l.locked_at } : null;
        if (l && l.key_hash) {
            // A lock from before editor links held one key. It becomes a link labeled 'Editors' with the
            // SAME id, so sockets that proved that key (attachment keyId) keep their write access.
            const id = l.key_id || this.newLinkId();
            if (!this.sql.exec(`SELECT 1 FROM editor_links WHERE id = ?`, id).toArray().length) {
                this.sql.exec(`INSERT INTO editor_links (id, label, key_hash, created_at, last_used_at, revoked_at) VALUES (?, 'Editors', ?, ?, NULL, NULL)`,
                    id, l.key_hash, l.locked_at || Date.now());
            }
            this.sql.exec(`UPDATE lock SET key_hash = NULL, key_id = NULL`);
        }
        // Live links only, in memory: canWrite checks a socket's link against this at every message.
        // Links paused by an unlock (suspended_for) are kept apart: they authorize nothing.
        const rows = this.sql.exec(`SELECT id, label, key_hash, created_at, last_used_at, suspended_for FROM editor_links WHERE revoked_at IS NULL ORDER BY created_at, id`).toArray();
        const asLink = (r) => [r.id, { id: r.id, label: r.label, keyHash: r.key_hash, createdAt: r.created_at, lastUsedAt: r.last_used_at, suspendedFor: r.suspended_for || null }];
        this.links = new Map(rows.filter((r) => !r.suspended_for).map(asLink));
        this.suspended = new Map(rows.filter((r) => r.suspended_for).map(asLink));
        const ps = this.sql.exec(`SELECT owner, data FROM pro_settings`).toArray()[0];
        let settings = null; try { settings = ps ? JSON.parse(ps.data) : null; } catch { /* unreadable: defaults */ }
        this.proStored = ps && settings ? { owner: ps.owner, settings } : null;
    }
    setMeta(k, v) { this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, json(v)); }
    calendar() {
        const s = this.state;
        return { id: s.id, title: s.title, options: s.options, lastEditedAt: s.lastEditedAt, events: s.events };
    }
    viewCalendar(viewId) {
        const s = this.state;
        const options = { ...s.options };
        delete options.publicViewId;
        return { id: viewId, title: s.title, options, lastEditedAt: s.lastEditedAt, events: s.events };
    }

    // ---- Pro lock -------------------------------------------------------------------------
    // A socket's right to write is worked out at each message from what it proved (its
    // attachment) against the lock as it is NOW, never cached: revoking a link, replacing all of
    // them, an unlock (which pauses them) or a lock by a new owner removes the link id from
    // this.links, so its sockets lose write access at once, even after hibernation.
    canWrite(att) {
        if (att.isViewOnly) return false;
        const l = this.lock;
        if (!l) return true;
        return this.isOwner(att) || (!!att.keyId && this.links.has(att.keyId));
    }
    isOwner(att) { return !att.isViewOnly && !!this.lock && !!att.user && att.user === this.lock.ownerId; }
    roleOf(att) { return this.isOwner(att) ? 'owner' : this.canWrite(att) ? 'editor' : 'viewer'; }
    // Shown to everyone while locked (it is how the calendar looks); null otherwise. Settings saved
    // by a previous owner are not inherited by a new one.
    proSettings() {
        if (!this.lock) return null;
        const p = this.proStored;
        return p && p.owner === this.lock.ownerId ? mergeProSettings(p.settings, {}).settings : mergeProSettings(null, {}).settings;
    }
    snapshotFor(att) {
        const cal = att.isViewOnly ? this.viewCalendar(att.viewId) : this.calendar();
        return { t: 'snapshot', v: this.state.v, calendar: cal, locked: !!this.lock, pro: !!this.lock, canEdit: this.canWrite(att), role: this.roleOf(att), proSettings: this.proSettings() };
    }
    // The live link a key belongs to, or null. Hashed first; after the await everything is read
    // synchronously, so the answer is about the links as they are now. Every link is compared
    // (no early exit), each in constant time. While unlocked, a key matches a paused link, so the
    // socket remembers it and can write again if the same owner re-locks.
    async keyMatches(key) {
        if (typeof key !== 'string' || !key || key.length > 200) return null;
        const hash = await sha256Hex(key);
        let hit = null;
        for (const link of (this.lock ? this.links : this.suspended).values()) if (sameHex(hash, link.keyHash)) hit = link;
        return hit;
    }
    // Was this key a link that has since been revoked? (Revoked rows are kept a while with their hashes.)
    async keyRevoked(key) {
        if (typeof key !== 'string' || !key || key.length > 200) return false;
        const hash = await sha256Hex(key);
        let hit = false;
        for (const r of this.sql.exec(`SELECT key_hash FROM editor_links WHERE revoked_at IS NOT NULL`).toArray()) hit = sameHex(hash, r.key_hash) || hit;
        return hit;
    }
    touchLink(link) {
        const now = Date.now();
        if (link.lastUsedAt && now - link.lastUsedAt < LINK_TOUCH_MS) return;
        link.lastUsedAt = now;
        this.sql.exec(`UPDATE editor_links SET last_used_at = ? WHERE id = ?`, now, link.id);
    }
    newLinkId() { return b64url(crypto.getRandomValues(new Uint8Array(6))); }      // 8 characters
    async newEditorKey() {
        const key = b64url(crypto.getRandomValues(new Uint8Array(16)));    // 128 bits
        return { key, keyHash: await sha256Hex(key), keyId: this.newLinkId() };
    }
    // Synchronous: callers make the key first (the only await), then read and write.
    createLink(label, k) {
        let id = k.keyId;
        while (this.links.has(id) || this.sql.exec(`SELECT 1 FROM editor_links WHERE id = ?`, id).toArray().length) id = this.newLinkId();
        const at = Date.now();
        this.sql.exec(`INSERT INTO editor_links (id, label, key_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)`, id, label, k.keyHash, at);
        // Revoked rows are kept a while (they explain a dead link), not forever.
        this.sql.exec(`DELETE FROM editor_links WHERE revoked_at IS NOT NULL AND id NOT IN (SELECT id FROM editor_links WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 50)`);
        const link = { id, label, keyHash: k.keyHash, createdAt: at, lastUsedAt: null };
        this.links.set(id, link);
        return link;
    }
    // Revoke links; sockets that used one are told at once and drop to read-only (unless they are the owner).
    revokeLinks(ids, reason) {
        const gone = new Set(ids.filter((id) => this.links.has(id)));
        if (!gone.size) return;
        const at = Date.now();
        for (const id of gone) { this.sql.exec(`UPDATE editor_links SET revoked_at = ? WHERE id = ?`, at, id); this.links.delete(id); }
        if (reason) this.tellRevoked(gone, reason);
    }
    tellRevoked(gone, reason) {
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment() || {};
            if (!gone.has(att.keyId)) continue;
            const next = { ...att, keyId: null };
            ws.serializeAttachment(next);
            try { ws.send(json({ t: 'auth', ok: false, reason, locked: !!this.lock, canEdit: this.canWrite(next), role: this.roleOf(next) })); } catch { /* gone */ }
        }
    }
    static cleanLabel(label) {
        if (typeof label !== 'string') return null;
        const t = label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
        return t && t.length <= 40 ? t : null;
    }
    // A history row for a lock change, so a group can see why editing stopped (or came back).
    // No owner and no key: history is served to anyone with the edit name.
    recordLockChange(kind, label) {
        const s = this.state, at = Date.now();
        s.v += 1; this.setMeta('v', s.v);
        const entry = { savedAt: at, kind, label, removed: 0, changed: 0, added: 0, removedEvents: [], changedEvents: [], addedEvents: [],
            eventCount: s.events.length, title: s.title, options: s.options, writer: null };
        this.sql.exec(`INSERT INTO history (v, at, source, commands, entry) VALUES (?, ?, ?, ?, ?)`, s.v, at, kind, json([{ type: kind }]), json(entry));
        this.sql.exec(`DELETE FROM history WHERE v NOT IN (SELECT v FROM history ORDER BY v DESC LIMIT 50)`);
        for (const ws of this.ctx.getWebSockets()) { try { ws.send(json(this.snapshotFor(ws.deserializeAttachment() || {}))); } catch { /* gone */ } }
    }

    async lockRoute(op, request) {
        const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
        const ownerId = typeof body?.ownerId === 'string' ? body.ownerId.trim() : '';
        // Any key is made BEFORE the lock is read: from here on nothing awaits, so two lock calls
        // cannot both see "unlocked", and two link creations cannot both see 19 links.
        const k = ['lock', 'rotate-editor-key', 'create-editor-link', 'dev-legacy-key'].includes(op) ? await this.newEditorKey() : null;
        const l = this.lock;
        const no = (status, error) => Response.json({ ok: false, error }, { status });
        if (op === 'lock-status') {
            if (!this.state.id) return no(404, 'not-found');
            return Response.json({ locked: !!l, ownerId: l ? l.ownerId : null, plan: l ? l.plan : null, lockedAt: l ? l.lockedAt : null });
        }
        if (op === 'can-edit') {
            // For the Worker (create-view): may this caller change the calendar?
            if (!l || (!!body.userId && body.userId === l.ownerId)) return Response.json({ locked: !!l, canEdit: true });
            const link = await this.keyMatches(body.editorKey);
            if (link) this.touchLink(link);
            return Response.json({ locked: !!this.lock, canEdit: !this.lock || !!link });
        }
        if (op === 'set-view-id') {
            // The Worker's create-view, already authorized: records the new read-only link.
            const publicViewId = typeof body.publicViewId === 'string' ? body.publicViewId : '';
            if (!this.state.id) return no(404, 'not-found');
            if (!publicViewId || publicViewId.length > 200) return no(400, 'bad publicViewId');
            const s = this.state;
            if (s.options.publicViewId === publicViewId) return Response.json({ ok: true, unchanged: true });
            const beforeOptions = s.options;
            s.options = { ...s.options, publicViewId }; this.setMeta('options', s.options);
            this.bump('meta', [{ type: 'meta', options: { publicViewId } }], { beforeEvents: s.events, beforeTitle: s.title, beforeOptions });
            this.broadcast({ t: 'meta', v: s.v, title: s.title, options: s.options });
            await this.scheduleCopyBack();
            return Response.json({ ok: true, v: s.v });
        }
        if (op === 'unlock') {
            if (!l) return Response.json({ ok: true, alreadyUnlocked: true });
            if (ownerId && ownerId !== l.ownerId) return no(409, 'locked-by-other');
            this.sql.exec(`DELETE FROM lock`); this.lock = null;
            // Links are paused, not revoked: an unlocked calendar is editable by everyone anyway, and a
            // re-lock by the same owner turns them back on. A lock by anyone else revokes them.
            this.sql.exec(`UPDATE editor_links SET suspended_for = ? WHERE revoked_at IS NULL AND suspended_for IS NULL`, l.ownerId);
            for (const [id, link] of this.links) this.suspended.set(id, { ...link, suspendedFor: l.ownerId });
            this.links.clear();
            // Firebase kept its pre-lock copy, and anyone may have edited (or emptied) it since.
            // Merging that against the pre-lock baseline would replay those edits here, so the next
            // exchange adopts Firebase's copy as the baseline, applies none of it, and writes ours over it.
            this.setMeta('firebaseUntrusted', true);
            this.recordLockChange('unlocked', 'Unlocked');
            await this.scheduleCopyBack();
            return Response.json({ ok: true });
        }
        if (!ownerId || ownerId.length > 200) return no(400, 'ownerId required');
        if (op === 'lock') {
            if (!this.state.id) return no(404, 'not-found');
            if (l && l.ownerId !== ownerId) return no(409, 'locked-by-other');
            if (l && !body.rotate) return Response.json({ ok: true, alreadyLocked: true });   // only hashes are kept: no key to return
            if (l) return this.rotateKey(k);
            const plan = typeof body.plan === 'string' && body.plan ? body.plan.slice(0, 32) : 'pro';
            const at = Date.now();
            this.sql.exec(`INSERT INTO lock (k, owner, plan, locked_at, key_hash, key_id) VALUES (1, ?, ?, ?, NULL, NULL)`, ownerId, plan, at);
            this.lock = { ownerId, plan, lockedAt: at };
            this.revokeLinks([...this.links.keys()], null);            // none should be live; never inherit any
            // Paused links come back for the owner who paused them; anyone else's are revoked, and
            // tabs still holding them are told, so they forget the key.
            const stale = new Set();
            for (const [id, link] of this.suspended) {
                if (link.suspendedFor === ownerId) {
                    this.sql.exec(`UPDATE editor_links SET suspended_for = NULL WHERE id = ?`, id);
                    this.links.set(id, { ...link, suspendedFor: null });
                } else {
                    this.sql.exec(`UPDATE editor_links SET suspended_for = NULL, revoked_at = ? WHERE id = ?`, at, id);
                    stale.add(id);
                }
            }
            this.suspended.clear();
            if (stale.size) this.tellRevoked(stale, 'link-revoked');
            // Billing locks with createLink:false: there is no browser to show a key to, and the owner
            // makes links from the calendar. The admin route still gets one 'Editors' key.
            const made = body.createLink !== false && !this.links.size ? this.createLink('Editors', k) : null;
            this.recordLockChange('locked', 'Locked with Pro');
            // Claim this calendar's own name (and view link) in the directory now, so a case variant
            // registered earlier can't keep its lookups. (A name held by another LOCKED calendar stays.)
            this.ctx.waitUntil(this.registerInDirectory(this.state.id, false, null, true));
            if (this.state.options?.publicViewId) this.ctx.waitUntil(this.registerInDirectory(this.state.options.publicViewId, true, this.state.id, true));
            return Response.json({ ok: true, editorKey: made ? k.key : null, links: this.links.size });
        }
        // Everything below is owner-only, and only while locked.
        if (!l) return no(409, 'not-locked');
        if (l.ownerId !== ownerId) return no(403, 'not-owner');
        if (op === 'rotate-editor-key') return this.rotateKey(k);
        if (op === 'create-editor-link') {
            const label = CalendarRoom.cleanLabel(body.label);
            if (!label) return no(400, 'label must be 1-40 characters');
            if (this.links.size >= MAX_EDITOR_LINKS) return no(409, 'too-many-links');
            const link = this.createLink(label, k);
            return Response.json({ ok: true, id: link.id, label: link.label, createdAt: link.createdAt, editorKey: k.key });
        }
        if (op === 'list-editor-links') {
            const links = [...this.links.values()].map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
            return Response.json({ ok: true, links });
        }
        if (op === 'revoke-editor-link') {
            const id = typeof body.id === 'string' ? body.id : '';
            if (!this.links.has(id)) return no(404, 'no-link');
            this.revokeLinks([id], 'link-revoked');
            return Response.json({ ok: true });
        }
        if (op === 'set-pro-settings') {
            const cur = this.proStored && this.proStored.owner === l.ownerId ? this.proStored.settings : null;
            const r = mergeProSettings(cur, body.settings);
            if (!r.ok) return Response.json({ ok: false, error: 'bad-settings', message: r.error }, { status: 400 });
            const at = Date.now();
            this.sql.exec(`INSERT OR REPLACE INTO pro_settings (k, owner, data, updated_at) VALUES (1, ?, ?, ?)`, l.ownerId, json(r.settings), at);
            this.proStored = { owner: l.ownerId, settings: r.settings };
            this.broadcast({ t: 'pro', settings: r.settings });
            return Response.json({ ok: true, settings: r.settings });
        }
        if (op === 'dev-legacy-key' && this.env.ACCOUNTS_DEV_MODE === '1') {
            // Local tests only: put this lock back in the pre-links shape (one key in the lock row) and
            // reload, so the real migration in load() runs.
            this.sql.exec(`DELETE FROM editor_links`);
            this.sql.exec(`UPDATE lock SET key_hash = ?, key_id = ?`, k.keyHash, 'legacy-' + k.keyId);
            this.load();
            return Response.json({ ok: true, editorKey: k.key, keyId: 'legacy-' + k.keyId });
        }
        return no(404, 'not found');
    }
    // Every link is revoked and one new 'Editors' link made (the old single-key "rotate"). Sockets
    // that used any old link are told (reason 'key-rotated') and drop to read-only.
    rotateKey(k) {
        this.revokeLinks([...this.links.keys()], 'key-rotated');
        this.createLink('Editors', k);
        return Response.json({ ok: true, editorKey: k.key });
    }

    async registerInDirectory(actualSlug, isReadOnly = false, targetId = null, force = false) {
        if (!this.env.DIRECTORY || !actualSlug) return;
        try {
            const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('global'));
            // Never re-point a name that leads to a LOCKED calendar elsewhere. Registering is an
            // upsert, so without this anyone could create a calendar carrying a locked calendar's
            // publicViewId (it is in the view URL) and take over its /view/ link -- or create a
            // case variant of its name and take over the name's lookups.
            const target = targetId || actualSlug;
            // Fail closed: if we can't tell where the name leads now, or whether that calendar is locked,
            // leave the directory alone.
            const cur = await (await dir.fetch(`http://internal/lookup?slug=${encodeURIComponent(actualSlug)}`)).json().catch(() => null);
            if (!cur || typeof cur.found !== 'boolean') { console.warn(`[CalendarRoom] not registering ${actualSlug}: lookup unreadable`); return; }
            const curTarget = cur.found ? (cur.targetId || cur.actualSlug) : null;
            if (curTarget && curTarget !== target && this.env.CALENDARS) {
                const st = await this.env.CALENDARS.get(this.env.CALENDARS.idFromName(curTarget))
                    .fetch(`http://internal/cal/${encodeURIComponent(curTarget)}/lock-status`);
                const locked = st.ok ? (await st.json().catch(() => null))?.locked : st.status === 404 ? false : null;
                if (locked !== false) {
                    console.warn(`[CalendarRoom] not re-pointing ${actualSlug}: it leads to a ${locked ? 'locked' : 'possibly locked'} calendar`);
                    return;
                }
            }
            await dir.fetch('http://internal/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: json({
                    actualSlug,
                    isReadOnly: !!isReadOnly,
                    targetId: targetId || actualSlug,
                    ...(force ? { force: true } : {})
                })
            });
        } catch (e) {
            console.error(`[CalendarRoom] registerInDirectory failed for ${actualSlug}:`, e.message);
        }
    }

    recordAuthor(uid, isCreation = false) {
        if (!uid || typeof uid !== 'string') return;
        const cleanUid = uid.slice(0, 128);
        const now = Date.now();
        const today = new Date(now).toISOString().slice(0, 10);
        const rows = this.sql.exec(`SELECT first_seen, last_seen, edit_count, created_here, days FROM authors WHERE uid = ?`, cleanUid).toArray();
        if (!rows.length) {
            this.sql.exec(`INSERT INTO authors (uid, first_seen, last_seen, edit_count, created_here, days) VALUES (?, ?, ?, 1, ?, ?)`,
                cleanUid, now, now, isCreation ? 1 : 0, json([today]));
        } else {
            const r = rows[0];
            let days = [];
            try { days = JSON.parse(r.days); } catch {}
            if (!days.includes(today)) days.push(today);
            this.sql.exec(`UPDATE authors SET last_seen = ?, edit_count = edit_count + 1, days = ? WHERE uid = ?`,
                now, json(days), cleanUid);
        }
    }

    static sameEvent(a, b) {
        if (!a || !b) return false;
        const norm = (v) => (v === undefined || v === null || v === '') ? null : v;
        const FIELDS = ['title', 'description', 'start', 'end', 'type', 'isAllDay',
            'repeat', 'recurrencerule', 'recurrenceID', 'recurrenceException'];
        return FIELDS.every((f) => {
            const x = norm(a[f]), y = norm(b[f]);
            if (f === 'type') return String(x === null ? 1 : x) === String(y === null ? 1 : y);
            if (f === 'isAllDay') return !!x === !!y;
            return x === y;
        });
    }

    // Store a new event list: only the rows that changed are written.
    storeEvents(events, touched) {
        const keys = new Set(events.map(EventStore.keyOf));
        for (const e of this.state.events) {
            const k = EventStore.keyOf(e);
            if (!keys.has(k)) this.sql.exec(`DELETE FROM events WHERE k = ?`, k);
        }
        events.forEach((e, i) => {
            const k = EventStore.keyOf(e);
            if (touched === 'all' || touched.has(k) || this.state.events[i] !== e) {
                this.sql.exec(`INSERT OR REPLACE INTO events (k, pos, data) VALUES (?, ?, ?)`, k, i, json(e));
            }
        });
        this.state.events = events;
    }

    bump(source, commands, { beforeEvents, beforeTitle, beforeOptions, writer } = {}) {
        const s = this.state;
        s.v += 1;
        s.lastEditedAt = Date.now();
        this.setMeta('v', s.v);
        this.setMeta('lastEditedAt', s.lastEditedAt);
        if (this.env.BACKUPS) this.ctx.waitUntil(this.scheduleAlarm());   // every change is backed up (see backupToR2)

        const before = beforeEvents || [];
        const after = s.events;
        const keyOf = EventStore.keyOf;
        const beforeByKey = new Map(before.map((e) => [keyOf(e), e]));
        const afterByKey = new Map(after.map((e) => [keyOf(e), e]));
        const removedEvents = [], changedEvents = [];
        for (const e of before) {
            const x = afterByKey.get(keyOf(e));
            if (!x) removedEvents.push(e);
            else if (!CalendarRoom.sameEvent(x, e)) changedEvents.push({ from: e, to: x, at: s.lastEditedAt });
        }
        const addedEvents = after.filter((e) => !beforeByKey.has(keyOf(e)));

        const kind = (source === 'create' || !before.length) ? 'created'
            : (before.length > 0 && removedEvents.length === before.length) ? 'wiped'
            : removedEvents.length ? 'shrunk'
            : changedEvents.length ? 'edited'
            : addedEvents.length ? 'added'
            : (beforeTitle && !s.title) ? 'title-cleared'
            : 'edited';

        const entry = {
            savedAt: s.lastEditedAt,
            kind,
            removed: removedEvents.length,
            changed: changedEvents.length,
            added: addedEvents.length,
            removedEvents,
            changedEvents,
            addedEvents,
            eventCount: before.length,
            title: beforeTitle ?? s.title ?? null,
            options: beforeOptions ?? s.options ?? null,
            writer: writer || null,
        };
        if (kind === 'shrunk' || kind === 'title-cleared') entry.events = before;

        this.sql.exec(`INSERT INTO history (v, at, source, commands, entry) VALUES (?, ?, ?, ?, ?)`,
            s.v, s.lastEditedAt, source, json(commands), json(entry));
        this.sql.exec(`DELETE FROM history WHERE v NOT IN (SELECT v FROM history ORDER BY v DESC LIMIT 50)`);
    }

    // ---- limits ---------------------------------------------------------------------------
    overRate(ws) {
        const now = Date.now();
        this.saves = this.saves.filter((t) => now - t < 60000);
        if (this.saves.length >= LIMITS.savesPerMinute) return 'this calendar is saving too often';
        const tab = ws.deserializeAttachment() || {};
        const mine = (tab.saves || []).filter((t) => now - t < 60000);
        if (mine.length >= LIMITS.savesPerMinutePerTab) return 'this tab is saving too often';
        mine.push(now); this.saves.push(now);
        ws.serializeAttachment({ ...tab, saves: mine });
        return null;
    }
    tooBig(events) {
        if (events.length > LIMITS.maxEvents) return `more than ${LIMITS.maxEvents} events`;
        for (const e of events) {
            if ((e.title || '').length > LIMITS.maxTitle) return 'an event title is too long';
            for (const f of ['description', 'recurrenceException', 'recurrencerule']) {
                if ((e[f] || '').length > LIMITS.maxField) return `an event ${f} is too long`;
            }
        }
        return null;
    }

    // ---- HTTP: WebSocket upgrade, snapshot, import -----------------------------------------
    async fetch(request) {
        const url = new URL(request.url);
        const viewId = url.searchParams.get('view') || request.headers.get('X-View-Id');
        const isViewOnly = !!viewId;
        // /cal/<id>[/<suffix>], matched exactly. endsWith('/import') also matched a calendar NAMED
        // "import" (PUT /cal/import replaced it with no secret), and would do the same for "lock".
        const [, , , suffix = '', ...rest] = url.pathname.split('/');
        if (rest.length) return new Response('not found', { status: 404 });
        if (LOCK_ROUTES.has(suffix)) {
            // Only Worker code calls these (stub.fetch('http://internal/...')). Public requests are
            // forwarded with their real host, and the Worker's allowlist never forwards these
            // suffixes; read-only view forwards use the internal host but always carry ?view=.
            if (url.hostname !== 'internal' || isViewOnly) return new Response('not found', { status: 404 });
            return this.lockRoute(suffix, request);
        }
        if (request.headers.get('Upgrade') === 'websocket') {
            const [client, server] = Object.values(new WebSocketPair());
            this.ctx.acceptWebSocket(server);
            const author = url.searchParams.get('author');
            // X-PC-User is trusted: the Worker deletes any a client sent and sets it from a session.
            const att = { saves: [], isViewOnly, viewId, author, user: isViewOnly ? null : request.headers.get('X-PC-User') || null };
            server.serializeAttachment(att);
            if (author && this.canWrite(att)) this.recordAuthor(author, false);
            server.send(json(this.snapshotFor(att)));
            return new Response(null, { status: 101, webSocket: client });
        }
        if (request.method === 'POST' && suffix === 'archive') return Response.json(await this.archiveTestCalendar());
        if (request.method === 'HEAD') return new Response(null, { status: this.state.id ? 200 : 404 });
        if (request.method === 'GET') {
            if (suffix === 'history') {
                const rows = this.sql.exec(`SELECT v, at, source, commands, entry FROM history ORDER BY v DESC LIMIT 20`).toArray();
                const entries = rows.map((r) => {
                    if (r.entry) {
                        try {
                            const parsed = JSON.parse(r.entry);
                            return { key: String(r.v), ...parsed };
                        } catch {}
                    }
                    return {
                        key: String(r.v),
                        savedAt: r.at,
                        kind: r.source || 'edited',
                        commands: r.commands ? JSON.parse(r.commands) : [],
                    };
                });
                return Response.json(entries);
            }
            if (suffix === 'authors') {
                const rows = this.sql.exec(`SELECT uid, first_seen, last_seen, edit_count, created_here, days FROM authors`).toArray();
                const authors = rows.map((r) => ({
                    uid: r.uid,
                    firstSeen: r.first_seen,
                    lastSeen: r.last_seen,
                    editCount: r.edit_count,
                    createdHere: !!r.created_here,
                    days: (() => { try { return JSON.parse(r.days); } catch { return []; } })(),
                }));
                authors.sort((a, b) => {
                    if (a.createdHere !== b.createdHere) return b.createdHere ? 1 : -1;
                    if (a.days.length !== b.days.length) return b.days.length - a.days.length;
                    if (a.firstSeen !== b.firstSeen) return a.firstSeen - b.firstSeen;
                    return b.editCount - a.editCount;
                });
                return Response.json(authors);
            }
            if (!this.state.id) return Response.json({ error: 'not found' }, { status: 404 });
            const cal = isViewOnly ? this.viewCalendar(viewId) : this.calendar();
            return Response.json({ v: this.state.v, calendar: cal, locked: !!this.lock, pro: !!this.lock, proSettings: this.proSettings() });
        }
        if (request.method === 'POST' && suffix === '') {
            const text = await request.text();
            if (text.length > LIMITS.maxCreate) return Response.json({ ok: false, error: 'too big' }, { status: 413 });
            let cal; try { cal = JSON.parse(text); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
            let id; try { id = decodeURIComponent(url.pathname.split('/')[2]); } catch { id = null; }
            const r = this.createCalendar(id, cal);
            if (r.ok) await this.scheduleCopyBack();
            return Response.json(r, { status: r.ok ? 201 : r.status });
        }
        if (request.method === 'PUT' && suffix === 'import') {
            // Whole-calendar replace: the Firebase shadow copy, and the one-time load.
            const cal = await request.json();
            const r = this.importCalendar(cal);
            return Response.json(r, { status: r.status || 200 });
        }
        if (request.method === 'PUT' && suffix === 'from-firebase') {
            // A live Firebase write: merged onto the current state, never a blind replace.
            // Locked: refused with ok:false and an error, which the Firebase function logs and does not retry.
            const r = this.fromFirebase(await request.json());
            return Response.json(r, { status: r.status || 200 });
        }
        return new Response('not found', { status: 404 });
    }

    // Old calendars can hold two events with the same id (13 did, Sep 27). Keys must be
    // unique here, so a repeat gets a new id -- reported, never silently merged away. The new
    // id is derived (id~2, id~3), not random, so the same Firebase state always dedupes to the
    // same list and replaying it is recognized as "nothing changed".
    // Stored exactly as they are -- not normalized: a copy must be a copy (the dry run
    // caught normalize trimming "James " to "James" in a real calendar).
    dedupe(cal) {
        const raw = Array.isArray(cal.events) ? cal.events : Object.values(cal.events || {});
        const seen = new Set(); let renamed = 0;
        const events = raw.filter(Boolean).map((e) => {
            const n = { ...e };
            for (let i = 2; seen.has(EventStore.keyOf(n)); i++) { n.id = `${e.id}~${i}`; if (i === 2) renamed++; }
            seen.add(EventStore.keyOf(n));
            return n;
        });
        return { events, renamed };
    }

    // `mirrored` is the last state exchanged with Firebase: the baseline that tells "Firebase
    // changed this" from "only Cloudflare has this", so a Firebase write never erases an edit
    // made here.
    setMirrored(title, options, events) { this.mirrored = { title, options, events }; this.setMeta('mirrored', this.mirrored); }

    // First save of a new calendar, from a browser. Only into an EMPTY room: an existing
    // calendar can never be replaced this way (that is what /import is for, with a secret).
    // Events go through the same `add` rule as every other save, so they are validated and
    // normalized identically, and each must carry the id the tab chose.
    createCalendar(id, cal) {
        if (this.state.id) return { ok: false, status: 409, error: 'already exists' };
        if (!cal || typeof cal !== 'object') return { ok: false, status: 400, error: 'bad calendar' };
        const title = cal.title ?? '';
        if (typeof title !== 'string' || title.length > LIMITS.maxTitle) return { ok: false, status: 400, error: 'bad title' };
        const options = clientOptions(cal.options ?? {});
        if (typeof options !== 'object' || Array.isArray(options) || json(options).length > LIMITS.maxField * 5) {
            return { ok: false, status: 400, error: 'bad options' };
        }
        const raw = (Array.isArray(cal.events) ? cal.events : Object.values(cal.events || {})).filter(Boolean);
        if (raw.some((e) => e.id === undefined || e.id === null || e.id === '')) return { ok: false, status: 400, error: 'a new event needs an id' };
        let events;
        try { events = EventStore.apply([], { type: 'batch', commands: raw.map((event) => ({ type: 'add', event })) }).events; }
        catch (e) { return { ok: false, status: 400, error: e.message }; }
        if (cal.author) this.recordAuthor(cal.author, true);
        const r = this.importCalendar({ id, title, options, events }, 'create');
        if (r.ok) {
            this.ctx.waitUntil(this.registerInDirectory(id));
            if (options?.publicViewId) this.ctx.waitUntil(this.registerInDirectory(options.publicViewId, true, id));
        }
        return r.ok ? { ...r, calendar: this.calendar() } : { ...r, status: 413 };
    }

    importCalendar(cal, source = 'import') {
        // A locked calendar is replaced by no one: /import is the Firebase shadow, and Firebase is world-writable.
        if (this.lock) return { ok: false, status: 423, error: 'locked' };
        cal = { ...cal, options: clientOptions(cal.options) };
        const { events, renamed } = this.dedupe(cal);
        const why = this.tooBig(events);
        if (why) return { ok: false, error: why };
        // Identical to what is stored: do nothing. This is what stops a two-way copy with
        // Firebase from bouncing one write back and forth forever (the Sep 26 shape).
        const s = this.state, title = cal.title ?? '', options = cal.options || {};
        if (s.id === cal.id && s.title === title && json(s.options) === json(options) && json(s.events) === json(events)) {
            this.setMirrored(title, options, events);
            return { ok: true, unchanged: true, v: s.v, events: events.length, renamedDuplicates: renamed };
        }
        const beforeEvents = s.events;
        const beforeTitle = s.title;
        const beforeOptions = s.options;
        this.sql.exec(`DELETE FROM events`);
        this.state.events = [];
        this.storeEvents(events, 'all');
        this.state.id = cal.id; this.state.title = title; this.state.options = options;
        this.setMeta('id', cal.id); this.setMeta('title', title); this.setMeta('options', options);
        this.setMirrored(title, options, events);
        this.bump(source, [{ type: source, events: events.length }], { beforeEvents, beforeTitle, beforeOptions });
        this.ctx.waitUntil(this.registerInDirectory(cal.id));
        if (options?.publicViewId) this.ctx.waitUntil(this.registerInDirectory(options.publicViewId, true, cal.id));
        this.broadcast({ t: 'snapshot', v: this.state.v, calendar: this.calendar() });
        return { ok: true, v: this.state.v, events: events.length, renamedDuplicates: renamed };
    }

    // A Firebase write, merged onto the CURRENT state. Only what Firebase changed since the
    // last exchange (`mirrored`) is applied; rows and fields that only Cloudflare touched stay.
    // Rate limits do not apply (this is one server copying, not a tab); size limits do.
    // Values are copied raw, never normalized (see dedupe).
    fromFirebase(cal) {
        const s = this.state;
        if (this.lock) return { ok: false, status: 423, error: 'locked' };   // Firebase is world-writable: no bypass through it
        if (!s.id) return this.importCalendar(cal);                      // first sight: a plain copy
        cal = { ...cal, options: clientOptions(cal.options) };
        const { events: incoming, renamed } = this.dedupe(cal);
        if (this.sql.exec(`SELECT 1 FROM meta WHERE k = 'firebaseUntrusted'`).toArray().length) {
            // First exchange since an unlock (see lockRoute): Firebase's copy becomes the baseline and
            // nothing of it is applied; the copy-back then writes this calendar over it.
            this.setMirrored(cal.title ?? '', cal.options || {}, incoming);
            this.sql.exec(`DELETE FROM meta WHERE k = 'firebaseUntrusted'`);
            this.ctx.waitUntil(this.scheduleCopyBack());
            return { ok: true, unchanged: true, untrusted: true, v: s.v, events: s.events.length, renamedDuplicates: renamed };
        }
        const title = cal.title ?? '', options = cal.options || {};
        // Rooms imported before `mirrored` existed: the import is the baseline.
        const m = this.mirrored || { title: s.title, options: s.options, events: s.events };
        const done = (extra) => ({ ok: true, events: this.state.events.length, renamedDuplicates: renamed, ...extra });

        const before = new Map(m.events.map((e) => [EventStore.keyOf(e), e]));
        const commands = [];
        const seen = new Set();
        for (const e of incoming) {
            const k = EventStore.keyOf(e); seen.add(k);
            const was = before.get(k);
            if (!was) commands.push({ type: 'add', event: e, restoreId: true });
            else {
                const changes = {};
                for (const f of new Set([...Object.keys(was), ...Object.keys(e)])) if (json(was[f]) !== json(e[f])) changes[f] = e[f] === undefined ? null : e[f];
                if (Object.keys(changes).length) commands.push({ type: 'update', key: k, changes, raw: e });
            }
        }
        for (const k of before.keys()) if (!seen.has(k)) commands.push({ type: 'remove', key: k });

        // Apply onto the current list.
        const index = new Map(s.events.map((e, i) => [EventStore.keyOf(e), i]));
        let list = s.events.map((e) => e); const touched = new Set(); const applied = [];
        for (const c of commands) {
            if (c.type === 'add') {
                const k = EventStore.keyOf(c.event);
                if (index.has(k)) { list[index.get(k)] = c.event; applied.push({ type: 'update', key: k, changes: c.event }); }   // same id made here too: Firebase's wins
                else { index.set(k, list.length); list.push(c.event); applied.push({ type: 'add', event: c.event, restoreId: true }); }
                touched.add(k);
            } else if (c.type === 'update') {
                const i = index.get(c.key); if (i === undefined) continue;          // deleted here since: the delete stands
                const row = { ...list[i] };
                for (const [f, v] of Object.entries(c.changes)) { if (v === null && !(f in c.raw)) delete row[f]; else row[f] = v; }
                if (json(row) === json(list[i])) continue;
                list[i] = row; touched.add(c.key); applied.push({ type: 'update', key: c.key, changes: c.changes });
            } else {
                const i = index.get(c.key); if (i === undefined) continue;          // already gone here
                list = list.filter((_, j) => j !== i); index.clear(); list.forEach((e, j) => index.set(EventStore.keyOf(e), j));
                applied.push({ type: 'remove', key: c.key });
            }
        }
        const nextTitle = title !== m.title && title !== s.title ? title : s.title;
        const nextOptions = { ...s.options };
        for (const k of new Set([...Object.keys(m.options), ...Object.keys(options)])) {
            if (json(m.options[k]) === json(options[k])) continue;
            if (options[k] === undefined) delete nextOptions[k]; else nextOptions[k] = options[k];
        }
        const metaChanged = nextTitle !== s.title || json(nextOptions) !== json(s.options);

        if (!applied.length && !metaChanged) {
            this.setMirrored(title, options, incoming);
            return done({ unchanged: true, v: s.v });
        }
        const why = this.tooBig(list) || (nextTitle.length > LIMITS.maxTitle ? 'title too long' : null);
        if (why) return { ok: false, error: why };                             // nothing stored
        const beforeEvents = s.events;
        const beforeTitle = s.title;
        const beforeOptions = s.options;
        if (nextTitle !== s.title) { s.title = nextTitle; this.setMeta('title', nextTitle); }
        if (json(nextOptions) !== json(s.options)) { s.options = nextOptions; this.setMeta('options', nextOptions); }
        if (applied.length) this.storeEvents(list, touched);
        this.setMirrored(title, options, incoming);
        this.bump('firebase', applied.length ? applied : [{ type: 'meta' }], { beforeEvents, beforeTitle, beforeOptions });
        if (applied.length) this.broadcast({ t: 'change', v: s.v, commands: applied });
        if (metaChanged) this.broadcast({ t: 'meta', v: s.v, title: s.title, options: s.options });
        return done({ v: s.v });
    }


    // ---- copy back to Firebase ------------------------------------------------------------
    // While pastecal.com still runs on Firebase, a save made here must reach it. A few seconds
    // after the last save (one Durable Object alarm, so a burst is ONE write) the room:
    //   1. reads Firebase's copy with its ETag and merges anything new from it (fromFirebase),
    //   2. writes the current calendar back, only if the ETag still matches (a pc.com tab that
    //      wrote in between makes it retry from step 1, as the browsers do themselves).
    // `mirrored` is set to the intended state BEFORE the write, so when Firebase's function
    // sends that same state back it finds nothing new and stores nothing -- no ping-pong.
    // Off unless COPY_BACK (comma list: "kalid", "test-*", "*") names the calendar, and unless
    // there is somewhere to write: FIREBASE_DB_URL, plus FIREBASE_SA (a service account key)
    // for the real database.
    copyBackAllowed() {
        const id = this.state.id, list = String(this.env.COPY_BACK || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!id || !this.env.FIREBASE_DB_URL) return false;
        // Locked calendars stop mirroring to Firebase: anyone can write there, and its edits are
        // refused here anyway (fromFirebase). Covers both scheduling and the alarm itself.
        if (this.lock) return false;
        if (!this.firebaseLocal() && !this.env.FIREBASE_SA) return false;
        return list.some((p) => p === '*' || (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p));
    }
    firebaseLocal() { return /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(this.env.FIREBASE_DB_URL || ''); }

    async scheduleCopyBack() {
        if (!this.copyBackAllowed()) return;
        await this.scheduleAlarm();
    }
    // One alarm a few seconds after the last change runs both the backup and the copy-back, so a
    // burst of saves is one of each.
    async scheduleAlarm() {
        if (await this.ctx.storage.getAlarm() == null) await this.ctx.storage.setAlarm(Date.now() + LIMITS.copyBackDelayMs);
    }

    // ---- archiving test calendars ---------------------------------------------------------
    // Automated tests used to create calendars on the live site (4,000+ by Oct 2026). This takes one
    // out of service: its full state is written to R2 FIRST, and only once that write succeeded is
    // the calendar emptied and its name dropped from the directory. Only names starting "test" are
    // accepted, so even a leaked secret cannot archive a real calendar this way.
    async archiveTestCalendar() {
        const s = this.state;
        if (!s.id) return { ok: true, missing: true };
        if (!/^test/i.test(s.id)) return { ok: false, error: 'only test calendars can be archived' };
        if (!this.env.BACKUPS) return { ok: false, error: 'no backup bucket' };
        const id = s.id;
        await this.env.BACKUPS.put(`archive/test-calendars/${encodeURIComponent(id)}.json`,
            json({ archivedAt: new Date().toISOString(), v: s.v, calendar: this.calendar() }),
            { httpMetadata: { contentType: 'application/json' }, customMetadata: { id } });
        for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'archived'); } catch { /* gone */ } }
        await this.ctx.storage.deleteAlarm();
        this.sql.exec('DELETE FROM events'); this.sql.exec('DELETE FROM meta'); this.sql.exec('DELETE FROM history'); this.sql.exec('DELETE FROM lock');
        this.sql.exec('DELETE FROM editor_links'); this.sql.exec('DELETE FROM pro_settings');
        this.mirrored = null;
        this.load();                                                    // now empty: GET answers 404
        if (this.env.DIRECTORY) {
            const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('global'));
            await dir.fetch('http://internal/remove', { method: 'POST', body: json({ slug: id, actualSlug: id }) }).catch(() => {});
        }
        return { ok: true, archived: id };
    }

    // ---- backups --------------------------------------------------------------------------
    // Each calendar backs itself up: after a change, its full state goes to R2 at
    // snapshots/<encoded id>/<UTC date>.json -- one object per calendar per day it changed (a later
    // change that day overwrites it). No cron and no list of calendars to walk: the old nightly job
    // that read every calendar in one run never completed once (Oct 2026). A calendar nobody edits
    // never changes, so its newest snapshot (or the last full snapshot) stays valid.
    async backupToR2() {
        const s = this.state;
        if (!this.env.BACKUPS || !s.id) return;
        const key = `snapshots/${encodeURIComponent(s.id)}/${new Date().toISOString().slice(0, 10)}.json`;
        await this.env.BACKUPS.put(key, json({ v: s.v, savedAt: new Date().toISOString(), calendar: this.calendar() }), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { id: s.id, v: String(s.v) },
        });
    }

    async firebaseToken() {
        if (this.firebaseLocal()) return null;
        if (this.token && this.token.exp > Date.now() + 60000) return this.token.value;
        const sa = JSON.parse(this.env.FIREBASE_SA);
        const b64 = (x) => btoa(typeof x === 'string' ? x : String.fromCharCode(...new Uint8Array(x))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const now = Math.floor(Date.now() / 1000);
        const head = b64(json({ alg: 'RS256', typ: 'JWT' }));
        const claim = b64(json({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
        const pem = sa.private_key.replace(/-----[A-Z ]+-----|\s/g, '');
        const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
        const sig = b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claim}`)));
        const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}` });
        const out = await res.json();
        if (!out.access_token) throw new Error(`no Firebase token: ${out.error || res.status}`);
        this.token = { value: out.access_token, exp: Date.now() + (out.expires_in || 3600) * 1000 };
        return this.token.value;
    }

    async firebaseFetch(id, init = {}) {
        const token = await this.firebaseToken();
        const headers = { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        return fetch(`${this.env.FIREBASE_DB_URL}/calendars/${encodeURIComponent(id)}.json`, { ...init, headers, signal: AbortSignal.timeout(15000) });
    }

    // Undefined has no meaning in Firebase; the browsers write null (CalendarDataService._sanitizeForFirebase).
    static forFirebase(v) { return JSON.parse(JSON.stringify(v, (k, x) => (x === undefined ? null : x))); }

    async alarm() {
        const id = this.state.id;
        // Separate from the copy-back: a failed backup must not stop it, nor the reverse.
        try { await this.backupToR2(); }
        catch (e) { console.error(`backup FAILED for ${id}: ${e.message}`); await this.ctx.storage.setAlarm(Date.now() + 60000); }   // try again
        if (!id || !this.copyBackAllowed()) return;
        try {
            for (let attempt = 1; attempt <= 4; attempt++) {
                const got = await this.firebaseFetch(id, { headers: { 'X-Firebase-ETag': 'true' } });
                if (!got.ok) throw new Error(`read HTTP ${got.status}`);
                const etag = got.headers.get('ETag'), remote = await got.json();
                if (remote && typeof remote === 'object') {
                    const merged = this.fromFirebase(remote);                   // Firebase's newer edits first
                    if (!merged.ok) throw new Error(`merge refused: ${merged.error}`);
                }
                const s = this.state, m = this.mirrored;
                // Firebase has no copy yet (a calendar born here): always write. Otherwise skip if nothing differs.
                if (remote && m && m.title === s.title && json(m.options) === json(s.options) && json(m.events) === json(s.events)) return;
                const body = CalendarRoom.forFirebase({ ...(remote && typeof remote === 'object' ? remote : {}), id: s.id, title: s.title, options: s.options, events: s.events, lastEditedAt: s.lastEditedAt });
                const before = this.mirrored;
                this.setMirrored(s.title, s.options, s.events);                  // BEFORE the write: see above
                const put = await this.firebaseFetch(id, { method: 'PUT', body: json(body), headers: { 'If-Match': etag || 'null_etag' } });
                if (put.ok) return;
                this.mirrored = before; this.setMeta('mirrored', before);
                if (put.status !== 412) throw new Error(`write HTTP ${put.status}`);
            }
            throw new Error('Firebase kept changing; gave up after 4 tries');
        } catch (e) {
            console.error(`copyBack FAILED for ${id}: ${e.message}`);
            await this.ctx.storage.setAlarm(Date.now() + 30000);                // try again; the state is safe here meanwhile
        }
    }

    // ---- WebSocket messages ---------------------------------------------------------------
    async webSocketMessage(ws, message) {
        if (typeof message !== 'string' || message.length > LIMITS.maxMessage) {
            return ws.send(json({ t: 'error', code: 'too_big', message: 'message too large' }));
        }
        let m; try { m = JSON.parse(message); } catch { return ws.send(json({ t: 'error', code: 'bad_json' })); }
        const refuse = (code, message) => ws.send(json({ t: 'error', id: m.id, code, message }));

        const tab = ws.deserializeAttachment() || {};
        if (tab.isViewOnly && (m.t === 'save' || m.t === 'meta')) {
            return refuse('read_only', 'this link is read-only');
        }
        // Before the rate limit and author tally: a refused tab must not use up the calendar's
        // shared save budget (that would lock out the owner) or count as an author.
        if ((m.t === 'save' || m.t === 'meta') && !this.canWrite(tab)) {
            return refuse('locked', 'This calendar is locked. Only its owner and people with an editor key can change it.');
        }
        if (m.t === 'auth') {
            // An editor link's key, sent over the socket: never in a URL, which logs and analytics record.
            const link = tab.isViewOnly ? null : await this.keyMatches(m.key);
            // A key revoked earlier (while this tab was closed) says so, so the tab forgets it.
            const revoked = !link && !tab.isViewOnly && this.lock ? await this.keyRevoked(m.key) : false;
            let next = ws.deserializeAttachment() || {};                  // re-read: the await may have let other messages in
            if (link) { next = { ...next, keyId: link.id }; ws.serializeAttachment(next); this.touchLink(link); }
            return ws.send(json({ t: 'auth', ok: !!link, locked: !!this.lock, canEdit: this.canWrite(next), role: this.roleOf(next), ...(revoked ? { reason: 'link-revoked' } : {}) }));
        }

        const author = m.author || tab.author;
        if (author && this.canWrite(tab)) this.recordAuthor(author, false);

        if (m.t === 'save' || m.t === 'meta') {
            const rate = this.overRate(ws);
            if (rate) return refuse('rate_limited', rate);
        }
        if (m.t === 'save') {
            // The tab picks the id of an event it creates. If the server picked one, the tab's
            // own copy and the server's would hold the same event under different ids.
            const adds = (cs) => (cs || []).flatMap((c) => (c.type === 'batch' ? adds(c.commands) : c.type === 'add' ? [c] : []));
            if (adds(m.commands).some((c) => !c.event || c.event.id === undefined || c.event.id === null || c.event.id === '')) {
                return refuse('bad_command', 'a new event needs an id');
            }
            let result;
            try { result = EventStore.apply(this.state.events, { type: 'batch', commands: m.commands || [] }); }
            catch (e) { return refuse('bad_command', e.message); }
            // Nothing changed: store nothing, tell no one. (An echo can never loop.)
            if (!result.added.length && !result.changed.length && !result.removed.length) {
                return ws.send(json({ t: 'ack', id: m.id, v: this.state.v, unchanged: true }));
            }
            const why = this.tooBig(result.events);
            if (why) return refuse('too_big', why);
            const beforeEvents = this.state.events;
            const beforeTitle = this.state.title;
            const beforeOptions = this.state.options;
            const touched = new Set([...result.added, ...result.changed].map(EventStore.keyOf));
            this.storeEvents(result.events, touched);
            this.bump('save', m.commands, { beforeEvents, beforeTitle, beforeOptions, writer: m.writer || author });
            ws.send(json({ t: 'ack', id: m.id, v: this.state.v }));
            this.broadcast({ t: 'change', v: this.state.v, commands: m.commands }, ws);
            await this.scheduleCopyBack();
            return;
        }
        if (m.t === 'meta') {
            const s = this.state; let changed = false;
            const beforeEvents = s.events;
            const beforeTitle = s.title;
            const beforeOptions = s.options;
            if (typeof m.title === 'string' && m.title !== s.title) {
                if (m.title.length > LIMITS.maxTitle) return refuse('too_big', 'title too long');
                s.title = m.title; this.setMeta('title', s.title); changed = true;
            }
            if (m.options && typeof m.options === 'object') {
                const next = { ...s.options, ...clientOptions(m.options) };   // keys merge (publicViewId survives)
                if (json(next).length > LIMITS.maxField * 5) return refuse('too_big', 'settings too large');
                if (json(next) !== json(s.options)) { s.options = next; this.setMeta('options', next); changed = true; }
            }
            if (!changed) return ws.send(json({ t: 'ack', id: m.id, v: s.v, unchanged: true }));
            this.bump('meta', [{ type: 'meta', title: m.title, options: m.options }], { beforeEvents, beforeTitle, beforeOptions, writer: m.writer || author });
            ws.send(json({ t: 'ack', id: m.id, v: s.v }));
            this.broadcast({ t: 'meta', v: s.v, title: s.title, options: s.options }, ws);
            await this.scheduleCopyBack();
            return;
        }
        if (m.t === 'hello') {
            // A reconnecting tab says which version it has; the snapshot was already sent on
            // connect, so this is only for the future "changes since v" optimization.
            return ws.send(json(this.snapshotFor(tab)));
        }
        refuse('unknown', `unknown message ${m.t}`);
    }

    // Answer the close. A tab that calls close() with no code arrives as 1005, which is not a code
    // close() accepts: it threw, so the close was never answered and the tab sat in CLOSING.
    webSocketClose(ws, code) {
        const ok = code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code);
        try { ws.close(ok ? code : 1000, 'bye'); } catch { /* already closed */ }
    }

    broadcast(msg, except) {
        for (const s of this.ctx.getWebSockets()) {
            if (s === except) continue;
            try {
                const att = s.deserializeAttachment() || {};
                if (msg.t === 'snapshot') {
                    s.send(json(this.snapshotFor(att)));                // per tab: view copy, canEdit
                } else if (att.isViewOnly) {
                    if (msg.t === 'meta') {
                        const options = { ...(msg.options || {}) };
                        delete options.publicViewId;
                        s.send(json({ ...msg, options }));
                    } else {
                        s.send(json(msg));
                    }
                } else {
                    s.send(json(msg));
                }
            } catch { /* gone */ }
        }
    }
}
