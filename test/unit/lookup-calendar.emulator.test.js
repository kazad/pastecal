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
    // Pulled out so it never lands in the stored calendar record.
    const { __skipIndex, ...calendarFields } = overrides;
    await db.ref('calendars').child(id).set({
        id,
        title: 'Test Calendar',
        events: [],
        options: {},
        ...calendarFields,
    });
    // In production the indexSlug trigger writes this the moment the calendar is written.
    // `emulators:exec --only database` runs no functions, so seed it here -- otherwise these
    // tests would exercise a state (calendar exists, index does not) that only occurs for
    // pre-trigger calendars, which the backfill script covers.
    if (!__skipIndex) {
        await db.ref('slug_mappings').child(id.toLowerCase())
            .set({ actualSlug: id, isReadOnly: false });
    }
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
    // The indexReadOnlySlug trigger writes this in production; emulators:exec runs no
    // functions, so seed it here.
    await db.ref('slug_mappings/viewonlysmoke')
        .set({ actualSlug: 'ViewOnlySmoke', isReadOnly: true });
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

        // __skipIndex: simulate a calendar appearing without the index being updated, which
        // is the only way the negative cache is still the deciding factor. (With the index
        // written, the trigger's entry correctly wins -- covered by its own test below.)
        await seedCalendar(slug, { title: 'Created after the negative cache was written', __skipIndex: true });

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
        // Same casing as the request, so the exact-key read resolves it once the stale
        // negative entry is bypassed -- no scan and no index entry needed.
        await seedCalendar(slug, { title: 'Created after the negative cache expired', __skipIndex: true });

        const result = await SlugService.lookupCalendar(slug);
        assert.equal(result.found, true, 'an expired negative-cache entry must not block a real lookup');
        assert.equal(result.actualSlug, slug);
    } finally {
        await cleanup(slug);
    }
});


// --- The creation path, and why it broke -------------------------------------------------
// On 2026-08-25, creating a calendar by typing a URL was impossible on production: the
// lookupCalendar function returned HTTP 500/503 for any slug that did not already exist,
// while existing slugs returned 200. Root cause was a full-tree scan on the cache-miss path
// (`.once('value')` over /calendars and /calendars_readonly, ~30MB) inside a 256MiB
// instance. It OOMed before reaching the negative-cache write at the end of lookupCalendar,
// so nothing was ever cached and every retry re-ran the same scan.
//
// Why the twelve tests above all passed while production was down: every one of them
// asserted RETURN VALUES, and the return values were always correct. The failure was
// resource exhaustion at production DATA VOLUME -- invisible against an emulator holding a
// handful of tiny seeded calendars. The scan is now gone (see lookupCalendar), replaced by
// the /slug_mappings index the codebase already had.
//
// These tests pin the properties that actually failed, not just the answers.

test('lookupCalendar: a nonexistent slug does not read whole calendars (the OOM shape)', async () => {
    // THE regression test for the outage. Asserts on bytes read rather than the return
    // value, because the return value was never wrong -- the memory cost was.
    const bulkyEvents = Array.from({ length: 400 }, (_, i) => ({
        subject: `padding ${i} ${'x'.repeat(200)}`,
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T01:00:00.000Z',
    }));
    await seedCalendar('OomShapeProbe', { events: bulkyEvents });

    const db2 = admin.database();
    const origRef = db2.ref;
    let valueBytesRead = 0;
    db2.ref = (p) => {
        const ref = origRef.call(db2, p);
        const realOnce = ref.once.bind(ref);
        ref.once = async (...args) => {
            const snap = await realOnce(...args);
            valueBytesRead += JSON.stringify(snap.val() ?? null).length;
            return snap;
        };
        return ref;
    };

    try {
        const result = await SlugService.lookupCalendar('no-such-slug-oom-probe');
        assert.equal(result.found, false);
        // The bulky calendar is ~100KB. Resolving an unrelated missing slug must not touch it.
        assert.ok(
            valueBytesRead < 10_000,
            `resolving a missing slug read ${valueBytesRead} bytes; it must not read calendar ` +
            'contents, or it OOMs a 256MiB instance at production data volume'
        );
    } finally {
        db2.ref = origRef;
        await cleanup('OomShapeProbe');
        await db.ref('slug_mappings/no-such-slug-oom-probe').remove();
    }
});

test('lookupCalendar: an EXISTING calendar is resolved without reading its events', async () => {
    // Same property on the hot path: a busy calendar is resolved by key, not by payload.
    const bulkyEvents = Array.from({ length: 400 }, (_, i) => ({
        subject: `padding ${i} ${'x'.repeat(200)}`,
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T01:00:00.000Z',
    }));
    await seedCalendar('HotPathProbe', { events: bulkyEvents, __skipIndex: true });

    const db2 = admin.database();
    const origRef = db2.ref;
    let valueBytesRead = 0;
    db2.ref = (p) => {
        const ref = origRef.call(db2, p);
        const realOnce = ref.once.bind(ref);
        ref.once = async (...args) => {
            const snap = await realOnce(...args);
            valueBytesRead += JSON.stringify(snap.val() ?? null).length;
            return snap;
        };
        return ref;
    };

    try {
        const result = await SlugService.lookupCalendar('HotPathProbe');
        assert.equal(result.found, true);
        assert.equal(result.actualSlug, 'HotPathProbe');
        assert.ok(
            valueBytesRead < 10_000,
            `resolving an existing slug read ${valueBytesRead} bytes; existence must be ` +
            'checked without pulling the event list'
        );
    } finally {
        db2.ref = origRef;
        await cleanup('HotPathProbe');
    }
});

test('lookupCalendar: cost does not grow with the number of calendars', async () => {
    // The scan was O(all calendars); the index is O(1). Measuring the SHAPE of the cost
    // curve catches a reintroduced scan even when a small fixture would hide it.
    const countReads = async (fn) => {
        const db2 = admin.database();
        const origRef = db2.ref;
        let reads = 0;
        db2.ref = (p) => {
            const ref = origRef.call(db2, p);
            const realOnce = ref.once.bind(ref);
            ref.once = async (...args) => { reads++; return realOnce(...args); };
            return ref;
        };
        try { await fn(); } finally { db2.ref = origRef; }
        return reads;
    };

    const ids = [];
    try {
        const readsWithFew = await countReads(() => SlugService.lookupCalendar('absent-slug-a'));

        for (let i = 0; i < 40; i++) {
            const id = `ScaleProbe${i}`;
            ids.push(id);
            await seedCalendar(id, { events: [{ subject: 'x'.repeat(500) }] });
        }

        const readsWithMany = await countReads(() => SlugService.lookupCalendar('absent-slug-b'));
        assert.equal(
            readsWithMany, readsWithFew,
            `resolving a missing slug took ${readsWithFew} reads with 0 calendars and ` +
            `${readsWithMany} with 40 -- lookup cost must not scale with the calendar count`
        );
    } finally {
        await cleanup(...ids);
        await db.ref('slug_mappings/absent-slug-a').remove();
        await db.ref('slug_mappings/absent-slug-b').remove();
    }
});

test('lookupCalendar: resolves a case-mismatched slug through the index', async () => {
    // The scan's one legitimate job. The index has to cover it, or removing the scan is a
    // regression rather than a fix.
    await seedCalendar('IndexedCaseProbe', { title: 'Found via index' });
    try {
        const result = await SlugService.lookupCalendar('indexedcaseprobe');
        assert.equal(result.found, true);
        assert.equal(result.actualSlug, 'IndexedCaseProbe');
        assert.equal(result.isReadOnly, false);
    } finally {
        await cleanup('IndexedCaseProbe');
    }
});

test('lookupCalendar: an index entry supersedes a stale negative-cache entry', async () => {
    // Someone visits /my-cal before it exists (negative-cached), then it gets created. The
    // trigger writes the index entry, which must win immediately rather than making the
    // visitor wait out NOT_FOUND_CACHE_MS.
    const slug = 'NegativeThenCreatedProbe';
    try {
        const missing = await SlugService.lookupCalendar(slug.toLowerCase());
        assert.equal(missing.found, false);

        await seedCalendar(slug); // writes the index, as the trigger does in production

        const found = await SlugService.lookupCalendar(slug.toLowerCase());
        assert.equal(found.found, true, 'a fresh index entry must beat a stale notFound entry');
        assert.equal(found.actualSlug, slug);
    } finally {
        await cleanup(slug);
    }
});

test('lookupCalendar: a read-only view resolves through the index too', async () => {
    await db.ref('calendars_readonly').child('ReadOnlyIndexProbe').set({
        id: 'ReadOnlyIndexProbe', title: 'RO', events: [], options: {},
    });
    await db.ref('slug_mappings/readonlyindexprobe')
        .set({ actualSlug: 'ReadOnlyIndexProbe', isReadOnly: true });
    try {
        const result = await SlugService.lookupCalendar('readonlyindexprobe');
        assert.equal(result.found, true);
        assert.equal(result.actualSlug, 'ReadOnlyIndexProbe');
        assert.equal(result.isReadOnly, true);
    } finally {
        await cleanup('ReadOnlyIndexProbe');
    }
});

// The Admin SDK holds its RTDB socket open, so without this the process lingers ~150s
// after the last assertion and `node --test` never advances to the next file. Three files
// without it turned a 3-second suite into an 8-minute one that then timed out and reported
// a false failure. See the same teardown in ics-device-buckets.emulator.test.js.
test.after(async () => {
    await admin.app().delete();
});
