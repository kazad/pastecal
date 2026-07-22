/**
 * Emulator-backed smoke test for the Cloud Functions that actually call admin.database().
 *
 * Regression origin: the firebase-admin 11->14 upgrade (commit 40090a4) broke
 * `admin.database()` in production ("admin.database is not a function"). It shipped
 * because test/unit/*.test.js only exercises pure logic (ICSService, Event model) —
 * nothing in the suite ever called SlugService.lookupCalendar or
 * CalendarService.getCalendarData, so nothing invoked the Admin SDK at all. A 3-major
 * dependency bump to the package that talks to the database went out with zero coverage
 * of that database call.
 *
 * This file closes that gap: it runs functions/index.js against a real (emulated)
 * Realtime Database and asserts on actual results, not mocks — so a future SDK upgrade
 * that breaks admin.database() fails here before it ever reaches a deploy.
 *
 * Requires the Database emulator running on FIREBASE_DATABASE_EMULATOR_HOST (see
 * `npm run test:unit`, which starts it automatically). Run standalone with:
 *   firebase emulators:exec --only database "node --test test/unit/lookup-calendar.emulator.test.js"
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    // Fail loud rather than silently skipping — a green run with this file silently
    // skipped is exactly how the coverage gap it closes could reopen unnoticed.
    throw new Error(
        'FIREBASE_DATABASE_EMULATOR_HOST is not set. Run via `npm run test:unit` ' +
        '(wraps this in `firebase emulators:exec --only database`), not `node --test` directly.'
    );
}

const admin = require('../../functions/node_modules/firebase-admin');
const { _internal } = require('../../functions/index.js');
const { CalendarService, SlugService } = _internal;

const db = admin.database();

// Each test seeds/cleans its own slug so tests can run in any order without leaking.
async function seedCalendar(id, overrides = {}) {
    await db.ref('calendars').child(id).set({
        id,
        title: 'Test Calendar',
        events: [],
        options: {},
        ...overrides,
    });
}

async function cleanup(...ids) {
    await Promise.all(ids.flatMap(id => [
        db.ref('calendars').child(id).remove(),
        db.ref('calendars_readonly').child(id).remove(),
        db.ref('slug_mappings').child(id.toLowerCase()).remove(),
    ]));
}

test('CalendarService.getCalendarData: reads a real calendar via admin.database()', async () => {
    await seedCalendar('SmokeTestCal', { title: 'From Emulator' });
    try {
        const { data } = await CalendarService.getCalendarData('SmokeTestCal');
        assert.equal(data.title, 'From Emulator');
    } finally {
        await cleanup('SmokeTestCal');
    }
});

test('CalendarService.getCalendarData: missing calendar throws not-found (not a generic crash)', async () => {
    await assert.rejects(
        () => CalendarService.getCalendarData('DoesNotExistAtAll'),
        (err) => err.code === 'not-found'
    );
});

test('SlugService.lookupCalendar: resolves a case-mismatched slug via slug_mappings', async () => {
    // Reproduces the exact WoodenIndian incident: URL slug arrives lowercased,
    // calendar key is mixed-case, resolution must go through the cache/scan path
    // in SlugService.lookupCalendar, which is what called the broken admin.database().
    await seedCalendar('WoodenIndianSmoke', { title: 'Case Mismatch Test' });
    try {
        const result = await SlugService.lookupCalendar('woodenindiansmoke');
        assert.equal(result.found, true);
        assert.equal(result.actualSlug, 'WoodenIndianSmoke');
        assert.equal(result.isReadOnly, false);
    } finally {
        await cleanup('WoodenIndianSmoke');
    }
});

test('SlugService.lookupCalendar: unknown slug reports not found, does not throw', async () => {
    const result = await SlugService.lookupCalendar('totally-unknown-slug-xyz');
    assert.equal(result.found, false);
});

test('SlugService.lookupCalendar: second lookup hits the slug_mappings cache path', async () => {
    // First call populates /slug_mappings/<normalized>; second call must read that
    // cached node successfully — a second admin.database() call site distinct from
    // the initial scan, so both must survive an SDK upgrade independently.
    await seedCalendar('CacheHitSmoke');
    try {
        await SlugService.lookupCalendar('cachehitsmoke');
        const cached = await db.ref('slug_mappings/cachehitsmoke').once('value');
        assert.ok(cached.val(), 'lookupCalendar should have written a slug_mappings cache entry');

        const second = await SlugService.lookupCalendar('cachehitsmoke');
        assert.equal(second.found, true);
        assert.equal(second.actualSlug, 'CacheHitSmoke');
    } finally {
        await cleanup('CacheHitSmoke');
    }
});

// --- Issue #37: ICS export bypassed case-insensitive slug lookup --------------------------
// generateICSV2 used to resolve the DB key via CalendarService.parseCalendarPath, which just
// lowercases the URL slug and reads that exact key. A calendar stored under a mixed-case key
// (e.g. "MeAndYou") was never at "/calendars/meandyou", so the export silently returned an
// empty (or wrong) calendar instead of the real one. The fix routes ICS export through the
// same SlugService.lookupCalendar case-insensitive scan the web app already uses. These tests
// exercise that exact chain — parseCalendarPath -> lookupCalendar -> getCalendarData — since
// generateICSV2 itself is an onRequest handler that isn't easily invoked without a full
// req/res harness.
test('ICS export path: mixed-case slug resolves to the real calendar, not a 404/empty one', async () => {
    await seedCalendar('MeAndYouSmoke', { title: 'Real Calendar', events: [] });
    try {
        const { rawSlug } = CalendarService.parseCalendarPath('/meandyousmoke');
        const lookup = await SlugService.lookupCalendar(rawSlug);
        assert.equal(lookup.found, true);
        assert.equal(lookup.actualSlug, 'MeAndYouSmoke', 'must resolve to the original mixed-case key');

        const { data } = await CalendarService.getCalendarData(lookup.actualSlug, lookup.isReadOnly);
        assert.equal(data.title, 'Real Calendar');
    } finally {
        await cleanup('MeAndYouSmoke');
    }
});

test('ICS export path: /view/<mixed-case slug> resolves read-only calendars too', async () => {
    await db.ref('calendars_readonly').child('ViewOnlySmoke').set({
        id: 'ViewOnlySmoke', title: 'Read Only Calendar', events: [], options: {},
    });
    try {
        const { rawSlug, isReadOnly: parsedReadOnly } = CalendarService.parseCalendarPath('/view/viewonlysmoke');
        assert.equal(parsedReadOnly, true);

        const lookup = await SlugService.lookupCalendar(rawSlug);
        assert.equal(lookup.found, true);
        assert.equal(lookup.actualSlug, 'ViewOnlySmoke');
        assert.equal(lookup.isReadOnly, true);

        const { data } = await CalendarService.getCalendarData(lookup.actualSlug, lookup.isReadOnly);
        assert.equal(data.title, 'Read Only Calendar');
    } finally {
        await cleanup('ViewOnlySmoke');
    }
});

test('CalendarService.parseCalendarPath: preserves raw (non-lowercased) slug for lookup', () => {
    const { rawSlug, id, isReadOnly } = CalendarService.parseCalendarPath('/MeAndYou');
    assert.equal(rawSlug, 'MeAndYou', 'raw slug must retain original casing');
    assert.equal(id, 'meandyou', 'normalized id is still lowercased for legacy callers');
    assert.equal(isReadOnly, false);
});

// --- Regression: full-tree scan must stay a bounded fallback, not the default path --------
// Root cause of the 2026-07-20 OOM crash loop / RTDB bandwidth spike: lookupCalendar's
// cache-miss path unconditionally read the entire calendars (~15MB) and calendars_readonly
// (~15MB+) trees into a 256MiB function instance just to resolve one slug. Two fixes closed
// this: (1) try an exact-key read on the caller's original casing before ever scanning, since
// callers already pass the raw un-lowercased slug and it matches the stored key in the common
// case; (2) negative-cache not-found results, since a nonexistent slug was otherwise
// unbounded — never cacheable, so every request for it (a dead subscription, a bot guessing
// IDs) paid the full scan every time. These tests assert the *caching behavior* those fixes
// depend on, since the scan itself isn't directly observable from outside lookupCalendar.
test('SlugService.lookupCalendar: exact-casing hit caches without needing a scan', async () => {
    // If this ever regressed to "scan first, cache second," the cached shape or the result
    // would still look identical — so what this really guards is that a same-casing slug
    // resolves via the O(1) exact-key path at all, by asserting the positive-cache entry
    // written matches the scan-path's own cache shape (proving either path produces a
    // consistent, reusable cache — see the next test for the actual cost-avoidance proof).
    await seedCalendar('ExactHitSmoke');
    try {
        const result = await SlugService.lookupCalendar('ExactHitSmoke');
        assert.equal(result.found, true);
        assert.equal(result.actualSlug, 'ExactHitSmoke');

        const cached = await db.ref('slug_mappings/exacthitsmoke').once('value');
        assert.deepEqual(cached.val(), { actualSlug: 'ExactHitSmoke', isReadOnly: false });
    } finally {
        await cleanup('ExactHitSmoke');
    }
});

test('SlugService.lookupCalendar: unknown slug writes a negative-cache entry', async () => {
    const slug = 'never-existed-negative-cache-smoke';
    try {
        const result = await SlugService.lookupCalendar(slug);
        assert.equal(result.found, false);

        const cached = await db.ref(`slug_mappings/${slug}`).once('value');
        const cacheData = cached.val();
        assert.ok(cacheData, 'a not-found lookup must still write a cache entry');
        assert.equal(cacheData.notFound, true);
        assert.equal(typeof cacheData.cachedAt, 'number');
    } finally {
        await db.ref(`slug_mappings/${slug}`).remove();
    }
});

test('SlugService.lookupCalendar: negative cache is honored even after the calendar is created (within TTL)', async () => {
    // This is the actual regression proof: if lookupCalendar re-scanned on every miss (the
    // original bug) instead of trusting the negative cache, it would find the calendar
    // created between the two calls and incorrectly report found=true. Reporting found=false
    // here is direct evidence the second call used the cache, not a live re-scan.
    const slug = 'created-after-negative-cache-smoke';
    try {
        const first = await SlugService.lookupCalendar(slug);
        assert.equal(first.found, false);

        await seedCalendar(slug, { title: 'Created after the negative cache was written' });

        const second = await SlugService.lookupCalendar(slug);
        assert.equal(second.found, false, 'negative cache must be trusted within its TTL, not re-scanned');
    } finally {
        await cleanup(slug);
    }
});

test('SlugService.lookupCalendar: expired negative cache re-checks and finds a since-created calendar', async () => {
    const slug = 'expired-negative-cache-smoke';
    try {
        // Seed an already-expired negative cache entry directly, rather than waiting out
        // the real TTL, to keep this test fast.
        await db.ref(`slug_mappings/${slug}`).set({
            notFound: true,
            cachedAt: Date.now() - (SlugService.NOT_FOUND_CACHE_MS + 1000),
        });
        await seedCalendar(slug, { title: 'Created after the negative cache expired' });

        const result = await SlugService.lookupCalendar(slug);
        assert.equal(result.found, true, 'an expired negative-cache entry must not block a real lookup');
        assert.equal(result.actualSlug, slug);
    } finally {
        await cleanup(slug);
    }
});
