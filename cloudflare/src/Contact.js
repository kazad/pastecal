/**
 * Contact form: POST /api/contact (public/contact.html). Messages are stored in the Waitlist
 * Durable Object (messages table) and read by GET /api/admin/messages (Bearer IMPORT_SECRET).
 *
 * No third-party CAPTCHA. Everything below is enforced here, in this order:
 *   1. same-site only: JSON content type and pastecal's own Origin (Accounts.js sameSite) -> 403
 *   2. body capped at MAX_BODY_BYTES, read in full before parsing -> 413
 *   3. the hidden "website" field filled -> { ok: true }, nothing stored (don't tell bots)
 *   4. field checks -> 400 with what to fix
 *   5. fill time: the page sends how long the form was open (its own clock at render and at submit,
 *      so a phone with a wrong clock still works); under 3 seconds or over a day -> 400.
 *      A script can forge this; it stops the bots that post without running the page.
 *   6. 5 messages an hour per IP (counted in the object by a salted hash, never the IP) -> 429
 */
import { CONTACT_TYPES } from './Waitlist.js';
import { RESERVED_CALENDAR_NAMES } from './SlugService.js';
import { sameSite } from './Accounts.js';

export const MAX_BODY_BYTES = 16 * 1024;           // 2000 characters of emoji is 8 KB
export const MAX_MESSAGE = 2000;
export const MIN_FILL_MS = 3000;
export const MAX_FILL_MS = 24 * 3600 * 1000;

// pastecal.com/<id> or pastecal.com/view/<id>, with or without https:// and www. Returns the
// calendar path ("<id>" or "view/<id>"), or null for anything else.
export function calendarPath(link) {
    const s = String(link || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    const m = s.match(/^(?:https?:\/\/)?(?:www\.)?pastecal\.com\/(view\/)?([A-Za-z0-9_-]{1,100})$/i);
    if (!m) return null;
    if (!m[1] && RESERVED_CALENDAR_NAMES.has(m[2].toLowerCase())) return null;
    return (m[1] ? 'view/' : '') + m[2];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The checks after the honeypot. Returns { error } or { entry } (pure, so it is unit-testable).
export function checkContact(body) {
    const type = body.type;
    if (!CONTACT_TYPES.includes(type)) return { error: 'Pick what this is about.' };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return { error: 'Write a message.' };
    if (message.length > MAX_MESSAGE) return { error: `Shorten the message to ${MAX_MESSAGE} characters or fewer.` };
    const link = typeof body.calendar === 'string' ? body.calendar.trim() : '';
    let calendar = '';
    if (type === 'report' && !link) return { error: 'Paste the calendar\'s link, like pastecal.com/your-calendar.' };
    if (link) {
        calendar = calendarPath(link);
        if (!calendar) return { error: 'That isn\'t a pastecal calendar link. Paste one like pastecal.com/your-calendar, or leave it empty.' };
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email && (email.length > 254 || !EMAIL.test(email))) return { error: 'Check the email address, or leave it empty.' };
    const elapsed = body.elapsed;
    if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
        return { error: 'That was quick. Wait a few seconds and send it again.' };
    }
    if (elapsed > MAX_FILL_MS) return { error: 'This page has been open a long time. Reload it and send again.' };
    return { entry: { type, calendar, message, email } };
}

export async function handleContact(request, env) {
    if (!sameSite(request, env)) return Response.json({ ok: false, error: 'Send this from the contact page on pastecal.com.' }, { status: 403 });
    if (!env.WAITLIST) return Response.json({ ok: false, error: 'not available' }, { status: 503 });
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) return tooBig();
    const text = await readCapped(request);
    if (text === null) return tooBig();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ ok: false, error: 'Send the form as JSON.' }, { status: 400 });
    if (body.website) return Response.json({ ok: true });                  // the hidden field: a bot
    const { error, entry } = checkContact(body);
    if (error) return Response.json({ ok: false, error }, { status: 400 });
    entry.country = (request.cf && request.cf.country) || '';
    entry.ip = request.headers.get('CF-Connecting-IP') || 'unknown';       // hashed in the object, never stored
    const wl = env.WAITLIST.get(env.WAITLIST.idFromName('pro'));
    const res = await wl.fetch('http://internal/message', { method: 'POST', body: JSON.stringify(entry) });
    if (res.status === 429) return Response.json({ ok: false, error: 'That\'s a lot of messages from here. Wait an hour and send it again.' }, { status: 429 });
    return res;
}

const tooBig = () => Response.json({ ok: false, error: `Shorten the message to ${MAX_MESSAGE} characters or fewer.` }, { status: 413 });

// The body as text, or null past MAX_BODY_BYTES (Content-Length can be absent or wrong).
async function readCapped(request) {
    if (!request.body) return '';
    const reader = request.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
        chunks.push(value);
    }
    const all = new Uint8Array(size); let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.byteLength; }
    return new TextDecoder().decode(all);
}
