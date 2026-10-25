// Stand-ins for the two things billing talks to, on one local port (the Worker reaches them with
// ACCOUNTS_DEV_MODE=1, STRIPE_API_BASE=http://127.0.0.1:<port>/stripe, LOCK_API_BASE=.../lockfake):
//   Stripe:  POST /stripe/v1/checkout/sessions, POST .../checkout/sessions/<id>/expire, GET .../checkout/sessions/<id>
//            (`sessions`), POST /stripe/v1/billing_portal/sessions,
//            GET/DELETE /stripe/v1/subscriptions/<id>   (from `subs`, which the test sets; DELETE cancels)
//            GET /stripe/v1/invoices/<id> (`invoices`), GET /stripe/v1/invoice_payments?invoice=|payment[payment_intent]=
//            (`invoicePayments`, a list of {invoice, status, payment}), GET /stripe/v1/charges/<id> (`charges`),
//            POST /stripe/v1/refunds (recorded in `refunds`; the same Idempotency-Key makes one refund)
//            GET /stripe/v1/customers/<id> (`customers`, which the test sets)
//            POST /stripe/v1/customers, POST /stripe/v1/subscriptions (trials: a trialing sub with trial_end, put in `subs`;
//            the same Idempotency-Key returns the same object; hooks.createFails refuses the next N with a 400)
//   Lock:    the CalendarRoom lock API from the pastecal-pro-lock branch, over `cals`:
//            GET lock-status, POST lock / unlock / rotate-editor-key / editor-of-record
// Everything the Worker sent is in `log`, form bodies decoded.
import http from 'node:http';
import crypto from 'node:crypto';

export function startFakeStripe(port) {
    const subs = new Map(), cals = new Map(), log = [], hooks = { lockFails: 0, refundFails: 0, expireFails: 0, createFails: 0 };
    const sessions = new Map(), invoices = new Map(), invoicePayments = [], charges = new Map(), refunds = [], customers = new Map(), created = new Map();
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
                    const metadata = {};
                    for (const [k, v] of Object.entries(body || {})) { const mm = k.match(/^metadata\[(.+)\]$/); if (mm) metadata[mm[1]] = v; }
                    sessions.set(id, { id, object: 'checkout.session', status: 'open', payment_status: 'unpaid', metadata,
                        created: Math.floor(Date.now() / 1000), url: `https://checkout.stripe.test/${id}` });
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
                // Trials: a customer, then a subscription made directly (no Checkout). The same
                // Idempotency-Key returns the same object, as Stripe does.
                if (req.method === 'POST' && (p === '/stripe/v1/customers' || p === '/stripe/v1/subscriptions')) {
                    if (hooks.createFails > 0) { hooks.createFails--; return send(res, 400, { error: { type: 'invalid_request_error', message: 'fake: refused' } }); }
                    const seen = idem && created.get(idem);
                    if (seen) return send(res, 200, seen);
                    const metadata = {};
                    for (const [k, v] of Object.entries(body || {})) { const mm = k.match(/^metadata\[(.+)\]$/); if (mm) metadata[mm[1]] = v; }
                    let obj;
                    if (p === '/stripe/v1/customers') {
                        obj = { id: 'cus_' + crypto.randomBytes(6).toString('hex'), object: 'customer', email: body.email, metadata };
                        customers.set(obj.id, obj);
                    } else {
                        const now = Math.floor(Date.now() / 1000), days = Number(body.trial_period_days || 0);
                        const price = body['items[0][price]'];
                        obj = { id: 'sub_' + crypto.randomBytes(6).toString('hex'), object: 'subscription', status: days ? 'trialing' : 'active',
                            customer: body.customer, metadata, created: now, trial_end: days ? now + days * 86400 : null, default_payment_method: null,
                            trial_settings: { end_behavior: { missing_payment_method: body['trial_settings[end_behavior][missing_payment_method]'] || null } },
                            items: { data: [{ current_period_end: days ? now + days * 86400 : now + 365 * 86400,
                                price: { id: price, recurring: { interval: price === 'price_fake_monthly' ? 'month' : 'year' } } }] } };
                        subs.set(obj.id, obj);
                    }
                    if (idem) created.set(idem, obj);
                    return send(res, 200, obj);
                }
                const m = p.match(/^\/stripe\/v1\/subscriptions\/([^/]+)$/);
                if ((req.method === 'GET' || req.method === 'DELETE') && m) {
                    const sub = subs.get(decodeURIComponent(m[1]));
                    if (!sub) return missing();
                    if (req.method === 'DELETE') sub.status = 'canceled';
                    return send(res, 200, sub);
                }
                const cu = p.match(/^\/stripe\/v1\/customers\/([^/]+)$/);
                if (req.method === 'GET' && cu) return customers.has(cu[1]) ? send(res, 200, customers.get(cu[1])) : missing();
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
            const lm = decodeURIComponent(p).match(/^\/lockfake\/cal\/(.+)\/(lock|unlock|rotate-editor-key|lock-status|editor-of-record)$/);
            if (!lm) return send(res, 404, { ok: false });
            const [, id, action] = lm, cal = cals.get(id);
            if (action !== 'lock-status' && action !== 'editor-of-record' && hooks.lockFails > 0) { hooks.lockFails--; return send(res, 503, { ok: false, error: 'unavailable' }); }
            if (!cal) return send(res, 404, { ok: false, error: 'no-calendar' });
            // No authors table here: every author is an editor of record (and the creator) unless the test set cal.creator.
            if (action === 'editor-of-record') { const yes = !cal.creator || (body && body.uid) === cal.creator; return send(res, 200, { ok: true, known: true, editor: yes, creator: yes }); }
            if (action === 'lock-status') return send(res, 200, { locked: cal.locked, ownerId: cal.ownerId || null, plan: cal.plan || null, lockedAt: cal.lockedAt || null, title: cal.title || null });
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
        sessions, invoices, invoicePayments, charges, refunds, customers, close: () => server.close() })));
}

// A Stripe-Signature header the way Stripe makes one.
export function signStripe(secret, body, t = Math.floor(Date.now() / 1000)) {
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return `t=${t},v1=${v1}`;
}
