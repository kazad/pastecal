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
 *                   {t:'error', id, code, message}        refused; nothing was stored
 *
 * HTTP: GET /cal/<id> the calendar (404 = no such calendar); HEAD /cal/<id> same, no body;
 * POST /cal/<id> creates the calendar from {title, options, events} -- ONLY when the room
 * is empty (409 otherwise), names and events validated, size-limited (the Worker also
 * rate-limits it per IP). PUT /cal/<id>/import replaces everything (secret required).
 *
 * Storage (this object's own SQLite): meta(k, v), events(k, pos, data), history(v, at,
 * source, commands).
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
    maxCreate: 1024 * 1024,      // the body of a first save (POST /cal/<id>)
};

const json = (x) => JSON.stringify(x);

export class CalendarRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.saves = [];             // times of recent saves (memory: resets on hibernation, which only happens when idle)
        ctx.blockConcurrencyWhile(async () => {
            this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS events (k TEXT PRIMARY KEY, pos INTEGER, data TEXT)`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS history (v INTEGER PRIMARY KEY, at INTEGER, source TEXT, commands TEXT)`);
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
    }
    setMeta(k, v) { this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, json(v)); }
    calendar() {
        const s = this.state;
        return { id: s.id, title: s.title, options: s.options, lastEditedAt: s.lastEditedAt, events: s.events };
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

    bump(source, commands) {
        const s = this.state;
        s.v += 1;
        s.lastEditedAt = Date.now();
        this.setMeta('v', s.v);
        this.setMeta('lastEditedAt', s.lastEditedAt);
        this.sql.exec(`INSERT INTO history (v, at, source, commands) VALUES (?, ?, ?, ?)`, s.v, s.lastEditedAt, source, json(commands));
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
        if (request.headers.get('Upgrade') === 'websocket') {
            const [client, server] = Object.values(new WebSocketPair());
            this.ctx.acceptWebSocket(server);
            server.serializeAttachment({ saves: [] });
            server.send(json({ t: 'snapshot', v: this.state.v, calendar: this.calendar() }));
            return new Response(null, { status: 101, webSocket: client });
        }
        if (request.method === 'HEAD') return new Response(null, { status: this.state.id ? 200 : 404 });
        if (request.method === 'GET') {
            if (!this.state.id) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json({ v: this.state.v, calendar: this.calendar() });
        }
        if (request.method === 'POST' && !url.pathname.endsWith('/import')) {
            const text = await request.text();
            if (text.length > LIMITS.maxCreate) return Response.json({ ok: false, error: 'too big' }, { status: 413 });
            let cal; try { cal = JSON.parse(text); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
            let id; try { id = decodeURIComponent(url.pathname.split('/')[2]); } catch { id = null; }
            const r = this.createCalendar(id, cal);
            return Response.json(r, { status: r.ok ? 201 : r.status });
        }
        if (request.method === 'PUT' && url.pathname.endsWith('/import')) {
            // Whole-calendar replace: the Firebase shadow copy, and the one-time load.
            const cal = await request.json();
            return Response.json(this.importCalendar(cal));
        }
        if (request.method === 'PUT' && url.pathname.endsWith('/from-firebase')) {
            // A live Firebase write: merged onto the current state, never a blind replace.
            return Response.json(this.fromFirebase(await request.json()));
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
        const options = cal.options ?? {};
        if (typeof options !== 'object' || Array.isArray(options) || json(options).length > LIMITS.maxField * 5) {
            return { ok: false, status: 400, error: 'bad options' };
        }
        const raw = (Array.isArray(cal.events) ? cal.events : Object.values(cal.events || {})).filter(Boolean);
        if (raw.some((e) => e.id === undefined || e.id === null || e.id === '')) return { ok: false, status: 400, error: 'a new event needs an id' };
        let events;
        try { events = EventStore.apply([], { type: 'batch', commands: raw.map((event) => ({ type: 'add', event })) }).events; }
        catch (e) { return { ok: false, status: 400, error: e.message }; }
        const r = this.importCalendar({ id, title, options, events }, 'create');
        return r.ok ? { ...r, calendar: this.calendar() } : { ...r, status: 413 };
    }

    importCalendar(cal, source = 'import') {
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
        this.sql.exec(`DELETE FROM events`);
        this.state.events = [];
        this.storeEvents(events, 'all');
        this.state.id = cal.id; this.state.title = title; this.state.options = options;
        this.setMeta('id', cal.id); this.setMeta('title', title); this.setMeta('options', options);
        this.setMirrored(title, options, events);
        this.bump(source, [{ type: source, events: events.length }]);
        this.broadcast({ t: 'snapshot', v: this.state.v, calendar: this.calendar() });
        return { ok: true, v: this.state.v, events: events.length, renamedDuplicates: renamed };
    }

    // A Firebase write, merged onto the CURRENT state. Only what Firebase changed since the
    // last exchange (`mirrored`) is applied; rows and fields that only Cloudflare touched stay.
    // Rate limits do not apply (this is one server copying, not a tab); size limits do.
    // Values are copied raw, never normalized (see dedupe).
    fromFirebase(cal) {
        const s = this.state;
        if (!s.id) return this.importCalendar(cal);                      // first sight: a plain copy
        const { events: incoming, renamed } = this.dedupe(cal);
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
        if (nextTitle !== s.title) { s.title = nextTitle; this.setMeta('title', nextTitle); }
        if (json(nextOptions) !== json(s.options)) { s.options = nextOptions; this.setMeta('options', nextOptions); }
        if (applied.length) this.storeEvents(list, touched);
        this.setMirrored(title, options, incoming);
        this.bump('firebase', applied.length ? applied : [{ type: 'meta' }]);
        if (applied.length) this.broadcast({ t: 'change', v: s.v, commands: applied });
        if (metaChanged) this.broadcast({ t: 'meta', v: s.v, title: s.title, options: s.options });
        return done({ v: s.v });
    }

    // ---- WebSocket messages ---------------------------------------------------------------
    async webSocketMessage(ws, message) {
        if (typeof message !== 'string' || message.length > LIMITS.maxMessage) {
            return ws.send(json({ t: 'error', code: 'too_big', message: 'message too large' }));
        }
        let m; try { m = JSON.parse(message); } catch { return ws.send(json({ t: 'error', code: 'bad_json' })); }
        const refuse = (code, message) => ws.send(json({ t: 'error', id: m.id, code, message }));

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
            const touched = new Set([...result.added, ...result.changed].map(EventStore.keyOf));
            this.storeEvents(result.events, touched);
            this.bump('save', m.commands);
            ws.send(json({ t: 'ack', id: m.id, v: this.state.v }));
            this.broadcast({ t: 'change', v: this.state.v, commands: m.commands }, ws);
            return;
        }
        if (m.t === 'meta') {
            const s = this.state; let changed = false;
            if (typeof m.title === 'string' && m.title !== s.title) {
                if (m.title.length > LIMITS.maxTitle) return refuse('too_big', 'title too long');
                s.title = m.title; this.setMeta('title', s.title); changed = true;
            }
            if (m.options && typeof m.options === 'object') {
                const next = { ...s.options, ...m.options };           // keys merge (publicViewId survives)
                if (json(next).length > LIMITS.maxField * 5) return refuse('too_big', 'settings too large');
                if (json(next) !== json(s.options)) { s.options = next; this.setMeta('options', next); changed = true; }
            }
            if (!changed) return ws.send(json({ t: 'ack', id: m.id, v: s.v, unchanged: true }));
            this.bump('meta', [{ type: 'meta', title: m.title, options: m.options }]);
            ws.send(json({ t: 'ack', id: m.id, v: s.v }));
            this.broadcast({ t: 'meta', v: s.v, title: s.title, options: s.options }, ws);
            return;
        }
        if (m.t === 'hello') {
            // A reconnecting tab says which version it has; the snapshot was already sent on
            // connect, so this is only for the future "changes since v" optimization.
            return ws.send(json({ t: 'snapshot', v: this.state.v, calendar: this.calendar() }));
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
        const text = json(msg);
        for (const s of this.ctx.getWebSockets()) if (s !== except) { try { s.send(text); } catch { /* gone */ } }
    }
}
