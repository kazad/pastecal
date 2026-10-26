// Stripe.js pure helpers, no Worker needed:   node test/stripe-unit.test.mjs
// The test-key guard, the live/test event check, and reading a payment or subscription out of an
// invoice in both API shapes (before and after 2025-03-31.basil).
import assert from 'node:assert/strict';
import { stripeConfig, eventModeMismatch, paymentOfInvoice, paymentOfInvoicePayments, subscriptionOfInvoice, summarizeSubscription } from '../src/Stripe.js';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const quiet = console.error; console.error = () => {};

const base = { STRIPE_WEBHOOK_SECRET: 'fake-webhook-secret' };
assert.equal(stripeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc' }), null);
assert.equal(stripeConfig({ ...base, STRIPE_SECRET_KEY: 'rk_test_abc', ACCOUNTS_DEV_MODE: '0' }), null);
assert.equal(stripeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', ACCOUNTS_DEV_MODE: '1' }).livemode, false);
assert.equal(stripeConfig({ ...base, STRIPE_SECRET_KEY: 'rk_live_abc' }).livemode, true);
assert.equal(stripeConfig({ ...base, STRIPE_SECRET_KEY: 'fake-stripe-key' }).livemode, null);
console.error = quiet;
step('a test-mode key (sk_test_/rk_test_) turns billing off unless ACCOUNTS_DEV_MODE=1; livemode follows the key');

// Staging: BILLING_TEST_MODE=1 with a non-production SITE_URL, and only for a request to that host.
console.error = () => {};
const stg = { ...base, STRIPE_SECRET_KEY: 'sk_test_abc', BILLING_TEST_MODE: '1', SITE_URL: 'https://preview.pastecal.com' };
assert.equal(stripeConfig(stg, 'preview.pastecal.com').livemode, false);
assert.equal(stripeConfig(stg), null, 'no host: refused');
assert.equal(stripeConfig(stg, 'pastecal.com'), null);
assert.equal(stripeConfig(stg, 'www.pastecal.com'), null);
assert.equal(stripeConfig(stg, 'pastecal-staging.example.workers.dev'), null, 'only SITE_URL\'s own host');
const { SITE_URL, ...noSite } = stg;
assert.equal(stripeConfig(noSite, 'preview.pastecal.com'), null, 'production (no SITE_URL) + BILLING_TEST_MODE: still refused');
assert.equal(stripeConfig({ ...noSite, BILLING_TEST_MODE: '1' }, 'new.pastecal.com'), null, 'a misconfigured production never takes test keys');
assert.equal(stripeConfig({ ...stg, SITE_URL: 'https://pastecal.com' }, 'pastecal.com'), null);
assert.equal(stripeConfig({ ...stg, BILLING_TEST_MODE: '0' }, 'preview.pastecal.com'), null);
assert.equal(stripeConfig({ ...stg, STRIPE_SECRET_KEY: 'sk_live_abc' }, 'preview.pastecal.com'), null, 'staging refuses a LIVE key');
assert.equal(stripeConfig({ ...stg, STRIPE_SECRET_KEY: 'rk_live_abc' }, 'preview.pastecal.com'), null);
console.error = quiet;
step('BILLING_TEST_MODE: a test key works only on staging\'s own host; production hosts, no SITE_URL, or a live key: billing off');

const live = { livemode: true }, test = { livemode: false }, fake = { livemode: null };
assert.equal(eventModeMismatch(live, { livemode: false }), true);
assert.equal(eventModeMismatch(test, { livemode: true }), true);
assert.equal(eventModeMismatch(live, { livemode: true }), false);
assert.equal(eventModeMismatch(live, {}), false, 'no livemode on the event: not judged');
assert.equal(eventModeMismatch(fake, { livemode: true }), false);
step('events from the other mode than the key are flagged; events without livemode, or a fake key, are not');

assert.deepEqual(paymentOfInvoice({ payment_intent: 'pi_1', charge: 'ch_1' }), { payment_intent: 'pi_1' });
assert.deepEqual(paymentOfInvoice({ charge: { id: 'ch_2' } }), { charge: 'ch_2' });
assert.equal(paymentOfInvoice({ id: 'in_basil' }), null);
assert.deepEqual(paymentOfInvoicePayments({ data: [{ status: 'open', payment: { payment_intent: 'pi_x' } }, { status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_3' } }] }), { payment_intent: 'pi_3' });
assert.deepEqual(paymentOfInvoicePayments({ data: [{ status: 'paid', payment: { type: 'charge', charge: 'ch_4' } }] }), { charge: 'ch_4' });
assert.equal(paymentOfInvoicePayments({ data: [] }), null);
assert.equal(subscriptionOfInvoice({ subscription: 'sub_old' }), 'sub_old');
assert.equal(subscriptionOfInvoice({ parent: { subscription_details: { subscription: 'sub_new' } } }), 'sub_new');
assert.equal(subscriptionOfInvoice({}), null);
step('the payment to refund and the subscription an invoice belongs to, in the old and the basil shapes');

const sum = summarizeSubscription({ id: 'sub_1', status: 'active', created: 1700000000, latest_invoice: { id: 'in_9' }, items: { data: [] } });
assert.deepEqual([sum.created, sum.latestInvoice], [1700000000, 'in_9']);
step('a subscription summary keeps created and latest_invoice');
console.log(`\n${n} checks passed`);
