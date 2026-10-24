// Site.js, no Worker needed:   node test/site.test.mjs
// Which site this Worker is (production or staging), the links it writes, the Origins it trusts,
// and when a Stripe test key or noindex applies.
import assert from 'node:assert/strict';
import { siteUrl, siteHost, isStaging, allowedOrigins, testKeyAllowed, noindexEverywhere } from '../src/Site.js';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);

const prod = {}, stg = { SITE_URL: 'https://preview.pastecal.com' };
assert.equal(siteUrl(prod), 'https://pastecal.com');
assert.equal(siteUrl(stg), 'https://preview.pastecal.com');
assert.equal(siteUrl({ SITE_URL: 'https://preview.pastecal.com/' }), 'https://preview.pastecal.com', 'a trailing slash is fine');
for (const bad of ['http://preview.pastecal.com', 'https://preview.pastecal.com/x', 'https://preview.pastecal.com:8443', 'https://a@preview.pastecal.com', 'preview.pastecal.com', 'https://preview.pastecal.com?x=1', '']) {
    assert.equal(siteUrl({ SITE_URL: bad }), 'https://pastecal.com', `refused: ${bad}`);
}
assert.equal(siteHost(stg), 'preview.pastecal.com');
step('SITE_URL: an https origin or nothing; unset or malformed means https://pastecal.com');

assert.equal(isStaging(prod), false);
assert.equal(isStaging({ SITE_URL: 'https://pastecal.com' }), false);
assert.equal(isStaging({ SITE_URL: 'https://www.pastecal.com' }), false);
assert.equal(isStaging(stg), true);
assert.deepEqual(allowedOrigins(prod), ['https://pastecal.com', 'https://www.pastecal.com']);
assert.deepEqual(allowedOrigins(stg), ['https://preview.pastecal.com']);
assert.ok(!allowedOrigins(prod).includes('https://preview.pastecal.com'), 'production does not trust preview');
assert.ok(!allowedOrigins(stg).includes('https://pastecal.com'), 'staging does not trust production pages');
step('allowed Origins: production = pastecal.com + www; staging = its own origin only');

assert.equal(testKeyAllowed({ ACCOUNTS_DEV_MODE: '1' }, null), true, 'local dev mode, as before');
assert.equal(testKeyAllowed({ ...stg, BILLING_TEST_MODE: '1' }, 'preview.pastecal.com'), true);
assert.equal(testKeyAllowed({ ...stg, BILLING_TEST_MODE: '1' }, 'pastecal.com'), false);
assert.equal(testKeyAllowed({ ...stg, BILLING_TEST_MODE: '1' }, 'www.pastecal.com'), false);
assert.equal(testKeyAllowed({ ...stg, BILLING_TEST_MODE: '1' }, 'x.workers.dev'), false);
assert.equal(testKeyAllowed({ ...stg, BILLING_TEST_MODE: '1' }, undefined), false);
assert.equal(testKeyAllowed({ BILLING_TEST_MODE: '1' }, 'new.pastecal.com'), false, 'production + the flag by mistake');
assert.equal(testKeyAllowed({ BILLING_TEST_MODE: '1', SITE_URL: 'https://pastecal.com' }, 'pastecal.com'), false);
assert.equal(testKeyAllowed(stg, 'preview.pastecal.com'), false, 'no flag');
step('test keys: dev mode, or BILLING_TEST_MODE=1 on a staging SITE_URL for its own host only');

assert.equal(noindexEverywhere(prod, 'pastecal.com'), false);
assert.equal(noindexEverywhere(prod, 'new.pastecal.com'), false);
assert.equal(noindexEverywhere(prod, 'preview.pastecal.com'), true);
assert.equal(noindexEverywhere(stg, 'pastecal-staging.example.workers.dev'), true);
assert.equal(noindexEverywhere(stg, 'localhost'), true);
step('noindex everywhere: on the preview host, and on any host of a staging Worker; never on production');
console.log(`\n${n} checks passed`);
