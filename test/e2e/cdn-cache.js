// Serve the app's third-party scripts from a local cache during e2e runs.
//
// The page pulls Vue, Tailwind, date-fns, rrule, chrono, firebase-compat and --
// until Syncfusion is gone -- a 5 MB ej2 bundle from four CDNs. Fetching all of
// that on every test is slow, is a real source of CI flake, and makes the suite
// unrunnable anywhere without open egress.
//
// Opt in by setting PASTECAL_CDN_CACHE to a directory, then populate it once:
//
//     PASTECAL_CDN_CACHE=.cdn-cache node test/e2e/cdn-cache.js --populate
//     PASTECAL_CDN_CACHE=.cdn-cache npm run test:e2e
//
// Unset, everything behaves exactly as before and the tests go to the network.
// Requests that miss the cache still go to the network, so a newly added library
// fails loudly at populate time rather than silently at test time.
//
// One interaction to know about: Playwright matches route handlers newest-first
// and a handler that calls route.continue() ends the chain. A spec that installs
// its own catch-all route -- the analytics specs do, to watch what gets sent --
// therefore bypasses this cache and fetches from the network as it always has.
// That is fine where there is network; it just means the cache is a speed-up,
// not a way to run the whole suite offline.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// Kept in step with the <script> and <link> tags in public/index.html. The
// populate step fails on anything it cannot fetch, so a drifted list is noisy
// rather than silent.
const ASSETS = [
    'https://unpkg.com/vue@3/dist/vue.global.prod.js',
    'https://cdn.tailwindcss.com/',
    'https://www.gstatic.com/firebasejs/9.6.10/firebase-compat.js',
    'https://cdn.jsdelivr.net/npm/chrono-node@1.4.9/dist/chrono.min.js',
    'https://cdn.jsdelivr.net/npm/date-fns@3.6.0/cdn.min.js',
    'https://cdn.jsdelivr.net/npm/rrule@2.8.1/dist/es5/rrule.min.js',
    'https://cdn.syncfusion.com/ej2/23.2.6/dist/ej2.min.js',
    'https://cdn.syncfusion.com/ej2/ej2-base/styles/material.css',
    'https://cdn.syncfusion.com/ej2/material.css',
    'https://cdn.syncfusion.com/ej2/ej2-schedule/styles/material.css',
];

const cacheDir = () => process.env.PASTECAL_CDN_CACHE || '';
const keyFor = (url) => crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
const contentType = (url) => (url.split('?')[0].endsWith('.css') ? 'text/css' : 'text/javascript');

/**
 * Route third-party requests to the cache. Local requests and cache misses pass
 * through untouched. No-op when PASTECAL_CDN_CACHE is unset.
 */
async function useCdnCache(page) {
    const dir = cacheDir();
    if (!dir || !fs.existsSync(dir)) return;

    await page.route('**://*/**', (route) => {
        const url = route.request().url();
        if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
            return route.continue();
        }
        const file = path.join(dir, keyFor(url));
        if (!fs.existsSync(file)) return route.continue();
        return route.fulfill({
            status: 200,
            contentType: contentType(url),
            body: fs.readFileSync(file),
        });
    });
}

async function populate() {
    const dir = cacheDir();
    if (!dir) {
        console.error('Set PASTECAL_CDN_CACHE to the directory to populate.');
        process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });

    let failed = 0;
    for (const url of ASSETS) {
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            let body = Buffer.from(await res.arrayBuffer());
            // Some CDNs answer with gzip regardless of Accept-Encoding; storing the
            // compressed bytes and serving them as text/javascript yields a syntax
            // error inside the browser rather than an obvious failure here.
            if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
            fs.writeFileSync(path.join(dir, keyFor(url)), body);
            console.log(`  ok  ${(body.length / 1024).toFixed(0).padStart(6)} KB  ${url}`);
        } catch (err) {
            failed++;
            console.error(`  FAIL              ${url} -- ${err.message}`);
        }
    }
    console.log(failed ? `\n${failed} asset(s) failed.` : `\nCached ${ASSETS.length} assets in ${dir}.`);
    process.exit(failed ? 1 : 0);
}

if (require.main === module && process.argv.includes('--populate')) populate();

module.exports = { useCdnCache, ASSETS };
