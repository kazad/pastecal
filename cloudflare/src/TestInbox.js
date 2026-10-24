/**
 * Test inbox: Cloudflare Email Routing hands mail for a few fixed addresses to this Worker's email()
 * handler, which keeps it for 7 days (500 messages at most) so scripts can read what pastecal really
 * sent: subject, plain text, and the receiving side's SPF/DKIM/DMARC verdicts.
 *
 *   Addresses: test@, test-signin@, test-welcome@, test-weekly@pastecal.com (TEST_ADDRESS). Routing rules
 *   are literal, one per address (docs/pro-launch.md "Test inbox"); a catch-all would also swallow
 *   mail for addresses that must bounce. Anything else that reaches the handler is rejected.
 *   GET    /api/admin/test-inbox?to=<address>&limit=20   (Bearer IMPORT_SECRET) newest first:
 *          [{id, to, from, subject, receivedAt, auth:{spf,dkim,dmarc}, headers:{authenticationResults,
 *            arcAuthenticationResults, dkimSignature}, text, truncated}]. No `to`: every address.
 *   DELETE /api/admin/test-inbox?to=<address>            (same) clears that address; no `to`: all of it.
 *   POST   /api/admin/test-inbox/dev-seed {to, count, ageMs?}  (ACCOUNTS_DEV_MODE=1 + secret) inserts
 *          placeholder messages through the same pruning path, for the retention tests.
 *
 * Stored in the Accounts Durable Object (table test_inbox): it already exists as one global SQLite
 * object, so this needs no new class, binding or migration (a migration is a one-way deploy step),
 * and the volume (a few test mails a day) is nothing. Message bodies are never logged.
 */
import { timingSafeEqual } from './Stripe.js';

export const TEST_ADDRESS = /^test(-(signin|welcome|weekly))?@pastecal\.com$/i;
export const RAW_CAP = 200 * 1024;          // bytes of the raw message we read and parse
export const TEXT_CAP = 100 * 1024;         // characters of parsed text we store
export const RETAIN_MS = 7 * 24 * 3600 * 1000;
export const MAX_MESSAGES = 500;

const accounts = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

// --- MIME parsing (just enough for the mail we send: text, html, multipart/alternative|mixed) ------

function decodeBytes(bytes, charset) {
    try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}
const latin1Bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function base64Bytes(s) {
    let clean = s.replace(/[^A-Za-z0-9+/]/g, '');
    if (clean.length % 4 === 1) clean = clean.slice(0, -1);              // a stray character: not decodable
    try { return latin1Bytes(atob(clean + '='.repeat((4 - (clean.length % 4)) % 4))); } catch { return new Uint8Array(0); }
}
function quotedPrintableBytes(s) {
    const out = [];
    const t = s.replace(/=\r?\n/g, '');
    for (let i = 0; i < t.length; i++) {
        if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
        else out.push(t.charCodeAt(i) & 0xff);
    }
    return Uint8Array.from(out);
}

// RFC 2047 encoded words (=?utf-8?B?...?= / =?utf-8?Q?...?=) in a header value.
export function decodeHeader(v) {
    if (!v) return '';
    return v.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) =>
        decodeBytes(enc.toUpperCase() === 'B' ? base64Bytes(data) : quotedPrintableBytes(data.replace(/_/g, ' ')), cs));
}

// Header block → { lowercased name: [values] }, unfolded.
function parseHeaders(block) {
    const out = {};
    for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const name = line.slice(0, i).trim().toLowerCase();
        (out[name] = out[name] || []).push(line.slice(i + 1).trim());
    }
    return out;
}
const param = (value, name) => {
    const m = (value || '').match(new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i'));
    return m ? (m[1] ?? m[2]) : null;
};
function splitEntity(s) {
    const m = s.match(/\r?\n\r?\n/);
    return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : [s, ''];
}

// The parts of an entity (a latin1 "binary string"), depth-first: [{type, charset, body}].
function leafParts(entity, depth = 0) {
    const [head, body] = splitEntity(entity);
    const h = parseHeaders(head);
    const ctype = (h['content-type'] || ['text/plain'])[0];
    const type = ctype.split(';')[0].trim().toLowerCase();
    if (type.startsWith('multipart/') && depth < 5) {
        const boundary = param(ctype, 'boundary');
        if (!boundary) return [];
        const pieces = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
        return pieces.slice(1).filter((p) => p.trim()).flatMap((p) => leafParts(p, depth + 1));
    }
    const cte = ((h['content-transfer-encoding'] || [''])[0]).trim().toLowerCase();
    const bytes = cte === 'base64' ? base64Bytes(body) : cte === 'quoted-printable' ? quotedPrintableBytes(body) : latin1Bytes(body);
    const disposition = ((h['content-disposition'] || [''])[0]).toLowerCase();
    return [{ type, attachment: disposition.startsWith('attachment'), body: decodeBytes(bytes, param(ctype, 'charset')) }];
}

export function htmlToText(html) {
    return html
        .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The readable text of a raw message (bytes): its first text/plain part, else its first text/html
// part with the tags stripped.
export function parseMessageText(rawBytes) {
    let binary = '';
    for (let i = 0; i < rawBytes.length; i += 0x8000) binary += String.fromCharCode(...rawBytes.subarray(i, i + 0x8000));
    const parts = leafParts(binary).filter((p) => !p.attachment);
    const plain = parts.find((p) => p.type === 'text/plain');
    if (plain) return plain.body.replace(/\r\n/g, '\n').trim();
    const html = parts.find((p) => p.type === 'text/html');
    return html ? htmlToText(html.body) : '';
}

// {spf, dkim, dmarc} from an Authentication-Results value: the first verdict for each, or null.
export function parseAuthResults(value) {
    const out = { spf: null, dkim: null, dmarc: null };
    for (const k of Object.keys(out)) {
        const m = (value || '').match(new RegExp(`(?:^|[;\\s])${k}=([a-z]+)`, 'i'));
        if (m) out[k] = m[1].toLowerCase();
    }
    return out;
}

// --- The handler ----------------------------------------------------------------------------------

async function readCapped(stream, cap) {
    const reader = stream.getReader();
    const chunks = []; let size = 0, truncated = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = cap - size;
        if (value.length >= room) { chunks.push(value.subarray(0, room)); size += room; truncated = value.length > room; break; }
        chunks.push(value); size += value.length;
    }
    if (truncated || size >= cap) { truncated = true; reader.cancel().catch(() => {}); }
    const out = new Uint8Array(size); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return { bytes: out, truncated };
}

export async function handleTestInboxEmail(message, env) {
    const to = String(message.to || '').toLowerCase();
    if (!TEST_ADDRESS.test(to)) { message.setReject('unknown address'); return; }
    try {
        const { bytes, truncated } = await readCapped(message.raw, RAW_CAP);
        const h = message.headers;
        const authResults = h.get('authentication-results') || '';
        const arc = h.get('arc-authentication-results') || '';
        let text = parseMessageText(bytes);
        if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP);
        await accounts(env).addTestMail({
            to, from: String(message.from || '').toLowerCase(), subject: decodeHeader(h.get('subject') || '').slice(0, 500),
            text, truncated: truncated ? 1 : 0, authResults: authResults.slice(0, 4000), arcAuthResults: arc.slice(0, 4000),
            hasDkimSignature: h.has('dkim-signature') ? 1 : 0,
        });
    } catch (err) {
        console.error('[test-inbox] store failed:', err && err.message);   // never the body or the addresses
    }
}

// --- Admin routes -----------------------------------------------------------------------------------

function view(row) {
    const auth = parseAuthResults(row.auth_results);
    if (!auth.spf && !auth.dkim && !auth.dmarc) Object.assign(auth, parseAuthResults(row.arc_auth_results));
    return {
        id: row.id, to: row.to_addr, from: row.from_addr, subject: row.subject, receivedAt: new Date(row.received_at).toISOString(),
        auth, headers: { authenticationResults: row.auth_results || null, arcAuthenticationResults: !!row.arc_auth_results, dkimSignature: !!row.has_dkim_signature },
        text: row.text, truncated: !!row.truncated,
    };
}

// A Response for /api/admin/test-inbox[/...], or null for other paths.
export async function handleTestInboxAdmin(request, env, url) {
    const path = url.pathname;
    if (path !== '/api/admin/test-inbox' && !path.startsWith('/api/admin/test-inbox/')) return null;
    if (!env.IMPORT_SECRET || !timingSafeEqual(request.headers.get('Authorization') || '', `Bearer ${env.IMPORT_SECRET}`)) {
        return new Response('forbidden', { status: 403 });
    }
    if (!env.ACCOUNTS) return json({ error: 'not-available' }, 503);
    const rawTo = url.searchParams.get('to');
    const to = rawTo == null || rawTo === '' ? null : rawTo.trim().toLowerCase();
    if (to !== null && !TEST_ADDRESS.test(to)) return json({ error: 'bad-address' }, 400);
    if (path === '/api/admin/test-inbox' && request.method === 'GET') {
        const n = Number(url.searchParams.get('limit') || 20);
        const limit = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.floor(n))) : 20;
        return json((await accounts(env).listTestMail(to, limit)).map(view));
    }
    if (path === '/api/admin/test-inbox' && request.method === 'DELETE') {
        return json({ ok: true, deleted: await accounts(env).clearTestMail(to) });
    }
    if (path === '/api/admin/test-inbox/dev-seed' && request.method === 'POST' && env.ACCOUNTS_DEV_MODE === '1') {
        const body = await request.json().catch(() => ({})) || {};
        const seedTo = String(body.to || '').toLowerCase();
        const count = Math.min(1000, Math.max(1, Math.floor(Number(body.count) || 1)));
        if (!TEST_ADDRESS.test(seedTo)) return json({ error: 'bad-address' }, 400);
        return json({ ok: true, ...(await accounts(env).seedTestMail(seedTo, count, Number(body.ageMs) || 0)) });
    }
    return json({ error: 'not-found' }, 404);
}
