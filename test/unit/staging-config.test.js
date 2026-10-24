/**
 * The staging Worker (preview.pastecal.com, `wrangler deploy --env staging`) must never reach
 * production: not its routes, its Durable Objects, its backups, its Firebase, or its rate limits.
 * Wrangler environments do NOT inherit bindings, so every one is listed in env.staging; this pins
 * that list and the values that keep staging apart.
 *
 * Run: node --test test/unit/staging-config.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// JSONC -> JSON: drop // and /* */ comments outside strings, then trailing commas.
function parseJsonc(src) {
    let out = '', i = 0, inStr = false;
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (inStr) {
            out += c;
            if (c === '\\') { out += n; i += 2; continue; }
            if (c === '"') inStr = false;
            i++; continue;
        }
        if (c === '"') { inStr = true; out += c; i++; continue; }
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
        out += c; i++;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const cfg = parseJsonc(fs.readFileSync(path.join(__dirname, '../../cloudflare/wrangler.jsonc'), 'utf8'));
const st = cfg.env && cfg.env.staging;

test('staging is its own Worker on preview.pastecal.com only', () => {
    assert.ok(st, 'env.staging exists');
    assert.equal(st.name, 'pastecal-staging');
    assert.notEqual(st.name, cfg.name, 'a different script name = separate Durable Objects');
    assert.deepEqual(st.routes, [{ pattern: 'preview.pastecal.com', custom_domain: true }]);
    assert.equal(st.workers_dev, false);
    assert.equal(st.preview_urls, false);
    assert.equal(st.assets.run_worker_first, true, 'every path passes the Worker (noindex, robots.txt)');
    assert.equal(st.assets.directory, cfg.assets.directory);
    assert.equal(st.assets.not_found_handling, cfg.assets.not_found_handling);
});

test('staging lists every binding production has (none are inherited), pointing at its own resources', () => {
    const names = (arr, key = 'name') => (arr || []).map((b) => b[key] || b.binding).sort();
    assert.deepEqual(names(st.durable_objects.bindings), names(cfg.durable_objects.bindings));
    assert.deepEqual(st.durable_objects.bindings, cfg.durable_objects.bindings);
    assert.deepEqual(st.migrations, cfg.migrations, 'same classes, same migration tags');
    assert.deepEqual(names(st.ratelimits), names(cfg.ratelimits));
    assert.notEqual(st.ratelimits[0].namespace_id, cfg.ratelimits[0].namespace_id, 'own rate-limit namespace');
    assert.deepEqual(names(st.r2_buckets, 'binding'), ['BACKUPS']);
    assert.notEqual(st.r2_buckets[0].bucket_name, cfg.r2_buckets[0].bucket_name, 'own backup bucket');
    assert.deepEqual(names(st.analytics_engine_datasets, 'binding'), ['EVENTS']);
    assert.notEqual(st.analytics_engine_datasets[0].dataset, cfg.analytics_engine_datasets[0].dataset, 'own dataset');
    assert.deepEqual(st.send_email, cfg.send_email, 'same sender: pastecal.com is the sending domain');
});

test('staging never writes to Firebase and never runs in dev mode', () => {
    const v = st.vars;
    assert.equal(v.COPY_BACK, '');
    assert.equal(v.FIREBASE_DB_URL, '');
    assert.equal(v.SITE_URL, 'https://preview.pastecal.com');
    assert.equal(v.BILLING_TEST_MODE, '1');
    for (const k of ['ACCOUNTS_DEV_MODE', 'STRIPE_API_BASE', 'LOCK_API_BASE', 'UNSAFE_DEV_SESSION_HEADER']) {
        assert.ok(!(k in v), `${k} is not set on staging`);
        assert.ok(!(k in cfg.vars), `${k} is not set on production`);
    }
});

test('production has no staging switches', () => {
    assert.ok(!('SITE_URL' in cfg.vars), 'production links stay https://pastecal.com');
    assert.ok(!('BILLING_TEST_MODE' in cfg.vars), 'production never takes test keys');
    assert.ok(!cfg.routes.some((r) => /preview/.test(r.pattern)));
});
