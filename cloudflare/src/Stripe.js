/**
 * Stripe over plain fetch (no SDK): form-encoded requests and webhook signature checks.
 *
 * Config comes only from env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and one price id per
 * interval (STRIPE_PRICE_PRO_YEARLY, STRIPE_PRICE_PRO_MONTHLY). With any of the first two missing,
 * billing is off and the routes answer 503 billing-not-configured.
 * Requests go to https://api.stripe.com; local tests may point STRIPE_API_BASE at a fake on this
 * machine, honored only with ACCOUNTS_DEV_MODE=1 (see localBase), so the key never goes elsewhere.
 */
import { localBase } from './LockClient.js';

export const INTERVALS = { year: 'STRIPE_PRICE_PRO_YEARLY', month: 'STRIPE_PRICE_PRO_MONTHLY' };

export function stripeConfig(env) {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
    const devBase = env.ACCOUNTS_DEV_MODE === '1' && env.STRIPE_API_BASE ? localBase(env.STRIPE_API_BASE) : null;
    return {
        key: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        prices: { year: env.STRIPE_PRICE_PRO_YEARLY || null, month: env.STRIPE_PRICE_PRO_MONTHLY || null },
        base: devBase || 'https://api.stripe.com',
    };
}

// {a: {b: 1}, c: [{d: 2}]} -> a[b]=1&c[0][d]=2, the way Stripe reads nested params.
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        const key = prefix ? `${prefix}[${k}]` : k;
        if (typeof v === 'object') formEncode(v, key, out);
        else out.append(key, String(v));
    }
    return out;
}

export async function stripeRequest(cfg, method, path, params) {
    const init = { method, headers: { Authorization: `Bearer ${cfg.key}` } };
    if (params && method !== 'GET') {
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = formEncode(params).toString();
    }
    const res = await fetch(cfg.base + path, init);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
}

export function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

// Stripe-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=...]. The HMAC-SHA256 is over `${t}.${body}`
// with the endpoint's signing secret. Older than 5 minutes (either way) is refused: a replay.
export async function verifyStripeSignature(secret, header, body, nowSec = Math.floor(Date.now() / 1000)) {
    if (!header) return { ok: false, reason: 'no signature' };
    let t = null; const v1 = [];
    for (const part of header.split(',')) {
        const [k, v] = part.split('=', 2).map((s) => s && s.trim());
        if (k === 't') t = /^\d+$/.test(v || '') ? Number(v) : null;
        else if (k === 'v1' && v) v1.push(v);
    }
    if (t === null || !v1.length) return { ok: false, reason: 'malformed signature' };
    if (Math.abs(nowSec - t) > 300) return { ok: false, reason: 'stale timestamp' };
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const want = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
    let match = false;
    for (const sig of v1) match = timingSafeEqual(sig, want) || match;    // check every one, no early exit
    return match ? { ok: true } : { ok: false, reason: 'bad signature' };
}

// What we keep from a subscription, across API versions: current_period_end moved onto the
// items in 2025-03-31.basil, and invoices name their subscription under parent.subscription_details.
export function summarizeSubscription(sub) {
    const item = sub.items && sub.items.data && sub.items.data[0] || {};
    const price = item.price || sub.plan || {};
    return {
        id: sub.id,
        status: sub.status,
        customer: typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id,
        calendarId: sub.metadata && sub.metadata.calendar_id || null,
        userId: sub.metadata && sub.metadata.user_id || null,
        priceId: price.id || null,
        interval: (price.recurring && price.recurring.interval) || price.interval || null,
        currentPeriodEnd: item.current_period_end || sub.current_period_end || null,
    };
}

export function subscriptionIdOf(event) {
    const o = event && event.data && event.data.object || {};
    const ref = (v) => (typeof v === 'string' ? v : v && v.id) || null;
    if (event.type && event.type.startsWith('customer.subscription.')) return o.id || null;
    if (event.type === 'checkout.session.completed') return ref(o.subscription);
    if (event.type && event.type.startsWith('invoice.')) {
        return ref(o.subscription) || ref(o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription);
    }
    return null;
}
