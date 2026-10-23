// Stand-ins for the two things billing talks to, on one local port (the Worker reaches them with
// ACCOUNTS_DEV_MODE=1, STRIPE_API_BASE=http://127.0.0.1:<port>/stripe, LOCK_API_BASE=.../lockfake):
//   Stripe:  POST /stripe/v1/checkout/sessions, POST .../checkout/sessions/<id>/expire, GET .../checkout/sessions/<id>
//            (`sessions`), POST /stripe/v1/billing_portal/sessions,
//            GET/DELETE /stripe/v1/subscriptions/<id>   (from `subs`, which the test sets; DELETE cancels)
//            GET /stripe/v1/invoices/<id> (`invoices`), GET /stripe/v1/invoice_payments?invoice=|payment[payment_intent]=
//            (`invoicePayments`, a list of {invoice, status, payment}), GET /stripe/v1/charges/<id> (`charges`),
//            POST /stripe/v1/refunds (recorded in `refunds`; the same Idempotency-Key makes one refund)
//   Lock:    the CalendarRoom lock API from the pastecal-pro-lock branch, over `cals`:
//            GET lock-status, POST lock / unlock / rotate-editor-key
// Everything the Worker sent is in `log`, form bodies decoded.
import http from 'node:http';
import crypto from 'node:crypto';

export function startFakeStripe(port) {
    const subs = new Map(), cals = new Map(), log = [], hooks = { lockFails: 0, refundFails: 0, expireFails: 0 };
    const sessions = new Map(), invoices = new Map(), invoicePayments = [], charges = new Map(), refunds = [];
    const send = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    const server = http.createServer((req, res) => {
        let raw = ''; req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://x');
            const p = url.pathname;
            const form = (req.headers['content-type'] || '').includes('form') ? Object.fromEntries(new URLSearchParams(raw)) : null;
            const body = form || (raw ? JSON.parse(raw) : null);
            const idem = req.headers['idempotency-key'] || null;
            log.push({ method: req.method, path: decodeURIComponent(p), auth: req.headers.authorization, body, idem, query: Object.fromEntries(url.searchParams) });
            if (p.startsWith('/stripe/')) {
                const missing = () => send(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
                if (req.method === 'POST' && p === '/stripe/v1/checkout/sessions') {
                    const id = 'cs_test_' + crypto.randomBytes(6).toString('hex');
                    sessions.set(id, { id, object: 'checkout.session', status: 'open', url: `https://checkout.stripe.test/${id}` });
                    return send(res, 200, sessions.get(id));
                }
                const cs = p.match(/^\/stripe\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/);
                if (cs) {
                    const sess = sessions.get(cs[1]);
                    if (!sess) return missing();
                    if (req.method === 'GET' && !cs[2]) return send(res, 200, sess);
                    if (req.method === 'POST' && cs[2]) {
                        if (hooks.expireFails > 0) { hooks.expireFails--; return send(res, 400, { error: { type: 'invalid_request_error', message: 'fake: cannot expire' } }); }
                        if (sess.status !== 'open') return send(res, 400, { error: { type: 'invalid_request_error', message: `Session is ${sess.status}` } });
                        sess.status = 'expired';
                        return send(res, 200, sess);
                    }
                }
                if (req.method === 'POST' && p === '/stripe/v1/billing_portal/sessions') return send(res, 200, { url: 'https://billing.stripe.test/p/session' });
                const m = p.match(/^\/stripe\/v1\/subscriptions\/([^/]+)$/);
                if ((req.method === 'GET' || req.method === 'DELETE') && m) {
                    const sub = subs.get(decodeURIComponent(m[1]));
                    if (!sub) return missing();
                    if (req.method === 'DELETE') sub.status = 'canceled';
                    return send(res, 200, sub);
                }
                const inv = p.match(/^\/stripe\/v1\/invoices\/([^/]+)$/);
                if (req.method === 'GET' && inv) return invoices.has(inv[1]) ? send(res, 200, invoices.get(inv[1])) : missing();
                const ch = p.match(/^\/stripe\/v1\/charges\/([^/]+)$/);
                if (req.method === 'GET' && ch) return charges.has(ch[1]) ? send(res, 200, charges.get(ch[1])) : missing();
                if (req.method === 'GET' && p === '/stripe/v1/invoice_payments') {
                    const byInv = url.searchParams.get('invoice'), byPi = url.searchParams.get('payment[payment_intent]');
                    const data = invoicePayments.filter((x) => (byInv && x.invoice === byInv) || (byPi && x.payment && x.payment.payment_intent === byPi));
                    return send(res, 200, { object: 'list', data });
                }
                if (req.method === 'POST' && p === '/stripe/v1/refunds') {
                    if (hooks.refundFails > 0) { hooks.refundFails--; return send(res, 500, { error: { message: 'fake: down' } }); }
                    const seen = idem && refunds.find((r) => r.idem === idem);
                    if (seen) return send(res, 200, seen);
                    const refund = { id: 're_' + crypto.randomBytes(6).toString('hex'), object: 'refund', status: 'succeeded', idem, ...body };
                    refunds.push(refund);
                    return send(res, 200, refund);
                }
                return send(res, 404, { error: { message: 'fake: no route' } });
            }
            const lm = decodeURIComponent(p).match(/^\/lockfake\/cal\/(.+)\/(lock|unlock|rotate-editor-key|lock-status)$/);
            if (!lm) return send(res, 404, { ok: false });
            const [, id, action] = lm, cal = cals.get(id);
            if (action !== 'lock-status' && hooks.lockFails > 0) { hooks.lockFails--; return send(res, 503, { ok: false, error: 'unavailable' }); }
            if (!cal) return send(res, 404, { ok: false, error: 'no-calendar' });
            if (action === 'lock-status') return send(res, 200, { locked: cal.locked, ownerId: cal.ownerId || null, plan: cal.plan || null, lockedAt: cal.lockedAt || null });
            if (action === 'lock') {
                if (cal.locked && cal.ownerId !== body.ownerId) return send(res, 409, { ok: false, error: 'locked-by-other' });
                Object.assign(cal, { locked: true, ownerId: body.ownerId, plan: body.plan, lockedAt: Date.now(), editorKey: 'ek-' + crypto.randomBytes(8).toString('hex') });
                return send(res, 200, { ok: true, editorKey: cal.editorKey });
            }
            if (cal.ownerId !== body.ownerId) return send(res, 403, { ok: false, error: 'not-owner' });
            if (action === 'unlock') { Object.assign(cal, { locked: false, ownerId: null, plan: null }); return send(res, 200, { ok: true }); }
            cal.editorKey = 'ek-' + crypto.randomBytes(8).toString('hex');
            return send(res, 200, { ok: true, editorKey: cal.editorKey });
        });
    });
    const addCalendar = (id, lock = {}) => cals.set(id, { locked: false, ...lock });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ subs, cals, log, hooks, addCalendar,
        sessions, invoices, invoicePayments, charges, refunds, close: () => server.close() })));
}

// A Stripe-Signature header the way Stripe makes one.
export function signStripe(secret, body, t = Math.floor(Date.now() / 1000)) {
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return `t=${t},v1=${v1}`;
}
